# AGENTS.md — Coding & Contribution Guide

This file defines repository invariants, architecture boundaries, and verification commands for AI agents and contributors working in `stitch-screenshot-images`.

## Core Product Invariant (Do Not Violate)
- **Pure Image Capture & Pure Image Output Only:** Both the Chrome extension and the iOS app exist solely to capture web pages (single scrolling pages and multi-page articles) and output **images (`PNG` or `JPEG`)**.
- Do **not** add text summaries, social media captions, alt-text generators, markdown exporters, or non-image outputs.
- **Gemini API usage (`gemini-3.8-flash`) is strictly pre-capture only:**
  1. Identifying CSS selectors for overlays, cookie banners, sticky bars, inline/in-between article ad containers, and sponsored widgets to temporarily collapse before capturing.
  2. Identifying the true "Next Page" URL on paginated articles.
- Page pixels must always come from native browser/WebKit rendering—never AI-generated or AI-redrawn images.
- **Non-Destructive DOM Cleanup:** Pre-capture cleanup must always protect primary content (`<main>`, `<article>`, `<nav>`, headings, prose blocks, and legitimate embeds such as YouTube, Vimeo, Spotify, X/Instagram, CodePen, Maps) and restore every modified inline `style` and `img[loading]` attribute byte-for-byte after capture.

---

## Gemini API Standards
When editing `chrome-extension/shared/gemini-client.js` or `ios-app/StitchScreenshot/StitchScreenshot/Services/GeminiService.swift`:
- **Model:** Always use `gemini-3.8-flash` (never deprecated `gemini-2.5-*`, `gemini-2.0-*`, or `gemini-1.5-*`).
- **Endpoint & Headers:**
  - `POST https://generativelanguage.googleapis.com/v1beta/interactions`
  - `Content-Type: application/json`
  - `x-goog-api-key: <user-provided-key>`
  - `Api-Revision: 2026-05-20`
- **Structured Output:** Use `response_format: { "type": "text", "mime_type": "application/json", "schema": ... }` (do not use legacy `response_mime_type` or `generation_config`).
- **Response Parsing:** Decode `steps` (`step.type == "model_output"` -> `content` text items, ignoring `"thought"` parts), with a defensive fallback for `outputs` (both keyed objects and plain strings).
- **Validation & Timeouts:** Enforce bounded request timeouts (`AbortController` in JS; `URLRequest.timeoutInterval` in Swift), sanitize all CSS selectors before injection/caching (blocking bare HTML/semantic/media/table/form tags and stripping dynamic numeric ad instance IDs from domain caches), and validate returned next-page URLs against candidate links present on the page.
- **Offline / No-Key Parity:** Every capture workflow must still work cleanly without an API key via heuristic ad/wrapper cleanup and manual/heuristic pagination.

---

## Chrome Extension Rules (`chrome-extension/`)
- **Manifest V3 Only:** No MV2 APIs (`background.scripts`, `browserAction`, `tabs.executeScript`).
- **Async/Await Only:** Avoid `.then()` chains; async `chrome.runtime.onMessage` listeners must `return true` to keep the response channel open.
- **Stateless Service Worker:** Never rely on in-memory globals in `background/service-worker.js` for persistent or cross-wake state; persist in `chrome.storage.local` / `chrome.storage.session` (with heartbeat timestamps for stale capture lock recovery and lightweight metadata in `GET_STATE`).
- **Pre-Capture & Seam-Safe Ad Cleanup (`content/page-inspector.js`):**
  - Collapse inline ads, `"Advertisement"`/`"Sponsored"` placeholder boxes, and up to 4 empty/`min-height` CLS reserve ancestor wrappers (`display: none !important`), guarded by `isProtectedContent`.
  - Scroll to `(0, 0)` first, suppress bottom-anchored fixed/sticky bars *before* Slice 0 on scrollable pages, and suppress fixed/already-captured sticky bars on Slice 1+ while allowing unvisited sticky section headings (`<h2>`, `<thead>`) in normal flow to render once.
  - On Slice 1+, only `display: none` lazy-injected ads below the already-captured seam (`docTop >= coveredCssY - 2`); use `visibility: hidden` when straddling the seam so pixel coordinates never shift mid-stitch.
