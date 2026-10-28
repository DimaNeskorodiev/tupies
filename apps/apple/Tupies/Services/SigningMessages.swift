import CryptoKit
import Foundation
import Security

/// Canonical messages signed by the device and the engine. These must match
/// `lib/sync/crypto.mjs` byte for byte (UTF-8, `\n` separators, no trailing newline).
enum SigningMessages {
    static func pair(code: String, publicKey: String) -> Data {
        Data("hermes-studio/pair/v1\n\(code)\n\(publicKey)".utf8)
    }

    static func paired(deviceId: String, publicKey: String) -> Data {
        Data("hermes-studio/paired/v1\n\(deviceId)\n\(publicKey)".utf8)
    }

    static func session(deviceId: String, timestamp: Int64, nonce: String) -> Data {
        Data("hermes-studio/session/v1\n\(deviceId)\n\(String(timestamp))\n\(nonce)".utf8)
    }
}

/// Engine fingerprints are base64url(SHA-256(SPKI DER)) without padding.
enum Fingerprint {
    static func of(publicKeyDER: Data) -> String {
        Data(SHA256.hash(data: publicKeyDER)).base64URLEncodedString()
    }

    /// Strips whitespace and base64 padding so comparisons are robust.
    static func normalize(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "=", with: "")
    }

    static func isWellFormed(_ value: String) -> Bool {
        let normalized = normalize(value)
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        return normalized.count >= 16 && normalized.count <= 128
            && normalized.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    /// First 8 characters, upper-cased and grouped (`ABCD EFGH`) — the same
    /// format the engine shows next to its pairing QR code.
    static func short(_ value: String) -> String {
        let prefix = String(normalize(value).prefix(8)).uppercased()
        guard prefix.count > 4 else { return prefix }
        let index = prefix.index(prefix.startIndex, offsetBy: 4)
        return "\(prefix[..<index]) \(prefix[index...])"
    }

    /// Full fingerprint in groups of four for detailed display.
    static func grouped(_ value: String) -> String {
        let characters = Array(normalize(value))
        return stride(from: 0, to: characters.count, by: 4)
            .map { String(characters[$0..<min($0 + 4, characters.count)]) }
            .joined(separator: " ")
    }
}

/// Verifies signatures made by the engine identity key (P-256 ECDSA, DER).
enum EngineSignature {
    static func isValid(signatureBase64: String, message: Data, publicKeyDER: Data) -> Bool {
        guard let signatureData = Data(base64Encoded: signatureBase64),
              let publicKey = try? P256.Signing.PublicKey(derRepresentation: publicKeyDER),
              let signature = try? P256.Signing.ECDSASignature(derRepresentation: signatureData)
        else { return false }
        return publicKey.isValidSignature(signature, for: message)
    }
}

extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func random(count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        if status != errSecSuccess {
            // SecRandomCopyBytes does not fail in practice; fall back to the system RNG.
            var generator = SystemRandomNumberGenerator()
            for index in bytes.indices { bytes[index] = UInt8.random(in: .min ... .max, using: &generator) }
        }
        return Data(bytes)
    }
}
