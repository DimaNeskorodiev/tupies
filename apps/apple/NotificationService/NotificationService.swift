import Foundation
import CoreFoundation
import Intents
import UserNotifications

/// Local, finite avatars only. The extension never fetches a URL, reads an engine key,
/// changes routing metadata or runs an action. iOS owns lock-screen preview visibility.
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var fallback: UNNotificationContent?
    private static let avatars: Set<String> = ["blue", "coral", "jade", "honey", "cloud", "tangerine", "lagoon", "cherry", "pistachio", "periwinkle", "peach", "lemon", "rose", "teal", "azure", "scarlet", "butter", "mint", "cocoa", "blush", "cobalt", "ice", "apricot", "silver"]

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        lock.lock(); handler = contentHandler; fallback = request.content; lock.unlock()
        let content = request.content
        guard let studio = content.userInfo["studio"] as? [String: Any],
              let version = studio["v"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let engine = studio["engineId"] as? String, Self.validID(engine),
              let bot = studio["botId"] as? String, Self.validID(bot),
              let kind = studio["kind"] as? String, ["message", "routine"].contains(kind),
              !content.title.isEmpty, content.title.utf8.count <= 400, content.body.utf8.count <= 1600
        else { finish(content); return }

        var image: INImage?
        if let avatar = studio["avatar"] as? String, Self.avatars.contains(avatar),
           let url = Bundle.main.url(forResource: "notification-avatar-\(avatar)", withExtension: "png"),
           let data = try? Data(contentsOf: url), data.count <= 200000 {
            image = INImage(imageData: data)
        }
        let sender = INPerson(personHandle: INPersonHandle(value: "\(engine):\(bot)", type: .unknown),
                              nameComponents: nil, displayName: content.title, image: image,
                              contactIdentifier: nil, customIdentifier: "\(engine):\(bot)", isMe: false, suggestionType: .none)
        let group = content.subtitle.isEmpty ? nil : INSpeakableString(spokenPhrase: String(content.subtitle.prefix(100)))
        let intent = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText,
                                         content: content.body, speakableGroupName: group,
                                         conversationIdentifier: content.threadIdentifier,
                                         serviceName: nil, sender: sender, attachments: nil)
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.donate { [weak self] error in
            guard let self else { return }
            guard error == nil, let updated = try? content.updating(from: intent) else { self.finish(content); return }
            self.finish(updated)
        }
    }

    override func serviceExtensionTimeWillExpire() { finish(nil) }

    private func finish(_ content: UNNotificationContent?) {
        lock.lock()
        let callback = handler, result = content ?? fallback
        handler = nil; fallback = nil
        lock.unlock()
        if let callback, let result { callback(result) }
    }

    private static func validID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 120 && value.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 95 || $0 == 45 }
    }
}
