import AppKit
import Combine
import CryptoKit
import Foundation
import SwiftUI
import WebKit

// Synthetic collaborators only. The production session/client/wire/lifecycle sources
// are compiled unchanged; this fixture never links DeviceKeyStore or Keychain.
enum Brand { static let canvas = Color.white }
@MainActor enum JavaScriptPanels {
    static func alert(message: String, title: String, in webView: WKWebView, completion: @escaping () -> Void) { completion() }
    static func confirm(message: String, title: String, in webView: WKWebView, completion: @escaping (Bool) -> Void) { completion(false) }
    static func prompt(message: String, defaultText: String?, title: String, in webView: WKWebView, completion: @escaping (String?) -> Void) { completion(nil) }
}

@MainActor final class ConnectionStore {
    enum Reachability { case online, offline }
    var activeID: UUID?
    var showSettings = false
    private let saved: Connection
    private let key: P256.Signing.PrivateKey
    private var token: String?
    init(connection: Connection, key: P256.Signing.PrivateKey) { saved = connection; self.key = key; activeID = connection.id }
    func connection(_ id: UUID) -> Connection? { id == saved.id ? saved : nil }
    func invalidateToken(for id: UUID) { if id == saved.id { token = nil } }
    func markReachability(_ value: Reachability, for id: UUID) {}
    func refreshSync(_ id: UUID) async {}
    func showToast(_ message: String, systemImage: String) {}
    private func fresh() async throws -> String {
        let client = EngineClient(connection: saved)
        let target = try await client.verifiedSessionTarget(expectedNodeId: saved.nodeId)
        let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        let nonce = Data.random(count: 24).base64URLEncodedString()
        let bytes = SigningMessages.session(engineNodeId: target.nodeId, engineFingerprint: target.fingerprint, deviceId: saved.deviceId, timestamp: timestamp, nonce: nonce)
        let opened = try await client.openSession(SessionRequestBody(engineNodeId: target.nodeId, engineFingerprint: target.fingerprint, deviceId: saved.deviceId, timestamp: timestamp, nonce: nonce, signature: key.signature(for: bytes).derRepresentation.base64EncodedString()))
        token = opened.token
        return opened.token
    }
    func authorized<T>(_ id: UUID, _ operation: (EngineClient, String) async throws -> T) async throws -> T {
        guard id == saved.id else { throw EngineError.missingConnection }
        let bearer: String
        if let current = token { bearer = current } else { bearer = try await fresh() }
        do { return try await operation(EngineClient(connection: saved), bearer) }
        catch let error as EngineError where error.isUnauthorizedHTTP {
            token = nil
            let renewed = try await fresh()
            return try await operation(EngineClient(connection: saved), renewed)
        }
    }
}

/// Forward every navigation callback to the actual session. Only the test download's
/// destination is replaced immediately after the actual didBecomeDownload callback,
/// before WebKit asks for a destination. No production download seam or Downloads use.
@MainActor final class FixtureDownloadObserver: NSObject, WKNavigationDelegate, WKDownloadDelegate {
    let session: EngineWebSession
    let destination: URL
    private(set) var downloadCount = 0
    private(set) var finished = false
    private(set) var failed = false
    init(session: EngineWebSession, destination: URL) { self.session = session; self.destination = destination }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) { session.webView(webView, decidePolicyFor: action, decisionHandler: decisionHandler) }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) { session.webView(webView, decidePolicyFor: response, decisionHandler: decisionHandler) }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { (session as WKNavigationDelegate).webView?(webView, didStartProvisionalNavigation: navigation) }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { session.webView(webView, didCommit: navigation) }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { session.webView(webView, didFinish: navigation) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { session.webView(webView, didFailProvisionalNavigation: navigation, withError: error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { session.webView(webView, didFail: navigation, withError: error) }
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) { session.webView(webView, didReceive: challenge, completionHandler: completionHandler) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { session.webViewWebContentProcessDidTerminate(webView) }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { session.webView(webView, navigationAction: navigationAction, didBecome: download); download.delegate = self; downloadCount += 1 }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { session.webView(webView, navigationResponse: navigationResponse, didBecome: download); download.delegate = self; downloadCount += 1 }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping @MainActor (URL?) -> Void) { completionHandler(destination) }
    func downloadDidFinish(_ download: WKDownload) { finished = true }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) { failed = true }
}

