import SwiftUI
#if os(macOS)
import AppKit
#endif

/// Paste a `hermes-studio://pair?…` link.
struct PasteLinkView: View {
    let onLink: (PairingLink) -> Void
    @State private var text = ""
    @State private var error: String?
    @State private var failures = 0
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The link as typed so far, when it is already a valid pairing link.
    private var parsed: PairingLink? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return try? PairingLink.parse(trimmed)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Paste pairing link")
                        .font(.title2.weight(.bold))
                        .accessibilityAddTraits(.isHeader)
                    Text("In Tupies, open Devices & sync → Pair a phone or Mac and copy the pairing link.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(alignment: .leading, spacing: 10) {
                    TextField("Pairing link", text: $text, axis: .vertical)
                        .lineLimit(3...6)
                        .font(.callout.monospaced())
                        // The link is an opaque code; keep it to a few lines so Continue stays in reach at large sizes.
                        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
                        .textFieldStyle(.plain)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        #endif
                        .submitLabel(.continue)
                        .focused($focused)
                        .onSubmit(submit)
                        .onChange(of: text) { _, newValue in
                            error = nil
                            // A multi-line field turns Return into a newline; treat it as Continue instead.
                            if newValue.contains("\n") {
                                text = newValue.replacingOccurrences(of: "\n", with: "")
                                submit()
                            }
                        }
                        .padding(14)
                        .cardSurface(cornerRadius: 18)
                        .overlay {
                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .strokeBorder(error != nil ? Color.red.opacity(0.7) : (parsed != nil ? Color.green.opacity(0.6) : .clear), lineWidth: 1.5)
                        }
                        .modifier(Shake(trigger: failures, enabled: !reduceMotion))
                        .accessibilityLabel("Pairing link")

                    HStack(spacing: 12) {
                        PasteButton(payloadType: String.self) { strings in
                            if let first = strings.first {
                                text = first.trimmingCharacters(in: .whitespacesAndNewlines)
                                error = nil
                            }
                        }
                        .labelStyle(.titleAndIcon)
                        #if os(iOS)
                        .buttonBorderShape(.capsule)
                        #endif
                        Spacer(minLength: 0)
                        if let link = parsed {
                            Label {
                                Text(link.name)
                                    .foregroundStyle(.secondary)
                            } icon: {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.green)
                                    .symbolEffect(.bounce, value: link.id)
                            }
                                .font(.footnote.weight(.medium))
                                .lineLimit(1)
                                .transition(.opacity.combined(with: .scale(scale: 0.9)))
                                .accessibilityLabel("Valid link for \(link.name)")
                        }
                    }
                    .animation(.snappy, value: parsed?.id)
                }

                if let error = error {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .transition(.opacity)
                }

                Button(action: submit) {
                    Text("Continue")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                }
                .primaryActionStyle()
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .keyboardShortcut(.defaultAction)
            }
            .padding(24)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
            .animation(.snappy, value: error)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(AmbientBackground())
        .navigationTitle("Pairing Link")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .sensoryFeedback(.error, trigger: failures)
        .onAppear(perform: prefillFromPasteboard)
    }

    private func submit() {
        do {
            let link = try PairingLink.parse(text)
            error = nil
            onLink(link)
        } catch {
            self.error = error.localizedDescription
            failures += 1
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

/// A short horizontal shake when something is rejected.
struct Shake: ViewModifier {
    let trigger: Int
    var enabled = true

    func body(content: Content) -> some View {
        if enabled {
            content.keyframeAnimator(initialValue: 0.0, trigger: trigger) { view, offset in
                view.offset(x: offset)
            } keyframes: { _ in
                KeyframeTrack {
                    SpringKeyframe(-9, duration: 0.07)
                    SpringKeyframe(8, duration: 0.08)
                    SpringKeyframe(-5, duration: 0.08)
                    SpringKeyframe(0, duration: 0.12)
                }
            }
        } else {
            content
        }
    }
}
