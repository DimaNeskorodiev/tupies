import SwiftUI
import WebKit

/// Hosts an existing, long-lived WKWebView. Swapping the `webView` re-parents it
/// without recreating it, so each engine keeps its page state.
#if os(iOS)
struct WebViewHost: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WebContainerView {
        let container = WebContainerView()
        container.backgroundColor = .clear
        return container
    }

    func updateUIView(_ container: WebContainerView, context: Context) {
        guard webView.superview !== container else { return }
        container.subviews.forEach { $0.removeFromSuperview() }
        webView.removeFromSuperview()
        webView.frame = container.bounds
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(webView)
        container.applySystemAppearance()
    }
}

/// Keeps the page on the system's light/dark appearance even while the app's chrome is pinned to the page's own
/// appearance (`.preferredColorScheme`), so `prefers-color-scheme` in the page always tells the truth.
final class WebContainerView: UIView {
    private var registration: UITraitChangeRegistration?
    private weak var observedScene: UIWindowScene?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if let scene = window?.windowScene, scene !== observedScene {
            if let registration { observedScene?.unregisterForTraitChanges(registration) }
            observedScene = scene
            registration = scene.registerForTraitChanges([UITraitUserInterfaceStyle.self]) { [weak self] (_: UIWindowScene, _: UITraitCollection) in
                self?.applySystemAppearance()
            }
        }
        applySystemAppearance()
    }

    func applySystemAppearance() {
        guard let style = window?.windowScene?.traitCollection.userInterfaceStyle else { return }
        for case let webView as WKWebView in subviews where webView.overrideUserInterfaceStyle != style {
            webView.overrideUserInterfaceStyle = style
        }
    }
}

/// UIActivityViewController for downloaded files.
struct ShareSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
#else
struct WebViewHost: NSViewRepresentable {
    let webView: WKWebView

    func makeNSView(context: Context) -> NSView {
        NSView()
    }

    func updateNSView(_ container: NSView, context: Context) {
        guard webView.superview !== container else { return }
        container.subviews.forEach { $0.removeFromSuperview() }
        webView.removeFromSuperview()
        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)
    }
}
#endif

/// Sheet for same-origin `window.open` pages (previews, exports).
struct PopupWebSheet: View {
    let page: PopupPage
    let title: String
    let onClose: () -> Void

    var body: some View {
        NavigationStack {
            WebViewHost(webView: page.webView)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle(title)
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    #if os(iOS)
                    ToolbarItem(placement: .topBarTrailing) {
                        SheetCloseButton(action: onClose)
                    }
                    #else
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done", action: onClose)
                    }
                    #endif
                }
        }
        #if os(macOS)
        .frame(minWidth: 760, idealWidth: 900, minHeight: 520, idealHeight: 680)
        #endif
    }
}
