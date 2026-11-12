import CoreGraphics
import Foundation
import Observation
import SwiftUI
import UIKit
import WebKit

nonisolated enum WebCaptureError: Error, LocalizedError, Equatable {
    case noPageLoaded
    case invalidWebViewBounds
    case navigationTimeout
    case navigationFailed(String)
    case captureFailed(String)
    case cancelled

    var errorDescription: String? {
        switch self {
        case .noPageLoaded:
            return "Load a webpage before capturing."
        case .invalidWebViewBounds:
            return "Web view is not ready to capture yet."
        case .navigationTimeout:
            return "Timed out waiting for page to load."
        case .navigationFailed(let reason):
            return "Page failed to load: \(reason)"
        case .captureFailed(let reason):
            return "Capture failed: \(reason)"
        case .cancelled:
            return "Capture was cancelled."
        }
    }
}

/// Manages the in-app `WKWebView`, pre-capture decluttering, scroll-and-stitch capture,
/// manual page staging, and Gemini/heuristic auto multi-page capture.
@MainActor
@Observable
final class WebCaptureService {
    let webView: WKWebView

    var currentURLString: String = ""
    var currentURL: URL?
    var pageTitle: String = ""
    var canGoBack: Bool = false
    var canGoForward: Bool = false
    var isLoading: Bool = false
    var estimatedProgress: Double = 0
    var hasLoadedAnyPage: Bool = false
    var hasCommittedPage: Bool = false

    var isCapturing: Bool = false
    var captureStatus: String = ""
    var stagedPages: [StagedPage] = []
    var errorMessage: String?

    private let geminiService: GeminiService
    private let keychain: KeychainStoring

    private var navigationContinuation: CheckedContinuation<Void, Error>?
    private var navigationToken: UUID?
    private var navigationTimeoutTask: Task<Void, Never>?
    private var didCommitCurrentNavigation: Bool = false

    private var activeCaptureToken: UUID?
    private var activeCaptureCancelClosure: (() -> Void)?
    private var isCaptureCancelled: Bool = false

    private var delegateProxy: WebViewDelegateProxy?

    init(
        geminiService: GeminiService = GeminiService(),
        keychain: KeychainStoring = KeychainService()
    ) {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: config)
        view.allowsBackForwardNavigationGestures = true
        view.backgroundColor = .systemBackground

        self.webView = view
        self.geminiService = geminiService
        self.keychain = keychain

