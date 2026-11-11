import Foundation
import Observation
import UIKit

/// Supported pure-image export formats.
nonisolated enum ImageExportFormat: String, CaseIterable, Identifiable, Codable, Sendable {
    case png
    case jpeg

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .png: "PNG"
        case .jpeg: "JPEG"
        }
    }

    var fileExtension: String {
        switch self {
        case .png: "png"
        case .jpeg: "jpg"
        }
    }

    var mimeType: String {
        switch self {
        case .png: "image/png"
        case .jpeg: "image/jpeg"
        }
    }
}

/// A captured page held in the manual multi-page staging tray.
nonisolated struct StagedPage: Identifiable, Sendable {
    let id: UUID
    let url: URL?
    let title: String
    let image: UIImage
    let capturedAt: Date

    init(
        id: UUID = UUID(),
        url: URL?,
        title: String,
        image: UIImage,
        capturedAt: Date = Date()
    ) {
        self.id = id
        self.url = url
        self.title = title
        self.image = image
        self.capturedAt = capturedAt
    }
}

/// Result wrapper handed to the pure-image preview and export sheet.
nonisolated struct CapturedImageResult: Identifiable, Sendable {
    let id: UUID
    let image: UIImage
    let pageCount: Int
    let sourceURL: URL?

    init(
        id: UUID = UUID(),
        image: UIImage,
        pageCount: Int = 1,
        sourceURL: URL? = nil
    ) {
        self.id = id
        self.image = image
        self.pageCount = pageCount
        self.sourceURL = sourceURL
    }
}

/// Supported incoming URL scheme actions (`stitchscreenshot://capture?url=...`).
nonisolated enum DeepLinkAction: Equatable, Sendable {
    case capture(URL)
}

/// Parses app deep links and normalizes user-entered web URLs.
nonisolated enum DeepLinkParser {
    static let scheme = "stitchscreenshot"

    static func parse(_ url: URL) -> DeepLinkAction? {
        guard url.scheme?.lowercased() == scheme else {
            return nil
        }

        let host = url.host?.lowercased()
        let path = url.path.lowercased()
        guard host == "capture" || path == "/capture" || path == "capture" else {
            return nil
        }

        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let rawTarget = components.queryItems?.first(where: { $0.name == "url" })?.value,
              let targetURL = normalizeWebURL(rawTarget)
        else {
            return nil
        }

        return .capture(targetURL)
    }

    static func buildCaptureDeepLink(for targetURL: URL) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = "capture"
        components.queryItems = [URLQueryItem(name: "url", value: targetURL.absoluteString)]
        return components.url
    }

    static func normalizeWebURL(_ rawInput: String) -> URL? {
        let trimmed = rawInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let url = URL(string: trimmed),
           let scheme = url.scheme?.lowercased(),
           (scheme == "http" || scheme == "https"),
           url.host?.isEmpty == false {
            return url
        }

        if !trimmed.contains("://"),
           trimmed.contains("."),
           !trimmed.contains(" "),
           let url = URL(string: "https://\(trimmed)"),
           url.host?.isEmpty == false {
            return url
        }

        return nil
    }

    /// Extracts the first `http` or `https` URL found inside shared plain text.
    static func extractFirstWebURL(from text: String) -> URL? {
        if let direct = normalizeWebURL(text) {
            return direct
        }
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return nil
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        for match in detector.matches(in: text, options: [], range: range) {
            if let url = match.url,
               let scheme = url.scheme?.lowercased(),
               scheme == "http" || scheme == "https" {
                return url
            }
        }
        return nil
    }
}

/// Persistent app configuration backed by UserDefaults.
@MainActor
@Observable
final class AppSettingsStore {
    private enum Keys {
        static let outputFormat = "stitch.outputFormat"
        static let jpegQuality = "stitch.jpegQuality"
        static let autoCleanClutter = "stitch.autoCleanClutter"
        static let maxAutoPages = "stitch.maxAutoPages"
    }

    private let defaults: UserDefaults

    var outputFormat: ImageExportFormat {
        didSet { defaults.set(outputFormat.rawValue, forKey: Keys.outputFormat) }
    }

    var jpegQuality: Double {
        didSet { defaults.set(jpegQuality, forKey: Keys.jpegQuality) }
    }

    var autoCleanClutter: Bool {
        didSet { defaults.set(autoCleanClutter, forKey: Keys.autoCleanClutter) }
    }

    var maxAutoPages: Int {
        didSet { defaults.set(maxAutoPages, forKey: Keys.maxAutoPages) }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let rawFormat = defaults.string(forKey: Keys.outputFormat),
           let format = ImageExportFormat(rawValue: rawFormat) {
            self.outputFormat = format
        } else {
            self.outputFormat = .png
        }

        let storedQuality = defaults.object(forKey: Keys.jpegQuality) as? Double
        self.jpegQuality = storedQuality ?? 0.92

        if defaults.object(forKey: Keys.autoCleanClutter) != nil {
            self.autoCleanClutter = defaults.bool(forKey: Keys.autoCleanClutter)
        } else {
            self.autoCleanClutter = true
        }

        let storedMaxPages = defaults.integer(forKey: Keys.maxAutoPages)
        self.maxAutoPages = storedMaxPages > 0 ? min(max(storedMaxPages, 2), 15) : 5
    }
}
