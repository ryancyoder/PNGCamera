import AVFoundation
import Foundation
import Observation
import Speech

/// Live speech-to-text for annotating a capture right after the shutter.
@MainActor
@Observable
final class DictationController {

    enum State: Equatable {
        case idle
        case unauthorized(String)
        case listening
        case failed(String)
    }

    private(set) var state: State = .idle
    /// Transcript so far, including in-flight partial results.
    private(set) var transcript = ""

    private let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer()
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    var isListening: Bool { state == .listening }

    var isAvailable: Bool {
        recognizer?.isAvailable ?? false
    }

    func toggle() async {
        if isListening {
            stop()
        } else {
            await start()
        }
    }

    func start() async {
        guard !isListening else { return }
        guard let recognizer, recognizer.isAvailable else {
            state = .failed("Speech recognition is not available right now.")
            return
        }
        guard await requestAuthorization() else { return }

        do {
            try beginSession(with: recognizer)
            state = .listening
        } catch {
            teardown()
            state = .failed(error.localizedDescription)
        }
    }

    func stop() {
        guard isListening else { return }
        teardown()
        state = .idle
    }

    func reset() {
        stop()
        transcript = ""
        state = .idle
    }

    // MARK: - Internals

    private func requestAuthorization() async -> Bool {
        let speechStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speechStatus == .authorized else {
            state = .unauthorized("Speech recognition access is off. Enable it in Settings to dictate.")
            return false
        }

        let micGranted = await AVAudioApplication.requestRecordPermission()
        guard micGranted else {
            state = .unauthorized("Microphone access is off. Enable it in Settings to dictate.")
            return false
        }
        return true
    }

    private func beginSession(with recognizer: SFSpeechRecognizer) throws {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // Keep audio on device when the recognizer supports it.
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        self.request = request

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }

        audioEngine.prepare()
        try audioEngine.start()

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                    if result.isFinal { self.stop() }
                }
                if error != nil, self.isListening {
                    // A recognition error after speech has stopped is expected;
                    // treat it as the end of the utterance.
                    self.stop()
                }
            }
        }
    }

    private func teardown() {
        audioEngine.inputNode.removeTap(onBus: 0)
        if audioEngine.isRunning { audioEngine.stop() }
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
