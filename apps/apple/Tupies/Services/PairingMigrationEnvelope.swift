import CryptoKit
import Foundation

/// Public pairing metadata only. Device keys and session tokens travel through neither this schema nor its JSON.
struct PairingMigrationEnvelope: Codable {
    static let maximumEncodedBytes = 256 * 1024
    static let legacyBundleIdentifier = "dev.hermesstudio.app"
    static let currentBundleIdentifier = "dev.tupies.app"

    struct Preferences: Codable {
        var connections: [Connection]
        var activeID: UUID? = nil
        var deviceName: String? = nil
        var suppressedLocalFingerprints: [String]
        var notificationEnabled: Bool
        var notificationBotReplies: Bool
        var notificationRoutines: Bool
        var notificationConnectionID: UUID? = nil
        var studioFolder: String? = nil
        var nodePath: String? = nil
    }

    struct KeyProof: Codable {
        var connectionID: UUID
        var publicKeyDERBase64: String
        var storageKind: String
    }

    enum ValidationError: Error, LocalizedError {
        case malformed, tooLarge, unsupportedVersion, wrongBundle, invalidPreferences, invalidConnection, invalidKeyProof
        var errorDescription: String? {
            switch self {
            case .tooLarge: return "The pairing migration file exceeds its size limit."
            case .unsupportedVersion, .wrongBundle: return "This pairing migration file belongs to another app or version."
            default: return "The pairing migration file is invalid. Existing pairings were not changed."
            }
        }
    }

    var version: Int = 1
    var sourceBundleIdentifier: String = legacyBundleIdentifier
    var destinationBundleIdentifier: String = currentBundleIdentifier
    var exportedAt: Date
    var preferences: Preferences
    var keyProofs: [KeyProof]

    init(preferences: Preferences, keyProofs: [KeyProof], exportedAt: Date = Date()) {
        self.exportedAt = exportedAt
        self.preferences = preferences
        self.keyProofs = keyProofs
    }

    func validate() throws {
        guard version == 1 else { throw ValidationError.unsupportedVersion }
        guard sourceBundleIdentifier == Self.legacyBundleIdentifier,
              destinationBundleIdentifier == Self.currentBundleIdentifier else { throw ValidationError.wrongBundle }
        guard Self.validDate(exportedAt), preferences.connections.count <= 32,
              Self.validText(preferences.deviceName, maximum: 160),
              Self.validPath(preferences.studioFolder), Self.validPath(preferences.nodePath),
              preferences.suppressedLocalFingerprints.count <= 128,
              preferences.suppressedLocalFingerprints.allSatisfy(Self.validFingerprint),
              Set(preferences.suppressedLocalFingerprints).count == preferences.suppressedLocalFingerprints.count
        else { throw ValidationError.invalidPreferences }

        let ids = Set(preferences.connections.map(\.id))
        guard ids.count == preferences.connections.count,
              Set(preferences.connections.map(\.deviceId)).count == preferences.connections.count,
              preferences.activeID.map(ids.contains) ?? true,
              preferences.notificationConnectionID.map(ids.contains) ?? true
        else { throw ValidationError.invalidPreferences }

        for connection in preferences.connections {
            guard Self.validText(connection.name, maximum: 80, required: true),
                  Self.safeID(connection.deviceId), Self.validFingerprint(connection.fingerprint),
                  connection.nodeId.map(Self.safeID) ?? true,
                  Self.validDate(connection.addedAt), Self.validDate(connection.lastUsed),
                  Self.validOrigin(connection.baseURL),
                  let engineKey = Self.publicKey(connection.enginePublicKey),
                  Fingerprint.of(publicKeyDER: engineKey) == connection.fingerprint,
                  connection.pinnedTLS != true || connection.baseURL.scheme == "https"
            else { throw ValidationError.invalidConnection }
        }

        guard keyProofs.count == preferences.connections.count,
              Set(keyProofs.map(\.connectionID)) == ids,
              Set(keyProofs.map(\.connectionID)).count == keyProofs.count
        else { throw ValidationError.invalidKeyProof }
        for proof in keyProofs {
            guard ["secureEnclave", "software"].contains(proof.storageKind),
                  Self.publicKey(proof.publicKeyDERBase64) != nil
            else { throw ValidationError.invalidKeyProof }
        }
    }

