#if os(iOS)
import AVFoundation
import SwiftUI
import UIKit
import VisionKit

/// Camera screen that scans a Tupies pairing QR code.
struct QRScannerScreen: View {
    let onLink: (PairingLink) -> Void
    let onPasteInstead: () -> Void

    @State private var permission = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var error: String?
    @State private var handled = false
    @State private var scanned = false
    @State private var rejections = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var hasCamera: Bool { AVCaptureDevice.default(for: .video) != nil }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if !hasCamera {
                unavailable(
                    "No camera available",
                    systemImage: "camera.metering.unknown",
                    detail: "This device can’t scan QR codes. Paste the pairing link instead."
                )
            } else {
                switch permission {
                case .authorized:
                    scanner
                        .ignoresSafeArea()
                    ScanFrameOverlay(scanned: scanned)
                        .allowsHitTesting(false)
                case .notDetermined:
                    ProgressView()
                        .tint(.white)
                        .accessibilityLabel("Waiting for camera access")
                default:
                    unavailable(
                        "Camera access is off",
                        systemImage: "camera.fill",
                        detail: "Allow camera access for Tupies in Settings to scan pairing codes.",
                        showSettings: true
                    )
                }
            }

            VStack {
                Spacer()
                VStack(spacing: 14) {
                    if let error = error {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(.white)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(.red.opacity(0.85), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    } else if permission == .authorized && hasCamera {
                        Text(scanned ? "Found it" : "Point at the QR code shown in Tupies")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.white)
                            .shadow(color: .black.opacity(0.5), radius: 4)
                            .contentTransition(.opacity)
                    }
                    Button(action: onPasteInstead) {
                        Label("Paste link instead", systemImage: "link")
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 18)
                            .padding(.vertical, 12)
                            .frame(minHeight: 44)
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.white)
                    .glassSurface(Capsule(), interactive: true)
                    .environment(\.colorScheme, .dark)
                }
                .padding(.bottom, 28)
                .padding(.horizontal, 24)
                .animation(.snappy, value: error)
                .animation(.smooth, value: scanned)
            }
        }
        .navigationTitle("Scan QR Code")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.hidden, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .sensoryFeedback(.success, trigger: scanned) { _, new in new }
        .sensoryFeedback(.error, trigger: rejections)
        .task {
            if permission == .notDetermined {
                _ = await AVCaptureDevice.requestAccess(for: .video)
                permission = AVCaptureDevice.authorizationStatus(for: .video)
            }
        }
        .onAppear {
            handled = false
            scanned = false
        }
    }

    @ViewBuilder
    private var scanner: some View {
        if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
            DataScannerRepresentable(onCode: handle)
        } else {
            CaptureScannerRepresentable(onCode: handle)
        }
    }

    private func handle(_ payload: String) {
        guard !handled else { return }
        do {
            let link = try PairingLink.parse(payload)
            handled = true
            error = nil
            scanned = true
            // Let the frame turn green before moving on.
            Task {
                try? await Task.sleep(nanoseconds: reduceMotion ? 150_000_000 : 400_000_000)
                onLink(link)
            }
        } catch {
            let message = error.localizedDescription
            if self.error != message { rejections += 1 }
            self.error = message
        }
    }

    private func unavailable(_ title: String, systemImage: String, detail: String, showSettings: Bool = false) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(detail)
        } actions: {
            if showSettings, let url = URL(string: UIApplication.openSettingsURLString) {
                Button("Open Settings") { UIApplication.shared.open(url) }
                    .primaryActionStyle()
            }
        }
        .environment(\.colorScheme, .dark)
    }
}

/// Viewfinder corners that breathe while scanning and turn green on a valid code.
private struct ScanFrameOverlay: View {
    let scanned: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { proxy in
            let side = min(proxy.size.width, proxy.size.height) * 0.62
            corners(side: side)
                .position(x: proxy.size.width / 2, y: proxy.size.height * 0.45)
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func corners(side: CGFloat) -> some View {
        let shape = ViewfinderCorners(length: side * 0.2, radius: 28)
            .stroke(scanned ? Color.green : .white, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
            .frame(width: side, height: side)
            .shadow(color: .black.opacity(0.35), radius: 8)
            .scaleEffect(scanned && !reduceMotion ? 0.94 : 1)
            .animation(.bouncy(duration: 0.4), value: scanned)
        if reduceMotion || scanned {
            shape
        } else {
            shape.phaseAnimator([false, true]) { view, breathing in
                view.opacity(breathing ? 1 : 0.7).scaleEffect(breathing ? 1.0 : 1.03)
            } animation: { _ in
                .easeInOut(duration: 1.3)
            }
        }
    }
}

/// Four rounded corner brackets of a square.
private struct ViewfinderCorners: Shape {
    let length: CGFloat
    let radius: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let r = min(radius, length)
        // Top left
        path.move(to: CGPoint(x: rect.minX, y: rect.minY + length))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r))
        path.addQuadCurve(to: CGPoint(x: rect.minX + r, y: rect.minY), control: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX + length, y: rect.minY))
        // Top right
        path.move(to: CGPoint(x: rect.maxX - length, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + r), control: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + length))
        // Bottom right
        path.move(to: CGPoint(x: rect.maxX, y: rect.maxY - length))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
        path.addQuadCurve(to: CGPoint(x: rect.maxX - r, y: rect.maxY), control: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.maxX - length, y: rect.maxY))
        // Bottom left
        path.move(to: CGPoint(x: rect.minX + length, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
        path.addQuadCurve(to: CGPoint(x: rect.minX, y: rect.maxY - r), control: CGPoint(x: rect.minX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY - length))
        return path
    }
}

// MARK: - VisionKit

private struct DataScannerRepresentable: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: false,
            isHighlightingEnabled: true
        )
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {
        context.coordinator.onCode = onCode
        if !controller.isScanning {
            try? controller.startScanning()
        }
    }

    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
        controller.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onCode: (String) -> Void
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in addedItems {
                if case .barcode(let barcode) = item, let payload = barcode.payloadStringValue {
                    onCode(payload)
                    return
                }
            }
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
            if case .barcode(let barcode) = item, let payload = barcode.payloadStringValue {
                onCode(payload)
            }
        }
    }
}

// MARK: - AVFoundation fallback

private struct CaptureScannerRepresentable: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> CaptureScannerController {
        let controller = CaptureScannerController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: CaptureScannerController, context: Context) {
        controller.onCode = onCode
    }
}

final class CaptureScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let sessionQueue = DispatchQueue(label: "dev.hermesstudio.app.scanner")

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        if output.availableMetadataObjectTypes.contains(.qr) {
            output.metadataObjectTypes = [.qr]
        }
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        previewLayer = layer
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let session = self.session
        sessionQueue.async { if !session.isRunning { session.startRunning() } }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let session = self.session
        sessionQueue.async { if session.isRunning { session.stopRunning() } }
    }

    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        let payload = metadataObjects
            .compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }
            .first
        guard let payload = payload else { return }
        MainActor.assumeIsolated {
            self.onCode?(payload)
        }
    }
}
#endif
