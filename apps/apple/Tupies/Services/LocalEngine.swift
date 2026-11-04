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
    let tls: String?

    var expiryDate: Date? { ISODate.parse(expiresAt) }
    /// Local connections are always shown as "This Mac" (the engine writes its own
    /// name, usually the host name); users can rename the connection in Settings.
    var displayName: String { "This Mac" }

    var pairingLink: PairingLink? {
        guard let base = PairingLink.normalizedBaseURL(url), !code.isEmpty, Fingerprint.isWellFormed(fingerprint),
              tls == nil || tls == "engine", tls != "engine" || base.scheme == "https" else { return nil }
        return PairingLink(baseURL: base, code: code, fingerprint: Fingerprint.normalize(fingerprint), name: displayName, requiresPinnedTLS: tls == "engine")
    }
}

enum LocalEngineError: LocalizedError {
    case notRunning
    case noPairingInfo
    case folderInvalid(String)
    case nodeMissing(String)
    case exited(Int32, String)
    case timedOut
    case invalidPort

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
        case .invalidPort:
            return "Choose a valid local engine port between 0 and 65535."
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
    @Published private(set) var usesBundledEngine = false
    @Published private(set) var preparingAppUpdate = false
    @Published var studioFolder: String {
        didSet {
            if !selectingBundledEngine { UserDefaults.standard.set(studioFolder, forKey: Keys.folder); usesBundledEngine = false }
        }
    }
    @Published var nodePath: String {
        didSet {
            if !selectingBundledEngine { UserDefaults.standard.set(nodePath, forKey: Keys.node); usesBundledEngine = false }
        }
    }

    private enum Keys {
        static let folder = AppSettings.studioFolder
        static let node = AppSettings.nodePath
    }

    private var process: Process?
    private let bundledPayload: LocalEnginePayload?
    private var selectingBundledEngine = false
    private var partialLine = ""
    private static let maxLogLines = 400

