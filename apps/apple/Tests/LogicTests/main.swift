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
var pairingIntent = LocalEnginePairingIntent()
check(pairingIntent.permitsAutomaticConnection(to: fp), "new local identity allows the existing zero-click flow")
pairingIntent.removed(fp)
pairingIntent = LocalEnginePairingIntent(suppressedFingerprints: pairingIntent.suppressedFingerprints)
check(!pairingIntent.permitsAutomaticConnection(to: fp + "="), "local removal intent survives persistence and app relaunch")
let otherFingerprint = "UotherEngineFingerprintOtherIdentity_123456789"
pairingIntent.removed(otherFingerprint); pairingIntent.explicitlyConnected(fp)
check(pairingIntent.permitsAutomaticConnection(to: fp) && !pairingIntent.permitsAutomaticConnection(to: otherFingerprint), "explicit reconnect clears suppression only for that engine identity")

// Bundled code stays separate from persistent data and never adopts an unmarked folder.
let payloadRoot = FileManager.default.temporaryDirectory.appendingPathComponent("tupies-native-payload-\(UUID().uuidString)")
try! FileManager.default.createDirectory(at: payloadRoot, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: payloadRoot) }
let resources = payloadRoot.appendingPathComponent("Resources"), support = payloadRoot.appendingPathComponent("Support")
try! FileManager.default.createDirectory(at: resources.appendingPathComponent("Engine"), withIntermediateDirectories: true)
try! FileManager.default.createDirectory(at: resources.appendingPathComponent("Runtime"), withIntermediateDirectories: true)
try! FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
try! Data("// fixture".utf8).write(to: resources.appendingPathComponent("Engine/server.mjs"))
try! Data("fixture-runtime".utf8).write(to: resources.appendingPathComponent("Runtime/node"))
try! FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: resources.appendingPathComponent("Runtime/node").path)
let payload = LocalEnginePayload(resources: resources, applicationSupport: support)
check(payload.isAvailable, "bundled engine and runtime are located relative to application resources")
let dataDirectory = try! payload.prepareDataDirectory()
try! Data("retained engine identity fixture".utf8).write(to: dataDirectory.appendingPathComponent("identity-fixture"))
check((try? payload.prepareDataDirectory()) == dataDirectory && (try? String(contentsOf: dataDirectory.appendingPathComponent("identity-fixture"), encoding: .utf8)) == "retained engine identity fixture", "managed data survives repeated bundled launches outside the signed resources")
check(!dataDirectory.path.hasPrefix(resources.path + "/"), "bundled engine data never lives inside the application payload")
let managedEngineKey = P256.Signing.PrivateKey()
let managedPublicKey = managedEngineKey.publicKey.derRepresentation
let managedIdentity = try! JSONSerialization.data(withJSONObject: ["nodeId": "node_managed", "publicKey": managedPublicKey.base64EncodedString()])
try! FileManager.default.createDirectory(at: dataDirectory.appendingPathComponent("sync"), withIntermediateDirectories: false)
try! managedIdentity.write(to: dataDirectory.appendingPathComponent("sync/identity.json"))
let managedConnection = Connection(id: UUID(), name: "This Mac", baseURL: URL(string: "http://127.0.0.1:4310")!, deviceId: "dev_fixture", fingerprint: Fingerprint.of(publicKeyDER: managedPublicKey), enginePublicKey: managedPublicKey.base64EncodedString(), nodeId: "node_managed", kind: .local, addedAt: Date(), lastUsed: Date())
check(!payload.matchesManagedConnection(managedConnection), "unassociated marker never adopts an offline legacy pairing")
try! payload.associate(managedConnection)
check(payload.matchesManagedConnection(managedConnection), "automatic bundled restart requires its verified managed identity")
check(LocalEngineStartPolicy.mayLaunch(expectedConnection: nil, matchesManagedPayload: false), "a fresh installation can start its included engine")
check(LocalEngineStartPolicy.mayLaunch(expectedConnection: managedConnection, matchesManagedPayload: payload.matchesManagedConnection(managedConnection)), "an exact managed pairing permits its own restart")
var otherConnection = managedConnection; otherConnection.fingerprint = "other-engine-fingerprint"
check(!payload.matchesManagedConnection(otherConnection), "another engine identity never resumes the bundled data")
check(!LocalEngineStartPolicy.mayLaunch(expectedConnection: otherConnection, matchesManagedPayload: payload.matchesManagedConnection(otherConnection)), "managed identity mismatch refuses process launch")
otherConnection = managedConnection; otherConnection.baseURL = URL(string: "http://127.0.0.1:4311")!
check(!payload.matchesManagedConnection(otherConnection), "offline legacy 4311 connection never resumes a different bundled port")
check(!LocalEngineStartPolicy.mayLaunch(expectedConnection: otherConnection, matchesManagedPayload: payload.matchesManagedConnection(otherConnection)), "offline external 4311 cannot launch a replacement workspace")
check(!LocalEngineStartPolicy.mayLaunch(expectedConnection: managedConnection, matchesManagedPayload: false), "an imported developer path cannot authorize an external engine restart")
let startEngineKey = P256.Signing.PrivateKey()
var expectedStart = managedConnection
expectedStart.enginePublicKey = startEngineKey.publicKey.derRepresentation.base64EncodedString()
expectedStart.fingerprint = Fingerprint.of(publicKeyDER: startEngineKey.publicKey.derRepresentation)
let expectedInfo = EngineInfo(product: "hermes-studio", version: "0.5.0", name: "Fixture", fingerprint: expectedStart.fingerprint, publicKey: expectedStart.enginePublicKey, role: "node", nodeId: expectedStart.nodeId, protocols: .init(deviceSession: 2))
check(LocalEngineStartPolicy.matchesRunningEngine(expectedInfo, at: expectedStart.baseURL, expected: expectedStart), "existing exact v2 engine attaches without a new process")
check(!LocalEngineStartPolicy.matchesRunningEngine(expectedInfo, at: URL(string: "http://127.0.0.1:4311")!, expected: expectedStart), "unrelated discovery address cannot win an existing start")
let oldInfo = EngineInfo(product: expectedInfo.product, version: "old", name: "Fixture", fingerprint: expectedInfo.fingerprint, publicKey: expectedInfo.publicKey, role: "node", nodeId: expectedInfo.nodeId, protocols: nil)
check(!LocalEngineStartPolicy.matchesRunningEngine(oldInfo, at: expectedStart.baseURL, expected: expectedStart), "legacy protocol cannot satisfy an existing start")
let wrongNodeInfo = EngineInfo(product: expectedInfo.product, version: expectedInfo.version, name: "Fixture", fingerprint: expectedInfo.fingerprint, publicKey: expectedInfo.publicKey, role: "node", nodeId: "node_other", protocols: expectedInfo.protocols)
check(!LocalEngineStartPolicy.matchesRunningEngine(wrongNodeInfo, at: expectedStart.baseURL, expected: expectedStart), "same public key on another node cannot satisfy an existing start")
var wrongExpected = expectedStart; wrongExpected.fingerprint = fp
check(!LocalEngineStartPolicy.matchesRunningEngine(expectedInfo, at: expectedStart.baseURL, expected: wrongExpected), "another fingerprint cannot satisfy an existing start")
var missingNodeExpected = expectedStart; missingNodeExpected.nodeId = nil
check(!LocalEngineStartPolicy.matchesRunningEngine(expectedInfo, at: expectedStart.baseURL, expected: missingNodeExpected), "missing saved node identity never authorizes native engine management")
check(LocalEngineStartPolicy.destinationIsOffline(URLError(.cannotConnectToHost)), "a refused connection permits the managed offline-start check")
let startFailures: [Error] = [URLError(.timedOut), URLError(.networkConnectionLost), URLError(.secureConnectionFailed), EngineError.certificateMismatch(engine: "Fixture"), EngineError.engineUpdateRequired(engine: "Fixture"), EngineError.http(status: 503, message: "Fixture"), EngineError.invalidResponse]
for failure in startFailures {
    check(!LocalEngineStartPolicy.destinationIsOffline(failure), "an answering or indeterminate endpoint never authorizes another process")
}
check(LocalEngineStartPolicy.retains(expectedStart, expected: expectedStart) && !LocalEngineStartPolicy.retains(nil, expected: expectedStart), "removal during reconnect cannot clear its suppression or re-pair")
let movedData = payload.supportDirectory.appendingPathComponent("retained-data")
try! FileManager.default.moveItem(at: dataDirectory, to: movedData)
check(!payload.matchesManagedConnection(managedConnection) && (try? payload.prepareDataDirectory()) == nil && !FileManager.default.fileExists(atPath: dataDirectory.path), "missing managed data never creates a replacement workspace on restart")
check(!LocalEngineStartPolicy.mayLaunch(expectedConnection: managedConnection, matchesManagedPayload: payload.matchesManagedConnection(managedConnection)), "missing managed data refuses process launch")
try! FileManager.default.moveItem(at: movedData, to: dataDirectory)
let identityFile = dataDirectory.appendingPathComponent("sync/identity.json")
try! FileManager.default.removeItem(at: identityFile)
check(!payload.matchesManagedConnection(managedConnection) && (try? payload.prepareDataDirectory()) == nil, "retained directory without original identity cannot initialize a fresh engine")
try! Data("{\"nodeId\":\"node_other\",\"publicKey\":\"AA==\"}".utf8).write(to: identityFile)
check(!payload.matchesManagedConnection(managedConnection) && (try? payload.prepareDataDirectory()) == nil, "another workspace identity cannot be opened under a retained ownership marker")
try! FileManager.default.removeItem(at: identityFile)
let identityOutside = payloadRoot.appendingPathComponent("public-identity-fixture.json")
try! managedIdentity.write(to: identityOutside)
try! FileManager.default.createSymbolicLink(at: identityFile, withDestinationURL: identityOutside)
check(!payload.matchesManagedConnection(managedConnection) && (try? payload.prepareDataDirectory()) == nil, "symlinked retained identity cannot authorize engine startup")
try! FileManager.default.removeItem(at: identityFile)
try! managedIdentity.write(to: identityFile)
try! FileManager.default.removeItem(at: payload.markerURL)
check((try? payload.prepareDataDirectory()) == nil && FileManager.default.fileExists(atPath: dataDirectory.appendingPathComponent("identity-fixture").path), "existing unmarked data is refused without deleting its identity")
try! FileManager.default.removeItem(at: dataDirectory)
let outside = payloadRoot.appendingPathComponent("outside")
try! FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
try! FileManager.default.createSymbolicLink(at: dataDirectory, withDestinationURL: outside)
check((try? payload.prepareDataDirectory()) == nil && (try? FileManager.default.contentsOfDirectory(atPath: outside.path)) == [], "symlinked bundled data is refused without writing outside it")

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
let pinnedLink = try! PairingLink.parse("hermes-studio://pair?v=1&url=https%3A%2F%2Fengine.example&code=C&fp=\(fp)&tls=engine")
check(pinnedLink.requiresPinnedTLS, "engine TLS link requires its identity key before first contact")
check((try? PairingLink.parse(pinnedLink.url.absoluteString)) == pinnedLink, "mandatory TLS pin survives link round trip")
check(parseError("hermes-studio://pair?url=http://engine.example&code=C&fp=\(fp)&tls=engine") == .invalidAddress, "mandatory engine pin cannot use plaintext HTTP")
check(parseError("hermes-studio://pair?url=https://engine.example&code=C&fp=\(fp)&tls=other") == .unsupportedTransport, "unknown link security mode never downgrades silently")

