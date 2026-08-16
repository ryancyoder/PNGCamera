import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import Vision

/// Isolates the foreground subject of a photo and returns it over transparency.
///
/// The primary path is `VNGenerateForegroundInstanceMaskRequest`, which handles
/// arbitrary subjects (objects, products, documents, people). If it finds no
/// instances — common with low-contrast or full-frame scenes — the person
/// segmentation request is tried before giving up.
enum BackgroundRemover {

    enum Failure: LocalizedError {
        case noSubjectFound
        case maskUnavailable

        var errorDescription: String? {
            switch self {
            case .noSubjectFound:
                return "No subject was found to separate from the background."
            case .maskUnavailable:
                return "The subject mask could not be generated."
            }
        }
    }

    struct Result {
        var image: CIImage
        /// True when the foreground request found a subject; false when the
        /// person-segmentation fallback produced the mask.
        var usedInstanceMask: Bool
    }

    /// Returns `image` with everything outside the detected subject made transparent.
    static func removeBackground(from image: CIImage) async throws -> Result {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    continuation.resume(returning: try perform(on: image))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private static func perform(on image: CIImage) throws -> Result {
        let handler = VNImageRequestHandler(ciImage: image, options: [:])

        if let mask = try instanceMask(for: image, handler: handler) {
            return Result(image: try apply(mask: mask, to: image), usedInstanceMask: true)
        }
        if let mask = try personMask(handler: handler) {
            return Result(image: try apply(mask: mask, to: image), usedInstanceMask: false)
        }
        throw Failure.noSubjectFound
    }

    private static func instanceMask(for image: CIImage, handler: VNImageRequestHandler) throws -> CIImage? {
        let request = VNGenerateForegroundInstanceMaskRequest()
        try handler.perform([request])
        guard let observation = request.results?.first, !observation.allInstances.isEmpty else {
            return nil
        }
        let buffer = try observation.generateScaledMaskForImage(
            forInstances: observation.allInstances,
            from: handler
        )
        return CIImage(cvPixelBuffer: buffer)
    }

    private static func personMask(handler: VNImageRequestHandler) throws -> CIImage? {
        let request = VNGeneratePersonSegmentationRequest()
        request.qualityLevel = .accurate
        request.outputPixelFormat = kCVPixelFormatType_OneComponent8
        try handler.perform([request])
        guard let buffer = request.results?.first?.pixelBuffer else { return nil }
        return CIImage(cvPixelBuffer: buffer)
    }

    /// Composites the subject over transparency, scaling the mask to the image.
    private static func apply(mask: CIImage, to image: CIImage) throws -> CIImage {
        let target = image.extent
        guard target.width > 0, target.height > 0, mask.extent.width > 0, mask.extent.height > 0 else {
            throw Failure.maskUnavailable
        }

        let scaled = mask
            .transformed(by: CGAffineTransform(
                scaleX: target.width / mask.extent.width,
                y: target.height / mask.extent.height
            ))
            .transformed(by: CGAffineTransform(translationX: target.origin.x, y: target.origin.y))

        let blend = CIFilter.blendWithMask()
        blend.inputImage = image
        blend.backgroundImage = CIImage.empty()
        blend.maskImage = scaled

        guard let output = blend.outputImage else { throw Failure.maskUnavailable }
        return output.cropped(to: target)
    }
}
