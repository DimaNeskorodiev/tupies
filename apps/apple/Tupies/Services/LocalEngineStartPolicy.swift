import Foundation

/// A retained local pairing does not authorize opening a different workspace or an old developer checkout.
enum LocalEngineStartPolicy {
    enum Failure: LocalizedError {
        case externalLauncherRequired
        case incompleteIdentity
        var errorDescription: String? {
            switch self {
            case .externalLauncherRequired:
                return "This Mac’s existing engine is managed outside this app. Start it with its configured updated launcher, then choose Try Again. Tupies will keep its pairing and will not open an older engine or create a replacement workspace."
            case .incompleteIdentity:
                return "This saved connection does not include its engine’s node identity. Start the existing engine with its configured updated launcher and pair it again before managing it from this app. No engine was started."
            }
        }
    }

    static func mayLaunch(expectedConnection: Connection?, matchesManagedPayload: Bool) -> Bool {
        guard let expected = expectedConnection else { return true }
        return expected.kind == .local && expected.baseURL.isLoopback && matchesManagedPayload
    }

    static func matchesRunningEngine(_ info: EngineInfo, at url: URL, expected: Connection) -> Bool {
        (try? verifyRunningEngine(info, at: url, expected: expected)) != nil
    }

    static func verifyRunningEngine(_ info: EngineInfo, at url: URL, expected: Connection) throws {
        guard expected.kind == .local, expected.baseURL.isLoopback,
              url.isSameOrigin(as: expected.baseURL) else { throw Failure.externalLauncherRequired }
        guard let nodeId = expected.nodeId, !nodeId.isEmpty else { throw Failure.incompleteIdentity }
        let client = EngineClient(baseURL: expected.baseURL, engineName: expected.name, fingerprint: expected.fingerprint, requirePin: expected.pinnedTLS == true)
        _ = try client.sessionTarget(from: info, expectedNodeId: nodeId)
    }

    static func destinationIsOffline(_ error: Error) -> Bool {
        // A timeout, TLS failure, HTTP response or malformed body is not permission to start a second process.
        (error as? URLError)?.code == .cannotConnectToHost
    }

    static func retains(_ current: Connection?, expected: Connection) -> Bool {
        guard let current else { return false }
        return current.id == expected.id && current.kind == .local && current.deviceId == expected.deviceId
            && current.baseURL.isSameOrigin(as: expected.baseURL) && current.nodeId == expected.nodeId
            && Fingerprint.normalize(current.fingerprint) == Fingerprint.normalize(expected.fingerprint)
    }
}
