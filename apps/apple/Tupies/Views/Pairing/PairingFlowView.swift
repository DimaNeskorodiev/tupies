import SwiftUI

/// The pairing sheet: choose → scan/paste → confirm, or straight to confirm for opened links.
struct PairingFlowView: View {
    @EnvironmentObject private var store: ConnectionStore
    @Environment(\.dismiss) private var dismiss
    let start: PairingStep
    @State private var path: [PairingStep] = []

    var body: some View {
        NavigationStack(path: $path) {
            screen(for: start, isRoot: true)
                .navigationDestination(for: PairingStep.self) { step in
                    screen(for: step, isRoot: false)
                }
        }
        #if os(macOS)
        .frame(minWidth: 480, idealWidth: 500, minHeight: 560, idealHeight: 600)
        #else
        .sensoryFeedback(.selection, trigger: path)
        #endif
    }

    @ViewBuilder
    private func screen(for step: PairingStep, isRoot: Bool) -> some View {
        Group {
            switch step {
            case .choose:
                AddConnectionView(
                    onScan: { path.append(.scan) },
                    onPaste: { path.append(.paste) },
                    onThisMac: thisMac
                )
            case .scan:
                #if os(iOS)
                QRScannerScreen(
                    onLink: { path.append(.confirm($0)) },
                    onPasteInstead: { path.append(.paste) }
                )
                #else
                PasteLinkView(onLink: { path.append(.confirm($0)) })
                #endif
            case .paste:
                PasteLinkView(onLink: { path.append(.confirm($0)) })
            case .confirm(let link):
                PairingConfirmView(link: link, onPaired: { dismiss() })
            #if os(macOS)
            case .thisMac:
                ThisMacSetupView(onPaired: { dismiss() })
            #endif
            }
        }
        .toolbar {
            if isRoot {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func thisMac() {
        #if os(macOS)
        Task {
            do {
                try await store.connectThisMac()
                dismiss()
            } catch {
                if case LocalEngineError.notRunning = error {
                    store.thisMacError = nil
                } else {
                    store.thisMacError = error.localizedDescription
                }
                path.append(.thisMac)
            }
        }
        #endif
    }
}

/// Root of the "Add connection" sheet.
struct AddConnectionView: View {
    var onScan: () -> Void
    var onPaste: () -> Void
    var onThisMac: () -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                VStack(spacing: 10) {
                    BrandMark(size: 56)
                    Text("Add a Tupies")
                        .font(.title2.weight(.bold))
                    Text("Pair this \(DeviceInfo.kindLabel) with another Tupies engine. You can switch between engines at any time.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.top, 12)

                ConnectChoices(onScan: onScan, onPaste: onPaste, onThisMac: onThisMac)
            }
            .padding(24)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .background(AmbientBackground())
        .navigationTitle("Add Connection")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}
