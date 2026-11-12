import CoreGraphics
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

    func testStitchVerticallyRetina3xImagesPreservesFullPixelResolution() throws {
        // 100x80 pt @3x = 300x240 px per slice
        let topRetina = makeSolidImage(width: 100, height: 80, scale: 3.0, color: .red)
        let bottomRetinaRaw = makeSolidImage(width: 100, height: 100, scale: 3.0, color: .blue)
        // Crop 60px (20pt @3x) overlap from top of second @3x slice -> 300x240 px remaining
        let bottomRetina = try XCTUnwrap(ImageStitcher.cropTopAndBottomOverlap(bottomRetinaRaw, topCropPixels: 60))

        XCTAssertEqual(ImageStitcher.pixelSize(of: topRetina).width, 300)
        XCTAssertEqual(ImageStitcher.pixelSize(of: topRetina).height, 240)
        XCTAssertEqual(ImageStitcher.pixelSize(of: bottomRetina).height, 240)

        let stitched = try ImageStitcher.stitchVertically([topRetina, bottomRetina])
        let stitchedSize = ImageStitcher.pixelSize(of: stitched)
        XCTAssertEqual(stitchedSize.width, 300)
        XCTAssertEqual(stitchedSize.height, 480)

        let upperSample = try XCTUnwrap(pixelRGBA(in: stitched, x: 150, y: 120))
        XCTAssertGreaterThan(upperSample.r, 220)
        XCTAssertLessThan(upperSample.b, 30)

        let lowerSample = try XCTUnwrap(pixelRGBA(in: stitched, x: 150, y: 360))
        XCTAssertGreaterThan(lowerSample.b, 220)
        XCTAssertLessThan(lowerSample.r, 30)
    }

    func testStitchVertically35SliceDownscaleEliminatesCumulativeRoundingDrift() throws {
        // 35 slices of 120x200 px (rawTotalHeight = 7000) downscaled to maxPixelHeight = 368 (each slice ~10.514 px).
        // Under naive per-slice `round(10.514) == 11`, 34 * 11 = 374 > 368, which previously crushed slice 35 to 1px!
        var slices: [UIImage] = []
        for idx in 0..<35 {
            let color: UIColor = (idx == 34) ? .blue : ((idx % 2 == 0) ? .red : .green)
            slices.append(makeSolidImage(width: 120, height: 200, color: color))
        }

        let config = StitchConfiguration(maxPixelWidth: 1000, maxPixelHeight: 368)
        let stitched = try ImageStitcher.stitchVertically(slices, configuration: config)
        let dims = ImageStitcher.pixelSize(of: stitched)
        XCTAssertEqual(dims.height, 368)

        // The 35th (blue) slice should occupy approximately the bottom 10-11 pixels (y = 358..367), not 1px.
        let nearBottomOfLastSlice = try XCTUnwrap(pixelRGBA(in: stitched, x: dims.width / 2, y: 366))
        let midOfLastSlice = try XCTUnwrap(pixelRGBA(in: stitched, x: dims.width / 2, y: 360))
        XCTAssertGreaterThan(nearBottomOfLastSlice.b, 200)
        XCTAssertLessThan(nearBottomOfLastSlice.r, 40)
        XCTAssertGreaterThan(midOfLastSlice.b, 200)
        XCTAssertLessThan(midOfLastSlice.r, 40)
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

    func testStitchScreenshotsWithAutoOverlapStripsStickyChromeAndOverlap() throws {
        // Simulate two 200x400 native app screenshots with:
        // - Top 40px sticky status/nav bar
        // - Bottom 32px sticky tab bar
        // - 328px scrollable viewport where Screenshot 2 scrolled down by 200px (128px overlap)
        let fullArticleHeight = 600
        let width = 200
        let screenHeight = 400
        let topBarHeight = 40
        let bottomBarHeight = 32
        let viewportHeight = screenHeight - topBarHeight - bottomBarHeight // 328

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1.0
        format.opaque = true

        // Render synthetic full article with distinct horizontal textured bands every 16px
        let articleImage = UIGraphicsImageRenderer(size: CGSize(width: width, height: fullArticleHeight), format: format).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: width, height: fullArticleHeight))
            for rowBand in 0..<(fullArticleHeight / 16) {
                for colBand in 0..<(width / 20) {
                    let r = CGFloat((rowBand * 37 + colBand * 53) % 220) / 255.0
                    let g = CGFloat((rowBand * 71 + colBand * 29) % 220) / 255.0
                    let b = CGFloat((rowBand * 19 + colBand * 97) % 220) / 255.0
                    UIColor(red: r, green: g, blue: b, alpha: 1.0).setFill()
                    ctx.fill(CGRect(x: colBand * 20 + 2, y: rowBand * 16 + 2, width: 16, height: 12))
                }
            }
        }

        func makeAppScreenshot(scrollOffsetY: Int) -> UIImage {
            UIGraphicsImageRenderer(size: CGSize(width: width, height: screenHeight), format: format).image { ctx in
                // Draw scrolled article slice in middle viewport
                if let cg = articleImage.cgImage?.cropping(to: CGRect(x: 0, y: scrollOffsetY, width: width, height: viewportHeight)) {
                    UIImage(cgImage: cg).draw(in: CGRect(x: 0, y: topBarHeight, width: width, height: viewportHeight))
                }
                // Draw static top bar
                UIColor(red: 0.1, green: 0.1, blue: 0.15, alpha: 1.0).setFill()
                ctx.fill(CGRect(x: 0, y: 0, width: width, height: topBarHeight))
                // Draw static bottom bar
                UIColor(red: 0.15, green: 0.15, blue: 0.2, alpha: 1.0).setFill()
                ctx.fill(CGRect(x: 0, y: screenHeight - bottomBarHeight, width: width, height: bottomBarHeight))
            }
        }

        let shot1 = makeAppScreenshot(scrollOffsetY: 0)
        let shot2 = makeAppScreenshot(scrollOffsetY: 200)

        let overlap = try XCTUnwrap(ImageStitcher.detectVerticalOverlap(topImage: shot1, bottomImage: shot2))
        XCTAssertEqual(overlap.bottomTrimOnTopImage, bottomBarHeight, accuracy: 4)
        XCTAssertEqual(overlap.topCropOnBottomImage, topBarHeight + (viewportHeight - 200), accuracy: 6)

        let stitched = try ImageStitcher.stitchScreenshotsWithAutoOverlap([shot1, shot2], detectOverlap: true)
        let stitchedDims = ImageStitcher.pixelSize(of: stitched)
        // Expected height: shot1 (400 - 32 bottom bar = 368) + shot2 unique tail (200 + 32 bottom bar = 232) = 600
        XCTAssertEqual(stitchedDims.width, width)
        XCTAssertEqual(stitchedDims.height, 600, accuracy: 8)
    }

    func testEncodePNGAndJPEGHeadersAndPrunesStaleTempFiles() throws {
        let image = makeSolidImage(width: 32, height: 32, color: .orange)

        let pngData = try ImageStitcher.encode(image, format: .png)
        XCTAssertEqual(Array(pngData.prefix(4)), [0x89, 0x50, 0x4E, 0x47])

        let jpegData = try ImageStitcher.encode(image, format: .jpeg, jpegQuality: 0.9)
        XCTAssertEqual(Array(jpegData.prefix(2)), [0xFF, 0xD8])

        let tempSubdir = FileManager.default.temporaryDirectory
            .appendingPathComponent("StitchPruneTest-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempSubdir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempSubdir) }

        let staleFile = tempSubdir.appendingPathComponent("StitchScreenshot-old.png")
        let freshFile = tempSubdir.appendingPathComponent("StitchScreenshot-fresh.png")
        try pngData.write(to: staleFile)
        try pngData.write(to: freshFile)

        let twoHoursAgo = Date().addingTimeInterval(-7200)
        try FileManager.default.setAttributes([.modificationDate: twoHoursAgo], ofItemAtPath: staleFile.path)

        ImageStitcher.pruneTemporaryImageFiles(in: tempSubdir, olderThan: 3600, now: Date())
        XCTAssertFalse(FileManager.default.fileExists(atPath: staleFile.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: freshFile.path))
    }

    // MARK: - GeminiService, Sanitizer & Cache Tests

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
        XCTAssertEqual(decodedBody.responseFormat.type, "text")
        XCTAssertEqual(decodedBody.responseFormat.mimeType, "application/json")
        XCTAssertEqual(decodedBody.responseFormat.schema, schema)

        let rawJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: bodyData) as? [String: Any])
        XCTAssertNil(rawJSON["generation_config"])
        let rawResponseFormat = try XCTUnwrap(rawJSON["response_format"] as? [String: Any])
        XCTAssertEqual(rawResponseFormat["type"] as? String, "text")
        XCTAssertEqual(rawResponseFormat["mime_type"] as? String, "application/json")
        XCTAssertNotNil(rawResponseFormat["schema"])
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

    func testGeminiDecodesStepsIgnoringThoughtPartsAndDecodesPlainStringOutputs() throws {
        let service = GeminiService(
            transport: MockHTTPTransport { _ in fatalError("Not called") },
            keychain: InMemoryKeychain(key: "k"),
            selectorCache: DomainSelectorCache(defaults: testDefaults)
        )

        let thoughtAndTextStepsJSON = """
        {
          "steps": [
            {
              "type": "model_output",
              "content": [
                { "type": "thought", "text": "Reasoning about sticky headers and inline ad slots (not JSON)..." },
                { "type": "text", "text": "{\\"next_page_url\\": \\"https://example.com/page/2\\", \\"confidence\\": 0.95}" }
              ]
            }
          ]
        }
        """
        let fromParts = try service.decodeStructuredOutput(NextPageResult.self, from: Data(thoughtAndTextStepsJSON.utf8))
        XCTAssertEqual(fromParts.nextPageURL, "https://example.com/page/2")
        XCTAssertEqual(fromParts.confidence, 0.95)

        let keyedOutputsJSON = """
        {
          "outputs": [
            { "type": "text", "text": "{\\"selectors\\": [\\"#newsletter-modal\\"]}" }
          ]
        }
        """
        let fromKeyedOutputs = try service.decodeStructuredOutput(ClutterSelectorsResult.self, from: Data(keyedOutputsJSON.utf8))
        XCTAssertEqual(fromKeyedOutputs.selectors, ["#newsletter-modal"])

        let plainStringOutputsJSON = """
        {
          "outputs": [
            "{\\"selectors\\": [\\"ins.adsbygoogle\\", \\"#cookie-banner\\"]}"
          ]
        }
        """
        let fromStringOutputs = try service.decodeStructuredOutput(ClutterSelectorsResult.self, from: Data(plainStringOutputsJSON.utf8))
        XCTAssertEqual(fromStringOutputs.selectors, ["ins.adsbygoogle", "#cookie-banner"])
    }

    func testCSSSelectorSanitizerBlocksUnsafeTagsAndInjectionWhileKeepingValidSelectors() {
        let rawSelectors = [
            "body",
            "div",
            "article",
            "header",
            "main",
            "*",
            ":root",
            "body.modal-open",
            "article.story-body",
            "#cookie-banner, body",
            "#bad { display: block }",
            ".bad; color: red",
            "<script>",
            "@import url('x')",
            "/* comment */ .ad",
            "  #cookie-banner  ",
            "ins.adsbygoogle",
            "[id^=\"div-gpt-ad\"]",
            "#cookie-banner" // duplicate
        ]

        let sanitized = CSSSelectorSanitizer.sanitize(rawSelectors)
        XCTAssertEqual(sanitized, [
            "#cookie-banner",
            "ins.adsbygoogle",
            "[id^=\"div-gpt-ad\"]"
        ])

        // Verify 30-selector cap
        let fortyValid = (1...40).map { "#ad-slot-\($0)" }
        XCTAssertEqual(CSSSelectorSanitizer.sanitize(fortyValid).count, 30)
    }

    func testDomainSelectorCacheSevenDayTTLAndEmptyHandling() throws {
        let clock = MutableClock(Date(timeIntervalSince1970: 1_700_000_000))
        let cache = DomainSelectorCache(
            defaults: testDefaults,
            storageKey: "stitch.testCache",
            nowProvider: { clock.now }
        )

        // Empty array and unsafe-only selectors must NOT be cached.
        cache.save(selectors: [], for: "empty.example.com")
        cache.save(selectors: ["body", "div", "article"], for: "unsafe.example.com")
        XCTAssertNil(cache.selectors(for: "empty.example.com"))
        XCTAssertNil(cache.selectors(for: "unsafe.example.com"))
        XCTAssertEqual(cache.cachedDomainCount, 0)

        // Valid selectors are sanitized and returned within the 7-day TTL.
        cache.save(selectors: ["body", "#cookie-banner", "ins.adsbygoogle"], for: "News.Example.com")
        XCTAssertEqual(cache.selectors(for: "news.example.com"), ["#cookie-banner", "ins.adsbygoogle"])
        XCTAssertEqual(cache.cachedDomainCount, 1)

        // Advance 6 days -> still valid.
        clock.now = clock.now.addingTimeInterval(6 * 24 * 60 * 60)
        XCTAssertEqual(cache.selectors(for: "news.example.com"), ["#cookie-banner", "ins.adsbygoogle"])

        // Advance past 7 days -> expired and evicted.
        clock.now = clock.now.addingTimeInterval(2 * 24 * 60 * 60)
        XCTAssertNil(cache.selectors(for: "news.example.com"))
        XCTAssertEqual(cache.cachedDomainCount, 0)

        // Legacy `[String: [String]]` UserDefaults format remains backward compatible.
        let legacyData = try JSONEncoder().encode(["legacy.example.com": ["div", "#gdpr-modal"]])
        testDefaults.set(legacyData, forKey: "stitch.testCache")
        XCTAssertEqual(cache.selectors(for: "legacy.example.com"), ["#gdpr-modal"])
    }

    func testGeminiDetectClutterSelectorsCachesPerDomain() async throws {
        var requestCount = 0
        let transport = MockHTTPTransport { request in
            requestCount += 1
            let payload = """
            {
              "steps": [
                { "type": "model_output", "content": "{\\"selectors\\": [\\"body\\", \\"#cookie-wall\\"]}" }
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

    func testGeminiDetectNextPageURLResolvesRelativeURLAndValidatesConfidenceAndCandidateLinks() async throws {
        var mockJSON = """
        {
          "outputs": [
            { "text": "{\\"next_page_url\\": \\"/articles/swift?page=2\\", \\"confidence\\": 0.92}" }
          ]
        }
        """
        let transport = MockHTTPTransport { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (Data(mockJSON.utf8), response)
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

        // Low confidence (< 0.45) must return nil.
        mockJSON = """
        {
          "outputs": [
            "{\\"next_page_url\\": \\"/articles/swift?page=2\\", \\"confidence\\": 0.30}"
          ]
        }
        """
        let lowConfidence = try await service.detectNextPageURL(pageContext: context)
        XCTAssertNil(lowConfidence)

        // Hallucinated URL not present in relNextURL or links must return nil.
        mockJSON = """
        {
          "outputs": [
            "{\\"next_page_url\\": \\"/articles/unrelated-page\\", \\"confidence\\": 0.95}"
          ]
        }
        """
        let unlistedURL = try await service.detectNextPageURL(pageContext: context)
        XCTAssertNil(unlistedURL)
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

    func testPaginationHeuristicPrefersRelNextAndHandlesWordBoundaryClasses() {
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

        // Links with utility/component classes like `btn-desktop`, `border-top`, `preview-card-next`
        // must NOT be falsely rejected by substring matches on `top` or `prev`, while `"Previous Page"` IS rejected.
        let trickyClassesContext = PageNavigationContext(
            url: "https://example.com/articles/architecture/p/1",
            title: "Architecture Guide",
            relNextURL: nil,
            links: [
                PageLinkCandidate(
                    text: "Previous Page",
                    href: "/articles/architecture/p/0",
                    rel: "",
                    ariaLabel: "Previous Page",
                    className: "btn-desktop pagination-prev"
                ),
                PageLinkCandidate(
                    text: "Jump",
                    href: "#comments",
                    rel: "",
                    ariaLabel: "",
                    className: ""
                ),
                PageLinkCandidate(
                    text: "Next",
                    href: "/articles/architecture/p/2",
                    rel: "",
                    ariaLabel: "Next article page",
                    className: "btn-desktop border-top preview-card-next autopager-link"
                )
            ]
        )
        XCTAssertEqual(
            PaginationHeuristic.findNextPageURL(in: trickyClassesContext)?.absoluteString,
            "https://example.com/articles/architecture/p/2"
        )

        // Verify `/p/2` and `-page-2` path number extraction.
        XCTAssertEqual(
            PaginationHeuristic.extractPageNumber(from: URL(string: "https://example.com/story/p/2")!),
            2
        )
        XCTAssertEqual(
            PaginationHeuristic.extractPageNumber(from: URL(string: "https://example.com/deep-dive-page-3.html")!),
            3
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

    private func makeSolidImage(width: Int, height: Int, scale: CGFloat = 1.0, color: UIColor) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
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

private final class MutableClock: @unchecked Sendable {
    var now: Date

    init(_ now: Date) {
        self.now = now
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
