import SwiftUI

/// Where the pairing sheet starts.
enum PairingStep: Hashable {
    case choose
    case scan
    case paste
    case confirm(PairingLink)
    #if os(macOS)
    case thisMac
    #endif
}

struct PairingSheetRequest: Identifiable {
    let id = UUID()
    var start: PairingStep
}

enum PairingProgress: Equatable {
    case verifying
    case creatingKey
    case pairing
    case signingIn

    var label: String {
        switch self {
        case .verifying: return "Verifying engine…"
        case .creatingKey: return "Creating device key…"
        case .pairing: return "Pairing…"
        case .signingIn: return "Signing in…"
        }
    }
}

struct AppAlert: Identifiable {
    let id = UUID()
    var title: String
    var message: String
}

struct Toast: Identifiable, Equatable {
    let id = UUID()
    var message: String
    var systemImage: String
}

/// Lightweight liveness of an engine, from `GET /api/engine` probes and session results.
enum Reachability: Equatable {
    case unknown
    case online
    case offline
    case revoked
    case identityChanged
    case updateRequired

    var color: Color {
        switch self {
        case .online: return .green
        case .offline, .revoked, .identityChanged, .updateRequired: return .red
        case .unknown: return .gray
        }
    }

    var label: String {
        switch self {
        case .unknown: return "Checking…"
        case .online: return "Online"
        case .offline: return "Offline"
        case .revoked: return "Needs pairing"
        case .identityChanged: return "Identity changed"
        case .updateRequired: return "Update required"
        }
    }
}

enum SyncHealth: Equatable {
    case unknown
    case standalone
    case connected
    case syncing
    case error
    case unsupported
    case offline

    var color: Color {
        switch self {
        case .standalone, .connected: return .green
        case .syncing: return .orange
        case .error, .offline: return .red
        case .unknown, .unsupported: return .gray
        }
    }

    var symbol: String {
        switch self {
        case .error, .offline: return "exclamationmark.arrow.triangle.2.circlepath"
        default: return "arrow.triangle.2.circlepath"
        }
    }

    var label: String {
        switch self {
        case .unknown: return "Checking sync…"
        case .standalone: return "Standalone engine"
        case .connected: return "In sync"
        case .syncing: return "Syncing…"
        case .error: return "Sync problem"
        case .unsupported: return "Sync not available"
        case .offline: return "Engine offline"
        }
    }
}

struct SyncSnapshot: Equatable {
    var status: SyncStatus?
    var health: SyncHealth
    var message: String?
    var updatedAt: Date

    static func from(_ status: SyncStatus) -> SyncSnapshot {
        let health: SyncHealth
        var message: String?
        if let hub = status.hub {
            if let error = hub.error, !error.isEmpty {
                health = .error
                message = error
            } else if hub.connected == false {
                health = .error
                message = "Not connected to \(hub.name ?? "the hub")."
            } else if (status.pending ?? 0) > 0 {
                health = .syncing
            } else {
                health = .connected
            }
        } else if (status.pending ?? 0) > 0 {
            health = .syncing
        } else {
            health = .standalone
        }
        return SyncSnapshot(status: status, health: health, message: message, updatedAt: Date())
    }
}
