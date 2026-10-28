import SwiftUI

@main
struct TupiesApp: App {
    #if os(macOS)
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var localEngine = LocalEngineController.shared
    #else
    @UIApplicationDelegateAdaptor(IOSAppDelegate.self) private var appDelegate
    #endif
    @StateObject private var store = ConnectionStore()

    var body: some Scene {
        #if os(macOS)
        // A single main window: each engine's web view can only live in one window.
        Window("Tupies", id: "main") {
            RootView()
                .environmentObject(store)
                .environmentObject(localEngine)
                .frame(minWidth: 760, minHeight: 540)
        }
        .defaultSize(width: 1200, height: 820)
        .windowToolbarStyle(.unified(showsTitle: false))
        .commands { StudioCommands(store: store) }

        Settings {
            SettingsView()
                .environmentObject(store)
                .environmentObject(localEngine)
        }
        #else
        WindowGroup {
            RootView()
                .environmentObject(store)
        }
        .commands { StudioCommands(store: store) }
        #endif
    }
}

#if os(macOS)
import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillTerminate(_ notification: Notification) {
        // Only stops an engine this app started; never one launched elsewhere.
        LocalEngineController.shared.terminateIfOwned()
    }
}
#endif
