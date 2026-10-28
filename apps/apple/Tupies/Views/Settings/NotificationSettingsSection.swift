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
                Label("Notifications", systemImage: "bell.badge")
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
            Text("Receive finished routine results and new bot replies, even while Tupies is closed. Choose one home server to avoid duplicate alerts. Apple receives a generic alert and identifiers; message content stays on your engine.")
        }
        .task { await notifications.refresh() }
    }
}
#endif
