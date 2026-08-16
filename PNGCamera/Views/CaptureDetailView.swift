import SwiftUI
import UIKit

@MainActor
struct CaptureDetailView: View {

    let capture: Capture

    @Environment(CaptureStore.self) private var store
    @Environment(AppSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss

    @State private var isRunningAI = false
    @State private var banner: (kind: StatusBanner.Kind, text: String)?

    /// Always read the live copy so edits made here stay visible.
    private var current: Capture {
        store.captures.first { $0.id == capture.id } ?? capture
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let image = store.image(for: current) {
                    TransparencyPreview(image: image)
                        .frame(height: 300)
                }

                metadataGrid

                section("Parsed text", text: current.metadata.parsedText)
                section("Recognized text", text: current.metadata.recognizedText)

                if !current.metadata.barcodes.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Barcodes").font(.headline)
                        ForEach(current.metadata.barcodes) { code in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(code.payload).font(.callout.monospaced())
                                    Text(code.symbology).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("Copy") { copy(code.payload) }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                            }
                        }
                    }
                }

                section("Note", text: current.metadata.dictation)
                section("AI result", text: current.metadata.aiOutput)

                actions
            }
            .padding(16)
        }
        .overlay(alignment: .top) {
            if let banner {
                StatusBanner(kind: banner.kind, message: banner.text)
                    .padding(.top, 6)
            }
        }
        .navigationTitle(current.createdAt.formatted(date: .abbreviated, time: .shortened))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if let url = store.temporaryExportURL(for: current) {
                        ShareLink(item: url) {
                            Label("Share PNG", systemImage: "square.and.arrow.up")
                        }
                    }
                    Button("Save to Photos", systemImage: "square.and.arrow.down") {
                        Task { await saveToPhotos() }
                    }
                    Divider()
                    Button(role: .destructive) {
                        store.delete(current)
                        dismiss()
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
    }

    private var metadataGrid: some View {
        HStack(spacing: 16) {
            metric("Size", "\(current.pixelWidth) × \(current.pixelHeight)")
            metric("Cutout", current.metadata.backgroundRemoved ? "Yes" : "No")
            if let script = current.metadata.scriptName {
                metric("Script", script)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.subheadline.weight(.medium))
        }
    }

    @ViewBuilder
    private func section(_ title: String, text: String) -> some View {
        if !text.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(title).font(.headline)
                    Spacer()
                    Button("Copy") { copy(text) }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
                Text(text)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    @ViewBuilder
    private var actions: some View {
        @Bindable var settings = settings
        if settings.aiEnabled {
            VStack(alignment: .leading, spacing: 10) {
                Text("Run a prompt").font(.headline)
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
                            Text("Running…")
                        }
                    } else {
                        Label("Run on this capture", systemImage: "sparkles")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isRunningAI)
            }
        }
    }

    // MARK: - Actions

    private func copy(_ text: String) {
        Clipboard.copy(text: text)
        show(.success, "Copied")
    }

    private func saveToPhotos() async {
        guard let data = store.pngData(for: current) else { return }
        do {
            try await PhotoLibrarySaver.save(pngData: data)
            show(.success, "Saved to Photos")
        } catch {
            show(.failure, error.localizedDescription)
        }
    }

    private func runAI() async {
        guard let prompt = settings.selectedPrompt else { return }
        guard let apiKey = KeychainStore.string(for: .anthropicAPIKey), !apiKey.isEmpty else {
            show(.failure, "Add an API key in Settings")
            return
        }

        isRunningAI = true
        defer { isRunningAI = false }

        let client = AnthropicClient(apiKey: apiKey, model: settings.aiModel)
        let image = (prompt.includesImage && settings.aiSendsImage) ? store.image(for: current) : nil
        let text = current.metadata.recognizedText.isEmpty
            ? current.metadata.parsedText
            : current.metadata.recognizedText

        do {
            let output = try await client.send(instruction: prompt.instruction, text: text, image: image)
            var metadata = current.metadata
            metadata.aiOutput = output
            store.update(current, metadata: metadata)
            show(.success, "AI result saved")
        } catch {
            show(.failure, error.localizedDescription)
        }
    }

    private func show(_ kind: StatusBanner.Kind, _ text: String) {
        withAnimation { banner = (kind, text) }
        Task {
            try? await Task.sleep(for: .seconds(2.5))
            withAnimation { banner = nil }
        }
    }
}
