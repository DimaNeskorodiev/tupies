import WebKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Native presentations for `alert()`, `confirm()` and `prompt()` from the engine page.
@MainActor
enum JavaScriptPanels {
    static func alert(message: String, title: String, in webView: WKWebView, completion: @escaping () -> Void) {
        #if os(iOS)
        let controller = UIAlertController(title: title, message: message, preferredStyle: .alert)
        controller.addAction(UIAlertAction(title: "OK", style: .default) { _ in completion() })
        present(controller, from: webView, otherwise: completion)
        #else
        let panel = NSAlert()
        panel.messageText = title
        panel.informativeText = message
        panel.addButton(withTitle: "OK")
        run(panel, in: webView) { _ in completion() }
        #endif
    }

    static func confirm(message: String, title: String, in webView: WKWebView, completion: @escaping (Bool) -> Void) {
        #if os(iOS)
        let controller = UIAlertController(title: title, message: message, preferredStyle: .alert)
        controller.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completion(false) })
        controller.addAction(UIAlertAction(title: "OK", style: .default) { _ in completion(true) })
        present(controller, from: webView) { completion(false) }
        #else
        let panel = NSAlert()
        panel.messageText = title
        panel.informativeText = message
        panel.addButton(withTitle: "OK")
        panel.addButton(withTitle: "Cancel")
        run(panel, in: webView) { completion($0 == .alertFirstButtonReturn) }
        #endif
    }

    static func prompt(message: String, defaultText: String?, title: String, in webView: WKWebView, completion: @escaping (String?) -> Void) {
        #if os(iOS)
        let controller = UIAlertController(title: title, message: message, preferredStyle: .alert)
        controller.addTextField { $0.text = defaultText }
        controller.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completion(nil) })
        controller.addAction(UIAlertAction(title: "OK", style: .default) { [weak controller] _ in
            completion(controller?.textFields?.first?.text ?? "")
        })
        present(controller, from: webView) { completion(nil) }
        #else
        let panel = NSAlert()
        panel.messageText = title
        panel.informativeText = message
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        panel.accessoryView = field
        panel.addButton(withTitle: "OK")
        panel.addButton(withTitle: "Cancel")
        run(panel, in: webView) { completion($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
        #endif
    }

    #if os(iOS)
    private static func present(_ controller: UIViewController, from webView: WKWebView, otherwise fallback: @escaping () -> Void) {
        guard var presenter = webView.window?.rootViewController else {
            fallback()
            return
        }
        while let next = presenter.presentedViewController { presenter = next }
        presenter.present(controller, animated: true)
    }
    #else
    private static func run(_ panel: NSAlert, in webView: WKWebView, completion: @escaping (NSApplication.ModalResponse) -> Void) {
        if let window = webView.window {
            panel.beginSheetModal(for: window, completionHandler: completion)
        } else {
            completion(panel.runModal())
        }
    }
    #endif
}
