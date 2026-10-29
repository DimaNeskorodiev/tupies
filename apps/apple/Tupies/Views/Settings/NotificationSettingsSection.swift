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
                Button("Preview and Lock Screen settings", systemImage: "arrow.up.forward.app") { notifications.openSystemSettings() }
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
            Text("Replies you read in an active chat stay quiet on your other devices. Alerts include the bot’s name and a short preview through Apple Push Notifications. Choose When Unlocked in iPhone notification settings to hide previews on the Lock Screen.")
        }
        .animation(.snappy, value: notifications.enabled)
        .task { await notifications.refresh() }
    }
}
#endif
