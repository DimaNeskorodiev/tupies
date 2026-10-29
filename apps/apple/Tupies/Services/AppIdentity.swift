import Foundation

enum AppIdentity {
    static let primaryBundleIdentifier = "dev.tupies.app"
    static let legacyBundleIdentifier = "dev.hermesstudio.app"
    static let deviceKeyService = "dev.tupies.app.device-key"
    static let sessionService = "dev.tupies.app.session"
    static let legacyDeviceKeyService = "dev.hermesstudio.app.device-key"
    static let migrationService = "dev.tupies.app.migration"
    static let envelopeAccount = "legacy-transfer-v1"
    static let completionAccount = "legacy-transfer-complete-v1"
    static let startedAccount = "legacy-transfer-started-v1"

    static var requiresLegacyTransfer: Bool {
        let value = Bundle.main.object(forInfoDictionaryKey: "TupiesRequiresLegacyTransfer")
        return (value as? Bool) == true || (value as? String)?.uppercased() == "YES"
    }

    /// Xcode expands this from the selected provisioning profile, not a guessed Team ID.
    static var keychainGroup: String? {
        group(for: primaryBundleIdentifier, key: "TupiesKeychainGroup")
    }
    static var legacyKeychainGroup: String? {
        group(for: legacyBundleIdentifier, key: "TupiesLegacyKeychainGroup")
    }

    private static func group(for bundle: String, key: String) -> String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              value.hasSuffix(bundle) else { return nil }
        let prefix = String(value.dropLast(bundle.count))
        guard prefix.hasSuffix("."), (2...129).contains(prefix.count),
              prefix.dropLast().utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) }) else { return nil }
        return value
    }
}

enum AppSettings {
    static let connections = "tupies.connections.v1"
    static let active = "tupies.activeConnection.v1"
    static let deviceName = "tupies.deviceName"
    static let suppressedLocalIdentities = "tupies.local.removedIdentities.v1"
    static let notificationsEnabled = "tupies.notifications.enabled"
    static let notificationsReplies = "tupies.notifications.botReplies"
    static let notificationsRoutines = "tupies.notifications.routines"
    static let notificationsConnection = "tupies.notifications.connection"
    static let notificationsRegistrations = "tupies.notifications.registrations"
    static let studioFolder = "tupies.local.studioFolder"
    static let nodePath = "tupies.local.nodePath"
}
