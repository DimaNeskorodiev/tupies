import Combine
import SwiftUI
import WebKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// A same-origin `window.open` page shown in a sheet.
final class PopupPage: Identifiable {
    let id = UUID()
    let webView: WKWebView
    init(webView: WKWebView) { self.webView = webView }
}

/// A finished download waiting for the iOS share sheet.
struct SharedFile: Identifiable {
    let id = UUID()
    let url: URL
}

/// Owns one long-lived WKWebView per connection, so switching engines is instant and
/// each keeps its page state. Signs the web view in with single-use device tickets.
@MainActor
final class EngineWebSession: NSObject, ObservableObject, Identifiable {
    enum Phase: Equatable {
        case idle
        case signingIn
        case loading
        case ready
        case unreachable(String)
        case revoked(String)
        case failed(String)

        var isError: Bool {
            switch self {
            case .unreachable, .revoked, .failed: return true
            default: return false
            }
        }
    }

    let id: UUID
    let webView: WKWebView
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var progress: Double = 0
    @Published private(set) var isNavigating = false
    @Published private(set) var hasLoadedEngine = false
    /// The page draws its own phone navigation (tab bar, Settings) and reaches the app's settings through the bridge,
    /// so the iPhone app hides its engine bar and lets the page run under the status bar. Older engines never send it.
    @Published private(set) var webOwnsChrome = false
    @Published var popup: PopupPage?
    @Published var sharedFile: SharedFile?

    private weak var store: ConnectionStore?
    private var connection: Connection
    private var signInTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    private var reauthAttempts: [Date] = []
    private var cancellables: Set<AnyCancellable> = []
    private var downloadNames: [ObjectIdentifier: URL] = [:]
    private var notificationNavigation = NotificationNavigation()
    private var authenticationGeneration = 0
    private var authenticatedPage = false
    #if os(iOS)
    private let refreshControl = UIRefreshControl()
    #endif

    private static let messageHandlerName = "hermesStudio"

