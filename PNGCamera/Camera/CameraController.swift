import AVFoundation
import CoreImage
import Foundation
import Observation
import UIKit

/// Owns the capture session and hands back oriented `CIImage`s.
@MainActor
@Observable
final class CameraController {

    enum Status: Equatable {
        case idle
        case unauthorized
        case ready
        case failed(String)
    }

    enum Failure: LocalizedError {
        case notReady
        case captureFailed(String)
        case decodeFailed

        var errorDescription: String? {
            switch self {
            case .notReady: return "The camera is not ready yet."
            case .captureFailed(let reason): return reason
            case .decodeFailed: return "The photo could not be decoded."
            }
        }
    }

    private(set) var status: Status = .idle
    private(set) var isCapturing = false
    var isFlashOn = false
    private(set) var usesFrontCamera = false
    private(set) var zoomFactor: CGFloat = 1
    private(set) var maxZoomFactor: CGFloat = 1

    /// Not isolated so the preview layer can be wired up from `makeUIView`.
    nonisolated let session = AVCaptureSession()

    private let photoOutput = AVCapturePhotoOutput()
    private let sessionQueue = DispatchQueue(label: "com.pngcamera.session")
    private var videoInput: AVCaptureDeviceInput?
    private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
    private weak var previewLayer: AVCaptureVideoPreviewLayer?

    /// Delegates are retained until their capture completes — `AVFoundation`
    /// only holds a weak reference to them.
    private var pendingCaptures: [Int64: PhotoCaptureDelegate] = [:]

    // MARK: - Lifecycle

