#if os(macOS)
import AppKit
import Foundation

/// `~/Library/Application Support/Hermes Studio/local-engine.json`, written (0600) by an
/// engine bound to loopback so this Mac's app can pair with zero clicks.
struct LocalEngineDiscovery: Decodable {
    let v: Int?
    let url: String
    let code: String
    let fingerprint: String
    let name: String?
    let expiresAt: String?

    var expiryDate: Date? { ISODate.parse(expiresAt) }
    /// Local connections are always shown as "This Mac" (the engine writes its own
    /// name, usually the host name); users can rename the connection in Settings.
    var displayName: String { "This Mac" }

    var pairingLink: PairingLink? {
        guard let base = PairingLink.normalizedBaseURL(url), !code.isEmpty, Fingerprint.isWellFormed(fingerprint) else { return nil }
        return PairingLink(baseURL: base, code: code, fingerprint: Fingerprint.normalize(fingerprint), name: displayName)
    }
}

enum LocalEngineError: LocalizedError {
    case notRunning
    case noPairingInfo
    case folderInvalid(String)
    case nodeMissing(String)
    case exited(Int32, String)
    case timedOut

    var errorDescription: String? {
        switch self {
        case .notRunning:
            return "Tupies isn’t running on this Mac."
        case .noPairingInfo:
            return "Tupies is running on this Mac but hasn’t published a pairing code. Update Tupies, make sure it listens on 127.0.0.1, or pair with a link from Tupies’s settings."
        case .folderInvalid(let path):
            return "No Tupies engine (server.mjs) was found in \(path). Choose your Tupies project folder."
        case .nodeMissing(let path):
            return path.isEmpty
                ? "Node.js wasn’t found. Install Node 22 or choose the node binary."
                : "Node.js wasn’t found at \(path). Choose the node binary."
        case .exited(let status, let tail):
            let detail = tail.isEmpty ? "" : "\n\(tail)"
            return "The engine stopped (exit code \(status)).\(detail)"
        case .timedOut:
            return "The engine took too long to start. Check the log for details."
        }
    }
}

/// Discovers, starts and stops the Tupies engine on this Mac.
@MainActor
final class LocalEngineController: ObservableObject {
    static let shared = LocalEngineController()

    enum State: Equatable {
        case unknown
        case checking
        case running(URL)
        case notRunning
        case starting
        case failed(String)
    }

    @Published private(set) var state: State = .unknown
    @Published private(set) var logLines: [String] = []
    @Published private(set) var ownsProcess = false
    @Published var studioFolder: String {
        didSet { UserDefaults.standard.set(studioFolder, forKey: Keys.folder) }
    }
    @Published var nodePath: String {
        didSet { UserDefaults.standard.set(nodePath, forKey: Keys.node) }
    }

    private enum Keys {
        static let folder = "hermes.local.studioFolder"
        static let node = "hermes.local.nodePath"
    }

    private var process: Process?
    private var partialLine = ""
    private static let maxLogLines = 400

