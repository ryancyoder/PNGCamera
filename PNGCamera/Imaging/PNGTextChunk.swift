import Foundation

/// Reads and writes PNG textual metadata chunks (`tEXt` / `iTXt`).
///
/// ImageIO can only write the handful of keywords it knows about, so anything
/// structured (JSON payloads, custom keys) has to be spliced into the byte
/// stream directly. Uncompressed `iTXt` is used for everything because `tEXt`
/// is Latin-1 only and recognized text is frequently not.
enum PNGTextChunk {

    struct Entry: Hashable {
        var keyword: String
        var text: String
    }

    enum Failure: LocalizedError {
        case notAPNG
        case truncated
        case keywordTooLong(String)

        var errorDescription: String? {
            switch self {
            case .notAPNG: return "The data is not a PNG image."
            case .truncated: return "The PNG data ended unexpectedly."
            case .keywordTooLong(let keyword): return "PNG keyword \"\(keyword)\" exceeds 79 characters."
            }
        }
    }

    private static let signature = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

    // MARK: - Writing

    /// Returns a copy of `png` with `entries` inserted as `iTXt` chunks.
    ///
    /// Chunks are placed immediately after `IHDR`, which is legal for `iTXt`
    /// and keeps them ahead of the image data so readers see them early.
    static func inserting(_ entries: [Entry], into png: Data) throws -> Data {
        guard !entries.isEmpty else { return png }
        guard png.count > signature.count, png.prefix(signature.count) == signature else {
            throw Failure.notAPNG
        }
        for entry in entries where entry.keyword.utf8.count > 79 {
            throw Failure.keywordTooLong(entry.keyword)
        }

        // IHDR is required to be the first chunk: 8 byte signature + 4 length
        // + 4 type + 13 data + 4 CRC.
        let insertionPoint = signature.count + 4 + 4 + 13 + 4
        guard png.count >= insertionPoint else { throw Failure.truncated }

        var output = Data()
        output.reserveCapacity(png.count + entries.count * 128)
        output.append(png.prefix(insertionPoint))
        for entry in entries {
            output.append(makeITXtChunk(keyword: entry.keyword, text: entry.text))
        }
        output.append(png.dropFirst(insertionPoint))
        return output
    }

    private static func makeITXtChunk(keyword: String, text: String) -> Data {
        // iTXt layout: keyword \0 compressionFlag compressionMethod
        //              languageTag \0 translatedKeyword \0 text
        var payload = Data()
        payload.append(contentsOf: Array(keyword.utf8))
        payload.append(0)
        payload.append(0) // not compressed
        payload.append(0) // compression method (ignored when uncompressed)
        payload.append(0) // empty language tag
        payload.append(0) // empty translated keyword
        payload.append(contentsOf: Array(text.utf8))
        return makeChunk(type: "iTXt", payload: payload)
    }

    private static func makeChunk(type: String, payload: Data) -> Data {
        var chunk = Data()
        chunk.append(bigEndian: UInt32(payload.count))
        var typeAndPayload = Data(type.utf8)
        typeAndPayload.append(payload)
        chunk.append(typeAndPayload)
        chunk.append(bigEndian: crc32(typeAndPayload))
        return chunk
    }

    /// Removes every existing `tEXt` / `iTXt` chunk, then inserts `entries`.
    ///
    /// Used when metadata changes after export (an AI result or a dictation
    /// added later) so keywords are replaced rather than duplicated.
    static func replacing(_ entries: [Entry], in png: Data) throws -> Data {
        try inserting(entries, into: removingTextChunks(from: png))
    }

