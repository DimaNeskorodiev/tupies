import Foundation

/// Human-readable failures for everything that talks to an engine.
enum EngineError: LocalizedError, Equatable {
    case unreachable(engine: String)
    case untrustedCertificate(engine: String)
    case certificateMismatch(engine: String)
    case tlsHandshake(engine: String)
    case engineUpdateRequired(engine: String)
    case appUpdateRequired(engine: String)
    case notStudio
    case identityMismatch(engine: String)
    case proofInvalid(engine: String)
    case unauthorized(engine: String)
    case http(status: Int, message: String)
    case invalidResponse
    case missingConnection

    var errorDescription: String? {
        switch self {
        case .unreachable(let engine):
            return "Can’t reach \(engine). Check Tailscale/VPN or that the server is running."
        case .untrustedCertificate(let engine):
            return "\(engine)’s HTTPS certificate isn’t trusted by this device. Check its certificate or create a new pairing link from your own engine."
        case .certificateMismatch(let engine):
            return "Security check failed: the server at \(engine)’s address isn’t the one you paired with, so nothing was sent. If you moved Tupies to a new server, pair this device again."
        case .tlsHandshake(let engine):
            return "A secure connection to \(engine) could not be established. Check the engine’s HTTPS configuration and try again."
        case .engineUpdateRequired(let engine):
            return "Update Tupies on \(engine) to use secure device sign-in, then choose Check Again. Your saved connection and device key are kept."
        case .appUpdateRequired(let engine):
            return "\(engine) requires a newer device sign-in protocol. Update this Tupies app and try again. Your saved connection and device key are kept."
        case .notStudio:
            return "This address doesn’t answer like a Tupies engine."
        case .identityMismatch(let engine):
            return "Security check failed: \(engine) presented a different identity than the pairing link. Nothing was paired. Create a new pairing link in Tupies and make sure you’re on your own network."
        case .proofInvalid(let engine):
            return "Security check failed: \(engine) couldn’t prove its identity. Nothing was saved."
        case .unauthorized(let engine):
            return "This device was removed from \(engine). Pair again."
        case .http(_, let message):
            return message
        case .invalidResponse:
            return "The engine sent a response this app doesn’t understand. Make sure Tupies is up to date."
        case .missingConnection:
            return "This connection no longer exists."
        }
    }

    var isUnauthorizedHTTP: Bool {
        if case .http(let status, _) = self, status == 401 { return true }
        return false
    }

    var isUnreachable: Bool {
        if case .unreachable = self { return true }
        return false
    }
}

/// Async/await client for one engine origin.
struct EngineClient {
    let baseURL: URL
    let engineName: String
    /// Engine identity fingerprint from the pairing link; an engine serving its own certificate must present this key.
    var fingerprint: String = ""
    /// Once an engine has proved itself with its own key, a publicly trusted certificate is not accepted instead.
    var requirePin = false
    /// How this client's connections were trusted (shared by copies of the client).
    let trust = TrustReport()

    init(baseURL: URL, engineName: String, fingerprint: String = "", requirePin: Bool = false) {
        self.baseURL = baseURL
        self.engineName = engineName
        self.fingerprint = fingerprint
        self.requirePin = requirePin
    }

    init(connection: Connection) {
        self.init(baseURL: connection.baseURL, engineName: connection.name, fingerprint: connection.fingerprint, requirePin: connection.pinnedTLS == true)
    }

