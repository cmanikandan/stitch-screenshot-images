import SwiftUI
import UIKit

/// Pure-image preview, zoom, copy, Photos save, and native Share Sheet export.
struct PreviewSheet: View {
    let result: CapturedImageResult
    @Bindable var settings: AppSettingsStore

    @Environment(\.dismiss) private var dismiss
    @State private var zoomScale: CGFloat = 1.0
    @State private var activePinchScale: CGFloat = 1.0
    @State private var isSavingToPhotos = false
    @State private var statusBanner: String?
    @State private var errorMessage: String?
    @State private var sharePayload: SharePayload?

    private var pixelDimensions: (width: Int, height: Int) {
        ImageStitcher.pixelSize(of: result.image)
    }

    private var encodedPreviewData: Data? {
        try? ImageStitcher.encode(
            result.image,
            format: settings.outputFormat,
            jpegQuality: settings.jpegQuality
        )
    }

    private var formattedByteSize: String {
        guard let data = encodedPreviewData else { return "--" }
        return ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                metadataBar

                Divider()

                zoomableImageCanvas

                if let statusBanner {
                    Text(statusBanner)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(Capsule().fill(Color.green.opacity(0.9)))
                        .padding(.bottom, 8)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }

                Divider()

                exportActionBar
            }
            .navigationTitle("Captured Image")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(item: $sharePayload) { payload in
                PureImageActivitySheet(items: payload.items)
                    .ignoresSafeArea()
            }
            .alert("Export Error", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
        }
    }

    private var metadataBar: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(pixelDimensions.width) × \(pixelDimensions.height) px • \(formattedByteSize)")
                    .font(.caption.monospacedDigit().weight(.medium))
                    .foregroundStyle(.primary)
                Text(result.pageCount > 1 ? "\(result.pageCount) stitched pages" : "Single full-page capture")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Picker("Format", selection: $settings.outputFormat) {
                ForEach(ImageExportFormat.allCases) { format in
                    Text(format.displayName).tag(format)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 128)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Color(.secondarySystemBackground))
    }

    private var zoomableImageCanvas: some View {
        GeometryReader { proxy in
            let currentScale = max(0.5, min(zoomScale * activePinchScale, 5.0))
            let fitWidth = max(1, proxy.size.width - 24)
            let aspectRatio = CGFloat(pixelDimensions.height) / CGFloat(max(1, pixelDimensions.width))
            let baseHeight = fitWidth * aspectRatio

            ScrollView([.horizontal, .vertical]) {
                Image(uiImage: result.image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .frame(
                        width: fitWidth * currentScale,
                        height: baseHeight * currentScale
                    )
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
                    .padding(12)
                    .frame(minWidth: proxy.size.width, minHeight: proxy.size.height, alignment: .top)
            }
            .background(Color(.systemGroupedBackground))
            .gesture(
                MagnifyGesture()
                    .onChanged { value in
                        activePinchScale = value.magnification
                    }
                    .onEnded { value in
                        zoomScale = max(0.5, min(zoomScale * value.magnification, 5.0))
                        activePinchScale = 1.0
                    }
            )
            .onTapGesture(count: 2) {
                withAnimation(.easeInOut(duration: 0.2)) {
                    zoomScale = zoomScale > 1.25 ? 1.0 : 2.0
                }
            }
        }
    }

    private var exportActionBar: some View {
        HStack(spacing: 12) {
            Button {
                saveToPhotos()
            } label: {
                VStack(spacing: 4) {
                    if isSavingToPhotos {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "photo.badge.arrow.down")
                            .font(.title3)
                    }
                    Text("Save Photos")
                        .font(.caption.weight(.medium))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
            }
            .buttonStyle(.borderedProminent)
            .disabled(isSavingToPhotos)

            Button {
                copyImageToPasteboard()
            } label: {
                VStack(spacing: 4) {
                    Image(systemName: "doc.on.doc")
                        .font(.title3)
                    Text("Copy Image")
                        .font(.caption.weight(.medium))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
            }
            .buttonStyle(.bordered)

            Button {
                sharePureImage()
            } label: {
                VStack(spacing: 4) {
                    Image(systemName: "square.and.arrow.up")
                        .font(.title3)
                    Text("Share")
                        .font(.caption.weight(.medium))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
            }
            .buttonStyle(.bordered)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color(.systemBackground))
    }

    private func saveToPhotos() {
        isSavingToPhotos = true
        Task {
            defer { isSavingToPhotos = false }
            do {
                try await PhotoLibraryService.saveImage(
                    result.image,
                    format: settings.outputFormat,
                    jpegQuality: settings.jpegQuality
                )
                showStatus("Saved \(settings.outputFormat.displayName) to Photos")
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func copyImageToPasteboard() {
        UIPasteboard.general.image = result.image
        showStatus("Copied image to clipboard")
    }

    private func sharePureImage() {
        do {
            // Export ONLY the encoded image file (or UIImage fallback) with zero text/captions.
            let fileURL = try ImageStitcher.writeTemporaryImageFile(
                result.image,
                format: settings.outputFormat,
                jpegQuality: CGFloat(settings.jpegQuality)
            )
            sharePayload = SharePayload(items: [fileURL])
        } catch {
            sharePayload = SharePayload(items: [result.image])
        }
    }

    private func showStatus(_ message: String) {
        withAnimation {
            statusBanner = message
        }
        Task {
            try? await Task.sleep(for: .seconds(2.5))
            await MainActor.run {
                withAnimation {
                    if statusBanner == message {
                        statusBanner = nil
                    }
                }
            }
        }
    }
}

private struct SharePayload: Identifiable {
    let id = UUID()
    let items: [Any]
}

private struct PureImageActivitySheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
