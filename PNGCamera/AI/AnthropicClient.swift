import Foundation
import UIKit

/// Calls the Anthropic Messages API over raw HTTPS.
///
/// There is no official Anthropic SDK for Swift, so requests are built by hand
/// against `POST /v1/messages`. Notes that matter for the current models:
///
/// * `temperature` / `top_p` / `top_k` are rejected on Claude Opus 5 — they are
///   never sent.
/// * A refusal arrives as HTTP 200 with `stop_reason: "refusal"` and empty or
///   partial content, so `stop_reason` is checked before reading `content`.
/// * Server-side fallbacks are opted into so a policy decline is re-served by
///   Anthropic's recommended fallback model inside the same call.
struct AnthropicClient {

    static let endpoint = URL(string: "https://api.anthropic.com/v1/messages")!
    static let apiVersion = "2023-06-01"
    static let fallbackBeta = "server-side-fallback-2026-07-01"

    /// Long edge the attached image is resized to before upload. Claude's
    /// high-resolution tier accepts up to 2576px; 2048 keeps detail while
    /// bounding the per-request image token cost.
    static let maxImageDimension: CGFloat = 2048

    var apiKey: String
    var model: String
    var maxTokens: Int = 16_000
    var session: URLSession = .shared

    enum Failure: LocalizedError {
        case missingAPIKey
        case refused(String?)
        case emptyResponse
        case http(status: Int, message: String)
        case transport(Error)

        var errorDescription: String? {
            switch self {
            case .missingAPIKey:
                return "Add an Anthropic API key in Settings to use AI processing."
            case .refused(let explanation):
                return explanation ?? "Claude declined to process this capture."
            case .emptyResponse:
                return "Claude returned an empty response."
            case .http(let status, let message):
                switch status {
                case 401: return "The API key was rejected. Check it in Settings."
                case 403: return "This API key does not have access to the selected model."
                case 404: return "The selected model is unavailable for this key."
                case 429: return "Rate limited by the API. Try again in a moment."
                case 500...599: return "The API is temporarily unavailable. Try again."
                default: return message.isEmpty ? "Request failed with status \(status)." : message
                }
            case .transport(let error):
                return error.localizedDescription
            }
        }
    }

    /// Sends the instruction plus optional text and image, returning Claude's reply.
    func send(instruction: String, text: String?, image: UIImage?) async throws -> String {
        guard !apiKey.isEmpty else { throw Failure.missingAPIKey }

        var content: [[String: Any]] = []

        if let image, let encoded = Self.encodeForUpload(image) {
            content.append([
                "type": "image",
                "source": [
                    "type": "base64",
                    "media_type": "image/png",
                    "data": encoded
                ]
            ])
        }

        var userText = instruction
        if let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            userText += "\n\n<recognized_text>\n\(text)\n</recognized_text>"
        }
        content.append(["type": "text", "text": userText])

        let body: [String: Any] = [
            "model": model,
            "max_tokens": maxTokens,
            "system": Self.systemPrompt,
            "fallbacks": "default",
            "messages": [["role": "user", "content": content]]
        ]

        var request = URLRequest(url: Self.endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue(Self.apiVersion, forHTTPHeaderField: "anthropic-version")
        request.setValue(Self.fallbackBeta, forHTTPHeaderField: "anthropic-beta")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw Failure.transport(error)
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]

        guard (200..<300).contains(status) else {
            let message = (json["error"] as? [String: Any])?["message"] as? String ?? ""
            throw Failure.http(status: status, message: message)
        }

        // A refusal is a successful HTTP response, so check it before reading content.
        if json["stop_reason"] as? String == "refusal" {
            let details = json["stop_details"] as? [String: Any]
            throw Failure.refused(details?["explanation"] as? String)
        }

        let blocks = json["content"] as? [[String: Any]] ?? []
        let text = blocks
            .filter { $0["type"] as? String == "text" }
            .compactMap { $0["text"] as? String }
            .joined()
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !text.isEmpty else { throw Failure.emptyResponse }
        return text
    }

    private static let systemPrompt = """
    You are the processing step of a camera app. The user has photographed \
    something and may attach the cropped image, text read from it by on-device \
    OCR, or both. OCR output can contain recognition errors.

    Return only the requested result, ready to paste. No preamble, no \
    explanation of what you did, and no markdown code fences unless the result \
    itself is code.
    """

    /// Downscales and re-encodes the capture as PNG for upload.
    static func encodeForUpload(_ image: UIImage) -> String? {
        let resized = resize(image, maxDimension: maxImageDimension)
        return resized.pngData()?.base64EncodedString()
    }

    static func resize(_ image: UIImage, maxDimension: CGFloat) -> UIImage {
        let size = image.size
        let longEdge = max(size.width, size.height)
        guard longEdge > maxDimension, longEdge > 0 else { return image }

        let scale = maxDimension / longEdge
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = false
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }
}
