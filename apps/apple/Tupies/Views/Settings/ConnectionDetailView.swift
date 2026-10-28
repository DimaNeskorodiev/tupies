import SwiftUI

/// Rename, inspect and remove one connection.
struct ConnectionDetailView: View {
    @EnvironmentObject private var store: ConnectionStore
    @Environment(\.dismiss) private var dismiss
    let connectionID: UUID

    @State private var name = ""
    @State private var confirmRemove = false

    var body: some View {
        Group {
            if let connection = store.connection(connectionID) {
                Form {
                    Section("Name") {
                        TextField("Name", text: $name)
                            .onSubmit { store.rename(connectionID, to: name) }
                    }

                    Section("Engine") {
                        LabeledContent("Status") {
                            HStack(spacing: 6) {
                                StatusDot(color: store.statusColor(for: connection), size: 7)
                                Text(store.statusLabel(for: connection))
                            }
                        }
                        LabeledContent("Address", value: connection.baseURL.absoluteString)
                        LabeledContent("Type", value: connection.kind == .local ? "This Mac" : "Remote")
                        LabeledContent("Security code") {
                            Text(connection.shortFingerprint)
                                .font(.body.monospaced())
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Fingerprint")
                            Text(Fingerprint.grouped(connection.fingerprint))
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    Section("This Device") {
                        LabeledContent("Device ID") {
                            Text(connection.deviceId)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                        }
                        LabeledContent("Device key", value: store.deviceKeyDescription(for: connection.id))
                        LabeledContent("Paired") {
                            Text(connection.addedAt, format: .dateTime.year().month().day().hour().minute())
                        }
                    }

                    Section {
                        if connection.id != store.activeID {
                            Button("Switch to \(connection.name)") { store.activate(connection.id) }
                        }
                        Button("Remove Connection", role: .destructive) { confirmRemove = true }
                    }
                }
                .formStyle(.grouped)
                #if os(iOS)
                .scrollDismissesKeyboard(.interactively)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .navigationTitle(connection.name)
                .onAppear { name = connection.name }
                .onDisappear { store.rename(connectionID, to: name) }
                .confirmationDialog("Remove \(connection.name)?", isPresented: $confirmRemove, titleVisibility: .visible) {
                    Button("Remove Connection", role: .destructive) {
                        store.remove(connectionID)
                        dismiss()
                    }
                } message: {
                    Text("This device’s key for \(connection.name) will be deleted. To use it again, pair with a new code from Tupies. You can also remove this device in Tupies’s device list.")
                }
            } else {
                Text("This connection was removed.")
                    .foregroundStyle(.secondary)
            }
        }
    }
}
