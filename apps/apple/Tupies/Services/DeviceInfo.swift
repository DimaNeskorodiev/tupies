import Foundation
#if os(iOS)
import UIKit
#else
import AppKit
import SystemConfiguration
#endif

enum DeviceInfo {
    /// `platform` value sent to the engine when pairing.
    static var platform: String {
        #if os(iOS)
        return "ios"
        #else
        return "macos"
        #endif
    }

    static var kindLabel: String {
        #if os(iOS)
        return UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        #else
        return "Mac"
        #endif
    }

    /// The name this device suggests to the engine (editable before pairing).
    @MainActor static var defaultName: String {
        #if os(iOS)
        let name = UIDevice.current.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? kindLabel : name
        #else
        if let name = SCDynamicStoreCopyComputerName(nil, nil) as String?, !name.isEmpty {
            return name
        }
        return Host.current().localizedName ?? "Mac"
        #endif
    }

    static var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.5.0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        return "\(version) (\(build))"
    }
}
