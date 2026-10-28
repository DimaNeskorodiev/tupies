import Foundation

/// A paired Tupies engine. Persisted as JSON in UserDefaults; device keys and
/// session tokens never live here — they are stored in the Keychain.
struct Connection: Codable, Identifiable, Hashable {
    enum Kind: String, Codable {
        /// The engine running on this Mac (loopback).
        case local
        /// Any other engine (VPS, home server, Tailscale, …).
        case remote
    }

    var id: UUID
    var name: String
    var baseURL: URL
    var deviceId: String
    var fingerprint: String
    /// Base64 SPKI DER of the engine identity key, kept for future verification.
    var enginePublicKey: String
    var nodeId: String?
    var kind: Kind
    var addedAt: Date
    var lastUsed: Date
    /// True when the engine serves its own certificate over its identity key; then only that key is trusted.
    var pinnedTLS: Bool? = nil

    var hostLabel: String { baseURL.hostLabel }
    var shortFingerprint: String { Fingerprint.short(fingerprint) }
}

extension URL {
    /// `host` or `host:port`, for display.
    var hostLabel: String {
        guard let host = host, !host.isEmpty else { return absoluteString }
        let shown = host.contains(":") ? "[\(host)]" : host
        if let port = port { return "\(shown):\(port)" }
        return shown
    }

    var isLoopback: Bool {
        guard let host = host?.lowercased() else { return false }
        return host == "localhost" || host == "::1" || host == "[::1]" || host.hasPrefix("127.")
    }

    /// Hosts reached through an encrypted overlay network (Tailscale) — plain HTTP
    /// is acceptable there because WireGuard already encrypts the traffic.
    var isEncryptedOverlay: Bool {
        guard let host = host?.lowercased() else { return false }
        if host.hasSuffix(".ts.net") { return true }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        if parts.count == 4, parts[0] == 100, (64...127).contains(parts[1]) { return true }
        return false
    }

    /// True when traffic to this URL travels unencrypted over a real network.
    var isInsecureRemote: Bool {
        scheme?.lowercased() == "http" && !isLoopback && !isEncryptedOverlay
    }

    /// scheme://host[:port] — the engine origin.
    var origin: URL? {
        guard let scheme = scheme, let host = host else { return nil }
        var components = URLComponents()
        components.scheme = scheme.lowercased()
        components.host = host
        components.port = port
        return components.url
    }

    func isSameOrigin(as other: URL) -> Bool {
        guard let a = scheme?.lowercased(), let b = other.scheme?.lowercased(), a == b,
              let h1 = host?.lowercased(), let h2 = other.host?.lowercased(), h1 == h2 else { return false }
        return effectivePort == other.effectivePort
    }

    var effectivePort: Int? {
        if let port = port { return port }
        switch scheme?.lowercased() {
        case "http": return 80
        case "https": return 443
        default: return nil
        }
    }
}
