import Foundation

/// A named instruction sent to Claude along with the capture.
struct AIPrompt: Codable, Hashable, Identifiable {
    var id: UUID = UUID()
    var name: String
    var instruction: String
    /// When true the capture image is attached in addition to the text.
    var includesImage: Bool = true

    init(id: UUID = UUID(), name: String, instruction: String, includesImage: Bool = true) {
        self.id = id
        self.name = name
        self.instruction = instruction
        self.includesImage = includesImage
    }

    static let defaults: [AIPrompt] = [
        AIPrompt(
            id: UUID(uuidString: "00000000-0000-0000-0000-0000000000B1")!,
            name: "Clean up text",
            instruction: """
            Correct obvious character recognition errors in the text and restore its \
            original line structure. Return only the corrected text, with no commentary.
            """
        ),
        AIPrompt(
            id: UUID(uuidString: "00000000-0000-0000-0000-0000000000B2")!,
            name: "Extract fields as JSON",
            instruction: """
            Extract the meaningful fields from this capture and return a single JSON \
            object. Use lowerCamelCase keys, omit fields you cannot read, and return \
            only the JSON.
            """
        ),
        AIPrompt(
            id: UUID(uuidString: "00000000-0000-0000-0000-0000000000B3")!,
            name: "Summarize",
            instruction: """
            Summarize what this capture shows in two or three sentences. Lead with \
            what it is, then the details that matter.
            """
        ),
        AIPrompt(
            id: UUID(uuidString: "00000000-0000-0000-0000-0000000000B4")!,
            name: "Describe for alt text",
            instruction: """
            Write a single sentence of alt text describing the subject of this image. \
            Return only the sentence.
            """
        ),
        AIPrompt(
            id: UUID(uuidString: "00000000-0000-0000-0000-0000000000B5")!,
            name: "Translate to English",
            instruction: """
            Translate the text into English, preserving the line structure. Return only \
            the translation.
            """
        )
    ]
}

/// Models offered in Settings. Claude Opus 5 is the default.
struct AnthropicModel: Identifiable, Hashable {
    var id: String
    var name: String
    var detail: String

    static let opus = AnthropicModel(
        id: "claude-opus-5",
        name: "Claude Opus 5",
        detail: "Most capable. Best for messy captures and structured extraction."
    )
    static let sonnet = AnthropicModel(
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        detail: "Balanced speed and quality."
    )
    static let haiku = AnthropicModel(
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        detail: "Fastest and cheapest. Good for short cleanups."
    )

    static let all: [AnthropicModel] = [opus, sonnet, haiku]

    static func named(_ id: String) -> AnthropicModel {
        all.first { $0.id == id } ?? opus
    }
}
