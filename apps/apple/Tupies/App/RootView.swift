import SwiftUI

/// Onboarding until the first engine is paired, then the engine UI.
struct RootView: View {
    @EnvironmentObject private var store: ConnectionStore
    #if os(macOS)
    @EnvironmentObject private var local: LocalEngineController
    #endif
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if store.connections.isEmpty {
                OnboardingView()
                    .transition(.opacity)
            } else {
                MainView()
                    .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: store.connections.isEmpty)
        .overlay(alignment: .bottom) {
            if let toast = store.toast {
                ToastView(toast: toast)
                    .padding(.bottom, 24)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .id(toast.id)
            }
        }
        .sheet(item: $store.pairingSheet) { request in
            pairingSheet(for: request)
        }
        .alert(
            store.alert?.title ?? "",
            isPresented: Binding(get: { store.alert != nil }, set: { if !$0 { store.alert = nil } }),
            presenting: store.alert
        ) { _ in
            Button("OK", role: .cancel) { store.alert = nil }
        } message: { alert in
            Text(alert.message)
        }
        .onOpenURL { url in
            store.handleIncomingURL(url)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                store.resume()
                #if os(iOS)
                Task { await NotificationCoordinator.shared.refresh() }
                #endif
            }
        }
        .task {
            #if os(macOS)
            await store.autoPairLocalIfNeeded()
            #else
            NotificationCoordinator.shared.attach(store)
            #endif
        }
        .task {
            await store.monitor()
        }
        #if os(iOS)
        .tint(Brand.ink)
        #endif
        #if os(macOS)
        .handlesExternalEvents(preferring: ["*"], allowing: ["*"])
        #endif
    }

    @ViewBuilder
    private func pairingSheet(for request: PairingSheetRequest) -> some View {
        #if os(macOS)
        PairingFlowView(start: request.start)
            .environmentObject(store)
            .environmentObject(local)
        #else
        PairingFlowView(start: request.start)
            .environmentObject(store)
            .presentationDragIndicator(.visible)
            .presentationCornerRadius(28)
        #endif
    }
}