var startupLink = StartupPairingLink()
check(startupLink.offer(l2.url), "cold-start pairing link waits in memory for initialization")
check(!startupLink.offer(URL(string: "hermes-studio://unrelated")!), "unrelated URL cannot replace a queued pairing link")
check(!startupLink.offer(URL(string: l2.url.absoluteString + "&name=" + String(repeating: "x", count: 16_385))!), "oversized cold-start pairing link is refused")
check(startupLink.take() == l2.url && startupLink.take() == nil, "cold-start pairing link is consumed exactly once")
check(startupLink.offer(pinnedLink.url) && startupLink.take() == pinnedLink.url, "cold-start handoff preserves mandatory TLS pin")

// URL helpers
check(URL(string: "http://100.101.102.103:4311")!.isEncryptedOverlay, "tailscale CGNAT is overlay")
check(URL(string: "http://192.168.1.5:4311")!.isInsecureRemote, "LAN http is insecure-remote")
check(!URL(string: "http://127.evil.example")!.isLoopback && URL(string: "http://127.evil.example")!.isInsecureRemote, "loopback-looking DNS names never suppress the plaintext warning")
check(!URL(string: "http://100.64.1.2.evil.example")!.isEncryptedOverlay, "overlay-looking DNS names never claim encrypted transport")
check(!URL(string: "http://100.64.999.1")!.isEncryptedOverlay, "invalid IPv4 octets never claim overlay encryption")
check(URL(string: "https://a.b")!.isSameOrigin(as: URL(string: "https://A.b:443/x")!), "same origin with default port")
check(!URL(string: "http://a.b:4311")!.isSameOrigin(as: URL(string: "http://a.b:4312")!), "different port is different origin")

