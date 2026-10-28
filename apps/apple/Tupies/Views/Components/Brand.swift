import SwiftUI
#if os(iOS)
import UIKit
#endif

/// Colors from the Tupies web UI (public/pearl.css) so native chrome and web content match.
enum Brand {
    static let slate = Color(hex: 0x2C333E)
    static let slateTop = Color(hex: 0x3B4352)
    static let slateBottom = Color(hex: 0x232933)
    #if os(iOS)
    /// The page's phone base (`--pearl-base`): #f5f8fc in light, #0c1017 in dark. The launch screen uses the same
    /// asset color, so launch, native screens and the engine page meet without a flash.
    static let base = Color(.launchBackground)
    static let canvas = base
    /// Graphite text and controls in light; pearl ink in dark.
    static let ink = Color(light: 0x29313D, dark: 0xEEF2FA)
    static let muted = Color(light: 0x606E88, dark: 0xB6C1D4)
    /// The app tint for text and symbols (asset `AccentColor`): the phone page's blue (`--ios-tint`) in light and dark.
    static let purple = Color.accentColor
    /// Fill of prominent buttons: the page's filled blue (`--ios-tint-fill`) in light and dark.
    static let actionFill = Color(light: 0x2860C2, dark: 0x2F6FD6)
    /// Text and symbols drawn on `actionFill`.
    static let onAccent = Color.white
    /// Restrained amber detail (`--pearl-amber`).
    static let amber = Color(light: 0xBE5B13, dark: 0xFFD19E)
    #else
    static let ink = Color(hex: 0x29313D)
    static let canvas = Color(hex: 0xE9EAF2)
    /// The window background behind native content.
    static let base = Color(nsColor: .windowBackgroundColor)
    static let lavender = Color(hex: 0xD8D7F1)
    static let mint = Color(hex: 0xD4E7E4)
    static let lilac = Color(hex: 0xE5DCF3)
    static let purple = Color(hex: 0x706390)
    static let actionFill = purple
    static let onAccent = Color.white
    static let amber = Color(hex: 0xBE5B13)
    static let canvasDark = Color(hex: 0x111318)
    static let muted = Color(hex: 0x737B89)
    #endif
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }

    #if os(iOS)
    /// A color that follows the light/dark appearance of the view that draws it.
    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { traits in
            UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
        })
    }
    #endif
}

#if os(iOS)
extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}
#endif

/// The Tupies "T" mark from the web favicon, drawn natively.
struct BrandMark: View {
    var size: CGFloat = 56
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        RoundedRectangle(cornerRadius: size * 19 / 64, style: .continuous)
            .fill(LinearGradient(colors: [Brand.slateTop, Brand.slateBottom], startPoint: .top, endPoint: .bottom))
            .overlay(
                TGlyph()
                    .stroke(.white, style: StrokeStyle(lineWidth: size * 7 / 64, lineCap: .round))
            )
            .overlay(
                RoundedRectangle(cornerRadius: size * 19 / 64, style: .continuous)
                    .strokeBorder(.white.opacity(colorScheme == .dark ? 0.22 : 0.08), lineWidth: 1)
            )
            .frame(width: size, height: size)
            .shadow(color: (colorScheme == .dark ? Color.black : Brand.slate).opacity(colorScheme == .dark ? 0.45 : 0.28), radius: size * 0.22, y: size * 0.1)
            .accessibilityHidden(true)
    }
}

private struct TGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let unit = min(rect.width, rect.height) / 64
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * unit, y: rect.minY + y * unit)
        }
        var path = Path()
        path.move(to: point(18, 18)); path.addLine(to: point(46, 18))
        path.move(to: point(32, 18)); path.addLine(to: point(32, 46))
        return path
    }
}

