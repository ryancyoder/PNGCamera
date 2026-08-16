import SwiftUI

/// Builds and previews a parsing script: an ordered list of text
/// transformations applied to whatever the camera reads.
@MainActor
struct ScriptEditorView: View {

    @State private var script: ParsingScript
    @State private var sampleInput: String
    private let onSave: (ParsingScript) -> Void

    @Environment(\.dismiss) private var dismiss

    init(script: ParsingScript, onSave: @escaping (ParsingScript) -> Void) {
        // A built-in opened for editing becomes a user copy; built-ins stay pristine.
        _script = State(initialValue: script.isBuiltIn ? script.duplicated() : script)
        _sampleInput = State(initialValue: Self.defaultSample)
        self.onSave = onSave
    }

    private static let defaultSample = """
    ACME Industrial Supply
    Invoice #INV-20481
    ship@acme-supply.com
    Order total: 1,284.50
    Serial: XR7-99120-B
    """

    var body: some View {
        NavigationStack {
            Form {
                Section("Script") {
                    TextField("Name", text: $script.name)
                    TextField("Description", text: $script.detail, axis: .vertical)
                        .lineLimit(1...3)
                }

                Section {
                    if script.steps.isEmpty {
                        Text("No steps yet — the text is copied unchanged.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    ForEach($script.steps) { $step in
                        StepEditor(step: $step)
                    }
                    .onDelete { script.steps.remove(atOffsets: $0) }
                    .onMove { script.steps.move(fromOffsets: $0, toOffset: $1) }

                    Menu("Add step") {
                        ForEach(ParsingStep.Kind.allCases) { kind in
                            Button(kind.title) { script.steps.append(ParsingStep(kind: kind)) }
                        }
                    }
                } header: {
                    Text("Steps")
                } footer: {
                    Text("Steps run top to bottom. Drag to reorder, swipe to delete.")
                }

                Section("Test") {
                    TextEditor(text: $sampleInput)
                        .font(.callout.monospaced())
                        .frame(minHeight: 100)

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Result").font(.caption).foregroundStyle(.secondary)
                        Text(result.isEmpty ? "(empty)" : result)
                            .font(.callout.monospaced())
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .navigationTitle(script.name.isEmpty ? "Script" : script.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(script)
                        dismiss()
                    }
                    .disabled(script.name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                ToolbarItem(placement: .topBarLeading) {
                    EditButton()
                }
            }
        }
    }

    private var result: String {
        ParsingEngine.run(script, on: sampleInput)
    }
}

/// Row that edits one step, showing only the fields its kind uses.
@MainActor
private struct StepEditor: View {

    @Binding var step: ParsingStep

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Step", selection: $step.kind) {
                ForEach(ParsingStep.Kind.allCases) { kind in
                    Text(kind.title).tag(kind)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .frame(maxWidth: .infinity, alignment: .leading)

            Text(step.kind.summary)
                .font(.caption)
                .foregroundStyle(.secondary)

            let fields = step.kind.fields

            if fields.contains(.pattern) {
                TextField("Regular expression", text: $step.pattern)
                    .font(.callout.monospaced())
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                if let problem = ParsingEngine.validate(step) {
                    Text(problem).font(.caption).foregroundStyle(.red)
                }
            }
            if fields.contains(.replacement) {
                TextField("Replacement (use $1 for group 1)", text: $step.replacement)
                    .font(.callout.monospaced())
                    .autocorrectionDisabled()
            }
            if fields.contains(.group) {
                Stepper("Capture group: \(step.group)", value: $step.group, in: 0...9)
            }
            if fields.contains(.characters) {
                TextField("Characters to remove", text: $step.characters)
                    .font(.callout.monospaced())
                    .autocorrectionDisabled()
            }
            if fields.contains(.separator) {
                TextField("Separator (\\n and \\t allowed)", text: $step.separator)
                    .font(.callout.monospaced())
                    .autocorrectionDisabled()
            }
            if fields.contains(.count) {
                Stepper("Keep \(step.count) line\(step.count == 1 ? "" : "s")", value: $step.count, in: 1...200)
            }
            if fields.contains(.prefix) {
                TextField("Prefix", text: $step.prefix)
                    .font(.callout.monospaced())
            }
            if fields.contains(.suffix) {
                TextField("Suffix", text: $step.suffix)
                    .font(.callout.monospaced())
            }
            if fields.contains(.template) {
                TextField("Template with {{text}}", text: $step.template, axis: .vertical)
                    .font(.callout.monospaced())
                    .lineLimit(1...4)
            }
            if fields.contains(.caseInsensitive) {
                Toggle("Ignore case", isOn: $step.caseInsensitive)
            }
            if fields.contains(.ascending) {
                Toggle("Ascending", isOn: $step.ascending)
            }
            if fields.contains(.uppercase) {
                Toggle("Upper case", isOn: $step.uppercase)
            }
        }
        .padding(.vertical, 4)
    }
}
