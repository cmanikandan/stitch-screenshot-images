import Foundation
import SwiftUI
import UIKit

struct ContentView: View {
    @Bindable var captureService: WebCaptureService
    @Bindable var settings: AppSettingsStore

    @State private var addressInput: String = ""
    @State private var showSettings = false
    @State private var previewResult: CapturedImageResult?
    @FocusState private var isAddressFieldFocused: Bool

    private let quickLinks: [(label: String, url: String)] = [
        ("Wikipedia: Swift", "https://en.wikipedia.org/wiki/Swift_(programming_language)"),
        ("Hacker News", "https://news.ycombinator.com"),
        ("Apple Developer", "https://developer.apple.com/documentation/webkit")
    ]

    var body: some View {
        VStack(spacing: 0) {
            browserTopBar

            if captureService.isLoading {
                ProgressView(value: captureService.estimatedProgress)
                    .progressViewStyle(.linear)
                    .tint(.accentColor)
            }

            ZStack {
                if captureService.hasLoadedAnyPage {
                    WebViewContainer(webView: captureService.webView)
                } else {
                    emptyBrowserLanding
                }

                if captureService.isCapturing {
                    captureProgressOverlay
                }
            }

            if !captureService.stagedPages.isEmpty {
                stagedPagesTray
            }

            captureActionToolbar
        }
        .onChange(of: captureService.currentURLString) { _, newValue in
            if !isAddressFieldFocused {
                addressInput = newValue
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(settings: settings)
        }
        .sheet(item: $previewResult) { result in
            PreviewSheet(result: result, settings: settings)
        }
        .alert("Capture Notice", isPresented: Binding(
            get: { captureService.errorMessage != nil },
            set: { if !$0 { captureService.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { captureService.errorMessage = nil }
        } message: {
            Text(captureService.errorMessage ?? "")
        }
    }

    // MARK: - Top Browser Bar

    private var browserTopBar: some View {
        HStack(spacing: 8) {
            Button {
                captureService.goBack()
            } label: {
                Image(systemName: "chevron.left")
                    .font(.body.weight(.semibold))
            }
            .accessibilityLabel("Back")
            .disabled(!captureService.canGoBack || captureService.isCapturing)

            Button {
                captureService.goForward()
            } label: {
                Image(systemName: "chevron.right")
                    .font(.body.weight(.semibold))
            }
            .accessibilityLabel("Forward")
            .disabled(!captureService.canGoForward || captureService.isCapturing)

            HStack(spacing: 6) {
                Image(systemName: "globe")
                    .foregroundStyle(.secondary)
                    .font(.caption)

                TextField("Enter URL or paste link...", text: $addressInput)
                    .textFieldStyle(.plain)
                    .font(.subheadline)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .focused($isAddressFieldFocused)
                    .onSubmit {
                        submitAddress()
                    }

                if !addressInput.isEmpty && isAddressFieldFocused {
                    Button {
                        addressInput = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                            .font(.caption)
                    }
                    .accessibilityLabel("Clear Address")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))

            Button {
                captureService.reloadOrStop()
            } label: {
                Image(systemName: captureService.isLoading ? "xmark" : "arrow.clockwise")
                    .font(.body.weight(.medium))
            }
            .accessibilityLabel(captureService.isLoading ? "Stop Loading" : "Reload Page")
            .disabled(!captureService.hasLoadedAnyPage || captureService.isCapturing)

            Button {
                showSettings = true
            } label: {
                Image(systemName: "gearshape")
                    .font(.body.weight(.medium))
            }
            .accessibilityLabel("Settings")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(.systemBackground))
        .overlay(alignment: .bottom) {
            Divider()
        }
    }

    // MARK: - Empty Landing State

    private var emptyBrowserLanding: some View {
        ScrollView {
            VStack(spacing: 20) {
                Spacer(minLength: 36)

                Image(systemName: "camera.viewfinder")
                    .font(.system(size: 52))
                    .foregroundStyle(Color.accentColor)

                VStack(spacing: 8) {
                    Text("StitchScreenshot")
                        .font(.title2.bold())
                    Text("Browse any webpage, hide sticky clutter, and capture full-page or multi-page articles as a single pure PNG or JPEG image.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                }

                Button {
                    pasteAndOpenFromClipboard()
                } label: {
                    Label("Paste URL & Open", systemImage: "doc.on.clipboard")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.borderedProminent)

                VStack(alignment: .leading, spacing: 10) {
                    Text("Quick Test Pages")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)

                    ForEach(quickLinks, id: \.url) { item in
                        Button {
                            addressInput = item.url
                            captureService.loadURLString(item.url)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.label)
                                        .font(.subheadline.weight(.medium))
                                        .foregroundStyle(.primary)
                                    Text(item.url)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                                Spacer()
                                Image(systemName: "arrow.up.right")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(12)
                            .background(Color(.secondarySystemBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
            }
            .frame(maxWidth: .infinity)
        }
        .background(Color(.systemGroupedBackground))
    }

    // MARK: - Capture Progress Overlay

    private var captureProgressOverlay: some View {
        VStack {
            HStack(spacing: 12) {
                ProgressView()
                Text(captureService.captureStatus.isEmpty ? "Capturing..." : captureService.captureStatus)
                    .font(.subheadline.weight(.medium))
                Spacer()
                Button("Cancel", role: .destructive) {
                    captureService.cancelCapture()
                }
                .font(.caption.weight(.semibold))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.ultraThickMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
            .padding(12)

            Spacer()
        }
    }

    // MARK: - Staged Pages Tray

    private var stagedPagesTray: some View {
        VStack(spacing: 6) {
            Divider()
            HStack {
                Text("Staged Pages (\(captureService.stagedPages.count))")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Clear", role: .destructive) {
                    captureService.clearStagedPages()
                }
                .font(.caption.weight(.medium))
            }
            .padding(.horizontal, 12)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(Array(captureService.stagedPages.enumerated()), id: \.element.id) { index, page in
                        ZStack(alignment: .topTrailing) {
                            VStack(spacing: 4) {
                                Image(uiImage: page.image)
                                    .resizable()
                                    .aspectRatio(contentMode: .fill)
                                    .frame(width: 54, height: 74)
                                    .clipped()
                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 6)
                                            .stroke(Color.secondary.opacity(0.3), lineWidth: 1)
                                    )

                                Text("P\(index + 1)")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                            .contextMenu {
                                if index > 0 {
                                    Button {
                                        captureService.moveStagedPage(from: IndexSet(integer: index), to: index - 1)
                                    } label: {
                                        Label("Move Left", systemImage: "arrow.left")
                                    }
                                }
                                if index < captureService.stagedPages.count - 1 {
                                    Button {
                                        captureService.moveStagedPage(from: IndexSet(integer: index), to: index + 2)
                                    } label: {
                                        Label("Move Right", systemImage: "arrow.right")
                                    }
                                }
                                Button(role: .destructive) {
                                    captureService.removeStagedPage(id: page.id)
                                } label: {
                                    Label("Remove Page", systemImage: "trash")
                                }
                            }

                            Button {
                                captureService.removeStagedPage(id: page.id)
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.caption)
                                    .foregroundStyle(.white, .black.opacity(0.7))
                            }
                            .offset(x: 4, y: -4)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 4)
            }
        }
        .padding(.top, 6)
        .background(Color(.secondarySystemBackground))
    }

    // MARK: - Bottom Capture Action Bar

    private var captureActionToolbar: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 8) {
                Button {
                    runFullPageCapture()
                } label: {
                    Label("Full Page", systemImage: "doc.text.image")
                        .font(.caption.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!captureService.hasCommittedPage || captureService.isCapturing)

                Button {
                    runAutoMultiPageCapture()
                } label: {
                    Label("Auto Stitch", systemImage: "sparkles.rectangle.stack")
                        .font(.caption.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.bordered)
                .disabled(!captureService.hasCommittedPage || captureService.isCapturing)

                Button {
                    runCaptureAndAppend()
                } label: {
                    Label("Append", systemImage: "plus.rectangle.on.rectangle")
                        .font(.caption.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.bordered)
                .disabled(!captureService.hasCommittedPage || captureService.isCapturing)

                if !captureService.stagedPages.isEmpty {
                    Button {
                        stitchStagedPages()
                    } label: {
                        Text("Stitch (\(captureService.stagedPages.count))")
                            .font(.caption.weight(.bold))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 10)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                    .disabled(captureService.isCapturing)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Color(.systemBackground))
        }
    }

    // MARK: - Actions

    private func submitAddress() {
        isAddressFieldFocused = false
        captureService.loadURLString(addressInput)
    }

    private func pasteAndOpenFromClipboard() {
        if let pasted = UIPasteboard.general.string,
           let url = DeepLinkParser.extractFirstWebURL(from: pasted) {
            addressInput = url.absoluteString
            captureService.load(url: url)
        } else {
            captureService.errorMessage = "No valid http/https URL found in clipboard."
        }
    }

    private func runFullPageCapture() {
        Task {
            do {
                previewResult = try await captureService.captureFullPage(
                    autoCleanClutter: settings.autoCleanClutter
                )
            } catch WebCaptureError.cancelled {
                // User cancelled capture.
            } catch is CancellationError {
                // User cancelled capture.
            } catch {
                captureService.errorMessage = error.localizedDescription
            }
        }
    }

    private func runAutoMultiPageCapture() {
        Task {
            do {
                previewResult = try await captureService.autoCaptureMultiPage(
                    maxPages: settings.maxAutoPages,
                    autoCleanClutter: settings.autoCleanClutter
                )
            } catch WebCaptureError.cancelled {
                // User cancelled capture.
            } catch is CancellationError {
                // User cancelled capture.
            } catch {
                captureService.errorMessage = error.localizedDescription
            }
        }
    }

    private func runCaptureAndAppend() {
        Task {
            do {
                try await captureService.captureAndAppendPage(
                    autoCleanClutter: settings.autoCleanClutter
                )
            } catch WebCaptureError.cancelled {
                // User cancelled capture.
            } catch is CancellationError {
                // User cancelled capture.
            } catch {
                captureService.errorMessage = error.localizedDescription
            }
        }
    }

    private func stitchStagedPages() {
        do {
            previewResult = try captureService.stitchStagedPages()
        } catch {
            captureService.errorMessage = error.localizedDescription
        }
    }
}

#Preview {
    ContentView(
        captureService: WebCaptureService(),
        settings: AppSettingsStore()
    )
}
