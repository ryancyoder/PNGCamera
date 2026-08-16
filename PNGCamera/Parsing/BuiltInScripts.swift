import Foundation

/// Scripts that ship with the app. They cover the common "snap a label and get
/// something useful on the clipboard" cases; anything else is built in the
/// script editor.
enum BuiltInScripts {

    static let plainTextID = UUID(uuidString: "00000000-0000-0000-0000-0000000000A1")!

    static var all: [ParsingScript] {
        [plainText, tidyText, emails, phoneNumbers, urls, numbers, serialNumbers, firstLine, csvRow]
    }

    static var plainText: ParsingScript {
        ParsingScript(
            id: plainTextID,
            name: "Plain text",
            detail: "Copies recognized text exactly as read.",
            steps: [],
            isBuiltIn: true
        )
    }

    static var tidyText: ParsingScript {
        script(
            id: "00000000-0000-0000-0000-0000000000A2",
            name: "Tidy text",
            detail: "Trims each line, collapses runs of spaces, and drops blank lines.",
            steps: [
                ParsingStep(kind: .trimWhitespace),
                ParsingStep(kind: .collapseWhitespace),
                {
                    var step = ParsingStep(kind: .dropLinesMatching)
                    step.pattern = "^$"
                    return step
                }()
            ]
        )
    }

    static var emails: ParsingScript {
        script(
            id: "00000000-0000-0000-0000-0000000000A3",
            name: "Email addresses",
            detail: "Extracts every email address, one per line, without duplicates.",
            steps: [
                {
                    var step = ParsingStep(kind: .extractMatches)
                    step.pattern = "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"
                    step.caseInsensitive = true
                    return step
                }(),
                ParsingStep(kind: .dedupeLines)
            ]
        )
    }

    static var phoneNumbers: ParsingScript {
        script(
            id: "00000000-0000-0000-0000-0000000000A4",
            name: "Phone numbers",
            detail: "Extracts phone-number-shaped runs of digits, one per line.",
            steps: [
                {
                    var step = ParsingStep(kind: .extractMatches)
                    step.pattern = "\\+?\\d[\\d ().-]{7,}\\d"
                    return step
                }(),
                ParsingStep(kind: .trimWhitespace),
                ParsingStep(kind: .dedupeLines)
            ]
        )
    }

    static var urls: ParsingScript {
        script(
            id: "00000000-0000-0000-0000-0000000000A5",
            name: "Web addresses",
            detail: "Extracts http and https links, one per line.",
            steps: [
                {
                    var step = ParsingStep(kind: .extractMatches)
                    step.pattern = "https?://[^\\s]+"
                    step.caseInsensitive = true
                    return step
                }(),
                ParsingStep(kind: .dedupeLines)
            ]
        )
    }

    static var numbers: ParsingScript {
        script(
            id: "00000000-0000-0000-0000-0000000000A6",
            name: "Numbers only",
            detail: "Extracts every number, including decimals and thousands separators.",
            steps: [
                {
                    var step = ParsingStep(kind: .extractMatches)
                    // The lookbehind stops the hyphen in codes like INV-20481
                    // being read as a minus sign, and keeps digits that are part
                    // of an identifier (XR7) out of the results.
                    step.pattern = "(?<![A-Za-z0-9-])-?\\d+(?:,\\d{3})*(?:\\.\\d+)?"
                    return step
                }()
            ]
        )
    }

    static var serialNumbers: ParsingScript {
        script(
            id: "00000000-0000-0000-0000-0000000000A7",
            name: "Serial numbers",
            detail: "Keeps upper-case alphanumeric runs of six characters or more.",
            steps: [
                {
                    var step = ParsingStep(kind: .extractMatches)
                    step.pattern = "\\b[A-Z0-9][A-Z0-9-]{5,}\\b"
                    return step
                }(),
                ParsingStep(kind: .dedupeLines)
            ]
        )
    }

    static var firstLine: ParsingScript {
        script(
            id: "00000000-0000-0000-0000-0000000000A8",
            name: "First line",
            detail: "Copies only the first non-empty line — useful for titles and labels.",
            steps: [
                ParsingStep(kind: .trimWhitespace),
                {
                    var step = ParsingStep(kind: .dropLinesMatching)
                    step.pattern = "^$"
                    return step
                }(),
                ParsingStep(kind: .limitLines)
            ]
        )
    }

    static var csvRow: ParsingScript {
        script(
            id: "00000000-0000-0000-0000-0000000000A9",
            name: "CSV row",
            detail: "Joins every line into a single comma-separated row for spreadsheets.",
            steps: [
                ParsingStep(kind: .trimWhitespace),
                {
                    var step = ParsingStep(kind: .dropLinesMatching)
                    step.pattern = "^$"
                    return step
                }(),
                {
                    var step = ParsingStep(kind: .replaceMatches)
                    step.pattern = ","
                    step.replacement = " "
                    return step
                }(),
                {
                    var step = ParsingStep(kind: .joinLines)
                    step.separator = ","
                    return step
                }()
            ]
        )
    }

    private static func script(id: String, name: String, detail: String, steps: [ParsingStep]) -> ParsingScript {
        ParsingScript(
            id: UUID(uuidString: id) ?? UUID(),
            name: name,
            detail: detail,
            steps: steps,
            isBuiltIn: true
        )
    }
}
