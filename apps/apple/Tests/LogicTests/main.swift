// Pure-logic checks for the Apple app (pairing links, fingerprints, signing messages) plus
// crypto interop with the engine's lib/sync/crypto.mjs. Run via apps/apple/Tests/run-logic-tests.sh.
import CryptoKit
import Foundation
import Security

var failures = 0
func check(_ condition: Bool, _ name: String) {
    print((condition ? "PASS " : "FAIL ") + name)
    if !condition { failures += 1 }
}
func parseError(_ text: String) -> PairingLink.ParseError? {
    do { _ = try PairingLink.parse(text); return nil } catch { return error as? PairingLink.ParseError }
}

let fp = "PTRLhIjEEEUteCmjtXMT17Y_GZ97QmHV_s1PsR1c8u4"

// Notification metadata can choose only a paired engine and a bounded bot/room route.
let push: [String: Any] = ["v": 1, "engineId": "engine_home", "botId": "bot_atlas", "kind": "message", "eventId": "event_123"]
let destination = NotificationDestination(userInfo: ["studio": push])!
check(destination.hash == "#/bot/bot_atlas", "bot notification route")
var roomPush = push; roomPush["roomId"] = "room_team"; roomPush["url"] = "https://untrusted.example"
let roomDestination = NotificationDestination(userInfo: ["studio": roomPush])!
check(roomDestination.hash == "#/room/room_team", "room notification selects room and ignores supplied URL")
check(roomDestination.matchesVisibleHash("#/room/room_team") && !roomDestination.matchesVisibleHash("#/bot/bot_atlas"), "foreground suppression matches exact destination")
for field in ["engineId", "botId", "roomId"] {
    for invalid in ["", "../bots", "bot/other", "x?url=https://evil.example", "bot\nscript", String(repeating: "a", count: 121)] {
        var candidate = push; candidate[field] = invalid
        check(NotificationDestination(userInfo: ["studio": candidate]) == nil, "notification rejects unsafe \(field)")
    }
}
for pair: (String, Any) in [("v", 2), ("v", true), ("v", 1.2), ("kind", "approval"), ("roomId", NSNull()), ("eventId", ""), ("eventId", "bad\u{0}event")] {
    var candidate = push; candidate[pair.0] = pair.1
    check(NotificationDestination(userInfo: ["studio": candidate]) == nil, "notification rejects unsupported \(pair.0)")
}
let pushConnection = Connection(id: UUID(), name: "Fixture", baseURL: URL(string: "https://studio.example")!, deviceId: "device_one", fingerprint: fp, enginePublicKey: "", nodeId: "engine_home", kind: .remote, addedAt: Date(), lastUsed: Date())
check(destination.connectionID(in: [pushConnection]) == pushConnection.id, "notification matches a paired engine")
check(destination.connectionID(in: []) == nil, "notification cannot create an unknown engine connection")
var notificationNavigation = NotificationNavigation()
notificationNavigation.receive(destination)
check(notificationNavigation.destination(authenticated: false) == nil && notificationNavigation.pending == destination, "cold-start tap survives unauthenticated page")
check(notificationNavigation.destination(authenticated: true) == destination && notificationNavigation.pending == destination, "confirmed authentication retains route until page applies it")
notificationNavigation.receive(roomDestination)
notificationNavigation.didApply(destination)
check(notificationNavigation.pending == roomDestination, "late route callback cannot clear a newer notification tap")
notificationNavigation.didApply(roomDestination)
check(notificationNavigation.pending == nil, "applied authenticated route clears pending tap")
let pushDecoder = JSONDecoder()
for code in ["push_authorization_failed", "storage_unavailable", "delivery_unknown", "untrusted engine error text"] {
    let body: [String: Any] = ["available": true, "registered": true, "enabled": true, "botReplies": true, "routines": true, "delivery": ["status": "failed", "lastError": code]]
    let status = try! pushDecoder.decode(NotificationRegistrationStatus.self, from: JSONSerialization.data(withJSONObject: body))
    check(!status.deliverySummary.hasPrefix("Registered") && !status.deliverySummary.contains(code), "failed delivery never claims readiness or echoes raw error")
}

// encodeURIComponent-style link from the contract
let l1 = try! PairingLink.parse("hermes-studio://pair?v=1&url=https%3A%2F%2Fstudio.tail1234.ts.net&code=ABC123&fp=\(fp)&name=Home%20server&kind=device")
check(l1.baseURL.absoluteString == "https://studio.tail1234.ts.net", "base URL decoded")
check(l1.name == "Home server", "name %20 decoded")
check(l1.code == "ABC123" && l1.fingerprint == fp && l1.kind == .device, "code/fp/kind")