        let proxy = WebViewDelegateProxy(owner: self)
        self.delegateProxy = proxy
        view.navigationDelegate = proxy
        view.uiDelegate = proxy
    }

    // MARK: - Browser Navigation

    func loadURLString(_ rawInput: String) {
        errorMessage = nil
        guard let url = DeepLinkParser.normalizeWebURL(rawInput) else {
            errorMessage = "Enter a valid http:// or https:// web address."
            return
        }
        load(url: url)
    }

    func load(url: URL) {
        errorMessage = nil
        hasLoadedAnyPage = true
        didCommitCurrentNavigation = false
        currentURL = url
        currentURLString = url.absoluteString
        webView.load(URLRequest(url: url))
    }

    func goBack() {
        webView.goBack()
    }

    func goForward() {
        webView.goForward()
    }

    func reloadOrStop() {
        if isLoading {
            webView.stopLoading()
        } else {
            webView.reload()
        }
    }

    func cancelCapture() {
        isCaptureCancelled = true
        let cancelClosure = activeCaptureCancelClosure
        activeCaptureCancelClosure = nil
        activeCaptureToken = nil
        cancelClosure?()
        finishPendingNavigation(with: .failure(WebCaptureError.cancelled))
        isCapturing = false
        captureStatus = ""
    }

    // MARK: - Staged Pages Management

    func removeStagedPage(id: UUID) {
        stagedPages.removeAll { $0.id == id }
    }

    func moveStagedPage(from source: IndexSet, to destination: Int) {
        stagedPages.move(fromOffsets: source, toOffset: destination)
    }

    func clearStagedPages() {
        stagedPages.removeAll()
    }

    func stageImportedScreenshots(_ images: [UIImage]) {
        for (idx, image) in images.enumerated() {
            let num = stagedPages.count + idx + 1
            stagedPages.append(
                StagedPage(
                    url: nil,
                    title: "Screenshot \(num)",
                    image: image
                )
            )
        }
    }

    func stitchStagedPages(detectOverlap: Bool = true) throws -> CapturedImageResult {
        let images = stagedPages.map(\.image)
        let stitched = try ImageStitcher.stitchScreenshotsWithAutoOverlap(
            images,
            detectOverlap: detectOverlap
        )
        return CapturedImageResult(
            image: stitched,
            pageCount: stagedPages.count,
            sourceURL: stagedPages.first?.url ?? currentURL
        )
    }

    func stitchImportedScreenshots(_ images: [UIImage], detectOverlap: Bool = true) throws -> CapturedImageResult {
        let stitched = try ImageStitcher.stitchScreenshotsWithAutoOverlap(
            images,
            detectOverlap: detectOverlap
        )
        return CapturedImageResult(
            image: stitched,
            pageCount: images.count,
            sourceURL: nil
        )
    }

    // MARK: - Single & Multi-Page Capture

    func captureFullPage(autoCleanClutter: Bool) async throws -> CapturedImageResult {
        try await runCaptureOperation(initialStatus: "Preparing page...") {
            let pageImage = try await self.captureCurrentWebPage(autoCleanClutter: autoCleanClutter)
            return CapturedImageResult(
                image: pageImage,
                pageCount: 1,
                sourceURL: self.webView.url ?? self.currentURL
            )
        }
    }

    func captureAndAppendPage(autoCleanClutter: Bool) async throws {
        try await runCaptureOperation(initialStatus: "Capturing page \(stagedPages.count + 1)...") {
            guard let activeURL = self.webView.url ?? self.currentURL else {
                throw WebCaptureError.noPageLoaded
            }
            let image = try await self.captureCurrentWebPage(autoCleanClutter: autoCleanClutter)
            let title = self.pageTitle.isEmpty
                ? (activeURL.host ?? "Page \(self.stagedPages.count + 1)")
                : self.pageTitle
            self.stagedPages.append(StagedPage(url: activeURL, title: title, image: image))
        }
    }

    func autoCaptureMultiPage(maxPages: Int, autoCleanClutter: Bool) async throws -> CapturedImageResult {
        try await runCaptureOperation(initialStatus: "Capturing page 1...") {
            guard let startURL = self.webView.url ?? self.currentURL else {
                throw WebCaptureError.noPageLoaded
            }

            let clampedMax = min(max(maxPages, 1), 15)
            var capturedImages: [UIImage] = []
            var visited: Set<String> = [self.normalizedURLKey(startURL)]

            for pageNumber in 1...clampedMax {
                try self.checkCaptureCancelled()
                self.captureStatus = "Capturing page \(pageNumber) of \(clampedMax)..."

                do {
                    let pageImage = try await self.captureCurrentWebPage(autoCleanClutter: autoCleanClutter)
                    capturedImages.append(pageImage)
                } catch let error as WebCaptureError where error == .cancelled {
                    throw WebCaptureError.cancelled
                } catch is CancellationError {
                    throw WebCaptureError.cancelled
                } catch {
                    if !capturedImages.isEmpty {
                        break
                    }
                    throw error
                }

                if pageNumber == clampedMax {
                    break
                }

                self.captureStatus = "Finding next page link..."
                guard let nextURL = try await self.resolveNextPageURL(visited: visited) else {
                    break
                }

                let key = self.normalizedURLKey(nextURL)
                guard !visited.contains(key) else {
                    break
                }
                visited.insert(key)

                self.captureStatus = "Loading page \(pageNumber + 1)..."
                do {
                    try await self.navigateAndAwaitLoad(url: nextURL)
                    // Brief settle for lazy layout/fonts after navigation completes.
                    try await self.sleepCheckCancel(milliseconds: 400)
                } catch let error as WebCaptureError where error == .cancelled {
                    throw WebCaptureError.cancelled
                } catch is CancellationError {
                    throw WebCaptureError.cancelled
                } catch {
                    // Preserve and stitch already-captured pages when a subsequent page fails to load.
                    if !capturedImages.isEmpty {
                        break
                    }
                    throw error
                }
            }

            try self.checkCaptureCancelled()
            self.captureStatus = "Stitching \(capturedImages.count) page(s)..."
            let stitched = try ImageStitcher.stitchVertically(capturedImages)
            return CapturedImageResult(
                image: stitched,
                pageCount: capturedImages.count,
                sourceURL: startURL
            )
        }
    }

    private func runCaptureOperation<T: Sendable>(
        initialStatus: String,
        operation: @escaping @MainActor () async throws -> T
    ) async throws -> T {
        guard hasLoadedAnyPage, hasCommittedPage, webView.url != nil else {
            throw WebCaptureError.noPageLoaded
        }
        guard !isCapturing else {
            throw WebCaptureError.captureFailed("A capture is already in progress.")
        }

        let runToken = UUID()
        activeCaptureToken = runToken
        isCaptureCancelled = false
        isCapturing = true
        captureStatus = initialStatus

        let task = Task<T, Error> { @MainActor in
            try await operation()
        }
        activeCaptureCancelClosure = {
            task.cancel()
        }

        defer {
            if activeCaptureToken == runToken {
                activeCaptureCancelClosure = nil
                activeCaptureToken = nil
                isCaptureCancelled = false
                isCapturing = false
                captureStatus = ""
            }
        }

        do {
            return try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                task.cancel()
            }
        } catch is CancellationError {
            throw WebCaptureError.cancelled
        } catch let error as WebCaptureError where error == .cancelled {
            throw WebCaptureError.cancelled
        }
    }

    private func checkCaptureCancelled() throws {
        if isCaptureCancelled || Task.isCancelled {
            throw WebCaptureError.cancelled
        }
    }

    private func sleepCheckCancel(milliseconds: Int) async throws {
        try checkCaptureCancelled()
        do {
            try await Task.sleep(for: .milliseconds(milliseconds))
        } catch {
            throw WebCaptureError.cancelled
        }
        try checkCaptureCancelled()
    }

    // MARK: - Core Scroll-and-Stitch Engine

    private func captureCurrentWebPage(autoCleanClutter: Bool) async throws -> UIImage {
        try checkCaptureCancelled()

        let bounds = webView.bounds
        guard bounds.width > 10, bounds.height > 10 else {
            throw WebCaptureError.invalidWebViewBounds
        }

        let initialOffset = await readInitialScrollOffset()
        var didRestore = false

        do {
            // Scroll to (0, 0) FIRST so sticky headers are at their natural top position before DOM inspection.
            _ = try await scrollTo(y: 0)
            try await sleepCheckCancel(milliseconds: 60)

            try await eagerLoadImagesAndAwaitDecode()

            var extraSelectors: [String] = []
            if autoCleanClutter {
                captureStatus = "Cleaning overlays & ads..."
                extraSelectors = await detectExtraClutterSelectorsIfConfigured()
            }

            try checkCaptureCancelled()
            try await applyPreCaptureSetup(
                autoCleanClutter: autoCleanClutter,
                extraSelectors: extraSelectors
            )
            try await sleepCheckCancel(milliseconds: 80)

            // Read scroll metrics AFTER pre-capture cleanup so collapsed inline ads do not inflate scrollHeight.
            let metrics = try await readScrollMetrics()
            let viewportHeight = max(
                1,
                min(bounds.height, metrics.viewportHeight > 0 ? metrics.viewportHeight : bounds.height)
            )
            var liveScrollHeight = max(viewportHeight, metrics.scrollHeight)

            // Before Slice 0 on multi-slice pages, hide bottom-anchored fixed/sticky bars so they never bake into the middle of the stitched image.
            if autoCleanClutter && liveScrollHeight > viewportHeight + 20 {
                await hideBottomAnchoredBarsBeforeFirstSlice()
                try await sleepCheckCancel(milliseconds: 40)
            }

            let snapshotSize = CGSize(width: bounds.width, height: viewportHeight)
            var slices: [UIImage] = []
            let maxSlices = 35
            var targetY: CGFloat = 0
            var previousCoveredEndY: CGFloat = 0

            for sliceIndex in 0..<maxSlices {
                try checkCaptureCancelled()
                captureStatus = "Capturing slice \(sliceIndex + 1)..."

                var actualY = try await scrollTo(y: targetY)
                try await sleepCheckCancel(milliseconds: 160)

                if sliceIndex >= 1 {
                    let liveState = await prepareSubsequentSlice(
                        coveredEndY: previousCoveredEndY,
                        autoCleanClutter: autoCleanClutter,
                        extraSelectors: extraSelectors
                    )
                    if let updatedScrollHeight = liveState?.scrollHeight, updatedScrollHeight > 0 {
                        liveScrollHeight = max(viewportHeight, updatedScrollHeight)
                    }
                    if let updatedScrollY = liveState?.scrollY {
                        actualY = updatedScrollY
                    }
                    if liveState?.mutated == true {
                        try await sleepCheckCancel(milliseconds: 50)
                    }
                }

                try checkCaptureCancelled()

                let snapshotConfig = WKSnapshotConfiguration()
                snapshotConfig.rect = CGRect(origin: .zero, size: snapshotSize)
                snapshotConfig.afterScreenUpdates = true

                let snapshot = try await takeSnapshot(config: snapshotConfig)
                await recordVisibleStickyElements()

                if sliceIndex == 0 {
                    slices.append(snapshot)
                    previousCoveredEndY = actualY + viewportHeight
                } else {
                    let overlapPoints = previousCoveredEndY - actualY
                    if overlapPoints >= viewportHeight - 1 {
                        // Reached the bottom without advancing.
                        break
                    } else if overlapPoints > 0 {
                        let slicePixelHeight = CGFloat(ImageStitcher.pixelSize(of: snapshot).height)
                        let pointsToPixels = slicePixelHeight / max(1, viewportHeight)
                        let topCropPixels = Int(round(overlapPoints * pointsToPixels))
                        if topCropPixels >= Int(slicePixelHeight) {
                            break
                        } else if topCropPixels >= 1 {
                            if let cropped = ImageStitcher.cropTopAndBottomOverlap(snapshot, topCropPixels: topCropPixels) {
                                slices.append(cropped)
                            }
                        } else {
                            slices.append(snapshot)
                        }
                    } else {
                        slices.append(snapshot)
                    }
                    previousCoveredEndY = actualY + viewportHeight
                }

                if previousCoveredEndY >= liveScrollHeight - 2 {
                    break
                }

                targetY = previousCoveredEndY
            }

            didRestore = true
            await restoreAfterCapture(origX: initialOffset.x, origY: initialOffset.y)
            try checkCaptureCancelled()
            return try ImageStitcher.stitchVertically(slices)
        } catch {
            if !didRestore {
                await restoreAfterCapture(origX: initialOffset.x, origY: initialOffset.y)
            }
            if isCaptureCancelled || Task.isCancelled || (error is CancellationError) {
                throw WebCaptureError.cancelled
            }
            throw error
        }
    }

    private func takeSnapshot(config: WKSnapshotConfiguration) async throws -> UIImage {
        try await withCheckedThrowingContinuation { continuation in
            webView.takeSnapshot(with: config) { image, error in
                if let error {
                    continuation.resume(throwing: WebCaptureError.captureFailed(error.localizedDescription))
                } else if let image {
                    continuation.resume(returning: image)
                } else {
                    continuation.resume(throwing: WebCaptureError.captureFailed("Snapshot returned nil."))
                }
            }
        }
    }

    // MARK: - Pagination & Clutter Detection

    private func resolveNextPageURL(visited: Set<String>) async throws -> URL? {
        try checkCaptureCancelled()
        guard let context = try await extractPageNavigationContext() else {
            return nil
        }

        if let key = keychain.loadAPIKey(), !key.isEmpty {
            if let geminiURL = try? await geminiService.detectNextPageURL(pageContext: context),
               !visited.contains(normalizedURLKey(geminiURL)) {
                return geminiURL
            }
        }

        if let heuristicURL = PaginationHeuristic.findNextPageURL(in: context),
           !visited.contains(normalizedURLKey(heuristicURL)) {
            return heuristicURL
        }

        return nil
    }

    private func detectExtraClutterSelectorsIfConfigured() async -> [String] {
        guard let key = keychain.loadAPIKey(), !key.isEmpty else {
            return []
        }
        guard !isCaptureCancelled, !Task.isCancelled else {
            return []
        }
        guard let summary = try? await extractDOMSummary() else {
            return []
        }
        let detected = (try? await geminiService.detectClutterSelectors(domSummary: summary)) ?? []
        return CSSSelectorSanitizer.sanitize(detected)
    }

    // MARK: - Navigation Waiting

    private func navigateAndAwaitLoad(url: URL) async throws {
        try checkCaptureCancelled()
        finishPendingNavigation(with: .failure(WebCaptureError.cancelled))

        let token = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                if self.isCaptureCancelled || Task.isCancelled {
                    continuation.resume(throwing: WebCaptureError.cancelled)
                    return
                }

                self.navigationToken = token
                self.navigationContinuation = continuation
                self.load(url: url)

                self.navigationTimeoutTask = Task { @MainActor [weak self] in
                    // Fallback at ~12s: if the main document already committed and reached interactive/complete,
                    // stop stalled third-party ad subresources so capture can proceed cleanly.
                    try? await Task.sleep(for: .seconds(12))
                    guard !Task.isCancelled, let self, self.navigationToken == token else { return }

                    if self.didCommitCurrentNavigation,
                       let readyState = (try? await self.webView.evaluateJavaScript("document.readyState")) as? String,
                       (readyState == "interactive" || readyState == "complete") {
                        self.webView.stopLoading()
                        self.hasCommittedPage = true
                        self.syncWebViewState()
                        self.finishPendingNavigation(token: token, with: .success(()))
                        return
                    }

                    try? await Task.sleep(for: .seconds(13))
                    guard !Task.isCancelled, self.navigationToken == token else { return }
                    self.webView.stopLoading()
                    self.syncWebViewState()
                    self.finishPendingNavigation(token: token, with: .failure(WebCaptureError.navigationTimeout))
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.webView.stopLoading()
                self?.finishPendingNavigation(token: token, with: .failure(WebCaptureError.cancelled))
            }
        }
    }

    private func finishPendingNavigation(token: UUID? = nil, with result: Result<Void, Error>) {
        if let token, self.navigationToken != token {
            return
        }
        navigationTimeoutTask?.cancel()
        navigationTimeoutTask = nil
        navigationToken = nil
        guard let pending = navigationContinuation else { return }
        navigationContinuation = nil
        pending.resume(with: result)
    }

    private func normalizedURLKey(_ url: URL) -> String {
        PaginationHeuristic.canonicalPageKey(url)
    }

    // MARK: - JavaScript DOM Helpers

    private nonisolated struct ScrollOffset: Decodable, Sendable {
        let x: CGFloat
        let y: CGFloat
    }

    private nonisolated struct ScrollMetrics: Decodable, Sendable {
        let scrollHeight: CGFloat
        let viewportHeight: CGFloat
        let scrollX: CGFloat
        let scrollY: CGFloat
    }

    private nonisolated struct LiveSliceState: Decodable, Sendable {
        let scrollHeight: CGFloat
        let scrollY: CGFloat
        let mutated: Bool
    }

    /// Shared DOM protection, ad-matching, wrapper-collapsing, and byte-exact style-saving JS helpers.
    private static let sharedDOMHelpersJS = #"""
        if (!window.__stitchState) {
            window.__stitchState = {
                modifiedStyles: new Map(),
                capturedStickyEls: new Set(),
                lazyImages: []
            };
        }
        const state = window.__stitchState;

        const recordOriginalStyle = (el) => {
            if (!el || el.nodeType !== 1) return;
            if (!state.modifiedStyles.has(el)) {
                state.modifiedStyles.set(el, {
                    hadStyle: el.hasAttribute('style'),
                    origStyle: el.getAttribute('style') || ''
                });
            }
        };

        const KNOWN_CLUTTER_SELECTORS = [
            'ins.adsbygoogle',
            '.adsbygoogle',
            '.google-auto-placed',
            '[id^="div-gpt-ad"]',
            '[id^="google_ads_iframe"]',
            'iframe[id^="google_ads_iframe"]',
            'iframe[src*="googlesyndication.com"]',
            'iframe[src*="doubleclick.net"]',
            'iframe[src*="2mdn.net"]',
            'iframe[src*="adservice.google."]',
            '[data-google-query-id]',
            '[data-ad-client]',
            '[data-ad-slot]',
            '[id^="taboola-"]',
            '[class*="taboola-"]',
            '.trc_rbox_container',
            '.OUTBRAIN',
            '[data-widget-id^="outbrain"]',
            '[id^="outbrain_widget"]',
            '[id^="mgid"]',
            'iframe[src*="criteo."]',
            'iframe[src*="amazon-adsystem.com"]',
            'iframe[src*="adnxs.com"]',
            'iframe[src*="rubiconproject.com"]',
            'iframe[src*="pubmatic.com"]',
            'iframe[src*="openx.net"]',
            'iframe[src*="taboola.com"]',
            'iframe[src*="outbrain.com"]',
            '.mv-ad-box',
            '[class*="mv-ad-"]',
            '.adthrive-ad',
            '[class*="adthrive-"]',
            '[data-freestar-ad]',
            '[id^="ezoic-pub-ad-placeholder"]',
            '.ezoic-ad',
            'amp-ad',
            'amp-sticky-ad',
            '[data-ad-unit]',
            '[data-ad-name]',
            '[data-ad-region]',
            '[data-testid="ad-slot"]',
            '[data-testid="ad-container"]',
            '[aria-label="Advertisement" i]',
            '[aria-label="Sponsored" i]',
            '#onetrust-banner-sdk',
            '#onetrust-consent-sdk',
            '#CybotCookiebotDialog',
            '.cc-window',
            '.cookie-banner',
            '.cookie-consent',
            '#didomi-host',
            '#sp_message_container',
            '.qc-cmp2-container',
            '#intercom-container',
            '#hubspot-messages-iframe-container',
            '.drift-frame-controller',
            '[aria-label*="cookie" i][role="dialog"]',
            '[aria-label*="consent" i][role="dialog"]'
        ];

        const AD_TOKEN_RE = /(?:^|[-_\s])(ad|ads|advert|advertisement|adslot|adunit|adsbygoogle|dfp|gpt|sponsored|outbrain|taboola|inline-ad|in-article-ad|banner-ad)(?:$|[-_\s\d])/i;
        const AD_LABEL_ONLY_RE = /^(advertisement|sponsored|sponsored\s+content|paid\s+advertisement|paid\s+content|article\s+continues\s+below|story\s+continues\s+below|continues\s+below|ad|ads|promoted)[\s:.\-\u2013\u2014]*$/i;
        const EMBED_HOST_RE = /(youtube\.com|youtube-nocookie\.com|youtu\.be|player\.vimeo\.com|vimeo\.com|open\.spotify\.com|spotify\.com|codepen\.io|jsfiddle\.net|codesandbox\.io|figma\.com|google\.com\/maps|maps\.google\.|platform\.twitter\.com|twitter\.com|x\.com|instagram\.com|tiktok\.com|soundcloud\.com|bandcamp\.com|gist\.github\.com)/i;

        const isLegitimateEmbed = (el) => {
            if (!el || el.nodeType !== 1) return false;
            const checkIframe = (f) => {
                const src = f.getAttribute('src') || f.getAttribute('data-src') || '';
                return EMBED_HOST_RE.test(src);
            };
            if (el.tagName === 'IFRAME' && checkIframe(el)) return true;
            if (el.matches && el.matches('blockquote.twitter-tweet, blockquote.instagram-media, blockquote.tiktok-embed, .twitter-tweet, .instagram-media')) {
                return true;
            }
            if (el.querySelectorAll) {
                const frames = el.querySelectorAll('iframe');
                for (const f of frames) {
                    if (checkIframe(f)) return true;
                }
                if (el.querySelector('blockquote.twitter-tweet, blockquote.instagram-media, blockquote.tiktok-embed')) {
                    return true;
                }
            }
            return false;
        };

        const isProtectedContent = (el) => {
            if (!el || el.nodeType !== 1) return true;
            const tag = el.tagName.toLowerCase();
            if (tag === 'html' || tag === 'body' || tag === 'head' || tag === 'main' || tag === 'article' || tag === 'nav') {
                return true;
            }
            const role = (el.getAttribute('role') || '').toLowerCase();
            if (role === 'main' || role === 'article' || role === 'navigation') {
                return true;
            }
            if (isLegitimateEmbed(el)) {
                return true;
            }
            if (el.querySelector && el.querySelector('main, article, [role="main"], h1')) {
                return true;
            }
            if (el.querySelectorAll && el.querySelectorAll('p').length >= 3) {
                return true;
            }
            const textLen = ((el.innerText || el.textContent || '').trim()).length;
            if (textLen > 500) {
                return true;
            }
            return false;
        };

        const isCoreDocumentLandmark = (el) => {
            if (!el || el.nodeType !== 1) return true;
            const tag = el.tagName.toLowerCase();
            if (tag === 'html' || tag === 'body' || tag === 'head' || tag === 'main' || tag === 'article') {
                return true;
            }
            const role = (el.getAttribute('role') || '').toLowerCase();
            if (role === 'main' || role === 'article') {
                return true;
            }
            if (el.querySelector && el.querySelector('main, article, [role="main"]')) {
                return true;
            }
            return false;
        };

        const matchesAdToken = (el) => {
            if (!el || el.nodeType !== 1) return false;
            const fields = [
                el.id || '',
                typeof el.className === 'string' ? el.className : '',
                el.getAttribute('data-testid') || '',
                el.getAttribute('aria-label') || '',
                el.getAttribute('data-component') || '',
                el.getAttribute('data-module') || ''
            ];
            for (const val of fields) {
                if (val && AD_TOKEN_RE.test(val)) return true;
            }
            return false;
        };

        const hasVisibleContentMedia = (container) => {
            if (!container || !container.querySelectorAll) return false;
            const media = container.querySelectorAll('img, picture, video, canvas, svg, iframe');
            for (const m of media) {
                const cs = getComputedStyle(m);
                if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0) {
                    continue;
                }
                const r = m.getBoundingClientRect();
                if (r.width > 4 && r.height > 4) {
                    return true;
                }
            }
            return false;
        };

        const collapseElement = (el) => {
            if (!el || el.nodeType !== 1 || isProtectedContent(el)) return false;
            recordOriginalStyle(el);
            el.style.setProperty('display', 'none', 'important');
            el.style.setProperty('min-height', '0px', 'important');
            el.style.setProperty('height', '0px', 'important');
            el.style.setProperty('margin-top', '0px', 'important');
            el.style.setProperty('margin-bottom', '0px', 'important');
            el.style.setProperty('padding-top', '0px', 'important');
            el.style.setProperty('padding-bottom', '0px', 'important');
            return true;
        };

        const hideOverlayPreserveLayout = (el) => {
            if (!el || el.nodeType !== 1 || isCoreDocumentLandmark(el)) return false;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            recordOriginalStyle(el);
            el.style.setProperty('visibility', 'hidden', 'important');
            el.style.setProperty('opacity', '0', 'important');
            el.style.setProperty('pointer-events', 'none', 'important');
            return true;
        };

        const collapseAdAncestors = (startEl, minDocTop = -Infinity) => {
            const scrollY = window.scrollY || window.pageYOffset || (document.documentElement ? document.documentElement.scrollTop : 0) || 0;
            let parent = startEl ? startEl.parentElement : null;
            for (let depth = 0; depth < 4 && parent; depth++) {
                if (isProtectedContent(parent)) break;
                const nextParent = parent.parentElement;
                const parentDocTop = parent.getBoundingClientRect().top + scrollY;
                if (parentDocTop < minDocTop) break;
                const cs = getComputedStyle(parent);
                if (cs.display === 'none') {
                    parent = nextParent;
                    continue;
                }
                const remainingText = (parent.innerText || '').replace(/\s+/g, ' ').trim();
                const isLabelOrEmpty = remainingText.length === 0 || (remainingText.length <= 60 && AD_LABEL_ONLY_RE.test(remainingText));
                if (isLabelOrEmpty && !hasVisibleContentMedia(parent)) {
                    collapseElement(parent);
                    parent = nextParent;
                } else {
                    break;
                }
            }
        };
    """#

    private func readInitialScrollOffset() async -> (x: CGFloat, y: CGFloat) {
        let js = #"""
        (() => {
            return JSON.stringify({
                x: window.scrollX || window.pageXOffset || 0,
                y: window.scrollY || window.pageYOffset || (document.documentElement ? document.documentElement.scrollTop : 0) || 0
            });
        })();
        """#
        guard let json = try? await evaluateStringJS(js),
              let data = json.data(using: .utf8),
              let offset = try? JSONDecoder().decode(ScrollOffset.self, from: data)
        else {
            return (0, 0)
        }
        return (offset.x, offset.y)
    }

    private func eagerLoadImagesAndAwaitDecode() async throws {
        let triggerJS = #"""
        (() => {
            if (!window.__stitchState) {
                window.__stitchState = {
                    modifiedStyles: new Map(),
                    capturedStickyEls: new Set(),
                    lazyImages: []
                };
            }
            const state = window.__stitchState;
            let pendingCount = 0;
            document.querySelectorAll('img').forEach(img => {
                if (img.getAttribute('loading') === 'lazy') {
                    state.lazyImages.push({
                        img: img,
                        hadLoading: true,
                        origLoading: 'lazy'
                    });
                    img.setAttribute('loading', 'eager');
                }
                if (img.decoding === 'async') {
                    try { img.decoding = 'sync'; } catch (_) {}
                }
                if (typeof img.decode === 'function') {
                    try { img.decode().catch(() => {}); } catch (_) {}
                }
                if (!img.complete) {
                    pendingCount += 1;
                }
            });
            return pendingCount;
        })();
        """#

        let initialPending = ((try? await webView.evaluateJavaScript(triggerJS)) as? NSNumber)?.intValue ?? 0
        guard initialPending > 0 else { return }

        let checkPendingJS = #"""
        (() => {
            let pending = 0;
            document.querySelectorAll('img').forEach(img => {
                if (!img.complete) pending += 1;
            });
            return pending;
        })();
        """#

        for _ in 0..<5 {
            try await sleepCheckCancel(milliseconds: 150)
            let remaining = ((try? await webView.evaluateJavaScript(checkPendingJS)) as? NSNumber)?.intValue ?? 0
            if remaining == 0 {
                break
            }
        }
    }

    private func readScrollMetrics() async throws -> ScrollMetrics {
        let js = #"""
        (() => {
            const docEl = document.documentElement;
            const body = document.body;
            const scrollHeight = Math.max(
                docEl ? docEl.scrollHeight : 0,
                body ? body.scrollHeight : 0
            );
            const vvHeight = window.visualViewport ? window.visualViewport.height : 0;
            const viewportHeight = vvHeight || window.innerHeight || (docEl ? docEl.clientHeight : 800);
            return JSON.stringify({
                scrollHeight: scrollHeight,
                viewportHeight: viewportHeight,
                scrollX: window.scrollX || window.pageXOffset || 0,
                scrollY: window.scrollY || window.pageYOffset || (docEl ? docEl.scrollTop : 0) || 0
            });
        })();
        """#
        let json = try await evaluateStringJS(js)
        guard let data = json.data(using: .utf8) else {
            throw WebCaptureError.captureFailed("Could not read scroll metrics.")
        }
        return try JSONDecoder().decode(ScrollMetrics.self, from: data)
    }

    private func scrollTo(y: CGFloat) async throws -> CGFloat {
        let js = #"""
        (() => {
            window.scrollTo({ top: \#(y), left: 0, behavior: 'instant' });
            return window.scrollY || window.pageYOffset || (document.documentElement ? document.documentElement.scrollTop : 0) || 0;
        })();
        """#
        let result = try await webView.evaluateJavaScript(js)
        if let number = result as? NSNumber {
            return CGFloat(number.doubleValue)
        }
        return y
    }

    private func applyPreCaptureSetup(autoCleanClutter: Bool, extraSelectors: [String]) async throws {
        let sanitizedExtras = CSSSelectorSanitizer.sanitize(extraSelectors)
        let extraJSON = String(data: try JSONEncoder().encode(sanitizedExtras), encoding: .utf8) ?? "[]"
        let cleanFlag = autoCleanClutter ? "true" : "false"

        let js = #"""
        (() => {
            \#(Self.sharedDOMHelpersJS)

            document.querySelectorAll('style[data-stitch-cleanup="true"]').forEach(s => s.remove());
            const styleEl = document.createElement('style');
            styleEl.setAttribute('data-stitch-cleanup', 'true');
            const cssRules = [
                'html, body, *, *::before, *::after { scroll-behavior: auto !important; }',
                '::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }',
                'html, body { scrollbar-width: none !important; }'
            ];

            const extraSelectors = \#(extraJSON);
            if (\#(cleanFlag)) {
                // One CSS rule per selector (only when not matching protected content) so an unsupported or overly broad selector never harms primary content or sibling rules.
                for (const sel of [...KNOWN_CLUTTER_SELECTORS, ...extraSelectors]) {
                    try {
                        const matches = document.querySelectorAll(sel);
                        let hitsProtected = false;
                        for (const el of matches) {
                            if (isProtectedContent(el)) {
                                hitsProtected = true;
                                break;
                            }
                        }
                        if (!hitsProtected) {
                            cssRules.push(`${sel} { display: none !important; visibility: hidden !important; }`);
                        }
                    } catch (_) {}
                }
            }

            styleEl.textContent = cssRules.join('\n');
            (document.head || document.documentElement).appendChild(styleEl);

            if (\#(cleanFlag)) {
                let hidOverlayModal = false;

                // Collapse known ad elements and walk up to 4 ancestors to collapse empty / "Advertisement" CLS wrappers.
                for (const sel of KNOWN_CLUTTER_SELECTORS) {
                    try {
                        document.querySelectorAll(sel).forEach(el => {
                            if (!isProtectedContent(el)) {
                                collapseElement(el);
                                collapseAdAncestors(el);
                            }
                        });
                    } catch (_) {}
                }

                // Apply Gemini/cached domain selectors with full content protection and ancestor wrapper cleanup.
                for (const sel of extraSelectors) {
                    try {
                        document.querySelectorAll(sel).forEach(el => {
                            if (!isProtectedContent(el)) {
                                const cs = getComputedStyle(el);
                                if (cs.position === 'fixed') {
                                    hidOverlayModal = true;
                                }
                                collapseElement(el);
                                collapseAdAncestors(el);
                            }
                        });
                    } catch (_) {}
                }

                // Collapse inline ad elements matched by token-boundary AD_TOKEN_RE.
                document.querySelectorAll('body *').forEach(el => {
                    if (isProtectedContent(el)) return;
                    if (matchesAdToken(el)) {
                        collapseElement(el);
                        collapseAdAncestors(el);
                    }
                });

                // Collapse standalone empty "Advertisement" / "Sponsored" placeholder boxes.
                document.querySelectorAll('div, aside, section, figure').forEach(el => {
                    if (isProtectedContent(el)) return;
                    const cs = getComputedStyle(el);
                    if (cs.display === 'none') return;
                    const r = el.getBoundingClientRect();
                    if (r.height <= 0 || r.height >= window.innerHeight * 0.9) return;
                    const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
                    if (txt.length > 0 && txt.length <= 60 && AD_LABEL_ONLY_RE.test(txt) && !hasVisibleContentMedia(el)) {
                        collapseElement(el);
                        collapseAdAncestors(el);
                    }
                });

                // Hide cookie consent banners, GDPR popups, paywall/newsletter modals, and small floating widgets.
                const heuristicOverlaySelectors = [
                    '[id*="cookie" i]', '[class*="cookie" i]',
                    '[id*="consent" i]', '[class*="consent" i]',
                    '[id*="onetrust" i]', '[class*="onetrust" i]',
                    '[id*="gdpr" i]', '[class*="gdpr" i]',
                    '[class*="newsletter" i][class*="popup" i]',
                    '[class*="paywall" i]', '[aria-modal="true"]'
                ];
                for (const sel of heuristicOverlaySelectors) {
                    try {
                        document.querySelectorAll(sel).forEach(el => {
                            if (isProtectedContent(el)) return;
                            const style = getComputedStyle(el);
                            const rect = el.getBoundingClientRect();
                            if ((style.position === 'fixed' || style.position === 'sticky' || parseInt(style.zIndex || '0', 10) >= 20)
                                && rect.height > 0 && rect.height < window.innerHeight * 0.9) {
                                collapseElement(el);
                                hidOverlayModal = true;
                            }
                        });
                    } catch (_) {}
                }

                document.querySelectorAll('body *').forEach(el => {
                    if (isCoreDocumentLandmark(el)) return;
                    const style = getComputedStyle(el);
                    if (style.position !== 'fixed') return;
                    const rect = el.getBoundingClientRect();
                    const isSmallFloatingWidget = rect.width > 0 && rect.height > 0 &&
                        rect.height < window.innerHeight * 0.45 &&
                        (rect.bottom > window.innerHeight * 0.55 || rect.top > 80);
                    if (isSmallFloatingWidget) {
                        hideOverlayPreserveLayout(el);
                    }
                });

                // Unlock scroll on html/body if a hidden consent modal had locked overflow-y.
                if (hidOverlayModal) {
                    for (const root of [document.documentElement, document.body]) {
                        if (!root) continue;
                        const cs = getComputedStyle(root);
                        if (cs.overflowY === 'hidden' && root.scrollHeight > window.innerHeight + 50) {
                            recordOriginalStyle(root);
                            root.style.setProperty('overflow-y', 'auto', 'important');
                        }
                    }
                }
            }
            return true;
        })();
        """#
        _ = try? await webView.evaluateJavaScript(js)
    }

    private func hideBottomAnchoredBarsBeforeFirstSlice() async {
        let js = #"""
        (() => {
            \#(Self.sharedDOMHelpersJS)
            const innerHeight = window.innerHeight || 800;
            document.querySelectorAll('body *').forEach(el => {
                if (isCoreDocumentLandmark(el)) return;
                const style = getComputedStyle(el);
                if (style.position !== 'fixed' && style.position !== 'sticky') return;
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 &&
                    rect.height > 0 &&
                    rect.bottom >= innerHeight - 120 &&
                    rect.top >= innerHeight * 0.38 &&
                    rect.height < innerHeight * 0.48) {
                    hideOverlayPreserveLayout(el);
                }
            });
            return true;
        })();
        """#
        _ = try? await webView.evaluateJavaScript(js)
    }

    private func recordVisibleStickyElements() async {
        let js = #"""
        (() => {
            if (!window.__stitchState) return false;
            const innerHeight = window.innerHeight || 800;
            document.querySelectorAll('body *').forEach(el => {
                const style = getComputedStyle(el);
                if (style.position !== 'sticky') return;
                if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return;
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && rect.bottom > 2 && rect.top < innerHeight - 2) {
                    window.__stitchState.capturedStickyEls.add(el);
                }
            });
            return true;
        })();
        """#
        _ = try? await webView.evaluateJavaScript(js)
    }

    private func prepareSubsequentSlice(
        coveredEndY: CGFloat,
        autoCleanClutter: Bool,
        extraSelectors: [String]
    ) async -> LiveSliceState? {
        let sanitizedExtras = CSSSelectorSanitizer.sanitize(extraSelectors)
        let extraJSON = (try? String(data: JSONEncoder().encode(sanitizedExtras), encoding: .utf8)) ?? "[]"
        let cleanFlag = autoCleanClutter ? "true" : "false"

        let js = #"""
        (() => {
            \#(Self.sharedDOMHelpersJS)
            const innerHeight = window.innerHeight || 800;
            const coveredEndY = \#(coveredEndY);
            const seamY = coveredEndY - 2;
            let mutated = false;

            // 1. Suppress fixed bars and already-captured or edge-stuck sticky bars so headers never repeat down the image,
            // while allowing unvisited sticky section headings (e.g., sticky <h2>) in normal flow to render once.
            document.querySelectorAll('body *').forEach(el => {
                if (isCoreDocumentLandmark(el)) return;
                const style = getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') return;
                const pos = style.position;
                if (pos !== 'fixed' && pos !== 'sticky') return;

                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= innerHeight) return;

                if (pos === 'fixed') {
                    if (rect.height < innerHeight * 0.65) {
                        if (hideOverlayPreserveLayout(el)) mutated = true;
                    }
                    return;
                }

                // pos === 'sticky'
                if (rect.height >= innerHeight * 0.48) return;
                const alreadyCaptured = state.capturedStickyEls.has(el);
                const cssTop = parseFloat(style.top);
                const parentRect = el.parentElement ? el.parentElement.getBoundingClientRect() : null;
                const stuckAtTopEdge = !Number.isNaN(cssTop)
                    && Math.abs(rect.top - cssTop) <= 2
                    && rect.top <= 120
                    && parentRect !== null
                    && parentRect.top < rect.top - 2;
                const stuckAtBottomEdge = rect.bottom >= innerHeight - 120 && rect.top >= innerHeight * 0.38;

                if (alreadyCaptured || stuckAtTopEdge || stuckAtBottomEdge) {
                    if (hideOverlayPreserveLayout(el)) mutated = true;
                }
            });

            // 2. Seam-safe cleanup of lazy-injected ads/wrappers triggered during scroll.
            if (\#(cleanFlag)) {
                const currentScrollY = window.scrollY || window.pageYOffset || (document.documentElement ? document.documentElement.scrollTop : 0) || 0;

                const cleanLazyAdElement = (el) => {
                    if (!el || el.nodeType !== 1 || isProtectedContent(el)) return;
                    const cs = getComputedStyle(el);
                    if (cs.display === 'none') {
                        collapseAdAncestors(el, seamY);
                        return;
                    }
                    const rect = el.getBoundingClientRect();
                    if (rect.width <= 0 && rect.height <= 0) return;
                    const docTop = rect.top + currentScrollY;
                    if (docTop >= seamY) {
                        if (collapseElement(el)) {
                            collapseAdAncestors(el, seamY);
                            mutated = true;
                        }
                    } else if (cs.visibility !== 'hidden') {
                        if (hideOverlayPreserveLayout(el)) {
                            mutated = true;
                        }
                    }
                };

                for (const sel of KNOWN_CLUTTER_SELECTORS) {
                    try {
                        document.querySelectorAll(sel).forEach(cleanLazyAdElement);
                    } catch (_) {}
                }

                const extraSelectors = \#(extraJSON);
                for (const sel of extraSelectors) {
                    try {
                        document.querySelectorAll(sel).forEach(cleanLazyAdElement);
                    } catch (_) {}
                }

                document.querySelectorAll('body *').forEach(el => {
                    if (isProtectedContent(el)) return;
                    if (matchesAdToken(el)) {
                        cleanLazyAdElement(el);
                    }
                });

                document.querySelectorAll('div, aside, section, figure').forEach(el => {
                    if (isProtectedContent(el)) return;
                    const cs = getComputedStyle(el);
                    if (cs.display === 'none') return;
                    const r = el.getBoundingClientRect();
                    if (r.height <= 0 || r.height >= innerHeight * 0.9) return;
                    const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
                    if (txt.length > 0 && txt.length <= 60 && AD_LABEL_ONLY_RE.test(txt) && !hasVisibleContentMedia(el)) {
                        cleanLazyAdElement(el);
                    }
                });
            }

            const docEl = document.documentElement;
            const body = document.body;
            const liveScrollHeight = Math.max(
                docEl ? docEl.scrollHeight : 0,
                body ? body.scrollHeight : 0
            );
            const liveScrollY = window.scrollY || window.pageYOffset || (docEl ? docEl.scrollTop : 0) || 0;

            return JSON.stringify({
                scrollHeight: liveScrollHeight,
                scrollY: liveScrollY,
                mutated: mutated
            });
        })();
        """#

        guard let json = try? await evaluateStringJS(js),
              let data = json.data(using: .utf8)
        else {
            return nil
        }
        return try? JSONDecoder().decode(LiveSliceState.self, from: data)
    }

    private func restoreAfterCapture(origX: CGFloat, origY: CGFloat) async {
        let js = #"""
        (() => {
            document.querySelectorAll('style[data-stitch-cleanup="true"]').forEach(s => s.remove());
            const state = window.__stitchState;
            if (!state) return false;

            if (state.modifiedStyles) {
                for (const [el, saved] of state.modifiedStyles.entries()) {
                    try {
                        if (saved.hadStyle) {
                            el.setAttribute('style', saved.origStyle);
                        } else {
                            el.removeAttribute('style');
                        }
                    } catch (_) {}
                }
            }

            if (Array.isArray(state.lazyImages)) {
                for (const item of state.lazyImages) {
                    try {
                        if (item.hadLoading) {
                            item.img.setAttribute('loading', item.origLoading);
                        } else {
                            item.img.removeAttribute('loading');
                        }
                    } catch (_) {}
                }
            }

            delete window.__stitchState;
            window.scrollTo({ top: \#(origY), left: \#(origX), behavior: 'instant' });
            return true;
        })();
        """#
        _ = try? await webView.evaluateJavaScript(js)
    }

    private func extractDOMSummary() async throws -> DOMSummaryInput {
        let js = #"""
        (() => {
            \#(Self.sharedDOMHelpersJS)

            const UTILITY_CLASS_RE = /^(flex|inline-flex|grid|block|inline-block|inline|hidden|relative|absolute|fixed|sticky|static|container|row|col|w-|h-|min-|max-|m[trblxy]?-|p[trblxy]?-|space-|gap-|items-|justify-|content-|self-|place-|text-|font-|leading-|tracking-|bg-|border|rounded|shadow|opacity-|z-|overflow-|transition|duration-|ease-|cursor-|select-|pointer-events-|sr-only|clearfix|active|open|show|visible|fade|d-)/i;

            const escapeAttrVal = (val) => val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

            const buildSelector = (el) => {
                if (el.id && typeof el.id === 'string' && el.id.trim()) {
                    return '#' + CSS.escape(el.id.trim());
                }
                const tag = el.tagName.toLowerCase();
                const attrKeys = ['data-testid', 'data-ad-slot', 'data-ad-unit', 'data-ad-name', 'data-ad-region', 'data-widget-id'];
                for (const attr of attrKeys) {
                    const val = el.getAttribute(attr);
                    if (val && val.trim() && val.length <= 80) {
                        return `${tag}[${attr}="${escapeAttrVal(val.trim())}"]`;
                    }
                }
                if (typeof el.className === 'string' && el.className.trim()) {
                    const meaningful = el.className
                        .trim()
                        .split(/\s+/)
                        .filter(c => c.length > 1 && !UTILITY_CLASS_RE.test(c));
                    if (meaningful.length > 0) {
                        return tag + meaningful.slice(0, 3).map(c => '.' + CSS.escape(c)).join('');
                    }
                }
                const ariaLabel = el.getAttribute('aria-label');
                if (ariaLabel && ariaLabel.trim() && ariaLabel.length <= 60) {
                    return `${tag}[aria-label="${escapeAttrVal(ariaLabel.trim())}"]`;
                }
                // Never return a bare HTML tag name.
                return null;
            };

            const SUSPECT_INLINE_RE = /(?:^|[-_\s])(ad|ads|advert|advertisement|adslot|adunit|sponsor|sponsored|promo|promoted|outbrain|taboola|mgid|dfp|gpt|banner|newsletter|subscribe|paywall|cookie|consent|gdpr|commercial|partner)(?:$|[-_\s\d])/i;

            const candidates = [];
            const seenSelectors = new Set();
            const all = document.querySelectorAll('body *');

            for (const el of all) {
                if (candidates.length >= 50) break;
                if (isProtectedContent(el)) continue;

                const style = getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') continue;

                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) continue;

                const z = parseInt(style.zIndex || '0', 10) || 0;
                const isOverlay = style.position === 'fixed' || style.position === 'sticky' || z >= 50;

                const idStr = el.id || '';
                const classStr = typeof el.className === 'string' ? el.className : '';
                const ariaStr = el.getAttribute('aria-label') || '';
                const testIdStr = el.getAttribute('data-testid') || '';
                const snippet = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);

                const isSuspectInline = r.height < Math.max(window.innerHeight * 1.2, 1100) && (
                    SUSPECT_INLINE_RE.test(idStr) ||
                    SUSPECT_INLINE_RE.test(classStr) ||
                    SUSPECT_INLINE_RE.test(ariaStr) ||
                    SUSPECT_INLINE_RE.test(testIdStr) ||
                    (snippet.length > 0 && snippet.length <= 50 && AD_LABEL_ONLY_RE.test(snippet))
                );

                if (!isOverlay && !isSuspectInline) continue;

                const selector = buildSelector(el);
                if (!selector || seenSelectors.has(selector)) continue;
                seenSelectors.add(selector);

                candidates.push({
                    selector: selector,
                    tagName: el.tagName.toLowerCase(),
                    position: style.position,
                    zIndex: style.zIndex || 'auto',
                    rectSummary: `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)}`,
                    textSnippet: snippet,
                    ariaLabel: ariaStr.slice(0, 80),
                    id: idStr.slice(0, 80),
                    className: classStr.slice(0, 80)
                });
            }

            return JSON.stringify({
                url: location.href,
                domain: location.hostname,
                candidates: candidates
            });
        })();
        """#
        let json = try await evaluateStringJS(js)
        guard let data = json.data(using: .utf8) else {
            throw WebCaptureError.captureFailed("Could not serialize DOM summary.")
        }
        return try JSONDecoder().decode(DOMSummaryInput.self, from: data)
    }

    private func extractPageNavigationContext() async throws -> PageNavigationContext? {
        let js = #"""
        (() => {
            const relLink = document.querySelector('link[rel~="next"][href], a[rel~="next"][href]');
            const relNextURL = relLink ? relLink.href : null;
            const PAGINATION_CONTAINER_SEL = '.pagination, .pager, .page-numbers, .pagenavi, .wp-pagenavi, nav[aria-label*="pag" i], [role="navigation"][aria-label*="pag" i]';
            const PAGINATION_URL_RE = /[?&](?:page|p|pg|paged)=\d+|(?:\/page\/|\/p\/|\/part\/|-page-|-part-|_page_|_part_)\d+/i;
            const PAGINATION_TEXT_RE = /\b(next|older\s+posts|older\s+entries|continue\s+reading|page|pager|pagination|pagenavi)\b|^(?:→|›|»|>|\d{1,3})$/i;

            const priorityLinks = [];
            const fallbackLinks = [];
            const seenHrefs = new Set();
            const anchors = document.querySelectorAll('a[href]');

            for (const a of anchors) {
                const rawHref = (a.getAttribute('href') || '').trim();
                if (!rawHref || rawHref.startsWith('#')) continue;
                const lowerHref = rawHref.toLowerCase();
                if (lowerHref.startsWith('javascript:') || lowerHref.startsWith('mailto:') || lowerHref.startsWith('tel:')) continue;

                const dedupeKey = a.href || rawHref;
                if (seenHrefs.has(dedupeKey)) continue;
                seenHrefs.add(dedupeKey);

                const text = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
                const rel = a.getAttribute('rel') || '';
                const ariaLabel = (a.getAttribute('aria-label') || '').slice(0, 80);
                const className = (typeof a.className === 'string' ? a.className : '').slice(0, 80);
                const entry = { text, href: rawHref, rel, ariaLabel, className };

                const inPagination = Boolean(a.closest && a.closest(PAGINATION_CONTAINER_SEL));
                const combined = `${text} ${rel} ${ariaLabel} ${className}`;
                if (inPagination || /\bnext\b/i.test(rel) || PAGINATION_URL_RE.test(dedupeKey) || PAGINATION_TEXT_RE.test(combined)) {
                    priorityLinks.push(entry);
                } else if (fallbackLinks.length < 80) {
                    fallbackLinks.push(entry);
                }
            }

            const links = [...priorityLinks, ...fallbackLinks].slice(0, 80);
            return JSON.stringify({
                url: location.href,
                title: document.title || '',
                relNextURL: relNextURL,
                links: links
            });
        })();
        """#
        let json = try await evaluateStringJS(js)
        guard let data = json.data(using: .utf8) else { return nil }
        return try JSONDecoder().decode(PageNavigationContext.self, from: data)
    }

    private func evaluateStringJS(_ script: String) async throws -> String {
        let result = try await webView.evaluateJavaScript(script)
        guard let stringValue = result as? String else {
            throw WebCaptureError.captureFailed("Unexpected JS evaluation result.")
        }
        return stringValue
    }

    // MARK: - Delegate Callbacks

    fileprivate func syncWebViewState() {
        currentURL = webView.url
        if let urlString = webView.url?.absoluteString {
            currentURLString = urlString
        }
        pageTitle = webView.title ?? ""
        canGoBack = webView.canGoBack
        canGoForward = webView.canGoForward
        estimatedProgress = webView.estimatedProgress
        isLoading = webView.isLoading
    }

    fileprivate func didStartProvisionalNavigation() {
        didCommitCurrentNavigation = false
        syncWebViewState()
    }

    fileprivate func didCommitNavigation() {
        didCommitCurrentNavigation = true
        if webView.url != nil {
            hasCommittedPage = true
        }
        syncWebViewState()
    }

    fileprivate func didFinishNavigation() {
        didCommitCurrentNavigation = true
        if webView.url != nil {
            hasCommittedPage = true
        }
        syncWebViewState()
        finishPendingNavigation(with: .success(()))
    }

    fileprivate func didFailNavigation(_ error: Error) {
        syncWebViewState()
        let nsError = error as NSError
        // Ignore cancelled load notifications (e.g. rapid redirects or stopLoading).
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
            return
        }
        if nsError.domain == WKError.errorDomain && nsError.code == 102 {
            return
        }
        if !isCapturing {
            errorMessage = error.localizedDescription
        }
        finishPendingNavigation(with: .failure(WebCaptureError.navigationFailed(error.localizedDescription)))
    }

    fileprivate func didTerminateWebContentProcess() {
        didCommitCurrentNavigation = false
        hasCommittedPage = false
        syncWebViewState()
        finishPendingNavigation(with: .failure(WebCaptureError.navigationFailed("Web content process terminated.")))
    }
}

private final class WebViewDelegateProxy: NSObject, WKNavigationDelegate, WKUIDelegate {
    weak var owner: WebCaptureService?
    private var progressObservation: NSKeyValueObservation?

    init(owner: WebCaptureService) {
        self.owner = owner
        super.init()
        progressObservation = owner.webView.observe(\.estimatedProgress, options: [.new]) { [weak self] _, _ in
            Task { @MainActor [weak self] in
                self?.owner?.syncWebViewState()
            }
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        owner?.didStartProvisionalNavigation()
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        owner?.didCommitNavigation()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        owner?.didFinishNavigation()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        owner?.didFailNavigation(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        owner?.didFailNavigation(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        owner?.didTerminateWebContentProcess()
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }
}
