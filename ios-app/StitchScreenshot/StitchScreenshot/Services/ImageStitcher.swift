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

    /// Stitches sequential user-taken screenshots (e.g. from native iOS apps like NYTimes, WSJ, WhatsApp)
    /// by automatically detecting and removing duplicate sticky headers, sticky bottom bars, and vertical scroll overlap.
    static func stitchScreenshotsWithAutoOverlap(
        _ images: [UIImage],
        detectOverlap: Bool = true,
        configuration: StitchConfiguration = StitchConfiguration()
    ) throws -> UIImage {
        guard !images.isEmpty else {
            throw ImageStitcherError.emptyImages
        }
        if images.count == 1 || !detectOverlap {
            return try stitchVertically(images, configuration: configuration)
        }

        let normalized = try images.map { image -> UIImage in
            let norm = normalizeOrientation(image)
            let dims = pixelSize(of: norm)
            guard dims.width > 0, dims.height > 0 else {
                throw ImageStitcherError.invalidDimensions
            }
            return norm
        }

        var croppedSlices: [UIImage] = []
        croppedSlices.reserveCapacity(normalized.count)

        var pendingBottomCropOnPrevious = 0

        for idx in 0..<normalized.count {
            if idx == 0 {
                croppedSlices.append(normalized[0])
                continue
            }

            let prevImage = normalized[idx - 1]
            let currImage = normalized[idx]

            if let match = detectVerticalOverlap(topImage: prevImage, bottomImage: currImage) {
                // Trim the sticky footer / bottom bar from the previous slice before appending the new slice's unique tail.
                if match.bottomTrimOnTopImage > 0, let lastSlice = croppedSlices.last {
                    let adjustedBottomTrim = max(0, match.bottomTrimOnTopImage - pendingBottomCropOnPrevious)
                    if adjustedBottomTrim > 0,
                       let trimmedPrev = cropTopAndBottomOverlap(
                           lastSlice,
                           topCropPixels: 0,
                           bottomCropPixels: adjustedBottomTrim
                       ) {
                        croppedSlices[croppedSlices.count - 1] = trimmedPrev
                    }
                }

                if let croppedCurr = cropTopAndBottomOverlap(
                    currImage,
                    topCropPixels: match.topCropOnBottomImage,
                    bottomCropPixels: 0
                ) {
                    croppedSlices.append(croppedCurr)
                    pendingBottomCropOnPrevious = 0
                    continue
                }
            }

            croppedSlices.append(currImage)
            pendingBottomCropOnPrevious = 0
        }

        return try stitchVertically(croppedSlices, configuration: configuration)
    }

    /// Represents detected pixel crop boundaries between two consecutive vertical screenshots.
    struct OverlapMatch: Equatable, Sendable {
        /// Number of pixels to trim from the bottom of the upper image (e.g., sticky bottom toolbar/home indicator).
        let bottomTrimOnTopImage: Int
        /// Number of pixels to crop from the top of the lower image (status bar + sticky header + overlapping scrolled content).
        let topCropOnBottomImage: Int
    }

    /// Detects vertical scroll overlap between two consecutive screenshots of the same dimensions.
    /// Uses fast downsampled row-signature matching to ignore status-bar/nav-bar chrome and align scrolled text/media.
    static func detectVerticalOverlap(topImage: UIImage, bottomImage: UIImage) -> OverlapMatch? {
        guard let topCG = topImage.cgImage, let bottomCG = bottomImage.cgImage else {
            return nil
        }
        let width = topCG.width
        let height = topCG.height
        guard width == bottomCG.width, height == bottomCG.height, width >= 60, height >= 160 else {
            return nil
        }

        // Downsample horizontally to 48 columns for fast, noise-tolerant luminance + chroma comparison
        let sampleCols = 48
        let sampleHeight = min(height, 720)
        let scaleY = Double(height) / Double(sampleHeight)

        guard let topGrid = extractSampleGrid(cgImage: topCG, cols: sampleCols, rows: sampleHeight),
              let bottomGrid = extractSampleGrid(cgImage: bottomCG, cols: sampleCols, rows: sampleHeight)
        else {
            return nil
        }

        // 1. Detect identical static top chrome (status bar + sticky app nav bar) up to 24% of screen height
        let maxTopChromeRows = Int(Double(sampleHeight) * 0.24)
        var staticTopRows = 0
        while staticTopRows < maxTopChromeRows {
            let diff = rowMeanAbsDiff(topGrid, rowA: staticTopRows, bottomGrid, rowB: staticTopRows, cols: sampleCols)
            if diff < 7.5 {
                staticTopRows += 1
            } else {
                break
            }
        }

        // 2. Detect identical static bottom chrome (home indicator + bottom tab bar) up to 20% of screen height
        let maxBottomChromeRows = Int(Double(sampleHeight) * 0.20)
        var staticBottomRows = 0
        while staticBottomRows < maxBottomChromeRows {
            let rowIdx = sampleHeight - 1 - staticBottomRows
            let diff = rowMeanAbsDiff(topGrid, rowA: rowIdx, bottomGrid, rowB: rowIdx, cols: sampleCols)
            if diff < 7.5 {
                staticBottomRows += 1
            } else {
                break
            }
        }

        // Minimum safe chrome bounds for iOS screenshots (at least status bar ~6% top if any chrome exists)
        let searchTopStart = max(staticTopRows, Int(Double(sampleHeight) * 0.06))
        let searchBottomEnd = sampleHeight - max(staticBottomRows, Int(Double(sampleHeight) * 0.04))
        let usableSpan = searchBottomEnd - searchTopStart
        guard usableSpan >= 60 else { return nil }

        // Precompute row variance so we only anchor on rows with real visual detail (text, images, borders), never blank whitespace
        var topRowVariance = [Double](repeating: 0, count: sampleHeight)
        for r in searchTopStart..<searchBottomEnd {
            topRowVariance[r] = rowHorizontalVariance(topGrid, row: r, cols: sampleCols)
        }

        // 3. Search for the best vertical shift `delta` where `topImage[y]` matches `bottomImage[y - delta]`
        // `overlapRows` is the height of shared content inside [searchTopStart ..< searchBottomEnd]
        let minOverlapRows = max(16, Int(Double(usableSpan) * 0.08))
        let maxOverlapRows = Int(Double(usableSpan) * 0.88)
        guard minOverlapRows < maxOverlapRows else { return nil }

        var bestOverlapRows: Int?
        var bestScore = Double.greatestFiniteMagnitude

        for overlap in stride(from: maxOverlapRows, through: minOverlapRows, by: -1) {
            let topAnchorStart = searchBottomEnd - overlap
            let bottomAnchorStart = searchTopStart

            var totalDiff = 0.0
            var texturedRows = 0
            var checkedRows = 0

            let step = max(1, overlap / 36)
            var offset = 0
            while offset < overlap {
                let rTop = topAnchorStart + offset
                let rBot = bottomAnchorStart + offset
                let variance = topRowVariance[rTop]
                if variance > 10.0 {
                    texturedRows += 1
                    let d = rowMeanAbsDiff(topGrid, rowA: rTop, bottomGrid, rowB: rBot, cols: sampleCols)
                    totalDiff += d * 1.5
                } else {
                    let d = rowMeanAbsDiff(topGrid, rowA: rTop, bottomGrid, rowB: rBot, cols: sampleCols)
                    totalDiff += d * 0.5
                }
                checkedRows += 1
                offset += step
            }

            guard checkedRows >= 6, texturedRows >= 3 else { continue }
            let meanScore = totalDiff / Double(checkedRows)

            // Prefer larger overlap slightly when scores are near-identical to avoid false periodic text-line matches
            let adjustedScore = meanScore - (Double(overlap) / Double(usableSpan)) * 0.6
            if meanScore < 11.5 && adjustedScore < bestScore {
                bestScore = adjustedScore
                bestOverlapRows = overlap
            }
        }

        if let overlapRows = bestOverlapRows {
            // Refine +/- 1 row around bestOverlapRows at step = 1
            var refinedOverlap = overlapRows
            var refinedBestDiff = Double.greatestFiniteMagnitude
            for candidate in max(minOverlapRows, overlapRows - 2)...min(maxOverlapRows, overlapRows + 2) {
                let topStart = searchBottomEnd - candidate
                var sum = 0.0
                for off in 0..<candidate {
                    sum += rowMeanAbsDiff(topGrid, rowA: topStart + off, bottomGrid, rowB: searchTopStart + off, cols: sampleCols)
                }
                let avg = sum / Double(candidate)
                if avg < refinedBestDiff {
                    refinedBestDiff = avg
                    refinedOverlap = candidate
                }
            }

            let bottomTrimRows = sampleHeight - searchBottomEnd
            let topCropRows = searchTopStart + refinedOverlap

            let bottomTrimPx = max(0, Int(round(Double(bottomTrimRows) * scaleY)))
            let topCropPx = max(0, Int(round(Double(topCropRows) * scaleY)))

            if topCropPx > 0 && (topCropPx + bottomTrimPx) < height - 32 {
                return OverlapMatch(
                    bottomTrimOnTopImage: bottomTrimPx,
                    topCropOnBottomImage: topCropPx
                )
            }
        }

        // Fallback if no content overlap was found, but both screenshots share identical sticky top/bottom chrome:
        // strip the duplicate sticky bars so they don't repeat in the middle of the stitch.
        if staticTopRows >= Int(Double(sampleHeight) * 0.05) || staticBottomRows >= Int(Double(sampleHeight) * 0.04) {
            let bottomTrimPx = Int(round(Double(staticBottomRows) * scaleY))
            let topCropPx = Int(round(Double(staticTopRows) * scaleY))
            if (topCropPx + bottomTrimPx) > 0 && (topCropPx + bottomTrimPx) < height / 2 {
                return OverlapMatch(
                    bottomTrimOnTopImage: bottomTrimPx,
                    topCropOnBottomImage: topCropPx
                )
            }
        }

        return nil
    }

    private static func extractSampleGrid(cgImage: CGImage, cols: Int, rows: Int) -> [UInt8]? {
        let bytesPerPixel = 4
        let bytesPerRow = cols * bytesPerPixel
        var buffer = [UInt8](repeating: 0, count: rows * bytesPerRow)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: &buffer,
            width: cols,
            height: rows,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return nil
        }
        context.interpolationQuality = .medium
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: cols, height: rows))
        return buffer
    }

    private static func rowMeanAbsDiff(
        _ gridA: [UInt8],
        rowA: Int,
        _ gridB: [UInt8],
        rowB: Int,
        cols: Int
    ) -> Double {
        let strideBytes = cols * 4
        let baseA = rowA * strideBytes
        let baseB = rowB * strideBytes
        // Ignore the leftmost and rightmost 2 columns (scrollbars / rounded screen corners)
        let startCol = 2
        let endCol = max(startCol + 1, cols - 2)
        var sum = 0
        for c in startCol..<endCol {
            let idxA = baseA + c * 4
            let idxB = baseB + c * 4
            sum += abs(Int(gridA[idxA]) - Int(gridB[idxB]))
            sum += abs(Int(gridA[idxA + 1]) - Int(gridB[idxB + 1]))
            sum += abs(Int(gridA[idxA + 2]) - Int(gridB[idxB + 2]))
        }
        let channelCount = (endCol - startCol) * 3
        return Double(sum) / Double(max(1, channelCount))
    }

    private static func rowHorizontalVariance(_ grid: [UInt8], row: Int, cols: Int) -> Double {
        let base = row * cols * 4
        let startCol = 2
        let endCol = max(startCol + 2, cols - 2)
        var diffSum = 0
        for c in startCol..<(endCol - 1) {
            let idx = base + c * 4
            let nextIdx = idx + 4
            diffSum += abs(Int(grid[idx]) - Int(grid[nextIdx]))
            diffSum += abs(Int(grid[idx + 1]) - Int(grid[nextIdx + 1]))
            diffSum += abs(Int(grid[idx + 2]) - Int(grid[nextIdx + 2]))
        }
        return Double(diffSum) / Double((endCol - startCol - 1) * 3)
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
