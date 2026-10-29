import CryptoKit
import Foundation

protocol PairingMigrationKeychain {
    func read(service: String, account: String, group: String, legacyMacFallback: Bool) throws -> Data?
    func insert(_ data: Data, service: String, account: String, group: String) throws
    func save(_ data: Data, service: String, account: String, group: String) throws
}

struct SystemPairingMigrationKeychain: PairingMigrationKeychain {
    func read(service: String, account: String, group: String, legacyMacFallback: Bool = false) throws -> Data? {
        try Keychain.data(service: service, account: account, accessGroup: group, allowLegacyMacFallback: legacyMacFallback)
    }
    func insert(_ data: Data, service: String, account: String, group: String) throws {
        try Keychain.insertIfAbsent(data, service: service, account: account, accessGroup: group)
    }
    func save(_ data: Data, service: String, account: String, group: String) throws {
        try Keychain.set(data, service: service, account: account, accessGroup: group)
    }
}

protocol PairingMigrationPreferences {
    func object(forKey key: String) -> Any?
    func commit(_ values: [String: Any], removing keys: Set<String>) throws
}

final class SystemPairingMigrationPreferences: PairingMigrationPreferences {
    let defaults: UserDefaults
    let domain: String
    init(defaults: UserDefaults, domain: String) { self.defaults = defaults; self.domain = domain }
    func object(forKey key: String) -> Any? { defaults.object(forKey: key) }
    func commit(_ values: [String: Any], removing keys: Set<String>) throws {
        var contents = defaults.persistentDomain(forName: domain) ?? [:]
        for key in keys { contents.removeValue(forKey: key) }
        for (key, value) in values { contents[key] = value }
        // One domain replacement keeps the selected settings and completion flag in the same snapshot.
        defaults.setPersistentDomain(contents, forName: domain)
        guard defaults.synchronize() else { throw PairingMigrationService.Failure.settingsNotSaved }
    }
}

/// The bridge copies opaque records inside Keychain. JSON contains public metadata only.
/// It never opens an engine, creates a replacement key, revokes a device, or deletes the source.
final class PairingMigrationService: @unchecked Sendable {
    enum Failure: Error, LocalizedError {
        case wrongApp, invalidRecord, missingKey, differentKey, settingsNotSaved, destinationAlreadyUsed, legacyTransferRequired, transferChanged
        var errorDescription: String? {
            switch self {
            case .wrongApp: return "This app cannot access the signed Tupies transfer group. Install the complete signed build."
            case .missingKey: return "A connection’s original device key is unavailable. Keep the previous Tupies app and try the transfer again after unlocking this device. No replacement key was created."
            case .differentKey: return "An existing Tupies device key differs from the transfer. Nothing was overwritten. Keep both apps and review this connection before retrying."
            case .settingsNotSaved: return "The transferred settings could not be saved and verified. Keep both apps and choose Try Again."
            case .destinationAlreadyUsed: return "This Tupies app already has connections. The transfer will not overwrite them. Keep both apps and review the existing connections."
            case .legacyTransferRequired: return "Open Tupies Transfer once on this device to prepare your existing connections, then choose Try Again here."
            case .transferChanged: return "The transfer changed while it was being checked. Keep both apps and choose Try Again."
            case .invalidRecord: return "The saved transfer record is incomplete or invalid. Keep the previous app and prepare the transfer again."
            }
        }
    }
    struct Receipt {
        let connections: Int
        let secureEnclaveKeys: Int
        let alreadyCompleted: Bool
    }
    private struct Completion: Codable {
        let version: Int
        let envelopeSHA256: String
    }
    static let completedPreference = "tupies.migration.completed.v1"
    private static let pendingPreference = "tupies.migration.pending.v1"
    private static let preferenceKeys: Set<String> = [
        AppSettings.connections, AppSettings.active, AppSettings.deviceName, AppSettings.suppressedLocalIdentities,
        AppSettings.notificationsEnabled, AppSettings.notificationsReplies, AppSettings.notificationsRoutines,
        AppSettings.notificationsConnection, AppSettings.notificationsRegistrations, AppSettings.studioFolder, AppSettings.nodePath,
    ]

