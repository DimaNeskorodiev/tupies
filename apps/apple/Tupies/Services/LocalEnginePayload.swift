import Foundation

/// The signed application contains code; its persistent engine state belongs outside the bundle.
struct LocalEnginePayload {
    enum Failure: LocalizedError {
        case missingPayload
        case unsafeStorage
        case unmanagedData
        case missingManagedData
        case managedIdentityMismatch
        case unsupportedStorage

        var errorDescription: String? {
            switch self {
            case .missingPayload: return "This app is missing its included engine or Node.js runtime. Install a complete Tupies app, or choose a developer engine under Advanced settings."
            case .unsafeStorage: return "Tupies’s local engine storage must use real folders and files, not symbolic links. No engine was started."
            case .unmanagedData: return "The local engine data folder already exists without Tupies’s ownership marker. Nothing was opened or changed. Choose a developer engine or move that folder yourself before trying again."
            case .missingManagedData: return "This Mac’s saved engine data is missing. Restore the complete engine backup before starting it. No replacement workspace was created."
            case .managedIdentityMismatch: return "This Mac’s saved engine identity does not match its managed workspace. Restore the complete matching backup before starting it. No engine was started."
            case .unsupportedStorage: return "This local engine data folder uses an unsupported layout. Update Tupies before opening it. Nothing was changed."
            }
        }
    }

    let engineDirectory: URL
    let nodeExecutable: URL
    let supportDirectory: URL

    init(resources: URL, applicationSupport: URL) {
        engineDirectory = resources.appendingPathComponent("Engine", isDirectory: true)
        nodeExecutable = resources.appendingPathComponent("Runtime/node")
        supportDirectory = applicationSupport.appendingPathComponent("Tupies/Engine", isDirectory: true)
    }

    var dataDirectory: URL { supportDirectory.appendingPathComponent("data", isDirectory: true) }
    var markerURL: URL { supportDirectory.appendingPathComponent("managed-engine-v1.json") }
    var isAvailable: Bool {
        let manager = FileManager.default
        return manager.fileExists(atPath: engineDirectory.appendingPathComponent("server.mjs").path)
            && manager.isExecutableFile(atPath: nodeExecutable.path)
    }

    func validate() throws {
        let manager = FileManager.default
        guard isAvailable,
              try manager.attributesOfItem(atPath: engineDirectory.path)[.type] as? FileAttributeType == .typeDirectory,
              try manager.attributesOfItem(atPath: nodeExecutable.deletingLastPathComponent().path)[.type] as? FileAttributeType == .typeDirectory,
              try manager.attributesOfItem(atPath: engineDirectory.appendingPathComponent("server.mjs").path)[.type] as? FileAttributeType == .typeRegular,
              try manager.attributesOfItem(atPath: nodeExecutable.path)[.type] as? FileAttributeType == .typeRegular
        else { throw Failure.missingPayload }
    }

