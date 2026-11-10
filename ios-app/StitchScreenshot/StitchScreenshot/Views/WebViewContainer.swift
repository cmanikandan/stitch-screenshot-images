import SwiftUI
import WebKit

/// Hosts the `WebCaptureService`'s `WKWebView` inside SwiftUI.
struct WebViewContainer: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView {
        webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        // State and navigation are driven directly by WebCaptureService.
    }
}
