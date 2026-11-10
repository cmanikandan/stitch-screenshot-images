# AGENTS.md — Coding & Contribution Guide

This file defines repository invariants, architecture boundaries, and verification commands for AI agents and contributors working in `stitch-screenshot-images`.

## Core Product Invariant (Do Not Violate)
- **Pure Image Capture & Pure Image Output Only:** Both the Chrome extension and the iOS app exist solely to capture web pages (single scrolling pages and multi-page articles) and output **images (`PNG` or `JPEG`)**.
- Do **not** add text summaries, social media captions, alt-text generators, markdown exporters, or non-image outputs.
- **Gemini API usage (`gemini-3.8-flash`) is strictly pre-capture only:**
  1. Identifying CSS selectors for overlays, cookie banners, sticky bars, and ad containers to temporarily hide before capturing.
  2. Identifying the true "Next Page" URL on paginated articles.
- Page pixels must always come from native browser/WebKit rendering—never AI-generated or AI-redrawn images.

---

## Gemini API Standards
When editing `chrome-extension/shared/gemini-client.js` or `ios-app/StitchScreenshot/StitchScreenshot/Services/GeminiService.swift`:
- **Model:** Always use `gemini-3.8-flash` (never deprecated `gemini-2.5-*`, `gemini-2.0-*`, or `gemini-1.5-*`).
- **Endpoint & Headers:**
  - `POST https://generativelanguage.googleapis.com/v1beta/interactions`
  - `Content-Type: application/json`
  - `x-goog-api-key: <user-provided-key>`
  - `Api-Revision: 2026-05-20`
- **Structured Output:** Use `response_format: { "type": "text", "mime_type": "application/json", "schema": ... }` (do not use legacy `response_mime_type`).
- **Response Parsing:** Decode `steps` (`step.type == "model_output"` -> `content` text items), with a defensive fallback for `outputs`.
- **Offline / No-Key Parity:** Every capture workflow must still work cleanly without an API key via heuristic cleanup and manual/heuristic pagination.

---

## Chrome Extension Rules (`chrome-extension/`)
- **Manifest V3 Only:** No MV2 APIs (`background.scripts`, `browserAction`, `tabs.executeScript`).
- **Async/Await Only:** Avoid `.then()` chains; async `chrome.runtime.onMessage` listeners must `return true` to keep the response channel open.
- **Stateless Service Worker:** Never rely on in-memory globals in `background/service-worker.js` for persistent or cross-wake state; persist in `chrome.storage.local` / `chrome.storage.session`.
- **CSP & Accessibility:**
  - Zero inline `<script>`, zero inline event handlers (`onclick`, etc.), and zero inline `style="..."` in HTML.
  - Maintain semantic HTML landmarks (`<main>`, `<fieldset>`/`<legend>`, explicit `<label for="...">`, `:focus-visible`, `:user-invalid`, `aria-live="polite"`).
- **Offscreen Document Boundary:** `offscreen/offscreen.js` may use Web APIs (Canvas, Image, Blob) and `chrome.runtime` messaging only—never call `chrome.downloads`, `chrome.tabs`, or `chrome.action` inside an offscreen document.
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
- **No Signing-Blocked Entitlements by Default:** Keep `StitchShareExtension` -> `StitchScreenshot` handoff working via the `stitchscreenshot://` custom URL scheme (`CFBundleURLTypes` in `StitchScreenshot/Info.plist`) so the project builds and tests cleanly on iOS Simulator without requiring a paid team App Group.
- **Keychain & Permissions:** Store the Gemini API key only in Keychain (`KeychainService`); preserve `NSPhotoLibraryAddUsageDescription` in `StitchScreenshot/Info.plist`.
- **Memory Safety:** Preserve `StitchConfiguration` max pixel width/height caps in `ImageStitcher` so tall multi-page stitches do not exhaust iOS memory.

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