    private let keychain: PairingMigrationKeychain
    private let current: PairingMigrationPreferences
    private let legacy: PairingMigrationPreferences?
    private let newGroup: String
    private let oldGroup: String
    private let bundleIdentifier: String
    private let legacyMacFallback: Bool
    private let requiresLegacyTransfer: Bool

    init(keychain: PairingMigrationKeychain, current: PairingMigrationPreferences, legacy: PairingMigrationPreferences?, newGroup: String, oldGroup: String, bundleIdentifier: String, legacyMacFallback: Bool, requiresLegacyTransfer: Bool = false) {
        self.keychain = keychain; self.current = current; self.legacy = legacy
        self.newGroup = newGroup; self.oldGroup = oldGroup
        self.bundleIdentifier = bundleIdentifier; self.legacyMacFallback = legacyMacFallback
        self.requiresLegacyTransfer = requiresLegacyTransfer
    }

    static func system() throws -> PairingMigrationService {
        guard let newGroup = AppIdentity.keychainGroup, let oldGroup = AppIdentity.legacyKeychainGroup,
              let identifier = Bundle.main.bundleIdentifier else { throw Failure.wrongApp }
        let current = SystemPairingMigrationPreferences(defaults: .standard, domain: identifier)
        #if os(macOS)
        let previous = UserDefaults(suiteName: AppIdentity.legacyBundleIdentifier).map {
            SystemPairingMigrationPreferences(defaults: $0, domain: AppIdentity.legacyBundleIdentifier)
        }
        return PairingMigrationService(keychain: SystemPairingMigrationKeychain(), current: current, legacy: previous, newGroup: newGroup, oldGroup: oldGroup, bundleIdentifier: identifier, legacyMacFallback: true, requiresLegacyTransfer: AppIdentity.requiresLegacyTransfer)
        #else
        return PairingMigrationService(keychain: SystemPairingMigrationKeychain(), current: current, legacy: nil, newGroup: newGroup, oldGroup: oldGroup, bundleIdentifier: identifier, legacyMacFallback: false, requiresLegacyTransfer: AppIdentity.requiresLegacyTransfer)
        #endif
    }

    /// Called only by the passive old-identifier app, after the owner selects Prepare Transfer.
    func exportLegacy() throws -> Receipt {
        guard bundleIdentifier == AppIdentity.legacyBundleIdentifier else { throw Failure.wrongApp }
        let previousEncoded = try readEnvelope()
        if let existing = previousEncoded, let complete = try readCompletion() {
            guard complete.envelopeSHA256 == Self.digest(existing) else { throw Failure.invalidRecord }
            return Self.receipt(try PairingMigrationEnvelope.decode(existing), completed: true)
        }
        if try readCompletion() != nil { throw Failure.invalidRecord }
        let preferences = try Self.snapshot(current, legacyNames: true)
        var proofs: [PairingMigrationEnvelope.KeyProof] = []
        var records: [(UUID, Data)] = []
        for connection in preferences.connections {
            guard let source = try keychain.read(service: AppIdentity.legacyDeviceKeyService, account: connection.id.uuidString, group: oldGroup, legacyMacFallback: legacyMacFallback) else { throw Failure.missingKey }
            let original = try Self.verifiedKey(source)
            records.append((connection.id, source))
            proofs.append(.init(connectionID: connection.id, publicKeyDERBase64: original.publicKeyBase64, storageKind: original.isHardwareBacked ? "secureEnclave" : "software"))
        }
        let envelope: PairingMigrationEnvelope
        let encoded: Data
        if let previousEncoded {
            let previous = try PairingMigrationEnvelope.decode(previousEncoded)
            guard try Self.encode(previous.preferences) == Self.encode(preferences),
                  try Self.encode(previous.keyProofs) == Self.encode(proofs) else { throw Failure.transferChanged }
            envelope = previous; encoded = previousEncoded // Retry retains the exact handoff digest and timestamp.
        } else {
            envelope = PairingMigrationEnvelope(preferences: preferences, keyProofs: proofs)
            encoded = try envelope.encoded()
        }
        let intent = try Self.encode(Completion(version: 1, envelopeSHA256: Self.digest(encoded)))
        try keychain.save(intent, service: AppIdentity.migrationService, account: AppIdentity.startedAccount, group: newGroup)
        for (id, source) in records {
            let original = try Self.verifiedKey(source)
            try keychain.insert(source, service: AppIdentity.deviceKeyService, account: id.uuidString, group: newGroup)
            guard let copied = try keychain.read(service: AppIdentity.deviceKeyService, account: id.uuidString, group: newGroup, legacyMacFallback: false) else { throw Failure.missingKey }
            let imported = try Self.verifiedKey(copied)
            guard original.publicKeyDER == imported.publicKeyDER,
                  original.isHardwareBacked == imported.isHardwareBacked else { throw Failure.differentKey }
        }
        try keychain.save(encoded, service: AppIdentity.migrationService, account: AppIdentity.envelopeAccount, group: newGroup)
        guard try readEnvelope() == encoded else { throw Failure.settingsNotSaved }
        return Self.receipt(envelope, completed: false)
    }

