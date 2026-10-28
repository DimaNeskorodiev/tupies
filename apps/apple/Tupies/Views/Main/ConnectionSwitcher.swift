import SwiftUI

extension ConnectionStore {
    /// Status dot color for a connection (combines probes and the web view state).
    func statusColor(for connection: Connection) -> Color {
        if let session = webSessionIfLoaded(connection.id), session.phase.isError {
            return .red
        }
        return reachabilityState(for: connection.id).color
    }

    func statusLabel(for connection: Connection) -> String {
        if let session = webSessionIfLoaded(connection.id) {
            switch session.phase {
            case .unreachable: return "Offline"
            case .revoked: return "Needs pairing"
            case .failed: return "Error"
            default: break
            }
        }
        return reachabilityState(for: connection.id).label
    }
}

#if os(macOS)
/// macOS toolbar: engine switcher (center), sync, reload, add, settings.
struct MacToolbar: ToolbarContent {
    @EnvironmentObject private var store: ConnectionStore

    var body: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            MacConnectionSwitcher()
        }
        ToolbarItemGroup(placement: .primaryAction) {
            if let connection = store.activeConnection {
                SyncIndicatorButton(connection: connection)
            }
            Button {
                store.reloadActive()
            } label: {
                Label("Reload", systemImage: "arrow.clockwise")
            }
            .help("Reload (⌘R)")
            Button {
                store.beginPairing(.choose)
            } label: {
                Label("Add Connection", systemImage: "plus")
            }
            .help("Add a Tupies engine")
            SettingsLink {
                Label("Settings", systemImage: "gearshape")
            }
            .help("Settings (⌘,)")
        }
    }
}

/// Segmented switcher with status dots; collapses into a menu above three engines.
struct MacConnectionSwitcher: View {
    @EnvironmentObject private var store: ConnectionStore

    var body: some View {
        if store.connections.count > 3 {
            Menu {
                ForEach(Array(store.connections.enumerated()), id: \.element.id) { index, connection in
                    Button {
                        store.activate(connection.id)
                    } label: {
                        Text(index < 9 ? "\(connection.name)  ⌘\(index + 1)" : connection.name)
                    }
                }
            } label: {
                if let active = store.activeConnection {
                    HStack(spacing: 7) {
                        StatusDot(color: store.statusColor(for: active))
                        Text(active.name)
                            .fontWeight(.medium)
                    }
                }
            }
            .menuStyle(.button)
            .fixedSize()
        } else if store.connections.count > 1 {
            HStack(spacing: 2) {
                ForEach(Array(store.connections.enumerated()), id: \.element.id) { index, connection in
                    let selected = connection.id == store.activeID
                    Button {
                        store.activate(connection.id)
                    } label: {
                        HStack(spacing: 7) {
                            StatusDot(color: store.statusColor(for: connection), size: 7)
                            Text(connection.name)
                                .lineLimit(1)
                                .fontWeight(selected ? .semibold : .regular)
                        }
                        .padding(.horizontal, 12)
                        .frame(height: 24)
                        .background {
                            if selected {
                                Capsule().fill(Color.primary.opacity(0.1))
                            }
                        }
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .help("\(connection.name) — \(store.statusLabel(for: connection)) (⌘\(index + 1))")
                }
            }
            .padding(3)
            .background(Capsule().fill(Color.primary.opacity(0.04)))
            .animation(.easeInOut(duration: 0.15), value: store.activeID)
        } else if let active = store.activeConnection {
            HStack(spacing: 7) {
                StatusDot(color: store.statusColor(for: active))
                Text(active.name)
                    .fontWeight(.semibold)
            }
            .padding(.horizontal, 10)
            .help("\(active.hostLabel) — \(store.statusLabel(for: active))")
        }
    }
}
#else
/// iOS: a compact glass capsule at the top that opens the engine menu.
struct PhoneTopBar: View {
    @EnvironmentObject private var store: ConnectionStore

    var body: some View {
        HStack(spacing: 8) {
            if let active = store.activeConnection {
                Menu {
                    Section("Engines") {
                        ForEach(store.connections) { connection in
                            Button {
                                store.activate(connection.id)
                            } label: {
                                if connection.id == store.activeID {
                                    Label(connection.name, systemImage: "checkmark")
                                } else {
                                    Text(connection.name)
                                }
                                Text("\(store.statusLabel(for: connection)) · \(connection.hostLabel)")
                            }
                        }
                    }
                    Section {
                        Button("Add Connection", systemImage: "plus") { store.beginPairing(.choose) }
                        Button("Reload", systemImage: "arrow.clockwise") { store.reloadActive() }
                        Button("Settings", systemImage: "gearshape") { store.showSettings = true }
                    }
                } label: {
                    HStack(spacing: 7) {
                        StatusDot(color: store.statusColor(for: active))
                        Text(active.name)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                            .foregroundStyle(Brand.ink)
                        Image(systemName: "chevron.down")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Brand.muted)
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .glassSurface(Capsule(), interactive: true)
                }
                .accessibilityLabel("Engine: \(active.name), \(store.statusLabel(for: active))")
                .accessibilityHint("Switch engine, add a connection or open settings")

                SyncIndicatorButton(connection: active)
                    .frame(width: 44, height: 44)
                    .glassSurface(Circle(), interactive: true)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 2)
        .padding(.bottom, 6)
        .background(Brand.canvas.ignoresSafeArea(edges: .top))
    }
}
#endif