// Fingerprint formatting
check(Fingerprint.short(fp) == "PTRL HIJE", "short fingerprint format")
check(Fingerprint.grouped("abcdefgh12") == "abcd efgh 12", "grouped fingerprint")

// Signing messages
check(String(decoding: SigningMessages.pair(code: "C", publicKey: "K"), as: UTF8.self) == "hermes-studio/pair/v1\nC\nK", "pair message")
check(String(decoding: SigningMessages.paired(deviceId: "dev_1", publicKey: "K"), as: UTF8.self) == "hermes-studio/paired/v1\ndev_1\nK", "paired message")
check(String(decoding: SigningMessages.session(engineNodeId: "node_one", engineFingerprint: fp, deviceId: "dev_1", timestamp: 1700000000123, nonce: "n"), as: UTF8.self) == "hermes-studio/session/v2\nnode_one\n\(fp)\ndev_1\n1700000000123\nn", "session v2 message binds both engine identifiers")
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
let otherCertificate = Data(base64Encoded: certificates["other"]!)!
let trustedOther = trust(for: otherCertificate, host: "203.0.113.5")
SecTrustSetAnchorCertificates(trustedOther, [SecCertificateCreateWithData(nil, otherCertificate as CFData)!] as CFArray)
SecTrustSetAnchorCertificatesOnly(trustedOther, true)
check(ServerTrust.evaluate(trustedOther, host: "203.0.113.5", fingerprint: engineFingerprint, requirePin: false) == .system, "trusted wrong-key fixture exercises normal certificate trust")
check(ServerTrust.evaluate(trustedOther, host: "203.0.113.5", fingerprint: engineFingerprint, requirePin: true) == .reject, "first-contact mandatory pin refuses even an otherwise trusted certificate")
let report = TrustReport(); report.record(.system); check(!report.pinned, "system trust is not reported as pinned"); report.record(.pinned); check(report.pinned, "pinned trust is reported")

