#if os(iOS)
import SwiftUI

struct NotificationSettingsSection: View {
    @EnvironmentObject private var store: ConnectionStore
    @ObservedObject private var notifications = NotificationCoordinator.shared

    var body: some View {
        Section {
            Toggle(isOn: Binding(
                get: { notifications.enabled },
                set: { value in
                    if value { Task { await notifications.enable() } }
                    else { notifications.disable() }
                }
            )) {
                Label {
                    Text("Notifications")
                } icon: {
                    Image(systemName: notifications.enabled ? "bell.badge.fill" : "bell")
                        .contentTransition(.symbolEffect(.replace))
                }
            }
            .disabled(notifications.busy || store.connections.isEmpty)

            if notifications.enabled {
                Toggle("Bot replies", isOn: Binding(get: { notifications.botReplies }, set: notifications.setBotReplies))
                Toggle("Routine results", isOn: Binding(get: { notifications.routines }, set: notifications.setRoutines))
                Picker("Delivery engine", selection: Binding(
                    get: { notifications.connectionID },
                    set: { if let id = $0 { notifications.selectConnection(id) } }
                )) {
                    ForEach(store.connections) { connection in
                        Text(connection.name).tag(Optional(connection.id))
                    }
                }
                Button("Check notification delivery") { Task { await notifications.refresh() } }
                    .disabled(notifications.busy)
            }
            if notifications.authorization == .denied {
                Button("Allow in iPhone Settings", systemImage: "arrow.up.forward.app") { notifications.openSystemSettings() }
            }
            Text(notifications.status)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        } header: {
            Text("Notifications")
        } footer: {
            Text("Bot replies and routine results, even while Tupies is closed. Pick one delivery server to avoid duplicates. Apple only sees a generic alert; message content stays on your server.")
        }
        .animation(.snappy, value: notifications.enabled)
        .task { await notifications.refresh() }
    }
}
#endif
