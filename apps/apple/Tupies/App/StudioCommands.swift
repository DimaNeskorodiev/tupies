import SwiftUI

/// Menu bar commands: ⌘1…⌘9 switch engines, ⌘R reloads, ⌘N adds a connection.
struct StudioCommands: Commands {
    @ObservedObject var store: ConnectionStore

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("Add Connection…") { store.beginPairing(.choose) }
                .keyboardShortcut("n", modifiers: .command)
        }

        CommandMenu("Engine") {
            ForEach(Array(store.connections.prefix(9).enumerated()), id: \.element.id) { index, connection in
                Toggle(isOn: Binding(
                    get: { store.activeID == connection.id },
                    set: { _ in store.activate(connection.id) }
                )) {
                    Text(connection.name)
                }
                .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
            }
            if !store.connections.isEmpty {
                Divider()
            }
            Button("Reload") { store.reloadActive() }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(store.activeConnection == nil)
        }
    }
}
