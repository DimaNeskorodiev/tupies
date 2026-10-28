import SwiftUI
import WebKit

/// The engine UI for the active connection, with the native switcher.
struct MainView: View {
    @EnvironmentObject private var store: ConnectionStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let connection = store.activeConnection {
                // Each engine keeps its own live web view; switching crossfades between them.
                EngineContentView(connection: connection, session: store.webSession(for: connection.id))
                    .id(connection.id)
                    .transition(.opacity)
            } else {
                Color.clear.onAppear {
                    if let first = store.connections.first { store.activate(first.id) }
                }
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : .smooth(duration: 0.32), value: store.activeID)
        #if os(macOS)
        .toolbar { MacToolbar() }
        #else
        .background(Brand.base.ignoresSafeArea())
        .sheet(isPresented: $store.showSettings) {
            SettingsView()
                .environmentObject(store)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sensoryFeedback(.selection, trigger: store.activeID)
        #endif
    }
}

/// One engine: its web view plus loading/error states.
struct EngineContentView: View {
    @EnvironmentObject private var store: ConnectionStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let connection: Connection
    @ObservedObject var session: EngineWebSession

    /// The page has drawn and nothing is wrong: show it instead of the native state.
    private var showsPage: Bool { session.isPageVisible && !session.phase.isError }

    private var isPullRefreshing: Bool {
        #if os(iOS)
        return session.isPullRefreshing
        #else
        return false
        #endif
    }

    #if os(iOS)
    /// The engine bar (switcher and sync) is for pages without their own navigation (older engines), for errors, and,
    /// while connecting, for switching to another engine. A page with its own navigation runs edge to edge.
    private var showsEngineBar: Bool {
        if session.phase.isError { return true }
        if showsPage { return !session.webOwnsChrome }
        return store.connections.count > 1
    }
    #endif

    var body: some View {
        ZStack(alignment: .top) {
            #if os(iOS)
            // Behind the (transparent) web view: pull-to-refresh and rubber-banding reveal the page's own color.
            (session.pageBackground ?? Brand.base)
                .ignoresSafeArea()
            #endif

            WebViewHost(webView: session.webView)
                #if os(iOS)
                // A page with its own navigation runs edge to edge and pads itself with env(safe-area-inset-*).
                .ignoresSafeArea(.container, edges: showsEngineBar ? .bottom : .all)
                #endif
                .opacity(showsPage ? 1 : 0)
                .allowsHitTesting(showsPage)
                .accessibilityHidden(!showsPage)
                .sheet(item: $session.popup) { page in
                    PopupWebSheet(page: page, title: connection.name) { session.popup = nil }
                }

            if showsPage && session.isNavigating && session.progress < 1 && !isPullRefreshing {
                ProgressView(value: session.progress)
                    .progressViewStyle(.linear)
                    .tint(Brand.purple)
                    .frame(height: 2)
                    .transition(.opacity)
                    .accessibilityLabel("Loading \(connection.name)")
            }

            #if os(iOS)
            if showsPage && (session.isPullRefreshing || session.pullProgress > 0) {
                PullToRefreshIndicator(progress: session.pullProgress, refreshing: session.isPullRefreshing)
                    .padding(.top, 6)
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
            }
            #endif

            if !showsPage {
                ConnectionStateOverlay(connection: connection, phase: session.phase)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 1.02)))
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .smooth(duration: 0.42), value: showsPage)
        .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: isPullRefreshing)
        .animation(reduceMotion ? nil : .smooth(duration: 0.3), value: session.phase)
        .task(id: connection.id) { session.start() }
        #if os(iOS)
        .safeAreaInset(edge: .top, spacing: 0) {
            if showsEngineBar {
                PhoneTopBar(background: showsPage ? session.pageBackground ?? Brand.base : .clear)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: showsEngineBar)
        // Status bar, Settings and sheets follow the appearance the page actually draws.
        .preferredColorScheme(session.pageColorScheme)
        .sheet(item: $session.sharedFile) { file in
            ShareSheet(url: file.url)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        #endif
    }
}

#if os(iOS)
/// Pull-to-refresh, drawn below the status bar (the system spinner would sit behind the Dynamic Island on pages that run
/// edge to edge): an arrow that turns as the page is pulled, then a spinner while it reloads.
struct PullToRefreshIndicator: View {
    let progress: CGFloat
    let refreshing: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if refreshing {
                ProgressView()
                    .controlSize(.regular)
                    .transition(.opacity)
            } else {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(progress >= 1 ? Brand.purple : Brand.muted)
                    .rotationEffect(.degrees(reduceMotion ? 0 : Double(progress) * 270))
                    .symbolEffect(.bounce, value: progress >= 1)
                    .transition(.opacity)
            }
        }
        .frame(width: 40, height: 40)
        .glassSurface(Circle())
        .scaleEffect(refreshing ? 1 : 0.7 + 0.3 * progress)
        .opacity(refreshing ? 1 : min(1, Double(progress) * 1.6))
        .accessibilityElement()
        .accessibilityLabel(refreshing ? "Reloading" : "Pull down to reload")
    }
}
#endif

