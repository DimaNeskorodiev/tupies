import Foundation
import SwiftUI
import WebKit

/// The app's source of truth: paired connections, the active engine, device sessions,
/// reachability/sync state and the per-connection web views.
@MainActor
final class ConnectionStore: ObservableObject {
    @Published private(set) var connections: [Connection] = []
    @Published private(set) var activeID: UUID?
    @Published private(set) var reachability: [UUID: Reachability] = [:]
    @Published private(set) var sync: [UUID: SyncSnapshot] = [:]
    @Published var pairingSheet: PairingSheetRequest?
    @Published var alert: AppAlert?
    @Published var toast: Toast?
    @Published var showSettings = false
    @Published var deviceName: String {
        didSet { defaults.set(deviceName, forKey: Keys.deviceName) }
    }
    @Published private(set) var isConnectingThisMac = false
    @Published var thisMacError: String?

    private enum Keys {
        static let connections = AppSettings.connections
        static let active = AppSettings.active
        static let deviceName = AppSettings.deviceName
        static let suppressedLocalIdentities = AppSettings.suppressedLocalIdentities
    }

    private static let tokenService = AppIdentity.sessionService
    /// Refresh tokens this long before they expire.
    private static let refreshMargin: TimeInterval = 5 * 60

    private let defaults: UserDefaults
    private let keys: DeviceKeyStore
    private var tokens: [UUID: SessionToken] = [:]
    private var tokenTasks: [UUID: Task<SessionToken, Error>] = [:]
    private var webSessions: [UUID: EngineWebSession] = [:]
    private var toastTask: Task<Void, Never>?
    private var didAttemptLocalAutoPair = false
    private var localPairingIntent: LocalEnginePairingIntent {
        get { LocalEnginePairingIntent(suppressedFingerprints: defaults.stringArray(forKey: Keys.suppressedLocalIdentities) ?? []) }
        set { defaults.set(newValue.suppressedFingerprints, forKey: Keys.suppressedLocalIdentities) }
    }

    init(defaults: UserDefaults = .standard, keys: DeviceKeyStore = .shared) {
        self.defaults = defaults
        self.keys = keys
        self.deviceName = defaults.string(forKey: Keys.deviceName) ?? DeviceInfo.defaultName
        load()
    }

    // MARK: - Connections

    var activeConnection: Connection? {
        guard let id = activeID else { return nil }
        return connection(id)
    }

    func connection(_ id: UUID) -> Connection? {
        connections.first { $0.id == id }
    }

    var localConnection: Connection? {
        connections.first { $0.kind == .local }
    }

    func activate(_ id: UUID) {
        guard let index = connections.firstIndex(where: { $0.id == id }) else { return }
        connections[index].lastUsed = Date()
        activeID = id
        defaults.set(id.uuidString, forKey: Keys.active)
        save()
        let session = webSession(for: id)
        session.start()
        session.notifyVisible()
        Task { await refreshSync(id) }
    }

    func activate(index: Int) {
        guard connections.indices.contains(index) else { return }
        activate(connections[index].id)
    }

    func rename(_ id: UUID, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let index = connections.firstIndex(where: { $0.id == id }) else { return }
        connections[index].name = String(trimmed.prefix(80))
        save()
        webSessions[id]?.updateConnection(connections[index])
    }

    /// Forgets the connection: deletes its device key, token, web view and website data.
    /// While a session is still valid it also unpairs the device on the engine, so the pairing does not linger there.
    func remove(_ id: UUID) {
        guard let removed = connections.first(where: { $0.id == id }) else { return }
        if removed.kind == .local { localPairingIntent.removed(removed.fingerprint) }
        if tokens[id] == nil, let stored = loadStoredToken(for: id) { tokens[id] = stored }
        if let token = tokens[id], token.expiresAt.timeIntervalSinceNow > 30 {
            let client = EngineClient(connection: removed)
            Task { try? await client.revokeDevice(removed.deviceId, token: token.token) }
        }
        connections.removeAll { $0.id == id }
        save()
        discardSecrets(for: id)
        if activeID == id {
            let next = connections.max { $0.lastUsed < $1.lastUsed }
            activeID = nil
            defaults.removeObject(forKey: Keys.active)
            if let next = next { activate(next.id) }
        }
    }

    func deviceKeyDescription(for id: UUID) -> String {
        keys.storageKind(for: id)?.label ?? "Missing"
    }

    // MARK: - Web sessions

