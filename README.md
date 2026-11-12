# PageStitch — Cross-Platform Full-Page & Multi-Page Screenshot Stitcher

**PageStitch** captures full scrolling web pages and multi-page paginated articles into a **single, clean PNG or JPEG image**—across desktop (**Manifest V3 Chrome Extension**) and iPhone (**SwiftUI iOS App + Share Extension**).

By design, **the final output is strictly an image (`PNG` or `JPEG`)**—no text summaries, AI captions, or secondary text exports. Optional **Gemini (`gemini-3.8-flash`)** integration runs solely *before* capture to improve image cleanliness and multi-page continuity.

---

## Architecture Overview

```mermaid
flowchart LR
    subgraph Browser["Chrome Extension (MV3)"]
        Popup["Popup UI"] --> SW["Service Worker"]
        SW --> Inspector["Content Inspector"]
        SW --> Offscreen["Offscreen Canvas Stitcher"]
    end

    subgraph Mobile["iOS App + Share Extension"]
        ShareExt["StitchShareExtension"] -->|"stitchscreenshot://capture?url=..."| App["StitchScreenshot App"]
        App --> WebCap["WKWebView Capture Engine"]
        WebCap --> Stitcher["ImageStitcher"]
    end

    subgraph OptionalAI["Optional Gemini Pre-Capture Layer"]
        Gemini["Gemini 3.8 Flash\n(Interactions API)"]
    end

    SW -. "DOM summary / link candidates" .-> Gemini
    WebCap -. "DOM summary / link candidates" .-> Gemini
    Gemini -. "Clutter CSS selectors + Next Page URL" .-> SW
    Gemini -. "Clutter CSS selectors + Next Page URL" .-> WebCap

    Offscreen --> ImageOut["Clean PNG / JPEG Image"]
    Stitcher --> ImageOut
```

### How Gemini Improves Image Capture (Optional)
Both clients work deterministically offline using native browser/iOS rendering and heuristic cleanup. When you supply a Gemini API key in Settings, both clients call `gemini-3.8-flash` via the Gemini **Interactions API** (`POST https://generativelanguage.googleapis.com/v1beta/interactions` with `Api-Revision: 2026-05-20` and structured `response_format`) for two focused pre-capture tasks:

1. **Pre-Capture Decluttering (`detectClutterSelectors` / `detectClutterSelectors(domSummary:)`):** Inspects a compact DOM summary of `position: fixed` / `sticky` overlays, cookie banners, modals, inline/in-between article ads, and sponsored widgets, returning sanitized CSS selectors to temporarily collapse before capturing (restored byte-for-byte immediately afterward). Discovered selectors are cached per domain (`chrome.storage.local` on Chrome; `UserDefaults` via `DomainSelectorCache` on iOS).
2. **Smart Pagination Detection (`detectNextPageUrl` / `detectNextPageURL(pageContext:)`):** Evaluates candidate links (`<a>` / `<link rel="next">`) on paginated articles to locate the true continuation URL without accidentally following "Related" or "Next Article" links.

> **Pixel Fidelity:** Actual page pixels are always rendered natively by Chromium (`chrome.tabs.captureVisibleTab` + Offscreen Canvas) and WebKit (`WKWebView.takeSnapshot(with:)` + CoreGraphics). Gemini never alters or regenerates page text or pixels.

---

## Repository Layout

