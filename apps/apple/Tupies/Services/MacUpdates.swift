#if os(macOS)
import AppKit
import SwiftUI
import Sparkle
import Combine

enum MacUpdateError: LocalizedError {
    case postponed(String)
    var errorDescription: String? { if case .postponed(let message) = self { return message }; return nil }
}

@MainActor
final class MacUpdates: NSObject, ObservableObject, SPUUpdaterDelegate {
    static let shared = MacUpdates()
    @Published private(set) var configured = false
    @Published private(set) var canCheck = false
    @Published private(set) var preparing = false
    @Published private(set) var message = ""
    @Published private(set) var hasDownloadedUpdate = false
    private var controller: SPUStandardUpdaterController!
    private var installHandler: (() -> Void)?
    private var prepared = false
    private var abortedDuringPreparation = false
    private var preparation: Task<Bool, Never>?
    private var restartConnection: Connection?
    private var observations = Set<AnyCancellable>()
    var blocksEngineStart: Bool { preparing || prepared }

    override init() {
        super.init()
        let info = Bundle.main.infoDictionary ?? [:]
        guard let feed = info["SUFeedURL"] as? String, let url = URL(string: feed), url.scheme == "https", url.host != nil,
              let key = info["SUPublicEDKey"] as? String, Data(base64Encoded: key)?.count == 32 else { return }
        configured = true
        controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
        controller.updater.publisher(for: \.canCheckForUpdates).receive(on: RunLoop.main).sink { [weak self] in self?.canCheck = $0 }.store(in: &observations)
        controller.startUpdater()
    }
    var automaticChecks: Bool {
        get { configured && controller.updater.automaticallyChecksForUpdates }
        set { if configured { controller.updater.automaticallyChecksForUpdates = newValue; objectWillChange.send() } }
    }
    var automaticDownloads: Bool {
        get { configured && controller.updater.automaticallyDownloadsUpdates }
        set { if configured { controller.updater.automaticallyDownloadsUpdates = newValue; objectWillChange.send() } }
    }
    func check() { if configured { controller.checkForUpdates(nil) } }
    func installDownloaded() { guard let handler = installHandler else { return }; beginInstall(handler) }
    private func beginInstall(_ handler: @escaping () -> Void) {
        Task { if await prepare() { handler() } }
    }
    func prepare() async -> Bool {
        if prepared { return true }
        if let preparation { return await preparation.value }
        let task = Task { @MainActor in
            abortedDuringPreparation = false
            preparing = true; message = "Preparing the update and verifying your local backup…"
            defer { preparing = false; preparation = nil }
            do {
                // Lock pages before stopping the Engine, so a newly typed draft cannot be lost.
                try await AppLifecycle.connectionStore?.lockPagesForUpdate()
                if let local = AppLifecycle.localEngine, local.usesBundledEngine && local.ownsProcess && local.isProcessRunning {
                    restartConnection = AppLifecycle.connectionStore?.localConnection
                }
                try await AppLifecycle.localEngine?.prepareForAppUpdate()
                if abortedDuringPreparation {
                    AppLifecycle.localEngine?.cancelAppUpdatePreparation()
                    AppLifecycle.connectionStore?.unlockPagesAfterUpdate()
                    preparing = false
                    await restartAfterAbortedUpdate()
                    return false
                }
                prepared = true; message = "Ready to install."; return true
            } catch {
                AppLifecycle.connectionStore?.unlockPagesAfterUpdate()
                AppLifecycle.localEngine?.cancelAppUpdatePreparation()
                preparing = false
                await restartAfterAbortedUpdate()
                message = error.localizedDescription
                let alert = NSAlert(); alert.messageText = "Update postponed"; alert.informativeText = message; alert.runModal()
                return false
            }
        }
        preparation = task; return await task.value
    }
    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) { hasDownloadedUpdate = true }
    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem, untilInvokingBlock handler: @escaping () -> Void) -> Bool {
        hasDownloadedUpdate = true; installHandler = handler; beginInstall(handler); return true
    }
    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock handler: @escaping () -> Void) -> Bool {
        hasDownloadedUpdate = true; installHandler = handler; message = "An update is downloaded. It will install when you quit safely."; return true
    }
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        hasDownloadedUpdate = false; installHandler = nil; message = error.localizedDescription
        if preparing { abortedDuringPreparation = true; return }
        prepared = false
        AppLifecycle.localEngine?.cancelAppUpdatePreparation()
        AppLifecycle.connectionStore?.unlockPagesAfterUpdate(); message = error.localizedDescription
        Task { await restartAfterAbortedUpdate() }
    }
    private func restartAfterAbortedUpdate() async {
        guard let connection = restartConnection, let local = AppLifecycle.localEngine else { return }
        restartConnection = nil
        guard !local.isProcessRunning else { return }
        do { try await local.start(expectedConnection: connection) }
        catch { message += " Reopen your local Engine after reviewing its error: \(error.localizedDescription)" }
    }
}

struct MacUpdateCommands: Commands {
    @ObservedObject private var updates = MacUpdates.shared
    var body: some Commands {
        CommandGroup(after: .appInfo) {
            Button("Check for Updates…") { updates.check() }.disabled(!updates.canCheck || updates.preparing)
        }
    }
}
struct MacUpdateSettings: View {
    @ObservedObject private var updates = MacUpdates.shared
    var body: some View {
        Section("Updates") {
            if updates.configured {
                Toggle("Check for updates automatically", isOn: Binding(get: { updates.automaticChecks }, set: { updates.automaticChecks = $0 }))
                Toggle("Download updates automatically", isOn: Binding(get: { updates.automaticDownloads }, set: { updates.automaticDownloads = $0 }))
                Button("Check for Updates…") { updates.check() }.disabled(!updates.canCheck || updates.preparing)
                if updates.hasDownloadedUpdate { Button("Install Downloaded Update") { updates.installDownloaded() }.disabled(updates.preparing) }
                if !updates.message.isEmpty { Text(updates.message).font(.callout).foregroundStyle(.secondary) }
                Text("Updates include this Mac’s Engine. Local work must finish before installation. An encrypted backup is verified before replacing the app.").font(.callout).foregroundStyle(.secondary)
            } else {
                Text("Automatic updates aren’t configured in this build. Install the next official Tupies release to enable them.").foregroundStyle(.secondary)
            }
        }
    }
}
#endif
