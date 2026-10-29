import CryptoKit
import Foundation

@main
struct MigrationEnvelopeTests {
    static var failures = 0
    static var checks = 0
    static func check(_ value: Bool, _ label: String) {
        checks += 1
        if !value { failures += 1; print("FAIL \(label)") }
    }
    static func rejects(_ value: PairingMigrationEnvelope, _ label: String) {
        do { try value.validate(); check(false, label) } catch { check(true, label) }
    }
    static func rejectsData(_ value: Data, _ label: String) {
        do { _ = try PairingMigrationEnvelope.decode(value); check(false, label) } catch { check(true, label) }
    }
    static func fixture() -> PairingMigrationEnvelope {
        let engine = P256.Signing.PrivateKey().publicKey.derRepresentation
        let device = P256.Signing.PrivateKey().publicKey.derRepresentation
        let id = UUID(), date = Date(timeIntervalSince1970: 1_800_000_000.123456)
        let connection = Connection(id: id, name: "Synthetic engine", baseURL: URL(string: "https://studio.example")!, deviceId: "dev_fixture", fingerprint: Fingerprint.of(publicKeyDER: engine), enginePublicKey: engine.base64EncodedString(), nodeId: "node_fixture", kind: .remote, addedAt: date, lastUsed: date.addingTimeInterval(0.765432), pinnedTLS: true)
        let preferences = PairingMigrationEnvelope.Preferences(connections: [connection], activeID: id, deviceName: "Synthetic device", suppressedLocalFingerprints: [Fingerprint.of(publicKeyDER: P256.Signing.PrivateKey().publicKey.derRepresentation)], notificationEnabled: true, notificationBotReplies: false, notificationRoutines: true, notificationConnectionID: id, studioFolder: "~/Synthetic/Tupies", nodePath: "/Synthetic/node/bin/node")
        return PairingMigrationEnvelope(preferences: preferences, keyProofs: [.init(connectionID: id, publicKeyDERBase64: device.base64EncodedString(), storageKind: "software")], exportedAt: date.addingTimeInterval(1.987654))
    }
    static func mutatedJSON(_ data: Data, _ mutate: (inout [String: Any]) -> Void) throws -> Data {
        var object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        mutate(&object)
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
    static func main() throws {
        let original = fixture(), data = try original.encoded(), restored = try PairingMigrationEnvelope.decode(data)
        check(restored.preferences.connections == original.preferences.connections, "Connection metadata including subsecond dates survives exactly")
        check(restored.exportedAt == original.exportedAt, "Export timestamp preserves subsecond precision")
        check(restored.preferences.activeID == original.preferences.activeID && restored.preferences.notificationConnectionID == original.preferences.notificationConnectionID, "References survive")
        check(restored.preferences.studioFolder == original.preferences.studioFolder && restored.preferences.nodePath == original.preferences.nodePath, "Absolute and tilde paths survive without file access")
        check(restored.preferences.notificationEnabled && !restored.preferences.notificationBotReplies && restored.preferences.notificationRoutines, "Notification preferences survive exactly")
        check(restored.keyProofs[0].publicKeyDERBase64 != restored.preferences.connections[0].enginePublicKey, "Device proof is distinct from engine public identity")
        check(!String(decoding: data, as: UTF8.self).contains("privateKey") && !String(decoding: data, as: UTF8.self).contains("token"), "Encoded schema contains no secret fields")
        var value = original
        value.version = 2; rejects(value, "Unknown version refused")
        value = original; value.sourceBundleIdentifier = "wrong.source"; rejects(value, "Wrong source refused")
        value = original; value.destinationBundleIdentifier = "wrong.destination"; rejects(value, "Wrong destination refused")
        value = original; value.exportedAt = Date(timeIntervalSince1970: .infinity); rejects(value, "Nonfinite export time refused")
        value = original; value.preferences.connections[0].lastUsed = Date(timeIntervalSince1970: 1); rejects(value, "Out-of-range Connection time refused")
        value = original; value.preferences.activeID = UUID(); rejects(value, "Dangling active reference refused")
        value = original; value.preferences.notificationConnectionID = UUID(); rejects(value, "Dangling notification reference refused")
        value = original; value.preferences.deviceName = "Bad\nname"; rejects(value, "Control characters refused")
        value = original; value.preferences.deviceName = String(repeating: "x", count: 161); rejects(value, "Device name bounded")
        value = original; value.preferences.nodePath = "relative/node"; rejects(value, "Relative executable path refused")
        value = original; value.preferences.studioFolder = String(repeating: "/", count: 4097); rejects(value, "Stored paths bounded")
        value = original; value.preferences.connections[0].name = String(repeating: "x", count: 81); rejects(value, "Connection name bounded")
        value = original; value.preferences.connections[0].deviceId = "dev/escape"; rejects(value, "Unsafe device identity refused")
        value = original; value.preferences.connections[0].nodeId = "node\ninjection"; rejects(value, "Unsafe node identity refused")
        value = original; value.preferences.connections[0].fingerprint = String(repeating: "a", count: 43); rejects(value, "Engine key fingerprint mismatch refused")
        value = original; value.preferences.connections[0].enginePublicKey = Data(repeating: 0, count: 91).base64EncodedString(); rejects(value, "Malformed engine P256 key refused")
        value = original; value.preferences.connections[0].enginePublicKey = P384.Signing.PrivateKey().publicKey.derRepresentation.base64EncodedString(); rejects(value, "Wrong curve engine key refused")
        for url in ["https://user:pass@studio.example", "https://studio.example/path", "https://studio.example?query=x", "https://studio.example#fragment", "ftp://studio.example", "https://studio.example/"] {
            value = original; value.preferences.connections[0].baseURL = URL(string: url)!; rejects(value, "Non-origin URL refused")
        }
        value = original; value.preferences.connections[0].baseURL = URL(string: "http://127.0.0.1:4311")!; rejects(value, "Pinned TLS cannot use HTTP")
        value.preferences.connections[0].pinnedTLS = nil; try value.validate(); check(true, "Unpinned loopback HTTP origin remains valid")
        value = original; value.preferences.connections.append(value.preferences.connections[0]); rejects(value, "Duplicate Connection UUID refused")
        value = original; var duplicate = value.preferences.connections[0]; duplicate.id = UUID(); value.preferences.connections.append(duplicate); rejects(value, "Duplicate device ID refused")
        value = original; value.preferences.connections = Array(repeating: value.preferences.connections[0], count: 33); rejects(value, "Connection count bounded")
        value = original; value.preferences.suppressedLocalFingerprints = Array(repeating: value.preferences.suppressedLocalFingerprints[0], count: 129); rejects(value, "Suppression count bounded")
        value = original; value.preferences.suppressedLocalFingerprints.append(value.preferences.suppressedLocalFingerprints[0]); rejects(value, "Duplicate suppression refused")
        value = original; value.preferences.suppressedLocalFingerprints = ["not-a-fingerprint"]; rejects(value, "Malformed suppression refused")
        value = original; value.keyProofs = []; rejects(value, "Missing device proof refused")
        value = original; value.keyProofs.append(value.keyProofs[0]); rejects(value, "Duplicate device proof refused")
        value = original; value.keyProofs[0].connectionID = UUID(); rejects(value, "Foreign device proof refused")
        value = original; value.keyProofs[0].storageKind = "unknown"; rejects(value, "Unknown key storage refused")
        value = original; value.keyProofs[0].publicKeyDERBase64 = Data(repeating: 0, count: 91).base64EncodedString(); rejects(value, "Invalid device P256 point refused")
        value = original; value.keyProofs[0].publicKeyDERBase64 = P384.Signing.PrivateKey().publicKey.derRepresentation.base64EncodedString(); rejects(value, "Wrong device key curve refused")
        value = original; value.keyProofs[0].publicKeyDERBase64 += "="; rejects(value, "Noncanonical device public encoding refused")
        rejectsData(Data(data.dropLast()), "Truncated JSON refused")
        rejectsData(Data("[]".utf8), "Nonobject JSON refused")
        rejectsData(Data(repeating: 32, count: PairingMigrationEnvelope.maximumEncodedBytes + 1), "Oversized JSON refused before decoding")
        rejectsData(try mutatedJSON(data) { $0["privateKey"] = "synthetic forbidden field" }, "Unknown root secret field refused")
        rejectsData(try mutatedJSON(data) { var preferences = $0["preferences"] as! [String: Any]; preferences["sessionToken"] = "synthetic forbidden field"; $0["preferences"] = preferences }, "Unknown preference secret field refused")
        rejectsData(try mutatedJSON(data) { var preferences = $0["preferences"] as! [String: Any]; var connections = preferences["connections"] as! [[String: Any]]; connections[0]["token"] = "synthetic forbidden field"; preferences["connections"] = connections; $0["preferences"] = preferences }, "Unknown Connection secret field refused")
        rejectsData(try mutatedJSON(data) { var proofs = $0["keyProofs"] as! [[String: Any]]; proofs[0]["keyData"] = "synthetic forbidden field"; $0["keyProofs"] = proofs }, "Unknown proof key material refused")
        print("Migration envelope checks: \(checks - failures)/\(checks) passed; synthetic metadata only, no Keychain/device/account writes.")
        if failures > 0 { exit(1) }
    }
}
