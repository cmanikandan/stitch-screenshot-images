import CoreGraphics
import Foundation
import UIKit

nonisolated enum ImageStitcherError: Error, LocalizedError, Equatable {
    case emptyImages
    case invalidDimensions
    case renderingFailed
    case encodingFailed

    var errorDescription: String? {
        switch self {
        case .emptyImages:
            return "No captured images to stitch."
        case .invalidDimensions:
            return "Captured image has invalid dimensions."
        case .renderingFailed:
            return "Failed to render the stitched image."
        case .encodingFailed:
            return "Failed to encode the image in the selected format."
        }
    }
}

nonisolated struct StitchConfiguration: Sendable {
    var maxPixelWidth: Int
    var maxPixelHeight: Int
    var pageGapPixels: Int
    var backgroundColor: UIColor

    init(
        maxPixelWidth: Int = 3600,
        maxPixelHeight: Int = 24000,
        pageGapPixels: Int = 0,
        backgroundColor: UIColor = .white
    ) {
        self.maxPixelWidth = maxPixelWidth
        self.maxPixelHeight = maxPixelHeight
        self.pageGapPixels = pageGapPixels
        self.backgroundColor = backgroundColor
    }
}

/// Pure image-processing helper for vertical stitching, overlap cropping, and PNG/JPEG encoding.
nonisolated enum ImageStitcher {
    /// Returns exact pixel dimensions for a `UIImage`.
    static func pixelSize(of image: UIImage) -> (width: Int, height: Int) {
        if let cgImage = image.cgImage {
            return (cgImage.width, cgImage.height)
        }
        return (
            max(0, Int(round(image.size.width * image.scale))),
            max(0, Int(round(image.size.height * image.scale)))
        )
    }

    /// Crops `topCropPixels` from the top and `bottomCropPixels` from the bottom of `image`.
    static func cropTopAndBottomOverlap(
        _ image: UIImage,
        topCropPixels: Int,
        bottomCropPixels: Int = 0
    ) -> UIImage? {
        guard let cgImage = image.cgImage else { return nil }
        let width = cgImage.width
        let height = cgImage.height
        let clampedTop = max(0, topCropPixels)
        let clampedBottom = max(0, bottomCropPixels)
        let remainingHeight = height - clampedTop - clampedBottom
        guard width > 0, remainingHeight > 0 else { return nil }

        let cropRect = CGRect(x: 0, y: clampedTop, width: width, height: remainingHeight)
        guard let croppedCG = cgImage.cropping(to: cropRect) else { return nil }
        return UIImage(cgImage: croppedCG, scale: image.scale, orientation: .up)
    }

    /// Stitches multiple images vertically into a single continuous bitmap while capping total pixels for iOS memory safety.
    static func stitchVertically(
        _ images: [UIImage],
        configuration: StitchConfiguration = StitchConfiguration()
    ) throws -> UIImage {
        guard !images.isEmpty else {
            throw ImageStitcherError.emptyImages
        }

        let normalized = try images.map { image -> (image: UIImage, width: Int, height: Int) in
            let normalizedImage = normalizeOrientation(image)
            let dims = pixelSize(of: normalizedImage)
            guard dims.width > 0, dims.height > 0 else {
                throw ImageStitcherError.invalidDimensions
            }
            return (normalizedImage, dims.width, dims.height)
        }

        let maxSourceWidth = normalized.map(\.width).max() ?? 0
        guard maxSourceWidth > 0 else {
            throw ImageStitcherError.invalidDimensions
        }

        let targetWidth = min(maxSourceWidth, max(1, configuration.maxPixelWidth))
        let gap = max(0, configuration.pageGapPixels)

        // Compute proportional heights when aligning all slices to `targetWidth`.
        var scaledSlices: [(image: UIImage, width: CGFloat, height: CGFloat)] = []
        scaledSlices.reserveCapacity(normalized.count)
        var rawTotalHeight: CGFloat = 0

        for (index, item) in normalized.enumerated() {
            let ratio = CGFloat(targetWidth) / CGFloat(item.width)
            let scaledHeight = max(1, round(CGFloat(item.height) * ratio))
            scaledSlices.append((item.image, CGFloat(targetWidth), scaledHeight))
            rawTotalHeight += scaledHeight
            if index < normalized.count - 1 {
                rawTotalHeight += CGFloat(gap)
            }
        }

        let maxHeightCG = CGFloat(max(1, configuration.maxPixelHeight))
        let globalDownscale = rawTotalHeight > maxHeightCG ? (maxHeightCG / rawTotalHeight) : 1.0

        let canvasWidth = max(1, Int(floor(CGFloat(targetWidth) * globalDownscale)))
        let canvasHeight = max(1, Int(floor(rawTotalHeight * globalDownscale)))
        let scaledGap = CGFloat(gap) * globalDownscale

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1.0
        format.opaque = true

        let renderer = UIGraphicsImageRenderer(
            size: CGSize(width: canvasWidth, height: canvasHeight),
            format: format
        )

        let stitched = renderer.image { context in
            configuration.backgroundColor.setFill()
            context.fill(CGRect(x: 0, y: 0, width: canvasWidth, height: canvasHeight))

            var exactY: CGFloat = 0
            for (index, slice) in scaledSlices.enumerated() {
                let startY = min(CGFloat(max(0, canvasHeight - 1)), round(exactY))
                exactY += slice.height * globalDownscale
                let endY = (index == scaledSlices.count - 1 && gap == 0)
                    ? CGFloat(canvasHeight)
                    : min(CGFloat(canvasHeight), round(exactY))
                let drawHeight = max(1, endY - startY)

                let drawRect = CGRect(
                    x: 0,
                    y: startY,
                    width: CGFloat(canvasWidth),
                    height: drawHeight
                )
                slice.image.draw(in: drawRect)
                if index < scaledSlices.count - 1 {
                    exactY += scaledGap
                }
            }
        }

        guard stitched.cgImage != nil else {
            throw ImageStitcherError.renderingFailed
        }
        return stitched
    }

    static func encode(
        _ image: UIImage,
        format: ImageExportFormat,
        jpegQuality: CGFloat = 0.92
    ) throws -> Data {
        switch format {
        case .png:
            guard let data = image.pngData() else {
                throw ImageStitcherError.encodingFailed
            }
            return data
        case .jpeg:
            let clamped = min(max(jpegQuality, 0.1), 1.0)
            guard let data = image.jpegData(compressionQuality: clamped) else {
                throw ImageStitcherError.encodingFailed
            }
            return data
        }
    }

    static func writeTemporaryImageFile(
        _ image: UIImage,
        format: ImageExportFormat,
        jpegQuality: CGFloat = 0.92,
        fileNamePrefix: String = "StitchScreenshot"
    ) throws -> URL {
        pruneTemporaryImageFiles(fileNamePrefix: fileNamePrefix)
        let data = try encode(image, format: format, jpegQuality: jpegQuality)
        let timestamp = Int(Date().timeIntervalSince1970)
        let fileName = "\(fileNamePrefix)-\(timestamp)-\(UUID().uuidString.prefix(6)).\(format.fileExtension)"
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent(fileName)
        try data.write(to: fileURL, options: .atomic)
        return fileURL
    }

    static func pruneTemporaryImageFiles(
        in directory: URL = FileManager.default.temporaryDirectory,
        fileNamePrefix: String = "StitchScreenshot",
        olderThan maxAge: TimeInterval = 3600,
        now: Date = Date()
    ) {
        let fm = FileManager.default
        guard let urls = try? fm.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey, .creationDateKey],
            options: [.skipsHiddenFiles]
        ) else {
            return
        }

        for fileURL in urls {
            let name = fileURL.lastPathComponent
            guard name.hasPrefix("StitchScreenshot-") || name.hasPrefix("\(fileNamePrefix)-") else {
                continue
            }
            let values = try? fileURL.resourceValues(forKeys: [.contentModificationDateKey, .creationDateKey])
            if let fileDate = values?.contentModificationDate ?? values?.creationDate,
               now.timeIntervalSince(fileDate) > maxAge {
                try? fm.removeItem(at: fileURL)
            }
        }
    }

    private static func normalizeOrientation(_ image: UIImage) -> UIImage {
        if image.imageOrientation == .up {
            return image
        }
        let format = UIGraphicsImageRendererFormat()
        format.scale = image.scale
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: image.size, format: format)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
    }
}
