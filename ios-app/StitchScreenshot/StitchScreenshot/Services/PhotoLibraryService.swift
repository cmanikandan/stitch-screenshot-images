import Foundation
import Photos
import UIKit

nonisolated enum PhotoLibraryError: Error, LocalizedError, Equatable {
    case permissionDenied
    case encodingFailed
    case saveFailed(String)

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "Photos permission is required to save screenshots. Enable Photos access in Settings."
        case .encodingFailed:
            return "Could not encode screenshot image data."
        case .saveFailed(let message):
            return "Failed to save screenshot to Photos: \(message)"
        }
    }
}

/// Saves pure image output directly to the user's Photos library.
@MainActor
enum PhotoLibraryService {
    static func saveImage(_ image: UIImage, format: ImageExportFormat, jpegQuality: Double) async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            throw PhotoLibraryError.permissionDenied
        }

        let imageData = try ImageStitcher.encode(image, format: format, jpegQuality: CGFloat(jpegQuality))

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges {
                let request = PHAssetCreationRequest.forAsset()
                request.addResource(with: .photo, data: imageData, options: nil)
            } completionHandler: { success, error in
                if let error {
                    continuation.resume(throwing: PhotoLibraryError.saveFailed(error.localizedDescription))
                } else if !success {
                    continuation.resume(throwing: PhotoLibraryError.saveFailed("Unknown Photos error."))
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
    }
}
