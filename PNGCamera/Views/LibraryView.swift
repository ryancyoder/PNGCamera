import SwiftUI
import UIKit

@MainActor
struct LibraryView: View {

    @Environment(CaptureStore.self) private var store

    @State private var searchText = ""
    @State private var selection: Capture?

    private let columns = [GridItem(.adaptive(minimum: 140), spacing: 12)]

    var body: some View {
        NavigationStack {
            Group {
                if store.captures.isEmpty {
                    emptyState
                } else {
                    grid
                }
            }
            .navigationTitle("Library")
            .searchable(text: $searchText, prompt: "Search text and codes")
            .toolbar {
                if !store.captures.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button(role: .destructive) {
                                store.deleteAll()
                            } label: {
                                Label("Delete all", systemImage: "trash")
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                    }
                }
            }
            .navigationDestination(item: $selection) { capture in
                CaptureDetailView(capture: capture)
            }
        }
    }

    private var filtered: [Capture] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return store.captures }
        return store.captures.filter { capture in
            let haystack = [
                capture.metadata.recognizedText,
                capture.metadata.parsedText,
                capture.metadata.dictation,
                capture.metadata.aiOutput,
                capture.metadata.barcodes.map(\.payload).joined(separator: " ")
            ].joined(separator: " ").lowercased()
            return haystack.contains(query)
        }
    }

    private var grid: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 12) {
                ForEach(filtered) { capture in
                    Button {
                        selection = capture
                    } label: {
                        tile(for: capture)
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button("Copy text", systemImage: "doc.on.doc") {
                            Clipboard.copy(text: capture.primaryText)
                        }
                        Button("Copy PNG", systemImage: "photo") {
                            if let data = store.pngData(for: capture) {
                                Clipboard.copy(pngData: data)
                            }
                        }
                        Button(role: .destructive) {
                            store.delete(capture)
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
            }
            .padding(12)
        }
    }

    private func tile(for capture: Capture) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack {
                CheckerboardBackground(squareSize: 8)
                if let image = store.image(for: capture) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .padding(6)
                }
            }
            .frame(height: 130)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            Text(capture.title)
                .font(.caption)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 6) {
                if !capture.metadata.barcodes.isEmpty {
                    Image(systemName: "barcode")
                }
                if !capture.metadata.dictation.isEmpty {
                    Image(systemName: "mic")
                }
                if !capture.metadata.aiOutput.isEmpty {
                    Image(systemName: "sparkles")
                }
                Spacer()
                Text(capture.createdAt, format: .relative(presentation: .numeric))
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No captures yet", systemImage: "square.grid.2x2")
        } description: {
            Text("Photos you save from the review screen appear here with their text, codes and notes.")
        }
    }
}
