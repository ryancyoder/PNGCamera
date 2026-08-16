import CoreImage
import Foundation
import UniformTypeIdentifiers

/// Structured metadata written into every exported PNG.
struct CaptureMetadata: Codable, Hashable {
    var createdAt: Date
    var recognizedText: String
    var parsedText: String
    var scriptName: String?
    var barcodes: [BarcodeResult]
    var dictation: String
    var aiOutput: String
    var backgroundRemoved: Bool

    init(
        createdAt: Date = .now,
        recognizedText: String = "",
        parsedText: String = "",
        scriptName: String? = nil,
        barcodes: [BarcodeResult] = [],
        dictation: String = "",
        aiOutput: String = "",
        backgroundRemoved: Bool = false
    ) {
        self.createdAt = createdAt
        self.recognizedText = recognizedText
        self.parsedText = parsedText
        self.scriptName = scriptName
        self.barcodes = barcodes
        self.dictation = dictation
        self.aiOutput = aiOutput
        self.backgroundRemoved = backgroundRemoved
    }

    var isEmpty: Bool {
        recognizedText.isEmpty && parsedText.isEmpty && barcodes.isEmpty
            && dictation.isEmpty && aiOutput.isEmpty
    }
}

/// Renders `CIImage`s to PNG data with an alpha channel, optionally embedding
/// capture metadata as PNG text chunks.
enum PNGWriter {

    /// Keywords used for the embedded text chunks. `Description` and `Software`
    /// are standard PNG keywords; the rest are app-specific.
    enum Keyword {
        static let description = "Description"
        static let software = "Software"
        static let creationTime = "Creation Time"
        static let recognizedText = "PNGCamera:RecognizedText"
        static let parsedText = "PNGCamera:ParsedText"
        static let barcodes = "PNGCamera:Barcodes"
        static let dictation = "PNGCamera:Dictation"
        static let aiOutput = "PNGCamera:AIOutput"
        static let payload = "PNGCamera:JSON"
    }

    enum Failure: LocalizedError {
        case renderFailed

        var errorDescription: String? {
            switch self {
            case .renderFailed: return "The image could not be encoded as a PNG."
            }
        }
    }

    /// A single context is reused so the Metal pipeline isn't rebuilt per shot.
    static let context: CIContext = {
        CIContext(options: [
            .workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB) as Any,
            .cacheIntermediates: false
        ])
    }()

    static func pngData(from image: CIImage, metadata: CaptureMetadata?, embedMetadata: Bool) throws -> Data {
        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        // The image is moved to the origin first: a non-zero extent origin makes
        // CIContext render a transparent border the size of the offset.
        let normalized = image.transformed(
            by: CGAffineTransform(translationX: -image.extent.origin.x, y: -image.extent.origin.y)
        )
        guard let data = context.pngRepresentation(
            of: normalized,
            format: .RGBA8,
            colorSpace: colorSpace,
            options: [:]
        ) else {
            throw Failure.renderFailed
        }

        guard embedMetadata, let metadata, !metadata.isEmpty else { return data }
        return (try? PNGTextChunk.inserting(entries(for: metadata), into: data)) ?? data
    }

    static func entries(for metadata: CaptureMetadata) -> [PNGTextChunk.Entry] {
        var entries: [PNGTextChunk.Entry] = [
            .init(keyword: Keyword.software, text: "PNG Camera"),
            .init(keyword: Keyword.creationTime, text: ISO8601DateFormatter().string(from: metadata.createdAt))
        ]

        let summary = metadata.parsedText.isEmpty ? metadata.recognizedText : metadata.parsedText
        if !summary.isEmpty {
            entries.append(.init(keyword: Keyword.description, text: summary))
        }
        if !metadata.recognizedText.isEmpty {
            entries.append(.init(keyword: Keyword.recognizedText, text: metadata.recognizedText))
        }
        if !metadata.parsedText.isEmpty {
            entries.append(.init(keyword: Keyword.parsedText, text: metadata.parsedText))
        }
        if !metadata.barcodes.isEmpty {
            let joined = metadata.barcodes.map { "\($0.symbology): \($0.payload)" }.joined(separator: "\n")
            entries.append(.init(keyword: Keyword.barcodes, text: joined))
        }
        if !metadata.dictation.isEmpty {
            entries.append(.init(keyword: Keyword.dictation, text: metadata.dictation))
        }
        if !metadata.aiOutput.isEmpty {
            entries.append(.init(keyword: Keyword.aiOutput, text: metadata.aiOutput))
        }

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        if let json = try? encoder.encode(metadata), let text = String(data: json, encoding: .utf8) {
            entries.append(.init(keyword: Keyword.payload, text: text))
        }
        return entries
    }

    /// Reads back metadata previously written by `pngData(from:metadata:embedMetadata:)`.
    static func metadata(in png: Data) -> CaptureMetadata? {
        let entries = PNGTextChunk.entries(in: png)
        guard let payload = entries.first(where: { $0.keyword == Keyword.payload })?.text,
              let data = payload.data(using: .utf8) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(CaptureMetadata.self, from: data)
    }
}
