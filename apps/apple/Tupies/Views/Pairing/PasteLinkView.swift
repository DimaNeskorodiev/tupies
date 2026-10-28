import SwiftUI
#if os(macOS)
import AppKit
#endif

/// Paste a `hermes-studio://pair?…` link.
struct PasteLinkView: View {
    let onLink: (PairingLink) -> Void
    @State private var text = ""
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Paste pairing link")
                        .font(.title2.weight(.bold))
                    Text("In Tupies, open Devices & sync → Pair a phone or Mac and copy the pairing link. It starts with hermes-studio://pair.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(alignment: .leading, spacing: 10) {
                    TextField("hermes-studio://pair?…", text: $text, axis: .vertical)
                        .lineLimit(3...6)
                        .font(.callout.monospaced())
                        .textFieldStyle(.plain)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        #endif
                        .focused($focused)
                        .onSubmit(submit)
                        .padding(14)
                        .cardSurface(cornerRadius: 16)

                    HStack {
                        PasteButton(payloadType: String.self) { strings in
                            if let first = strings.first {
                                text = first
                                error = nil
                            }
                        }
                        .labelStyle(.titleAndIcon)
                        #if os(iOS)
                        .buttonBorderShape(.capsule)
                        #endif
                        Spacer()
                    }
                }

                if let error = error {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button(action: submit) {
                    Text("Continue")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .keyboardShortcut(.defaultAction)
            }
            .padding(24)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .background(AmbientBackground())
        .navigationTitle("Pairing Link")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .onAppear(perform: prefillFromPasteboard)
    }

    private func submit() {
        do {
            let link = try PairingLink.parse(text)
            error = nil
            onLink(link)
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// On the Mac reading the pasteboard is silent, so prefill a copied link.
    private func prefillFromPasteboard() {
        #if os(macOS)
        if text.isEmpty, let string = NSPasteboard.general.string(forType: .string),
           PairingLink.extract(from: string) != nil {
            text = string.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        #endif
        focused = true
    }
}
