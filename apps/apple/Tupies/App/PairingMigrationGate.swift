import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
final class AppRuntime: ObservableObject {
    let store: ConnectionStore
    #if os(macOS)
    let local: LocalEngineController
    #endif
    init() {
        #if os(iOS)
        NotificationCoordinator.shared.reloadPreferencesAfterMigration()
        #endif
        store = ConnectionStore()
        #if os(macOS)
        local = LocalEngineController.shared
        AppLifecycle.localEngine = local
        AppLifecycle.connectionStore = store
        #endif
    }
}

@MainActor
final class PairingMigrationGate: ObservableObject {
    @Published private(set) var runtime: AppRuntime?
    @Published private(set) var error: String?
    @Published private(set) var checking = false
    private var pendingPairingLink = StartupPairingLink()
    func handleIncomingURL(_ url: URL) {
        guard url.absoluteString.utf8.count <= 16_384 else { return }
        if url.scheme == "tupies", url.host == "transfer" { start(); return }
        guard url.scheme?.lowercased() == PairingLink.scheme else { return }
        if let runtime { runtime.store.handleIncomingURL(url) }
        else { pendingPairingLink.offer(url) }
    }
    func start() {
        guard runtime == nil, !checking else { return }
        checking = true; error = nil
        Task {
            do {
                _ = try await Task.detached(priority: .userInitiated) { try PairingMigrationService.system().preparePrimary() }.value
                let ready = AppRuntime()
                if let pending = pendingPairingLink.take() {
                    ready.store.handleIncomingURL(pending)
                }
                runtime = ready
            } catch { self.error = error.localizedDescription }
            checking = false
        }
    }
}

struct PairingMigrationGateView: View {
    @ObservedObject var gate: PairingMigrationGate
    var body: some View {
        Group {
            if let runtime = gate.runtime {
                #if os(macOS)
                RootView().environmentObject(runtime.store).environmentObject(runtime.local)
                #else
                RootView().environmentObject(runtime.store)
                #endif
            } else {
                ZStack {
                    AmbientBackground()
                    GeometryReader { geometry in
                    ScrollView {
                    VStack(spacing: 20) {
                        BrandMark(size: 64)
                        Text(gate.error == nil ? "Checking your connections…" : "Transfer your Tupies connections")
                            .font(.title2.bold()).multilineTextAlignment(.center)
                        if let error = gate.error {
                            Text(error).foregroundStyle(.secondary).multilineTextAlignment(.center)
                            Button("Try Again") { gate.start() }.primaryActionStyle()
                            Button { openTransferApp() } label: {
                                Text("Open Tupies Transfer").multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                            }.secondaryActionStyle()
                            Text("Your previous app, device keys and engine data are kept.")
                                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        } else { ProgressView() }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(32).frame(maxWidth: 560)
                    .frame(maxWidth: .infinity, minHeight: geometry.size.height)
                    }
                    }
                }
            }
        }
        .task { gate.start() }
        .onOpenURL { gate.handleIncomingURL($0) }
    }
    private func openTransferApp() {
        guard let url = URL(string: "tupies-transfer://open") else { return }
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        UIApplication.shared.open(url)
        #endif
    }
}

struct PairingTransferView: View {
    @State private var busy = false
    @State private var receipt: PairingMigrationService.Receipt?
    @State private var error: String?
    var body: some View {
        ZStack {
            AmbientBackground()
            GeometryReader { geometry in
            ScrollView {
            VStack(spacing: 20) {
                BrandMark(size: 64)
                Text("Move your connections to Tupies").font(.title2.bold()).multilineTextAlignment(.center)
                Text("This transfer app prepares your existing pairings on this device. It keeps the original keys and settings, and does not start or change your engines.")
                    .foregroundStyle(.secondary).multilineTextAlignment(.center)
                if let receipt {
                    Label(receipt.alreadyCompleted ? "Transfer already completed" : "\(receipt.connections) connections prepared", systemImage: "checkmark.shield.fill")
                        .font(.headline).foregroundStyle(.green)
                    Text(receipt.alreadyCompleted ? "Your new Tupies settings are now authoritative." : "All device keys were checked. \(receipt.secureEnclaveKeys) use the Secure Enclave.")
                        .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button { openPrimary() } label: {
                        Text("Open Tupies").multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    }.primaryActionStyle()
                } else {
                    if let error { Text(error).foregroundStyle(.red).multilineTextAlignment(.center) }
                    Button { prepare() } label: {
                        if busy { ProgressView() }
                        else { Text(error == nil ? "Prepare Transfer" : "Try Again").multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true) }
                    }
                    .primaryActionStyle().disabled(busy)
                }
                Text("No key or settings file is exported. Keep both apps until the new Tupies confirms the transfer.")
                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(32).frame(maxWidth: 560)
            .frame(maxWidth: .infinity, minHeight: geometry.size.height)
            }
            }
        }
    }
    private func prepare() {
        guard !busy else { return }; busy = true; error = nil
        Task {
            do { receipt = try await Task.detached(priority: .userInitiated) { try PairingMigrationService.system().exportLegacy() }.value }
            catch { self.error = error.localizedDescription }
            busy = false
        }
    }
    private func openPrimary() {
        guard let url = URL(string: "tupies://transfer") else { return }
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        UIApplication.shared.open(url)
        #endif
    }
}

#if os(macOS)
@MainActor
enum AppLifecycle {
    static weak var localEngine: LocalEngineController?
    static weak var connectionStore: ConnectionStore?
}
#endif
