import CoreImage
import Foundation
import Vision

struct BarcodeResult: Codable, Hashable, Identifiable {
    var id: String { "\(symbology)-\(payload)" }
    var payload: String
    var symbology: String
}

/// Detects 1D and 2D barcodes anywhere in the frame.
enum BarcodeScanner {

    static func scan(in image: CIImage) async throws -> [BarcodeResult] {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let request = VNDetectBarcodesRequest()
                    // Detect everything this OS build knows about rather than a
                    // hand-picked list, falling back to the common symbologies.
                    request.symbologies = (try? request.supportedSymbologies())
                        ?? [.qr, .ean13, .ean8, .code128, .code39, .pdf417, .aztec, .dataMatrix]

                    let handler = VNImageRequestHandler(ciImage: image, options: [:])
                    try handler.perform([request])

                    let observations = request.results ?? []
                    var seen = Set<String>()
                    var results: [BarcodeResult] = []

                    for observation in observations {
                        let payload = observation.payloadStringValue ?? decodeRawPayload(observation)
                        guard let payload, !payload.isEmpty else { continue }
                        let result = BarcodeResult(
                            payload: payload,
                            symbology: displayName(for: observation.symbology)
                        )
                        // The same code is frequently reported more than once
                        // when it appears at multiple scales.
                        guard seen.insert(result.id).inserted else { continue }
                        results.append(result)
                    }

                    continuation.resume(returning: results)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// Some symbologies (notably raw binary QR payloads) have no string value;
    /// fall back to a UTF-8 reading of the raw descriptor data.
    private static func decodeRawPayload(_ observation: VNBarcodeObservation) -> String? {
        guard let data = observation.payloadData else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func displayName(for symbology: VNBarcodeSymbology) -> String {
        let raw = symbology.rawValue
        // Raw values look like "VNBarcodeSymbologyQR"; trim the prefix.
        if raw.hasPrefix("VNBarcodeSymbology") {
            return String(raw.dropFirst("VNBarcodeSymbology".count))
        }
        return raw
    }
}