let client = EngineClient(baseURL: URL(string: "https://engine.example")!, engineName: "Fixture", fingerprint: engineFingerprint, requirePin: true)
var engineInfoJSON: [String: Any] = ["product": "hermes-studio", "fingerprint": engineFingerprint, "publicKey": identity["publicKey"]!, "nodeId": "node_one", "protocols": ["deviceSession": 2]]
func info(_ value: [String: Any]) -> EngineInfo { try! JSONDecoder().decode(EngineInfo.self, from: JSONSerialization.data(withJSONObject: value)) }
check((try? client.sessionTarget(from: info(engineInfoJSON), expectedNodeId: "node_one")) == DeviceSessionTarget(nodeId: "node_one", fingerprint: engineFingerprint), "session target validates stored identity and advertised v2 support")
check((try? client.sessionTarget(from: info(engineInfoJSON), expectedNodeId: "node_other")) == nil, "session target refuses another engine node")
var legacyInfo = engineInfoJSON; legacyInfo.removeValue(forKey: "protocols")
do { _ = try client.sessionTarget(from: info(legacyInfo), expectedNodeId: "node_one"); check(false, "old engine requires explicit upgrade") }
catch { check(error as? EngineError == .engineUpdateRequired(engine: "Fixture"), "old engine requires explicit upgrade") }
var newerInfo = engineInfoJSON; newerInfo["protocols"] = ["deviceSession": 3]
do { _ = try client.sessionTarget(from: info(newerInfo), expectedNodeId: "node_one"); check(false, "newer session protocol requires app update") }
catch { check(error as? EngineError == .appUpdateRequired(engine: "Fixture"), "newer session protocol requires app update") }
check(EngineClient.transportError(URLError(.secureConnectionFailed), engine: "Fixture") as? EngineError == .tlsHandshake(engine: "Fixture"), "TLS handshake failure is distinct from connectivity")
check(EngineClient.transportError(URLError(.serverCertificateUntrusted), engine: "Fixture") as? EngineError == .untrustedCertificate(engine: "Fixture"), "certificate trust failure is explicit")
check(!EngineClient.isConnectivityError(URLError(.secureConnectionFailed)), "TLS failure never claims the engine is offline")