    static let userAgent = "TupiesApp/0.5"

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 40
        configuration.waitsForConnectivity = false
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpAdditionalHeaders = [
            "User-Agent": userAgent,
            "Accept": "application/json",
        ]
        return URLSession(configuration: configuration)
    }()

    // MARK: Endpoints

    /// `GET /api/engine` — unauthenticated identity of the engine.
    func engineInfo(timeout: TimeInterval = 10) async throws -> EngineInfo {
        try await send("GET", "/api/engine", timeout: timeout)
    }

    /// A launcher must distinguish a refused connection from an answering but unsafe engine.
    func localStartEngineInfo(timeout: TimeInterval = 2.5) async throws -> EngineInfo {
        try await send("GET", "/api/engine", timeout: timeout, preserveTransportError: true)
    }

    /// Validate identity and protocol metadata before signing any session request.
    func verifiedSessionTarget(expectedNodeId: String?) async throws -> DeviceSessionTarget {
        let info = try await engineInfo()
        return try sessionTarget(from: info, expectedNodeId: expectedNodeId)
    }

    func sessionTarget(from info: EngineInfo, expectedNodeId: String?) throws -> DeviceSessionTarget {
        guard info.product == "hermes-studio" else { throw EngineError.notStudio }
        let expected = Fingerprint.normalize(fingerprint)
        guard !expected.isEmpty, Fingerprint.normalize(info.fingerprint) == expected,
              let key = Data(base64Encoded: info.publicKey), Fingerprint.of(publicKeyDER: key) == expected
        else { throw EngineError.identityMismatch(engine: engineName) }
        let version = info.protocols?.deviceSession ?? 0
        guard version == 2 else {
            if version > 2 { throw EngineError.appUpdateRequired(engine: engineName) }
            throw EngineError.engineUpdateRequired(engine: engineName)
        }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
        guard let nodeId = info.nodeId, !nodeId.isEmpty, nodeId.count <= 120,
              nodeId.unicodeScalars.allSatisfy({ allowed.contains($0) })
        else { throw EngineError.invalidResponse }
        guard expectedNodeId == nil || expectedNodeId == nodeId else { throw EngineError.identityMismatch(engine: engineName) }
        return DeviceSessionTarget(nodeId: nodeId, fingerprint: expected)
    }

    /// `POST /api/pair` — registers this device's public key using a pairing code.
    func pair(_ body: PairRequestBody) async throws -> PairResponse {
        try await send("POST", "/api/pair", body: body)
    }

    /// `POST /api/device/session` — exchanges a signed challenge for a bearer token.
    func openSession(_ body: SessionRequestBody) async throws -> SessionResponse {
        do {
            return try await send("POST", "/api/device/session", body: body)
        } catch EngineError.http(let status, _) where status == 401 {
            throw EngineError.unauthorized(engine: engineName)
        } catch EngineError.http(let status, _) where status == 426 {
            throw EngineError.appUpdateRequired(engine: engineName)
        }
    }

    /// `POST /api/device/web-ticket` — single-use ticket that signs the web view in.
    func webTicket(token: String) async throws -> WebTicketResponse {
        try await send("POST", "/api/device/web-ticket", body: EmptyBody(), token: token)
    }

    /// `GET /api/sync/status`
    func syncStatus(token: String) async throws -> SyncStatus {
        try await send("GET", "/api/sync/status", token: token)
    }

    /// The engine binds registration to this bearer session's own paired iOS device.
    func registerNotifications(_ body: NotificationRegistrationBody, token: String) async throws -> NotificationRegistrationStatus {
        try await send("PUT", "/api/device/notifications", body: body, token: token)
    }

    func notificationStatus(token: String) async throws -> NotificationRegistrationStatus {
        try await send("GET", "/api/device/notifications", token: token)
    }

    func removeNotifications(token: String) async throws {
        let _: NotificationRegistrationStatus = try await send("DELETE", "/api/device/notifications", body: EmptyBody(), token: token)
    }

    /// `DELETE /api/devices/{id}` — unpairs this device on the engine (and, through sync, on every linked engine).
    func revokeDevice(_ deviceId: String, token: String) async throws {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
        guard !deviceId.isEmpty, deviceId.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return }
        let _: RevokeResponse = try await send("DELETE", "/api/devices/\(deviceId)", token: token, timeout: 5)
    }

    // MARK: Transport

    private struct EmptyBody: Encodable {}

    private func send<Response: Decodable>(
        _ method: String,
        _ path: String,
        body: (any Encodable)? = nil,
        token: String? = nil,
        timeout: TimeInterval? = nil,
        preserveTransportError: Bool = false
    ) async throws -> Response {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else { throw EngineError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let timeout = timeout { request.timeoutInterval = timeout }
        if let token = token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body = body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }

        let data: Data
        let response: URLResponse
        let delegate = PinningDelegate(fingerprint: fingerprint, requirePin: requirePin, report: trust)
        do {
            (data, response) = try await Self.session.data(for: request, delegate: delegate)
        } catch {
            if delegate.rejected {
                throw requirePin ? EngineError.certificateMismatch(engine: engineName) : EngineError.untrustedCertificate(engine: engineName)
            }
            throw preserveTransportError ? error : map(error)
        }

        guard let http = response as? HTTPURLResponse else { throw EngineError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(APIErrorBody.self, from: data))?.error
            throw EngineError.http(status: http.statusCode, message: message ?? Self.fallbackMessage(for: http.statusCode, engine: engineName))
        }
        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw EngineError.invalidResponse
        }
    }

    private func map(_ error: Error) -> Error {
        Self.transportError(error, engine: engineName)
    }

    static func transportError(_ error: Error, engine: String) -> Error {
        if error is CancellationError { return error }
        guard let urlError = error as? URLError else { return EngineError.unreachable(engine: engine) }
        switch urlError.code {
        case .cancelled:
            return CancellationError()
        case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid, .clientCertificateRejected, .clientCertificateRequired:
            return EngineError.untrustedCertificate(engine: engine)
        case .secureConnectionFailed:
            return EngineError.tlsHandshake(engine: engine)
        default:
            return EngineError.unreachable(engine: engine)
        }
    }

    private static func fallbackMessage(for status: Int, engine: String) -> String {
        switch status {
        case 401: return "\(engine) didn’t accept this device’s credentials."
        case 403: return "\(engine) refused the request."
        case 404: return "\(engine) doesn’t support this feature yet. Update Tupies on the engine."
        case 409: return "\(engine) reported a conflict. Try again."
        case 410: return "This pairing code has expired. Create a new one in Tupies."
        case 429: return "Too many attempts. Wait a little and try again."
        case 500...599: return "\(engine) had a problem (\(status)). Try again shortly."
        default: return "\(engine) returned an error (\(status))."
        }
    }

    /// URL error codes that mean "the engine can't be reached right now".
    static func isConnectivityError(_ error: Error) -> Bool {
        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain else { return false }
        let codes: Set<Int> = [
            NSURLErrorTimedOut, NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost,
            NSURLErrorNetworkConnectionLost, NSURLErrorDNSLookupFailed, NSURLErrorNotConnectedToInternet,
            NSURLErrorInternationalRoamingOff, NSURLErrorDataNotAllowed, NSURLErrorCannotLoadFromNetwork,
            NSURLErrorBadServerResponse,
        ]
        return codes.contains(nsError.code)
    }
}
