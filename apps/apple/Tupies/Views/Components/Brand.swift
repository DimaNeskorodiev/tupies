import SwiftUI

/// Colors from the Tupies web UI (public/style.css) so native chrome and web content match.
enum Brand {
    static let ink = Color(hex: 0x29313D)
    static let slate = Color(hex: 0x2C333E)
    static let slateTop = Color(hex: 0x3B4352)
    static let slateBottom = Color(hex: 0x232933)
    #if os(iOS)
    static let canvas = Color(hex: 0xF2F3F5)
    static let lavender = Color(hex: 0xE5E7EB)
    static let mint = Color(hex: 0xE8E9E7)
    static let lilac = Color(hex: 0xF0EAE3)
    // Keep native controls in the same quiet graphite palette as the phone UI.
    static let purple = ink
    #else
    static let canvas = Color(hex: 0xE9EAF2)
    static let lavender = Color(hex: 0xD8D7F1)
    static let mint = Color(hex: 0xD4E7E4)
    static let lilac = Color(hex: 0xE5DCF3)
    static let purple = Color(hex: 0x706390)
    #endif
    static let canvasDark = Color(hex: 0x111318)
    static let muted = Color(hex: 0x737B89)
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
}

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
            .shadow(color: Brand.slate.opacity(0.28), radius: size * 0.22, y: size * 0.1)
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

/// Soft blurred color fields, like the web UI's `.ambient` blobs.
struct AmbientBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
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
    }
}

extension View {
    /// Liquid Glass on iOS 26 / macOS 26, a material with a hairline elsewhere.
    @ViewBuilder
    func glassSurface<S: Shape>(_ shape: S, interactive: Bool = false) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            self.glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
            self
                .background(.regularMaterial, in: shape)
                .overlay(shape.stroke(Color.white.opacity(0.45), lineWidth: 0.5))
                .shadow(color: Brand.slate.opacity(0.08), radius: 12, y: 4)
        }
    }

    /// A soft frosted card (not interactive glass) for grouped content.
    func cardSurface(cornerRadius: CGFloat = 20) -> some View {
        self
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.5), lineWidth: 0.5)
            )
    }
}

struct StatusDot: View {
    var color: Color
    var size: CGFloat = 8

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .shadow(color: color.opacity(0.55), radius: size * 0.35)
            .accessibilityHidden(true)
    }
}

struct ToastView: View {
    let toast: Toast

    var body: some View {
        Label(toast.message, systemImage: toast.systemImage)
            .font(.subheadline.weight(.medium))
            .lineLimit(2)
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            .glassSurface(Capsule())
            .padding(.horizontal, 24)
    }
}