    /// Refuse accidental data adoption. Existing installations keep using their discovered engine first.
    func prepareDataDirectory() throws -> URL {
        try validate()
        let manager = FileManager.default
        let markerExists = manager.fileExists(atPath: markerURL.path)
        let dataExists = manager.fileExists(atPath: dataDirectory.path)
        for folder in [supportDirectory.deletingLastPathComponent(), supportDirectory, dataDirectory] where manager.fileExists(atPath: folder.path) {
            guard try manager.attributesOfItem(atPath: folder.path)[.type] as? FileAttributeType == .typeDirectory else { throw Failure.unsafeStorage }
        }
        if markerExists {
            guard try manager.attributesOfItem(atPath: markerURL.path)[.type] as? FileAttributeType == .typeRegular else { throw Failure.unsafeStorage }
            guard (try manager.attributesOfItem(atPath: markerURL.path)[.size] as? NSNumber)?.intValue ?? 0 <= 1024,
                  let marker = try? JSONDecoder().decode(Marker.self, from: Data(contentsOf: markerURL)),
                  marker.version == 1, marker.dataDirectory == "data" else { throw Failure.unsupportedStorage }
            if marker.fingerprint != nil || marker.nodeId != nil {
                guard dataExists else { throw Failure.missingManagedData }
                try validateManagedIdentity(marker)
            }
        } else {
            guard !dataExists else { throw Failure.unmanagedData }
        }
        try privateDirectory(supportDirectory.deletingLastPathComponent())
        try privateDirectory(supportDirectory)
        if !markerExists {
            let encoded = try JSONEncoder().encode(Marker(version: 1, dataDirectory: "data"))
            try encoded.write(to: markerURL, options: .atomic)
            try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: markerURL.path)
        }
        try privateDirectory(dataDirectory)
        return dataDirectory
    }

    /// Only an already verified connection to this app's owned process may establish restart ownership.
    func associate(_ connection: Connection) throws {
        guard connection.kind == .local, connection.baseURL.isLoopback, let port = connection.baseURL.effectivePort,
              let nodeId = connection.nodeId, Fingerprint.isWellFormed(connection.fingerprint) else { throw Failure.unsafeStorage }
        _ = try prepareDataDirectory()
        let marker = Marker(version: 1, dataDirectory: "data", fingerprint: Fingerprint.normalize(connection.fingerprint), nodeId: nodeId, port: port)
        try validateManagedIdentity(marker)
        try JSONEncoder().encode(marker).write(to: markerURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: markerURL.path)
    }

    func matchesManagedConnection(_ connection: Connection) -> Bool {
        guard connection.kind == .local, connection.baseURL.isLoopback, connection.baseURL.scheme == "http",
              (try? FileManager.default.attributesOfItem(atPath: dataDirectory.path)[.type] as? FileAttributeType) == .typeDirectory,
              (try? FileManager.default.attributesOfItem(atPath: markerURL.path)[.type] as? FileAttributeType) == .typeRegular,
              (try? FileManager.default.attributesOfItem(atPath: markerURL.path)[.size] as? NSNumber)?.intValue ?? Int.max <= 1024,
              let marker = try? JSONDecoder().decode(Marker.self, from: Data(contentsOf: markerURL)),
              marker.version == 1, marker.dataDirectory == "data", let fingerprint = marker.fingerprint,
              marker.nodeId != nil, marker.nodeId == connection.nodeId, marker.port == connection.baseURL.effectivePort
        else { return false }
        return Fingerprint.normalize(fingerprint) == Fingerprint.normalize(connection.fingerprint)
            && (try? validateManagedIdentity(marker)) != nil
    }

    private struct Marker: Codable {
        let version: Int
        let dataDirectory: String
        var fingerprint: String? = nil
        var nodeId: String? = nil
        var port: Int? = nil
    }

    private func validateManagedIdentity(_ marker: Marker) throws {
        struct Identity: Decodable { let nodeId: String; let publicKey: String }
        let manager = FileManager.default
        let sync = dataDirectory.appendingPathComponent("sync", isDirectory: true)
        for folder in [supportDirectory.deletingLastPathComponent(), supportDirectory, dataDirectory, sync] {
            guard (try? manager.attributesOfItem(atPath: folder.path)[.type] as? FileAttributeType) == .typeDirectory else { throw Failure.missingManagedData }
        }
        let file = sync.appendingPathComponent("identity.json")
        guard (try? manager.attributesOfItem(atPath: file.path)[.type] as? FileAttributeType) == .typeRegular,
              (try? manager.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.intValue ?? Int.max <= 16_384 else { throw Failure.missingManagedData }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        guard let data = try handle.read(upToCount: 16_385), data.count <= 16_384,
              let identity = try? JSONDecoder().decode(Identity.self, from: data),
              identity.nodeId == marker.nodeId, identity.publicKey.count <= 400,
              let publicKey = Data(base64Encoded: identity.publicKey),
              let fingerprint = marker.fingerprint,
              Fingerprint.of(publicKeyDER: publicKey) == Fingerprint.normalize(fingerprint) else { throw Failure.managedIdentityMismatch }
    }

    private func privateDirectory(_ directory: URL) throws {
        let manager = FileManager.default
        if !manager.fileExists(atPath: directory.path) {
            try manager.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        }
        guard try manager.attributesOfItem(atPath: directory.path)[.type] as? FileAttributeType == .typeDirectory else { throw Failure.unsafeStorage }
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    }
}
