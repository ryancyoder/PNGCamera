import SwiftUI

/// Edits one AI prompt preset.
@MainActor
struct PromptEditorView: View {

    @State private var prompt: AIPrompt
    private let onSave: (AIPrompt) -> Void

    @Environment(\.dismiss) private var dismiss

    init(prompt: AIPrompt, onSave: @escaping (AIPrompt) -> Void) {
        _prompt = State(initialValue: prompt)
        self.onSave = onSave
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Prompt") {
                    TextField("Name", text: $prompt.name)
                    TextField("Instruction", text: $prompt.instruction, axis: .vertical)
                        .lineLimit(4...12)
                }

                Section {
                    Toggle("Attach the capture image", isOn: $prompt.includesImage)
                } footer: {
                    Text("Turn this off for text-only prompts — it is faster and cheaper. Recognized text is always included.")
                }
            }
            .navigationTitle("Prompt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(prompt)
                        dismiss()
                    }
                    .disabled(
                        prompt.name.trimmingCharacters(in: .whitespaces).isEmpty
                            || prompt.instruction.trimmingCharacters(in: .whitespaces).isEmpty
                    )
                }
            }
        }
    }
}
