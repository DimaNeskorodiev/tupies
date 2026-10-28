import SwiftUI
import WebKit

/// The engine UI for the active connection, with the native switcher.
struct MainView: View {
    @EnvironmentObject private var store: ConnectionStore

    var body: some View {
        Group {
            if let connection = store.activeConnection {
                EngineContentView(connection: connection, session: store.webSession(for: connection.id))
            } else {
                Color.clear.onAppear {
                    if let first = store.connections.first { store.activate(first.id) }
                }
            }
        }
        #if os(macOS)
        .toolbar { MacToolbar() }
        #else
        .background(Brand.canvas.ignoresSafeArea())
        .preferredColorScheme(.light)
        .sheet(isPresented: $store.showSettings) {
            SettingsView()
                .environmentObject(store)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(28)
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

    #if os(iOS)
    /// The engine bar (switcher and sync) stays until the page shows its own navigation; it comes back while the
    /// engine is loading or unreachable, so another engine is always one tap away.
    private var showsEngineBar: Bool {
        !(session.webOwnsChrome && session.hasLoadedEngine && !session.phase.isError)
    }
    #endif

    var body: some View {
        ZStack(alignment: .top) {
            WebViewHost(webView: session.webView)
                #if os(iOS)
                // WebKit keeps the page inside the safe area itself and fills the home-indicator area with the page background.
                // A page with its own navigation runs edge to edge and pads itself with env(safe-area-inset-*).
                .ignoresSafeArea(.container, edges: showsEngineBar ? .bottom : .all)
                #endif
                .opacity(session.hasLoadedEngine && !session.phase.isError ? 1 : 0)
                .sheet(item: $session.popup) { page in
                    PopupWebSheet(page: page, title: connection.name) { session.popup = nil }
                }

            if session.hasLoadedEngine && session.isNavigating && session.progress < 1 {
                ProgressView(value: session.progress)
                    .progressViewStyle(.linear)
                    .tint(Brand.purple)
                    .frame(height: 2)
                    .transition(.opacity)
            }

            if session.phase.isError || !session.hasLoadedEngine {
                ConnectionStateOverlay(connection: connection, phase: session.phase)
                    .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: session.phase)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: session.hasLoadedEngine)
        .task(id: connection.id) { session.start() }
        #if os(iOS)
        .safeAreaInset(edge: .top, spacing: 0) {
            if showsEngineBar { PhoneTopBar() }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: showsEngineBar)
        .sheet(item: $session.sharedFile) { file in
            ShareSheet(url: file.url)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        #endif
    }
}

/// Loading, unreachable, revoked and failure states.
struct ConnectionStateOverlay: View {
    @EnvironmentObject private var store: ConnectionStore
    #if os(macOS)
    @EnvironmentObject private var local: LocalEngineController
    #endif
    let connection: Connection
    let phase: EngineWebSession.Phase
    @State private var confirmRemove = false
    @State private var startingLocal = false

    var body: some View {
        ZStack {
            AmbientBackground()
            VStack(spacing: 18) {
                switch phase {
                case .unreachable(let message):
                    stateIcon("wifi.exclamationmark", tint: .orange)
                    title("Can’t reach \(connection.name)")
                    detail(message)
                    actions {
                        primary("Retry", systemImage: "arrow.clockwise") { store.webSession(for: connection.id).signIn() }
                        #if os(macOS)
                        if connection.kind == .local {
                            secondary(startingLocal ? "Starting…" : "Start Local Engine", systemImage: "play.fill") { startLocal() }
                                .disabled(startingLocal)
                        }
                        #endif
                    }
                    Text("Retrying automatically…")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                case .revoked(let message):
                    stateIcon("person.crop.circle.badge.xmark", tint: .red)
                    title("Pair \(connection.name) again")
                    detail(message)
                    actions {
                        primary("Pair Again", systemImage: "qrcode") { pairAgain() }
                        secondary("Remove", systemImage: "trash") { confirmRemove = true }
                            .confirmationDialog("Remove \(connection.name)?", isPresented: $confirmRemove, titleVisibility: .visible) {
                                Button("Remove Connection", role: .destructive) { store.remove(connection.id) }
                            } message: {
                                Text("This device’s key for \(connection.name) will be deleted.")
                            }
                    }
                case .failed(let message):
                    stateIcon("exclamationmark.triangle", tint: .orange)
                    title("Something went wrong")
                    detail(message)
                    actions {
                        primary("Try Again", systemImage: "arrow.clockwise") { store.webSession(for: connection.id).signIn() }
                    }
                default:
                    BrandMark(size: 64)
                    title("Connecting to \(connection.name)…")
                    ProgressView()
                        .controlSize(.regular)
                        .padding(.top, 4)
                    Text(connection.hostLabel)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(32)
            .frame(maxWidth: 440)
        }
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

    private func stateIcon(_ name: String, tint: Color) -> some View {
        Image(systemName: name)
            .font(.system(size: 34, weight: .medium))
            .foregroundStyle(tint)
            .frame(width: 76, height: 76)
            .glassSurface(Circle())
    }

    private func title(_ text: String) -> some View {
        Text(text)
            .font(.title2.weight(.bold))
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func detail(_ text: String) -> some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func actions<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: 12) { content() }
            .padding(.top, 4)
    }

    private func primary(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .padding(.horizontal, 6)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
    }

    private func secondary(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .padding(.horizontal, 6)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
    }
}
