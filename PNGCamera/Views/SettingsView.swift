import SwiftUI

@MainActor
struct SettingsView: View {

    @Environment(AppSettings.self) private var settings
    @Environment(CaptureStore.self) private var store

    @State private var apiKeyDraft = ""
    @State private var apiKeyStatus: String?
    @State private var editingScript: ParsingScript?
    @State private var editingPrompt: AIPrompt?

    var body: some View {
        @Bindable var settings = settings

        NavigationStack {
            Form {
                Section("Capture") {
                    Toggle("Remove background", isOn: $settings.removeBackground)
                    Toggle("Recognize text", isOn: $settings.recognizeText)
                    Toggle("Scan barcodes", isOn: $settings.scanBarcodes)
                    Toggle("Include barcode payloads in parsed text", isOn: $settings.appendBarcodesToText)
                        .disabled(!settings.scanBarcodes)
                }

                Section {
                    Toggle("Copy text after capture", isOn: $settings.copyTextAutomatically)
                    Toggle("Copy PNG after capture", isOn: $settings.copyImageAutomatically)
                    Toggle("Save to Photos after capture", isOn: $settings.saveToPhotoLibrary)
                    Toggle("Write text into PNG metadata", isOn: $settings.embedMetadataInPNG)
                } header: {
                    Text("Output")
                } footer: {
                    Text("Metadata is written as PNG text chunks, so the recognized text travels with the file.")
                }

                Section("Text recognition") {
                    NavigationLink {
                        LanguagePickerView()
                    } label: {
                        LabeledContent("Languages", value: languageSummary)
                    }
                    Toggle("Language correction", isOn: $settings.usesLanguageCorrection)
                }

                Section {
                    Picker("Default script", selection: $settings.selectedScriptID) {
                        ForEach(settings.allScripts) { script in
                            Text(script.name).tag(script.id)
                        }
                    }
                    ForEach(settings.customScripts) { script in
                        Button {
                            editingScript = script
                        } label: {
                            scriptRow(script)
                        }
                    }
                    .onDelete { offsets in
                        for index in offsets {
                            settings.deleteScript(id: settings.customScripts[index].id)
                        }
                    }
                    Button("New script", systemImage: "plus") {
                        editingScript = ParsingScript(name: "New script", detail: "", steps: [])
                    }
                    Menu("Duplicate a built-in script") {
                        ForEach(BuiltInScripts.all) { script in
                            Button(script.name) { editingScript = script.duplicated() }
                        }
                    }
                } header: {
                    Text("Parsing scripts")
                } footer: {
                    Text(settings.selectedScript.detail)
                }

                Section {
                    Toggle("Dictate after each capture", isOn: $settings.dictateAfterCapture)
                } header: {
                    Text("Dictation")
                } footer: {
                    Text("Starts recording as soon as the review screen opens. The transcript is stored with the capture.")
                }

                aiSection

                Section {
                    LabeledContent("Saved captures", value: "\(store.captures.count)")
                    Button("Delete all captures", role: .destructive) {
                        store.deleteAll()
                    }
                    .disabled(store.captures.isEmpty)
                } header: {
                    Text("Storage")
                }

                Section {
                    LabeledContent("Version", value: Bundle.main.shortVersion)
                } footer: {
                    Text("Captures never leave the device unless you share them or turn on AI processing.")
                }
            }
            .navigationTitle("Settings")
            .sheet(item: $editingScript) { script in
                ScriptEditorView(script: script) { saved in
                    settings.upsert(saved)
                }
            }
            .sheet(item: $editingPrompt) { prompt in
                PromptEditorView(prompt: prompt) { saved in
                    settings.upsert(saved)
                }
            }
            .onAppear {
                apiKeyDraft = KeychainStore.string(for: .anthropicAPIKey) ?? ""
            }
        }
    }

    // MARK: - AI