    #if os(macOS)
    func lockPagesForUpdate() async throws {
        guard pairingSheet == nil else { throw MacUpdateError.postponed("Finish pairing before updating Tupies.") }
        do {
            for session in webSessions.values { try await session.lockForAppUpdate() }
        } catch { unlockPagesAfterUpdate(); throw error }
    }
    func unlockPagesAfterUpdate() { for session in webSessions.values { session.unlockAfterAppUpdate() } }
    #endif

    func webSession(for id: UUID) -> EngineWebSession {
        if let session = webSessions[id] { return session }
        let connection = self.connection(id) ?? Connection(
            id: id, name: "Tupies", baseURL: URL(string: "http://127.0.0.1")!, deviceId: "", fingerprint: "",
            enginePublicKey: "", nodeId: nil, kind: .remote, addedAt: Date(), lastUsed: Date()
        )
        let session = EngineWebSession(connection: connection, store: self)
        webSessions[id] = session
        return session
    }

    /// The web session if it was already created (does not create one).
    func webSessionIfLoaded(_ id: UUID) -> EngineWebSession? {
        webSessions[id]
    }

    func reloadActive() {
        guard let id = activeID else { return }
        webSession(for: id).reload()
    }

    func retryActive() {
        guard let id = activeID else { return }
        webSession(for: id).signIn()
    }

    // MARK: - Incoming links

    func handleIncomingURL(_ url: URL) {
        guard url.scheme?.lowercased() == PairingLink.scheme else { return }
        do {
            let link = try PairingLink.parse(url.absoluteString)
            pairingSheet = PairingSheetRequest(start: .confirm(link))
        } catch {
            alert = AppAlert(title: "Can’t use this link", message: error.localizedDescription)
        }
    }

    func beginPairing(_ step: PairingStep = .choose) {
        pairingSheet = PairingSheetRequest(start: step)
    }

    // MARK: - Pairing

    /// Verifies the engine identity, registers a new device key and saves the connection.
    @discardableResult
    func pair(
        _ link: PairingLink,
        kind requestedKind: Connection.Kind? = nil,
        displayName: String? = nil,
        progress: (PairingProgress) -> Void = { _ in }
    ) async throws -> Connection {
        guard link.kind == .device else { throw PairingLink.ParseError.engineLink }
        let engineName = displayName ?? link.name
        let expected = Fingerprint.normalize(link.fingerprint)
        var client = EngineClient(baseURL: link.baseURL, engineName: engineName, fingerprint: expected, requirePin: link.requiresPinnedTLS)

        progress(.verifying)
        let info = try await client.engineInfo()
        guard info.product == "hermes-studio" else { throw EngineError.notStudio }
        guard Fingerprint.normalize(info.fingerprint) == expected,
              let advertisedKey = Data(base64Encoded: info.publicKey),
              Fingerprint.of(publicKeyDER: advertisedKey) == expected
        else { throw EngineError.identityMismatch(engine: engineName) }
        let target = try client.sessionTarget(from: info, expectedNodeId: nil)
        if client.trust.pinned { client.requirePin = true }

        progress(.creatingKey)
        let id = UUID()
        let key = try keys.createKey(for: id)
        do {
            let publicKey = key.publicKeyBase64
            let proof = try key.sign(SigningMessages.pair(code: link.code, publicKey: publicKey)).base64EncodedString()

            progress(.pairing)
            let response = try await client.pair(PairRequestBody(
                code: link.code,
                name: pairingDeviceName,
                platform: DeviceInfo.platform,
                publicKey: publicKey,
                proof: proof
            ))

            guard Fingerprint.normalize(response.engine.fingerprint) == expected,
                  response.engine.nodeId == target.nodeId,
                  let engineKey = Data(base64Encoded: response.engine.publicKey),
                  Fingerprint.of(publicKeyDER: engineKey) == expected
            else { throw EngineError.identityMismatch(engine: engineName) }
            guard EngineSignature.isValid(
                signatureBase64: response.engineProof,
                message: SigningMessages.paired(deviceId: response.deviceId, publicKey: publicKey),
                publicKeyDER: engineKey
            ) else { throw EngineError.proofInvalid(engine: engineName) }

            let kind = requestedKind ?? defaultKind(for: link.baseURL)
            let previous = connections.first { Fingerprint.normalize($0.fingerprint) == expected && $0.kind == kind }
            let now = Date()
            let connection = Connection(
                id: id,
                name: previous?.name ?? (engineName.isEmpty ? (response.engine.name ?? "Tupies") : engineName),
                baseURL: link.baseURL,
                deviceId: response.deviceId,
                fingerprint: expected,
                enginePublicKey: response.engine.publicKey,
                nodeId: response.engine.nodeId,
                kind: kind,
                addedAt: previous?.addedAt ?? now,
                lastUsed: now,
                pinnedTLS: link.requiresPinnedTLS || client.trust.pinned ? true : nil
            )

            if let previous = previous, let index = connections.firstIndex(of: previous) {
                connections[index] = connection
                discardSecrets(for: previous.id)
            } else {
                connections.append(connection)
            }
            sortConnections()
            save()
            if connection.kind == .local { localPairingIntent.explicitlyConnected(connection.fingerprint) }
            reachability[id] = .online

            progress(.signingIn)
            activate(id)
            #if os(macOS)
            LocalEngineController.shared.recordManagedConnection(connection)
            #endif
            return connection
        } catch {
            keys.deleteKey(for: id)
            throw error
        }
    }

