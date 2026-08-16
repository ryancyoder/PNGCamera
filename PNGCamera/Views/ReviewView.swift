import SwiftUI

/// Post-capture screen: preview the cutout, inspect and edit the extracted
/// text, dictate a note, run an AI prompt, then copy, share or save.
@MainActor
struct ReviewView: View {

    @Binding var capture: ProcessedCapture?
    let processor: CaptureProcessor

    @Environment(AppSettings.self) private var settings
    @Environment(CaptureStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var dictation = DictationController()
    @State private var pane: Pane = .parsed
    @State private var shareURL: URL?
    @State private var banner: (kind: StatusBanner.Kind, text: String)?
    @State private var isRunningAI = false
    @State private var didRunAutomaticAI = false

    enum Pane: String, CaseIterable, Identifiable {
        case parsed = "Parsed"
        case text = "Text"
        case codes = "Codes"
        case note = "Note"
        case ai = "AI"

        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack {
            Group {
                if capture != nil {
                    content
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Review")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Discard", role: .destructive) { finish() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { saveToLibrary() }
                }
            }
        }
        .task { await runAutomaticActions() }
        .onDisappear { dictation.stop() }
    }

    // MARK: - Layout

    @ViewBuilder
    private var content: some View {
        ScrollView {
            VStack(spacing: 16) {
                preview
                warnings
                scriptPicker
                paneSelector
                paneContent
                actionButtons
            }
            .padding(16)
        }
        .overlay(alignment: .top) {
            if let banner {
                StatusBanner(kind: banner.kind, message: banner.text)
                    .padding(.top, 6)
            }
        }
        .task(id: capture?.pngData.count) { await prepareShareFile() }
    }

    @ViewBuilder
    private var preview: some View {
        if let image = capture?.uiImage {
            TransparencyPreview(image: image)
                .frame(maxWidth: .infinity)
                .frame(height: 280)
                .overlay(alignment: .bottomTrailing) {
                    if let capture {
                        Text("\(Int(capture.pixelSize.width)) × \(Int(capture.pixelSize.height))")
                            .font(.caption2.monospacedDigit())
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(.black.opacity(0.5), in: Capsule())
                            .foregroundStyle(.white)
                            .padding(8)
                    }
                }
        }
    }

    @ViewBuilder
    private var warnings: some View {
        if let warnings = capture?.warnings, !warnings.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(warnings, id: \.self) { warning in
                    Label(warning, systemImage: "info.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var scriptPicker: some View {
        @Bindable var settings = settings
        return HStack {
            Label("Script", systemImage: "text.viewfinder")
                .font(.subheadline)
            Spacer()
            Picker("Script", selection: $settings.selectedScriptID) {
                ForEach(settings.allScripts) { script in
                    Text(script.name).tag(script.id)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
        }
        .onChange(of: settings.selectedScriptID) { _, _ in reparse() }
    }

    private var paneSelector: some View {
        Picker("Pane", selection: $pane) {
            ForEach(Pane.allCases) { pane in
                Text(pane.rawValue).tag(pane)
            }
        }
        .pickerStyle(.segmented)
    }

    @ViewBuilder
    private var paneContent: some View {
        switch pane {
        case .parsed:
            editor(text: bindingForParsedText, placeholder: "No parsed text. Try a different script.")
        case .text:
            editor(text: bindingForRecognizedText, placeholder: "No text was recognized.")
        case .codes:
            barcodeList
        case .note:
            notePane
        case .ai:
            aiPane
        }
    }

    private func editor(text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if text.wrappedValue.isEmpty {
                Text(placeholder)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            TextEditor(text: text)
                .font(.body.monospaced())
                .frame(minHeight: 160)
                .padding(8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        }
    }

    @ViewBuilder
    private var barcodeList: some View {
        let codes = capture?.metadata.barcodes ?? []
        if codes.isEmpty {
            Text("No barcodes found.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            VStack(spacing: 8) {
                ForEach(codes) { code in
                    Button {
                        Clipboard.copy(text: code.payload)
                        show(.success, "Copied \(code.symbology)")
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(code.payload)
                                    .font(.callout.monospaced())
                                    .multilineTextAlignment(.leading)
                                Text(code.symbology)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "doc.on.doc")
                                .foregroundStyle(.secondary)
                        }
                        .padding(12)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var notePane: some View {
        VStack(spacing: 12) {
            HStack {
                Button {
                    Task { await dictation.toggle() }
                } label: {
                    Label(
                        dictation.isListening ? "Stop dictation" : "Dictate a note",
                        systemImage: dictation.isListening ? "stop.circle.fill" : "mic.circle.fill"
                    )
                }
                .buttonStyle(.borderedProminent)
                .tint(dictation.isListening ? .red : .accentColor)

                Spacer()

                if dictation.isListening {
                    ProgressView().controlSize(.small)
                }
            }

            if case .unauthorized(let reason) = dictation.state {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if case .failed(let reason) = dictation.state {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            editor(text: bindingForDictation, placeholder: "Dictate or type a note to store with this capture.")
        }
        .onChange(of: dictation.transcript) { _, transcript in
            guard !transcript.isEmpty else { return }
            capture?.metadata.dictation = transcript
        }
    }

    @ViewBuilder
    private var aiPane: some View {
        @Bindable var settings = settings
        VStack(alignment: .leading, spacing: 12) {
            if !settings.aiEnabled {
                Text("Turn on AI processing in Settings and add an Anthropic API key to use this.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                Picker("Prompt", selection: $settings.selectedPromptID) {
                    ForEach(settings.aiPrompts) { prompt in
                        Text(prompt.name).tag(prompt.id)
                    }
                }
                .pickerStyle(.menu)

                Button {
                    Task { await runAI() }
                } label: {
                    if isRunningAI {
                        HStack {
                            ProgressView().controlSize(.small)
                            Text("Running \(AnthropicModel.named(settings.aiModel).name)…")
                        }
                    } else {
                        Label("Run \(settings.selectedPrompt?.name ?? "prompt")", systemImage: "sparkles")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isRunningAI)
            }

            editor(text: bindingForAIOutput, placeholder: "The AI result appears here.")
        }
    }

    private var actionButtons: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                Button {
                    Clipboard.copy(text: activeText)
                    show(.success, "Text copied")
                } label: {
                    Label("Copy text", systemImage: "doc.on.doc")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(activeText.isEmpty)

                Button {
                    if let data = capture?.pngData {
                        Clipboard.copy(pngData: data)
                        show(.success, "PNG copied")
                    }
                } label: {
                    Label("Copy PNG", systemImage: "photo.on.rectangle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }

            HStack(spacing: 10) {
                if let shareURL {
                    ShareLink(item: shareURL) {
                        Label("Share", systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }

                Button {
                    Task { await saveToPhotos() }
                } label: {
                    Label("Save to Photos", systemImage: "square.and.arrow.down")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        }
    }

    // MARK: - Bindings

    private var bindingForParsedText: Binding<String> {
        Binding(
            get: { capture?.metadata.parsedText ?? "" },
            set: { capture?.metadata.parsedText = $0 }
        )
    }

    private var bindingForRecognizedText: Binding<String> {
        Binding(
            get: { capture?.metadata.recognizedText ?? "" },
            set: { capture?.metadata.recognizedText = $0 }
        )
    }

    private var bindingForDictation: Binding<String> {
        Binding(
            get: { capture?.metadata.dictation ?? "" },
            set: { capture?.metadata.dictation = $0 }
        )
    }

    private var bindingForAIOutput: Binding<String> {
        Binding(
            get: { capture?.metadata.aiOutput ?? "" },
            set: { capture?.metadata.aiOutput = $0 }
        )
    }

    /// The text the copy button acts on, chosen by the visible pane.
    private var activeText: String {
        guard let metadata = capture?.metadata else { return "" }
        switch pane {
        case .parsed: return metadata.parsedText
        case .text: return metadata.recognizedText
        case .codes: return metadata.barcodes.map(\.payload).joined(separator: "\n")
        case .note: return metadata.dictation
        case .ai: return metadata.aiOutput
        }
    }

    // MARK: - Actions

    private func runAutomaticActions() async {
        if settings.dictateAfterCapture {
            await dictation.start()
        }
        if settings.aiEnabled, settings.aiRunsAutomatically, !didRunAutomaticAI {
            didRunAutomaticAI = true
            await runAI()
        }
    }

    private func reparse() {
        guard let current = capture else { return }
        capture?.metadata = processor.reparse(
            current,
            with: settings.selectedScript,
            includeBarcodes: settings.appendBarcodesToText
        )
    }

    private func runAI() async {
        guard let current = capture, let prompt = settings.selectedPrompt else { return }
        guard let apiKey = KeychainStore.string(for: .anthropicAPIKey), !apiKey.isEmpty else {
            show(.failure, "Add an API key in Settings")
            return
        }

        isRunningAI = true
        defer { isRunningAI = false }

        let client = AnthropicClient(apiKey: apiKey, model: settings.aiModel)
        let image = (prompt.includesImage && settings.aiSendsImage) ? current.uiImage : nil
        let text = current.metadata.recognizedText.isEmpty
            ? current.metadata.parsedText
            : current.metadata.recognizedText

        do {
            let output = try await client.send(instruction: prompt.instruction, text: text, image: image)
            capture?.metadata.aiOutput = output
            pane = .ai
        } catch {
            show(.failure, error.localizedDescription)
        }
    }

    private func saveToLibrary() {
        guard let current = capture else { return }
        let encoded = processor.reencode(
            current,
            metadata: current.metadata,
            embedMetadata: settings.embedMetadataInPNG
        )
        do {
            try store.save(
                pngData: encoded.pngData,
                metadata: encoded.metadata,
                pixelSize: encoded.pixelSize
            )
            finish()
        } catch {
            show(.failure, "Could not save: \(error.localizedDescription)")
        }
    }

    private func saveToPhotos() async {
        guard let current = capture else { return }
        let encoded = processor.reencode(
            current,
            metadata: current.metadata,
            embedMetadata: settings.embedMetadataInPNG
        )
        do {
            try await PhotoLibrarySaver.save(pngData: encoded.pngData)
            show(.success, "Saved to Photos")
        } catch {
            show(.failure, error.localizedDescription)
        }
    }

    private func prepareShareFile() async {
        guard let current = capture else { return }
        let encoded = processor.reencode(
            current,
            metadata: current.metadata,
            embedMetadata: settings.embedMetadataInPNG
        )
        let name = "PNGCamera-\(Int(Date().timeIntervalSince1970)).png"
        let url = URL.temporaryDirectory.appendingPathComponent(name)
        do {
            try encoded.pngData.write(to: url, options: .atomic)
            shareURL = url
        } catch {
            shareURL = nil
        }
    }

    private func finish() {
        dictation.stop()
        capture = nil
        dismiss()
    }

    private func show(_ kind: StatusBanner.Kind, _ text: String) {
        withAnimation { banner = (kind, text) }
        Task {
            try? await Task.sleep(for: .seconds(2.5))
            withAnimation { banner = nil }
        }
    }
}