    @ViewBuilder
    private var aiSection: some View {
        @Bindable var settings = settings

        Section {
            Toggle("Enable AI processing", isOn: $settings.aiEnabled)

            if settings.aiEnabled {
                SecureField("Anthropic API key", text: $apiKeyDraft)
                    .textContentType(.password)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)

                HStack {
                    Button("Save key") {
                        KeychainStore.set(apiKeyDraft, for: .anthropicAPIKey)
                        apiKeyStatus = apiKeyDraft.isEmpty ? "Key removed." : "Key saved to the keychain."
                    }
                    Spacer()
                    Button("Remove", role: .destructive) {
                        KeychainStore.delete(.anthropicAPIKey)
                        apiKeyDraft = ""
                        apiKeyStatus = "Key removed."
                    }
                    .disabled(apiKeyDraft.isEmpty)
                }

                if let apiKeyStatus {
                    Text(apiKeyStatus).font(.caption).foregroundStyle(.secondary)
                }

                Picker("Model", selection: $settings.aiModel) {
                    ForEach(AnthropicModel.all) { model in
                        Text(model.name).tag(model.id)
                    }
                }
                Text(AnthropicModel.named(settings.aiModel).detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Toggle("Attach the image", isOn: $settings.aiSendsImage)
                Toggle("Run automatically after capture", isOn: $settings.aiRunsAutomatically)

                Picker("Default prompt", selection: $settings.selectedPromptID) {
                    ForEach(settings.aiPrompts) { prompt in
                        Text(prompt.name).tag(prompt.id)
                    }
                }

                ForEach(settings.aiPrompts) { prompt in
                    Button {
                        editingPrompt = prompt
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(prompt.name).foregroundStyle(.primary)
                            Text(prompt.instruction)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                }
                .onDelete { offsets in
                    for index in offsets {
                        settings.deletePrompt(id: settings.aiPrompts[index].id)
                    }
                }

                Button("New prompt", systemImage: "plus") {
                    editingPrompt = AIPrompt(name: "New prompt", instruction: "")
                }
            }
        } header: {
            Text("AI processing")
        } footer: {
            Text("Captures are sent to the Anthropic API only when you run a prompt. The key is stored in the keychain, never in a backup-visible file.")
        }
    }

    // MARK: - Helpers

    private var languageSummary: String {
        let languages = settings.recognitionLanguages
        if languages.isEmpty { return "Automatic" }
        return languages.joined(separator: ", ")
    }

    private func scriptRow(_ script: ParsingScript) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(script.name).foregroundStyle(.primary)
            Text(script.steps.isEmpty ? "No steps" : "\(script.steps.count) step\(script.steps.count == 1 ? "" : "s")")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

/// Multi-select list of the recognition languages Vision supports on this device.
@MainActor
struct LanguagePickerView: View {

    @Environment(AppSettings.self) private var settings

    private let available = TextRecognizer.supportedLanguages()

    var body: some View {
        List {
            Section {
                Button {
                    settings.recognitionLanguages = []
                } label: {
                    HStack {
                        Text("Automatic")
                        Spacer()
                        if settings.recognitionLanguages.isEmpty {
                            Image(systemName: "checkmark").foregroundStyle(.tint)
                        }
                    }
                }
            } footer: {
                Text("Automatic lets Vision detect the language. Choosing languages explicitly is more accurate when you know what you are photographing.")
            }

            Section("Languages") {
                ForEach(available, id: \.self) { language in
                    Button {
                        toggle(language)
                    } label: {
                        HStack {
                            Text(displayName(for: language))
                            Spacer()
                            if settings.recognitionLanguages.contains(language) {
                                Image(systemName: "checkmark").foregroundStyle(.tint)
                            }
                        }
                    }
                    .foregroundStyle(.primary)
                }
            }
        }
        .navigationTitle("Languages")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func toggle(_ language: String) {
        var languages = settings.recognitionLanguages
        if let index = languages.firstIndex(of: language) {
            languages.remove(at: index)
        } else {
            languages.append(language)
        }
        settings.recognitionLanguages = languages
    }

    private func displayName(for identifier: String) -> String {
        Locale.current.localizedString(forIdentifier: identifier) ?? identifier
    }
}

extension Bundle {
    var shortVersion: String {
        let version = infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(version) (\(build))"
    }
}
