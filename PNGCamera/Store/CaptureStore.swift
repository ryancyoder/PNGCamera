import Foundation
import Observation
import UIKit

/// Persists captures as PNG files in Application Support with a JSON index.
@MainActor
@Observable
final class CaptureStore {

    private(set) var captures: [Capture] = []
    private(set) var lastError: String?

    private let fileManager = FileManager.default
    private let directory: URL
    private let indexURL: URL

    init(directoryName: String = "Captures") {
        let base = (try? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )) ?? URL.temporaryDirectory

        directory = base.appendingPathComponent(directoryName, isDirectory: true)
        indexURL = directory.appendingPathComponent("index.json")
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        load()
    }

    // MARK: - Reading

    func url(for capture: Capture) -> URL {
        directory.appendingPathComponent(capture.fileName)
    }

    func pngData(for capture: Capture) -> Data? {
        try? Data(contentsOf: url(for: capture))
    }

    func image(for capture: Capture) -> UIImage? {
        guard let data = pngData(for: capture) else { return nil }
        return UIImage(data: data)
    }

    private func load() {
        guard let data = try? Data(contentsOf: indexURL) else { return }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let decoded = try? decoder.decode([Capture].self, from: data) else { return }
        // Drop entries whose file has gone missing (e.g. restored from a
        // backup that excluded the images).
        captures = decoded
            .filter { fileManager.fileExists(atPath: directory.appendingPathComponent($0.fileName).path) }
            .sorted { $0.createdAt > $1.createdAt }
    }

    private func saveIndex() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            let data = try encoder.encode(captures)
            try data.write(to: indexURL, options: .atomic)
        } catch {
            lastError = "Could not update the capture index: \(error.localizedDescription)"
        }
    }

    // MARK: - Writing

    @discardableResult
    func save(pngData: Data, metadata: CaptureMetadata, pixelSize: CGSize) throws -> Capture {
        let id = UUID()
        let capture = Capture(
            id: id,
            createdAt: metadata.createdAt,
            fileName: "\(id.uuidString).png",
            metadata: metadata,
            pixelWidth: Int(pixelSize.width),
            pixelHeight: Int(pixelSize.height)
        )
        try pngData.write(to: url(for: capture), options: .atomic)
        captures.insert(capture, at: 0)
        saveIndex()
        return capture
    }

    /// Updates a capture's metadata and rewrites the PNG's text chunks so the
    /// exported file and the index never disagree.
    func update(_ capture: Capture, metadata: CaptureMetadata) {
        guard let index = captures.firstIndex(where: { $0.id == capture.id }) else { return }
        captures[index].metadata = metadata

        let fileURL = url(for: captures[index])
        if let existing = try? Data(contentsOf: fileURL),
           let rewritten = try? PNGTextChunk.replacing(PNGWriter.entries(for: metadata), in: existing) {
            try? rewritten.write(to: fileURL, options: .atomic)
        }
        saveIndex()
    }

    func delete(_ capture: Capture) {
        try? fileManager.removeItem(at: url(for: capture))
        captures.removeAll { $0.id == capture.id }
        saveIndex()
    }

    func deleteAll() {
        for capture in captures {
            try? fileManager.removeItem(at: url(for: capture))
        }
        captures.removeAll()
        saveIndex()
    }

    /// Writes a capture to a temporary file with a readable name for sharing.
    func temporaryExportURL(for capture: Capture) -> URL? {
        guard let data = pngData(for: capture) else { return nil }
        let stamp = ISO8601DateFormatter().string(from: capture.createdAt)
            .replacingOccurrences(of: ":", with: "-")
        let name = "PNGCamera-\(stamp)-\(capture.id.uuidString.prefix(6)).png"
        let url = URL.temporaryDirectory.appendingPathComponent(name)
        do {
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            lastError = "Could not prepare the file for sharing."
            return nil
        }
    }
}