    init(connection: Connection, store: ConnectionStore) {
        self.id = connection.id
        self.connection = connection
        self.store = store

        let configuration = WKWebViewConfiguration()
        // Separate cookie jar per connection: two engines on one host never share sessions.
        configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: connection.id)
        #if os(iOS)
        configuration.allowsInlineMediaPlayback = true
        configuration.applicationNameForUserAgent = "Mobile/15E148 \(EngineClient.userAgent)"
        #else
        configuration.applicationNameForUserAgent = EngineClient.userAgent
        #endif
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let contentController = WKUserContentController()
        contentController.addUserScript(WKUserScript(
            source: Self.bridgeScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        configuration.userContentController = contentController

        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()

        contentController.add(WeakScriptMessageHandler(self), name: Self.messageHandlerName)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        #if DEBUG
        if #available(iOS 16.4, macOS 13.3, *) { webView.isInspectable = true }
        #endif
        #if os(iOS)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.keyboardDismissMode = .interactive
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        refreshControl.tintColor = UIColor(Brand.ink)
        refreshControl.addTarget(self, action: #selector(handlePullToRefresh), for: .valueChanged)
        webView.scrollView.refreshControl = refreshControl
        NotificationCenter.default.publisher(for: UIContentSizeCategory.didChangeNotification)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.updateTextSize() }
            .store(in: &cancellables)
        #else
        webView.underPageBackgroundColor = NSColor(Brand.canvas)
        #endif

        webView.publisher(for: \.estimatedProgress)
            .receive(on: RunLoop.main)
            .sink { [weak self] value in self?.progress = value }
            .store(in: &cancellables)
        webView.publisher(for: \.isLoading)
            .receive(on: RunLoop.main)
            .sink { [weak self] value in self?.isNavigating = value }
            .store(in: &cancellables)
    }

    func updateConnection(_ connection: Connection) {
        self.connection = connection
    }

    // MARK: - Lifecycle

    /// Signs in the first time the connection is shown.
    func start() {
        guard phase == .idle else { return }
        signIn()
    }

    /// Mints a device session + web ticket and loads `/auth/device?ticket=…`.
    func signIn() {
        authenticationGeneration += 1
        authenticatedPage = false
        signInTask?.cancel()
        retryTask?.cancel()
        if !hasLoadedEngine || phase.isError { phase = .signingIn }
        signInTask = Task { [weak self] in
            guard let self = self, let store = self.store else { return }
            do {
                let ticket = try await store.authorized(self.id) { client, token in
                    try await client.webTicket(token: token)
                }
                try Task.checkCancellation()
                guard ticket.path.hasPrefix("/"),
                      let url = URL(string: ticket.path, relativeTo: self.connection.baseURL)?.absoluteURL,
                      url.isSameOrigin(as: self.connection.baseURL)
                else { throw EngineError.invalidResponse }
                if !self.hasLoadedEngine { self.phase = .loading }
                self.webView.load(URLRequest(url: url))
            } catch is CancellationError {
                return
            } catch {
                self.apply(error)
            }
        }
    }

    /// Tells an already loaded page it is on screen again, so it catches up with changes made on other engines at once.
    func notifyVisible() {
        guard hasLoadedEngine, !phase.isError else { return }
        #if os(iOS)
        updateTextSize()
        #endif
        webView.evaluateJavaScript("window.dispatchEvent(new Event('studio:visible'))", completionHandler: nil)
    }

    /// A notification chooses a bot identifier, never a supplied URL or executable action.
    func openNotification(_ destination: NotificationDestination) {
        notificationNavigation.receive(destination)
        if hasLoadedEngine, !phase.isError { verifyAuthentication() }
        else {
            switch phase {
            case .unreachable, .failed: signIn()
            default: start()
            }
        }
    }

    func isShowingNotification(_ destination: NotificationDestination) async -> Bool {
        guard hasLoadedEngine, authenticatedPage, !phase.isError, let url = webView.url, isEngineOrigin(url) else { return false }
        guard let value = try? await webView.evaluateJavaScript("document.querySelector('dialog[open]') ? null : window.location.hash"), let hash = value as? String else { return false }
        return destination.matchesVisibleHash(hash)
    }

    private func applyPendingNotification(authenticated: Bool, generation: Int) {
        guard generation == authenticationGeneration,
              let destination = notificationNavigation.destination(authenticated: authenticated), let url = webView.url,
              isEngineOrigin(url), url.path != "/auth/device",
              let encoded = try? JSONEncoder().encode(destination.hash),
              let hash = String(data: encoded, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.location.hash = \(hash); window.dispatchEvent(new Event('studio:visible')); window.location.hash;") { [weak self] result, error in
            guard let self, error == nil, generation == self.authenticationGeneration,
                  result as? String == destination.hash else { return }
            self.notificationNavigation.didApply(destination)
        }
    }

    func reload() {
        if hasLoadedEngine, !phase.isError, let url = webView.url, url.isSameOrigin(as: connection.baseURL),
           url.path != "/auth/device" {
            webView.reload()
        } else {
            signIn()
        }
    }

    /// Foreground: recover from errors and re-check that the web session is still valid.
    func resume() {
        switch phase {
        case .unreachable, .failed: signIn()
        case .ready: verifyAuthentication()
        default: break
        }
    }

    func tearDown() {
        signInTask?.cancel()
        retryTask?.cancel()
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: Self.messageHandlerName)
        webView.removeFromSuperview()
        cancellables.removeAll()
        popup = nil
    }

