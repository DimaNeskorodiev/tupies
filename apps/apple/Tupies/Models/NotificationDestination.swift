import Foundation
import CoreFoundation

/// Push metadata can select only a known engine and a bot route. It never supplies a URL or an action.
struct NotificationDestination: Equatable {
    enum Kind: String { case message, routine }
    let engineID: String
    let botID: String
    let roomID: String?
    let kind: Kind
    let eventID: String

    init?(userInfo: [AnyHashable: Any]) {
        guard let payload = userInfo["studio"] as? [String: Any],
              let version = payload["v"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let engine = payload["engineId"] as? String, Self.validID(engine),
              let bot = payload["botId"] as? String, Self.validID(bot),
              let rawKind = payload["kind"] as? String, let kind = Kind(rawValue: rawKind),
              let event = payload["eventId"] as? String, !event.isEmpty, event.utf8.count <= 256,
              !event.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
        else { return nil }
        let room = payload["roomId"] as? String
        if payload["roomId"] != nil && (room == nil || !Self.validID(room!)) { return nil }
        engineID = engine; botID = bot; roomID = room; self.kind = kind; eventID = event
    }

    static func validID(_ value: String) -> Bool {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
        return !value.isEmpty && value.utf8.count <= 120 && value.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    var hash: String { roomID.map { "#/room/\($0)" } ?? "#/bot/\(botID)" }

    func matchesVisibleHash(_ hash: String) -> Bool { self.hash == hash }
    func connectionID(in connections: [Connection]) -> UUID? { connections.first { $0.nodeId == engineID }?.id }
}

/// Cold-start delivery survives sign-in and only clears after the authenticated page applied it.
struct NotificationNavigation {
    private(set) var pending: NotificationDestination?
    mutating func receive(_ destination: NotificationDestination) { pending = destination }
    func destination(authenticated: Bool) -> NotificationDestination? { authenticated ? pending : nil }
    mutating func didApply(_ destination: NotificationDestination) {
        if pending == destination { pending = nil }
    }
}
