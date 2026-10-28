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

    private var hasCamera: Bool { AVCaptureDevice.default(for: .video) != nil }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if !hasCamera {
                message(
                    systemImage: "camera.metering.unknown",
                    title: "No camera available",
                    detail: "This device can’t scan QR codes. Paste the pairing link instead."
                )
            } else {
                switch permission {
                case .authorized:
                    scanner
                        .ignoresSafeArea()
                    ScanFrameOverlay()
                        .allowsHitTesting(false)
                case .notDetermined:
                    ProgressView().tint(.white)
                default:
                    message(
                        systemImage: "camera.fill",
                        title: "Camera access is off",
                        detail: "Allow camera access for Tupies in Settings to scan pairing codes.",
                        showSettings: true
                    )
                }
            }

            VStack {
                Spacer()
                VStack(spacing: 12) {
                    if let error = error {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(.red.opacity(0.85), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    } else if permission == .authorized && hasCamera {
                        Text("Point at the QR code shown in Tupies")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.white)
                            .shadow(radius: 4)
                    }
                    Button(action: onPasteInstead) {
                        Label("Paste link instead", systemImage: "link")
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 18)
                            .padding(.vertical, 11)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.white)
                    .glassSurface(Capsule(), interactive: true)
                }
                .padding(.bottom, 28)
                .padding(.horizontal, 24)
            }
        }
        .navigationTitle("Scan QR Code")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.hidden, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .task {
            if permission == .notDetermined {
                _ = await AVCaptureDevice.requestAccess(for: .video)
                permission = AVCaptureDevice.authorizationStatus(for: .video)
            }
        }
        .onAppear { handled = false }
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
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            onLink(link)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func message(systemImage: String, title: String, detail: String, showSettings: Bool = false) -> some View {
        VStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 40, weight: .light))
            Text(title)
                .font(.title3.weight(.semibold))
            Text(detail)
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(.white.opacity(0.75))
            if showSettings, let url = URL(string: UIApplication.openSettingsURLString) {
                Button("Open Settings") { UIApplication.shared.open(url) }
                    .buttonStyle(.borderedProminent)
                    .padding(.top, 6)
            }
        }
        .foregroundStyle(.white)
        .padding(32)
    }
}

/// Rounded viewfinder corners.
private struct ScanFrameOverlay: View {
    var body: some View {
        GeometryReader { proxy in
            let side = min(proxy.size.width, proxy.size.height) * 0.62
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .strokeBorder(.white.opacity(0.9), style: StrokeStyle(lineWidth: 4, lineCap: .round, dash: [side * 0.18, side * 0.82], dashPhase: side * 0.09))
                .frame(width: side, height: side)
                .position(x: proxy.size.width / 2, y: proxy.size.height * 0.45)
                .shadow(color: .black.opacity(0.3), radius: 8)
        }
        .ignoresSafeArea()
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