/// The page's background: the pearl base with soft sky and amber light, like `body.pearl-studio` in the web UI.
struct AmbientBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        #if os(iOS)
        GeometryReader { proxy in
            let size = proxy.size
            let dark = colorScheme == .dark
            ZStack {
                Brand.base
                glow(dark ? Color(hex: 0x446BA4, opacity: 0.25) : Color(hex: 0xA3CFFF, opacity: 0.5),
                     center: UnitPoint(x: dark ? 0.02 : 0.04, y: dark ? 0.10 : 0.13), radii: CGSize(width: 0.66, height: 0.62), in: size)
                glow(dark ? Color(hex: 0xAF6F38, opacity: 0.11) : Color(hex: 0xFFC785, opacity: 0.3),
                     center: UnitPoint(x: dark ? 0.98 : 0.96, y: dark ? 0.72 : 0.66), radii: CGSize(width: 0.48, height: 0.55), in: size)
                if !dark {
                    glow(Color(hex: 0xA5CCFF, opacity: 0.4), center: UnitPoint(x: 0.47, y: 1.05), radii: CGSize(width: 0.6, height: 0.65), in: size)
                }
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
        #else
        GeometryReader { proxy in
            let width = proxy.size.width
            let height = proxy.size.height
            let dark = colorScheme == .dark
            ZStack {
                (dark ? Brand.canvasDark : Brand.canvas)
                Circle()
                    .fill(dark ? Color(hex: 0x4A4391) : Brand.lavender)
                    .frame(width: width * 0.95, height: width * 0.95)
                    .position(x: width * 0.1, y: height * 0.08)
                    .opacity(dark ? 0.55 : 0.8)
                Circle()
                    .fill(dark ? Color(hex: 0x23574F) : Brand.mint)
                    .frame(width: width * 0.9, height: width * 0.9)
                    .position(x: width * 0.95, y: height * 0.92)
                    .opacity(dark ? 0.55 : 0.85)
                Circle()
                    .fill(dark ? Color(hex: 0x553A78) : Brand.lilac)
                    .frame(width: width * 0.6, height: width * 0.6)
                    .position(x: width * 0.92, y: height * 0.12)
                    .opacity(dark ? 0.45 : 0.7)
            }
            .blur(radius: min(width, height) * 0.16)
            .background(dark ? Brand.canvasDark : Brand.canvas)
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
        #endif
    }

    #if os(iOS)
    /// One CSS `radial-gradient(ellipse rx ry at x y, color, transparent 76%)`.
    private func glow(_ color: Color, center: UnitPoint, radii: CGSize, in size: CGSize) -> some View {
        let width = size.width * radii.width * 2
        let height = size.height * radii.height * 2
        return EllipticalGradient(colors: [color, color.opacity(0)], center: .center, startRadiusFraction: 0, endRadiusFraction: 0.38)
            .frame(width: width, height: height)
            .position(x: size.width * center.x, y: size.height * center.y)
    }
    #endif
}

extension View {
    /// Liquid Glass on iOS 26 / macOS 26, a material with a hairline elsewhere.
    func glassSurface<S: Shape>(_ shape: S, interactive: Bool = false) -> some View {
        modifier(GlassSurface(shape: shape, interactive: interactive))
    }

    /// A soft frosted card (not interactive glass) for grouped content.
    func cardSurface(cornerRadius: CGFloat = 20) -> some View {
        modifier(CardSurface(cornerRadius: cornerRadius))
    }

    /// The main action of a screen: prominent Liquid Glass on iOS 26 / macOS 26, a filled button elsewhere.
    @ViewBuilder
    func primaryActionStyle() -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            self.buttonStyle(.glassProminent).controlSize(.large).tint(Brand.actionFill)
        } else {
            self.buttonStyle(.borderedProminent).controlSize(.large).tint(Brand.actionFill)
        }
    }

    /// A secondary action next to the main one: clear Liquid Glass on iOS 26 / macOS 26, a tinted button elsewhere.
    @ViewBuilder
    func secondaryActionStyle() -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            self.buttonStyle(.glass).controlSize(.large)
        } else {
            self.buttonStyle(.bordered).controlSize(.large)
        }
    }
}

private struct GlassSurface<S: Shape>: ViewModifier {
    let shape: S
    let interactive: Bool
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content.glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
            // Materials turn opaque by themselves when Reduce Transparency is on.
            content
                .background(.regularMaterial, in: shape)
                .overlay(shape.stroke(Color.white.opacity(colorScheme == .dark ? 0.12 : 0.45), lineWidth: 0.5))
                .shadow(color: Brand.slate.opacity(colorScheme == .dark ? 0.3 : 0.08), radius: 12, y: 4)
        }
    }
}

private struct CardSurface: ViewModifier {
    let cornerRadius: CGFloat
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .background(.thinMaterial, in: shape)
            .overlay(shape.strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.1 : 0.5), lineWidth: 0.5))
    }
}

struct StatusDot: View {
    var color: Color
    var size: CGFloat = 8
    /// Pulses softly while true (for example while checking or syncing).
    var pulsing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Image(systemName: "circle.fill")
            .font(.system(size: size))
            .foregroundStyle(color)
            .frame(width: size, height: size)
            .shadow(color: color.opacity(0.55), radius: size * 0.35)
            .symbolEffect(.pulse, options: .repeating, isActive: pulsing && !reduceMotion)
            .accessibilityHidden(true)
    }
}

struct ToastView: View {
    let toast: Toast

    var body: some View {
        Label {
            Text(toast.message)
        } icon: {
            Image(systemName: toast.systemImage)
                .symbolEffect(.bounce, value: toast.id)
        }
        .font(.subheadline.weight(.medium))
        .lineLimit(2)
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .glassSurface(Capsule())
        .padding(.horizontal, 24)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
    }
}

/// A sheet's close control: the system close button (an xmark in Liquid Glass) on iOS 26 / macOS 26, a text button before.
struct SheetCloseButton: View {
    /// Shown on earlier systems, and read by VoiceOver everywhere.
    var title: String = "Done"
    let action: () -> Void

    var body: some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            Button(role: .close, action: action)
                .accessibilityLabel(title)
        } else {
            Button(title, action: action)
                .fontWeight(.semibold)
        }
    }
}