    /// The device was revoked: hide the page and wipe this connection's cookies and storage,
    /// so a still-valid web cookie can't keep the engine open.
    func markRevoked(_ message: String) {
        authenticationGeneration += 1
        authenticatedPage = false
        signInTask?.cancel()
        retryTask?.cancel()
        phase = .revoked(message)
        hasLoadedEngine = false
        webOwnsChrome = false
        popup = nil
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil)
        let store = webView.configuration.websiteDataStore
        store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {}
    }

    private func apply(_ error: Error) {
        endRefreshing()
        switch error {
        case EngineError.unauthorized:
            markRevoked(error.localizedDescription)
        case let engineError as EngineError where engineError.isUnreachable:
            phase = .unreachable(engineError.localizedDescription)
            scheduleRetry()
        default:
            phase = .failed(error.localizedDescription)
        }
    }

    /// Quietly retries an unreachable engine while it stays unreachable.
    private func scheduleRetry() {
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 15 * 1_000_000_000)
            guard !Task.isCancelled, let self = self, case .unreachable = self.phase,
                  self.store?.activeID == self.id else { return }
            self.signIn()
        }
    }

    // MARK: - Authentication watchdog

    /// After each page load, ask the engine whether the web session is authenticated.
    private func verifyAuthentication() {
        let generation = authenticationGeneration
        Task { [weak self] in
            guard let self = self else { return }
            do {
                let result = try await self.webView.callAsyncJavaScript(
                    "const r = await fetch('/api/auth', {credentials: 'same-origin', cache: 'no-store'}); return await r.json();",
                    arguments: [:],
                    in: nil,
                    contentWorld: .defaultClient
                )
                guard generation == self.authenticationGeneration, let state = result as? [String: Any] else { return }
                let authenticated = (state["authenticated"] as? Bool) ?? true
                let setupRequired = (state["setupRequired"] as? Bool) ?? false
                self.authenticatedPage = state["authenticated"] as? Bool == true
                self.applyPendingNotification(authenticated: self.authenticatedPage, generation: generation)
                if !authenticated && !setupRequired { self.reauthenticate() }
            } catch {
                // Page navigated away or engine offline; navigation callbacks handle it.
            }
        }
    }

    /// Re-signs the web view in, at most three times in two minutes.
    private func reauthenticate() {
        let now = Date()
        reauthAttempts = reauthAttempts.filter { now.timeIntervalSince($0) < 120 }
        guard reauthAttempts.count < 3 else {
            phase = .failed("Couldn’t keep this device signed in to \(connection.name). Try again, or pair this device again from Tupies.")
            return
        }
        reauthAttempts.append(now)
        store?.invalidateToken(for: id)
        signIn()
    }

    #if os(iOS)
    @objc private func handlePullToRefresh() {
        StudioHaptics.play("light")
        reload()
    }

    /// CSS keeps the engine layout responsive while following the owner's system text size.
    private func updateTextSize() {
        guard let url = webView.url, isEngineOrigin(url) else { return }
        let scale = UIFontMetrics.default.scaledValue(for: 17) / 17
        webView.evaluateJavaScript("""
        document.documentElement.style.setProperty('--studio-text-scale', '\(scale)');
        window.dispatchEvent(new Event('studio:text-size'));
        """, completionHandler: nil)
    }
    #endif

    private func endRefreshing() {
        #if os(iOS)
        if refreshControl.isRefreshing { refreshControl.endRefreshing() }
        #endif
    }

    // MARK: - Helpers

    fileprivate func isEngineOrigin(_ url: URL) -> Bool {
        url.isSameOrigin(as: connection.baseURL)
    }

    fileprivate func isEngineOrigin(_ origin: WKSecurityOrigin) -> Bool {
        guard origin.protocol.lowercased() == connection.baseURL.scheme?.lowercased(),
              origin.host.lowercased() == connection.baseURL.host?.lowercased() else { return false }
        let port = origin.port == 0 ? nil : origin.port
        let expected = connection.baseURL.port
        if port == expected { return true }
        let defaultPort = connection.baseURL.scheme?.lowercased() == "https" ? 443 : 80
        return (port ?? defaultPort) == (expected ?? defaultPort)
    }

    fileprivate func openExternally(_ url: URL) {
        #if os(iOS)
        UIApplication.shared.open(url)
        #else
        NSWorkspace.shared.open(url)
        #endif
    }

    #if os(iOS)
    private static let platform = "ios"
    #else
    private static let platform = "macos"
    #endif

    /// Marks the page as running in the app (`<html data-studio-app>`) and reports 401s from the page's own API calls
    /// so the app can re-sign in.
    private static let bridgeScript = """
    (() => {
      if (window.__hermesStudioApp) return;
      window.__hermesStudioApp = true;
      try {
        document.documentElement.dataset.studioApp = '\(platform)';
        if ('\(platform)' === 'ios') document.documentElement.dataset.studioHaptics = 'true';
      } catch (_) {}
      const post = (message) => { try { window.webkit.messageHandlers.hermesStudio.postMessage(message); } catch (_) {} };
      const originalFetch = window.fetch;
      if (typeof originalFetch !== 'function') return;
      window.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);
        try {
          if (response.status === 401) {
            const target = new URL(response.url || (args[0] && args[0].url) || String(args[0]), location.href);
            const ignored = ['/api/login', '/api/setup', '/api/logout'];
            if (target.origin === location.origin && target.pathname.startsWith('/api/') && !ignored.includes(target.pathname)) {
              post({ type: 'unauthorized', path: target.pathname });
            }
          }
        } catch (_) {}
        return response;
      };
    })();
    """
}