    private var pairingDeviceName: String {
        let trimmed = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        return String((trimmed.isEmpty ? DeviceInfo.defaultName : trimmed).prefix(80))
    }

    private func defaultKind(for url: URL) -> Connection.Kind {
        #if os(macOS)
        return url.isLoopback ? .local : .remote
        #else
        return .remote
        #endif
    }

    // MARK: - This Mac

    #if os(macOS)
    /// A previously chosen included engine resumes only for its exact verified managed identity.
    func resumeIncludedEngineIfNeeded() async {
        let local = LocalEngineController.shared
        guard let connection = activeConnection, localPairingIntent.permitsAutomaticConnection(to: connection.fingerprint),
              local.canResumeBundledEngine(for: connection) else { return }
        if await local.refresh(expectedConnection: connection) != nil { return }
        guard activeID == connection.id, self.connection(connection.id) != nil,
              localPairingIntent.permitsAutomaticConnection(to: connection.fingerprint) else { return }
        do {
            try await local.start(expectedConnection: connection, bundledPort: connection.baseURL.effectivePort)
            try await local.waitForExpectedEngine(connection)
            guard self.connection(connection.id) != nil, localPairingIntent.permitsAutomaticConnection(to: connection.fingerprint) else { return }
            webSession(for: connection.id).signIn()
        } catch { thisMacError = error.localizedDescription }
    }

    /// Pairs with the engine on this Mac using its discovery file. Throws
    /// `LocalEngineError` when the engine isn't running or hasn't published a code.
    func connectThisMac(expectedConnection: Connection? = nil) async throws {
        isConnectingThisMac = true
        defer { isConnectingThisMac = false }
        let local = LocalEngineController.shared
        if let existing = expectedConnection ?? localConnection {
            guard LocalEngineStartPolicy.retains(connection(existing.id), expected: existing) else { throw EngineError.missingConnection }
            let running = await local.probeExpected(existing)
            guard LocalEngineStartPolicy.retains(connection(existing.id), expected: existing) else { throw EngineError.missingConnection }
            guard running else { throw LocalEngineStartPolicy.Failure.externalLauncherRequired }
            localPairingIntent.explicitlyConnected(existing.fingerprint)
            activate(existing.id)
            local.recordManagedConnection(existing)
            return
        }
        guard let discovery = local.readDiscovery(), let link = discovery.pairingLink else {
            if await local.refresh() != nil { throw LocalEngineError.noPairingInfo }
            throw LocalEngineError.notRunning
        }
        guard await local.probe(link.baseURL, fingerprint: link.fingerprint, requirePin: link.requiresPinnedTLS) else { throw LocalEngineError.notRunning }
        guard localConnection == nil else { throw EngineError.missingConnection }
        try await pair(link, kind: .local, displayName: discovery.displayName)
        thisMacError = nil
    }

    /// Zero-click pairing with this Mac's engine on first launch.
    func autoPairLocalIfNeeded() async {
        guard !didAttemptLocalAutoPair, localConnection == nil else { return }
        didAttemptLocalAutoPair = true
        let local = LocalEngineController.shared
        guard let discovery = local.readDiscovery(), let link = discovery.pairingLink,
              localPairingIntent.permitsAutomaticConnection(to: link.fingerprint),
              await local.probe(link.baseURL, fingerprint: link.fingerprint, requirePin: link.requiresPinnedTLS) else { return }
        guard localConnection == nil, localPairingIntent.permitsAutomaticConnection(to: link.fingerprint) else { return }
        do {
            isConnectingThisMac = true
            defer { isConnectingThisMac = false }
            try await pair(link, kind: .local, displayName: discovery.displayName)
            thisMacError = nil
        } catch {
            thisMacError = error.localizedDescription
        }
    }
    #endif

    // MARK: - Device sessions

