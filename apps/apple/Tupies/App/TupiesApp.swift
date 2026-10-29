import SwiftUI

#if TUPIES_MIGRATION_BRIDGE
@main
struct TupiesTransferApp: App {
    var body: some Scene {
        #if os(macOS)
        Window("Tupies Transfer", id: "transfer") {
            PairingTransferView().frame(minWidth: 560, minHeight: 480)
        }.defaultSize(width: 680, height: 600)
        .commands { CommandGroup(replacing: .newItem) {} }
        #else
        WindowGroup { PairingTransferView() }
        #endif
    }
}
#else
@main
struct TupiesApp: App {
    #if os(macOS)
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #else
    @UIApplicationDelegateAdaptor(IOSAppDelegate.self) private var appDelegate
    #endif
    @StateObject private var gate = PairingMigrationGate()

    var body: some Scene {
        #if os(macOS)
        // A single main window: each engine's web view can only live in one window.
        Window("Tupies", id: "main") {
            PairingMigrationGateView(gate: gate)
                .frame(minWidth: 760, minHeight: 540)
        }
        .defaultSize(width: 1200, height: 820)
        .windowToolbarStyle(.unified(showsTitle: false))
        .commands { if let runtime = gate.runtime { StudioCommands(store: runtime.store) } }

        Settings {
            if let runtime = gate.runtime {
                SettingsView().environmentObject(runtime.store).environmentObject(runtime.local)
            } else { PairingMigrationGateView(gate: gate) }
        }
        #else
        WindowGroup {
            PairingMigrationGateView(gate: gate)
        }
        .commands { if let runtime = gate.runtime { StudioCommands(store: runtime.store) } }
        #endif
    }
}
#endif

#if os(macOS)
import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillTerminate(_ notification: Notification) {
        // Only stops an engine this app started; never one launched elsewhere.
        AppLifecycle.localEngine?.terminateIfOwned()
    }
}
#endif