// MARK: - WKScriptMessageHandler

extension EngineWebSession: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.messageHandlerName,
              message.frameInfo.isMainFrame,
              isEngineOrigin(message.frameInfo.securityOrigin),
              let body = message.body as? [String: Any] else { return }
        switch body["type"] as? String {
        case "unauthorized":
            reauthenticate()
        case "chrome":
            webOwnsChrome = (body["ownsChrome"] as? Bool) == true
        case "app-settings":
            // Only the page on screen may open the app's settings.
            guard store?.activeID == id else { return }
            #if os(iOS)
            StudioHaptics.play("selection")
            #endif
            store?.showSettings = true
        #if os(iOS)
        case "haptic":
            // A hidden engine cannot buzz the device. Styles and frequency are bounded natively.
            guard store?.activeID == id, hasLoadedEngine, !phase.isError,
                  let style = body["style"] as? String else { return }
            StudioHaptics.play(style)
        #endif
        default:
            break
        }
    }
}

/// Breaks the WKUserContentController → handler retain cycle.
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

// MARK: - WKNavigationDelegate

extension EngineWebSession: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.allow)
            return
        }
        if ["about", "data", "blob", "javascript"].contains(scheme) {
            decisionHandler(.allow)
            return
        }
        guard scheme == "http" || scheme == "https" else {
            // mailto:, tel:, other apps.
            openExternally(url)
            decisionHandler(.cancel)
            return
        }
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        if isEngineOrigin(url) || !isMainFrame {
            decisionHandler(.allow)
            return
        }
        // Another origin in the main frame: keep the app on the engine, open it in the browser.
        openExternally(url)
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void
    ) {
        if let http = navigationResponse.response as? HTTPURLResponse {
            if navigationResponse.isForMainFrame, webView === self.webView,
               let url = http.url, isEngineOrigin(url), url.path == "/auth/device", http.statusCode >= 400 {
                decisionHandler(.cancel)
                reauthenticate()
                return
            }
            let disposition = (http.value(forHTTPHeaderField: "Content-Disposition") ?? "").lowercased()
            if disposition.hasPrefix("attachment") {
                decisionHandler(.download)
                return
            }
        }
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
        closePopupIfNeeded(webView)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
        closePopupIfNeeded(webView)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        endRefreshing()
        guard let url = webView.url, isEngineOrigin(url), url.path != "/auth/device" else { return }
        hasLoadedEngine = true
        authenticatedPage = false
        phase = .ready
        #if os(iOS)
        updateTextSize()
        #endif
        retryTask?.cancel()
        store?.markReachability(.online, for: id)
        verifyAuthentication()
    }

    /// The engine's own address is trusted through its identity key (see `ServerTrust`); other hosts get the system's checks.
    func webView(
        _ webView: WKWebView,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = space.serverTrust,
              space.host.lowercased() == connection.baseURL.host?.lowercased(),
              space.port == (connection.baseURL.effectivePort ?? 443)
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        switch ServerTrust.evaluate(trust, host: space.host, fingerprint: connection.fingerprint, requirePin: connection.pinnedTLS == true) {
        case .pinned:
            completionHandler(.useCredential, URLCredential(trust: trust))
        case .system:
            completionHandler(.performDefaultHandling, nil)
        case .reject:
            completionHandler(.cancelAuthenticationChallenge, nil)
            if webView === self.webView {
                retryTask?.cancel()
                phase = .failed(EngineError.certificateMismatch(engine: connection.name).localizedDescription)
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleNavigationError(error, in: webView)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleNavigationError(error, in: webView)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView === self.webView { reload() }
    }

    private func handleNavigationError(_ error: Error, in webView: WKWebView) {
        guard webView === self.webView else { return }
        endRefreshing()
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        // 102 = frame load interrupted (e.g. the response became a download).
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
        if EngineClient.isConnectivityError(error) {
            phase = .unreachable(EngineError.unreachable(engine: connection.name).localizedDescription)
            store?.markReachability(.offline, for: id)
            scheduleRetry()
        } else {
            phase = .failed(nsError.localizedDescription)
        }
    }

    private func closePopupIfNeeded(_ webView: WKWebView) {
        if let popup = popup, popup.webView === webView { self.popup = nil }
    }
}

// MARK: - WKUIDelegate

extension EngineWebSession: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "http" || scheme == "https", !isEngineOrigin(url) {
            openExternally(url)
            return nil
        }
        // Same-origin (or blob/about) popups open in an in-app sheet sharing the session.
        let popupView = WKWebView(frame: .zero, configuration: configuration)
        popupView.navigationDelegate = self
        popupView.uiDelegate = self
        popup = PopupPage(webView: popupView)
        return popupView
    }

    func webViewDidClose(_ webView: WKWebView) {
        closePopupIfNeeded(webView)
    }

    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void
    ) {
        // Microphone/camera only for the engine's own origin; the OS still asks once.
        decisionHandler(isEngineOrigin(origin) ? .grant : .deny)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor () -> Void
    ) {
        JavaScriptPanels.alert(message: message, title: connection.name, in: webView) { completionHandler() }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor (Bool) -> Void
    ) {
        JavaScriptPanels.confirm(message: message, title: connection.name, in: webView) { completionHandler($0) }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor (String?) -> Void
    ) {
        JavaScriptPanels.prompt(message: prompt, defaultText: defaultText, title: connection.name, in: webView) { completionHandler($0) }
    }
}

