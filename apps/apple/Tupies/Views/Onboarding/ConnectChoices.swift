import SwiftUI

/// One tappable option on the onboarding / add-connection screens.
struct ChoiceCard: View {
    let systemImage: String
    let title: String
    let subtitle: String
    var prominent = false
    var isBusy = false
    let action: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .headline) private var iconSize: CGFloat = 46

    var body: some View {
        Button(action: action) {
            layout
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                .glassSurface(RoundedRectangle(cornerRadius: 24, style: .continuous), interactive: true)
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(isBusy)
        .accessibilityLabel(title)
        .accessibilityHint(subtitle)
    }

    /// Side by side normally; stacked at accessibility text sizes so the words keep the full width.
    @ViewBuilder
    private var layout: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 12) {
                icon
                text
            }
        } else {
            HStack(spacing: 14) {
                icon
                text
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var icon: some View {
        ZStack {
            Circle()
                .fill(prominent ? AnyShapeStyle(Brand.actionFill.gradient) : AnyShapeStyle(Brand.purple.opacity(colorScheme == .dark ? 0.2 : 0.1)))
            if isBusy {
                ProgressView()
                    .controlSize(.small)
                    .tint(prominent ? Brand.onAccent : Brand.purple)
            } else {
                Image(systemName: systemImage)
                    .font(.system(size: min(iconSize, 72) * 0.41, weight: .semibold))
                    .foregroundStyle(prominent ? Brand.onAccent : Brand.purple)
                    .symbolEffect(.bounce, value: isBusy)
            }
        }
        .frame(width: min(iconSize, 72), height: min(iconSize, 72))
        .accessibilityHidden(true)
    }

    private var text: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.headline)
                .foregroundStyle(.primary)
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .multilineTextAlignment(.leading)
    }
}

/// A soft press: the card dips slightly under the finger and springs back.
struct PressableButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.9 : 1)
            .animation(reduceMotion ? nil : .bouncy(duration: 0.3, extraBounce: 0.1), value: configuration.isPressed)
    }
}

/// The ways to connect, shared by onboarding and the "Add connection" sheet.
struct ConnectChoices: View {
    @EnvironmentObject private var store: ConnectionStore
    var onScan: () -> Void
    var onPaste: () -> Void
    var onThisMac: () -> Void = {}

    var body: some View {
        VStack(spacing: 12) {
            #if os(macOS)
            if store.localConnection == nil {
                ChoiceCard(
                    systemImage: "desktopcomputer",
                    title: "Use this Mac",
                    subtitle: store.isConnectingThisMac ? "Connecting to Tupies on this Mac…" : "Connect to Tupies running here, or start it.",
                    prominent: true,
                    isBusy: store.isConnectingThisMac,
                    action: onThisMac
                )
            }
            ChoiceCard(
                systemImage: "link",
                title: "Paste pairing link",
                subtitle: "Connect to a Tupies on another computer or server.",
                action: onPaste
            )
            #else
            ChoiceCard(
                systemImage: "qrcode.viewfinder",
                title: "Scan QR code",
                subtitle: "Point your camera at the code shown in Tupies.",
                prominent: true,
                action: onScan
            )
            ChoiceCard(
                systemImage: "link",
                title: "Paste pairing link",
                subtitle: "Use a pairing link you copied from Tupies.",
                action: onPaste
            )
            #endif
        }
    }
}
