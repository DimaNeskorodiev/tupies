import Foundation
import Security

/// Minimal generic-password Keychain wrapper.
///
/// Items are stored with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so they
/// never sync to iCloud or migrate to another device. On macOS the modern data-protection
/// keychain is used when the app is signed with a team; unsigned development builds fall
/// back to the login keychain (which may ask for access after each rebuild).
enum Keychain {
    enum Failure: LocalizedError {
        case status(OSStatus)

        var errorDescription: String? {
            switch self {
            case .status(let status) where status == errSecMissingEntitlement:
                return "This copy of Tupies isn’t code-signed, so it can’t use the Keychain to store its device key. Run it from Xcode or install a signed build."
            case .status(let status):
                let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
                return "Keychain error: \(message)"
            }
        }
    }

    static func set(_ data: Data, service: String, account: String) throws {
        var status = write(data, service: service, account: account, modern: true)
        #if os(macOS)
        if status == errSecMissingEntitlement {
            status = write(data, service: service, account: account, modern: false)
        }
        #endif
        guard status == errSecSuccess else { throw Failure.status(status) }
    }

    static func data(service: String, account: String) throws -> Data? {
        for modern in modes {
            var query = baseQuery(service: service, account: account, modern: modern)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            switch status {
            case errSecSuccess:
                return result as? Data
            case errSecItemNotFound, errSecMissingEntitlement:
                continue
            default:
                throw Failure.status(status)
            }
        }
        return nil
    }

    static func delete(service: String, account: String) {
        for modern in modes {
            SecItemDelete(baseQuery(service: service, account: account, modern: modern) as CFDictionary)
        }
    }

    // MARK: - Private

    private static var modes: [Bool] {
        #if os(macOS)
        return [true, false]
        #else
        return [true]
        #endif
    }

    private static func baseQuery(service: String, account: String, modern: Bool) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        #if os(macOS)
        if modern { query[kSecUseDataProtectionKeychain as String] = true }
        #endif
        return query
    }

    private static func write(_ data: Data, service: String, account: String, modern: Bool) -> OSStatus {
        let query = baseQuery(service: service, account: account, modern: modern)
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        if modern {
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        }
        return SecItemAdd(attributes as CFDictionary, nil)
    }
}
