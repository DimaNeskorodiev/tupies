import Foundation

/// Real EngineClient requests against the disposable Tupies Engine started by notification-client.mjs.
@main
struct NotificationClientTests {
    private struct Fixture: Decodable { let url: URL; let token: String }
    private struct Failure: Error {}

    static func main() async {
        do {
            guard CommandLine.arguments.count == 2 else { throw Failure() }
            let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
            let client = EngineClient(baseURL: fixture.url, engineName: "Notification test engine")
            let initial = try await client.notificationStatus(token: fixture.token)
            guard initial.available, !initial.registered, !initial.enabled else { throw Failure() }
            print("PASS native notification initial status")

            let registered = try await client.registerNotifications(NotificationRegistrationBody(
                token: String(repeating: "a1", count: 32), environment: "sandbox",
                enabled: true, botReplies: false, routines: true
            ), token: fixture.token)
            guard registered.available, registered.registered, registered.enabled, !registered.botReplies, registered.routines else { throw Failure() }
            let reread = try await client.notificationStatus(token: fixture.token)
            guard reread.registered, reread.enabled, !reread.botReplies, reread.routines else { throw Failure() }
            print("PASS native notification registration and preferences")

            // The real server requires JSON {} and a current paired-device bearer on this DELETE.
            try await client.removeNotifications(token: fixture.token)
            let removed = try await client.notificationStatus(token: fixture.token)
            guard removed.available, !removed.registered, !removed.enabled else { throw Failure() }
            print("PASS native notification removal persists")
        } catch {
            // Never print the fixture bearer, raw HTTP bodies or account information.
            print("FAIL native notification HTTP client regression")
            exit(1)
        }
    }
}