    /// A bearer token for the connection, minting a new session when needed.
    func validToken(for id: UUID, forceRefresh: Bool = false) async throws -> String {
        if !forceRefresh {
            if tokens[id] == nil, let stored = loadStoredToken(for: id) { tokens[id] = stored }
            if let token = tokens[id], token.protocolVersion == 2, token.expiresAt.timeIntervalSinceNow > Self.refreshMargin {
                return token.token
            }
        }
        if let running = tokenTasks[id] {
            let token = try await running.value
            try Task.checkCancellation()
            guard self.connection(id) != nil else { throw EngineError.missingConnection }
            return token.token
        }
        guard let connection = connection(id) else { throw EngineError.missingConnection }

        let task = Task { try await self.openSession(for: connection) }
        tokenTasks[id] = task
        do {
            let token = try await task.value
            tokenTasks[id] = nil
            try Task.checkCancellation()
            guard self.connection(id) != nil else { throw EngineError.missingConnection }
            tokens[id] = token
            storeToken(token, for: id)
            if reachability[id] != .online { reachability[id] = .online }
            return token.token
        } catch {
            tokenTasks[id] = nil
            if case EngineError.unauthorized = error {
                reachability[id] = .revoked
                invalidateToken(for: id)
                // The engine no longer accepts this device: lock its web view too.
                webSessions[id]?.markRevoked(error.localizedDescription)
            } else if case EngineError.unreachable = error {
                reachability[id] = .offline
            } else if case EngineError.engineUpdateRequired = error {
                reachability[id] = .updateRequired
            } else if case EngineError.appUpdateRequired = error {
                reachability[id] = .updateRequired
            }
            throw error
        }
    }

    /// Runs an authenticated request, refreshing the token once on 401.
    func authorized<T>(_ id: UUID, _ operation: (EngineClient, String) async throws -> T) async throws -> T {
        let token = try await validToken(for: id)
        guard let connection = connection(id) else { throw EngineError.missingConnection }
        let client = EngineClient(connection: connection)
        do {
            return try await operation(client, token)
        } catch let error as EngineError where error.isUnauthorizedHTTP {
            invalidateToken(for: id)
            let fresh = try await validToken(for: id, forceRefresh: true)
            guard let current = self.connection(id) else { throw EngineError.missingConnection }
            return try await operation(EngineClient(connection: current), fresh)
        }
    }

    private func openSession(for connection: Connection) async throws -> SessionToken {
        var client = EngineClient(connection: connection)
        let target = try await client.verifiedSessionTarget(expectedNodeId: connection.nodeId)
        if client.trust.pinned { client.requirePin = true }
        try Task.checkCancellation()
        guard let index = connections.firstIndex(where: { $0.id == connection.id && $0.fingerprint == connection.fingerprint }) else {
            throw EngineError.missingConnection
        }
        // Old saved connections may predate node IDs. Fill this only after the stored identity matched.
        if connections[index].nodeId == nil || (client.trust.pinned && connections[index].pinnedTLS != true) {
            connections[index].nodeId = target.nodeId
            if client.trust.pinned { connections[index].pinnedTLS = true }
            save()
            webSessions[connection.id]?.updateConnection(connections[index])
        }
        let key: DeviceSigningKey?
        do {
            key = try keys.loadKey(for: connection.id)
        } catch {
            throw EngineError.http(status: 0, message: "This device’s key for \(connection.name) couldn’t be read: \(error.localizedDescription)")
        }
        guard let key = key else { throw EngineError.unauthorized(engine: connection.name) }
        let timestamp = Int64((Date().timeIntervalSince1970 * 1000).rounded())
        let nonce = Data.random(count: 16).base64URLEncodedString()
        let signature = try key.sign(SigningMessages.session(engineNodeId: target.nodeId, engineFingerprint: target.fingerprint, deviceId: connection.deviceId, timestamp: timestamp, nonce: nonce))
        let response = try await client.openSession(SessionRequestBody(
            engineNodeId: target.nodeId,
            engineFingerprint: target.fingerprint,
            deviceId: connection.deviceId,
            timestamp: timestamp,
            nonce: nonce,
            signature: signature.base64EncodedString()
        ))
        let expiresAt = ISODate.parse(response.expiresAt) ?? Date().addingTimeInterval(50 * 60)
        return SessionToken(token: response.token, expiresAt: expiresAt, protocolVersion: 2)
    }

    func invalidateToken(for id: UUID) {
        tokens[id] = nil
        Keychain.delete(service: Self.tokenService, account: id.uuidString)
    }

    private func loadStoredToken(for id: UUID) -> SessionToken? {
        guard let data = try? Keychain.data(service: Self.tokenService, account: id.uuidString) else { return nil }
        return try? JSONDecoder().decode(SessionToken.self, from: data)
    }

