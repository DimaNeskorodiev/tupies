import Foundation

/// Uses only generated fixture values. The fixture server must never receive them on another origin.
@main
struct TransportClientTests {
    private struct Fixture: Decodable { let url: URL }
    private struct Failure: Error {}

    static func main() async {
        do {
            let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
            let client = EngineClient(baseURL: fixture.url, engineName: "Transport fixture")
            let info = try await client.engineInfo()
            guard info.product == "hermes-studio" else { throw Failure() }
            print("PASS native transport follows same-origin redirects")

            try await refused {
                _ = try await client.pair(PairRequestBody(code: "fixture-code", name: "Fixture", platform: "ios", publicKey: "fixture-key", proof: "fixture-proof"))
            }
            try await refused {
                _ = try await client.openSession(SessionRequestBody(engineNodeId: "fixture-engine", engineFingerprint: "fixture-fingerprint", deviceId: "fixture-device", timestamp: 1, nonce: "fixture-nonce", signature: "fixture-signature"))
            }
            try await refused {
                _ = try await client.registerNotifications(NotificationRegistrationBody(token: "fixture-push", environment: "sandbox", enabled: true, botReplies: true, routines: true), token: "fixture-bearer")
            }
            print("PASS native transport refuses cross-origin credential redirects")
        } catch {
            print("FAIL native transport redirect boundary")
            exit(1)
        }
    }

    private static func refused(_ operation: () async throws -> Void) async throws {
        do { try await operation() }
        catch EngineError.http(let status, _) where status == 307 { return }
        throw Failure()
    }
}
