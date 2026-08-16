import CoreImage
import SwiftUI
import UIKit

@MainActor
struct CaptureView: View {

    @Environment(AppSettings.self) private var settings
    @Environment(\.scenePhase) private var scenePhase

    @State private var camera = CameraController()
    @State private var processor = CaptureProcessor()
    @State private var processed: ProcessedCapture?
    @State private var errorMessage: String?
    @State private var banner: String?
    @State private var zoomBase: CGFloat = 1

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            switch camera.status {
            case .ready:
                cameraSurface
            case .unauthorized:
                permissionPrompt
            case .failed(let reason):
                message(title: "Camera unavailable", detail: reason)
            case .idle:
                ProgressView().tint(.white)
            }

            if processor.isWorking {
                processingOverlay
            }

            if let banner {
                VStack {
                    StatusBanner(kind: .success, message: banner)
                        .padding(.top, 8)
                    Spacer()
                }
            }
        }
        .task { await camera.prepare() }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: camera.start()
            case .background, .inactive: camera.stop()
            @unknown default: break
            }
        }
        .fullScreenCover(isPresented: isReviewing) {
            ReviewView(capture: $processed, processor: processor)
        }
        .alert("Capture failed", isPresented: .constant(errorMessage != nil)) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private var isReviewing: Binding<Bool> {
        Binding(
            get: { processed != nil },
            set: { if !$0 { processed = nil } }
        )
    }

    // MARK: - Camera surface

    private var cameraSurface: some View {
        ZStack {
            CameraPreview(controller: camera) { point in
                camera.focus(at: point)
            }
            .ignoresSafeArea()
            .gesture(
                MagnifyGesture()
                    .onChanged { value in camera.setZoom(zoomBase * value.magnification) }
                    .onEnded { _ in zoomBase = camera.zoomFactor }
            )

            VStack {
                topBar
                Spacer()
                bottomBar
            }
        }
    }

    private var topBar: some View {
        HStack(spacing: 16) {
            if camera.supportsFlash {
                Button {
                    camera.isFlashOn.toggle()
                } label: {
                    controlIcon(camera.isFlashOn ? "bolt.fill" : "bolt.slash.fill", active: camera.isFlashOn)
                }
                .accessibilityLabel(camera.isFlashOn ? "Turn flash off" : "Turn flash on")
            }

            Spacer()

            scriptMenu

            Button {
                Task { await camera.switchCamera() }
            } label: {
                controlIcon("arrow.triangle.2.circlepath.camera")
            }
            .accessibilityLabel("Switch camera")
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
    }

    private var scriptMenu: some View {
        @Bindable var settings = settings
        return Menu {
            Picker("Parsing script", selection: $settings.selectedScriptID) {
                ForEach(settings.allScripts) { script in
                    Text(script.name).tag(script.id)
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "text.viewfinder")
                Text(settings.selectedScript.name)
                    .lineLimit(1)
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.black.opacity(0.45), in: Capsule())
        }
    }

    private var bottomBar: some View {
        @Bindable var settings = settings
        return VStack(spacing: 18) {
            HStack(spacing: 10) {
                toggleChip("Cutout", systemImage: "person.and.background.dotted", isOn: $settings.removeBackground)
                toggleChip("Text", systemImage: "text.viewfinder", isOn: $settings.recognizeText)
                toggleChip("Codes", systemImage: "barcode.viewfinder", isOn: $settings.scanBarcodes)
                if settings.aiEnabled {
                    toggleChip("AI", systemImage: "sparkles", isOn: $settings.aiRunsAutomatically)
                }
            }

            Button(action: capture) {
                ZStack {
                    Circle()
                        .strokeBorder(.white, lineWidth: 4)
                        .frame(width: 78, height: 78)
                    Circle()
                        .fill(.white)
                        .frame(width: 64, height: 64)
                }
            }
            .disabled(camera.isCapturing || processor.isWorking)
            .accessibilityLabel("Take photo")
        }
        .padding(.bottom, 24)
    }

    private func toggleChip(_ title: String, systemImage: String, isOn: Binding<Bool>) -> some View {
        Button {
            isOn.wrappedValue.toggle()
        } label: {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.semibold))
                .labelStyle(.titleAndIcon)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .foregroundStyle(isOn.wrappedValue ? Color.black : Color.white)
                .background(
                    isOn.wrappedValue ? AnyShapeStyle(Color.white) : AnyShapeStyle(Color.black.opacity(0.45)),
                    in: Capsule()
                )
        }
        .accessibilityAddTraits(isOn.wrappedValue ? [.isSelected] : [])
    }

    private func controlIcon(_ systemName: String, active: Bool = false) -> some View {
        Image(systemName: systemName)
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(active ? Color.yellow : Color.white)
            .frame(width: 40, height: 40)
            .background(.black.opacity(0.45), in: Circle())
    }

    // MARK: - Overlays

    private var processingOverlay: some View {
        ZStack {
            Color.black.opacity(0.55).ignoresSafeArea()
            VStack(spacing: 14) {
                ProgressView().controlSize(.large).tint(.white)
                Text(processor.stage.message)
                    .font(.subheadline)
                    .foregroundStyle(.white)
            }
            .padding(28)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .transition(.opacity)
    }

    private var permissionPrompt: some View {
        VStack(spacing: 16) {
            Image(systemName: "camera.metering.unknown")
                .font(.system(size: 44))
                .foregroundStyle(.white)
            Text("Camera access is off")
                .font(.headline)
                .foregroundStyle(.white)
            Text("PNG Camera needs the camera to take pictures.")
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.8))
                .multilineTextAlignment(.center)
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(32)
    }

    private func message(title: String, detail: String) -> some View {
        VStack(spacing: 10) {
            Text(title).font(.headline).foregroundStyle(.white)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(.white.opacity(0.8))
                .multilineTextAlignment(.center)
        }
        .padding(32)
    }

    // MARK: - Actions

    private func capture() {
        Task {
            do {
                let original = try await camera.capturePhoto()
                let result = try await processor.process(original, settings: settings)

                if settings.copyTextAutomatically || settings.copyImageAutomatically {
                    copyToClipboard(result)
                }
                if settings.saveToPhotoLibrary {
                    try? await PhotoLibrarySaver.save(pngData: result.pngData)
                }
                // Any pipeline warnings are surfaced in the review screen.
                processed = result
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func copyToClipboard(_ capture: ProcessedCapture) {
        let text = capture.metadata.parsedText.isEmpty
            ? capture.metadata.recognizedText
            : capture.metadata.parsedText

        switch (settings.copyTextAutomatically && !text.isEmpty, settings.copyImageAutomatically) {
        case (true, true):
            Clipboard.copy(text: text, pngData: capture.pngData)
            show(banner: "Text and image copied")
        case (true, false):
            Clipboard.copy(text: text)
            show(banner: "Text copied")
        case (false, true):
            Clipboard.copy(pngData: capture.pngData)
            show(banner: "Image copied")
        case (false, false):
            break
        }
    }

    private func show(banner message: String) {
        withAnimation { banner = message }
        Task {
            try? await Task.sleep(for: .seconds(2))
            withAnimation { banner = nil }
        }
    }
}
