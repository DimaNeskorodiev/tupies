import SwiftUI

/// "Connect to <name>?" — shows the engine address and short fingerprint before pairing.
struct PairingConfirmView: View {
    @EnvironmentObject private var store: ConnectionStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let link: PairingLink
    let onPaired: () -> Void

    @State private var stage: PairingProgress?
    @State private var error: String?
    @State private var task: Task<Void, Never>?
    @State private var paired = false
    @State private var failures = 0

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                VStack(spacing: 12) {
                    ZStack(alignment: .bottomTrailing) {
                        BrandMark(size: 68)
                        Image(systemName: paired ? "checkmark.circle.fill" : "link.circle.fill")
                            .font(.system(size: 26))
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(.white, paired ? Color.green : Brand.actionFill)
                            .contentTransition(.symbolEffect(.replace))
                            .symbolEffect(.bounce, value: paired)
                            .background(Circle().fill(Brand.base).padding(2))
                            .offset(x: 9, y: 9)
                    }
                    .padding(.bottom, 6)
                    .accessibilityHidden(true)
                    Text(paired ? "Connected to \(link.name)" : "Connect to \(link.name)?")
                        .font(.title2.weight(.bold))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .contentTransition(.opacity)
                        .accessibilityAddTraits(.isHeader)
                    Text("This \(DeviceInfo.kindLabel) will be able to open Tupies on this engine.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.top, 8)

                VStack(spacing: 0) {
                    InfoRow(systemImage: "network", title: "Address", value: link.baseURL.hostLabel)
                    Divider().padding(.leading, 50)
                    InfoRow(
                        systemImage: "checkmark.shield",
                        title: "Security code",
                        value: Fingerprint.short(link.fingerprint),
                        monospaced: true
                    )
                    Divider().padding(.leading, 50)
                    deviceNameRow
                        .font(.callout)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 48)
                }
                .cardSurface()
                .disabled(stage != nil || paired)

                Text("Check that the security code matches the one shown in Tupies.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)

                if link.baseURL.isInsecureRemote {
                    Label("This connection isn’t encrypted. That’s fine on your home network; for anything else use Tailscale or HTTPS.", systemImage: "lock.open")
                        .font(.footnote)
                        .foregroundStyle(Brand.amber)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let error = error {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .transition(.opacity)
                }

                Button(action: connect) {
                    HStack(spacing: 10) {
                        if paired {
                            Image(systemName: "checkmark")
                            Text("Connected")
                        } else if let stage = stage {
                            ProgressView().controlSize(.small).tint(Brand.onAccent)
                            Text(stage.label)
                                .contentTransition(.opacity)
                        } else {
                            Text(error == nil ? "Connect" : "Try Again")
                        }
                    }
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
                    .animation(.snappy, value: stage)
                }
                .primaryActionStyle()
                .disabled(stage != nil || paired)
                .modifier(Shake(trigger: failures, enabled: !reduceMotion))
                .keyboardShortcut(.defaultAction)
            }
            .padding(24)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
            .animation(.snappy, value: error)
            .animation(.smooth, value: paired)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(AmbientBackground())
        .navigationTitle("Confirm")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .sensoryFeedback(.success, trigger: paired) { _, new in new }
        .sensoryFeedback(.error, trigger: failures)
        .onDisappear { task?.cancel() }
    }

    @ViewBuilder
    private var deviceNameRow: some View {
        let field = TextField("Name", text: $store.deviceName)
            .textFieldStyle(.plain)
            .submitLabel(.done)
            .accessibilityLabel("Device name")
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 4) {
                Text("Device name").foregroundStyle(.secondary)
                field
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 10)
        } else {
            HStack(spacing: 12) {
                Image(systemName: DeviceInfo.platform == "ios" ? "iphone" : "laptopcomputer")
                    .frame(width: 26)
                    .foregroundStyle(Brand.purple)
                    .accessibilityHidden(true)
                Text("Device name")
                    .foregroundStyle(.secondary)
                Spacer(minLength: 12)
                field
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 220)
            }
        }
    }

    private func connect() {
        error = nil
        stage = .verifying
        task = Task {
            do {
                try await store.pair(link, progress: { stage = $0 })
                stage = nil
                paired = true
                // Let the check land before the sheet goes away.
                try? await Task.sleep(nanoseconds: reduceMotion ? 350_000_000 : 750_000_000)
                onPaired()
            } catch is CancellationError {
                stage = nil
            } catch {
                stage = nil
                self.error = error.localizedDescription
                failures += 1
            }
        }
    }
}

struct InfoRow: View {
    let systemImage: String
    let title: String
    let value: String
    var monospaced = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Group {
            // At accessibility sizes the value gets its own line and is never cut short: the security code must be
            // readable in full to compare it.
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    Label {
                        Text(title).foregroundStyle(.secondary)
                    } icon: {
                        Image(systemName: systemImage).foregroundStyle(Brand.purple)
                    }
                    valueText
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 10)
            } else {
                HStack(spacing: 12) {
                    Image(systemName: systemImage)
                        .frame(width: 26)
                        .foregroundStyle(Brand.purple)
                        .accessibilityHidden(true)
                    Text(title)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 12)
                    valueText
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .frame(minHeight: 48)
            }
        }
        .font(.callout)
        .padding(.horizontal, 14)
        .accessibilityElement(children: .combine)
    }

    private var valueText: some View {
        Text(value)
            .font(monospaced ? .callout.monospaced().weight(.semibold) : .callout.weight(.medium))
            .textSelection(.enabled)
    }
}
