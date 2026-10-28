import Foundation

/// A parsed `hermes-studio://pair?…` link.
///
///     hermes-studio://pair?v=1&url=<base URL>&code=<code>&fp=<fingerprint>&name=<engine name>&kind=device
struct PairingLink: Hashable, Identifiable {
    enum Kind: String {
        case device
        case engine
    }

    enum ParseError: LocalizedError, Equatable {
        case notAPairingLink
        case unsupportedVersion(String)
        case engineLink
        case missing(String)
        case invalidAddress
        case invalidFingerprint

        var errorDescription: String? {
            switch self {
            case .notAPairingLink:
                return "That isn’t a Tupies pairing link. It should start with hermes-studio://pair."
            case .unsupportedVersion(let version):
                return "This pairing link uses a newer format (v\(version)). Update Tupies and try again."
            case .engineLink:
                return "This link connects two Tupies engines, not a device. Open it in the other engine’s Tupies settings instead."
            case .missing(let field):
                return "The pairing link is incomplete (missing \(field)). Copy it again from Tupies."
            case .invalidAddress:
                return "The pairing link has an invalid engine address."
            case .invalidFingerprint:
                return "The pairing link has an invalid security fingerprint. Copy it again from Tupies."
            }
        }
    }

    static let scheme = "hermes-studio"

    let version: Int
    let baseURL: URL
    let code: String
    let fingerprint: String
    let name: String
    let kind: Kind

    var id: String { "\(baseURL.absoluteString)|\(code)" }

    init(version: Int = 1, baseURL: URL, code: String, fingerprint: String, name: String, kind: Kind = .device) {
        self.version = version
        self.baseURL = baseURL
        self.code = code
        self.fingerprint = fingerprint
        self.name = name
        self.kind = kind
    }

    /// Finds a `hermes-studio://` link inside arbitrary pasted text.
    static func extract(from text: String) -> String? {
        guard let range = text.range(of: "\(scheme)://", options: .caseInsensitive) else { return nil }
        let tail = text[range.lowerBound...]
        let end = tail.firstIndex(where: { $0.isWhitespace || $0 == "\"" || $0 == "'" || $0 == "<" || $0 == ">" }) ?? tail.endIndex
        return String(tail[..<end])
    }

    /// Parses a pairing link. Engine-to-engine links (`kind=engine`) are rejected.
    static func parse(_ text: String) throws -> PairingLink {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let raw = extract(from: trimmed),
              let components = URLComponents(string: raw),
              components.scheme?.lowercased() == scheme
        else { throw ParseError.notAPairingLink }

        let action = (components.host?.isEmpty == false ? components.host! : components.path)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .lowercased()
        guard action == "pair" else { throw ParseError.notAPairingLink }

        let query = formDecodedQuery(components.percentEncodedQuery)

        let versionText = query["v"]?.trimmingCharacters(in: .whitespaces) ?? "1"
        guard let version = Int(versionText) else { throw ParseError.unsupportedVersion(versionText) }
        guard version == 1 else { throw ParseError.unsupportedVersion(versionText) }

        let kindText = (query["kind"] ?? "device").lowercased()
        if kindText == Kind.engine.rawValue { throw ParseError.engineLink }
        guard kindText == Kind.device.rawValue else { throw ParseError.notAPairingLink }

        guard let urlText = query["url"], !urlText.isEmpty else { throw ParseError.missing("url") }
        guard let baseURL = normalizedBaseURL(urlText) else { throw ParseError.invalidAddress }

        guard let code = query["code"]?.trimmingCharacters(in: .whitespacesAndNewlines), !code.isEmpty else {
            throw ParseError.missing("code")
        }
        guard let fingerprint = query["fp"], !fingerprint.isEmpty else { throw ParseError.missing("fp") }
        guard Fingerprint.isWellFormed(fingerprint) else { throw ParseError.invalidFingerprint }

        let name = query["name"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayName = (name?.isEmpty == false ? name! : (baseURL.host ?? "Tupies"))

        return PairingLink(
            version: version,
            baseURL: baseURL,
            code: code,
            fingerprint: Fingerprint.normalize(fingerprint),
            name: String(displayName.prefix(80)),
            kind: .device
        )
    }

    /// Decodes `application/x-www-form-urlencoded` query strings. The engine builds links
    /// with `URLSearchParams`, which encodes spaces as `+`; a literal plus arrives as `%2B`.
    /// The first occurrence of a key wins.
    static func formDecodedQuery(_ query: String?) -> [String: String] {
        var result: [String: String] = [:]
        for pair in (query ?? "").split(separator: "&", omittingEmptySubsequences: true) {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            func decode(_ value: Substring) -> String {
                let spaced = value.replacingOccurrences(of: "+", with: " ")
                return spaced.removingPercentEncoding ?? spaced
            }
            let key = decode(parts[0])
            guard !key.isEmpty, result[key] == nil else { continue }
            result[key] = parts.count > 1 ? decode(parts[1]) : ""
        }
        return result
    }

    /// Reduces any engine URL to its origin (`scheme://host[:port]`). Only http(s) is allowed.
    static func normalizedBaseURL(_ text: String) -> URL? {
        guard let components = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil
        else { return nil }
        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        origin.port = components.port
        return origin.url
    }

    /// Re-encodes the link (used by tests and for sharing).
    var url: URL {
        // Strict encoding (unreserved characters only) so `+`, `&` and `=` survive form decoding.
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        func encode(_ value: String) -> String {
            value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
        }
        let query = [
            ("v", String(version)),
            ("url", baseURL.absoluteString),
            ("code", code),
            ("fp", fingerprint),
            ("name", name),
            ("kind", kind.rawValue),
        ].map { "\($0.0)=\(encode($0.1))" }.joined(separator: "&")
        return URL(string: "\(Self.scheme)://pair?\(query)")!
    }
}
