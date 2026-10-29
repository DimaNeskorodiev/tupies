import Foundation
import Security

/// Minimal generic-password Keychain wrapper.
///
/// Every normal operation targets one explicit, provisioned data-protection group.
/// The passive transfer app alone may read the old Mac login Keychain as a fallback.
enum Keychain {
    enum Failure: LocalizedError {
        case status(OSStatus)

        var errorDescription: String? {
            switch self {
            case .status(let status) where status == errSecMissingEntitlement:
                return "This copy of Tupies is missing its required Keychain signing permission. Install the complete signed app before transferring or pairing."
            case .status(let status):
                let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
                return "Keychain error: \(message)"
            }
        }
    }

    static func set(_ data: Data, service: String, account: String, accessGroup: String? = nil) throws {
        let query = try baseQuery(service: service, account: account, accessGroup: accessGroup)
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            status = add(data, query: query)
            if status == errSecDuplicateItem {
                status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            }
        }
        guard status == errSecSuccess else { throw Failure.status(status) }
    }

    /// Copy-first transfer: an existing destination is never overwritten or deleted.
    @discardableResult
    static func insertIfAbsent(_ data: Data, service: String, account: String, accessGroup: String) throws -> Bool {
        let query = try baseQuery(service: service, account: account, accessGroup: accessGroup)
        let status = add(data, query: query)
        if status == errSecDuplicateItem { return false }
        guard status == errSecSuccess else { throw Failure.status(status) }
        return true
    }

    static func data(service: String, account: String, accessGroup: String? = nil, allowLegacyMacFallback: Bool = false) throws -> Data? {
        let modernQuery = try baseQuery(service: service, account: account, accessGroup: accessGroup)
        var queries = [modernQuery]
        #if os(macOS)
        if allowLegacyMacFallback {
            queries.append([
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
            ])
        }
        #endif
        for var query in queries {
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            switch status {
            case errSecSuccess:
                return result as? Data
            case errSecItemNotFound:
                continue
            case errSecMissingEntitlement:
                #if os(macOS)
                if allowLegacyMacFallback { continue }
                #endif
                throw Failure.status(status)
            default:
                throw Failure.status(status)
            }
        }
        return nil
    }

    static func delete(service: String, account: String, accessGroup: String? = nil) {
        guard let query = try? baseQuery(service: service, account: account, accessGroup: accessGroup) else { return }
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - Private

    private static func baseQuery(service: String, account: String, accessGroup: String?) throws -> [String: Any] {
        guard let group = accessGroup ?? AppIdentity.keychainGroup,
              !group.isEmpty, group.count <= 256, !group.contains("$("), !group.contains("*") else {
            throw Failure.status(errSecMissingEntitlement)
        }
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: group,
        ]
        #if os(macOS)
        query[kSecUseDataProtectionKeychain as String] = true
        #endif
        return query
    }

    private static func add(_ data: Data, query: [String: Any]) -> OSStatus {
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(attributes as CFDictionary, nil)
    }
}
