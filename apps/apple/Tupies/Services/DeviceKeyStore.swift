import CryptoKit
import Foundation
import Security

/// A P-256 ECDSA signing key that identifies this device to one engine.
enum DeviceSigningKey {
    case secureEnclave(SecureEnclave.P256.Signing.PrivateKey)
    case software(P256.Signing.PrivateKey)

    /// SPKI DER of the public key.
    var publicKeyDER: Data {
        switch self {
        case .secureEnclave(let key): return key.publicKey.derRepresentation
        case .software(let key): return key.publicKey.derRepresentation
        }
    }

    var publicKeyBase64: String { publicKeyDER.base64EncodedString() }

    var isHardwareBacked: Bool {
        if case .secureEnclave = self { return true }
        return false
    }

    /// SHA-256 ECDSA signature, DER encoded.
    func sign(_ message: Data) throws -> Data {
        switch self {
        case .secureEnclave(let key): return try key.signature(for: message).derRepresentation
        case .software(let key): return try key.signature(for: message).derRepresentation
        }
    }
}

/// Creates and stores one device key per paired connection.
///
/// With a Secure Enclave the private key never exists outside the enclave; only an
/// encrypted, device-bound handle (`dataRepresentation`) is kept in the Keychain.
/// Without one (Simulator, older Intel Macs) a software P-256 key is kept in the
/// Keychain as `AfterFirstUnlockThisDeviceOnly`.
final class DeviceKeyStore {
    static let shared = DeviceKeyStore()

    enum StorageKind: String, Codable {
        case secureEnclave
        case software

        var label: String {
            switch self {
            case .secureEnclave: return "Secure Enclave"
            case .software: return "Keychain"
            }
        }
    }

    private struct StoredKey: Codable {
        var kind: StorageKind
        var data: Data
    }

    private let service: String
    private let accessGroup: String?
    private let allowLegacyMacFallback: Bool

    init(service: String = AppIdentity.deviceKeyService, accessGroup: String? = nil, allowLegacyMacFallback: Bool = false) {
        self.service = service
        self.accessGroup = accessGroup
        self.allowLegacyMacFallback = allowLegacyMacFallback
    }

    func createKey(for id: UUID) throws -> DeviceSigningKey {
        let key: DeviceSigningKey
        if let enclaveKey = makeSecureEnclaveKey() {
            key = .secureEnclave(enclaveKey)
        } else {
            key = .software(P256.Signing.PrivateKey())
        }
        try persist(key, for: id)
        return key
    }

    func loadKey(for id: UUID) throws -> DeviceSigningKey? {
        guard let data = try storedData(for: id) else { return nil }
        return try Self.signingKey(from: data)
    }

    func storedData(for id: UUID) throws -> Data? {
        try Keychain.data(service: service, account: id.uuidString, accessGroup: accessGroup, allowLegacyMacFallback: allowLegacyMacFallback)
    }

    static func signingKey(from data: Data) throws -> DeviceSigningKey {
        guard data.count <= 16_384 else { throw EngineError.invalidResponse }
        let stored = try JSONDecoder().decode(StoredKey.self, from: data)
        switch stored.kind {
        case .secureEnclave:
            return .secureEnclave(try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: stored.data))
        case .software:
            return .software(try P256.Signing.PrivateKey(rawRepresentation: stored.data))
        }
    }

    func storageKind(for id: UUID) -> StorageKind? {
        guard let data = try? storedData(for: id),
              let stored = try? JSONDecoder().decode(StoredKey.self, from: data) else { return nil }
        return stored.kind
    }

    func deleteKey(for id: UUID) {
        Keychain.delete(service: service, account: id.uuidString, accessGroup: accessGroup)
    }

    // MARK: - Private

    private func persist(_ key: DeviceSigningKey, for id: UUID) throws {
        let stored: StoredKey
        switch key {
        case .secureEnclave(let enclaveKey):
            stored = StoredKey(kind: .secureEnclave, data: enclaveKey.dataRepresentation)
        case .software(let softwareKey):
            stored = StoredKey(kind: .software, data: softwareKey.rawRepresentation)
        }
        try Keychain.set(try JSONEncoder().encode(stored), service: service, account: id.uuidString, accessGroup: accessGroup)
    }

    /// Returns a usable Secure Enclave key, or nil if the enclave is unavailable or
    /// refuses (e.g. unsigned builds). A test signature guards against late failures.
    private func makeSecureEnclaveKey() -> SecureEnclave.P256.Signing.PrivateKey? {
        guard SecureEnclave.isAvailable else { return nil }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            .privateKeyUsage,
            &error
        ) else { return nil }
        do {
            let key = try SecureEnclave.P256.Signing.PrivateKey(compactRepresentable: false, accessControl: access)
            _ = try key.signature(for: Data("hermes-studio/self-test".utf8))
            return key
        } catch {
            return nil
        }
    }
}