- **CSP & Accessibility:**
  - Zero inline `<script>`, zero inline event handlers (`onclick`, etc.), and zero inline `style="..."` in HTML.
  - Maintain semantic HTML landmarks (`<main>`, `<fieldset>`/`<legend>`, explicit `<label for="...">`, `:focus-visible`, `:user-invalid` / `input[aria-invalid="true"]`, `aria-live="polite"`, and accessible progress/cancel controls).
- **Offscreen Document Boundary & Streaming IPC:** `offscreen/offscreen.js` may use Web APIs (`Canvas`, `Image`, `Blob`, `URL.createObjectURL` / `URL.revokeObjectURL`) and `chrome.runtime` messaging only—never call `chrome.downloads`, `chrome.tabs`, `chrome.storage`, or `chrome.action` inside an offscreen document. Stream slices/pages incrementally (`BEGIN_STITCH` -> `PUSH_SLICE`/`PUSH_PAGE` -> `COMMIT_STITCH` / `ABORT_STITCH`) and export downloads via `CREATE_BLOB_URL` / `REVOKE_BLOB_URL` to avoid Mojo IPC and 2 MiB `data:` `GURL` limits.
- **Icons:** Keep `icons/icon-{16,48,128}.png` synced with `manifest.json` (regenerate via `node chrome-extension/scripts/generate-icons.mjs` if changed).

### Chrome Verification Command
```sh
cd chrome-extension && npm test
```

---

## iOS App & Share Extension Rules (`ios-app/StitchScreenshot/`)
- **Target Scope:**
  - `StitchScreenshot`: Main SwiftUI app (`WKWebView` capture engine, `ImageStitcher`, `GeminiService`, `KeychainService`, `PhotoLibraryService`).
  - `StitchShareExtension`: Receives shared webpage URLs from Safari/other apps and opens `stitchscreenshot://capture?url=...`.
  - `StitchScreenshotTests` & `StitchScreenshotUITests`.
- **Concurrency & Import Visibility:** `StitchScreenshot` compiles with `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`, `SWIFT_APPROACHABLE_CONCURRENCY = YES`, and `SWIFT_UPCOMING_FEATURE_MEMBER_IMPORT_VISIBILITY = YES`. Explicitly `import Foundation` / `import Observation` / `import CoreGraphics` in every file that uses their symbols, and mark pure value types/services (`GeminiService`, `ImageStitcher`, `KeychainService`, `CaptureModels`) `nonisolated`.
- **No Signing-Blocked Entitlements & Share Extension API Safety:**
  - Keep `StitchShareExtension` -> `StitchScreenshot` handoff working via the `stitchscreenshot://` custom URL scheme (`CFBundleURLTypes` in `StitchScreenshot/Info.plist`) without `REGISTER_APP_GROUPS` so Simulator builds work without a paid team App Group.
  - Never reference `UIApplication` directly inside `StitchShareExtension` (extension-safe responder chain + `NSExtensionContext.open` after `viewDidAppear`), and preserve `@objc(ShareViewController)` + Storyboard `customModule="StitchShareExtension"`.
  - Keep `StitchScreenshot.xcodeproj/xcshareddata/xcschemes/StitchScreenshot.xcscheme` committed so `xcodebuild -scheme StitchScreenshot` works on fresh clones.
- **Keychain & Permissions:** Store the Gemini API key only in Keychain (`KeychainService`); preserve `NSPhotoLibraryAddUsageDescription` in `StitchScreenshot/Info.plist`.
- **Stitching Accuracy & Memory Safety:** Preserve cumulative `exactY` rounding (preventing multi-slice drift) and `StitchConfiguration` max pixel width/height caps in `ImageStitcher` so tall multi-page stitches do not exhaust iOS memory.

### iOS Verification Command
```sh
xcodebuild test \
  -project ios-app/StitchScreenshot/StitchScreenshot.xcodeproj \
  -scheme StitchScreenshot \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro'
```

---

## Security & Git Hygiene
- **Never commit** API keys, GitHub Personal Access Tokens (`ghp_*`), `.env` files, or Xcode `xcuserdata/`.
- Before pushing changes, run both the Chrome extension test suite (`npm test`) and the iOS test suite (`xcodebuild test` or Xcode `RunAllTests`).
