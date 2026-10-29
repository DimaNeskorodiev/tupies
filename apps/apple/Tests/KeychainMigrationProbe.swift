// Signed macOS test executable only. Never linked into the app.
// Its random namespace is appended to EVERY service; preferences stay in memory.
import CryptoKit
import Foundation
import Security

private struct ProbeDocument: Codable {
    let namespace: UUID
    let connection: Connection
    let publicKey: String
    let secureEnclave: Bool
}
private final class ProbePreferences: PairingMigrationPreferences {
    var values: [String: Any] = [:]
    func object(forKey key: String) -> Any? { values[key] }
    func commit(_ values: [String: Any], removing keys: Set<String>) throws {
        for key in keys { self.values.removeValue(forKey: key) }
        for (key, value) in values { self.values[key] = value }
    }
}
private struct ProbeKeychain: PairingMigrationKeychain {
    let namespace: UUID
    func service(_ value: String) -> String { value + ".synthetic-transfer-probe." + namespace.uuidString }
    func read(service: String, account: String, group: String, legacyMacFallback: Bool) throws -> Data? {
        try Keychain.data(service: self.service(service), account: account, accessGroup: group, allowLegacyMacFallback: legacyMacFallback)
    }
    func insert(_ data: Data, service: String, account: String, group: String) throws {
        try Keychain.insertIfAbsent(data, service: self.service(service), account: account, accessGroup: group)
    }
    func save(_ data: Data, service: String, account: String, group: String) throws {
        try Keychain.set(data, service: self.service(service), account: account, accessGroup: group)
    }
}

@main
private struct KeychainMigrationProbe {
    enum Failure: Error { case badArguments, wrongIdentity, testFailure, keychain(OSStatus), noSecureEnclave }
    static func main() throws {
        guard CommandLine.arguments.count == 3,
              ["export", "import", "cleanup-source", "cleanup-destination"].contains(CommandLine.arguments[1]),
              let newGroup = AppIdentity.keychainGroup, let oldGroup = AppIdentity.legacyKeychainGroup else { throw Failure.badArguments }
        let phase = CommandLine.arguments[1], url = URL(fileURLWithPath: CommandLine.arguments[2])
        let old = phase == "export" || phase == "cleanup-source"
        guard Bundle.main.bundleIdentifier == (old ? AppIdentity.legacyBundleIdentifier : AppIdentity.primaryBundleIdentifier) else { throw Failure.wrongIdentity }
        if phase == "export" {
            guard !FileManager.default.fileExists(atPath: url.path), SecureEnclave.isAvailable else { throw Failure.noSecureEnclave }
            var accessError: Unmanaged<CFError>?
            guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &accessError) else { throw Failure.noSecureEnclave }
            // Match the existing DeviceKeyStore's exact Secure Enclave creation policy.
            let id = UUID(), namespace = UUID(), key = try SecureEnclave.P256.Signing.PrivateKey(compactRepresentable: false, accessControl: access)
            let engine = P256.Signing.PrivateKey()
            let connection = Connection(id: id, name: "Synthetic transfer probe", baseURL: URL(string: "http://127.0.0.1:1")!, deviceId: "dev_synthetic_" + namespace.uuidString,
                                        fingerprint: Fingerprint.of(publicKeyDER: engine.publicKey.derRepresentation), enginePublicKey: engine.publicKey.derRepresentation.base64EncodedString(),
                                        nodeId: "node_synthetic_" + namespace.uuidString, kind: .local, addedAt: Date(), lastUsed: Date())
            let document = ProbeDocument(namespace: namespace, connection: connection, publicKey: key.publicKey.derRepresentation.base64EncodedString(), secureEnclave: true)
            // Write only public fixture metadata first, so exact synthetic cleanup is possible on failure.
            try JSONEncoder().encode(document).write(to: url, options: .withoutOverwriting)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            let backend = ProbeKeychain(namespace: namespace)
            let record = try JSONSerialization.data(withJSONObject: ["kind": "secureEnclave", "data": key.dataRepresentation.base64EncodedString()])
            // This models the existing Mac app's file-based login Keychain record.
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: backend.service(AppIdentity.legacyDeviceKeyService),
                                        kSecAttrAccount as String: id.uuidString, kSecValueData as String: record]
            let status = SecItemAdd(query as CFDictionary, nil)
            guard status == errSecSuccess else { throw Failure.keychain(status) }
            let preferences = ProbePreferences()
            preferences.values = ["hermes.connections.v1": try JSONEncoder().encode([connection]), "hermes.activeConnection.v1": id.uuidString]
            let service = PairingMigrationService(keychain: backend, current: preferences, legacy: nil, newGroup: newGroup, oldGroup: oldGroup,
                                                  bundleIdentifier: AppIdentity.legacyBundleIdentifier, legacyMacFallback: true)
            let receipt = try service.exportLegacy()
            guard receipt.connections == 1, receipt.secureEnclaveKeys == 1 else { throw Failure.testFailure }
            print("{\"exported\":true,\"sourceWasFileBased\":true,\"secureEnclave\":true,\"productionItemsRead\":false}")
            return
        }
        let document = try JSONDecoder().decode(ProbeDocument.self, from: Data(contentsOf: url))
        let backend = ProbeKeychain(namespace: document.namespace)
        if phase == "import" {
            let preferences = ProbePreferences()
            let service = PairingMigrationService(keychain: backend, current: preferences, legacy: nil, newGroup: newGroup, oldGroup: oldGroup,
                                                  bundleIdentifier: AppIdentity.primaryBundleIdentifier, legacyMacFallback: false, requiresLegacyTransfer: true)
            let receipt = try service.preparePrimary()
            guard receipt?.connections == 1, receipt?.secureEnclaveKeys == 1,
                  let record = try backend.read(service: AppIdentity.deviceKeyService, account: document.connection.id.uuidString, group: newGroup, legacyMacFallback: false) else { throw Failure.testFailure }
            let key = try DeviceKeyStore.signingKey(from: record), challenge = Data.random(count: 32)
            let signature = try P256.Signing.ECDSASignature(derRepresentation: key.sign(challenge))
            guard key.isHardwareBacked, key.publicKeyBase64 == document.publicKey,
                  try P256.Signing.PublicKey(derRepresentation: Data(base64Encoded: document.publicKey)!).isValidSignature(signature, for: challenge),
                  let bytes = preferences.values[AppSettings.connections] as? Data,
                  try JSONDecoder().decode([Connection].self, from: bytes) == [document.connection] else { throw Failure.testFailure }
            print("{\"imported\":true,\"samePublicKey\":true,\"secureEnclaveSigned\":true,\"preferencesMemoryOnly\":true,\"productionItemsRead\":false}")
        } else if phase == "cleanup-source" {
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: backend.service(AppIdentity.legacyDeviceKeyService), kSecAttrAccount as String: document.connection.id.uuidString]
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.keychain(status) }
            print("{\"syntheticSourceRemoved\":true}")
        } else {
            for (service, account) in [(AppIdentity.deviceKeyService, document.connection.id.uuidString), (AppIdentity.migrationService, AppIdentity.envelopeAccount), (AppIdentity.migrationService, AppIdentity.startedAccount), (AppIdentity.migrationService, AppIdentity.completionAccount)] {
                Keychain.delete(service: backend.service(service), account: account, accessGroup: newGroup)
                guard try Keychain.data(service: backend.service(service), account: account, accessGroup: newGroup) == nil else { throw Failure.testFailure }
            }
            print("{\"syntheticDestinationRemoved\":true}")
        }
    }
}
