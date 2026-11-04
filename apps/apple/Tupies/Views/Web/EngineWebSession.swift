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
        case updateRequired(String)

        var isError: Bool {
            switch self {
            case .unreachable, .revoked, .failed, .updateRequired: return true
            default: return false
            }
        }
    }

    let id: UUID
    let webView: WKWebView
    #if os(macOS)
    func lockForAppUpdate() async throws {
        guard hasLoadedEngine else {
            if phase == .idle || phase.isError { return }
            throw MacUpdateError.postponed("Wait for your servers to finish connecting before updating.")
        }
        guard popup == nil, downloadNames.isEmpty, !isNavigating,
              let url = webView.url, isEngineOrigin(url),
              let ready = try? await webView.evaluateJavaScript("""
              (() => {
                if (typeof window.tupiesReadyForAppUpdate !== 'function' || !window.tupiesReadyForAppUpdate()) return false;
                document.documentElement.inert = true;
                return true;
              })()
              """), ready as? Bool == true else {
            throw MacUpdateError.postponed("Finish or save drafts, close open dialogs and downloads, then install the update. Older servers need an Engine update first.")
        }
    }
    func unlockAfterAppUpdate() {
        webView.evaluateJavaScript("document.documentElement.inert = false", completionHandler: nil)
    }
    #endif
    @Published private(set) var phase: Phase = .idle {
        didSet {
            // After an error, wait for the next page to draw again before showing it.
            if phase.isError, isPageVisible {
                revealTask?.cancel()
                isPageVisible = false
            }
        }
    }
    @Published private(set) var progress: Double = 0
    @Published private(set) var isNavigating = false
    @Published private(set) var hasLoadedEngine = false
    /// The page draws its own phone navigation (tab bar, Settings) and reaches the app's settings through the bridge,
    /// so the iPhone app hides its engine bar and lets the page run under the status bar. Older engines never send it.
    @Published private(set) var webOwnsChrome = false
    /// The first real page has drawn its interface, so the native loading state can crossfade into it. It stays true
    /// through reloads (the old page stays on screen until the new one commits) and resets only when the device is revoked.
    @Published private(set) var isPageVisible = false
    /// Set only when the page draws the other appearance than the system's (an engine without a dark theme), so the
    /// status bar and native sheets match the page. `nil` means follow the system.
    @Published private(set) var pageColorScheme: ColorScheme?
    /// The page's own background color (`underPageBackgroundColor`), drawn behind the web view so pull-to-refresh and
    /// rubber-banding reveal the page's color instead of a native one.
    @Published private(set) var pageBackground: Color?
    @Published var popup: PopupPage?
    @Published var sharedFile: SharedFile?
    #if os(iOS)
    /// How far the page is pulled down toward a reload (0…1), and whether a pull-to-refresh reload is running. The page
    /// runs under the status bar, where the system spinner would hide behind the Dynamic Island, so the app draws its own.
    @Published private(set) var pullProgress: CGFloat = 0
    @Published private(set) var isPullRefreshing = false
    #endif

    private weak var store: ConnectionStore?
    private var connection: Connection
    private var signInTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    private var reauthAttempts: [Date] = []
    private var cancellables: Set<AnyCancellable> = []
    private var lastNotificationAttendance = Date.distantPast
    private var downloadNames: [ObjectIdentifier: URL] = [:]
    #if os(macOS)
    private var reconnectDrafts: [String: Any]?
    private var draftRestoreTask: Task<Void, Never>?
    private var signInPreparationTask: Task<Void, Never>?
    private func retainReconnectDrafts(_ value: Any?) {
        guard let drafts = value as? [String: Any], drafts["v"] as? Int == 1,
              JSONSerialization.isValidJSONObject(drafts), let bytes = try? JSONSerialization.data(withJSONObject: drafts), bytes.count <= 1_000_000 else { return }
        reconnectDrafts = drafts
    }
    #endif
    private var notificationNavigation = NotificationNavigation()
    private var readiness = WebSessionReadiness()
    private var authenticationCheckTask: Task<Void, Never>?
    private var authenticationCheckID: UUID?
    private var pageCheckTask: Task<Void, Never>?
    private var pageCheckID: UUID?
    private var pageCheckAgain = false
    private var expectedNavigation: WKNavigation?
    private var expectedTicketURL: URL?
    private var pendingDocumentNavigation: WKNavigation?
    private var committedNavigation: WKNavigation?
    private var downloadNavigationCandidates: [ObjectIdentifier: WKNavigation] = [:]
    private var requestedNotification: NotificationDestination?
    private var requestedNotificationContext: WebSessionReadiness.Context?
    var pendingNotification: NotificationDestination? { notificationNavigation.pending }
    private var tlsFailure: EngineError?
    /// The current document has a verified, ready application interface.
    private var pageDrewInterface = false
    private var revealTask: Task<Void, Never>?
    #if os(macOS)
    private var uploadPanel: NSOpenPanel?
    #endif
    #if os(iOS)
    private let refreshControl = UIRefreshControl()
    private var pullTimeout: Task<Void, Never>?
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
        // The page draws its own long-press menus on chat messages and bot cards; `contextMenuConfigurationFor`
        // keeps the system link preview for links to other sites only.
        webView.allowsLinkPreview = true
        // The control provides the gesture and holds the page while it reloads; `PullToRefreshIndicator` is the visual.
        refreshControl.tintColor = .clear
        refreshControl.addTarget(self, action: #selector(handlePullToRefresh), for: .valueChanged)
        webView.scrollView.refreshControl = refreshControl
        webView.scrollView.publisher(for: \.contentOffset)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.updatePullProgress() }
            .store(in: &cancellables)
        NotificationCenter.default.publisher(for: UIContentSizeCategory.didChangeNotification)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.updateTextSize() }
            .store(in: &cancellables)
        // WebKit derives this from the page's <html>/<body> background; it follows the page's own light/dark theme.
        webView.publisher(for: \.underPageBackgroundColor)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.updatePageAppearance() }
            .store(in: &cancellables)
        // A page without a theme for the new system appearance keeps its color; check again once it has re-rendered.
        webView.registerForTraitChanges([UITraitUserInterfaceStyle.self]) { [weak self] (_: WKWebView, _: UITraitCollection) in
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 350_000_000)
                self?.updatePageAppearance()
            }
        }
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
        #if os(macOS)
        if connection.baseURL != self.connection.baseURL || connection.fingerprint != self.connection.fingerprint || connection.deviceId != self.connection.deviceId {
            reconnectDrafts = nil
            draftRestoreTask?.cancel()
            signInPreparationTask?.cancel()
        }
        #endif
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
        #if os(macOS)
        if hasLoadedEngine, let url = webView.url, isEngineOrigin(url), url.path != "/auth/device" {
            guard signInPreparationTask == nil else { return }
            let context = readiness.context
            signInPreparationTask = Task { [weak self] in
                guard let self else { return }
                defer { self.signInPreparationTask = nil }
                let snapshot = try? await self.webView.evaluateJavaScript("(() => { const snapshot = window.tupiesCaptureDrafts?.() ?? null; document.documentElement.inert = true; return snapshot; })()")
                guard !Task.isCancelled, context == self.readiness.context else { return }
                self.retainReconnectDrafts(snapshot)
                self.beginSignIn()
            }
            return
        }
        #endif
        beginSignIn()
    }
    private func beginSignIn() {
        tlsFailure = nil
        let context = readiness.beginSignIn()
        authenticationCheckTask?.cancel()
        authenticationCheckTask = nil
        authenticationCheckID = nil
        pageCheckTask?.cancel()
        pageCheckTask = nil
        pageCheckID = nil
        pageCheckAgain = false
        expectedNavigation = nil
        expectedTicketURL = nil
        pendingDocumentNavigation = nil
        committedNavigation = nil
        downloadNavigationCandidates.removeAll()
        requestedNotification = nil
        requestedNotificationContext = nil
        revealTask?.cancel()
        isPageVisible = false
        pageDrewInterface = false
        signInTask?.cancel()
        retryTask?.cancel()
        phase = .signingIn
        signInTask = Task { [weak self] in
            guard let self = self, let store = self.store else { return }
            do {
                let ticket = try await store.authorized(self.id) { client, token in
                    try await client.webTicket(token: token)
                }
                try Task.checkCancellation()
                guard context.authenticationGeneration == self.readiness.context.authenticationGeneration else { return }
                guard ticket.path.hasPrefix("/"),
                      let url = URL(string: ticket.path, relativeTo: self.connection.baseURL)?.absoluteURL,
                      url.isSameOrigin(as: self.connection.baseURL)
                else { throw EngineError.invalidResponse }
                self.phase = .loading
                self.expectedTicketURL = url
                self.expectedNavigation = self.webView.load(URLRequest(url: url))
                self.scheduleReadinessDeadline()
            } catch is CancellationError {
                return
            } catch {
                guard context.authenticationGeneration == self.readiness.context.authenticationGeneration else { return }
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

    /// Native window/app state is independent of WebKit's DOM focus. The hint is
    /// presentation-only, expires in the page and cannot authorize an engine action.
    private func reportNotificationAttendance() {
        let now = Date()
        guard now.timeIntervalSince(lastNotificationAttendance) >= 0.5 else { return }
        lastNotificationAttendance = now
        var attended = isPageVisible && readiness.mayReveal && !phase.isError &&
            store?.activeID == id && store?.showSettings == false && store?.pairingSheet == nil && popup == nil && sharedFile == nil
        #if os(iOS)
        attended = attended && UIApplication.shared.applicationState == .active &&
            webView.window?.windowScene?.activationState == .foregroundActive && webView.window?.isKeyWindow == true
        #else
        attended = attended && NSApp.isActive && webView.window?.isKeyWindow == true &&
            webView.window?.occlusionState.contains(.visible) == true
        #endif
        webView.evaluateJavaScript("document.documentElement.dataset.studioAttended = '\(attended ? "true" : "false")'; document.documentElement.dataset.studioAttendedAt = String(Date.now());", completionHandler: nil)
    }

    /// A notification chooses a bot identifier, never a supplied URL or executable action.
    func openNotification(_ destination: NotificationDestination) {
        notificationNavigation.receive(destination)
        isPageVisible = false
        if hasLoadedEngine, !phase.isError {
            if !readiness.signingIn { phase = .loading }
            scheduleReadinessDeadline()
            verifyAuthentication()
        } else {
            switch phase {
            case .unreachable, .failed: signIn()
            default: start()
            }
        }
    }

    func isShowingNotification(_ destination: NotificationDestination) async -> Bool {
        let context = readiness.context
        guard isPageVisible, readiness.mayReveal, pendingDocumentNavigation == nil, !phase.isError, let url = webView.url, isEngineOrigin(url) else { return false }
        guard let value = try? await webView.evaluateJavaScript("document.querySelector('dialog[open]') ? null : \(Self.pageSnapshotScript)"),
              context == readiness.context, pendingDocumentNavigation == nil, let page = WebPageSnapshot(value: value) else { return false }
        return destination.matchesRenderedPage(page)
    }

    /// Assigning a hash requests navigation; only a later rendered conversation acknowledges it.
    private func applyPendingNotification(context: WebSessionReadiness.Context) {
        guard context == readiness.context, readiness.mayReveal, pendingDocumentNavigation == nil,
              let destination = notificationNavigation.destination(authenticated: readiness.authenticated), let url = webView.url,
              isEngineOrigin(url), url.path != "/auth/device",
              requestedNotification != destination || requestedNotificationContext != context,
              let encoded = try? JSONEncoder().encode(destination.hash),
              let hash = String(data: encoded, encoding: .utf8) else { return }
        requestedNotification = destination
        requestedNotificationContext = context
        webView.evaluateJavaScript("if (window.location.hash !== \(hash)) window.location.hash = \(hash); window.dispatchEvent(new Event('studio:visible'));") { [weak self] _, error in
            guard let self, context == self.readiness.context else { return }
            if error != nil {
                self.requestedNotification = nil
                self.requestedNotificationContext = nil
            }
            self.checkPageReadiness()
        }
    }

    func reload() {
        tlsFailure = nil
        if hasLoadedEngine, !phase.isError, let url = webView.url, url.isSameOrigin(as: connection.baseURL),
           url.path != "/auth/device" {
            expectedNavigation = webView.reload()
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
        #if os(macOS)
        reconnectDrafts = nil
        draftRestoreTask?.cancel()
        signInPreparationTask?.cancel()
        uploadPanel?.cancel(nil)
        uploadPanel = nil
        #endif
        readiness.invalidate()
        authenticationCheckTask?.cancel()
        pageCheckTask?.cancel()
        signInTask?.cancel()
        retryTask?.cancel()
        revealTask?.cancel()
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
        #if os(macOS)
        reconnectDrafts = nil
        draftRestoreTask?.cancel()
        signInPreparationTask?.cancel()
        uploadPanel?.cancel(nil)
        uploadPanel = nil
        #endif
        readiness.invalidate()
        authenticationCheckTask?.cancel()
        pageCheckTask?.cancel()
        signInTask?.cancel()
        retryTask?.cancel()
        phase = .revoked(message)
        hasLoadedEngine = false
        webOwnsChrome = false
        revealTask?.cancel()
        isPageVisible = false
        pageDrewInterface = false
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
        case EngineError.engineUpdateRequired, EngineError.appUpdateRequired:
            phase = .updateRequired(error.localizedDescription)
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

    /// The probe uses the current cookie jar. Password setup does not restrict paired-device recovery.
    private func verifyAuthentication() {
        guard hasLoadedEngine, !readiness.signingIn, pendingDocumentNavigation == nil, !phase.isError,
              let url = webView.url, isEngineOrigin(url), url.path != "/auth/device",
              authenticationCheckTask == nil else { return }
        let context = readiness.context
        let checkID = UUID()
        authenticationCheckID = checkID
        authenticationCheckTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.authenticationCheckID == checkID {
                    self.authenticationCheckTask = nil
                    self.authenticationCheckID = nil
                }
            }
            do {
                let result = try await self.webView.callAsyncJavaScript(
                    "const c = new AbortController(); const timeout = setTimeout(() => c.abort(), 10000); try { const r = await fetch('/api/auth', {credentials: 'same-origin', cache: 'no-store', signal: c.signal}); return {status: r.status, state: await r.json()}; } finally { clearTimeout(timeout); }",
                    arguments: [:], in: nil, contentWorld: .defaultClient
                )
                guard !Task.isCancelled, context == self.readiness.context, self.pendingDocumentNavigation == nil,
                      let response = result as? [String: Any], response["status"] as? Int == 200,
                      let state = response["state"] as? [String: Any],
                      let authenticated = state["authenticated"] as? Bool else {
                    if !Task.isCancelled, context == self.readiness.context, self.pendingDocumentNavigation == nil { self.apply(EngineError.invalidResponse) }
                    return
                }
                guard self.readiness.receiveAuthentication(authenticated, context: context) else { return }
                if authenticated { self.checkPageReadiness() }
                else { self.reauthenticate() }
            } catch {
                guard !Task.isCancelled, context == self.readiness.context, self.pendingDocumentNavigation == nil else { return }
                self.phase = .unreachable(EngineError.unreachable(engine: self.connection.name).localizedDescription)
                self.scheduleRetry()
            }
        }
    }

    /// Chrome/DOM bridge messages are wakeups only; read the actual current document under native auth.
    private func checkPageReadiness() {
        guard hasLoadedEngine, !readiness.signingIn, pendingDocumentNavigation == nil, !phase.isError,
              let url = webView.url, isEngineOrigin(url), url.path != "/auth/device" else { return }
        if pageCheckTask != nil {
            pageCheckAgain = true
            return
        }
        let context = readiness.context
        let checkID = UUID()
        pageCheckID = checkID
        pageCheckTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.pageCheckID == checkID {
                    self.pageCheckTask = nil
                    self.pageCheckID = nil
                    let again = self.pageCheckAgain
                    self.pageCheckAgain = false
                    if again, context == self.readiness.context { self.checkPageReadiness() }
                }
            }
            guard let value = try? await self.webView.evaluateJavaScript(Self.pageSnapshotScript),
                  !Task.isCancelled, context == self.readiness.context, self.pendingDocumentNavigation == nil,
                  let page = WebPageSnapshot(value: value) else { return }
            if page.authScreen {
                self.isPageVisible = false
                self.reauthenticate()
                return
            }
            guard self.readiness.receiveRender(page.hasReadyInterface, context: context), self.readiness.mayReveal else { return }
            self.pageDrewInterface = true
            if let pending = self.notificationNavigation.pending {
                if pending.matchesRenderedPage(page) {
                    self.notificationNavigation.didApply(pending)
                    self.requestedNotification = nil
                    self.requestedNotificationContext = nil
                } else {
                    self.applyPendingNotification(context: context)
                    return
                }
            }
            self.phase = .ready
            self.revealWhenDrawn()
        }
    }

    private func scheduleReadinessDeadline() {
        revealTask?.cancel()
        let context = readiness.context
        revealTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            guard !Task.isCancelled, let self, context == self.readiness.context,
                  !self.isPageVisible, !self.phase.isError else { return }
            self.readiness.invalidate()
            self.authenticationCheckTask?.cancel()
            self.pageCheckTask?.cancel()
            self.signInTask?.cancel()
            self.expectedNavigation = nil
            self.expectedTicketURL = nil
            self.pendingDocumentNavigation = nil
            self.committedNavigation = nil
            self.webView.stopLoading()
            self.phase = .failed("Couldn’t open \(self.connection.name) after signing this device in. Try Again to reconnect. Your saved connection is kept.")
        }
    }

    /// Re-signs the web view in, at most three times in two minutes.
    private func reauthenticate(failedTicket: Bool = false) {
        guard (!readiness.signingIn || failedTicket), !phase.isError else { return }
        isPageVisible = false
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

    // MARK: - Reveal

    /// Reveal only a verified paired session whose actual interface (and requested conversation) rendered.
    private func revealWhenDrawn() {
        guard hasLoadedEngine, readiness.mayReveal, pageDrewInterface,
              notificationNavigation.pending == nil, !isPageVisible else { return }
        revealPage()
    }

    private func revealPage() {
        revealTask?.cancel()
        guard hasLoadedEngine, readiness.mayReveal, pageDrewInterface,
              notificationNavigation.pending == nil, !isPageVisible else { return }
        #if os(iOS)
        // Measure the drawn page while it is still hidden: if it pins the app to another appearance, that switch
        // (and the relayout it causes) happens under the loading state, not on the visible page.
        updatePageAppearance()
        StudioHaptics.prepare()
        #endif
        #if os(macOS)
        if let snapshot = reconnectDrafts {
            guard draftRestoreTask == nil else { return }
            let context = readiness.context
            draftRestoreTask = Task { [weak self] in
                guard let self else { return }
                defer { self.draftRestoreTask = nil }
                do {
                    let restored = try await self.webView.callAsyncJavaScript("return window.tupiesRestoreDrafts?.(snapshot) ?? false", arguments: ["snapshot": snapshot], in: nil, contentWorld: .page)
                    guard context == self.readiness.context else { return }
                    if restored as? Bool == true { self.reconnectDrafts = nil }
                    else { self.store?.alert = AppAlert(title: "Your draft is saved on this Mac", message: "Tupies reconnected, but this page couldn’t restore the message draft. Try Reload while keeping this app open.") }
                } catch {
                    guard context == self.readiness.context else { return }
                    self.store?.alert = AppAlert(title: "Your draft is saved on this Mac", message: "Try Reload to restore it while keeping this app open.")
                }
                if context == self.readiness.context { self.isPageVisible = true }
            }
            return
        }
        #endif
        isPageVisible = true
    }

    #if os(iOS)
    /// Reads the page's background (WebKit derives it from <html>/<body>) and whether it is light or dark. The app
    /// follows the system unless the page draws the other appearance (an engine without a dark theme).
    private func updatePageAppearance() {
        guard hasLoadedEngine, let url = webView.url, isEngineOrigin(url) else { return }
        let color = webView.underPageBackgroundColor.resolvedColor(with: webView.traitCollection)
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha), alpha > 0.5 else { return }
        let pageIsDark = (0.2126 * red + 0.7152 * green + 0.0722 * blue) < 0.5
        let systemIsDark = webView.traitCollection.userInterfaceStyle == .dark
        let pinned: ColorScheme? = pageIsDark == systemIsDark ? nil : (pageIsDark ? .dark : .light)
        if pageColorScheme != pinned { pageColorScheme = pinned }
        pageBackground = Color(uiColor: UIColor(red: red, green: green, blue: blue, alpha: 1))
    }

    private func updatePullProgress() {
        let scrollView = webView.scrollView
        let pulled = -(scrollView.contentOffset.y + scrollView.adjustedContentInset.top)
        let progress = isPullRefreshing ? 0 : min(1, max(0, pulled / 110))
        // Quantized, so SwiftUI updates a few times per pull rather than on every scroll frame.
        let stepped = (progress * 20).rounded() / 20
        if stepped != pullProgress { pullProgress = stepped }
    }

    @objc private func handlePullToRefresh() {
        // A reload would throw away an open sheet or a message being typed (drafts live only in the page's memory),
        // so a pull then only bounces.
        webView.evaluateJavaScript("""
        (() => {
          const active = document.activeElement;
          const editing = !!active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
          return editing || !!document.querySelector('dialog[open]');
        })()
        """) { [weak self] result, _ in
            guard let self else { return }
            if (result as? Bool) == true {
                self.endRefreshing()
                return
            }
            StudioHaptics.play(.light)
            self.isPullRefreshing = true
            self.pullProgress = 0
            self.reload()
            // Never leave the indicator spinning if the page doesn't report back.
            self.pullTimeout?.cancel()
            self.pullTimeout = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 12_000_000_000)
                guard !Task.isCancelled else { return }
                self?.endRefreshing()
            }
        }
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
        if isPullRefreshing { isPullRefreshing = false }
        pullTimeout?.cancel()
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

    /// Read presentation markers only, never conversation text or credentials. The page-world expando is set
    /// after a successful transcript read; a matching hash by itself is deliberately insufficient.
    private static let pageSnapshotScript = """
    (() => {
      const shell = document.querySelector('#app > .app-shell');
      const view = shell?.dataset.view || '';
      const form = view === 'bot' ? document.querySelector('#message-form') : view === 'room' ? document.querySelector('#room-message-form') : null;
      const thread = view === 'bot' ? document.querySelector('#chat-thread') : view === 'room' ? document.querySelector('#room-thread') : null;
      const marker = view === 'room' ? '__roomEtag' : '__chatEtag';
      const missing = view === 'bot' ? '#main-content > .page > .section-empty [data-action="create-bot"]' : view === 'room' ? '#main-content > .page > .section-empty [data-action="create-room"]' : null;
      return {
        appShell: !!shell,
        authScreen: !!document.querySelector('#app .auth-screen'),
        hash: window.location.hash,
        view,
        conversationID: form?.dataset.id || '',
        conversationReady: !!form && !!thread && (Object.prototype.hasOwnProperty.call(thread, marker) || !!thread.querySelector('.conversation-load-error')),
        conversationMissing: !form && !!missing && !!document.querySelector(missing)
      };
    })()
    """

    /// Marks the page as running in the app (`<html data-studio-app>`) and reports 401s from the page's own API calls
    /// so the app can re-sign in.
    private static let bridgeScript = """
    (() => {
      if (window.__hermesStudioApp) return;
      window.__hermesStudioApp = true;
      try {
        document.documentElement.dataset.studioApp = '\(platform)';
        document.documentElement.dataset.studioAttendance = '1';
        if ('\(platform)' === 'ios') document.documentElement.dataset.studioHaptics = 'true';
      } catch (_) {}
      const post = (message) => { try { window.webkit.messageHandlers.hermesStudio.postMessage(message); } catch (_) {} };
      // The observer sends a wakeup only when bounded route/readiness markers change. Native reads its own
      // current-document snapshot and still requires independent authenticated-cookie verification.
      let scheduled = false, previousState = '';
      const scheduleState = () => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
          scheduled = false;
          const state = JSON.stringify(\(pageSnapshotScript));
          if (state !== previousState) { previousState = state; post({type: 'page-state'}); }
        }, 0);
      };
      const observePage = () => {
        if (document.documentElement) new MutationObserver(scheduleState).observe(document.documentElement, {childList: true, subtree: true});
        scheduleState();
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observePage, {once: true});
      else observePage();
      window.addEventListener('hashchange', scheduleState);
      const originalFetch = window.fetch;
      if (typeof originalFetch !== 'function') return;
      window.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);
        try {
          if (response.status === 401) {
            const target = new URL(response.url || (args[0] && args[0].url) || String(args[0]), location.href);
            const ignored = ['/api/login', '/api/setup', '/api/logout'];
            if (target.origin === location.origin && target.pathname.startsWith('/api/') && !ignored.includes(target.pathname)) {
              let drafts = null;
              if ('\(platform)' === 'macos') { try { drafts = window.tupiesCaptureDrafts?.() ?? null; document.documentElement.inert = true; } catch (_) {} }
              post({ type: 'unauthorized', path: target.pathname, drafts });
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
            #if os(macOS)
            retainReconnectDrafts(body["drafts"])
            #endif
            reauthenticate()
        case "chrome":
            webOwnsChrome = (body["ownsChrome"] as? Bool) == true
            checkPageReadiness()
        case "page-state":
            checkPageReadiness()
        case "notification-attendance":
            reportNotificationAttendance()
        case "app-settings":
            // Only the page on screen may open the app's settings.
            guard store?.activeID == id else { return }
            #if os(iOS)
            StudioHaptics.play(.selection)
            #endif
            store?.showSettings = true
        #if os(iOS)
        case "haptic":
            // A hidden engine cannot buzz the device. Only the fixed vocabulary is accepted; frequency is bounded natively.
            guard store?.activeID == id, hasLoadedEngine, !phase.isError,
                  let name = body["style"] as? String,
                  let style = StudioHaptics.Style(rawValue: name) else { return }
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
                if url == expectedTicketURL { reauthenticate(failedTicket: true) }
                return
            }
            let disposition = (http.value(forHTTPHeaderField: "Content-Disposition") ?? "").lowercased()
            if disposition.hasPrefix("attachment") {
                rememberDownloadNavigation(navigationResponse, in: webView)
                decisionHandler(.download)
                return
            }
        }
        if !navigationResponse.canShowMIMEType { rememberDownloadNavigation(navigationResponse, in: webView) }
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    /// A download ends this exact provisional navigation while leaving the verified document in place.
    /// Capture the navigation at the response decision, so a late download callback cannot release a newer one.
    private func rememberDownloadNavigation(_ response: WKNavigationResponse, in webView: WKWebView) {
        guard webView === self.webView, response.isForMainFrame, !readiness.signingIn,
              let navigation = pendingDocumentNavigation, navigation !== committedNavigation else { return }
        if downloadNavigationCandidates.count >= 8 { downloadNavigationCandidates.removeAll() }
        downloadNavigationCandidates[ObjectIdentifier(response)] = navigation
    }

    private func finishNonDocumentNavigation(_ navigation: WKNavigation) {
        guard !phase.isError, !readiness.signingIn,
              navigation === pendingDocumentNavigation, navigation !== committedNavigation else { return }
        pendingDocumentNavigation = nil
        if navigation === expectedNavigation { expectedNavigation = nil }
        verifyAuthentication()
        checkPageReadiness()
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
        closePopupIfNeeded(webView)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        if webView === self.webView,
           let navigation = downloadNavigationCandidates.removeValue(forKey: ObjectIdentifier(navigationResponse)) {
            finishNonDocumentNavigation(navigation)
        }
        download.delegate = self
        closePopupIfNeeded(webView)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard webView === self.webView, !phase.isError, let navigation else { return }
        if readiness.signingIn {
            guard let expectedNavigation, navigation === expectedNavigation else { return }
        }
        pendingDocumentNavigation = navigation
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        guard webView === self.webView, !phase.isError, let navigation,
              navigation === pendingDocumentNavigation,
              !readiness.signingIn || navigation === expectedNavigation else { return }
        committedNavigation = navigation
        // Old-document probes cannot authenticate or reveal this new document.
        _ = readiness.didCommitDocument()
        authenticationCheckTask?.cancel()
        authenticationCheckTask = nil
        authenticationCheckID = nil
        pageCheckTask?.cancel()
        pageCheckTask = nil
        pageCheckID = nil
        pageCheckAgain = false
        requestedNotification = nil
        requestedNotificationContext = nil
        isPageVisible = false
        pageDrewInterface = false
        scheduleReadinessDeadline()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView, !phase.isError, let navigation,
              navigation === committedNavigation, navigation === pendingDocumentNavigation,
              !readiness.signingIn || navigation === expectedNavigation else { return }
        expectedNavigation = nil
        expectedTicketURL = nil
        pendingDocumentNavigation = nil
        endRefreshing()
        guard let url = webView.url, isEngineOrigin(url), url.path != "/auth/device" else { return }
        hasLoadedEngine = true
        _ = readiness.didFinishDocument()
        phase = .loading
        #if os(iOS)
        updateTextSize()
        #endif
        retryTask?.cancel()
        store?.markReachability(.online, for: id)
        // A restarted engine may have failed the launch-time sync probe before it was listening.
        // Refresh the actual status now instead of leaving a stale red badge until the next 30-second poll.
        Task { [weak self] in
            guard let self, let store = self.store else { return }
            await store.refreshSync(self.id)
        }
        verifyAuthentication()
        scheduleReadinessDeadline()
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
                let failure: EngineError = connection.pinnedTLS == true ? .certificateMismatch(engine: connection.name) : .untrustedCertificate(engine: connection.name)
                tlsFailure = failure
                phase = .failed(failure.localizedDescription)
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard let navigation, navigation === pendingDocumentNavigation || navigation === expectedNavigation else { return }
        let failure = error as NSError
        if (failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled) ||
            (failure.domain == "WebKitErrorDomain" && failure.code == 102) {
            finishNonDocumentNavigation(navigation)
            return
        }
        handleNavigationError(error, in: webView)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard let navigation, navigation === committedNavigation, navigation === pendingDocumentNavigation,
              !readiness.signingIn || navigation === expectedNavigation else { return }
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
        if let tlsFailure {
            phase = .failed(tlsFailure.localizedDescription)
            return
        }
        let transportError = EngineClient.transportError(error, engine: connection.name)
        if case EngineError.untrustedCertificate = transportError {
            phase = .failed(transportError.localizedDescription)
        } else if case EngineError.tlsHandshake = transportError {
            phase = .failed(transportError.localizedDescription)
        } else if EngineClient.isConnectivityError(error) {
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
    #if os(macOS)
    /// macOS WKWebView disables file uploads unless its delegate supplies this panel.
    /// Selection still only stages bytes; the engine admits the attachment when the owner sends it.
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void
    ) {
        guard frame.isMainFrame, isEngineOrigin(frame.securityOrigin),
              store?.activeID == id, !phase.isError, uploadPanel == nil,
              let window = webView.window else {
            completionHandler(nil)
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.prompt = "Attach"
        uploadPanel = panel
        panel.beginSheetModal(for: window) { [weak self] response in
            self?.uploadPanel = nil
            guard let self, response == .OK, self.store?.activeID == self.id,
                  self.store?.connection(self.id) != nil, !self.phase.isError else {
                completionHandler(nil)
                return
            }
            completionHandler(panel.urls)
        }
    }
    #endif

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

    #if os(iOS)
    /// Long-press on a link. Links inside the engine (routes, files, bot cards) belong to the page, which draws its own
    /// menus, so the system stays out of the way. Links to other sites, `mailto:`/`tel:` and images keep the standard
    /// system menu (WebKit passes its default actions as `suggestedActions`); the page can still opt any element out
    /// with `-webkit-touch-callout: none`.
    func webView(
        _ webView: WKWebView,
        contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo,
        completionHandler: @escaping @MainActor (UIContextMenuConfiguration?) -> Void
    ) {
        if let url = elementInfo.linkURL, isEngineOrigin(url) {
            completionHandler(nil)
            return
        }
        let title = elementInfo.linkURL?.host ?? ""
        completionHandler(UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { suggestedActions in
            UIMenu(title: title, children: suggestedActions)
        })
    }

    /// Tapping the lifted link opens it, outside the app for other sites.
    func webView(
        _ webView: WKWebView,
        contextMenuForElement elementInfo: WKContextMenuElementInfo,
        willCommitWithAnimator animator: UIContextMenuInteractionCommitAnimating
    ) {
        guard let url = elementInfo.linkURL else { return }
        animator.addCompletion { [weak self] in
            guard let self else { return }
            if self.isEngineOrigin(url) { return }
            self.openExternally(url)
        }
    }
    #endif

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
