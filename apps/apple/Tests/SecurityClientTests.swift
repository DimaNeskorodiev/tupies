import CryptoKit
import Foundation

/// Uses generated keys and disposable real engines; never reads the app's Keychain or preferences.
@main
struct SecurityClientTests {
    private struct KeyFixture: Codable { let privateKey: String; let publicKey: String }
    private struct Fixture: Decodable {
        let key: KeyFixture
        let linkA: String
        let linkB: String
        let nodeA: String
        let nodeB: String
        let wrongTLS: URL
        let oldEngine: URL
        let deviceId: String
    }
    private struct Failure: Error {}

    static func main() async {
        var stage = "fixture"
        do {
            let file = URL(fileURLWithPath: CommandLine.arguments[2])
            if CommandLine.arguments[1] == "prepare" {
                let key = P256.Signing.PrivateKey()
                try JSONEncoder().encode(KeyFixture(privateKey: key.derRepresentation.base64EncodedString(), publicKey: key.publicKey.derRepresentation.base64EncodedString())).write(to: file)
                return
            }
            let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: file))
            let linkA = try PairingLink.parse(fixture.linkA), linkB = try PairingLink.parse(fixture.linkB)
            guard linkA.requiresPinnedTLS, linkB.requiresPinnedTLS else { throw Failure() }
            let clientA = EngineClient(baseURL: linkA.baseURL, engineName: "Fixture A", fingerprint: linkA.fingerprint, requirePin: linkA.requiresPinnedTLS)
            let clientB = EngineClient(baseURL: linkB.baseURL, engineName: "Fixture B", fingerprint: linkB.fingerprint, requirePin: linkB.requiresPinnedTLS)
            stage = "first-contact A"
            let targetA = try await clientA.verifiedSessionTarget(expectedNodeId: fixture.nodeA)
            stage = "first-contact B"
            let targetB = try await clientB.verifiedSessionTarget(expectedNodeId: fixture.nodeB)
            guard clientA.trust.pinned, clientB.trust.pinned else { throw Failure() }
            print("PASS native security actual device links pin both engines on first contact")

            let impostor = EngineClient(baseURL: fixture.wrongTLS, engineName: "Impostor", fingerprint: linkA.fingerprint, requirePin: linkA.requiresPinnedTLS)
            stage = "impostor TLS"
            do { _ = try await impostor.engineInfo(); throw Failure() }
            catch EngineError.certificateMismatch { }
            print("PASS native security wrong first-contact TLS key receives no HTTP request")

            let old = EngineClient(baseURL: fixture.oldEngine, engineName: "Old fixture", fingerprint: linkA.fingerprint)
            stage = "old engine"
            do { _ = try await old.verifiedSessionTarget(expectedNodeId: fixture.nodeA); throw Failure() }
            catch EngineError.engineUpdateRequired { }
            print("PASS native security old engine requires upgrade before a session proof")

            let key = try P256.Signing.PrivateKey(derRepresentation: Data(base64Encoded: fixture.key.privateKey)!)
            func request(_ target: DeviceSessionTarget) throws -> SessionRequestBody {
                let timestamp = Int64((Date().timeIntervalSince1970 * 1000).rounded())
                let nonce = Data.random(count: 16).base64URLEncodedString()
                let message = SigningMessages.session(engineNodeId: target.nodeId, engineFingerprint: target.fingerprint, deviceId: fixture.deviceId, timestamp: timestamp, nonce: nonce)
                return SessionRequestBody(engineNodeId: target.nodeId, engineFingerprint: target.fingerprint, deviceId: fixture.deviceId, timestamp: timestamp, nonce: nonce, signature: try key.signature(for: message).derRepresentation.base64EncodedString())
            }
            let bodyA = try request(targetA)
            stage = "session A"
            let sessionA = try await clientA.openSession(bodyA)
            guard sessionA.token.hasPrefix("hsd_") else { throw Failure() }
            stage = "cross-engine replay"
            do { _ = try await clientB.openSession(bodyA); throw Failure() }
            catch EngineError.unauthorized { }
            let relabeled = SessionRequestBody(engineNodeId: targetB.nodeId, engineFingerprint: targetB.fingerprint, deviceId: bodyA.deviceId, timestamp: bodyA.timestamp, nonce: bodyA.nonce, signature: bodyA.signature)
            do { _ = try await clientB.openSession(relabeled); throw Failure() }
            catch EngineError.unauthorized { }
            print("PASS native security captured proof cannot authenticate or be relabeled on another engine")
            stage = "same-engine replay"
            do { _ = try await clientA.openSession(bodyA); throw Failure() }
            catch EngineError.unauthorized { }
            stage = "fresh session B"
            let sessionB = try await clientB.openSession(request(targetB))
            guard sessionB.token.hasPrefix("hsd_") else { throw Failure() }
            print("PASS native security same-engine replay refused and existing key works with a fresh target proof")
        } catch {
            // No raw URLs, request bodies, generated private keys or bearer values in diagnostics.
            print("FAIL native security contract at \(stage): \(error.localizedDescription)")
            exit(1)
        }
    }
}
