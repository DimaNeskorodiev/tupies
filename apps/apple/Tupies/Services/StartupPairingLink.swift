import Foundation

/// One bounded, validated cold-start link, retained only in memory until initialization succeeds.
struct StartupPairingLink {
    private var pending: URL?

    @discardableResult
    mutating func offer(_ url: URL) -> Bool {
        guard url.absoluteString.utf8.count <= 16_384,
              (try? PairingLink.parse(url.absoluteString)) != nil else { return false }
        pending = url
        return true
    }

    mutating func take() -> URL? {
        defer { pending = nil }
        return pending
    }
}
