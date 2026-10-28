#if os(iOS)
import UIKit

/// The shared vocabulary for deliberate touch feedback in native screens and the engine page.
///
/// The page may request exactly these styles with `{type: "haptic", style}` through the `hermesStudio` bridge; any other
/// value is ignored. Feedback plays only while the app is active and at most once per `minimumInterval`.
@MainActor
enum StudioHaptics {
    enum Style: String, CaseIterable {
        /// Moving between values: tabs, segments, pickers, switching engines.
        case selection
        /// A small deliberate tap: opening a menu, a sheet snapping into place.
        case light
        /// A firmer confirmation: sending a message, starting a run.
        case medium
        /// A crisp, precise edge: a drag reaching a limit, a toggle locking in.
        case rigid
        /// A soft, cushioned tap: a sheet settling, a card landing.
        case soft
        /// Something finished well: paired, saved, delivered.
        case success
        /// Needs attention but nothing failed: an approval waiting, an action held back.
        case warning
        /// Something failed: a rejected request, an invalid link.
        case error
    }

    /// Shortest gap between two feedback events, so a page cannot buzz the device continuously.
    static let minimumInterval: TimeInterval = 0.09

    private static let selectionGenerator = UISelectionFeedbackGenerator()
    private static let lightGenerator = UIImpactFeedbackGenerator(style: .light)
    private static let mediumGenerator = UIImpactFeedbackGenerator(style: .medium)
    private static let rigidGenerator = UIImpactFeedbackGenerator(style: .rigid)
    private static let softGenerator = UIImpactFeedbackGenerator(style: .soft)
    private static let notificationGenerator = UINotificationFeedbackGenerator()
    private static var lastFeedback: TimeInterval = 0

    /// Plays a style from the bridge vocabulary; unknown names do nothing.
    static func play(_ name: String) {
        guard let style = Style(rawValue: name) else { return }
        play(style)
    }

    static func play(_ style: Style) {
        guard UIApplication.shared.applicationState == .active else { return }
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastFeedback >= minimumInterval else { return }
        lastFeedback = now
        switch style {
        case .selection:
            selectionGenerator.selectionChanged()
            selectionGenerator.prepare()
        case .light:
            lightGenerator.impactOccurred(intensity: 0.65)
            lightGenerator.prepare()
        case .medium:
            mediumGenerator.impactOccurred()
            mediumGenerator.prepare()
        case .rigid:
            rigidGenerator.impactOccurred(intensity: 0.8)
            rigidGenerator.prepare()
        case .soft:
            softGenerator.impactOccurred(intensity: 0.75)
            softGenerator.prepare()
        case .success:
            notificationGenerator.notificationOccurred(.success)
            notificationGenerator.prepare()
        case .warning:
            notificationGenerator.notificationOccurred(.warning)
            notificationGenerator.prepare()
        case .error:
            notificationGenerator.notificationOccurred(.error)
            notificationGenerator.prepare()
        }
    }

    /// Wakes the Taptic Engine shortly before feedback is likely (the app becoming active, a page appearing), so the
    /// first tap is not late. The system lets prepared generators idle again after a few seconds.
    static func prepare() {
        guard UIApplication.shared.applicationState == .active else { return }
        selectionGenerator.prepare()
        lightGenerator.prepare()
        notificationGenerator.prepare()
    }
}
#endif
