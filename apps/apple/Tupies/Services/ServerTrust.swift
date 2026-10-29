import Foundation
import Security

/// Decides whether to trust an engine's HTTPS certificate.
///
/// An engine that serves HTTPS itself (`STUDIO_TLS=engine`) presents a self-signed certificate over its identity key:
/// the key whose fingerprint is in the pairing link and shown as the server code. That certificate is trusted only when
/// the key matches, so no domain or certificate authority is involved. An engine behind a publicly trusted certificate
/// (a domain, Tailscale) passes the system's normal checks, unless it was paired with its own key: from then on only
/// that key is accepted, so a certificate authority cannot vouch for an impostor.
enum ServerTrust {
    enum Decision: Equatable { case pinned, system, reject }

    /// DER prefix that turns a raw uncompressed P-256 point into SubjectPublicKeyInfo.
    private static let p256SPKIPrefix = Data([
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
        0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    ])

    /// base64url(SHA-256(SPKI DER)) of a certificate's key, for P-256 keys only.
    static func fingerprint(of certificate: SecCertificate) -> String? {
        guard let key = SecCertificateCopyKey(certificate),
              let attributes = SecKeyCopyAttributes(key) as? [CFString: Any],
              (attributes[kSecAttrKeyType] as? String) == (kSecAttrKeyTypeECSECPrimeRandom as String),
              (attributes[kSecAttrKeySizeInBits] as? Int) == 256,
              let raw = SecKeyCopyExternalRepresentation(key, nil) as Data?,
              raw.count == 65, raw.first == 0x04
        else { return nil }
        return Fingerprint.of(publicKeyDER: p256SPKIPrefix + raw)
    }

    static func fingerprint(ofCertificateDER der: Data) -> String? {
        guard let certificate = SecCertificateCreateWithData(nil, der as CFData) else { return nil }
        return fingerprint(of: certificate)
    }

    static func evaluate(_ trust: SecTrust, host: String, fingerprint expected: String, requirePin: Bool) -> Decision {
        let expected = Fingerprint.normalize(expected)
        if !expected.isEmpty,
           let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first,
           fingerprint(of: leaf) == expected {
            return .pinned
        }
        guard !requirePin else { return .reject }
        SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
        return SecTrustEvaluateWithError(trust, nil) ? .system : .reject
    }
}

/// Remembers how an engine's certificate was accepted, so pairing can record engines that use their own key.
final class TrustReport: @unchecked Sendable {
    private let lock = NSLock()
    private var usedPin = false

    var pinned: Bool { lock.withLock { usedPin } }
    func record(_ decision: ServerTrust.Decision) {
        if decision == .pinned { lock.withLock { usedPin = true } }
    }
}

/// Applies `ServerTrust` to one request's TLS handshake.
final class PinningDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let fingerprint: String
    private let requirePin: Bool
    private let report: TrustReport
    private(set) var rejected = false

    init(fingerprint: String, requirePin: Bool, report: TrustReport) {
        self.fingerprint = fingerprint
        self.requirePin = requirePin
        self.report = report
    }

    /// Pairing codes, signed session challenges and push tokens belong only to the paired origin.
    /// URLSession can replay a POST/PUT body across a 307/308 redirect even when it strips Authorization.
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        guard let original = task.originalRequest?.url, let destination = request.url,
              destination.user == nil, destination.password == nil,
              destination.isSameOrigin(as: original) else { return nil }
        return request
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge
    ) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = space.serverTrust else {
            return (.performDefaultHandling, nil)
        }
        let decision = ServerTrust.evaluate(trust, host: space.host, fingerprint: fingerprint, requirePin: requirePin)
        report.record(decision)
        switch decision {
        case .pinned: return (.useCredential, URLCredential(trust: trust))
        case .system: return (.performDefaultHandling, nil)
        case .reject:
            rejected = true
            return (.cancelAuthenticationChallenge, nil)
        }
    }
}
