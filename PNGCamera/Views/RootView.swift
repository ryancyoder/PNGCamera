import SwiftUI
import UIKit

struct RootView: View {

    @State private var selection: Tab = .capture

    enum Tab: Hashable {
        case capture, library, settings
    }

    var body: some View {
        TabView(selection: $selection) {
            CaptureView()
                .tabItem { Label("Capture", systemImage: "camera.fill") }
                .tag(Tab.capture)

            LibraryView()
                .tabItem { Label("Library", systemImage: "square.grid.2x2") }
                .tag(Tab.library)

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(Tab.settings)
        }
    }
}

/// Alternating grey squares behind a transparent image, so the user can see
/// exactly what the alpha channel is doing.
struct CheckerboardBackground: View {

    var squareSize: CGFloat = 12

    var body: some View {
        Canvas { context, size in
            let columns = Int(ceil(size.width / squareSize))
            let rows = Int(ceil(size.height / squareSize))
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(white: 0.92)))

            for row in 0..<max(rows, 1) {
                for column in 0..<max(columns, 1) where (row + column).isMultiple(of: 2) {
                    let rect = CGRect(
                        x: CGFloat(column) * squareSize,
                        y: CGFloat(row) * squareSize,
                        width: squareSize,
                        height: squareSize
                    )
                    context.fill(Path(rect), with: .color(Color(white: 0.82)))
                }
            }
        }
        .drawingGroup()
    }
}

/// Shows a transparent PNG over a checkerboard.
struct TransparencyPreview: View {

    let image: UIImage

    var body: some View {
        ZStack {
            CheckerboardBackground()
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .padding(8)
        }
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

/// A short banner used for transient success and failure messages.
struct StatusBanner: View {

    enum Kind {
        case success, failure

        var color: Color {
            switch self {
            case .success: return .green
            case .failure: return .red
            }
        }

        var symbol: String {
            switch self {
            case .success: return "checkmark.circle.fill"
            case .failure: return "exclamationmark.triangle.fill"
            }
        }
    }

    let kind: Kind
    let message: String

    var body: some View {
        Label(message, systemImage: kind.symbol)
            .font(.subheadline)
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(kind.color.opacity(0.92), in: Capsule())
            .shadow(radius: 6, y: 2)
            .transition(.move(edge: .top).combined(with: .opacity))
    }
}
