import Foundation
import UIKit
import XCTest
@testable import StitchScreenshot

final class StitchScreenshotTests: XCTestCase {
    private var testDefaults: UserDefaults!
    private var defaultsSuiteName: String!

    override func setUpWithError() throws {
        defaultsSuiteName = "StitchScreenshotTests-\(UUID().uuidString)"
        testDefaults = UserDefaults(suiteName: defaultsSuiteName)
    }

    override func tearDownWithError() throws {
        if let defaultsSuiteName {
            UserDefaults().removePersistentDomain(forName: defaultsSuiteName)
        }
        testDefaults = nil
    }

    // MARK: - ImageStitcher Tests

    func testStitchVerticallyThrowsOnEmptyArray() {
        XCTAssertThrowsError(try ImageStitcher.stitchVertically([])) { error in
            XCTAssertEqual(error as? ImageStitcherError, .emptyImages)
        }
    }

    func testStitchVerticallyCombinesDimensionsAndPreservesColors() throws {
        let top = makeSolidImage(width: 100, height: 200, color: .red)
        let bottom = makeSolidImage(width: 100, height: 300, color: .blue)

        let stitched = try ImageStitcher.stitchVertically([top, bottom])
        let size = ImageStitcher.pixelSize(of: stitched)

        XCTAssertEqual(size.width, 100)
        XCTAssertEqual(size.height, 500)

        let topPixel = try XCTUnwrap(pixelRGBA(in: stitched, x: 50, y: 50))
        XCTAssertGreaterThan(topPixel.r, 220)
        XCTAssertLessThan(topPixel.b, 30)

        let bottomPixel = try XCTUnwrap(pixelRGBA(in: stitched, x: 50, y: 350))
        XCTAssertGreaterThan(bottomPixel.b, 220)
        XCTAssertLessThan(bottomPixel.r, 30)
    }

    func testStitchVerticallyScalesMismatchedWidthsProportionally() throws {
        let wide = makeSolidImage(width: 200, height: 100, color: .green)
        let narrow = makeSolidImage(width: 100, height: 100, color: .yellow)

        let stitched = try ImageStitcher.stitchVertically([wide, narrow])
        let size = ImageStitcher.pixelSize(of: stitched)

        XCTAssertEqual(size.width, 200)
        XCTAssertEqual(size.height, 300) // 100 + (100 * 2)
    }

    func testStitchVerticallyRespectsMaxPixelHeightCap() throws {
        let slice1 = makeSolidImage(width: 120, height: 400, color: .red)
        let slice2 = makeSolidImage(width: 120, height: 400, color: .blue)
        let config = StitchConfiguration(maxPixelWidth: 1000, maxPixelHeight: 400)

        let stitched = try ImageStitcher.stitchVertically([slice1, slice2], configuration: config)
        let size = ImageStitcher.pixelSize(of: stitched)

        XCTAssertEqual(size.height, 400)
        XCTAssertEqual(size.width, 60)
    }

    func testCropTopAndBottomOverlap() throws {
        let image = makeSolidImage(width: 100, height: 250, color: .purple)
        let cropped = try XCTUnwrap(ImageStitcher.cropTopAndBottomOverlap(image, topCropPixels: 50, bottomCropPixels: 25))
        let dims = ImageStitcher.pixelSize(of: cropped)

        XCTAssertEqual(dims.width, 100)
        XCTAssertEqual(dims.height, 175)
        XCTAssertNil(ImageStitcher.cropTopAndBottomOverlap(image, topCropPixels: 250))
    }

    func testEncodePNGAndJPEGHeaders() throws {
        let image = makeSolidImage(width: 32, height: 32, color: .orange)

        let pngData = try ImageStitcher.encode(image, format: .png)
        XCTAssertEqual(Array(pngData.prefix(4)), [0x89, 0x50, 0x4E, 0x47])

        let jpegData = try ImageStitcher.encode(image, format: .jpeg, jpegQuality: 0.9)
        XCTAssertEqual(Array(jpegData.prefix(2)), [0xFF, 0xD8])
    }

    // MARK: - GeminiService Tests

