import CoreImage
import Foundation
import Observation
import UIKit

/// The result of running one photo through the capture pipeline.
struct ProcessedCapture {
    /// Subject over transparency when background removal succeeded, otherwise
    /// the original frame.
    var image: CIImage
    var pngData: Data
    var metadata: CaptureMetadata
    var recognizedText: RecognizedText
    /// Non-fatal problems worth telling the user about (e.g. no subject found).
    var warnings: [String]

    var pixelSize: CGSize {
        CGSize(width: image.extent.width, height: image.extent.height)
    }

    var uiImage: UIImage? {
        UIImage(data: pngData)
    }
}

/// Runs background removal, text recognition, barcode detection and parsing,
/// then encodes the PNG.
@MainActor
@Observable
final class CaptureProcessor {

    enum Stage: Equatable {
        case idle
        case removingBackground
        case readingText
        case scanningBarcodes
        case encoding

        var message: String {
            switch self {
            case .idle: return ""
            case .removingBackground: return "Removing background…"
            case .readingText: return "Reading text…"
            case .scanningBarcodes: return "Scanning barcodes…"
            case .encoding: return "Writing PNG…"
            }
        }
    }

    private(set) var stage: Stage = .idle

    var isWorking: Bool { stage != .idle }

    /// Runs the full pipeline. Vision failures degrade to warnings rather than
    /// discarding the photo — a capture that only produced an image is still
    /// worth keeping.
    func process(_ original: CIImage, settings: AppSettings) async throws -> ProcessedCapture {
        defer { stage = .idle }

        var warnings: [String] = []
        var subject = original
        var backgroundRemoved = false

        if settings.removeBackground {
            stage = .removingBackground
            do {
                let result = try await BackgroundRemover.removeBackground(from: original)
                subject = result.image
                backgroundRemoved = true
                if !result.usedInstanceMask {
                    warnings.append("Used person segmentation — no distinct subject was found.")
                }
            } catch {
                warnings.append("Kept the full frame: \(error.localizedDescription)")
            }
        }

        // Recognition runs against the original frame: text and barcodes are
        // often outside whatever the mask considered the subject.
        var recognized = RecognizedText.empty
        if settings.recognizeText {
            stage = .readingText
            do {
                recognized = try await TextRecognizer.recognize(
                    in: original,
                    languages: settings.recognitionLanguages,
                    usesLanguageCorrection: settings.usesLanguageCorrection
                )
            } catch {
                warnings.append("Text recognition failed: \(error.localizedDescription)")
            }
        }

        var barcodes: [BarcodeResult] = []
        if settings.scanBarcodes {
            stage = .scanningBarcodes
            do {
                barcodes = try await BarcodeScanner.scan(in: original)
            } catch {
                warnings.append("Barcode scanning failed: \(error.localizedDescription)")
            }
        }

        let script = settings.selectedScript
        var textForParsing = recognized.plainText
        if settings.appendBarcodesToText, !barcodes.isEmpty {
            let payloads = barcodes.map(\.payload).joined(separator: "\n")
            textForParsing = textForParsing.isEmpty ? payloads : textForParsing + "\n" + payloads
        }
        let parsed = ParsingEngine.run(script, on: textForParsing)

        let metadata = CaptureMetadata(
            createdAt: .now,
            recognizedText: recognized.plainText,
            parsedText: parsed,
            scriptName: script.steps.isEmpty ? nil : script.name,
            barcodes: barcodes,
            dictation: "",
            aiOutput: "",
            backgroundRemoved: backgroundRemoved
        )

        stage = .encoding
        let pngData = try PNGWriter.pngData(
            from: subject,
            metadata: metadata,
            embedMetadata: settings.embedMetadataInPNG
        )

        return ProcessedCapture(
            image: subject,
            pngData: pngData,
            metadata: metadata,
            recognizedText: recognized,
            warnings: warnings
        )
    }

    /// Re-encodes an already-processed capture after its metadata changed.
    func reencode(_ capture: ProcessedCapture, metadata: CaptureMetadata, embedMetadata: Bool) -> ProcessedCapture {
        var updated = capture
        updated.metadata = metadata
        if let data = try? PNGWriter.pngData(from: capture.image, metadata: metadata, embedMetadata: embedMetadata) {
            updated.pngData = data
        }
        return updated
    }

    /// Re-runs only the parsing step, for switching scripts in the review screen.
    func reparse(_ capture: ProcessedCapture, with script: ParsingScript, includeBarcodes: Bool) -> CaptureMetadata {
        var text = capture.metadata.recognizedText
        if includeBarcodes, !capture.metadata.barcodes.isEmpty {
            let payloads = capture.metadata.barcodes.map(\.payload).joined(separator: "\n")
            text = text.isEmpty ? payloads : text + "\n" + payloads
        }
        var metadata = capture.metadata
        metadata.parsedText = ParsingEngine.run(script, on: text)
        metadata.scriptName = script.steps.isEmpty ? nil : script.name
        return metadata
    }
}
