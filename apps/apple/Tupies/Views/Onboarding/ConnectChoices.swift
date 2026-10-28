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

    private var prominentFill: AnyShapeStyle {
        colorScheme == .dark ? AnyShapeStyle(Brand.purple.gradient) : AnyShapeStyle(Brand.slate.gradient)
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                ZStack {
                    Circle()
                        .fill(prominent ? prominentFill : AnyShapeStyle(Brand.purple.opacity(colorScheme == .dark ? 0.28 : 0.14)))
                    if isBusy {
                        ProgressView()
                            .controlSize(.small)
                            .tint(prominent ? .white : Brand.purple)
                    } else {
                        Image(systemName: systemImage)
                            .font(.system(size: 19, weight: .semibold))
                            .foregroundStyle(prominent ? Color.white : (colorScheme == .dark ? Color(hex: 0xB6A8E0) : Brand.purple))
                    }
                }
                .frame(width: 44, height: 44)

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

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .glassSurface(RoundedRectangle(cornerRadius: 22, style: .continuous), interactive: true)
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(isBusy)
    }
}

struct PressableButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .opacity(configuration.isPressed ? 0.92 : 1)
            .animation(reduceMotion ? nil : .spring(duration: 0.25), value: configuration.isPressed)
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
                subtitle: "Use a hermes-studio:// link you copied.",
                action: onPaste
            )
            #endif
        }
    }
}
