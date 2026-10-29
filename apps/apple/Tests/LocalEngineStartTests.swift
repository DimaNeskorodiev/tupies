import Foundation

/// Runs in a separate QA bundle/defaults domain, with only a fake runtime and scratch data.
@main
@MainActor
struct LocalEngineStartTests {
    private struct Fixture: Decodable {
        let online: URL; let old: URL; let wrongNode: URL; let wrongKey: URL
        let failed: URL; let malformed: URL; let timeout: URL; let offline: URL
        let fingerprint: String; let publicKey: String; let marker: String
    }
    private struct Failure: Error {}
    static func main() async throws {
        guard Bundle.main.bundleIdentifier?.hasPrefix("dev.tupies.qa.local-start.") == true else { throw Failure() }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        let controller = LocalEngineController.shared
        guard controller.usesBundledEngine, !controller.ownsProcess else { throw Failure() }
        let support = URL(fileURLWithPath: ProcessInfo.processInfo.environment["HERMES_STUDIO_APPLICATION_SUPPORT"]!)
        let payload = LocalEnginePayload(resources: Bundle.main.resourceURL!, applicationSupport: support)
        _ = try payload.prepareDataDirectory()
        try FileManager.default.createDirectory(at: payload.dataDirectory.appendingPathComponent("sync"), withIntermediateDirectories: false)
        let identity = try JSONSerialization.data(withJSONObject: ["nodeId": "node_expected", "publicKey": fixture.publicKey])
        try identity.write(to: payload.dataDirectory.appendingPathComponent("sync/identity.json"))
        func connection(_ url: URL) -> Connection {
            Connection(id: UUID(), name: "Synthetic local engine", baseURL: url, deviceId: "dev_synthetic", fingerprint: fixture.fingerprint,
                       enginePublicKey: fixture.publicKey, nodeId: "node_expected", kind: .local, addedAt: Date(), lastUsed: Date())
        }
        func noLaunch() throws {
            guard !controller.ownsProcess, !controller.isProcessRunning,
                  !FileManager.default.fileExists(atPath: fixture.marker) else { throw Failure() }
        }
        let online = connection(fixture.online)
        try await controller.start(expectedConnection: online)
        try noLaunch()
        guard controller.runningURL == online.baseURL else { throw Failure() }
        print("PASS native start attaches only the exact expected v2 engine without a process")
        for url in [fixture.old, fixture.wrongNode, fixture.wrongKey, fixture.failed, fixture.malformed, fixture.timeout] {
            let expected = connection(url)
            // Even a matching owned-data marker cannot override an answering or indeterminate destination.
            try payload.associate(expected)
            do { try await controller.start(expectedConnection: expected); throw Failure() }
            catch is Failure { throw Failure() }
            catch { try noLaunch() }
        }
        print("PASS native start refuses legacy identity HTTP malformed and timed-out destinations before process creation")
        let external = connection(fixture.offline)
        do { try await controller.start(expectedConnection: external); throw Failure() }
        catch LocalEngineStartPolicy.Failure.externalLauncherRequired { try noLaunch() }
        print("PASS native start refuses an offline external pairing without creating a workspace")
        try payload.associate(external)
        let retained = support.appendingPathComponent("retained-synthetic-data")
        try FileManager.default.moveItem(at: payload.dataDirectory, to: retained)
        do { try await controller.start(expectedConnection: external); throw Failure() }
        catch LocalEngineStartPolicy.Failure.externalLauncherRequired { try noLaunch() }
        guard !FileManager.default.fileExists(atPath: payload.dataDirectory.path) else { throw Failure() }
        print("PASS native start refuses missing associated data without recreating it")
        try FileManager.default.createDirectory(at: payload.dataDirectory, withIntermediateDirectories: false)
        do { try await controller.start(expectedConnection: external); throw Failure() }
        catch LocalEngineStartPolicy.Failure.externalLauncherRequired { try noLaunch() }
        guard try FileManager.default.contentsOfDirectory(atPath: payload.dataDirectory.path).isEmpty else { throw Failure() }
        print("PASS native start refuses an empty replacement data directory before process creation")
        try FileManager.default.removeItem(at: payload.dataDirectory)
        try FileManager.default.moveItem(at: retained, to: payload.dataDirectory)
        try Data("{\"nodeId\":\"node_wrong\",\"publicKey\":\"AA==\"}".utf8).write(to: payload.dataDirectory.appendingPathComponent("sync/identity.json"))
        do { try await controller.start(expectedConnection: external); throw Failure() }
        catch LocalEngineStartPolicy.Failure.externalLauncherRequired { try noLaunch() }
        print("PASS native start refuses another workspace identity before process creation")
    }
}