    private init() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        studioFolder = UserDefaults.standard.string(forKey: Keys.folder) ?? "\(home)/Documents/Personal/hermes-studio"
        nodePath = UserDefaults.standard.string(forKey: Keys.node) ?? Self.detectNode() ?? ""
    }

    static func detectNode() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = ["\(home)/.local/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Override with `HERMES_STUDIO_LOCAL_ENGINE_FILE` (mirrors the engine's
    /// `STUDIO_LOCAL_PAIRING_FILE`) for tests and side-by-side engines.
    static var discoveryFileURL: URL {
        if let override = ProcessInfo.processInfo.environment["HERMES_STUDIO_LOCAL_ENGINE_FILE"], !override.isEmpty {
            return URL(fileURLWithPath: (override as NSString).expandingTildeInPath)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Hermes Studio/local-engine.json")
    }

    var isProcessRunning: Bool { process?.isRunning == true }

    var runningURL: URL? {
        if case .running(let url) = state { return url }
        return nil
    }

    // MARK: Discovery

    func readDiscovery(includeExpired: Bool = false) -> LocalEngineDiscovery? {
        guard let data = try? Data(contentsOf: Self.discoveryFileURL),
              let discovery = try? JSONDecoder().decode(LocalEngineDiscovery.self, from: data) else { return nil }
        if !includeExpired, let expiry = discovery.expiryDate, expiry < Date() { return nil }
        return discovery
    }

    /// True when `url` answers `GET /api/engine` as a Tupies engine.
    func probe(_ url: URL) async -> Bool {
        do {
            let info = try await EngineClient(baseURL: url, engineName: "This Mac").engineInfo(timeout: 2.5)
            return info.product == "hermes-studio"
        } catch {
            return false
        }
    }

    private func candidateURLs(extra: [URL]) -> [URL] {
        var urls: [URL] = []
        if let discovered = readDiscovery(includeExpired: true).flatMap({ PairingLink.normalizedBaseURL($0.url) }) {
            urls.append(discovered)
        }
        urls.append(contentsOf: extra)
        urls.append(URL(string: "http://127.0.0.1:4311")!)
        urls.append(URL(string: "http://127.0.0.1:4310")!)
        var seen = Set<String>()
        return urls.filter { seen.insert($0.absoluteString).inserted }
    }

    /// Looks for a running engine. Returns its URL, if any.
    @discardableResult
    func refresh(extra: [URL] = []) async -> URL? {
        if state != .starting { state = .checking }
        for url in candidateURLs(extra: extra) {
            if await probe(url) {
                state = .running(url)
                return url
            }
        }
        if isProcessRunning {
            state = .starting
        } else if case .failed = state {
            // keep the failure visible
        } else {
            state = .notRunning
        }
        return nil
    }

    // MARK: Process

    /// Starts `node --env-file-if-exists=.env server.mjs` in the Tupies folder, unless an
    /// engine already answers — this never starts a second engine.
    func start(extra: [URL] = []) async throws {
        if await refresh(extra: extra) != nil { return }
        if isProcessRunning { return }

        let folder = (studioFolder as NSString).expandingTildeInPath
        let node = (nodePath as NSString).expandingTildeInPath
        guard FileManager.default.fileExists(atPath: (folder as NSString).appendingPathComponent("server.mjs")) else {
            throw LocalEngineError.folderInvalid(folder)
        }
        guard !node.isEmpty, FileManager.default.isExecutableFile(atPath: node) else {
            throw LocalEngineError.nodeMissing(node)
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = ["--env-file-if-exists=.env", "server.mjs"]
        process.currentDirectoryURL = URL(fileURLWithPath: folder, isDirectory: true)
        process.environment = Self.childEnvironment(nodeDirectory: (node as NSString).deletingLastPathComponent)
        process.standardInput = FileHandle.nullDevice

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            let text = String(decoding: data, as: UTF8.self)
            Task { @MainActor in self?.appendLog(text) }
        }
        process.terminationHandler = { [weak self] finished in
            let status = finished.terminationStatus
            Task { @MainActor in self?.processDidExit(status: status) }
        }

        logLines.removeAll()
        partialLine = ""
        appendLog("$ \(node) --env-file-if-exists=.env server.mjs   (in \(folder))\n")
        try process.run()
        self.process = process
        ownsProcess = true
        state = .starting
    }

    /// Waits until the started engine answers and has published pairing info.
    func waitForPairingInfo(timeout: TimeInterval = 60) async throws -> LocalEngineDiscovery {
        let deadline = Date().addingTimeInterval(timeout)
        var answeringSince: Date?
        while Date() < deadline {
            try Task.checkCancellation()
            if let discovery = readDiscovery(), let link = discovery.pairingLink, await probe(link.baseURL) {
                state = .running(link.baseURL)
                return discovery
            }
            if ownsProcess, let process = process, !process.isRunning {
                throw LocalEngineError.exited(process.terminationStatus, logTail(lines: 6))
            }
            if answeringSince == nil, let url = await refresh() {
                state = .running(url)
                answeringSince = Date()
            }
            if let since = answeringSince, Date().timeIntervalSince(since) > 10 {
                throw LocalEngineError.noPairingInfo
            }
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }
        throw LocalEngineError.timedOut
    }

    /// Stops the engine only if this app started it.
    func stop() {
        guard ownsProcess, let process = process, process.isRunning else { return }
        appendLog("Stopping engine…\n")
        process.terminate()
    }

    /// Called from `applicationWillTerminate`.
    func terminateIfOwned() {
        guard ownsProcess, let process = process, process.isRunning else { return }
        process.terminate()
        let deadline = Date().addingTimeInterval(2)
        while process.isRunning && Date() < deadline {
            usleep(50_000)
        }
    }

    func logTail(lines: Int) -> String {
        logLines.suffix(lines).joined(separator: "\n")
    }

    private func processDidExit(status: Int32) {
        if !partialLine.isEmpty {
            logLines.append(partialLine)
            partialLine = ""
        }
        logLines.append("Engine exited with code \(status).")
        process = nil
        ownsProcess = false
        state = status == 0 || status == 15 ? .notRunning : .failed("The engine stopped (exit code \(status)).")
    }

    private func appendLog(_ text: String) {
        let combined = partialLine + text
        var parts = combined.components(separatedBy: "\n")
        partialLine = parts.removeLast()
        logLines.append(contentsOf: parts.map(Self.stripANSI))
        if logLines.count > Self.maxLogLines {
            logLines.removeFirst(logLines.count - Self.maxLogLines)
        }
    }

    private static func stripANSI(_ line: String) -> String {
        line.replacingOccurrences(of: "\u{1B}\\[[0-9;]*[A-Za-z]", with: "", options: .regularExpression)
    }

    private static func childEnvironment(nodeDirectory: String) -> [String: String] {
        var environment = ProcessInfo.processInfo.environment.filter { key, _ in
            !key.hasPrefix("DYLD_") && !key.hasPrefix("__XPC_") && !key.hasPrefix("__XCODE")
        }
        let path = [nodeDirectory, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", environment["PATH"]]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        environment["PATH"] = path.joined(separator: ":")
        return environment
    }
}
#endif
