import Foundation
import Photos
import UIKit
import UniformTypeIdentifiers

/// Clipboard helpers. PNG data is written under the PNG UTI so the alpha
/// channel survives the paste — `UIPasteboard.image` would flatten it.
enum Clipboard {

    static func copy(text: String) {
        UIPasteboard.general.string = text
    }

    static func copy(pngData: Data) {
        UIPasteboard.general.setData(pngData, forPasteboardType: UTType.png.identifier)
    }

    /// Places both representations in a single pasteboard item so the receiving
    /// app can choose whichever it supports.
    static func copy(text: String, pngData: Data) {
        UIPasteboard.general.items = [[
            UTType.utf8PlainText.identifier: text,
            UTType.png.identifier: pngData
        ]]
    }
}

/// Saves PNGs to the photo library without going through `UIImage`, which
/// would re-encode and drop transparency.
enum PhotoLibrarySaver {

    enum Failure: LocalizedError {
        case denied
        case saveFailed(String)

        var errorDescription: String? {
            switch self {
            case .denied:
                return "Photos access is off. Enable it in Settings to save captures."
            case .saveFailed(let reason):
                return "Could not save to Photos: \(reason)"
            }
        }
    }

    static func save(pngData: Data) async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { throw Failure.denied }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges {
                let request = PHAssetCreationRequest.forAsset()
                let options = PHAssetResourceCreationOptions()
                options.uniformTypeIdentifier = UTType.png.identifier
                request.addResource(with: .photo, data: pngData, options: options)
            } completionHandler: { success, error in
                if success {
                    continuation.resume()
                } else {
                    continuation.resume(
                        throwing: Failure.saveFailed(error?.localizedDescription ?? "Unknown error")
                    )
                }
            }
        }
    }
}
