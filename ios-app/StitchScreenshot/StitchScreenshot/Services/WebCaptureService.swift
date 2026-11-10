import Foundation
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

    var isCapturing: Bool = false
    var captureStatus: String = ""
    var stagedPages: [StagedPage] = []
    var errorMessage: String?

    private let geminiService: GeminiService
    private let keychain: KeychainStoring
    private var navigationContinuation: CheckedContinuation<Void, Error>?
    private var activeCaptureTask: Task<Void, Never>?
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
        activeCaptureTask?.cancel()
        activeCaptureTask = nil
        navigationContinuation?.resume(throwing: WebCaptureError.cancelled)
        navigationContinuation = nil
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

    func stitchStagedPages() throws -> CapturedImageResult {
        let images = stagedPages.map(\.image)
        let stitched = try ImageStitcher.stitchVertically(images)
        return CapturedImageResult(
            image: stitched,
            pageCount: stagedPages.count,
            sourceURL: stagedPages.first?.url ?? currentURL
        )
    }

    // MARK: - Single & Multi-Page Capture

    func captureFullPage(autoCleanClutter: Bool) async throws -> CapturedImageResult {
        guard hasLoadedAnyPage, webView.url != nil else {
            throw WebCaptureError.noPageLoaded
        }
        guard !isCapturing else {
            throw WebCaptureError.captureFailed("A capture is already in progress.")
        }

        isCapturing = true
        captureStatus = "Preparing page..."
        defer {
            isCapturing = false
            captureStatus = ""
        }

        let pageImage = try await captureCurrentWebPage(autoCleanClutter: autoCleanClutter)
        return CapturedImageResult(
            image: pageImage,
            pageCount: 1,
            sourceURL: webView.url ?? currentURL
        )
    }

    func captureAndAppendPage(autoCleanClutter: Bool) async throws {
        guard hasLoadedAnyPage, let activeURL = webView.url else {
            throw WebCaptureError.noPageLoaded
        }
        guard !isCapturing else {
            throw WebCaptureError.captureFailed("A capture is already in progress.")
        }

        isCapturing = true
        captureStatus = "Capturing page \(stagedPages.count + 1)..."
        defer {
            isCapturing = false
            captureStatus = ""
        }

        let image = try await captureCurrentWebPage(autoCleanClutter: autoCleanClutter)
        let title = pageTitle.isEmpty ? (activeURL.host ?? "Page \(stagedPages.count + 1)") : pageTitle
        stagedPages.append(StagedPage(url: activeURL, title: title, image: image))
    }

    func autoCaptureMultiPage(maxPages: Int, autoCleanClutter: Bool) async throws -> CapturedImageResult {
        guard hasLoadedAnyPage, let startURL = webView.url else {
            throw WebCaptureError.noPageLoaded
        }
        guard !isCapturing else {
            throw WebCaptureError.captureFailed("A capture is already in progress.")
        }

        isCapturing = true
        defer {
            isCapturing = false
            captureStatus = ""
        }

        let clampedMax = min(max(maxPages, 1), 15)
        var capturedImages: [UIImage] = []
        var visited = Set<String>([normalizedURLKey(startURL)])

        for pageNumber in 1...clampedMax {
            try Task.checkCancellation()
            captureStatus = "Capturing page \(pageNumber) of \(clampedMax)..."

            let pageImage = try await captureCurrentWebPage(autoCleanClutter: autoCleanClutter)
            capturedImages.append(pageImage)

            if pageNumber == clampedMax {
                break
            }

            captureStatus = "Finding next page link..."
            guard let nextURL = try await resolveNextPageURL() else {
                break
            }

            let key = normalizedURLKey(nextURL)
            guard !visited.contains(key) else {
                break
            }
            visited.insert(key)

            captureStatus = "Loading page \(pageNumber + 1)..."
            try await navigateAndAwaitLoad(url: nextURL)
            // Brief settle for lazy layout/fonts after didFinish.
            try await Task.sleep(for: .milliseconds(400))
        }

        captureStatus = "Stitching \(capturedImages.count) page(s)..."
        let stitched = try ImageStitcher.stitchVertically(capturedImages)
        return CapturedImageResult(
            image: stitched,
            pageCount: capturedImages.count,
            sourceURL: startURL
        )
    }

    // MARK: - Core Scroll-and-Stitch Engine

    private func captureCurrentWebPage(autoCleanClutter: Bool) async throws -> UIImage {
        let bounds = webView.bounds
        guard bounds.width > 10, bounds.height > 10 else {
            throw WebCaptureError.invalidWebViewBounds
        }

        var extraSelectors: [String] = []
        if autoCleanClutter {
            captureStatus = "Cleaning overlays..."
            extraSelectors = await detectExtraClutterSelectorsIfConfigured()
        }

        let metrics = try await readScrollMetrics()
        let viewportHeight = max(1, metrics.viewportHeight)
        let scrollHeight = max(viewportHeight, metrics.scrollHeight)

        try await applyPreCaptureSetup(
            autoCleanClutter: autoCleanClutter,
            extraSelectors: extraSelectors
        )

        var didRestore = false
        defer {
            if !didRestore {
                Task { @MainActor [weak self] in
                    await self?.restoreAfterCapture(origX: metrics.scrollX, origY: metrics.scrollY)
                }
            }
        }

        var slices: [UIImage] = []
        let maxSlices = 35
        var targetY: CGFloat = 0
        var previousCoveredEndY: CGFloat = 0
        var stickyBarsHidden = false

        for sliceIndex in 0..<maxSlices {
            try Task.checkCancellation()

            if sliceIndex == 1 && !stickyBarsHidden {
                // Hide fixed/sticky bars on slices after the top viewport so headers never repeat down the page.
                try? await hideStickyAndFixedBarsAfterTopSlice()
                stickyBarsHidden = true
            }

            captureStatus = "Capturing slice \(sliceIndex + 1)..."
            let actualY = try await scrollTo(y: targetY)
            try await Task.sleep(for: .milliseconds(180))

            let snapshotConfig = WKSnapshotConfiguration()
            snapshotConfig.rect = CGRect(origin: .zero, size: bounds.size)
            snapshotConfig.afterScreenUpdates = true

            let snapshot = try await takeSnapshot(config: snapshotConfig)

            if sliceIndex == 0 {
                slices.append(snapshot)
                previousCoveredEndY = actualY + viewportHeight
            } else {
                let overlapPoints = previousCoveredEndY - actualY
                if overlapPoints >= viewportHeight - 2 {
                    // Reached the bottom without advancing.
                    break
                } else if overlapPoints > 1 {
                    let slicePixelHeight = CGFloat(snapshot.cgImage?.height ?? Int(snapshot.size.height * snapshot.scale))
                    let pointsToPixels = slicePixelHeight / max(1, bounds.height)
                    let topCropPixels = Int(round(overlapPoints * pointsToPixels))
                    if let cropped = ImageStitcher.cropTopAndBottomOverlap(snapshot, topCropPixels: topCropPixels) {
                        slices.append(cropped)
                    }
                } else {
                    slices.append(snapshot)
                }
                previousCoveredEndY = actualY + viewportHeight
            }

            if previousCoveredEndY >= scrollHeight - 2 {
                break
            }

            targetY = previousCoveredEndY
        }

        didRestore = true
        await restoreAfterCapture(origX: metrics.scrollX, origY: metrics.scrollY)
        return try ImageStitcher.stitchVertically(slices)
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

    // MARK: - Pagination Detection

    private func resolveNextPageURL() async throws -> URL? {
        guard let context = try await extractPageNavigationContext() else {
            return nil
        }

        if let key = keychain.loadAPIKey(), !key.isEmpty {
            if let geminiURL = try? await geminiService.detectNextPageURL(pageContext: context) {
                return geminiURL
            }
        }

        return PaginationHeuristic.findNextPageURL(in: context)
    }

    private func detectExtraClutterSelectorsIfConfigured() async -> [String] {
        guard let key = keychain.loadAPIKey(), !key.isEmpty else {
            return []
        }
        guard let summary = try? await extractDOMSummary() else {
            return []
        }
        return (try? await geminiService.detectClutterSelectors(domSummary: summary)) ?? []
    }

    // MARK: - Navigation Waiting

    private func navigateAndAwaitLoad(url: URL) async throws {
        navigationContinuation?.resume(throwing: WebCaptureError.cancelled)
        navigationContinuation = nil

        load(url: url)

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            self.navigationContinuation = continuation

            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(25))
                guard let self, let pending = self.navigationContinuation else { return }
                self.navigationContinuation = nil
                pending.resume(throwing: WebCaptureError.navigationTimeout)
            }
        }
    }

    private func normalizedURLKey(_ url: URL) -> String {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.fragment = nil
        return (components?.string ?? url.absoluteString).lowercased()
    }

    // MARK: - JavaScript DOM Helpers

    private struct ScrollMetrics: Decodable {
        let scrollHeight: CGFloat
        let viewportHeight: CGFloat
        let scrollX: CGFloat
        let scrollY: CGFloat
    }

    private func readScrollMetrics() async throws -> ScrollMetrics {
        let js = """
        (() => {
            const docEl = document.documentElement;
            const body = document.body;
            const scrollHeight = Math.max(
                docEl ? docEl.scrollHeight : 0,
                body ? body.scrollHeight : 0
            );
            const viewportHeight = window.innerHeight || (docEl ? docEl.clientHeight : 800);
            return JSON.stringify({
                scrollHeight: scrollHeight,
                viewportHeight: viewportHeight,
                scrollX: window.scrollX || 0,
                scrollY: window.scrollY || 0
            });
        })();
        """
        let json = try await evaluateStringJS(js)
        guard let data = json.data(using: .utf8) else {
            throw WebCaptureError.captureFailed("Could not read scroll metrics.")
        }
        return try JSONDecoder().decode(ScrollMetrics.self, from: data)
    }

    private func scrollTo(y: CGFloat) async throws -> CGFloat {
        let js = """
        (() => {
            window.scrollTo({ top: \(y), left: 0, behavior: 'instant' });
            return window.scrollY || document.documentElement.scrollTop || 0;
        })();
        """
        let result = try await webView.evaluateJavaScript(js)
        if let number = result as? NSNumber {
            return CGFloat(number.doubleValue)
        }
        return y
    }

    private func applyPreCaptureSetup(autoCleanClutter: Bool, extraSelectors: [String]) async throws {
        let extraJSON = String(data: try JSONEncoder().encode(extraSelectors), encoding: .utf8) ?? "[]"
        let cleanFlag = autoCleanClutter ? "true" : "false"

        let js = """
        (() => {
            if (!window.__stitchState) {
                window.__stitchState = {
                    hidden: [],
                    htmlScrollBehavior: document.documentElement ? document.documentElement.style.scrollBehavior : '',
                    bodyScrollBehavior: document.body ? document.body.style.scrollBehavior : ''
                };
            }
            if (document.documentElement) document.documentElement.style.scrollBehavior = 'auto';
            if (document.body) document.body.style.scrollBehavior = 'auto';

            const hideEl = (el) => {
                if (!el || el.dataset.stitchHidden === '1') return;
                el.dataset.stitchHidden = '1';
                window.__stitchState.hidden.push({
                    el: el,
                    visibility: el.style.visibility,
                    opacity: el.style.opacity,
                    pointerEvents: el.style.pointerEvents
                });
                el.style.setProperty('visibility', 'hidden', 'important');
                el.style.setProperty('opacity', '0', 'important');
                el.style.setProperty('pointer-events', 'none', 'important');
            };

            if (\(cleanFlag)) {
                const heuristicSelectors = [
                    '[id*="cookie" i]', '[class*="cookie" i]',
                    '[id*="consent" i]', '[class*="consent" i]',
                    '[id*="onetrust" i]', '[class*="onetrust" i]',
                    '[id*="gdpr" i]', '[class*="gdpr" i]',
                    '[class*="newsletter" i][class*="popup" i]',
                    '[class*="paywall" i]', '[aria-modal="true"]'
                ];
                for (const sel of heuristicSelectors) {
                    try {
                        document.querySelectorAll(sel).forEach(el => {
                            const style = getComputedStyle(el);
                            const rect = el.getBoundingClientRect();
                            if ((style.position === 'fixed' || style.position === 'sticky' || parseInt(style.zIndex || '0', 10) >= 20)
                                && rect.height > 0 && rect.height < window.innerHeight * 0.85) {
                                hideEl(el);
                            }
                        });
                    } catch (_) {}
                }

                // Also hide bottom/floating chat widgets or small fixed overlays.
                document.querySelectorAll('body *').forEach(el => {
                    const style = getComputedStyle(el);
                    if (style.position !== 'fixed') return;
                    const rect = el.getBoundingClientRect();
                    const isSmallFloatingWidget = rect.width > 0 && rect.height > 0 &&
                        rect.height < window.innerHeight * 0.45 &&
                        (rect.bottom > window.innerHeight * 0.55 || rect.top > 80);
                    if (isSmallFloatingWidget) {
                        hideEl(el);
                    }
                });

                const extraSelectors = \(extraJSON);
                for (const sel of extraSelectors) {
                    try {
                        document.querySelectorAll(sel).forEach(hideEl);
                    } catch (_) {}
                }
            }
            return true;
        })();
        """
        _ = try? await webView.evaluateJavaScript(js)
    }

    private func hideStickyAndFixedBarsAfterTopSlice() async throws {
        let js = """
        (() => {
            if (!window.__stitchState) return false;
            const hideEl = (el) => {
                if (!el || el.dataset.stitchHidden === '1') return;
                el.dataset.stitchHidden = '1';
                window.__stitchState.hidden.push({
                    el: el,
                    visibility: el.style.visibility,
                    opacity: el.style.opacity,
                    pointerEvents: el.style.pointerEvents
                });
                el.style.setProperty('visibility', 'hidden', 'important');
                el.style.setProperty('opacity', '0', 'important');
                el.style.setProperty('pointer-events', 'none', 'important');
            };
            document.querySelectorAll('body *').forEach(el => {
                const style = getComputedStyle(el);
                if (style.position === 'fixed' || style.position === 'sticky') {
                    const rect = el.getBoundingClientRect();
                    if (rect.height > 0 && rect.height < window.innerHeight * 0.45) {
                        hideEl(el);
                    }
                }
            });
            return true;
        })();
        """
        _ = try? await webView.evaluateJavaScript(js)
    }

    private func restoreAfterCapture(origX: CGFloat, origY: CGFloat) async {
        let js = """
        (() => {
            const state = window.__stitchState;
            if (state) {
                for (const item of state.hidden) {
                    try {
                        delete item.el.dataset.stitchHidden;
                        item.el.style.visibility = item.visibility || '';
                        item.el.style.opacity = item.opacity || '';
                        item.el.style.pointerEvents = item.pointerEvents || '';
                    } catch (_) {}
                }
                if (document.documentElement) {
                    document.documentElement.style.scrollBehavior = state.htmlScrollBehavior || '';
                }
                if (document.body) {
                    document.body.style.scrollBehavior = state.bodyScrollBehavior || '';
                }
                delete window.__stitchState;
            }
            window.scrollTo(\(origX), \(origY));
            return true;
        })();
        """
        _ = try? await webView.evaluateJavaScript(js)
    }

    private func extractDOMSummary() async throws -> DOMSummaryInput {
        let js = """
        (() => {
            const buildSelector = (el) => {
                if (el.id) return '#' + CSS.escape(el.id);
                const tag = el.tagName.toLowerCase();
                if (typeof el.className === 'string' && el.className.trim()) {
                    const classes = el.className.trim().split(/\\s+/).slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
                    if (classes) return tag + classes;
                }
                return tag;
            };
            const candidates = [];
            const all = document.querySelectorAll('body *');
            for (const el of all) {
                if (candidates.length >= 40) break;
                const style = getComputedStyle(el);
                const z = parseInt(style.zIndex || '0', 10) || 0;
                if (style.position === 'fixed' || style.position === 'sticky' || z >= 50) {
                    const r = el.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) continue;
                    candidates.push({
                        selector: buildSelector(el),
                        tagName: el.tagName.toLowerCase(),
                        position: style.position,
                        zIndex: style.zIndex || 'auto',
                        rectSummary: `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)}`,
                        textSnippet: (el.innerText || '').trim().slice(0, 80),
                        ariaLabel: el.getAttribute('aria-label') || '',
                        id: el.id || '',
                        className: (typeof el.className === 'string' ? el.className : '').slice(0, 80)
                    });
                }
            }
            return JSON.stringify({
                url: location.href,
                domain: location.hostname,
                candidates: candidates
            });
        })();
        """
        let json = try await evaluateStringJS(js)
        guard let data = json.data(using: .utf8) else {
            throw WebCaptureError.captureFailed("Could not serialize DOM summary.")
        }
        return try JSONDecoder().decode(DOMSummaryInput.self, from: data)
    }

    private func extractPageNavigationContext() async throws -> PageNavigationContext? {
        let js = """
        (() => {
            const relLink = document.querySelector('link[rel="next"], a[rel="next"]');
            const relNextURL = relLink ? relLink.href : null;
            const links = [];
            const anchors = document.querySelectorAll('a[href]');
            for (const a of anchors) {
                if (links.length >= 60) break;
                const href = a.getAttribute('href') || '';
                const text = (a.innerText || a.textContent || '').trim().slice(0, 80);
                const rel = a.getAttribute('rel') || '';
                const ariaLabel = a.getAttribute('aria-label') || '';
                const className = (typeof a.className === 'string' ? a.className : '').slice(0, 80);
                if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
                links.push({ text, href, rel, ariaLabel, className });
            }
            return JSON.stringify({
                url: location.href,
                title: document.title || '',
                relNextURL: relNextURL,
                links: links
            });
        })();
        """
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

    fileprivate func didFinishNavigation() {
        syncWebViewState()
        navigationContinuation?.resume()
        navigationContinuation = nil
    }

    fileprivate func didFailNavigation(_ error: Error) {
        syncWebViewState()
        let nsError = error as NSError
        // Ignore cancelled load notifications (e.g. rapid redirects).
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
            return
        }
        errorMessage = error.localizedDescription
        navigationContinuation?.resume(throwing: WebCaptureError.navigationFailed(error.localizedDescription))
        navigationContinuation = nil
    }
}

private final class WebViewDelegateProxy: NSObject, WKNavigationDelegate, WKUIDelegate {
    weak var owner: WebCaptureService?
    private var progressObservation: NSKeyValueObservation?

    init(owner: WebCaptureService) {
        self.owner = owner
        super.init()
        progressObservation = owner.webView.observe(\.estimatedProgress, options: [.new]) { [weak owner] _, _ in
            Task { @MainActor in
                owner?.syncWebViewState()
            }
        }
    }

    nonisolated func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        Task { @MainActor in
            owner?.syncWebViewState()
        }
    }

    nonisolated func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        Task { @MainActor in
            owner?.syncWebViewState()
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in
            owner?.didFinishNavigation()
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Task { @MainActor in
            owner?.didFailNavigation(error)
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        Task { @MainActor in
            owner?.didFailNavigation(error)
        }
    }

    nonisolated func webView(
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