    /// Returns `png` with all textual chunks stripped.
    static func removingTextChunks(from png: Data) -> Data {
        guard png.count > signature.count, png.prefix(signature.count) == signature else { return png }

        var output = Data()
        output.reserveCapacity(png.count)
        output.append(png.prefix(signature.count))

        var cursor = png.startIndex + signature.count
        while cursor + 8 <= png.endIndex {
            let length = Int(png.readBigEndianUInt32(at: cursor))
            let typeStart = cursor + 4
            let dataStart = typeStart + 4
            guard length >= 0, dataStart + length + 4 <= png.endIndex else { break }

            let type = String(decoding: png[typeStart..<dataStart], as: UTF8.self)
            let chunkEnd = dataStart + length + 4
            if type != "tEXt" && type != "iTXt" && type != "zTXt" {
                output.append(png[cursor..<chunkEnd])
            }
            cursor = chunkEnd
            if type == "IEND" { break }
        }
        return output
    }

    // MARK: - Reading

    /// Extracts every `tEXt` and uncompressed `iTXt` entry from a PNG.
    static func entries(in png: Data) -> [Entry] {
        guard png.count > signature.count, png.prefix(signature.count) == signature else { return [] }

        var entries: [Entry] = []
        var cursor = png.startIndex + signature.count

        while cursor + 8 <= png.endIndex {
            let length = Int(png.readBigEndianUInt32(at: cursor))
            let typeStart = cursor + 4
            let dataStart = typeStart + 4
            guard length >= 0, dataStart + length + 4 <= png.endIndex else { break }

            let type = String(decoding: png[typeStart..<dataStart], as: UTF8.self)
            let payload = png[dataStart..<(dataStart + length)]

            switch type {
            case "tEXt": entries.append(contentsOf: parseTEXt(payload))
            case "iTXt": entries.append(contentsOf: parseITXt(payload))
            case "IEND": return entries
            default: break
            }

            cursor = dataStart + length + 4
        }
        return entries
    }

    private static func parseTEXt<C: Collection>(_ payload: C) -> [Entry] where C.Element == UInt8 {
        let bytes = Array(payload)
        guard let separator = bytes.firstIndex(of: 0) else { return [] }
        let keyword = String(decoding: bytes[..<separator], as: UTF8.self)
        let text = String(decoding: bytes[(separator + 1)...], as: UTF8.self)
        return [Entry(keyword: keyword, text: text)]
    }

    private static func parseITXt<C: Collection>(_ payload: C) -> [Entry] where C.Element == UInt8 {
        let bytes = Array(payload)
        guard let keywordEnd = bytes.firstIndex(of: 0), bytes.count > keywordEnd + 2 else { return [] }
        let keyword = String(decoding: bytes[..<keywordEnd], as: UTF8.self)
        let compressionFlag = bytes[keywordEnd + 1]
        guard compressionFlag == 0 else { return [] } // compressed entries are not read back

        var index = keywordEnd + 3 // skip both compression bytes
        guard let languageEnd = bytes[index...].firstIndex(of: 0) else { return [] }
        index = languageEnd + 1
        guard let translatedEnd = bytes[index...].firstIndex(of: 0) else { return [] }
        index = translatedEnd + 1
        guard index <= bytes.count else { return [] }

        let text = String(decoding: bytes[index...], as: UTF8.self)
        return [Entry(keyword: keyword, text: text)]
    }

    // MARK: - CRC

    private static let crcTable: [UInt32] = {
        (0..<256).map { index -> UInt32 in
            var value = UInt32(index)
            for _ in 0..<8 {
                value = (value & 1) != 0 ? 0xEDB8_8320 ^ (value >> 1) : value >> 1
            }
            return value
        }
    }()

    private static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        for byte in data {
            crc = crcTable[Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8)
        }
        return crc ^ 0xFFFF_FFFF
    }
}

private extension Data {
    mutating func append(bigEndian value: UInt32) {
        append(UInt8((value >> 24) & 0xFF))
        append(UInt8((value >> 16) & 0xFF))
        append(UInt8((value >> 8) & 0xFF))
        append(UInt8(value & 0xFF))
    }

    func readBigEndianUInt32(at index: Index) -> UInt32 {
        var value: UInt32 = 0
        for offset in 0..<4 {
            value = (value << 8) | UInt32(self[index + offset])
        }
        return value
    }
}