```text
.
├── AGENTS.md
├── LICENSE
├── README.md
├── chrome-extension/
│   ├── manifest.json                   # Manifest V3 config
│   ├── package.json                    # Node test runner script
│   ├── background/
│   │   └── service-worker.js           # Stateless MV3 capture & download coordinator
│   ├── content/
│   │   └── page-inspector.js           # Time-sliced DOM inspection, ad/wrapper collapse & fixed-bar hiding
│   ├── offscreen/
│   │   ├── offscreen.html
│   │   └── offscreen.js                # Streaming canvas stitcher & Blob URL lifecycle helper
│   ├── popup/
│   │   ├── popup.html                  # Semantic, accessible popup UI
│   │   ├── popup.css
│   │   └── popup.js
│   ├── shared/
│   │   ├── gemini-client.js            # Gemini 3.8 Flash Interactions API + domain TTL cache
│   │   └── stitch-math.js              # Pure scroll offset, DPR crop, scale & link scoring helpers
│   ├── scripts/
│   │   └── generate-icons.mjs          # Generates 16x16, 48x48, 128x128 RGBA PNG icons
│   ├── icons/
│   │   ├── icon-16.png
│   │   ├── icon-48.png
│   │   └── icon-128.png
│   └── tests/
│       └── extension.test.js           # 17 unit & MV3/CSP compliance tests
└── ios-app/
    └── StitchScreenshot/
        ├── StitchScreenshot.xcodeproj/
        │   ├── project.pbxproj
        │   └── xcshareddata/xcschemes/
        │       └── StitchScreenshot.xcscheme
        ├── StitchScreenshot/
        │   ├── StitchScreenshotApp.swift   # App entry + deep-link URL handler
        │   ├── ContentView.swift           # In-app WKWebView browser, staged tray & capture bar
        │   ├── Info.plist                  # CFBundleURLTypes + NSPhotoLibraryAddUsageDescription
        │   ├── Models/
        │   │   └── CaptureModels.swift     # Format, StagedPage, DeepLinkParser, AppSettingsStore
        │   ├── Services/
        │   │   ├── GeminiService.swift     # Gemini 3.8 Flash Interactions API + DomainSelectorCache
        │   │   ├── ImageStitcher.swift     # CoreGraphics vertical stitcher, overlap crop & encoder
        │   │   ├── KeychainService.swift   # Secure Keychain storage for Gemini API key
        │   │   ├── PhotoLibraryService.swift
        │   │   └── WebCaptureService.swift # WKWebView snapshot capture, ad/clutter collapse & auto-stitch
        │   └── Views/
        │       ├── PreviewSheet.swift      # Zoomable image preview, Photos save, Copy & Share Sheet
        │       ├── SettingsView.swift      # Keychain API key & capture settings
        │       └── WebViewContainer.swift
        ├── StitchShareExtension/
        │   ├── Base.lproj/
        │   │   └── MainInterface.storyboard
        │   ├── Info.plist                  # Web URL & text share activation rules
        │   └── ShareViewController.swift   # Extracts shared URL and opens host app
        ├── StitchScreenshotTests/
        │   └── StitchScreenshotTests.swift # 17 Swift unit tests
        └── StitchScreenshotUITests/
            └── StitchScreenshotUITests.swift
```

---

## 1. Chrome Extension (`chrome-extension/`)

### Capabilities
- **Capture Full Page:** Dynamically scrolls through the active tab (`560ms` pacing + quota retry backoff for `captureVisibleTab`), suppresses bottom bars before slice 0 and sticky/fixed bars on subsequent slices, promotes lazy images to eager decode, crops sub-pixel DPR overlaps seamlessly, and streams slices to an offscreen document (`chrome.offscreen`) with live cancellation support.
- **Append & Stitch (Manual Multi-Page):** Stage captures across multiple pages using per-page `chrome.storage.local` keys, navigate manually, and stream staged pages into one vertical image.
- **Auto-Capture Multi-Page:** Walks paginated articles up to a configurable page limit (`2–15` pages) using Gemini or `rel="next"`/pagination heuristics, preventing duplicate or redirect URL loops.
- **Inline Ad, Wrapper & Overlay Cleanup:** Temporarily collapses in-article ads (AdSense/GPT, Taboola, Outbrain, publisher ad slots), `"Advertisement"`/`"Sponsored"` placeholder boxes, and empty CLS `min-height` reserve wrappers while protecting article prose, headings, and legitimate embeds—restoring original inline styles byte-for-byte in `try/finally`.
- **Image-Only Export:** Preview thumbnail in popup, **Copy Image** (`ClipboardItem` PNG), or **Download Image** (`chrome.downloads.download` backed by offscreen `Blob` URLs for large PNG/JPEG exports).
- **Canvas Safety:** `computeSafeCanvasScale` automatically scales oversized dimensions to stay within `16384×16384` / `268M` px browser canvas limits without rounding seams.

### Installation (Developer Mode)
1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select `chrome-extension/`.
4. Click the **PageStitch** toolbar icon on any `http://` or `https://` page.
5. *(Optional)* Expand **Settings**, paste your Gemini API key (stored locally in `chrome.storage.local`), choose PNG or JPEG, and adjust max auto-pages.

### Running Chrome Extension Tests
Requires Node.js (v20+ recommended):

```sh
cd chrome-extension
npm test
```

The test suite (`node --test tests/*.test.js`) verifies:
- Scroll offset calculation, fractional-DPR bottom-slice overlap cropping, and seam-free multi-page downscaling (`stitch-math.js`)
- Pagination candidate scoring and CSS selector sanitization/cache filtering
- Gemini Interactions API headers (`x-goog-api-key`, `Api-Revision`), model (`gemini-3.8-flash`), JSON schema payload, `steps` / `outputs` parsing, bounded request timeouts, candidate URL validation, and 7-day domain cache TTL (`gemini-client.js`)
- Mock-DOM execution of `page-inspector.js` verifying inline ad + CLS `min-height` wrapper collapse, Slice-0 bottom-bar hiding, protected article/YouTube embed preservation, and byte-exact style restoration
- `manifest.json` MV3 validity, real PNG icon IHDR dimensions (`16×16`, `48×48`, `128×128`), offscreen `Blob` URL lifecycle & API boundary enforcement, zero inline `<script>` / event handlers / `style` attributes in HTML, and `node --check` syntax across all JS files.

---

## 2. iOS App & Share Extension (`ios-app/StitchScreenshot/`)

