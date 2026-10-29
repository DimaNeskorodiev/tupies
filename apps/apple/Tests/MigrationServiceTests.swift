import CryptoKit
import Foundation

private enum Injected: Error { case failure }
private final class MemoryKeychain: PairingMigrationKeychain {
    var items: [String: Data] = [:]
    var failRead = false
    var failCompletionOnce = false
    var writes: [(String, String, String)] = []
    func index(_ service: String, _ account: String, _ group: String) -> String { "\(group)|\(service)|\(account)" }
    func read(service: String, account: String, group: String, legacyMacFallback: Bool) throws -> Data? {
        if failRead { throw Injected.failure }; return items[index(service, account, group)]
    }
    func insert(_ data: Data, service: String, account: String, group: String) throws {
        let key = index(service, account, group)
        if items[key] == nil { items[key] = data; writes.append((service, account, group)) }
    }
    func save(_ data: Data, service: String, account: String, group: String) throws {
        if failCompletionOnce && account == AppIdentity.completionAccount { failCompletionOnce = false; throw Injected.failure }
        items[index(service, account, group)] = data; writes.append((service, account, group))
    }
}
private final class MemoryPreferences: PairingMigrationPreferences {
    var values: [String: Any] = [:]
    var failCommitOnce = false
    var corruptCommitOnce = false
    func object(forKey key: String) -> Any? { values[key] }
    func commit(_ values: [String: Any], removing keys: Set<String>) throws {
        if failCommitOnce { failCommitOnce = false; throw Injected.failure }
        for key in keys { self.values.removeValue(forKey: key) }
        for (key, value) in values { self.values[key] = value }
        if corruptCommitOnce && values[AppSettings.connections] != nil {
            corruptCommitOnce = false; self.values[AppSettings.connections] = Data("invalid".utf8)
        }
    }
}
private struct Fixture {
    let keychain = MemoryKeychain()
    let old = MemoryPreferences()
    let new = MemoryPreferences()
    let oldGroup = "TESTPREFIX.dev.hermesstudio.app"
    let newGroup = "TESTPREFIX.dev.tupies.app"
    let connection: Connection
    let originalRecord: Data
    init() throws {
        let engine = P256.Signing.PrivateKey(), device = P256.Signing.PrivateKey()
        connection = Connection(id: UUID(), name: "Migration fixture", baseURL: URL(string: "http://127.0.0.1:4311")!, deviceId: "dev_fixture", fingerprint: Fingerprint.of(publicKeyDER: engine.publicKey.derRepresentation), enginePublicKey: engine.publicKey.derRepresentation.base64EncodedString(), nodeId: "node_fixture", kind: .local, addedAt: Date(timeIntervalSince1970: 1_700_000_000.123456), lastUsed: Date(timeIntervalSince1970: 1_700_000_010.654321))
        originalRecord = try JSONSerialization.data(withJSONObject: ["kind": "software", "data": device.rawRepresentation.base64EncodedString()])
        old.values = ["hermes.connections.v1": try JSONEncoder().encode([connection]), "hermes.activeConnection.v1": connection.id.uuidString,
                      "hermes.deviceName": "Transfer fixture", "hermes.local.removedIdentities.v1": [connection.fingerprint],
                      "hermes.notifications.enabled": true, "hermes.notifications.botReplies": false, "hermes.notifications.routines": true,
                      "hermes.notifications.connection": connection.id.uuidString, "hermes.local.nodePath": "~/.local/bin/node"]
        keychain.items[keychain.index(AppIdentity.legacyDeviceKeyService, connection.id.uuidString, oldGroup)] = originalRecord
    }
    func bridge() -> PairingMigrationService { PairingMigrationService(keychain: keychain, current: old, legacy: nil, newGroup: newGroup, oldGroup: oldGroup, bundleIdentifier: AppIdentity.legacyBundleIdentifier, legacyMacFallback: true) }
    func primary(required: Bool = true, macLegacy: Bool = false) -> PairingMigrationService { PairingMigrationService(keychain: keychain, current: new, legacy: macLegacy ? old : nil, newGroup: newGroup, oldGroup: oldGroup, bundleIdentifier: AppIdentity.primaryBundleIdentifier, legacyMacFallback: false, requiresLegacyTransfer: required) }
    var oldKeyIndex: String { keychain.index(AppIdentity.legacyDeviceKeyService, connection.id.uuidString, oldGroup) }
    var newKeyIndex: String { keychain.index(AppIdentity.deviceKeyService, connection.id.uuidString, newGroup) }
    var envelopeIndex: String { keychain.index(AppIdentity.migrationService, AppIdentity.envelopeAccount, newGroup) }
    var completionIndex: String { keychain.index(AppIdentity.migrationService, AppIdentity.completionAccount, newGroup) }
}

