import Foundation

/// Applies a `ParsingScript` to a string.
///
/// Every step is total: a malformed regular expression leaves the text
/// unchanged rather than throwing, so a bad pattern in one step never discards
/// a capture's text. Pattern problems surface in the editor's live preview via
/// `validate(_:)` instead.
enum ParsingEngine {

    static func run(_ script: ParsingScript, on input: String) -> String {
        script.steps.reduce(input) { text, step in apply(step, to: text) }
    }

    static func apply(_ step: ParsingStep, to text: String) -> String {
        switch step.kind {
        case .trimWhitespace:
            return mapLines(text) { $0.trimmingCharacters(in: .whitespaces) }

        case .collapseWhitespace:
            return mapLines(text) { line in
                line.split(whereSeparator: { $0 == " " || $0 == "\t" })
                    .joined(separator: " ")
            }

        case .keepLinesMatching:
            guard let regex = makeRegex(step) else { return text }
            return filterLines(text) { matches(regex, $0) }

        case .dropLinesMatching:
            guard let regex = makeRegex(step) else { return text }
            return filterLines(text) { !matches(regex, $0) }

        case .extractMatches:
            guard let regex = makeRegex(step) else { return text }
            let range = NSRange(text.startIndex..<text.endIndex, in: text)
            let values = regex.matches(in: text, options: [], range: range).compactMap { match -> String? in
                let index = min(max(step.group, 0), match.numberOfRanges - 1)
                guard let captured = Range(match.range(at: index), in: text) else { return nil }
                return String(text[captured])
            }
            return values.joined(separator: "\n")

        case .replaceMatches:
            guard let regex = makeRegex(step) else { return text }
            let range = NSRange(text.startIndex..<text.endIndex, in: text)
            return regex.stringByReplacingMatches(
                in: text,
                options: [],
                range: range,
                withTemplate: step.replacement
            )

        case .removeCharacters:
            guard !step.characters.isEmpty else { return text }
            let removal = CharacterSet(charactersIn: step.characters)
            return String(text.unicodeScalars.filter { !removal.contains($0) })

        case .changeCase:
            return step.uppercase ? text.uppercased() : text.lowercased()

        case .dedupeLines:
            var seen = Set<String>()
            return filterLines(text) { seen.insert($0).inserted }

        case .sortLines:
            let sorted = lines(of: text).sorted {
                let comparison = $0.localizedStandardCompare($1)
                return step.ascending ? comparison == .orderedAscending : comparison == .orderedDescending
            }
            return sorted.joined(separator: "\n")

        case .limitLines:
            let limit = max(step.count, 0)
            return lines(of: text).prefix(limit).joined(separator: "\n")

        case .joinLines:
            return lines(of: text).joined(separator: unescape(step.separator))

        case .wrap:
            return unescape(step.prefix) + text + unescape(step.suffix)

        case .template:
            return unescape(step.template).replacingOccurrences(of: "{{text}}", with: text)
        }
    }

    /// Returns a human-readable problem with the step, or `nil` if it is valid.
    static func validate(_ step: ParsingStep) -> String? {
        guard step.kind.fields.contains(.pattern) else { return nil }
        if step.pattern.isEmpty { return "Enter a regular expression." }
        do {
            _ = try NSRegularExpression(pattern: step.pattern, options: regexOptions(step))
            return nil
        } catch {
            return "Invalid regular expression."
        }
    }

    // MARK: - Helpers

    private static func makeRegex(_ step: ParsingStep) -> NSRegularExpression? {
        guard !step.pattern.isEmpty else { return nil }
        return try? NSRegularExpression(pattern: step.pattern, options: regexOptions(step))
    }

    private static func regexOptions(_ step: ParsingStep) -> NSRegularExpression.Options {
        step.caseInsensitive ? [.caseInsensitive] : []
    }

    private static func matches(_ regex: NSRegularExpression, _ line: String) -> Bool {
        let range = NSRange(line.startIndex..<line.endIndex, in: line)
        return regex.firstMatch(in: line, options: [], range: range) != nil
    }

    private static func lines(of text: String) -> [String] {
        text.components(separatedBy: .newlines)
    }

    private static func mapLines(_ text: String, _ transform: (String) -> String) -> String {
        lines(of: text).map(transform).joined(separator: "\n")
    }

    private static func filterLines(_ text: String, _ isIncluded: (String) -> Bool) -> String {
        lines(of: text).filter(isIncluded).joined(separator: "\n")
    }

    /// Lets separators and templates be typed with escape sequences in a plain
    /// text field.
    private static func unescape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\n", with: "\n")
            .replacingOccurrences(of: "\\t", with: "\t")
    }
}
