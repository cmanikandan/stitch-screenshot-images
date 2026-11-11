import Foundation
import SwiftUI

@main
struct StitchScreenshotApp: App {
    @State private var captureService = WebCaptureService()
    @State private var settings = AppSettingsStore()

    var body: some Scene {
        WindowGroup {
            ContentView(captureService: captureService, settings: settings)
                .onOpenURL { incomingURL in
                    handleIncomingURL(incomingURL)
                }
        }
    }

    private func handleIncomingURL(_ url: URL) {
        if case let .capture(targetURL)? = DeepLinkParser.parse(url) {
            if captureService.isCapturing {
                captureService.cancelCapture()
            }
            captureService.load(url: targetURL)
        } else if let directWebURL = DeepLinkParser.normalizeWebURL(url.absoluteString) {
            if captureService.isCapturing {
                captureService.cancelCapture()
            }
            captureService.load(url: directWebURL)
        }
    }
}
