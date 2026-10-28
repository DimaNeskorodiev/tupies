import SwiftUI

/// "Connect to <name>?" — shows the engine address and short fingerprint before pairing.
struct PairingConfirmView: View {
    @EnvironmentObject private var store: ConnectionStore
    let link: PairingLink
    let onPaired: () -> Void

    @State private var stage: PairingProgress?
    @State private var error: String?
    @State private var task: Task<Void, Never>?

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                VStack(spacing: 12) {
                    ZStack(alignment: .bottomTrailing) {
                        BrandMark(size: 64)
                        Image(systemName: "link.circle.fill")
                            .font(.system(size: 24))
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(.white, Brand.purple)
                            .offset(x: 8, y: 8)
                    }
                    .padding(.bottom, 4)
                    Text("Connect to \(link.name)?")
                        .font(.title2.weight(.bold))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("This \(DeviceInfo.kindLabel) will be able to open Tupies on this engine.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.top, 8)

                VStack(spacing: 0) {
                    InfoRow(systemImage: "network", title: "Address", value: link.baseURL.hostLabel)
                    Divider().padding(.leading, 48)
                    InfoRow(
                        systemImage: "checkmark.shield",
                        title: "Security code",
                        value: Fingerprint.short(link.fingerprint),
                        monospaced: true
                    )
                    Divider().padding(.leading, 48)
                    HStack(spacing: 12) {
                        Image(systemName: DeviceInfo.platform == "ios" ? "iphone" : "laptopcomputer")
                            .frame(width: 24)
                            .foregroundStyle(Brand.purple)
                        Text("Device name")
                            .foregroundStyle(.secondary)
                        Spacer()
                        TextField("Name", text: $store.deviceName)
                            .multilineTextAlignment(.trailing)
                            .textFieldStyle(.plain)
                            .frame(maxWidth: 200)
                    }
                    .font(.callout)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                }
                .cardSurface()

                Text("Check that the security code matches the one shown in Tupies.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                if link.baseURL.isInsecureRemote {
                    Label("This connection isn’t encrypted. That’s fine on your home network; for anything else use Tailscale or HTTPS.", systemImage: "lock.open")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let error = error {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Button(action: connect) {
                    HStack(spacing: 10) {
                        if let stage = stage {
                            ProgressView().controlSize(.small).tint(.white)
                            Text(stage.label)
                        } else {
                            Text(error == nil ? "Connect" : "Try Again")
                        }
                    }
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(stage != nil)
                .keyboardShortcut(.defaultAction)
            }
            .padding(24)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .background(AmbientBackground())
        .navigationTitle("Confirm")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .onDisappear { task?.cancel() }
    }

    private func connect() {
        error = nil
        stage = .verifying
        task = Task {
            do {
                try await store.pair(link, progress: { stage = $0 })
                stage = nil
                #if os(iOS)
                StudioHaptics.play("success")
                #endif
                onPaired()
            } catch is CancellationError {
                stage = nil
            } catch {
                stage = nil
                self.error = error.localizedDescription
                #if os(iOS)
                StudioHaptics.play("warning")
                #endif
            }
        }
    }
}

struct InfoRow: View {
    let systemImage: String
    let title: String
    let value: String
    var monospaced = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .frame(width: 24)
                .foregroundStyle(Brand.purple)
            Text(title)
                .foregroundStyle(.secondary)
            Spacer(minLength: 12)
            Text(value)
                .font(monospaced ? .callout.monospaced().weight(.semibold) : .callout.weight(.medium))
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
        }
        .font(.callout)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }
}