// URLSearchParams-style (what the engine actually emits): '+' for spaces, %2B for plus
let l2 = try! PairingLink.parse("hermes-studio://pair?v=1&url=http%3A%2F%2F127.0.0.1%3A4311&code=a_b-C&fp=\(fp)&name=Home+server+%2B+lab&kind=device")
check(l2.name == "Home server + lab", "URLSearchParams name decoded (got \(l2.name))")
check(l2.baseURL.absoluteString == "http://127.0.0.1:4311", "loopback base URL")
check(l2.baseURL.isLoopback && !l2.baseURL.isInsecureRemote, "loopback is not insecure-remote")

// path is reduced to the origin; surrounding pasted text is ignored
let l3 = try! PairingLink.parse("Here you go: hermes-studio://pair?url=https://x.example/studio/&code=Z&fp=\(fp)  thanks!")
check(l3.baseURL.absoluteString == "https://x.example", "origin only, extract from text, v defaults to 1")
check(l3.name == "x.example", "name defaults to host")

check(parseError("hermes-studio://pair?v=1&url=https%3A%2F%2Fa.b&code=X&fp=\(fp)&name=Hub&kind=engine") == .engineLink, "engine link rejected")
check(parseError("hermes-studio://pair?v=2&url=https%3A%2F%2Fa.b&code=X&fp=\(fp)") == .unsupportedVersion("2"), "v=2 rejected")
check(parseError("hermes-studio://pair?v=1&url=https%3A%2F%2Fa.b&fp=\(fp)") == .missing("code"), "missing code")
check(parseError("hermes-studio://pair?v=1&code=X&fp=\(fp)") == .missing("url"), "missing url")
check(parseError("hermes-studio://pair?v=1&url=ftp%3A%2F%2Fa.b&code=X&fp=\(fp)") == .invalidAddress, "ftp rejected")
check(parseError("hermes-studio://pair?v=1&url=https%3A%2F%2Fu%3Ap%40a.b&code=X&fp=\(fp)") == .invalidAddress, "credentials in URL rejected")
check(parseError("hermes-studio://pair?v=1&url=https%3A%2F%2Fa.b&code=X&fp=not*valid") == .invalidFingerprint, "bad fingerprint rejected")
check(parseError("https://example.com") == .notAPairingLink, "non-link rejected")
check(parseError("hermes-studio://other?x=1") == .notAPairingLink, "other action rejected")

// round trip
check((try? PairingLink.parse(l2.url.absoluteString)) == l2, "round trip through .url")

// URL helpers
check(URL(string: "http://100.101.102.103:4311")!.isEncryptedOverlay, "tailscale CGNAT is overlay")
check(URL(string: "http://192.168.1.5:4311")!.isInsecureRemote, "LAN http is insecure-remote")
check(URL(string: "https://a.b")!.isSameOrigin(as: URL(string: "https://A.b:443/x")!), "same origin with default port")
check(!URL(string: "http://a.b:4311")!.isSameOrigin(as: URL(string: "http://a.b:4312")!), "different port is different origin")

// Fingerprint formatting
check(Fingerprint.short(fp) == "PTRL HIJE", "short fingerprint format")
check(Fingerprint.grouped("abcdefgh12") == "abcd efgh 12", "grouped fingerprint")

// Signing messages
check(String(decoding: SigningMessages.pair(code: "C", publicKey: "K"), as: UTF8.self) == "hermes-studio/pair/v1\nC\nK", "pair message")
check(String(decoding: SigningMessages.paired(deviceId: "dev_1", publicKey: "K"), as: UTF8.self) == "hermes-studio/paired/v1\ndev_1\nK", "paired message")
check(String(decoding: SigningMessages.session(deviceId: "dev_1", timestamp: 1700000000123, nonce: "n"), as: UTF8.self) == "hermes-studio/session/v1\ndev_1\n1700000000123\nn", "session message")
check(Data.random(count: 16).base64URLEncodedString().count == 22, "16-byte nonce is 22 base64url chars")

