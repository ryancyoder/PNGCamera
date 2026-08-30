# PNG Camera

An iPhone and iPad camera app that photographs a subject, removes the
background on device, and gives you a **transparent PNG** plus everything it
could read off the frame — text, barcodes, a dictated note, and optionally a
result from the Anthropic API.

## What it does

**Capture → cutout.** `VNGenerateForegroundInstanceMaskRequest` isolates the
subject and the rest of the frame becomes transparent. If no distinct subject
is found the app falls back to person segmentation, and if that also fails it
keeps the full frame and tells you why.

**Text recognition.** Vision reads the frame, results are sorted into reading
order (rows top-to-bottom, left-to-right within a row), and the text is copied
to the clipboard.

**Parsing scripts.** Recognized text runs through an ordered list of steps
before it reaches the clipboard — extract every email, keep only the total,
join everything into a CSV row, and so on. Nine scripts ship with the app and
you can build your own in the editor, which previews the result live against
sample text.

**Barcodes.** Every symbology the OS supports is detected, deduplicated, and
optionally folded into the text the script parses. Tap any code to copy it.

**Dictation.** Optionally starts recording the moment the review screen opens,
so you can say what the picture is while you're still holding it. On-device
recognition is used where the device supports it.

**AI processing (optional).** Sends the cutout and/or the recognized text to
the Anthropic Messages API with a prompt you pick — clean up OCR errors,
extract fields as JSON, summarize, write alt text, translate. Off by default;
nothing leaves the device until you turn it on and add a key.

**Metadata.** The extracted text is written into the PNG itself as `iTXt`
chunks, so the file carries its own text wherever it goes. Standard
`Description` / `Software` / `Creation Time` keywords plus app-specific
`PNGCamera:*` keys, including a JSON payload the app can read back.

## Requirements

- Xcode 16 or later
- iOS / iPadOS 17.0 or later
- A physical device — the camera, Vision segmentation, and dictation do not
  work in the Simulator

## Building

```sh
open PNGCamera.xcodeproj
```

Set your team under *Signing & Capabilities* (the bundle identifier defaults to
`com.example.PNGCamera`) and run on a device.

The project uses Xcode 16 file-system-synchronized groups, so files added under
`PNGCamera/` are picked up without editing the project file. `project.yml` is an
equivalent [XcodeGen](https://github.com/yonaskolb/XcodeGen) spec if you ever
need to regenerate the project (`xcodegen generate`).

## Layout

```
PNGCamera/
├── App/          App entry point
├── Core/         Settings persistence, keychain
├── Camera/       AVCaptureSession, SwiftUI preview layer
├── Vision/       Background removal, text recognition, barcodes
├── Imaging/      PNG encoding and text-chunk read/write
├── Parsing/      Script model, engine, built-in scripts
├── AI/           Anthropic Messages API client, prompt presets
├── Dictation/    Speech recognition
├── Store/        On-disk capture library
├── Pipeline/     Capture orchestration, clipboard, Photos
└── Views/        SwiftUI screens
```

The pipeline lives in `Pipeline/CaptureProcessor.swift`: background removal →
text recognition → barcode scan → parsing → PNG encode. Vision failures become
warnings shown on the review screen rather than discarding the photo.

## Parsing scripts

A script is an ordered list of steps applied to the recognized text. Available
steps: trim and collapse whitespace, keep or drop lines matching a regular
expression, extract matches (with a capture group), find and replace, remove
characters, change case, deduplicate, sort, limit, join, wrap with a prefix and
suffix, and substitute into a `{{text}}` template.

Built-ins: Plain text, Tidy text, Email addresses, Phone numbers, Web
addresses, Numbers only, Serial numbers, First line, CSV row.

A malformed regular expression leaves the text unchanged rather than throwing,
so a bad pattern can never lose a capture's text. The editor flags the problem
instead.

## PNG metadata

Text is stored as uncompressed `iTXt` chunks inserted immediately after `IHDR`.
`iTXt` rather than `tEXt` because recognized text is frequently not Latin-1.

| Keyword | Contents |
| --- | --- |
| `Description` | Parsed text, or recognized text if no script ran |
| `Software` | `PNG Camera` |
| `Creation Time` | ISO 8601 timestamp |
| `PNGCamera:RecognizedText` | Raw OCR output |
| `PNGCamera:ParsedText` | Script output |
| `PNGCamera:Barcodes` | `SYMBOLOGY: payload` per line |
| `PNGCamera:Dictation` | Dictated note |
| `PNGCamera:AIOutput` | AI result |
| `PNGCamera:JSON` | The whole thing as JSON |

Read them with any PNG tool, e.g. `exiftool -Description image.png`.

## AI processing

Settings → AI processing. Paste an [Anthropic API
key](https://console.anthropic.com/); it is stored in the keychain
(`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), never in a
backup-visible file.

Requests go to `POST /v1/messages` over HTTPS. The image is downscaled to a
2048px long edge before upload. `stop_reason` is checked before the response
content is read, and server-side fallbacks are enabled so a policy decline is
re-served by Anthropic's recommended fallback model rather than failing the
request.

Models offered: Claude Opus 5 (default), Claude Sonnet 5, Claude Haiku 4.5.

## Privacy

Everything except AI processing runs on device. Captures are stored in the
app's Application Support directory and are only shared when you share them.
Camera, microphone, speech recognition, and photo-library-add permissions are
each requested at the point they are first used.

## Perspective Elevation Ruler

`PerspectiveElevationRuler/` holds a separate, self-contained web app: an
iPad-friendly tool that projects an elevation ruler into a perspective
photograph. You mark two points whose elevations and separation you know, and
it solves for the camera and draws elevation increments back onto the picture
through a real 3D projection, valid along one line of sight.

It shares nothing with the iOS target — no dependencies, no build step — so it
does not affect the Xcode project. See
[`PerspectiveElevationRuler/README.md`](PerspectiveElevationRuler/README.md).

## Planned features

- **Pre-loaded shape masks.** Crop the capture into a predefined shape —
  circle, rounded square, ellipse, hexagon, badge, banner, and similar — instead
  of (or on top of) the subject cutout. The shape mask would multiply into the
  existing alpha channel, so a circular crop of a cutout keeps the transparent
  background outside the subject as well as outside the circle. Ships with a
  built-in shape set, picked from the capture screen alongside the parsing
  script and previewed live over the checkerboard, with an aspect-fit or
  aspect-fill choice for how the frame maps into the shape.

## Known limitations

- Subject isolation quality is whatever Vision produces; there is no manual
  refine-edge tool yet.
- Dictation transcripts are not diarized or punctuated beyond what the speech
  recognizer provides.
- The AI client does not stream, so long responses wait for the full reply
  (the 120s request timeout is the ceiling).