@main struct WebSessionTests {
    struct Input: Decodable { let fixtures: [Fixture]; let controlURL: URL; let controlSecret: String; let expectedHome: String }
    struct Fixture: Decodable { let index: Int; let url: URL; let code: String; let fingerprint: String; let passwordRequired: Bool }
    struct Failure: Error { let label: String }
    @MainActor static var retainedStores: [ConnectionStore] = []
    @MainActor static var sessions: [EngineWebSession] = []
    @MainActor static var visibleAuthViolation = false
    @MainActor static var monitoring = true
    @MainActor static var monitoredSessions: Set<ObjectIdentifier> = []
    @MainActor static var visibilityRevision: [ObjectIdentifier: Int] = [:]
    @MainActor static var visibilityObservers: Set<AnyCancellable> = []
    @MainActor static func monitorVisibility(_ session: EngineWebSession) {
        let id = ObjectIdentifier(session)
        monitoredSessions.insert(id)
        visibilityRevision[id] = 0
        session.$isPageVisible.dropFirst().sink { _ in visibilityRevision[id, default: 0] += 1 }.store(in: &visibilityObservers)
    }

    static func main() {
        // A new LSUIElement bundle, private HOME and no windows/activation. This is
        // the harness's own run loop, never an installed Tupies application.
        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)
        Task { @MainActor in
            do {
                guard let data = try FileHandle.standardInput.readToEnd(), data.count < 65_536 else { throw Failure(label: "bounded fixture input") }
                let input = try JSONDecoder().decode(Input.self, from: data)
                try require(ProcessInfo.processInfo.environment["HOME"] == input.expectedHome, "private fixture home")
                try require(Bundle.main.bundleIdentifier?.hasPrefix("dev.tupies.synthetic.web-session.") == true, "unique fixture bundle")
                try require(input.fixtures.count == 2 && input.controlURL.host == "127.0.0.1", "local fixture topology")
                let monitor = Task { @MainActor in
                    while monitoring {
                        for session in sessions where session.isPageVisible && monitoredSessions.contains(ObjectIdentifier(session)) {
                            let id = ObjectIdentifier(session), revision = visibilityRevision[id]
                            if let auth = try? await session.webView.evaluateJavaScript("!!document.querySelector('.auth-screen')"),
                               (auth as? Bool) == true, session.isPageVisible,
                               monitoredSessions.contains(id), visibilityRevision[id] == revision { visibleAuthViolation = true }
                        }
                        try? await Task.sleep(for: .milliseconds(20))
                    }
                }
                for fixture in input.fixtures { try await exercise(fixture, input: input) }
                monitoring = false; monitor.cancel()
                await cleanup()
                try require(!visibleAuthViolation, "unauthenticated page never revealed")
                print("PASS synthetic WebKit unauthenticated UI remains hidden")
                exit(0)
            } catch {
                await cleanup()
                if let failure = error as? Failure { print("FAIL synthetic WebKit \(failure.label)") }
                else { print("FAIL synthetic WebKit native operation") }
                exit(1)
            }
        }
        application.run()
    }

    @MainActor static func require(_ condition: @autoclosure () -> Bool, _ label: String) throws { if !condition() { throw Failure(label: label) } }
    @MainActor static func pause(_ milliseconds: Int = 50) async { try? await Task.sleep(for: .milliseconds(milliseconds)) }
    @MainActor static func control(_ input: Input, _ fixture: Fixture, _ action: String) async throws -> [String: Any] {
        var request = URLRequest(url: input.controlURL); request.httpMethod = "POST"
        request.setValue("Bearer \(input.controlSecret)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["index": fixture.index, "action": action])
        let config = URLSessionConfiguration.ephemeral; config.httpCookieStorage = nil; config.urlCache = nil
        let client = URLSession(configuration: config); defer { client.invalidateAndCancel() }
        let (data, response) = try await client.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200, let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], result["ok"] as? Bool == true else { throw Failure(label: "local fixture control") }
        return result
    }
    @MainActor static func destination(_ connection: Connection, room: Bool = false, event: String, botID: String = "bot_atlas", roomID: String? = nil) throws -> NotificationDestination {
        guard let result = NotificationDestination(userInfo: ["studio": ["v": 1, "engineId": connection.nodeId!, "botId": botID, "kind": "message", "eventId": event].merging((room || roomID != nil) ? ["roomId": roomID ?? "room_webkit"] : [:], uniquingKeysWith: { _, next in next })]) else { throw Failure(label: "synthetic notification") }
        return result
    }
    @MainActor static func pending(_ session: EngineWebSession) -> NotificationDestination? {
        session.pendingNotification
    }
    @MainActor static func waitFor(_ label: String, timeout: Double = 20, _ predicate: @escaping @MainActor () async throws -> Bool) async throws {
        let until = Date().addingTimeInterval(timeout)
        while Date() < until {
            try require(!visibleAuthViolation, "unauthenticated page never revealed")
            if try await predicate() { return }
            await pause()
        }
        throw Failure(label: label)
    }
    @MainActor static func waitForContent(_ session: EngineWebSession, _ target: NotificationDestination, expectedText: String? = nil) async throws {
        let marker = expectedText ?? (target.roomID == nil ? "SYNTHETIC_WEBKIT_BOT_CONTENT" : "SYNTHETIC_WEBKIT_ROOM_CONTENT")
        try await waitFor("authenticated conversation content") {
            guard session.phase == .ready, session.isPageVisible else { return false }
            let script = "window.location.hash === \(String(data: try JSONEncoder().encode(target.hash), encoding: .utf8)!) && document.querySelector('#message-form, #room-message-form')?.dataset.id === \(String(data: try JSONEncoder().encode(target.roomID ?? target.botID), encoding: .utf8)!) && document.body.innerText.includes('\(marker)') && !document.querySelector('.auth-screen')"
            return (try? await session.webView.evaluateJavaScript(script)) as? Bool == true
        }
        try await waitFor("notification acknowledged after content") { pending(session) == nil }
    }
    @MainActor static func clearCookies(_ session: EngineWebSession) async {
        let store = session.webView.configuration.websiteDataStore.httpCookieStore
        let cookies = await store.allCookies()
        for cookie in cookies { await store.deleteCookie(cookie) }
    }
    @MainActor static func eraseFixtureStore(_ store: WKWebsiteDataStore) async {
        await withCheckedContinuation { continuation in store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) { continuation.resume() } }
    }
    @MainActor static func cleanup() async {
        monitoring = false
        for session in sessions { session.tearDown() }
        for session in sessions { await eraseFixtureStore(session.webView.configuration.websiteDataStore) }
    }
    @MainActor static func count(_ name: String, fixture: Fixture, input: Input) async throws -> Int {
        let state = try await control(input, fixture, "status")
        guard let counts = state["counts"] as? [String: Int], let value = counts[name] else { throw Failure(label: "fixture counter") }
        return value
    }
    @MainActor static func exercise(_ fixture: Fixture, input: Input) async throws {
        let key = P256.Signing.PrivateKey(), publicKey = key.publicKey.derRepresentation.base64EncodedString()
        let client = EngineClient(baseURL: fixture.url, engineName: "Synthetic WebKit engine", fingerprint: fixture.fingerprint)
        let target = try await client.verifiedSessionTarget(expectedNodeId: nil)
        let pair = try await client.pair(PairRequestBody(code: fixture.code, name: "Synthetic WebKit fixture", platform: "macos", publicKey: publicKey, proof: key.signature(for: SigningMessages.pair(code: fixture.code, publicKey: publicKey)).derRepresentation.base64EncodedString()))
        try require(pair.engine.nodeId == target.nodeId && pair.engine.fingerprint == target.fingerprint, "normal paired engine identity")
        guard let engineKey = Data(base64Encoded: pair.engine.publicKey) else { throw Failure(label: "engine public proof") }
        try require(EngineSignature.isValid(signatureBase64: pair.engineProof, message: SigningMessages.paired(deviceId: pair.deviceId, publicKey: publicKey), publicKeyDER: engineKey), "normal paired proof")
        let connection = Connection(id: UUID(), name: "Synthetic WebKit engine", baseURL: fixture.url, deviceId: pair.deviceId, fingerprint: target.fingerprint, enginePublicKey: pair.engine.publicKey, nodeId: target.nodeId, kind: .remote, addedAt: Date(), lastUsed: Date())
        let store = ConnectionStore(connection: connection, key: key), session = EngineWebSession(connection: connection, store: store)
        retainedStores.append(store); sessions.append(session); monitorVisibility(session)
        // The harness has no windows. Model an actually visible foreground page so the production
        // visible-refresh handler runs; this test-only property shim never enters the shipped app.
        session.webView.configuration.userContentController.addUserScript(WKUserScript(source: "Object.defineProperty(document, 'hidden', {configurable: true, get: () => false});", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        session.webView.frame = NSRect(x: 0, y: 0, width: 1000, height: 800)
        let suffix = fixture.passwordRequired ? "password-present" : "password-absent"
        let bot = try destination(connection, event: "cold-bot"), room = try destination(connection, room: true, event: "cold-room")

        let initial = fixture.passwordRequired ? room : bot
        session.openNotification(initial)
        try await waitForContent(session, initial)
        print("PASS synthetic WebKit cold \(fixture.passwordRequired ? "room" : "bot") \(suffix)")

        // A notification may point to a conversation created after this web view loaded its old state.
        // Reproduce activation's visible refresh, then route before that fresh state response can arrive.
        for lateRoom in [false, true] {
            await pause(1700) // pass the production visible-refresh throttle before starting this controlled read
            _ = try await control(input, fixture, "hold-state")
            _ = try await control(input, fixture, lateRoom ? "add-late-room" : "add-late-bot")
            session.notifyVisible()
            try await waitFor("warm state refresh held") { let status = try await control(input, fixture, "status"); return (status["waiting"] as? [String])?.contains("/api/state") == true }
            let target = try destination(connection, event: lateRoom ? "late-created-room" : "late-created-bot", botID: lateRoom ? "bot_atlas" : "bot_late_webkit", roomID: lateRoom ? "room_late_webkit" : nil)
            session.openNotification(target)
            try await waitFor("new notification route requested") { (try? await session.webView.evaluateJavaScript("window.location.hash")) as? String == target.hash }
            await pause(150)
            _ = try await control(input, fixture, "release")
            try await waitForContent(session, target, expectedText: lateRoom ? "SYNTHETIC_WEBKIT_LATE_ROOM_CONTENT" : "SYNTHETIC_WEBKIT_LATE_BOT_CONTENT")
            let missing = try await session.webView.evaluateJavaScript("document.body.innerText.includes('This bot isn’t here') || document.body.innerText.includes('This room isn’t here')")
            try require(missing as? Bool == false, "fresh existing notification conversation is not missing")
            print("PASS synthetic WebKit newly created \(lateRoom ? "room" : "bot") after warm state refresh \(suffix)")
        }

        let afterFalse = fixture.passwordRequired ? bot : room
        let ticketsBeforeFalse = try await count("ticket", fixture: fixture, input: input)
        _ = try await control(input, fixture, "auth-false-once")
        session.openNotification(afterFalse)
        try await waitForContent(session, afterFalse)
        let ticketsAfterFalse = try await count("ticket", fixture: fixture, input: input)
        try require(ticketsAfterFalse > ticketsBeforeFalse, "explicit false obtains new ordinary ticket")
        print("PASS synthetic WebKit explicit unauth recovery \(suffix)")

        let afterCookie = fixture.passwordRequired ? room : bot
        await clearCookies(session)
        session.openNotification(afterCookie)
        try await waitForContent(session, afterCookie)
        let ticketsAfterCookie = try await count("ticket", fixture: fixture, input: input)
        try require(ticketsAfterCookie > ticketsAfterFalse, "lost cookie obtains new ordinary ticket")
        print("PASS synthetic WebKit lost cookie recovery \(suffix)")

        let afterRestart = fixture.passwordRequired ? bot : room
        let sessionsBeforeRestart = try await count("session", fixture: fixture, input: input)
        _ = try await control(input, fixture, "restart")
        session.openNotification(afterRestart)
        try await waitForContent(session, afterRestart)
        let sessionsAfterRestart = try await count("session", fixture: fixture, input: input)
        try require(sessionsAfterRestart > sessionsBeforeRestart, "restart renews normal target-bound bearer")
        print("PASS synthetic WebKit restarted engine recovery \(suffix)")

        _ = try await control(input, fixture, "hold-state")
        session.reload()
        try await waitFor("state read held") { let status = try await control(input, fixture, "status"); return (status["waiting"] as? [String])?.contains("/api/state") == true }
        session.openNotification(room)
        await pause(150)
        try require(pending(session) == room, "hash alone does not acknowledge notification")
        let latest = try destination(connection, event: "latest-pending-bot")
        session.openNotification(latest)
        _ = try await control(input, fixture, "release")
        try await waitForContent(session, latest)
        print("PASS synthetic WebKit latest pending route after content \(suffix)")

        _ = try await control(input, fixture, "hold-page")
        session.reload()
        try await waitFor("new document held before commit") { let status = try await control(input, fixture, "status"); return (status["waiting"] as? [String])?.contains("/") == true }
        session.openNotification(room)
        await pause(150)
        try require(pending(session) == room, "old provisional document cannot acknowledge pending route")
        let oldHash = try await session.webView.evaluateJavaScript("window.location.hash")
        try require(oldHash as? String == latest.hash, "old provisional document does not receive new route")
        _ = try await control(input, fixture, "release")
        try await waitForContent(session, room)
        print("PASS synthetic WebKit held provisional document preserves route \(suffix)")

        let downloadURL = URL(fileURLWithPath: input.expectedHome).appendingPathComponent("synthetic-download-\(UUID().uuidString).txt")
        let download = FixtureDownloadObserver(session: session, destination: downloadURL)
        session.webView.navigationDelegate = download
        session.webView.load(URLRequest(url: fixture.url.appendingPathComponent("__fixture/download")))
        try await waitFor("own main-frame download finished") { download.finished || download.failed }
        try require(download.finished && !download.failed && download.downloadCount == 1, "actual download lifecycle completed")
        let downloadedBytes = try Data(contentsOf: downloadURL)
        try require(downloadedBytes == Data("SYNTHETIC_WEBKIT_DOWNLOAD".utf8), "download stays inside private fixture home")
        let retainedHash = try await session.webView.evaluateJavaScript("window.location.hash")
        try require(retainedHash as? String == room.hash, "download retains original verified page")
        session.openNotification(bot)
        try await waitForContent(session, bot)
        session.webView.navigationDelegate = session
        try FileManager.default.removeItem(at: downloadURL)
        print("PASS synthetic WebKit main-frame download retains notification routing \(suffix)")

        // Three successful recoveries already exercised the production rate cap.
        // A fresh real session gives the bounded refusal case its own retry window.
        monitoredSessions.remove(ObjectIdentifier(session))
        session.tearDown(); await eraseFixtureStore(session.webView.configuration.websiteDataStore)
        let rejected = EngineWebSession(connection: connection, store: store)
        sessions.append(rejected); monitorVisibility(rejected); rejected.webView.frame = NSRect(x: 0, y: 0, width: 1000, height: 800)
        _ = try await control(input, fixture, "refuse-tickets")
        rejected.openNotification(bot)
        try await waitFor("bounded ticket refusal", timeout: 20) { rejected.phase.isError }
        try require(!rejected.isPageVisible && pending(rejected) == bot, "refusal hides page and preserves notification")
        print("PASS synthetic WebKit bounded rejected ticket \(suffix)")
    }
}