// Interop with the engine's lib/sync/crypto.mjs
let dir = CommandLine.arguments[1]
let engineFile = "\(dir)/engine.json"
let engine = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: engineFile))) as! [String: Any]
let identity = engine["identity"] as! [String: Any]
let enginePub = Data(base64Encoded: identity["publicKey"] as! String)!
check(Fingerprint.of(publicKeyDER: enginePub) == identity["fingerprint"] as! String, "engine fingerprint computed identically")
let engineLink = try! PairingLink.parse(engine["link"] as! String)
check(engineLink.name == "Home server + lab" && engineLink.fingerprint == identity["fingerprint"] as! String, "engine-generated link parses")
check(Fingerprint.short(engineLink.fingerprint) == engine["short"] as! String, "short fingerprint matches engine shortFingerprint()")

// TLS pinning: the engine's own certificate is trusted by its identity key, never by a different key or without a pin.
let certificates = engine["certificates"] as! [String: String]
let ownCertificate = Data(base64Encoded: certificates["own"]!)!, engineFingerprint = identity["fingerprint"] as! String
check(ServerTrust.fingerprint(ofCertificateDER: ownCertificate) == engineFingerprint, "engine TLS certificate key matches the identity fingerprint")
check(ServerTrust.fingerprint(ofCertificateDER: Data(base64Encoded: certificates["p384"]!)!) == nil, "non-P-256 certificate keys are never pinnable")
func trust(for der: Data, host: String) -> SecTrust {
    var trust: SecTrust?
    SecTrustCreateWithCertificates(SecCertificateCreateWithData(nil, der as CFData)!, SecPolicyCreateSSL(true, host as CFString), &trust)
    return trust!
}
check(ServerTrust.evaluate(trust(for: ownCertificate, host: "203.0.113.5"), host: "203.0.113.5", fingerprint: engineFingerprint, requirePin: true) == .pinned, "own certificate with the paired key is pinned")
check(ServerTrust.evaluate(trust(for: ownCertificate, host: "203.0.113.5"), host: "203.0.113.5", fingerprint: engineFingerprint + "=", requirePin: false) == .pinned, "pin comparison ignores base64 padding")
check(ServerTrust.evaluate(trust(for: Data(base64Encoded: certificates["other"]!)!, host: "203.0.113.5"), host: "203.0.113.5", fingerprint: engineFingerprint, requirePin: false) == .reject, "another engine's certificate is refused")
check(ServerTrust.evaluate(trust(for: ownCertificate, host: "203.0.113.5"), host: "203.0.113.5", fingerprint: "", requirePin: false) == .reject, "a self-signed certificate without a pin is refused")
let report = TrustReport(); report.record(.system); check(!report.pinned, "system trust is not reported as pinned"); report.record(.pinned); check(report.pinned, "pinned trust is reported")

let key = P256.Signing.PrivateKey()
let pub = key.publicKey.derRepresentation.base64EncodedString()
let code = "abc_DEF-123", deviceId = "dev_test", timestamp: Int64 = 1761526800000
let nonce = Data.random(count: 16).base64URLEncodedString()
let proof = try! key.signature(for: SigningMessages.pair(code: code, publicKey: pub)).derRepresentation.base64EncodedString()
let sessionSig = try! key.signature(for: SigningMessages.session(deviceId: deviceId, timestamp: timestamp, nonce: nonce)).derRepresentation.base64EncodedString()
let out: [String: Any] = ["publicKey": pub, "code": code, "proof": proof, "deviceId": deviceId, "timestamp": timestamp, "nonce": nonce,
                          "sessionSignature": sessionSig, "deviceFingerprint": Fingerprint.of(publicKeyDER: key.publicKey.derRepresentation), "engineFile": engineFile]
if CommandLine.arguments.count <= 2 {
    try! JSONSerialization.data(withJSONObject: out).write(to: URL(fileURLWithPath: "\(dir)/swift.json"))
    try! JSONSerialization.data(withJSONObject: out).write(to: URL(fileURLWithPath: "\(dir)/swift.json.first"))
}
if CommandLine.arguments.count > 2 {
    let saved = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: "\(dir)/swift.json.first"))) as! [String: Any]
    let pub = saved["publicKey"] as! String
    let engineProof = try! String(contentsOfFile: engineFile + ".proof", encoding: .utf8)
    check(EngineSignature.isValid(signatureBase64: engineProof, message: SigningMessages.paired(deviceId: deviceId, publicKey: pub), publicKeyDER: enginePub), "engineProof from Node verifies in Swift")
    check(!EngineSignature.isValid(signatureBase64: engineProof, message: SigningMessages.paired(deviceId: "dev_other", publicKey: pub), publicKeyDER: enginePub), "engineProof rejected for other deviceId")
}
print(failures == 0 ? "ALL PASSED" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
