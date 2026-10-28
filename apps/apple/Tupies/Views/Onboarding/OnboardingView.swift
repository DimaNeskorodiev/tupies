import SwiftUI

/// First-run welcome: "Connect to your Tupies".
struct OnboardingView: View {
    @EnvironmentObject private var store: ConnectionStore

    var body: some View {
        ZStack {
            AmbientBackground()

            GeometryReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        Spacer(minLength: 24)

                        header
                            .padding(.bottom, 36)

                        ConnectChoices(
                            onScan: { store.beginPairing(.scan) },
                            onPaste: { store.beginPairing(.paste) },
                            onThisMac: connectThisMac
                        )

                        #if os(macOS)
                        if let error = store.thisMacError {
                            Label(error, systemImage: "exclamationmark.triangle.fill")
                                .font(.footnote)
                                .foregroundStyle(.orange)
                                .padding(.top, 12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        #endif

                        Text("In Tupies, open Devices & sync and choose Pair a phone or Mac — it shows a QR code and a pairing link.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.top, 20)

                        Spacer(minLength: 32)

                        Label("Your data stays on your engines. Device keys never leave this device.", systemImage: "lock.shield")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.bottom, 12)
                    }
                    .padding(.horizontal, 24)
                    .frame(maxWidth: 460)
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
    }

    private var header: some View {
        VStack(spacing: 14) {
            BrandMark(size: 76)
                .padding(.bottom, 6)
            Text("Tupies")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Brand.purple)
                .textCase(.uppercase)
                .tracking(1.2)
            Text("Connect to your Tupies")
                .font(.system(.largeTitle, design: .default).weight(.bold))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Text("Tupies runs on your own Mac or server. Pair this \(DeviceInfo.kindLabel) once and it stays signed in securely.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
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
