import Foundation

/// Native authentication and the web interface must both belong to the same current document.
/// Password setup is independent of a paired device's permission to obtain a web ticket.
struct WebSessionReadiness {
    struct Context: Equatable {
        let authenticationGeneration: Int
        let documentGeneration: Int
    }

    private(set) var context = Context(authenticationGeneration: 0, documentGeneration: 0)
    private(set) var signingIn = false
    private(set) var authenticated = false
    private(set) var rendered = false
    var mayReveal: Bool { authenticated && rendered && !signingIn }

    @discardableResult mutating func beginSignIn() -> Context {
        context = Context(authenticationGeneration: context.authenticationGeneration + 1, documentGeneration: context.documentGeneration + 1)
        signingIn = true
        authenticated = false
        rendered = false
        return context
    }

    @discardableResult mutating func didCommitDocument() -> Context {
        context = Context(authenticationGeneration: context.authenticationGeneration, documentGeneration: context.documentGeneration + 1)
        authenticated = false
        rendered = false
        return context
    }

    @discardableResult mutating func didFinishDocument() -> Context {
        signingIn = false
        return context
    }

    mutating func invalidate() {
        _ = beginSignIn()
        signingIn = false
    }

    @discardableResult mutating func receiveAuthentication(_ value: Bool, context expected: Context) -> Bool {
        guard context == expected, !signingIn else { return false }
        authenticated = value
        if !value { rendered = false }
        return true
    }

    @discardableResult mutating func receiveRender(_ value: Bool, context expected: Context) -> Bool {
        guard context == expected, !signingIn else { return false }
        rendered = value
        return true
    }
}

/// Bounded presentation context read from the current main document. It never authorizes a request.
struct WebPageSnapshot {
    let appShell: Bool
    let authScreen: Bool
    let hash: String
    let view: String
    let conversationID: String
    let conversationReady: Bool
    let conversationMissing: Bool

    init?(value: Any) {
        guard let value = value as? [String: Any],
              let appShell = value["appShell"] as? Bool,
              let authScreen = value["authScreen"] as? Bool,
              let hash = value["hash"] as? String, hash.utf8.count <= 16_384,
              let view = value["view"] as? String, view.utf8.count <= 120,
              let conversationID = value["conversationID"] as? String, conversationID.utf8.count <= 120,
              let conversationReady = value["conversationReady"] as? Bool,
              let conversationMissing = value["conversationMissing"] as? Bool
        else { return nil }
        self.appShell = appShell
        self.authScreen = authScreen
        self.hash = hash
        self.view = view
        self.conversationID = conversationID
        self.conversationReady = conversationReady
        self.conversationMissing = conversationMissing
    }

    var hasReadyInterface: Bool {
        appShell && !authScreen && (!["bot", "room"].contains(view) || conversationReady || conversationMissing)
    }
}
