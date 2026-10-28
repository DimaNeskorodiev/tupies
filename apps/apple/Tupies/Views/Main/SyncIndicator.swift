import SwiftUI

/// Small sync-health icon; tapping shows `GET /api/sync/status` in a popover.
struct SyncIndicatorButton: View {
    @EnvironmentObject private var store: ConnectionStore
    let connection: Connection
    @State private var showing = false

    private var snapshot: SyncSnapshot? { store.sync[connection.id] }
    private var health: SyncHealth { snapshot?.health ?? .unknown }

    var body: some View {
        Button {
            showing.toggle()
            Task { await store.refreshSync(connection.id) }
        } label: {
            Image(systemName: health.symbol)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(health.color)
                .symbolEffect(.pulse, isActive: health == .syncing)
                .frame(minWidth: 24, minHeight: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(health.label)
        .accessibilityLabel("Sync status: \(health.label)")
        #if os(iOS)
        .sheet(isPresented: $showing) {
            NavigationStack {
                ScrollView {
                    SyncStatusView(connection: connection)
                }
                .navigationTitle("Sync")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { showing = false }
                    }
                }
            }
            .environmentObject(store)
            .presentationDetents([.medium, .large])
        }
        #else
        .popover(isPresented: $showing, arrowEdge: .bottom) {
            SyncStatusView(connection: connection)
                .environmentObject(store)
        }
        #endif
    }
}

struct SyncStatusView: View {
    @EnvironmentObject private var store: ConnectionStore
    let connection: Connection

    private var snapshot: SyncSnapshot? { store.sync[connection.id] }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                StatusDot(color: (snapshot?.health ?? .unknown).color, size: 10)
                VStack(alignment: .leading, spacing: 1) {
                    Text((snapshot?.health ?? .unknown).label)
                        .font(.headline)
                    Text(connection.name)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    Task { await store.refreshSync(connection.id) }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Refresh")
            }

            if let message = snapshot?.message {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(snapshot?.health == .unsupported ? Color.secondary : Color.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let status = snapshot?.status {
                Divider()
                if let node = status.node {
                    detailRow("This engine", value: [node.name, node.role.map(roleLabel)].compactMap { $0 }.joined(separator: " · "))
                }
                if let hub = status.hub {
                    detailRow("Hub", value: hub.name ?? hub.url ?? "Hub")
                    detailRow("Connection", value: hub.connected == true ? "Connected" : "Disconnected")
                    if let last = ISODate.parse(hub.lastSyncAt) {
                        HStack {
                            Text("Last sync").foregroundStyle(.secondary)
                            Spacer()
                            Text(last, style: .relative) + Text(" ago")
                        }
                        .font(.callout)
                    }
                }
                detailRow("Pending changes", value: "\(status.pending ?? 0)")

                if let engines = status.engines, !engines.isEmpty {
                    Divider()
                    Text("Engines")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                    ForEach(engines) { engine in
                        HStack(spacing: 8) {
                            StatusDot(color: engine.online == true ? .green : .gray, size: 7)
                            Text(engine.name ?? engine.url ?? "Engine")
                                .lineLimit(1)
                            if let role = engine.role {
                                Text(roleLabel(role))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if engine.online != true, let seen = ISODate.parse(engine.lastSeenAt) {
                                Text(seen, style: .relative)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .font(.callout)
                    }
                }
            } else if snapshot == nil {
                HStack {
                    ProgressView().controlSize(.small)
                    Text("Checking…").foregroundStyle(.secondary)
                }
                .font(.callout)
            }
        }
        .padding(16)
        #if os(macOS)
        .frame(width: 300)
        #else
        .padding(.horizontal, 4)
        #endif
    }

    private func detailRow(_ title: String, value: String) -> some View {
        HStack {
            Text(title).foregroundStyle(.secondary)
            Spacer()
            Text(value).lineLimit(1)
        }
        .font(.callout)
    }

    private func roleLabel(_ role: String) -> String {
        switch role {
        case "hub": return "Hub"
        case "replica": return "Replica"
        case "standalone": return "Standalone"
        default: return role.capitalized
        }
    }
}
