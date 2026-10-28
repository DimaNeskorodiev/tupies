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
                    Section {
                        VStack(spacing: 10) {
                            Image(systemName: connection.kind == .local ? "desktopcomputer" : "server.rack")
                                .font(.system(size: 26, weight: .medium))
                                .foregroundStyle(.white)
                                .frame(width: 60, height: 60)
                                .background(LinearGradient(colors: [Brand.slateTop, Brand.slateBottom], startPoint: .top, endPoint: .bottom), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                                .accessibilityHidden(true)
                            Text(connection.name)
                                .font(.title3.weight(.semibold))
                                .multilineTextAlignment(.center)
                            HStack(spacing: 6) {
                                StatusDot(color: store.statusColor(for: connection), size: 7, pulsing: store.reachabilityState(for: connection.id) == .unknown)
                                Text(connection.id == store.activeID ? "\(store.statusLabel(for: connection)) · On screen" : store.statusLabel(for: connection))
                            }
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .listRowBackground(Color.clear)
                        .accessibilityElement(children: .combine)
                    }

                    Section("Name") {
                        TextField("Name", text: $name)
                            .submitLabel(.done)
                            .onSubmit { store.rename(connectionID, to: name) }
                            .accessibilityLabel("Server name")
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
                            Button {
                                withAnimation(.snappy) { store.activate(connection.id) }
                            } label: {
                                Label("Switch to \(connection.name)", systemImage: "arrow.left.arrow.right")
                            }
                        }
                        Button(role: .destructive) {
                            confirmRemove = true
                        } label: {
                            Label("Remove Connection", systemImage: "trash")
                                .foregroundStyle(.red)
                        }
                    }
                }
                .formStyle(.grouped)
                #if os(iOS)
                .contentMargins(.top, 0, for: .scrollContent)
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
                    Text("This \(DeviceInfo.kindLabel)’s key for \(connection.name) will be deleted. To connect again, pair with a new code from Tupies.")
                }
            } else {
                ContentUnavailableView("Connection removed", systemImage: "server.rack", description: Text("This server is no longer paired with this \(DeviceInfo.kindLabel)."))
            }
        }
    }
}
