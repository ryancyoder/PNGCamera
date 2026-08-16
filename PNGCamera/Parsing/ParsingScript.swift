import Foundation

/// A single transformation applied to recognized text.
///
/// Steps are modelled as a struct with a `kind` discriminator rather than an
/// enum with associated values so the editor UI can bind directly to the
/// parameter fields without unwrapping cases.
struct ParsingStep: Codable, Hashable, Identifiable {

    enum Kind: String, Codable, CaseIterable, Identifiable {
        case trimWhitespace
        case collapseWhitespace
        case keepLinesMatching
        case dropLinesMatching
        case extractMatches
        case replaceMatches
        case removeCharacters
        case changeCase
        case dedupeLines
        case sortLines
        case limitLines
        case joinLines
        case wrap
        case template

        var id: String { rawValue }

        var title: String {
            switch self {
            case .trimWhitespace: return "Trim whitespace"
            case .collapseWhitespace: return "Collapse whitespace"
            case .keepLinesMatching: return "Keep lines matching"
            case .dropLinesMatching: return "Drop lines matching"
            case .extractMatches: return "Extract matches"
            case .replaceMatches: return "Find and replace"
            case .removeCharacters: return "Remove characters"
            case .changeCase: return "Change case"
            case .dedupeLines: return "Remove duplicate lines"
            case .sortLines: return "Sort lines"
            case .limitLines: return "Limit lines"
            case .joinLines: return "Join lines"
            case .wrap: return "Add prefix and suffix"
            case .template: return "Apply template"
            }
        }

        var summary: String {
            switch self {
            case .trimWhitespace: return "Trims leading and trailing whitespace from every line."
            case .collapseWhitespace: return "Collapses runs of spaces and tabs into a single space."
            case .keepLinesMatching: return "Keeps only lines matching the regular expression."
            case .dropLinesMatching: return "Removes lines matching the regular expression."
            case .extractMatches: return "Outputs each regular expression match, one per line."
            case .replaceMatches: return "Replaces matches with a template ($1 refers to group 1)."
            case .removeCharacters: return "Deletes every character listed."
            case .changeCase: return "Converts the text to upper or lower case."
            case .dedupeLines: return "Removes repeated lines, keeping the first occurrence."
            case .sortLines: return "Sorts lines alphabetically."
            case .limitLines: return "Keeps at most the given number of lines."
            case .joinLines: return "Joins all lines with the separator."
            case .wrap: return "Adds text before and after the result."
            case .template: return "Substitutes the result into a template using {{text}}."
            }
        }

        /// Which parameter fields the editor should show for this kind.
        var fields: Set<Field> {
            switch self {
            case .trimWhitespace, .collapseWhitespace, .dedupeLines:
                return []
            case .keepLinesMatching, .dropLinesMatching:
                return [.pattern, .caseInsensitive]
            case .extractMatches:
                return [.pattern, .group, .caseInsensitive]
            case .replaceMatches:
                return [.pattern, .replacement, .caseInsensitive]
            case .removeCharacters:
                return [.characters]
            case .changeCase:
                return [.uppercase]
            case .sortLines:
                return [.ascending]
            case .limitLines:
                return [.count]
            case .joinLines:
                return [.separator]
            case .wrap:
                return [.prefix, .suffix]
            case .template:
                return [.template]
            }
        }
    }

    enum Field: Hashable {
        case pattern, replacement, group, separator, characters, count
        case prefix, suffix, template, caseInsensitive, ascending, uppercase
    }

    var id: UUID = UUID()
    var kind: Kind
    var pattern: String = ""
    var replacement: String = ""
    var characters: String = ""
    var separator: String = "\n"
    var prefix: String = ""
    var suffix: String = ""
    var template: String = "{{text}}"
    var group: Int = 0
    var count: Int = 1
    var caseInsensitive: Bool = false
    var ascending: Bool = true
    var uppercase: Bool = true

    init(kind: Kind) {
        self.kind = kind
    }
}

/// An ordered list of steps that turns recognized text into the text placed on
/// the clipboard.
struct ParsingScript: Codable, Hashable, Identifiable {
    var id: UUID = UUID()
    var name: String
    var detail: String
    var steps: [ParsingStep]
    /// Built-in scripts ship with the app and cannot be deleted, only duplicated.
    var isBuiltIn: Bool = false

    init(id: UUID = UUID(), name: String, detail: String, steps: [ParsingStep], isBuiltIn: Bool = false) {
        self.id = id
        self.name = name
        self.detail = detail
        self.steps = steps
        self.isBuiltIn = isBuiltIn
    }

    func duplicated() -> ParsingScript {
        ParsingScript(name: "\(name) copy", detail: detail, steps: steps, isBuiltIn: false)
    }
}
