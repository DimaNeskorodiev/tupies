import Foundation

/// Device-local owner intent. Removing a local connection must survive a still-running engine and app relaunch.
struct LocalEnginePairingIntent {
    private(set) var suppressedFingerprints: [String]

    init(suppressedFingerprints: [String] = []) {
        self.suppressedFingerprints = Array(Set(suppressedFingerprints.filter(Fingerprint.isWellFormed).map(Fingerprint.normalize))).sorted()
    }

    func permitsAutomaticConnection(to fingerprint: String) -> Bool {
        !suppressedFingerprints.contains(Fingerprint.normalize(fingerprint))
    }

    mutating func removed(_ fingerprint: String) {
        guard Fingerprint.isWellFormed(fingerprint) else { return }
        let value = Fingerprint.normalize(fingerprint)
        if !suppressedFingerprints.contains(value) { suppressedFingerprints.append(value); suppressedFingerprints.sort() }
    }

    mutating func explicitlyConnected(_ fingerprint: String) {
        suppressedFingerprints.removeAll { $0 == Fingerprint.normalize(fingerprint) }
    }
}