/// Loading, unreachable, revoked and failure states.
struct ConnectionStateOverlay: View {
    @EnvironmentObject private var store: ConnectionStore
    #if os(macOS)
    @EnvironmentObject private var local: LocalEngineController
    #endif
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let connection: Connection
    let phase: EngineWebSession.Phase
    @State private var confirmRemove = false
    @State private var startingLocal = false
    @State private var retries = 0

    var body: some View {
        ZStack {
            AmbientBackground()
            content
                .frame(maxWidth: 460)
                .padding(.horizontal, 24)
        }
        .sensoryFeedback(.impact(weight: .light), trigger: retries)
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .unreachable:
            ContentUnavailableView {
                Label("Can’t reach \(connection.name)", systemImage: "wifi.exclamationmark")
            } description: {
                Text("Make sure the server is running and this \(DeviceInfo.kindLabel) can reach \(connection.hostLabel) over Wi‑Fi, VPN or Tailscale.")
            } actions: {
                retryButton("Try Again")
                #if os(macOS)
                if connection.kind == .local {
                    Button {
                        startLocal()
                    } label: {
                        Label(startingLocal ? "Starting…" : "Start Local Engine", systemImage: "play.fill")
                    }
                    .secondaryActionStyle()
                    .disabled(startingLocal)
                }
                #endif
                Label("Retrying automatically", systemImage: "clock.arrow.circlepath")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion)
                    .padding(.top, 4)
            }
        case .revoked:
            ContentUnavailableView {
                Label("Pair \(connection.name) again", systemImage: "person.crop.circle.badge.xmark")
            } description: {
                Text("This \(DeviceInfo.kindLabel) was removed from \(connection.name). Pair it again with a new code from Tupies, or remove the connection.")
            } actions: {
                Button {
                    pairAgain()
                } label: {
                    Label("Pair Again", systemImage: "qrcode.viewfinder")
                        .frame(minWidth: 180)
                }
                .primaryActionStyle()
                Button(role: .destructive) {
                    confirmRemove = true
                } label: {
                    Label("Remove Connection", systemImage: "trash")
                        .foregroundStyle(.red)
                }
                .secondaryActionStyle()
                .confirmationDialog("Remove \(connection.name)?", isPresented: $confirmRemove, titleVisibility: .visible) {
                    Button("Remove Connection", role: .destructive) { store.remove(connection.id) }
                } message: {
                    Text("This \(DeviceInfo.kindLabel)’s key for \(connection.name) will be deleted.")
                }
            }
        case .failed(let message):
            ContentUnavailableView {
                Label("Something went wrong", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                retryButton("Try Again")
            }
        default:
            ConnectingView(connection: connection)
        }
    }

    private func retryButton(_ title: String) -> some View {
        Button {
            retries += 1
            store.webSession(for: connection.id).signIn()
        } label: {
            Label(title, systemImage: "arrow.clockwise")
                .frame(minWidth: 180)
        }
        .primaryActionStyle()
    }

    private func pairAgain() {
        #if os(macOS)
        if connection.kind == .local {
            store.beginPairing(.thisMac)
            return
        }
        #endif
        #if os(iOS)
        store.beginPairing(.scan)
        #else
        store.beginPairing(.paste)
        #endif
    }

    #if os(macOS)
    private func startLocal() {
        startingLocal = true
        Task {
            defer { startingLocal = false }
            do {
                try await local.start(extra: [connection.baseURL])
                _ = try? await local.waitForPairingInfo(timeout: 45)
                store.webSession(for: connection.id).signIn()
            } catch {
                store.alert = AppAlert(title: "Couldn’t start Tupies", message: error.localizedDescription)
            }
        }
    }
    #endif
}

/// The calm first moment: the Tupies mark breathing softly while the engine signs in.
private struct ConnectingView: View {
    let connection: Connection
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showsDetail = false

    var body: some View {
        VStack(spacing: 22) {
            mark
            // A quick connection shows only the mark; the words fade in if it takes a moment.
            VStack(spacing: 18) {
                VStack(spacing: 6) {
                    Text("Connecting to \(connection.name)")
                        .font(.title3.weight(.semibold))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(connection.hostLabel)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ProgressView()
                    .controlSize(.regular)
            }
            .opacity(showsDetail ? 1 : 0)
        }
        .task {
            try? await Task.sleep(nanoseconds: 350_000_000)
            withAnimation(.smooth(duration: 0.35)) { showsDetail = true }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Connecting to \(connection.name)")
        .accessibilityAddTraits(.updatesFrequently)
    }

    @ViewBuilder
    private var mark: some View {
        if reduceMotion {
            BrandMark(size: 72)
        } else {
            BrandMark(size: 72)
                .phaseAnimator([false, true]) { view, breathing in
                    view.scaleEffect(breathing ? 1.04 : 0.98)
                } animation: { _ in
                    .easeInOut(duration: 1.4)
                }
        }
    }
}
