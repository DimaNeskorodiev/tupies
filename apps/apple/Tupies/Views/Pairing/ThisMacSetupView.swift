#if os(macOS)
import AppKit
import SwiftUI

/// "Use this Mac": finds the local engine, starts it if needed, and pairs automatically.
struct ThisMacSetupView: View {
    @EnvironmentObject private var store: ConnectionStore
    @EnvironmentObject private var local: LocalEngineController
    let onPaired: () -> Void

    @State private var working = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 14) {
                    Image(systemName: "desktopcomputer")
                        .font(.system(size: 26, weight: .medium))
                        .foregroundStyle(.white)
                        .frame(width: 52, height: 52)
                        .background(Brand.slate.gradient, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Use Tupies on this Mac")
                            .font(.title2.weight(.bold))
                        Text("Tupies connects to the engine on this Mac automatically. If it isn’t running, start it here.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                LocalEngineStatusRow()

                LocalEnginePathsForm()

                if let message = error ?? store.thisMacError {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }

                HStack {
                    if local.ownsProcess && local.isProcessRunning {
                        Button("Stop Engine", role: .destructive) { local.stop() }
                    }
                    Spacer()
                    Button(action: startAndPair) {
                        HStack(spacing: 8) {
                            if working { ProgressView().controlSize(.small) }
                            Text(primaryTitle)
                        }
                        .frame(minWidth: 160)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(working)
                    .keyboardShortcut(.defaultAction)
                }

                if !local.logLines.isEmpty {
                    LocalEngineLogView()
                        .frame(height: 170)
                }
            }
            .padding(24)
        }
        .navigationTitle("This Mac")
        .task { await local.refresh(expectedConnection: store.localConnection) }
    }

    private var primaryTitle: String {
        if working { return local.state == .starting ? "Starting…" : "Connecting…" }
        if local.runningURL != nil { return "Connect" }
        return "Start Local Engine"
    }

    private func startAndPair() {
        working = true
        error = nil
        store.thisMacError = nil
        Task {
            defer { working = false }
            do {
                let existing = store.localConnection
                try await local.start(expectedConnection: existing)
                if let existing { try await local.waitForExpectedEngine(existing) }
                else { _ = try await local.waitForPairingInfo() }
                try await store.connectThisMac(expectedConnection: existing)
                onPaired()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

struct LocalEngineStatusRow: View {
    @EnvironmentObject private var local: LocalEngineController
    @EnvironmentObject private var store: ConnectionStore

    var body: some View {
        HStack(spacing: 10) {
            StatusDot(color: color, size: 9)
            Text(label)
                .font(.callout.weight(.medium))
            Spacer()
            if local.state == .checking || local.state == .starting {
                ProgressView().controlSize(.small)
            } else {
                Button {
                    Task { await local.refresh(expectedConnection: store.localConnection) }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Check again")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .cardSurface(cornerRadius: 14)
    }

    private var color: Color {
        switch local.state {
        case .running: return .green
        case .starting, .checking: return .orange
        case .failed: return .red
        case .notRunning, .unknown: return .gray
        }
    }

    private var label: String {
        switch local.state {
        case .unknown, .checking: return "Looking for Tupies on this Mac…"
        case .running(let url): return "Running at \(url.hostLabel)" + (local.ownsProcess ? " · started by this app" : "")
        case .notRunning: return "Not running"
        case .starting: return "Starting…"
        case .failed(let message): return message
        }
    }
}

struct LocalEnginePathsForm: View {
    @EnvironmentObject private var local: LocalEngineController

    var body: some View {
        if local.canUseBundledEngine {
            VStack(alignment: .leading, spacing: 10) {
                Label(local.usesBundledEngine ? "Engine included with Tupies" : "Using a developer engine", systemImage: local.usesBundledEngine ? "shippingbox" : "hammer")
                    .font(.callout)
                DisclosureGroup("Advanced engine settings") {
                    paths
                        .padding(.top, 8)
                    if !local.usesBundledEngine {
                        Button("Use the included engine") { local.useBundledEngine() }
                            .padding(.top, 6)
                    }
                }
            }
        } else {
            paths
        }
    }

    private var paths: some View {
        Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 10) {
            GridRow {
                Text("Tupies folder")
                    .foregroundStyle(.secondary)
                TextField("~/Documents/Personal/hermes-studio", text: $local.studioFolder)
                    .textFieldStyle(.roundedBorder)
                Button("Choose…") { choose(directory: true) }
            }
            GridRow {
                Text("Node.js")
                    .foregroundStyle(.secondary)
                TextField("/opt/homebrew/bin/node", text: $local.nodePath)
                    .textFieldStyle(.roundedBorder)
                Button("Choose…") { choose(directory: false) }
            }
        }
        .font(.callout)
    }

    private func choose(directory: Bool) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = directory
        panel.canChooseFiles = !directory
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = !directory
        panel.prompt = "Choose"
        panel.message = directory ? "Choose your Tupies folder (it contains server.mjs)." : "Choose the node executable (Node 22 or newer)."
        let current = (directory ? local.studioFolder : local.nodePath) as NSString
        panel.directoryURL = URL(fileURLWithPath: directory ? current.expandingTildeInPath : current.deletingLastPathComponent)
        if panel.runModal() == .OK, let url = panel.url {
            if directory { local.studioFolder = url.path } else { local.nodePath = url.path }
        }
    }
}

struct LocalEngineLogView: View {
    @EnvironmentObject private var local: LocalEngineController

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(local.logLines.joined(separator: "\n"))
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                Color.clear.frame(height: 1).id("bottom")
            }
            .background(Color.black.opacity(0.04), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.separator))
            .onChange(of: local.logLines.count) { _, _ in
                proxy.scrollTo("bottom", anchor: .bottom)
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }
}

/// Sheet with the full log tail, opened from Settings.
struct LocalEngineLogSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Local Engine Log")
                    .font(.headline)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            LocalEngineLogView()
        }
        .padding(20)
        .frame(minWidth: 620, minHeight: 420)
    }
}
#endif