let key = P256.Signing.PrivateKey()
let pub = key.publicKey.derRepresentation.base64EncodedString()
let code = "abc_DEF-123", deviceId = "dev_test", timestamp: Int64 = 1761526800000
let nonce = Data.random(count: 16).base64URLEncodedString()
let proof = try! key.signature(for: SigningMessages.pair(code: code, publicKey: pub)).derRepresentation.base64EncodedString()
let engineNodeId = "node_one"
let sessionSig = try! key.signature(for: SigningMessages.session(engineNodeId: engineNodeId, engineFingerprint: engineFingerprint, deviceId: deviceId, timestamp: timestamp, nonce: nonce)).derRepresentation.base64EncodedString()
let out: [String: Any] = ["publicKey": pub, "code": code, "proof": proof, "deviceId": deviceId, "timestamp": timestamp, "nonce": nonce, "engineNodeId": engineNodeId, "engineFingerprint": engineFingerprint,
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
// Current-document readiness: neither a successful ticket nor a changed hash proves a usable page.
var webReadiness = WebSessionReadiness()
check(!webReadiness.mayReveal && !webReadiness.signingIn, "a new web session has no authenticated rendered interface")
let signingContext = webReadiness.beginSignIn()
check(webReadiness.signingIn && !webReadiness.authenticated && !webReadiness.rendered && !webReadiness.mayReveal, "sign-in invalidates all previous presentation readiness")
check(!webReadiness.receiveAuthentication(true, context: signingContext) && !webReadiness.receiveRender(true, context: signingContext), "callbacks cannot reveal the old document while ticket sign-in is in progress")
let committedContext = webReadiness.didCommitDocument()
check(committedContext.authenticationGeneration == signingContext.authenticationGeneration && committedContext.documentGeneration > signingContext.documentGeneration, "a committed document preserves the auth generation but replaces document identity")
check(!webReadiness.receiveAuthentication(true, context: signingContext) && !webReadiness.receiveRender(true, context: signingContext), "callbacks captured before document commit cannot authenticate or render the new page")
check(webReadiness.didFinishDocument() == committedContext && !webReadiness.signingIn, "document finish opens readiness collection for the same document only")
check(webReadiness.receiveAuthentication(true, context: committedContext) && !webReadiness.mayReveal, "paired authentication alone does not reveal an unrendered page")
check(webReadiness.receiveRender(true, context: committedContext) && webReadiness.mayReveal, "an authenticated device and rendered current document permit reveal independently of password setup")
check(webReadiness.receiveAuthentication(false, context: committedContext) && !webReadiness.rendered && !webReadiness.mayReveal, "a genuine unauthenticated response clears readiness even after a successful render")
check(webReadiness.receiveRender(true, context: committedContext) && !webReadiness.mayReveal, "an interface snapshot cannot substitute for real authentication")
check(webReadiness.receiveAuthentication(true, context: committedContext) && webReadiness.mayReveal, "current paired authentication can combine with its current interface snapshot")
let nextSignInContext = webReadiness.beginSignIn()
check(nextSignInContext.authenticationGeneration > committedContext.authenticationGeneration && nextSignInContext.documentGeneration > committedContext.documentGeneration, "new sign-in advances both callback identities")
check(!webReadiness.receiveAuthentication(true, context: committedContext) && !webReadiness.receiveRender(true, context: committedContext), "old successful auth/render callbacks cannot cross a newer sign-in")
let replacementContext = webReadiness.didCommitDocument()
_ = webReadiness.didFinishDocument()
check(!webReadiness.receiveAuthentication(true, context: nextSignInContext), "a same-auth-generation callback from the preceding document is rejected")
check(webReadiness.receiveRender(true, context: replacementContext) && !webReadiness.mayReveal, "render-first ordering waits for authentication on the replacement document")
check(webReadiness.receiveAuthentication(true, context: replacementContext) && webReadiness.mayReveal, "auth-after-render ordering reveals exactly the current replacement document")
let beforeInvalidation = webReadiness.context
webReadiness.invalidate()
check(!webReadiness.signingIn && !webReadiness.authenticated && !webReadiness.rendered && !webReadiness.mayReveal, "invalidation clears readiness without claiming another sign-in has completed")
check(!webReadiness.receiveAuthentication(true, context: beforeInvalidation) && !webReadiness.receiveRender(true, context: beforeInvalidation), "invalidated contexts cannot reveal a signed-out or discarded web view")

func readinessPage(_ changes: [String: Any] = [:]) -> WebPageSnapshot? {
    var value: [String: Any] = ["appShell": true, "authScreen": false, "hash": destination.hash, "view": "bot", "conversationID": destination.botID, "conversationReady": true, "conversationMissing": false]
    value.merge(changes) { _, next in next }
    return WebPageSnapshot(value: value)
}
check(readinessPage()!.hasReadyInterface && destination.matchesRenderedPage(readinessPage()!), "a rendered exact bot conversation acknowledges the pending notification")
check(!readinessPage(["appShell": false])!.hasReadyInterface, "a loading document without the app shell cannot be revealed")
check(!readinessPage(["authScreen": true])!.hasReadyInterface, "a sign-in screen cannot be mistaken for the authenticated interface")
check(!readinessPage(["conversationReady": false])!.hasReadyInterface, "a matching hash without a ready conversation form/thread remains pending")
check(!destination.matchesRenderedPage(readinessPage(["conversationReady": false])!), "hash equality alone never acknowledges a notification")
check(!destination.matchesRenderedPage(readinessPage(["conversationID": "bot_other"])!), "another rendered bot cannot acknowledge the target bot")
check(!destination.matchesRenderedPage(readinessPage(["hash": "#/bot/bot_other"])!), "a target form under another visible hash cannot acknowledge the notification")
check(!destination.matchesRenderedPage(readinessPage(["view": "room"])!), "a different rendered view cannot acknowledge a bot notification")
check(!destination.matchesRenderedPage(readinessPage(["authScreen": true])!), "even matching target metadata cannot acknowledge through an authentication screen")
let missingTarget = readinessPage(["conversationReady": false, "conversationMissing": true, "conversationID": ""])!
check(missingTarget.hasReadyInterface && destination.matchesRenderedPage(missingTarget), "an explicit missing-target screen acknowledges the exact requested route without waiting forever")
check(!destination.matchesRenderedPage(readinessPage(["conversationReady": false, "conversationMissing": true, "hash": "#/bot/bot_other"])!), "missing-state rendering for another hash cannot clear the pending destination")
let readyRoom = readinessPage(["hash": roomDestination.hash, "view": "room", "conversationID": roomDestination.roomID!])!
check(roomDestination.matchesRenderedPage(readyRoom) && !destination.matchesRenderedPage(readyRoom), "room notification waits for its own rendered room rather than the member bot")
check(!roomDestination.matchesRenderedPage(readinessPage(["hash": roomDestination.hash, "view": "room", "conversationID": "room_other"])!), "a different room form cannot acknowledge the target room")
check(readinessPage(["view": "dashboard", "conversationReady": false])!.hasReadyInterface && !destination.matchesRenderedPage(readinessPage(["view": "dashboard", "conversationReady": false])!), "a ready dashboard may reveal but cannot consume a pending conversation destination")
check(WebPageSnapshot(value: "not-a-page") == nil, "non-object page snapshots are rejected")
for field in ["appShell", "authScreen", "conversationReady", "conversationMissing"] {
    check(readinessPage([field: "true"]) == nil, "page snapshot rejects a nonboolean \(field)")
}
for field in ["hash", "view", "conversationID"] {
    check(readinessPage([field: false]) == nil, "page snapshot rejects a nonstring \(field)")
}
check(readinessPage(["hash": String(repeating: "x", count: 16_385)]) == nil, "oversized page hashes are rejected")
check(readinessPage(["hash": String(repeating: "€", count: 5_462)]) == nil, "page hash bounds count UTF-8 bytes")
check(readinessPage(["view": String(repeating: "x", count: 121)]) == nil && readinessPage(["conversationID": String(repeating: "x", count: 121)]) == nil, "view and conversation identifiers remain bounded")
var renderedNavigation = NotificationNavigation()
renderedNavigation.receive(destination)
check(renderedNavigation.destination(authenticated: false) == nil && renderedNavigation.pending == destination, "unauthed readiness cannot consume the cold-tap route")
renderedNavigation.receive(roomDestination)
if destination.matchesRenderedPage(readinessPage()!) { renderedNavigation.didApply(destination) }
check(renderedNavigation.pending == roomDestination, "a late old rendered-page acknowledgement cannot clear a newer notification")
if roomDestination.matchesRenderedPage(readinessPage(["hash": roomDestination.hash, "view": "room", "conversationReady": false])!) { renderedNavigation.didApply(roomDestination) }
check(renderedNavigation.pending == roomDestination, "a newer route remains pending while its conversation is loading")
if roomDestination.matchesRenderedPage(readyRoom) { renderedNavigation.didApply(roomDestination) }
check(renderedNavigation.pending == nil, "only the matching rendered newer destination clears the pending notification")

print(failures == 0 ? "ALL PASSED" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
