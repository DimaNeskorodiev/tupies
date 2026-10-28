import SwiftUI

/// Connections management, this device, the Mac's local engine, and About.
struct SettingsView: View {
    @EnvironmentObject private var store: ConnectionStore
    #if os(macOS)
    @EnvironmentObject private var local: LocalEngineController
    @Environment(\.openWindow) private var openWindow
    @State private var showLog = false
    #endif
    @Environment(\.dismiss) private var dismiss
    #if os(iOS)
    @State private var detailID: UUID?
    #endif

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if store.connections.isEmpty {
                        Text("No servers yet.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(store.connections) { connection in
                        #if os(iOS)
                        // As in Wi-Fi settings: tap a row to switch to it, ⓘ for its details.
                        HStack(spacing: 10) {
                            Button {
                                switchTo(connection.id)
                            } label: {
                                HStack {
                                    ConnectionRow(connection: connection)
                                    Spacer(minLength: 8)
                                    if connection.id == store.activeID {
                                        Image(systemName: "checkmark")
                                            .font(.body.weight(.semibold))
                                            .foregroundStyle(Brand.purple)
                                            .transition(.scale(scale: 0.5).combined(with: .opacity))
                                            .accessibilityHidden(true)
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(connection.id == store.activeID ? .isSelected : [])
                            .accessibilityHint(connection.id == store.activeID ? "" : "Switches to this server")
                            Button {
                                detailID = connection.id
                            } label: {
                                Image(systemName: "info.circle")
                                    .font(.title3)
                                    .foregroundStyle(Brand.purple)
                                    .frame(minWidth: 44, minHeight: 44)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("\(connection.name) details")
                        }
                        #else
                        NavigationLink {
                            ConnectionDetailView(connectionID: connection.id)
                        } label: {
                            ConnectionRow(connection: connection)
                        }
                        #endif
                    }
                    Button {
                        addConnection()
                    } label: {
                        Label("Add Connection", systemImage: "plus.circle.fill")
                    }
                } header: {
                    Text("Servers")
                } footer: {
                    Text("Each server has its own device key. Removing a connection deletes that key from this \(DeviceInfo.kindLabel).")
                }

                #if os(iOS)
                // The sync indicator and Reload used to sit in the bar above the page.
                if let active = store.activeConnection {
                    Section {
                        NavigationLink {
                            ScrollView { SyncStatusView(connection: active) }
                                .navigationTitle("Sync")
                                .navigationBarTitleDisplayMode(.inline)
                        } label: {
                            let health = store.sync[active.id]?.health ?? .unknown
                            LabeledContent {
                                Text(health.label)
                            } label: {
                                Label {
                                    Text("Sync")
                                } icon: {
                                    SyncHealthSymbol(health: health)
                                }
                            }
                        }
                        Button {
                            store.reloadActive()
                            dismiss()
                        } label: {
                            Label("Reload \(active.name)", systemImage: "arrow.clockwise")
                        }
                    } header: {
                        Text(active.name)
                    } footer: {
                        Text("You can also pull down on a page to reload it.")
                    }
                }
                #endif

                #if os(iOS)
                NotificationSettingsSection()
                #endif

                Section {
                    TextField("Device name", text: $store.deviceName)
                        .submitLabel(.done)
                        .accessibilityLabel("Device name")
                } header: {
                    Text("This Device")
                } footer: {
                    Text("Shown in a server’s device list when you pair.")
                }

                #if os(macOS)
                Section {
                    LocalEngineStatusRow()
                        .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))
                    LocalEnginePathsForm()
                    HStack {
                        Button("Show Log") { showLog = true }
                            .disabled(local.logLines.isEmpty)
                        Spacer()
                        if local.ownsProcess && local.isProcessRunning {
                            Button("Stop Engine", role: .destructive) { local.stop() }
                        } else if local.runningURL == nil {
                            Button("Start Local Engine") {
                                Task {
                                    do {
                                        try await local.start(extra: store.localConnection.map { [$0.baseURL] } ?? [])
                                    } catch {
                                        store.alert = AppAlert(title: "Couldn’t start Tupies", message: error.localizedDescription)
                                    }
                                }
                            }
                        }
                        if store.localConnection == nil {
                            Button("Use This Mac…") {
                                openWindow(id: "main")
                                store.beginPairing(.thisMac)
                            }
                        }
                    }
                } header: {
                    Text("Local Engine")
                } footer: {
                    Text("Starts `node --env-file-if-exists=.env server.mjs` in the Tupies folder. An engine started here stops when you quit Tupies; one started elsewhere is never touched.")
                }
                #endif

                Section("About") {
                    LabeledContent("Version", value: DeviceInfo.appVersion)
                    Label {
                        Text("Your data stays on your engines. Device keys never leave this device.")
                    } icon: {
                        Image(systemName: "lock.shield.fill")
                            .foregroundStyle(Brand.purple)
                    }
                    .font(.callout)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Settings")
            #if os(iOS)
            .scrollDismissesKeyboard(.interactively)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    SheetCloseButton { dismiss() }
                }
            }
            .navigationDestination(item: $detailID) { id in
                ConnectionDetailView(connectionID: id)
            }
            .task {
                if let id = store.activeID { await store.refreshSync(id) }
            }
            #endif
        }
        #if os(macOS)
        .frame(minWidth: 560, idealWidth: 600, minHeight: 560, idealHeight: 680)
        .sheet(isPresented: $showLog) {
            LocalEngineLogSheet()
                .environmentObject(local)
        }
        .task { await local.refresh(extra: store.localConnection.map { [$0.baseURL] } ?? []) }
        #endif
    }

    #if os(iOS)
    /// Moves the checkmark first, then closes, so the switch is visible.
    private func switchTo(_ id: UUID) {
        guard id != store.activeID else {
            dismiss()
            return
        }
        withAnimation(.snappy(duration: 0.25)) { store.activate(id) }
        Task {
            try? await Task.sleep(nanoseconds: 320_000_000)
            dismiss()
        }
    }
    #endif

    private func addConnection() {
        #if os(macOS)
        openWindow(id: "main")
        store.beginPairing(.choose)
        #else
        dismiss()
        Task {
            try? await Task.sleep(nanoseconds: 450_000_000)
            store.beginPairing(.choose)
        }
        #endif
    }
}

struct ConnectionRow: View {
    @EnvironmentObject private var store: ConnectionStore
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let connection: Connection

    var body: some View {
        HStack(spacing: 12) {
            // At accessibility sizes the words need the width more than the icon does.
            if !dynamicTypeSize.isAccessibilitySize {
                icon
            }
            details
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var icon: some View {
        Image(systemName: connection.kind == .local ? "desktopcomputer" : "server.rack")
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(.white)
            .frame(width: 34, height: 34)
            .background(LinearGradient(colors: [Brand.slateTop, Brand.slateBottom], startPoint: .top, endPoint: .bottom), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .accessibilityHidden(true)
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(connection.name)
                    .fontWeight(.medium)
                #if os(macOS)
                if connection.id == store.activeID {
                    Text("Active")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Brand.purple.opacity(0.15), in: Capsule())
                        .foregroundStyle(Brand.purple)
                }
                #endif
            }
            HStack(spacing: 5) {
                StatusDot(color: store.statusColor(for: connection), size: 6, pulsing: store.reachabilityState(for: connection.id) == .unknown)
                Text("\(store.statusLabel(for: connection)) · \(connection.hostLabel)")
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                    .truncationMode(.middle)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }
}
