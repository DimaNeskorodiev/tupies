#if os(iOS)
import Combine
import Foundation
import UIKit
import UserNotifications

/// APNs registration and native preferences. Tokens are memory-only, requested fresh each launch,
/// and sent only to a paired engine. Preferences contain no token or message content.
@MainActor
final class NotificationCoordinator: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationCoordinator()
    private enum Keys {
        static let enabled = "hermes.notifications.enabled"
        static let replies = "hermes.notifications.botReplies"
        static let routines = "hermes.notifications.routines"
        static let connection = "hermes.notifications.connection"
        static let registrations = "hermes.notifications.registrations"
    }

    @Published private(set) var enabled: Bool
    @Published private(set) var botReplies: Bool
    @Published private(set) var routines: Bool
    @Published private(set) var connectionID: UUID?
    @Published private(set) var authorization: UNAuthorizationStatus = .notDetermined
    @Published private(set) var status = "Turn on Notifications to get bot replies and routine results."
    @Published private(set) var busy = false

    private weak var store: ConnectionStore?
    private let defaults: UserDefaults
    private let center = UNUserNotificationCenter.current()
    private var deviceToken: String?
    private var authorizationKnown = false
    private var registrations: Set<UUID>
    private var syncTask: Task<Void, Never>?
    private var revision = 0
    private var pendingDestination: NotificationDestination?
    private var observers: Set<AnyCancellable> = []

    override private init() {
        let defaults = UserDefaults.standard
        self.defaults = defaults
        enabled = defaults.bool(forKey: Keys.enabled)
        botReplies = defaults.object(forKey: Keys.replies) as? Bool ?? true
        routines = defaults.object(forKey: Keys.routines) as? Bool ?? true
        connectionID = defaults.string(forKey: Keys.connection).flatMap(UUID.init(uuidString:))
        registrations = Set((defaults.stringArray(forKey: Keys.registrations) ?? []).compactMap(UUID.init(uuidString:)))
        super.init()
    }

    func prepare() { center.delegate = self }

    func attach(_ store: ConnectionStore) {
        guard self.store !== store else { return }
        self.store = store
        observers.removeAll()
        store.$connections.dropFirst().sink { [weak self] _ in
            Task { @MainActor in self?.connectionsChanged() }
        }.store(in: &observers)
        connectionsChanged()
        if let destination = pendingDestination { open(destination) }
        Task { await refresh() }
    }

    func refresh() async {
        authorization = await center.notificationSettings().authorizationStatus
        authorizationKnown = true
        if enabled {
            guard authorized else {
                status = "Notifications are off in iPhone Settings."
                queueSynchronization()
                return
            }
            status = deviceToken == nil ? "Connecting to Apple notifications…" : "Checking notification delivery…"
            UIApplication.shared.registerForRemoteNotifications()
        }
        queueSynchronization()
    }

    var authorized: Bool { [.authorized, .provisional, .ephemeral].contains(authorization) }

    func enable() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let allowed = try await center.requestAuthorization(options: [.alert, .sound])
            authorization = await center.notificationSettings().authorizationStatus
            authorizationKnown = true
            guard allowed, authorized else { status = "Notifications are off in iPhone Settings."; return }
            enabled = true; defaults.set(true, forKey: Keys.enabled)
            chooseConnectionIfNeeded()
            status = "Connecting to Apple notifications…"
            UIApplication.shared.registerForRemoteNotifications()
            queueSynchronization()
        } catch { status = "Couldn’t ask iOS for notification permission. Try again." }
    }

    func disable() {
        enabled = false; defaults.set(false, forKey: Keys.enabled)
        deviceToken = nil
        UIApplication.shared.unregisterForRemoteNotifications()
        center.removeAllDeliveredNotifications()
        status = "Notifications are off."
        queueSynchronization()
    }

    func setBotReplies(_ value: Bool) { botReplies = value; defaults.set(value, forKey: Keys.replies); queueSynchronization() }
    func setRoutines(_ value: Bool) { routines = value; defaults.set(value, forKey: Keys.routines); queueSynchronization() }
    func selectConnection(_ id: UUID) {
        guard store?.connection(id) != nil else { return }
        connectionID = id; defaults.set(id.uuidString, forKey: Keys.connection)
        queueSynchronization()
    }

    func didRegister(_ data: Data) {
        // APNs tokens are opaque; do not log them or assume a fixed byte length.
        guard !data.isEmpty else { return }
        deviceToken = data.map { String(format: "%02x", $0) }.joined()
        queueSynchronization()
    }

    func didFailRegistration() {
        deviceToken = nil
        status = "Apple notification registration is unavailable. Check signing and the Push Notifications capability, then try again."
    }

    func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    private func connectionsChanged() {
        guard let store else { return }
        let known = Set(store.connections.map(\.id))
        registrations.formIntersection(known)
        saveRegistrations()
        chooseConnectionIfNeeded()
        queueSynchronization()
    }

    private func chooseConnectionIfNeeded() {
        guard let store, connectionID.flatMap(store.connection) == nil else { return }
        let hub = store.connections.first { store.sync[$0.id]?.status?.node?.role == "hub" }
        let selected = hub ?? store.activeConnection ?? store.connections.first
        connectionID = selected?.id
        defaults.set(selected?.id.uuidString, forKey: Keys.connection)
    }

    private func saveRegistrations() { defaults.set(registrations.map(\.uuidString).sorted(), forKey: Keys.registrations) }

    /// Serialize state changes: a late PUT cannot re-enable delivery after its DELETE.
    private func queueSynchronization() {
        revision += 1
        guard syncTask == nil, store != nil else { return }
        syncTask = Task { [weak self] in
            guard let self else { return }
            while true {
                let version = self.revision
                await self.synchronize()
                if self.revision == version { break }
            }
            self.syncTask = nil
        }
    }

    private func synchronize() async {
        guard let store else { return }
        guard !enabled || authorizationKnown else { return }
        let selected = enabled && authorized ? connectionID : nil
        // Keep failed removals for a future foreground retry instead of silently forgetting them.
        for id in registrations where id != selected {
            do {
                try await store.authorized(id) { client, token in try await client.removeNotifications(token: token) }
                registrations.remove(id); saveRegistrations()
            } catch { /* Retry while the engine is reachable again. */ }
        }
        guard enabled, authorized, let id = connectionID, let token = deviceToken else { return }
        let environment = Bundle.main.object(forInfoDictionaryKey: "StudioAPNSEnvironment") as? String
        guard environment == "development" || environment == "production" else {
            status = "This app build does not declare its Apple notification environment."
            return
        }
        // Record the pending registration before dispatch, so disabling can clean up even an uncertain response.
        registrations.insert(id); saveRegistrations()
        do {
            let result = try await store.authorized(id) { client, bearer in
                try await client.registerNotifications(NotificationRegistrationBody(
                    token: token, environment: environment == "development" ? "sandbox" : "production",
                    enabled: true, botReplies: self.botReplies, routines: self.routines
                ), token: bearer)
            }
            guard enabled, connectionID == id, deviceToken == token else { return }
            status = result.deliverySummary
        } catch EngineError.http(let statusCode, _) where statusCode == 404 {
            status = "Update this engine to support notifications."
        } catch {
            if enabled { status = "Couldn’t update notification delivery. Retry when your engine is reachable." }
        }
    }

    private func connection(for destination: NotificationDestination) -> Connection? {
        guard let store, let id = destination.connectionID(in: store.connections) else { return nil }
        return store.connection(id)
    }

    private func open(_ destination: NotificationDestination) {
        guard let store else { pendingDestination = destination; return }
        guard let connection = connection(for: destination) else { pendingDestination = nil; return }
        pendingDestination = nil
        store.showSettings = false
        store.activate(connection.id)
        store.webSession(for: connection.id).openNotification(destination)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let destination = NotificationDestination(userInfo: response.notification.request.content.userInfo) else { return }
        await MainActor.run { self.open(destination) }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        guard let destination = NotificationDestination(userInfo: notification.request.content.userInfo) else { return [] }
        return await presentation(for: destination)
    }

    private func presentation(for destination: NotificationDestination) async -> UNNotificationPresentationOptions {
        guard enabled, let store, let connection = connection(for: destination), connection.id == connectionID,
              destination.kind == .message ? botReplies : routines else { return [] }
        if store.activeID == connection.id, !store.showSettings, store.pairingSheet == nil,
           let session = store.webSessionIfLoaded(connection.id), await session.isShowingNotification(destination) { return [] }
        return [.banner, .sound, .list]
    }
}

@MainActor
final class IOSAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        NotificationCoordinator.shared.prepare()
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCoordinator.shared.didRegister(deviceToken)
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCoordinator.shared.didFailRegistration()
    }
}
#endif