    /// Finishes before any ConnectionStore, engine controller or push coordinator may start.
    func preparePrimary() throws -> Receipt? {
        guard bundleIdentifier == AppIdentity.primaryBundleIdentifier else { throw Failure.wrongApp }
        let encoded = try readEnvelope()
        let completion = try readCompletion()
        let started = try readMarker(account: AppIdentity.startedAccount)
        if let completion {
            guard let encoded, completion.envelopeSHA256 == Self.digest(encoded) else { throw Failure.invalidRecord }
            let envelope = try PairingMigrationEnvelope.decode(encoded)
            if current.object(forKey: Self.completedPreference) as? String == completion.envelopeSHA256,
               current.object(forKey: AppSettings.connections) is Data {
                // Later normal removal/renaming is authoritative; do not resurrect old settings or keys.
                var preferences = try Self.snapshot(current, legacyNames: false)
                // Normal removal saves connections before selector callbacks. A valid stale selector is not authority.
                let ids = Set(preferences.connections.map(\.id))
                if let active = preferences.activeID, !ids.contains(active) { preferences.activeID = nil }
                if let selected = preferences.notificationConnectionID, !ids.contains(selected) { preferences.notificationConnectionID = nil }
                try PairingMigrationEnvelope(preferences: preferences, keyProofs: currentProofs(preferences)).validate()
                return Self.receipt(envelope, completed: true)
            }
            // A crash before the preferences snapshot became durable can retry from the retained envelope.
        }
        guard let encoded else {
            if requiresLegacyTransfer || started != nil { throw Failure.legacyTransferRequired }
            if let previous = legacy, Self.hasLegacyPreferences(previous) {
                _ = try Self.snapshot(previous, legacyNames: true)
                throw Failure.legacyTransferRequired
            }
            return nil // A genuinely fresh namespace requires no legacy transfer.
        }
        let envelope = try PairingMigrationEnvelope.decode(encoded)
        let digest = Self.digest(encoded)
        if let started, started.envelopeSHA256 != digest { throw Failure.transferChanged }
        if completion == nil, current.object(forKey: Self.pendingPreference) as? String != digest,
           let bytes = current.object(forKey: AppSettings.connections) as? Data,
           !(try JSONDecoder().decode([Connection].self, from: bytes)).isEmpty { throw Failure.destinationAlreadyUsed }
        try verifyKeys(envelope)
        try current.commit([Self.pendingPreference: digest], removing: [])
        let values = try Self.preferenceValues(envelope.preferences, digest: digest)
        try current.commit(values, removing: Self.preferenceKeys.union([Self.pendingPreference]))
        let stored = try Self.snapshot(current, legacyNames: false)
        guard try Self.encode(stored) == Self.encode(envelope.preferences),
              current.object(forKey: Self.completedPreference) as? String == digest else { throw Failure.settingsNotSaved }
        try verifyKeys(envelope)
        guard try readEnvelope() == encoded else { throw Failure.transferChanged }
        let marker = try Self.encode(Completion(version: 1, envelopeSHA256: digest))
        try keychain.save(marker, service: AppIdentity.migrationService, account: AppIdentity.completionAccount, group: newGroup)
        guard try readCompletion()?.envelopeSHA256 == digest else { throw Failure.settingsNotSaved }
        return Self.receipt(envelope, completed: true)
    }

