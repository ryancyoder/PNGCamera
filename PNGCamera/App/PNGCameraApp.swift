import SwiftUI

@main
@MainActor
struct PNGCameraApp: App {

    @State private var settings = AppSettings()
    @State private var store = CaptureStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(settings)
                .environment(store)
                .tint(.accentColor)
        }
    }
}
