#if os(iOS)
import UIKit

/// A small, shared vocabulary for deliberate touch feedback in native and engine screens.
@MainActor
enum StudioHaptics {
    private static let selection = UISelectionFeedbackGenerator()
    private static let light = UIImpactFeedbackGenerator(style: .light)
    private static let notification = UINotificationFeedbackGenerator()
    private static var lastFeedback: TimeInterval = 0

    static func play(_ style: String) {
        guard ["selection", "light", "success", "warning"].contains(style),
              UIApplication.shared.applicationState == .active else { return }
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastFeedback >= 0.09 else { return }
        lastFeedback = now
        switch style {
        case "selection": selection.selectionChanged()
        case "light": light.impactOccurred(intensity: 0.65)
        case "success": notification.notificationOccurred(.success)
        case "warning": notification.notificationOccurred(.warning)
        default: break
        }
    }
}
#endif