### Capabilities
- **In-App `WKWebView` Browser:** Address bar, Back/Forward/Reload/Stop controls, quick links, and clipboard URL paste-and-open.
- **Share Extension (`StitchShareExtension`):** Tap **Share** in Safari, Chrome, or other iOS apps to hand off a webpage URL directly to `StitchScreenshot` via `stitchscreenshot://capture?url=<encoded>`.
- **Full-Page & Multi-Page Stitching:**
  - Scroll-and-stitch via `WKWebView.takeSnapshot(with:)` with inline ad & CLS reserve-wrapper collapse, bottom-bar & sticky-header suppression, seam-safe lazy ad cleanup, `cropTopAndBottomOverlap`, and responsive task cancellation.
  - Manual **Append** tray with thumbnail reordering and deletion before **Stitch**.
  - **Auto Stitch** for paginated articles using `GeminiService` or `PaginationHeuristic`.
  - `ImageStitcher` aligns mismatched widths proportionally without cumulative rounding drift and caps output safely (`3600px` max width, `24000px` max height by default) to stay within iOS memory budgets.
- **Image-Only Export & Sharing:** Smooth 60fps zoomable preview in `PreviewSheet` (async byte-size calculation), **PNG / JPEG** format toggle, **Save to Photos** (`PHPhotoLibrary` `.addOnly`), **Copy Image** (`UIPasteboard.general`), and native `UIActivityViewController` Share Sheet sharing only the rendered image.
- **Secure Keychain Storage:** Optional Gemini API key stored via `KeychainService` (`Security` framework) inside **Settings**.

### Running in Xcode
1. Open `ios-app/StitchScreenshot/StitchScreenshot.xcodeproj` in Xcode.
2. Select the **`StitchScreenshot`** scheme and choose an iOS Simulator (e.g., `iPhone 18 Pro`) or physical iOS device (set your Development Team under Signing & Capabilities for device builds).
3. Press **Cmd+R** to launch, or **Cmd+U** to run `StitchScreenshotTests` and `StitchScreenshotUITests`.

### Running iOS Tests from CLI
```sh
xcodebuild test \
  -project ios-app/StitchScreenshot/StitchScreenshot.xcodeproj \
  -scheme StitchScreenshot \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro'
```

The iOS test targets verify:
- `@3x` Retina stitching, 35-slice downscale cumulative-rounding accuracy, mismatched-width scaling, overlap cropping, PNG/JPEG encoding headers, and stale temp file pruning (`ImageStitcher`)
- Gemini Interactions API `response_format` schema envelope, `"thought"` step filtering, plain-string/keyed `outputs` decoding, `CSSSelectorSanitizer`, 7-day `DomainSelectorCache` TTL, and candidate-validated next-page URL resolution (`GeminiService`)
- `DeepLinkParser` round-trips, word-boundary `PaginationHeuristic` scoring, `KeychainService` lifecycle, and `StitchScreenshotUITests` launch/controls smoke checks.

---

## Packaging & Deployment

### 1. Chrome Web Store Deployment
1. Generate the distribution bundle:
   ```sh
   cd chrome-extension
   npm run package
   ```
   This creates a verified production archive at `dist/pagestitch-chrome-extension-v<version>.zip` containing strictly the runtime assets (excluding tests and development scripts).
2. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
3. Click **Add new item** (or select existing item) and upload the zip file from `dist/`.
4. Fill in the store listing metadata, screenshots, and privacy practices, then submit for review.

### 2. iOS App Store / TestFlight Deployment
1. Open `ios-app/StitchScreenshot/StitchScreenshot.xcodeproj` in Xcode.
2. Under **Signing & Capabilities**, select your Apple Developer Team and ensure provisioning profiles are assigned for both `StitchScreenshot` and `StitchShareExtension`.
3. Select **Any iOS Device (arm64)** as the target.
4. Choose **Product > Archive**.
5. Once the Organizer opens, click **Distribute App** to upload the build to **TestFlight** / **App Store Connect**.

### 3. Continuous Integration & Artifacts
The repository includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that automatically:
- Runs the Chrome extension test suite and packages the extension into a downloadable release artifact on every push.
- Runs the iOS test suite and builds the generic iOS release scheme on macOS runners.

---

## Troubleshooting & Caveats
- **Restricted Chrome pages:** Chrome blocks extensions from capturing `chrome://`, `chrome-extension://`, and Chrome Web Store URLs.
- **Infinite scroll / dynamic SPAs:** Very long infinite-scroll feeds are clamped safely (`60,000px` CSS height on Chrome; `24,000px` output height cap on iOS) to prevent tab or app OOM crashes.
- **Share Extension handoff:** `StitchShareExtension` hands the URL off via `stitchscreenshot://capture?url=...` so no paid Apple Developer App Group entitlement is required to build and run on Simulator.
- **API Key Privacy:** Gemini API keys are stored strictly locally (`chrome.storage.local` in Chrome, iOS Keychain on iPhone) and are never hardcoded or committed to git.
