import CoreImage
import Foundation
import Vision

/// One recognized line of text with its position in normalized image space.
struct RecognizedLine: Codable, Hashable {
    var text: String
    var confidence: Float
    /// Vision's normalized bounding box (origin bottom-left).
    var boundingBox: CGRect
}

struct RecognizedText: Codable, Hashable {
    var lines: [RecognizedLine]

    var plainText: String {
        lines.map(\.text).joined(separator: "\n")
    }

    var isEmpty: Bool { lines.isEmpty }

    static let empty = RecognizedText(lines: [])
}

/// Wraps `VNRecognizeTextRequest` and sorts results into reading order.
enum TextRecognizer {

    static func recognize(
        in image: CIImage,
        languages: [String],
        usesLanguageCorrection: Bool
    ) async throws -> RecognizedText {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let request = VNRecognizeTextRequest()
                    request.recognitionLevel = .accurate
                    request.usesLanguageCorrection = usesLanguageCorrection
                    if languages.isEmpty {
                        request.automaticallyDetectsLanguage = true
                    } else {
                        request.recognitionLanguages = languages
                    }

                    let handler = VNImageRequestHandler(ciImage: image, options: [:])
                    try handler.perform([request])

                    let observations = request.results ?? []
                    let lines: [RecognizedLine] = observations.compactMap { observation in
                        guard let candidate = observation.topCandidates(1).first else { return nil }
                        return RecognizedLine(
                            text: candidate.string,
                            confidence: candidate.confidence,
                            boundingBox: observation.boundingBox
                        )
                    }

                    continuation.resume(returning: RecognizedText(lines: sortIntoReadingOrder(lines)))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// Vision returns observations in detection order, which is not reading
    /// order for multi-column or scattered layouts. Lines whose vertical centers
    /// are within a row tolerance are treated as the same row and sorted left to
    /// right; rows themselves run top to bottom.
    private static func sortIntoReadingOrder(_ lines: [RecognizedLine]) -> [RecognizedLine] {
        guard lines.count > 1 else { return lines }
        let tolerance = 0.015

        return lines.sorted { first, second in
            let firstY = first.boundingBox.midY
            let secondY = second.boundingBox.midY
            if abs(firstY - secondY) > tolerance {
                return firstY > secondY // higher on the page first
            }
            return first.boundingBox.minX < second.boundingBox.minX
        }
    }

    /// Language identifiers the current device supports for accurate recognition.
    static func supportedLanguages() -> [String] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        return (try? request.supportedRecognitionLanguages()) ?? ["en-US"]
    }
}