    private init() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let savedFolder = UserDefaults.standard.string(forKey: Keys.folder)
        let savedNode = UserDefaults.standard.string(forKey: Keys.node)
        let environment = ProcessInfo.processInfo.environment
        let support: URL
        if let override = environment["HERMES_STUDIO_APPLICATION_SUPPORT"], !override.isEmpty {
            support = URL(fileURLWithPath: (override as NSString).expandingTildeInPath, isDirectory: true)
        } else {
            support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        }
        bundledPayload = Bundle.main.resourceURL.map { LocalEnginePayload(resources: $0, applicationSupport: support) }
        if savedFolder != nil || savedNode != nil {
            studioFolder = savedFolder ?? "\(home)/Documents/Personal/hermes-studio"
            nodePath = savedNode ?? Self.detectNode() ?? ""
        } else if let payload = bundledPayload, payload.isAvailable {
            studioFolder = payload.engineDirectory.path
            nodePath = payload.nodeExecutable.path
            usesBundledEngine = true
        } else {
            #if DEBUG
            studioFolder = "\(home)/Documents/Personal/hermes-studio"
            nodePath = Self.detectNode() ?? ""
            #else
            studioFolder = ""
            nodePath = ""
            #endif
        }
    }

    var canUseBundledEngine: Bool { bundledPayload?.isAvailable == true }
    func canResumeBundledEngine(for connection: Connection) -> Bool {
        usesBundledEngine && bundledPayload?.matchesManagedConnection(connection) == true
    }

    func recordManagedConnection(_ connection: Connection) {
        guard usesBundledEngine, ownsProcess, isProcessRunning, runningURL?.isSameOrigin(as: connection.baseURL) == true,
              let link = readDiscovery()?.pairingLink, link.baseURL.isSameOrigin(as: connection.baseURL),
              Fingerprint.normalize(link.fingerprint) == Fingerprint.normalize(connection.fingerprint) else { return }
        do { try bundledPayload?.associate(connection) }
        catch { appendLog("Couldn’t record automatic restart ownership. Start this engine manually next time.\n") }
    }
    var launchSummary: String {
        usesBundledEngine
            ? "The included engine keeps its data in Application Support. It stops when you quit Tupies; an engine started elsewhere is never touched."
            : "Uses your developer engine folder and its local configuration. An engine started here stops when you quit Tupies; one started elsewhere is never touched."
    }

    func useBundledEngine() {
        guard let payload = bundledPayload, payload.isAvailable else { return }
        selectingBundledEngine = true
        studioFolder = payload.engineDirectory.path
        nodePath = payload.nodeExecutable.path
        UserDefaults.standard.removeObject(forKey: Keys.folder)
        UserDefaults.standard.removeObject(forKey: Keys.node)
        usesBundledEngine = true
        selectingBundledEngine = false
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
    func probe(_ url: URL, fingerprint: String = "", requirePin: Bool = false) async -> Bool {
        do {
            let discovery = readDiscovery(includeExpired: true)?.pairingLink
            let knownLink = discovery?.baseURL.isSameOrigin(as: url) == true ? discovery : nil
            let expected = fingerprint.isEmpty ? knownLink?.fingerprint ?? "" : fingerprint
            let pin = requirePin || knownLink?.requiresPinnedTLS == true
            let info = try await EngineClient(baseURL: url, engineName: "This Mac", fingerprint: expected, requirePin: pin).engineInfo(timeout: 2.5)
            guard info.product == "hermes-studio" else { return false }
            if !expected.isEmpty {
                guard Fingerprint.normalize(info.fingerprint) == Fingerprint.normalize(expected),
                      let key = Data(base64Encoded: info.publicKey), Fingerprint.of(publicKeyDER: key) == Fingerprint.normalize(expected) else { return false }
            }
            return true
        } catch {
            return false
        }
    }

    /// Start/reconnect for an existing pairing checks only its exact destination and v2 identity.
    func probeExpected(_ connection: Connection) async -> Bool {
        (try? await checkExpected(connection)) == true
    }

    private func checkExpected(_ connection: Connection) async throws -> Bool {
        guard connection.kind == .local, connection.baseURL.isLoopback else { throw LocalEngineStartPolicy.Failure.externalLauncherRequired }
        guard connection.nodeId?.isEmpty == false else { throw LocalEngineStartPolicy.Failure.incompleteIdentity }
        let client = EngineClient(baseURL: connection.baseURL, engineName: connection.name, fingerprint: connection.fingerprint, requirePin: connection.pinnedTLS == true)
        do {
            let info = try await client.localStartEngineInfo()
            try LocalEngineStartPolicy.verifyRunningEngine(info, at: connection.baseURL, expected: connection)
            return true
        } catch {
            if LocalEngineStartPolicy.destinationIsOffline(error) { return false }
            if error is URLError { throw EngineClient.transportError(error, engine: connection.name) }
            throw error
        }
    }

    private func candidateURLs(extra: [URL]) -> [URL] {
        var urls: [URL] = []
        if let discovered = readDiscovery(includeExpired: true).flatMap({ PairingLink.normalizedBaseURL($0.url) }) {
            urls.append(discovered)
        }
        urls.append(contentsOf: extra)
        // An explicit discovery override also isolates its probes (tests and side-by-side engines).
        if ProcessInfo.processInfo.environment["HERMES_STUDIO_LOCAL_ENGINE_FILE"]?.isEmpty != false {
            urls.append(URL(string: "http://127.0.0.1:4311")!)
            urls.append(URL(string: "http://127.0.0.1:4310")!)
        }
        var seen = Set<String>()
        return urls.filter { seen.insert($0.absoluteString).inserted }
    }

    /// Looks for a running engine. Returns its URL, if any.
    @discardableResult
    func refresh(expectedConnection: Connection? = nil, extra: [URL] = []) async -> URL? {
        if state != .starting { state = .checking }
        let urls = expectedConnection.map { [$0.baseURL] } ?? candidateURLs(extra: extra)
        for url in urls {
            if let expected = expectedConnection {
                if await probeExpected(expected) { state = .running(expected.baseURL); return expected.baseURL }
                continue
            }
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
    func start(expectedConnection: Connection? = nil, extra: [URL] = [], bundledPort: Int? = nil) async throws {
        guard !preparingAppUpdate && !MacUpdates.shared.blocksEngineStart else { throw MacUpdateError.postponed("Tupies is preparing an update. Wait for it to finish.") }
        if let expected = expectedConnection {
            if try await checkExpected(expected) {
                state = .running(expected.baseURL)
                return
            }
            guard LocalEngineStartPolicy.mayLaunch(expectedConnection: expected, matchesManagedPayload: canResumeBundledEngine(for: expected)) else {
                throw LocalEngineStartPolicy.Failure.externalLauncherRequired
            }
        } else if await refresh(extra: extra) != nil { return }
        if isProcessRunning { return }

        let folder = (studioFolder as NSString).expandingTildeInPath
        let node = (nodePath as NSString).expandingTildeInPath
        if folder.isEmpty || node.isEmpty { throw LocalEnginePayload.Failure.missingPayload }
        guard FileManager.default.fileExists(atPath: (folder as NSString).appendingPathComponent("server.mjs")) else {
            throw LocalEngineError.folderInvalid(folder)
        }
        guard !node.isEmpty, FileManager.default.isExecutableFile(atPath: node) else {
            throw LocalEngineError.nodeMissing(node)
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = usesBundledEngine ? [URL(fileURLWithPath: folder).appendingPathComponent("server.mjs").path] : ["--env-file-if-exists=.env", "server.mjs"]
        process.currentDirectoryURL = URL(fileURLWithPath: folder, isDirectory: true)
        var environment = Self.childEnvironment(nodeDirectory: (node as NSString).deletingLastPathComponent, bundled: usesBundledEngine)
        if usesBundledEngine {
            guard let payload = bundledPayload else { throw LocalEnginePayload.Failure.missingPayload }
            environment["STUDIO_DATA_DIR"] = try payload.prepareDataDirectory().path
            environment["STUDIO_HOST"] = "127.0.0.1"
            let port = (expectedConnection?.baseURL.effectivePort ?? bundledPort).map(String.init) ?? ProcessInfo.processInfo.environment["HERMES_STUDIO_LOCAL_ENGINE_PORT"] ?? "4310"
            guard let number = Int(port), (0...65535).contains(number) else { throw LocalEngineError.invalidPort }
            environment["STUDIO_PORT"] = String(number)
            environment["STUDIO_LOCAL_PAIRING_FILE"] = Self.discoveryFileURL.path
        }
        process.environment = environment
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
        appendLog(usesBundledEngine ? "Starting the included Tupies engine. Data stays in Application Support.\n" : "$ \(node) --env-file-if-exists=.env server.mjs   (in \(folder))\n")
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
            if let discovery = readDiscovery(), let link = discovery.pairingLink, await probe(link.baseURL, fingerprint: link.fingerprint, requirePin: link.requiresPinnedTLS) {
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

    /// Existing device keys need their own verified engine, not a new pairing code from another discovery file.
    func waitForExpectedEngine(_ expected: Connection, timeout: TimeInterval = 60) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            try Task.checkCancellation()
            if try await checkExpected(expected) { state = .running(expected.baseURL); return }
            if ownsProcess, let process = process, !process.isRunning { throw LocalEngineError.exited(process.terminationStatus, logTail(lines: 6)) }
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }
        throw LocalEngineError.timedOut
    }

    /// Stop only our managed bundled process, then verify an encrypted complete data backup.
    func prepareForAppUpdate() async throws {
        guard !preparingAppUpdate else { throw MacUpdateError.postponed("An update is already being prepared.") }
        guard usesBundledEngine, let payload = bundledPayload else {
            if ownsProcess && isProcessRunning { throw MacUpdateError.postponed("Stop the developer Engine before updating Tupies.") }
            return
        }
        guard FileManager.default.fileExists(atPath: payload.dataDirectory.appendingPathComponent("state.json").path) else { return }
        preparingAppUpdate = true
        var verified = false
        defer { if !verified { preparingAppUpdate = false } }
        let ownedPID = ownsProcess && isProcessRunning ? process?.processIdentifier ?? 0 : 0
        let executable = payload.nodeExecutable
        let script = payload.engineDirectory.appendingPathComponent("scripts/prepare-mac-update.mjs")
        let support = payload.supportDirectory.deletingLastPathComponent()
        let arguments = [script.path, "--data", payload.dataDirectory.path, "--pid", String(ownedPID),
                         "--backup-dir", support.appendingPathComponent("UpdateBackups").path,
                         "--key-file", support.appendingPathComponent("update-backup.key").path]
        let environment = Self.childEnvironment(nodeDirectory: executable.deletingLastPathComponent().path, bundled: true)
        try await Task.detached(priority: .utility) {
            let helper = Process(), output = Pipe()
            helper.executableURL = executable; helper.arguments = arguments; helper.environment = environment
            helper.currentDirectoryURL = script.deletingLastPathComponent()
            helper.standardOutput = FileHandle.nullDevice; helper.standardError = output
            try helper.run()
            let message = output.fileHandleForReading.readDataToEndOfFile()
            helper.waitUntilExit()
            guard helper.terminationStatus == 0 else {
                throw MacUpdateError.postponed(String(data: message.prefix(4096), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "Couldn’t verify the local Engine backup. The update was postponed.")
            }
        }.value
        verified = true
    }

    func cancelAppUpdatePreparation() { preparingAppUpdate = false }

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

    private static func childEnvironment(nodeDirectory: String, bundled: Bool) -> [String: String] {
        var environment = ProcessInfo.processInfo.environment.filter { key, _ in
            !key.hasPrefix("DYLD_") && !key.hasPrefix("__XPC_") && !key.hasPrefix("__XCODE")
        }
        if bundled {
            let inherited = environment
            environment = ["HOME": FileManager.default.homeDirectoryForCurrentUser.path, "LANG": inherited["LANG"] ?? "en_US.UTF-8"]
            if let temporary = inherited["TMPDIR"] { environment["TMPDIR"] = temporary }
        }
        let path = [nodeDirectory, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", environment["PATH"]]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        environment["PATH"] = path.joined(separator: ":")
        return environment
    }
}
#endif