// MARK: - WKDownloadDelegate

extension EngineWebSession: WKDownloadDelegate {
    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping @MainActor (URL?) -> Void
    ) {
        let name = Self.safeFilename(suggestedFilename)
        do {
            let destination = try Self.downloadDestination(for: name)
            downloadNames[ObjectIdentifier(download)] = destination
            completionHandler(destination)
        } catch {
            store?.showToast("Couldn’t save \(name)", systemImage: "exclamationmark.triangle.fill")
            completionHandler(nil)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let destination = downloadNames.removeValue(forKey: ObjectIdentifier(download)) else { return }
        #if os(iOS)
        sharedFile = SharedFile(url: destination)
        #else
        DistributedNotificationCenter.default().post(name: Notification.Name("com.apple.DownloadFileFinished"), object: destination.path)
        store?.showToast("Saved “\(destination.lastPathComponent)” to Downloads", systemImage: "arrow.down.circle.fill")
        #endif
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let destination = downloadNames.removeValue(forKey: ObjectIdentifier(download))
        if let destination = destination { try? FileManager.default.removeItem(at: destination) }
        store?.showToast("Download failed", systemImage: "exclamationmark.triangle.fill")
    }

    private static func safeFilename(_ suggested: String) -> String {
        let cleaned = suggested
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty || cleaned.hasPrefix(".") ? "Download" + cleaned : cleaned
    }

    private static func downloadDestination(for name: String) throws -> URL {
        let fileManager = FileManager.default
        #if os(iOS)
        let folder = fileManager.temporaryDirectory
            .appendingPathComponent("Downloads", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent(name)
        #else
        let folder = try fileManager.url(for: .downloadsDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var candidate = folder.appendingPathComponent(name)
        var counter = 2
        while fileManager.fileExists(atPath: candidate.path) {
            let numbered = ext.isEmpty ? "\(base) \(counter)" : "\(base) \(counter).\(ext)"
            candidate = folder.appendingPathComponent(numbered)
            counter += 1
        }
        return candidate
        #endif
    }
}