    private func verifyKeys(_ envelope: PairingMigrationEnvelope) throws {
        for proof in envelope.keyProofs {
            guard let data = try keychain.read(service: AppIdentity.deviceKeyService, account: proof.connectionID.uuidString, group: newGroup, legacyMacFallback: false) else { throw Failure.missingKey }
            let key = try Self.verifiedKey(data)
            guard key.publicKeyBase64 == proof.publicKeyDERBase64,
                  (key.isHardwareBacked ? "secureEnclave" : "software") == proof.storageKind else { throw Failure.differentKey }
        }
    }
    private func currentProofs(_ preferences: PairingMigrationEnvelope.Preferences) throws -> [PairingMigrationEnvelope.KeyProof] {
        try preferences.connections.map { connection in
            guard let data = try keychain.read(service: AppIdentity.deviceKeyService, account: connection.id.uuidString, group: newGroup, legacyMacFallback: false) else { throw Failure.missingKey }
            let key = try Self.verifiedKey(data)
            return .init(connectionID: connection.id, publicKeyDERBase64: key.publicKeyBase64, storageKind: key.isHardwareBacked ? "secureEnclave" : "software")
        }
    }
    private static func verifiedKey(_ data: Data) throws -> DeviceSigningKey {
        let key = try DeviceKeyStore.signingKey(from: data)
        let challenge = Data("tupies/device-transfer/v1\n".utf8) + Data.random(count: 32)
        let signature = try P256.Signing.ECDSASignature(derRepresentation: key.sign(challenge))
        let publicKey = try P256.Signing.PublicKey(derRepresentation: key.publicKeyDER)
        guard publicKey.isValidSignature(signature, for: challenge) else { throw Failure.differentKey }
        return key
    }
    private func readEnvelope() throws -> Data? {
        let data = try keychain.read(service: AppIdentity.migrationService, account: AppIdentity.envelopeAccount, group: newGroup, legacyMacFallback: false)
        if let data { _ = try PairingMigrationEnvelope.decode(data) }
        return data
    }
    private func readCompletion() throws -> Completion? {
        try readMarker(account: AppIdentity.completionAccount)
    }
    private func readMarker(account: String) throws -> Completion? {
        guard let data = try keychain.read(service: AppIdentity.migrationService, account: account, group: newGroup, legacyMacFallback: false) else { return nil }
        guard data.count <= 256, let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["version", "envelopeSHA256"], let marker = try? JSONDecoder().decode(Completion.self, from: data), marker.version == 1,
              marker.envelopeSHA256.count == 64, marker.envelopeSHA256.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw Failure.invalidRecord }
        return marker
    }
    private static func hasLegacyPreferences(_ preferences: PairingMigrationPreferences) -> Bool {
        ["hermes.connections.v1", "hermes.activeConnection.v1", "hermes.deviceName", "hermes.local.removedIdentities.v1", "hermes.notifications.enabled", "hermes.notifications.botReplies", "hermes.notifications.routines", "hermes.notifications.connection", "hermes.local.studioFolder", "hermes.local.nodePath"].contains { preferences.object(forKey: $0) != nil }
    }
    private static func snapshot(_ preferences: PairingMigrationPreferences, legacyNames: Bool) throws -> PairingMigrationEnvelope.Preferences {
        func name(_ old: String, _ new: String) -> String { legacyNames ? old : new }
        func string(_ old: String, _ new: String) throws -> String? {
            guard let value = preferences.object(forKey: name(old, new)) else { return nil }
            guard let value = value as? String else { throw Failure.invalidRecord }; return value
        }
        func uuid(_ old: String, _ new: String) throws -> UUID? {
            guard let value = try string(old, new) else { return nil }
            guard let id = UUID(uuidString: value) else { throw Failure.invalidRecord }; return id
        }
        func bool(_ old: String, _ new: String, _ fallback: Bool) throws -> Bool {
            guard let value = preferences.object(forKey: name(old, new)) else { return fallback }
            guard let value = value as? Bool else { throw Failure.invalidRecord }; return value
        }
        let connections: [Connection]
        if let value = preferences.object(forKey: name("hermes.connections.v1", AppSettings.connections)) {
            guard let data = value as? Data, data.count <= PairingMigrationEnvelope.maximumEncodedBytes else { throw Failure.invalidRecord }
            connections = try JSONDecoder().decode([Connection].self, from: data)
        } else { connections = [] }
        let suppressed: [String]
        if let value = preferences.object(forKey: name("hermes.local.removedIdentities.v1", AppSettings.suppressedLocalIdentities)) {
            guard let value = value as? [String] else { throw Failure.invalidRecord }; suppressed = value
        } else { suppressed = [] }
        return .init(connections: connections,
                     activeID: try uuid("hermes.activeConnection.v1", AppSettings.active),
                     deviceName: try string("hermes.deviceName", AppSettings.deviceName), suppressedLocalFingerprints: suppressed,
                     notificationEnabled: try bool("hermes.notifications.enabled", AppSettings.notificationsEnabled, false),
                     notificationBotReplies: try bool("hermes.notifications.botReplies", AppSettings.notificationsReplies, true),
                     notificationRoutines: try bool("hermes.notifications.routines", AppSettings.notificationsRoutines, true),
                     notificationConnectionID: try uuid("hermes.notifications.connection", AppSettings.notificationsConnection),
                     studioFolder: try string("hermes.local.studioFolder", AppSettings.studioFolder), nodePath: try string("hermes.local.nodePath", AppSettings.nodePath))
    }
    private static func preferenceValues(_ preferences: PairingMigrationEnvelope.Preferences, digest: String) throws -> [String: Any] {
        var values: [String: Any] = [AppSettings.connections: try JSONEncoder().encode(preferences.connections),
                                   AppSettings.suppressedLocalIdentities: preferences.suppressedLocalFingerprints,
                                   AppSettings.notificationsEnabled: preferences.notificationEnabled,
                                   AppSettings.notificationsReplies: preferences.notificationBotReplies,
                                   AppSettings.notificationsRoutines: preferences.notificationRoutines,
                                   Self.completedPreference: digest, Self.pendingPreference: digest]
        if let value = preferences.activeID { values[AppSettings.active] = value.uuidString }
        if let value = preferences.deviceName { values[AppSettings.deviceName] = value }
        if let value = preferences.notificationConnectionID { values[AppSettings.notificationsConnection] = value.uuidString }
        if let value = preferences.studioFolder { values[AppSettings.studioFolder] = value }
        if let value = preferences.nodePath { values[AppSettings.nodePath] = value }
        return values
    }
    private static func encode<T: Encodable>(_ value: T) throws -> Data { let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; return try encoder.encode(value) }
    private static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func receipt(_ envelope: PairingMigrationEnvelope, completed: Bool) -> Receipt {
        .init(connections: envelope.preferences.connections.count, secureEnclaveKeys: envelope.keyProofs.filter { $0.storageKind == "secureEnclave" }.count, alreadyCompleted: completed)
    }
}