    func testGeminiBuildRequestIncludesRequiredHeadersAndModel() throws {
        let service = GeminiService(
            transport: MockHTTPTransport { _ in fatalError("Not called") },
            keychain: InMemoryKeychain(key: "test-secret-key"),
            selectorCache: DomainSelectorCache(defaults: testDefaults)
        )

        let schema: [String: JSONValue] = [
            "type": .string("object"),
            "properties": .object(["selectors": .object(["type": .string("array")])])
        ]
        let request = try service.buildRequest(
            prompt: "Find clutter",
            responseFormat: schema,
            apiKey: "test-secret-key"
        )

        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "https://generativelanguage.googleapis.com/v1beta/interactions")
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-goog-api-key"), "test-secret-key")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Api-Revision"), "2026-05-20")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")

        let bodyData = try XCTUnwrap(request.httpBody)
        let decodedBody = try JSONDecoder().decode(GeminiInteractionsRequest.self, from: bodyData)
        XCTAssertEqual(decodedBody.model, "gemini-3.8-flash")
        XCTAssertEqual(decodedBody.input, "Find clutter")
        XCTAssertEqual(decodedBody.responseFormat, schema)
    }

    func testGeminiDecodesStepsModelOutputWithCodeFences() throws {
        let service = GeminiService(
            transport: MockHTTPTransport { _ in fatalError("Not called") },
            keychain: InMemoryKeychain(key: "k"),
            selectorCache: DomainSelectorCache(defaults: testDefaults)
        )

        let json = """
        {
          "id": "int_123",
          "status": "completed",
          "steps": [
            {
              "type": "model_output",
              "content": "```json\\n{\\"selectors\\": [\\".cookie-banner\\", \\"#chat-widget\\"]}\\n```"
            }
          ]
        }
        """
        let decoded = try service.decodeStructuredOutput(ClutterSelectorsResult.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.selectors, [".cookie-banner", "#chat-widget"])
    }

    func testGeminiDecodesStepsContentPartsAndOutputsFallback() throws {
        let service = GeminiService(
            transport: MockHTTPTransport { _ in fatalError("Not called") },
            keychain: InMemoryKeychain(key: "k"),
            selectorCache: DomainSelectorCache(defaults: testDefaults)
        )

        let partsJSON = """
        {
          "steps": [
            {
              "type": "model_output",
              "content": [
                { "type": "text", "text": "{\\"next_page_url\\": \\"https://example.com/page/2\\", \\"confidence\\": 0.95}" }
              ]
            }
          ]
        }
        """
        let fromParts = try service.decodeStructuredOutput(NextPageResult.self, from: Data(partsJSON.utf8))
        XCTAssertEqual(fromParts.nextPageURL, "https://example.com/page/2")
        XCTAssertEqual(fromParts.confidence, 0.95)

        let outputsJSON = """
        {
          "outputs": [
            { "type": "text", "text": "{\\"selectors\\": [\\"#newsletter-modal\\"]}" }
          ]
        }
        """
        let fromOutputs = try service.decodeStructuredOutput(ClutterSelectorsResult.self, from: Data(outputsJSON.utf8))
        XCTAssertEqual(fromOutputs.selectors, ["#newsletter-modal"])
    }

    func testGeminiDetectClutterSelectorsCachesPerDomain() async throws {
        var requestCount = 0
        let transport = MockHTTPTransport { request in
            requestCount += 1
            let payload = """
            {
              "steps": [
                { "type": "model_output", "content": "{\\"selectors\\": [\\"#cookie-wall\\"]}" }
              ]
            }
            """
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (Data(payload.utf8), response)
        }

        let cache = DomainSelectorCache(defaults: testDefaults)
        let service = GeminiService(
            transport: transport,
            keychain: InMemoryKeychain(key: "api-key-123"),
            selectorCache: cache
        )

        let input = DOMSummaryInput(
            url: "https://news.example.com/story",
            domain: "news.example.com",
            candidates: [
                ClutterCandidate(
                    selector: "#cookie-wall",
                    tagName: "div",
                    position: "fixed",
                    zIndex: "9999",
                    rectSummary: "0,700,390x144",
                    textSnippet: "Accept cookies",
                    ariaLabel: "Cookie banner",
                    id: "cookie-wall",
                    className: "cookie-banner"
                )
            ]
        )

        let first = try await service.detectClutterSelectors(domSummary: input)
        let second = try await service.detectClutterSelectors(domSummary: input)

        XCTAssertEqual(first, ["#cookie-wall"])
        XCTAssertEqual(second, ["#cookie-wall"])
        XCTAssertEqual(requestCount, 1)
        XCTAssertEqual(cache.cachedDomainCount, 1)
    }

    func testGeminiDetectNextPageURLResolvesRelativeURL() async throws {
        let transport = MockHTTPTransport { request in
            let payload = """
            {
              "outputs": [
                { "text": "{\\"next_page_url\\": \\"/articles/swift?page=2\\", \\"confidence\\": 0.92}" }
              ]
            }
            """
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (Data(payload.utf8), response)
        }

        let service = GeminiService(
            transport: transport,
            keychain: InMemoryKeychain(key: "api-key-123"),
            selectorCache: DomainSelectorCache(defaults: testDefaults)
        )

        let context = PageNavigationContext(
            url: "https://blog.example.com/articles/swift?page=1",
            title: "Swift Guide",
            relNextURL: nil,
            links: [
                PageLinkCandidate(text: "Next Page", href: "/articles/swift?page=2", rel: "", ariaLabel: "", className: "next")
            ]
        )

        let resolved = try await service.detectNextPageURL(pageContext: context)
        XCTAssertEqual(resolved?.absoluteString, "https://blog.example.com/articles/swift?page=2")
    }

    // MARK: - DeepLinkParser & PaginationHeuristic Tests

    func testDeepLinkParserRoundTripAndValidation() throws {
        let target = try XCTUnwrap(URL(string: "https://example.com/article?page=1&sort=asc"))
        let deepLink = try XCTUnwrap(DeepLinkParser.buildCaptureDeepLink(for: target))

        XCTAssertEqual(DeepLinkParser.parse(deepLink), .capture(target))
        XCTAssertNil(DeepLinkParser.parse(URL(string: "https://example.com")!))
        XCTAssertNil(DeepLinkParser.parse(URL(string: "stitchscreenshot://unknown?url=https://example.com")!))

        XCTAssertEqual(
            DeepLinkParser.normalizeWebURL("developer.apple.com")?.absoluteString,
            "https://developer.apple.com"
        )
        XCTAssertEqual(
            DeepLinkParser.extractFirstWebURL(from: "Check out https://swift.org/blog/ today!")?.absoluteString,
            "https://swift.org/blog/"
        )
    }

    func testPaginationHeuristicPrefersRelNextAndNextPageLinks() {
        let withRelNext = PageNavigationContext(
            url: "https://example.com/post?page=1",
            title: "Post",
            relNextURL: "/post?page=2",
            links: [
                PageLinkCandidate(text: "Older", href: "/post?page=3", rel: "", ariaLabel: "", className: "")
            ]
        )
        XCTAssertEqual(
            PaginationHeuristic.findNextPageURL(in: withRelNext)?.absoluteString,
            "https://example.com/post?page=2"
        )

        let withoutRelNext = PageNavigationContext(
            url: "https://example.com/post?page=1",
            title: "Post",
            relNextURL: nil,
            links: [
                PageLinkCandidate(text: "Previous", href: "/post?page=0", rel: "", ariaLabel: "", className: "prev"),
                PageLinkCandidate(text: "Jump", href: "#comments", rel: "", ariaLabel: "", className: ""),
                PageLinkCandidate(text: "Next Page", href: "/post?page=2", rel: "", ariaLabel: "Next", className: "pagination-next")
            ]
        )
        XCTAssertEqual(
            PaginationHeuristic.findNextPageURL(in: withoutRelNext)?.absoluteString,
            "https://example.com/post?page=2"
        )
    }

    // MARK: - KeychainService Test

    func testKeychainSaveLoadDeleteLifecycle() throws {
        let service = KeychainService(
            service: "com.cmanikandan.stitchscreenshot.tests.\(UUID().uuidString)",
            account: "test-key"
        )
        defer { try? service.deleteAPIKey() }

        XCTAssertNil(service.loadAPIKey())
        try service.saveAPIKey("initial-key")
        XCTAssertEqual(service.loadAPIKey(), "initial-key")

        try service.saveAPIKey("updated-key")
        XCTAssertEqual(service.loadAPIKey(), "updated-key")

        try service.deleteAPIKey()
        XCTAssertNil(service.loadAPIKey())
    }

    // MARK: - Helpers

    private func makeSolidImage(width: Int, height: Int, color: UIColor) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1.0
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
        return renderer.image { ctx in
            color.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    private func pixelRGBA(in image: UIImage, x: Int, y: Int) -> (r: UInt8, g: UInt8, b: UInt8, a: UInt8)? {
        guard let cgImage = image.cgImage,
              x >= 0, y >= 0, x < cgImage.width, y < cgImage.height
        else { return nil }

        var pixel: [UInt8] = [0, 0, 0, 0]
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: &pixel,
            width: 1,
            height: 1,
            bitsPerComponent: 8,
            bytesPerRow: 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return nil
        }
        context.draw(cgImage, in: CGRect(x: -x, y: -(cgImage.height - 1 - y), width: cgImage.width, height: cgImage.height))
        return (pixel[0], pixel[1], pixel[2], pixel[3])
    }
}

private final class MockHTTPTransport: HTTPTransport, @unchecked Sendable {
    private let handler: (URLRequest) throws -> (Data, URLResponse)

    init(handler: @escaping (URLRequest) throws -> (Data, URLResponse)) {
        self.handler = handler
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try handler(request)
    }
}

private final class InMemoryKeychain: KeychainStoring, @unchecked Sendable {
    var key: String?

    init(key: String?) {
        self.key = key
    }

    func saveAPIKey(_ key: String) throws {
        self.key = key
    }

    func loadAPIKey() -> String? {
        key
    }

    func deleteAPIKey() throws {
        key = nil
    }
}