    func prepare() async {
        guard status != .ready else { return }

        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .video) else {
                status = .unauthorized
                return
            }
        default:
            status = .unauthorized
            return
        }

        do {
            try configureSession()
            status = .ready
            start()
        } catch {
            status = .failed(error.localizedDescription)
        }
    }

    func start() {
        guard status == .ready else { return }
        sessionQueue.async { [session] in
            guard !session.isRunning else { return }
            session.startRunning()
        }
    }

    func stop() {
        sessionQueue.async { [session] in
            guard session.isRunning else { return }
            session.stopRunning()
        }
    }

    /// Called by the preview view once its layer exists so rotation can track it.
    func attach(previewLayer: AVCaptureVideoPreviewLayer) {
        self.previewLayer = previewLayer
        updateRotationCoordinator()
    }

    // MARK: - Configuration

    private func configureSession() throws {
        session.beginConfiguration()
        defer { session.commitConfiguration() }

        session.sessionPreset = .photo

        guard let device = defaultDevice(front: usesFrontCamera) else {
            throw Failure.captureFailed("No camera is available on this device.")
        }
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else {
            throw Failure.captureFailed("The camera input could not be added.")
        }
        session.addInput(input)
        videoInput = input

        guard session.canAddOutput(photoOutput) else {
            throw Failure.captureFailed("The photo output could not be added.")
        }
        session.addOutput(photoOutput)
        photoOutput.maxPhotoQualityPrioritization = .quality
        if let dimensions = device.activeFormat.supportedMaxPhotoDimensions.last {
            photoOutput.maxPhotoDimensions = dimensions
        }

        maxZoomFactor = min(device.activeFormat.videoMaxZoomFactor, 10)
        zoomFactor = device.videoZoomFactor
    }

    private func defaultDevice(front: Bool) -> AVCaptureDevice? {
        let types: [AVCaptureDevice.DeviceType] = front
            ? [.builtInWideAngleCamera]
            : [.builtInDualWideCamera, .builtInDualCamera, .builtInWideAngleCamera]
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: types,
            mediaType: .video,
            position: front ? .front : .back
        )
        return discovery.devices.first
    }

    private func updateRotationCoordinator() {
        guard let device = videoInput?.device else { return }
        rotationCoordinator = AVCaptureDevice.RotationCoordinator(
            device: device,
            previewLayer: previewLayer
        )
        applyPreviewRotation()
    }

    private func applyPreviewRotation() {
        guard let coordinator = rotationCoordinator,
              let connection = previewLayer?.connection else { return }
        let angle = coordinator.videoRotationAngleForHorizonLevelPreview
        if connection.isVideoRotationAngleSupported(angle) {
            connection.videoRotationAngle = angle
        }
    }

    // MARK: - Controls

    func switchCamera() async {
        guard status == .ready, let currentInput = videoInput else { return }
        usesFrontCamera.toggle()

        guard let device = defaultDevice(front: usesFrontCamera),
              let input = try? AVCaptureDeviceInput(device: device) else {
            usesFrontCamera.toggle()
            return
        }

        session.beginConfiguration()
        session.removeInput(currentInput)
        if session.canAddInput(input) {
            session.addInput(input)
            videoInput = input
            maxZoomFactor = min(device.activeFormat.videoMaxZoomFactor, 10)
            zoomFactor = device.videoZoomFactor
            if let dimensions = device.activeFormat.supportedMaxPhotoDimensions.last {
                photoOutput.maxPhotoDimensions = dimensions
            }
        } else {
            session.addInput(currentInput)
            usesFrontCamera.toggle()
        }
        session.commitConfiguration()

        updateRotationCoordinator()
    }

    func setZoom(_ factor: CGFloat) {
        guard let device = videoInput?.device else { return }
        let clamped = min(max(factor, 1), maxZoomFactor)
        do {
            try device.lockForConfiguration()
            device.videoZoomFactor = clamped
            device.unlockForConfiguration()
            zoomFactor = clamped
        } catch {
            // A transient lock failure only means the zoom gesture is ignored.
        }
    }

    func focus(at point: CGPoint) {
        guard let device = videoInput?.device else { return }
        do {
            try device.lockForConfiguration()
            if device.isFocusPointOfInterestSupported {
                device.focusPointOfInterest = point
                device.focusMode = device.isFocusModeSupported(.autoFocus) ? .autoFocus : .continuousAutoFocus
            }
            if device.isExposurePointOfInterestSupported {
                device.exposurePointOfInterest = point
                device.exposureMode = device.isExposureModeSupported(.autoExpose) ? .autoExpose : .continuousAutoExposure
            }
            device.unlockForConfiguration()
        } catch {
            // Focus is best-effort; ignore a failed lock.
        }
    }

    var supportsFlash: Bool {
        videoInput?.device.hasFlash ?? false
    }

    // MARK: - Capture

    func capturePhoto() async throws -> CIImage {
        guard status == .ready else { throw Failure.notReady }
        isCapturing = true
        defer { isCapturing = false }

        applyCaptureRotation()

        let settings = makePhotoSettings()
        let data: Data = try await withCheckedThrowingContinuation { continuation in
            let delegate = PhotoCaptureDelegate { [weak self] result in
                Task { @MainActor in
                    self?.pendingCaptures[settings.uniqueID] = nil
                }
                continuation.resume(with: result)
            }
            pendingCaptures[settings.uniqueID] = delegate
            photoOutput.capturePhoto(with: settings, delegate: delegate)
        }

        // `.applyOrientationProperty` bakes the EXIF orientation into the image
        // so downstream Vision requests and the PNG export agree on "up".
        guard let image = CIImage(data: data, options: [.applyOrientationProperty: true]) else {
            throw Failure.decodeFailed
        }
        return image
    }

    private func makePhotoSettings() -> AVCapturePhotoSettings {
        let settings: AVCapturePhotoSettings
        if photoOutput.availablePhotoCodecTypes.contains(.hevc) {
            settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.hevc])
        } else {
            settings = AVCapturePhotoSettings()
        }
        settings.photoQualityPrioritization = .quality
        settings.maxPhotoDimensions = photoOutput.maxPhotoDimensions
        if supportsFlash {
            settings.flashMode = isFlashOn ? .on : .off
        }
        return settings
    }

    private func applyCaptureRotation() {
        guard let connection = photoOutput.connection(with: .video) else { return }
        if let angle = rotationCoordinator?.videoRotationAngleForHorizonLevelCapture,
           connection.isVideoRotationAngleSupported(angle) {
            connection.videoRotationAngle = angle
        }
        // Front-camera photos are mirrored on screen; match what the user saw.
        if connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = usesFrontCamera
        }
    }
}

/// Bridges `AVCapturePhotoCaptureDelegate` callbacks to a single completion.
private final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {

    private let completion: (Result<Data, Error>) -> Void

    init(completion: @escaping (Result<Data, Error>) -> Void) {
        self.completion = completion
    }

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        if let error {
            completion(.failure(error))
            return
        }
        guard let data = photo.fileDataRepresentation() else {
            completion(.failure(CameraController.Failure.decodeFailed))
            return
        }
        completion(.success(data))
    }
}