    func encoded() throws -> Data {
        try validate()
        // Foundation's default numeric Date coding preserves existing Connection subsecond values losslessly.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(self)
        guard data.count <= Self.maximumEncodedBytes else { throw ValidationError.tooLarge }
        return data
    }

    static func decode(_ data: Data) throws -> Self {
        guard !data.isEmpty, data.count <= maximumEncodedBytes else { throw ValidationError.tooLarge }
        do {
            let object = try JSONSerialization.jsonObject(with: data)
            try checkFields(object, allowed: ["version", "sourceBundleIdentifier", "destinationBundleIdentifier", "exportedAt", "preferences", "keyProofs"])
            guard let envelope = object as? [String: Any], let preferences = envelope["preferences"] as? [String: Any],
                  let connections = preferences["connections"] as? [Any], let proofs = envelope["keyProofs"] as? [Any]
            else { throw ValidationError.malformed }
            try checkFields(preferences, allowed: ["connections", "activeID", "deviceName", "suppressedLocalFingerprints", "notificationEnabled", "notificationBotReplies", "notificationRoutines", "notificationConnectionID", "studioFolder", "nodePath"])
            for connection in connections { try checkFields(connection, allowed: ["id", "name", "baseURL", "deviceId", "fingerprint", "enginePublicKey", "nodeId", "kind", "addedAt", "lastUsed", "pinnedTLS"]) }
            for proof in proofs { try checkFields(proof, allowed: ["connectionID", "publicKeyDERBase64", "storageKind"]) }
            let value = try JSONDecoder().decode(Self.self, from: data)
            try value.validate()
            return value
        } catch let error as ValidationError { throw error }
        catch { throw ValidationError.malformed }
    }

    private static func checkFields(_ value: Any, allowed: Set<String>) throws {
        guard let object = value as? [String: Any], Set(object.keys).isSubset(of: allowed) else { throw ValidationError.malformed }
    }
    private static func validDate(_ value: Date) -> Bool {
        value.timeIntervalSince1970.isFinite && (946_684_800...4_102_444_800).contains(value.timeIntervalSince1970)
    }
    private static func validText(_ value: String?, maximum: Int, required: Bool = false) -> Bool {
        guard let value else { return !required }
        return value.utf8.count <= maximum * 4 && value.count <= maximum
            && (!required || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            && !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    }
    private static func validPath(_ value: String?) -> Bool {
        guard validText(value, maximum: 4096) else { return false }
        return value.map { $0.isEmpty || $0.hasPrefix("/") || $0.hasPrefix("~/") } ?? true
    }
    private static func safeID(_ value: String) -> Bool {
        (1...120).contains(value.utf8.count) && value.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 95 || $0 == 45 }
    }
    private static func validFingerprint(_ value: String) -> Bool {
        guard value.utf8.count == 43, value.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 95 || $0 == 45 }) else { return false }
        let padded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "="
        guard let bytes = Data(base64Encoded: padded), bytes.count == 32 else { return false }
        return bytes.base64URLEncodedString() == value
    }
    private static func publicKey(_ value: String) -> Data? {
        guard value.utf8.count <= 128, let bytes = Data(base64Encoded: value), bytes.count == 91,
              bytes.base64EncodedString() == value,
              let key = try? P256.Signing.PublicKey(derRepresentation: bytes), key.derRepresentation == bytes
        else { return nil }
        return bytes
    }
    private static func validOrigin(_ value: URL) -> Bool {
        guard value.absoluteString.utf8.count <= 2048,
              let components = URLComponents(url: value, resolvingAgainstBaseURL: false),
              let scheme = components.scheme, ["http", "https"].contains(scheme),
              let host = components.host, validText(host, maximum: 253, required: true),
              !host.contains(where: { $0.isWhitespace }), components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil, components.path.isEmpty,
              components.port.map({ (1...65535).contains($0) }) ?? true,
              value.origin?.absoluteString == value.absoluteString
        else { return false }
        return true
    }
}
