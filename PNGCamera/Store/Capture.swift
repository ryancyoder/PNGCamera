import Foundation

/// A saved capture: one PNG on disk plus everything extracted from it.
struct Capture: Identifiable, Codable, Hashable {
    var id: UUID
    var createdAt: Date
    var fileName: String
    var metadata: CaptureMetadata
    var pixelWidth: Int
    var pixelHeight: Int

    init(
        id: UUID = UUID(),
        createdAt: Date = .now,
        fileName: String,
        metadata: CaptureMetadata,
        pixelWidth: Int = 0,
        pixelHeight: Int = 0
    ) {
        self.id = id
        self.createdAt = createdAt
        self.fileName = fileName
        self.metadata = metadata
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
    }

    /// The text this capture puts on the clipboard: parsed output when a script
    /// produced something, otherwise the raw recognized text.
    var primaryText: String {
        metadata.parsedText.isEmpty ? metadata.recognizedText : metadata.parsedText
    }

    var title: String {
        let candidate = primaryText
            .components(separatedBy: .newlines)
            .first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        if let candidate, !candidate.isEmpty {
            return String(candidate.prefix(60))
        }
        if let barcode = metadata.barcodes.first {
            return barcode.payload
        }
        return createdAt.formatted(date: .abbreviated, time: .shortened)
    }
}
