import Foundation
import Observation

/// Everything the user can configure, in one codable value.
struct SettingsData: Codable, Hashable {
    // Capture pipeline
    var removeBackground = true
    var recognizeText = true
    var scanBarcodes = true
    var appendBarcodesToText = true

    // Output
    var copyTextAutomatically = true
    var copyImageAutomatically = false
    var embedMetadataInPNG = true
    var saveToPhotoLibrary = false

    // Text recognition
    var recognitionLanguages: [String] = []
    var usesLanguageCorrection = true

    // Parsing
    var customScripts: [ParsingScript] = []
    var selectedScriptID: UUID = BuiltInScripts.plainTextID

    // Dictation
    var dictateAfterCapture = false

    // Anthropic API
    var aiEnabled = false
    var aiModel: String = AnthropicModel.opus.id
    var aiSendsImage = true
    var aiRunsAutomatically = false
    var aiPrompts: [AIPrompt] = AIPrompt.defaults
    var selectedPromptID: UUID = AIPrompt.defaults[0].id
}

/// Observable wrapper that persists `SettingsData` to `UserDefaults` on change.
///
/// Properties are computed over a single stored value so one `didSet` covers
/// every setting; SwiftUI still tracks each one individually through
/// `@Observable`.
@MainActor
@Observable
final class AppSettings {

    private static let storageKey = "PNGCamera.settings"

    private var data: SettingsData {
        didSet { persist() }
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let stored = defaults.data(forKey: Self.storageKey),
           let decoded = try? JSONDecoder().decode(SettingsData.self, from: stored) {
            self.data = decoded
        } else {
            self.data = SettingsData()
        }
    }

    private func persist() {
        guard let encoded = try? JSONEncoder().encode(data) else { return }
        defaults.set(encoded, forKey: Self.storageKey)
    }

    // MARK: - Capture pipeline

    var removeBackground: Bool {
        get { data.removeBackground }
        set { data.removeBackground = newValue }
    }

    var recognizeText: Bool {
        get { data.recognizeText }
        set { data.recognizeText = newValue }
    }

    var scanBarcodes: Bool {
        get { data.scanBarcodes }
        set { data.scanBarcodes = newValue }
    }

    var appendBarcodesToText: Bool {
        get { data.appendBarcodesToText }
        set { data.appendBarcodesToText = newValue }
    }

    // MARK: - Output

    var copyTextAutomatically: Bool {
        get { data.copyTextAutomatically }
        set { data.copyTextAutomatically = newValue }
    }

    var copyImageAutomatically: Bool {
        get { data.copyImageAutomatically }
        set { data.copyImageAutomatically = newValue }
    }

    var embedMetadataInPNG: Bool {
        get { data.embedMetadataInPNG }
        set { data.embedMetadataInPNG = newValue }
    }

    var saveToPhotoLibrary: Bool {
        get { data.saveToPhotoLibrary }
        set { data.saveToPhotoLibrary = newValue }
    }

    // MARK: - Text recognition

    var recognitionLanguages: [String] {
        get { data.recognitionLanguages }
        set { data.recognitionLanguages = newValue }
    }

    var usesLanguageCorrection: Bool {
        get { data.usesLanguageCorrection }
        set { data.usesLanguageCorrection = newValue }
    }

    // MARK: - Dictation

    var dictateAfterCapture: Bool {
        get { data.dictateAfterCapture }
        set { data.dictateAfterCapture = newValue }
    }

    // MARK: - Parsing scripts

    /// Built-in scripts first, then the user's own.
    var allScripts: [ParsingScript] {
        BuiltInScripts.all + data.customScripts
    }

    var customScripts: [ParsingScript] {
        get { data.customScripts }
        set { data.customScripts = newValue }
    }

    var selectedScriptID: UUID {
        get { data.selectedScriptID }
        set { data.selectedScriptID = newValue }
    }

    var selectedScript: ParsingScript {
        allScripts.first { $0.id == data.selectedScriptID } ?? BuiltInScripts.plainText
    }

    func script(withID id: UUID) -> ParsingScript? {
        allScripts.first { $0.id == id }
    }

    func upsert(_ script: ParsingScript) {
        if let index = data.customScripts.firstIndex(where: { $0.id == script.id }) {
            data.customScripts[index] = script
        } else {
            data.customScripts.append(script)
        }
    }

    func deleteScript(id: UUID) {
        data.customScripts.removeAll { $0.id == id }
        if data.selectedScriptID == id {
            data.selectedScriptID = BuiltInScripts.plainTextID
        }
    }

    // MARK: - Anthropic API

    var aiEnabled: Bool {
        get { data.aiEnabled }
        set { data.aiEnabled = newValue }
    }

    var aiModel: String {
        get { data.aiModel }
        set { data.aiModel = newValue }
    }

    var aiSendsImage: Bool {
        get { data.aiSendsImage }
        set { data.aiSendsImage = newValue }
    }

    var aiRunsAutomatically: Bool {
        get { data.aiRunsAutomatically }
        set { data.aiRunsAutomatically = newValue }
    }

    var aiPrompts: [AIPrompt] {
        get { data.aiPrompts }
        set { data.aiPrompts = newValue }
    }

    var selectedPromptID: UUID {
        get { data.selectedPromptID }
        set { data.selectedPromptID = newValue }
    }

    var selectedPrompt: AIPrompt? {
        data.aiPrompts.first { $0.id == data.selectedPromptID } ?? data.aiPrompts.first
    }

    func upsert(_ prompt: AIPrompt) {
        if let index = data.aiPrompts.firstIndex(where: { $0.id == prompt.id }) {
            data.aiPrompts[index] = prompt
        } else {
            data.aiPrompts.append(prompt)
        }
    }

    func deletePrompt(id: UUID) {
        data.aiPrompts.removeAll { $0.id == id }
        if data.selectedPromptID == id, let first = data.aiPrompts.first {
            data.selectedPromptID = first.id
        }
    }
}