    private func storeToken(_ token: SessionToken, for id: UUID) {
        guard let data = try? JSONEncoder().encode(token) else { return }
        try? Keychain.set(data, service: Self.tokenService, account: id.uuidString)
    }

    // MARK: - Reachability and sync

    func markReachability(_ value: Reachability, for id: UUID) {
        if reachability[id] != value { reachability[id] = value }
    }

    func reachabilityState(for id: UUID) -> Reachability {
        reachability[id] ?? .unknown
    }

    func probe(_ id: UUID) async {
        guard let connection = connection(id) else { return }
        let client = EngineClient(connection: connection)
        do {
            let info = try await client.engineInfo(timeout: 6)
            guard self.connection(id) != nil else { return }
            if info.product != "hermes-studio" {
                markReachability(.offline, for: id)
            } else if Fingerprint.normalize(info.fingerprint) != Fingerprint.normalize(connection.fingerprint) {
                markReachability(.identityChanged, for: id)
            } else if reachability[id] != .revoked {
                do { _ = try client.sessionTarget(from: info, expectedNodeId: connection.nodeId) }
                catch EngineError.engineUpdateRequired { markReachability(.updateRequired, for: id); return }
                catch EngineError.appUpdateRequired { markReachability(.updateRequired, for: id); return }
                catch EngineError.identityMismatch { markReachability(.identityChanged, for: id); return }
                markReachability(.online, for: id)
            }
        } catch {
            guard self.connection(id) != nil else { return }
            markReachability(.offline, for: id)
        }
    }

    func probeAll() async {
        let ids = connections.map(\.id)
        await withTaskGroup(of: Void.self) { group in
            for id in ids {
                group.addTask { await self.probe(id) }
            }
        }
    }

    func refreshSync(_ id: UUID) async {
        guard connection(id) != nil else { return }
        do {
            let status = try await authorized(id) { client, token in try await client.syncStatus(token: token) }
            sync[id] = SyncSnapshot.from(status)
        } catch EngineError.http(let status, let message) where status == 404 {
            sync[id] = SyncSnapshot(status: nil, health: .unsupported, message: message, updatedAt: Date())
        } catch let error as EngineError where error.isUnreachable {
            sync[id] = SyncSnapshot(status: nil, health: .offline, message: error.localizedDescription, updatedAt: Date())
        } catch is CancellationError {
            return
        } catch {
            sync[id] = SyncSnapshot(status: nil, health: .error, message: error.localizedDescription, updatedAt: Date())
        }
    }

    /// Background loop while a window is visible: probes engines and refreshes sync.
    func monitor() async {
        while !Task.isCancelled {
            await probeAll()
            if let id = activeID { await refreshSync(id) }
            try? await Task.sleep(nanoseconds: 30 * 1_000_000_000)
        }
    }

    /// Called when the app returns to the foreground.
    func resume() {
        Task { await probeAll() }
        guard let id = activeID else { return }
        webSessions[id]?.resume()
        Task { await refreshSync(id) }
    }

    // MARK: - Toasts

    func showToast(_ message: String, systemImage: String = "checkmark.circle.fill") {
        toastTask?.cancel()
        withAnimation(.spring(duration: 0.35)) { toast = Toast(message: message, systemImage: systemImage) }
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_200_000_000)
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.25)) { self?.toast = nil }
        }
    }

    // MARK: - Persistence

    private func load() {
        if let data = defaults.data(forKey: Keys.connections),
           let decoded = try? JSONDecoder().decode([Connection].self, from: data) {
            connections = decoded
            sortConnections()
        }
        if let raw = defaults.string(forKey: Keys.active), let id = UUID(uuidString: raw),
           connections.contains(where: { $0.id == id }) {
            activeID = id
        } else {
            activeID = connections.max { $0.lastUsed < $1.lastUsed }?.id
        }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(connections) {
            defaults.set(data, forKey: Keys.connections)
        }
    }

    /// Stable order for the switcher and ⌘1…⌘9: this Mac first, then by pairing date.
    private func sortConnections() {
        connections.sort { a, b in
            if a.kind != b.kind { return a.kind == .local }
            return a.addedAt < b.addedAt
        }
    }

    private func discardSecrets(for id: UUID) {
        keys.deleteKey(for: id)
        tokenTasks[id]?.cancel()
        tokenTasks[id] = nil
        invalidateToken(for: id)
        reachability[id] = nil
        sync[id] = nil
        if let session = webSessions.removeValue(forKey: id) {
            session.tearDown()
        }
        Task {
            // The data store can only be removed once no web view uses it.
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            try? await WKWebsiteDataStore.remove(forIdentifier: id)
        }
    }
}
