import AVFoundation
import SwiftUI

/// SwiftUI wrapper around `AVCaptureVideoPreviewLayer`.
struct CameraPreview: UIViewRepresentable {

    let controller: CameraController
    /// Reports a tap in normalized device coordinates for focus.
    var onFocusTap: (CGPoint) -> Void

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = controller.session
        view.previewLayer.videoGravity = .resizeAspectFill
        view.onTap = { location in
            let point = view.previewLayer.captureDevicePointConverted(fromLayerPoint: location)
            onFocusTap(point)
        }
        controller.attach(previewLayer: view.previewLayer)
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}

    final class PreviewView: UIView {
        override static var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

        var previewLayer: AVCaptureVideoPreviewLayer {
            // Safe: `layerClass` guarantees the type.
            layer as! AVCaptureVideoPreviewLayer
        }

        var onTap: ((CGPoint) -> Void)?

        override init(frame: CGRect) {
            super.init(frame: frame)
            backgroundColor = .black
            let recognizer = UITapGestureRecognizer(target: self, action: #selector(handleTap))
            addGestureRecognizer(recognizer)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        @objc private func handleTap(_ recognizer: UITapGestureRecognizer) {
            onTap?(recognizer.location(in: self))
        }
    }
}
