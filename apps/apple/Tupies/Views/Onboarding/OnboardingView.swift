import SwiftUI

/// Product introduction and the first engine choice.
struct OnboardingView: View {
    @EnvironmentObject private var store: ConnectionStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false

    var body: some View {
        ZStack {
            AmbientBackground()

            GeometryReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        Spacer(minLength: 24)

                        header
                            .padding(.bottom, 36)
                            .modifier(Entrance(appeared: appeared, delay: 0))

                        ConnectChoices(
                            onScan: { store.beginPairing(.scan) },
                            onPaste: { store.beginPairing(.paste) },
                            onThisMac: connectThisMac
                        )
                        .modifier(Entrance(appeared: appeared, delay: 0.08))

                        #if os(macOS)
                        if let error = store.thisMacError {
                            Label(error, systemImage: "exclamationmark.triangle.fill")
                                .font(.footnote)
                                .foregroundStyle(.orange)
                                .padding(.top, 12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        #endif

                        Text("Already have an engine? Open Settings → Devices & sync there and choose Pair a phone or Mac.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 20)
                            .modifier(Entrance(appeared: appeared, delay: 0.14))

                        Spacer(minLength: 32)

                        Label("Your workspace stays on your engines. Your chosen model provider processes the requests you send.", systemImage: "lock.shield")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.bottom, 12)
                    }
                    .padding(.horizontal, 24)
                    .frame(maxWidth: 460)
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .onAppear {
            withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .smooth(duration: 0.6)) { appeared = true }
        }
    }

    private var header: some View {
        VStack(spacing: 14) {
            BrandMark(size: 80)
                .scaleEffect(appeared || reduceMotion ? 1 : 0.86)
                .padding(.bottom, 8)
            Text("A little team for your everyday work.")
                .font(.largeTitle.weight(.bold))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text("Tupies gives your AI bots a home: their own chats, memory and files. Start with Chief of Staff for your goals and Ops to help set up your team.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            #if os(macOS)
            Text("1. Start your engine   ·   2. Connect a model   ·   3. Meet your team")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            #else
            Text("Your bots run on a Mac or server. Pair this device to bring your team with you.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            #endif
        }
    }

    private func connectThisMac() {
        #if os(macOS)
        Task {
            do {
                try await store.connectThisMac()
            } catch {
                if case LocalEngineError.notRunning = error {
                    store.thisMacError = nil
                } else {
                    store.thisMacError = error.localizedDescription
                }
                store.beginPairing(.thisMac)
            }
        }
        #endif
    }
}

/// Content rises gently into place the first time the screen appears (a plain fade with Reduce Motion).
private struct Entrance: ViewModifier {
    let appeared: Bool
    let delay: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .opacity(appeared ? 1 : 0)
            .offset(y: appeared || reduceMotion ? 0 : 18)
            .animation(reduceMotion ? .easeOut(duration: 0.2) : .smooth(duration: 0.6).delay(delay), value: appeared)
    }
}