@main
private struct MigrationServiceTests {
    static var checks = 0
    static func check(_ ok: @autoclosure () throws -> Bool, _ name: String) throws {
        guard try ok() else { fatalError("FAIL \(name)") }; checks += 1; print("PASS \(name)")
    }
    static func refuses(_ name: String, _ operation: () throws -> Void) throws {
        do { try operation() } catch { checks += 1; print("PASS \(name)"); return }; fatalError("FAIL \(name)")
    }
    static func main() throws {
        let fixture = try Fixture(), originalPreferences = NSDictionary(dictionary: fixture.old.values)
        let exported = try fixture.bridge().exportLegacy()
        try check(exported.connections == 1, "bridge prepares original connection")
        try check(fixture.keychain.items[fixture.oldKeyIndex] == fixture.originalRecord, "source key is never deleted or changed")
        try check(fixture.keychain.items[fixture.newKeyIndex] == fixture.originalRecord, "opaque record copied byte-for-byte inside Keychain")
        try check(originalPreferences.isEqual(to: fixture.old.values), "source preferences remain unchanged")
        try check(fixture.keychain.writes.allSatisfy { $0.2 == fixture.newGroup }, "all transfer writes target only the new exact group")
        try check(fixture.keychain.writes.allSatisfy { $0.0 != AppIdentity.sessionService }, "session bearer tokens are never migrated")
        let envelope = try PairingMigrationEnvelope.decode(fixture.keychain.items[fixture.envelopeIndex]!)
        try check(envelope.preferences.connections[0] == fixture.connection, "UUID device identity pin and subsecond dates preserved")
        _ = try fixture.primary().preparePrimary()
        try check(fixture.keychain.items[fixture.completionIndex] != nil, "completion marker follows key and preference verification")
        try check(fixture.new.values[AppSettings.active] as? String == fixture.connection.id.uuidString, "active engine selection preserved")
        try check(fixture.new.values[AppSettings.notificationsReplies] as? Bool == false, "notification category preferences preserved")
        try check(fixture.new.values[AppSettings.notificationsRegistrations] == nil, "old-topic push registrations are not copied")
        let imported = try JSONDecoder().decode([Connection].self, from: fixture.new.values[AppSettings.connections] as! Data)
        try check(imported == [fixture.connection], "durable settings read back as original connections")
        fixture.new.values[AppSettings.connections] = try JSONEncoder().encode([Connection]())
        // Keep valid-but-stale selectors to model a crash between normal removal and its async callbacks.
        fixture.keychain.items.removeValue(forKey: fixture.newKeyIndex)
        _ = try fixture.primary().preparePrimary(); _ = try fixture.bridge().exportLegacy()
        try check(fixture.keychain.items[fixture.newKeyIndex] == nil, "completed transfer never resurrects a deliberately removed key")
        try check((try JSONDecoder().decode([Connection].self, from: fixture.new.values[AppSettings.connections] as! Data)).isEmpty, "completed transfer respects later connection removal")

        let missing = try Fixture(); missing.keychain.items.removeValue(forKey: missing.oldKeyIndex)
        try refuses("missing original key fails without replacements") { _ = try missing.bridge().exportLegacy() }
        try check(missing.keychain.items[missing.newKeyIndex] == nil, "missing source cannot create a new identity")
        try refuses("existing-install release refuses absent envelope") { _ = try missing.primary().preparePrimary() }
        try check(try missing.primary(required: false).preparePrimary() == nil, "genuine fresh install works without a bridge")

        let collision = try Fixture(), different = P256.Signing.PrivateKey()
        let differentRecord = try JSONSerialization.data(withJSONObject: ["kind":"software", "data":different.rawRepresentation.base64EncodedString()])
        collision.keychain.items[collision.newKeyIndex] = differentRecord
        try refuses("different destination key is never overwritten") { _ = try collision.bridge().exportLegacy() }
        try check(collision.keychain.items[collision.newKeyIndex] == differentRecord && collision.keychain.items[collision.oldKeyIndex] == collision.originalRecord, "collision preserves both original key records")
        try refuses("incomplete transfer intent blocks a fresh-start fallback") { _ = try collision.primary(required: false).preparePrimary() }

        let retry = try Fixture(); _ = try retry.bridge().exportLegacy(); retry.keychain.failCompletionOnce = true
        try refuses("completion write failure leaves transfer incomplete") { _ = try retry.primary().preparePrimary() }
        try check(retry.keychain.items[retry.completionIndex] == nil, "failed marker never claims success")
        let originalEnvelope = retry.keychain.items[retry.envelopeIndex]
        _ = try retry.bridge().exportLegacy()
        try check(retry.keychain.items[retry.envelopeIndex] == originalEnvelope, "bridge retry preserves the exact pending handoff digest")
        _ = try retry.primary().preparePrimary()
        try check(retry.keychain.items[retry.completionIndex] != nil, "same-envelope retry completes after committed preferences")
        try check(retry.keychain.items[retry.oldKeyIndex] == retry.originalRecord, "retry preserves legacy source")

        let preferencesFailure = try Fixture(); _ = try preferencesFailure.bridge().exportLegacy(); preferencesFailure.new.failCommitOnce = true
        try refuses("preference save failure cannot complete migration") { _ = try preferencesFailure.primary().preparePrimary() }
        try check(preferencesFailure.keychain.items[preferencesFailure.completionIndex] == nil, "settings failure leaves no completion marker")
        _ = try preferencesFailure.primary().preparePrimary()
        try check(preferencesFailure.keychain.items[preferencesFailure.completionIndex] != nil, "preference failure is retry safe")

        retry.new.values[AppSettings.connections] = Data("invalid".utf8)
        try refuses("completed marker cannot bypass corrupt connection settings") { _ = try retry.primary().preparePrimary() }
        let corrupt = try Fixture(); _ = try corrupt.bridge().exportLegacy(); corrupt.keychain.items[corrupt.envelopeIndex] = Data("invalid".utf8)
        try refuses("malformed envelope blocks initialization") { _ = try corrupt.primary().preparePrimary() }
        let denied = try Fixture(); denied.keychain.failRead = true
        try refuses("Keychain permission/read failure is never interpreted as fresh install") { _ = try denied.primary(required: false).preparePrimary() }

        let legacyMalformed = try Fixture(); legacyMalformed.old.values["hermes.connections.v1"] = "invalid"
        try refuses("malformed legacy settings require recovery instead of autopair") { _ = try legacyMalformed.primary(required: false, macLegacy: true).preparePrimary() }
        let removed = try Fixture(); removed.old.values = ["hermes.local.removedIdentities.v1": [removed.connection.fingerprint]]
        try refuses("legacy removal suppression alone requires transfer") { _ = try removed.primary(required: false, macLegacy: true).preparePrimary() }
        print("ALL \(checks) MIGRATION SERVICE CHECKS PASSED; no system Keychain, account, engine or device was accessed")
    }
}
