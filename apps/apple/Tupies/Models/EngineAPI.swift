import Foundation

// Wire types for the Tupies Engine device API. Field names match the engine
// contract exactly; optional fields are decoded leniently so older or newer
// engines do not break the app.

struct EngineInfo: Decodable, Equatable {
    struct Protocols: Decodable, Equatable {
        let deviceSession: Int?
    }
    let product: String
    let version: String?
    let name: String?
    let fingerprint: String
    let publicKey: String
    let role: String?
    let nodeId: String?
    let protocols: Protocols?
}

struct PairRequestBody: Encodable {
    let v: Int = 1
    let code: String
    let kind: String = "device"
    let name: String
    let platform: String
    let publicKey: String
    let proof: String

    init(code: String, name: String, platform: String, publicKey: String, proof: String) {
        self.code = code
        self.name = name
        self.platform = platform
        self.publicKey = publicKey
        self.proof = proof
    }

    private enum CodingKeys: String, CodingKey {
        case v, code, kind, name, platform, publicKey, proof
    }
}

struct PairResponse: Decodable {
    struct Engine: Decodable {
        let nodeId: String?
        let name: String?
        let fingerprint: String
        let publicKey: String
    }

    let deviceId: String
    let engine: Engine
    let engineProof: String
}

struct SessionRequestBody: Encodable {
    let v: Int = 2
    let engineNodeId: String
    let engineFingerprint: String
    let deviceId: String
    let timestamp: Int64
    let nonce: String
    let signature: String
}

struct SessionResponse: Decodable {
    let token: String
    let expiresAt: String
}

struct WebTicketResponse: Decodable {
    let ticket: String
    let path: String
}

struct RevokeResponse: Decodable {
    let revoked: Bool
}

struct NotificationRegistrationBody: Encodable {
    let token: String
    let environment: String
    let enabled: Bool
    let botReplies: Bool
    let routines: Bool
}

struct NotificationRegistrationStatus: Decodable {
    struct Delivery: Decodable {
        let status: String
        let lastError: String?
    }
    let available: Bool
    let registered: Bool
    let enabled: Bool
    let botReplies: Bool
    let routines: Bool
    let environment: String?
    let reason: String?
    let delivery: Delivery?

    /// Fixed copy only: do not echo arbitrary engine errors into a lock-screen settings surface.
    var deliverySummary: String {
        if reason == "home_server_only" { return "Choose your home server for notification delivery." }
        if reason == "storage_unavailable" { return "The engine could not read notification delivery settings. Restore its notification storage before enabling alerts." }
        if reason == "environment_mismatch" { return "This app and engine use different Apple push environments. Match sandbox or production in the engine setup." }
        if !available { return "Notifications need Apple push setup on this engine. Your preferences are saved." }
        switch delivery?.lastError {
        case "push_authorization_failed": return "Apple refused this engine’s push credentials. Review its Apple push setup."
        case "storage_unavailable": return "The engine could not save notification delivery. Check its storage and try again."
        case "delivery_unknown": return "The last alert’s delivery could not be confirmed. Open Tupies to check for new replies."
        case "delivery_rejected": return "Apple rejected the last alert. Check notification delivery on the engine."
        case "delivery_expired": return "The last queued alert expired before it could be sent. Open Tupies for the latest replies."
        case "temporarily_unavailable": return "Apple is temporarily unavailable. The engine will retry queued alerts."
        case .some: return "The last alert could not be delivered. Check notification delivery on the engine."
        case nil: break
        }
        if delivery?.status == "storage_error" { return "The engine could not save notification delivery. Check its storage and try again." }
        if delivery?.status == "unknown" { return "The last alert’s delivery could not be confirmed. Open Tupies to check for new replies." }
        if delivery?.status == "failed" { return "The last alert could not be delivered. Check notification delivery on the engine." }
        return registered && enabled ? "Registered for bot replies and routine results. Message content stays on your engine." : "Notification delivery is not enabled on this engine."
    }
}

struct SyncStatus: Decodable, Equatable {
    struct Node: Decodable, Equatable {
        let id: String?
        let name: String?
        let role: String?
    }

    struct Hub: Decodable, Equatable {
        let url: String?
        let name: String?
        let connected: Bool?
        let lastSyncAt: String?
        let error: String?
    }

    struct Engine: Decodable, Equatable, Identifiable {
        let nodeId: String?
        let name: String?
        let role: String?
        let url: String?
        let online: Bool?
        let lastSeenAt: String?

        var id: String { nodeId ?? url ?? name ?? UUID().uuidString }
    }

    let node: Node?
    let hub: Hub?
    let engines: [Engine]?
    let pending: Int?
}

struct APIErrorBody: Decodable {
    let error: String
}

/// A short-lived bearer token minted by `POST /api/device/session`.
struct SessionToken: Codable, Equatable {
    let token: String
    let expiresAt: Date
    /// Absent on old stored tokens. Never reuse those to skip the current protocol check.
    var protocolVersion: Int? = nil
}

struct DeviceSessionTarget: Equatable {
    let nodeId: String
    let fingerprint: String
}

enum ISODate {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func parse(_ value: String?) -> Date? {
        guard let value = value, !value.isEmpty else { return nil }
        return fractional.date(from: value) ?? plain.date(from: value)
    }
}
