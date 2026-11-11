import Foundation

// MARK: - DOM & Pagination Models

nonisolated struct ClutterCandidate: Codable, Equatable, Sendable {
    let selector: String
    let tagName: String
    let position: String
    let zIndex: String
    let rectSummary: String
    let textSnippet: String
    let ariaLabel: String
    let id: String
    let className: String
}

nonisolated struct DOMSummaryInput: Codable, Equatable, Sendable {
    let url: String
    let domain: String
    let candidates: [ClutterCandidate]
}

nonisolated struct ClutterSelectorsResult: Codable, Equatable, Sendable {
    let selectors: [String]
}

nonisolated struct PageLinkCandidate: Codable, Equatable, Sendable {
    let text: String
    let href: String
    let rel: String
    let ariaLabel: String
    let className: String
}

nonisolated struct PageNavigationContext: Codable, Equatable, Sendable {
    let url: String
    let title: String
    let relNextURL: String?
    let links: [PageLinkCandidate]
}

nonisolated struct NextPageResult: Codable, Equatable, Sendable {
    let nextPageURL: String?
    let confidence: Double?

    enum CodingKeys: String, CodingKey {
        case nextPageURL = "next_page_url"
        case confidence
    }
}

// MARK: - CSS Selector Sanitizer

nonisolated enum CSSSelectorSanitizer {
    static let maxSelectors = 30
    private static let maxSelectorLength = 240

    private static let blockedBareTags: Set<String> = [
        "*", ":root", "html", "body", "head", "main", "article", "section",
        "header", "footer", "nav", "aside", "div", "span", "p", "a",
        "img", "picture", "figure", "video", "canvas", "svg",
        "h1", "h2", "h3", "h4", "h5", "h6",
        "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
        "form", "button", "input", "textarea", "select", "label",
        "script", "style", "link", "meta", "iframe"
    ]

    private static let blockedRootSubjects: Set<String> = [
        "*", ":root", "html", "body", "head", "main", "article"
    ]

    private static let forbiddenSubstrings: [String] = [
        "{", "}", ";", "<", ">", "`", "@", "/*", "*/", "\n", "\r", "\0"
    ]

    static func sanitize(_ selectors: [String], maxCount: Int = maxSelectors) -> [String] {
        let cap = max(0, maxCount)
        guard cap > 0 else { return [] }

        var result: [String] = []
        var seen = Set<String>()

        for raw in selectors {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard isValid(trimmed), !seen.contains(trimmed) else {
                continue
            }
            seen.insert(trimmed)
            result.append(trimmed)
            if result.count >= cap {
                break
            }
        }
        return result
    }

    static func isValid(_ rawSelector: String) -> Bool {
        let trimmed = rawSelector.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= maxSelectorLength else {
            return false
        }

        for forbidden in forbiddenSubstrings where trimmed.contains(forbidden) {
            return false
        }

        guard hasBalancedDelimiters(trimmed) else {
            return false
        }

        let branches = splitTopLevelCommaBranches(trimmed)
        guard !branches.isEmpty else {
            return false
        }

        for branch in branches {
            let sub = branch.trimmingCharacters(in: .whitespacesAndNewlines)
            guard isValidSingleBranch(sub) else {
                return false
            }
        }
        return true
    }

    private static func isValidSingleBranch(_ branch: String) -> Bool {
        guard !branch.isEmpty else { return false }
        let lowered = branch.lowercased()

        if blockedBareTags.contains(lowered) {
            return false
        }

        let hasQualifier = branch.contains("#") || branch.contains(".") || branch.contains("[")
        if !hasQualifier {
            // Allow only valid custom hyphenated element tags (e.g., amp-ad, amp-sticky-ad).
            let isCustomElement = lowered.contains("-")
                && lowered.first?.isLetter == true
                && lowered.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" }
            if !isCustomElement {
                return false
            }
        }

        // Prevent hiding document/main containers even when qualified with a class/attribute.
        let subject = extractRightmostCompound(from: lowered)
        let subjectTag = extractLeadingTagOrPseudoRoot(from: subject)
        if !subjectTag.isEmpty && blockedRootSubjects.contains(subjectTag) {
            return false
        }

        return true
    }

    private static func hasBalancedDelimiters(_ selector: String) -> Bool {
        var squareDepth = 0
        var parenDepth = 0
        var activeQuote: Character?
        var escaped = false

        for ch in selector {
            if escaped {
                escaped = false
                continue
            }
            if ch == "\\" {
                escaped = true
                continue
            }
            if let quote = activeQuote {
                if ch == quote {
                    activeQuote = nil
                }
                continue
            }
            if ch == "\"" || ch == "'" {
                activeQuote = ch
                continue
            }
            switch ch {
            case "[": squareDepth += 1
            case "]":
                squareDepth -= 1
                if squareDepth < 0 { return false }
            case "(": parenDepth += 1
            case ")":
                parenDepth -= 1
                if parenDepth < 0 { return false }
            default:
                break
            }
        }

        return activeQuote == nil && squareDepth == 0 && parenDepth == 0
    }

    private static func splitTopLevelCommaBranches(_ selector: String) -> [String] {
        var branches: [String] = []
        var current = ""
        var squareDepth = 0
        var parenDepth = 0
        var activeQuote: Character?
        var escaped = false

        for ch in selector {
            if escaped {
                current.append(ch)
                escaped = false
                continue
            }
            if ch == "\\" {
                current.append(ch)
                escaped = true
                continue
            }
            if let quote = activeQuote {
                current.append(ch)
                if ch == quote {
                    activeQuote = nil
                }
                continue
            }
            if ch == "\"" || ch == "'" {
                activeQuote = ch
                current.append(ch)
                continue
            }
            if ch == "[" { squareDepth += 1 }
            else if ch == "]" { squareDepth = max(0, squareDepth - 1) }
            else if ch == "(" { parenDepth += 1 }
            else if ch == ")" { parenDepth = max(0, parenDepth - 1) }

            if ch == "," && squareDepth == 0 && parenDepth == 0 {
                branches.append(current)
                current = ""
            } else {
                current.append(ch)
            }
        }
        branches.append(current)
        return branches
    }

    private static func extractRightmostCompound(from selector: String) -> String {
        var lastSegment = ""
        var squareDepth = 0
        var parenDepth = 0
        var activeQuote: Character?
        var escaped = false

        for ch in selector {
            if escaped {
                lastSegment.append(ch)
                escaped = false
                continue
            }
            if ch == "\\" {
                lastSegment.append(ch)
                escaped = true
                continue
            }
            if let quote = activeQuote {
                lastSegment.append(ch)
                if ch == quote {
                    activeQuote = nil
                }
                continue
            }
            if ch == "\"" || ch == "'" {
                activeQuote = ch
                lastSegment.append(ch)
                continue
            }
            if ch == "[" { squareDepth += 1 }
            else if ch == "]" { squareDepth = max(0, squareDepth - 1) }
            else if ch == "(" { parenDepth += 1 }
            else if ch == ")" { parenDepth = max(0, parenDepth - 1) }

            if squareDepth == 0 && parenDepth == 0 && (ch.isWhitespace || ch == "+" || ch == "~") {
                lastSegment = ""
            } else {
                lastSegment.append(ch)
            }
        }

        return lastSegment.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func extractLeadingTagOrPseudoRoot(from compound: String) -> String {
        if compound.hasPrefix(":root") {
            return ":root"
        }
        if compound.hasPrefix("*") {
            return "*"
        }
        var tag = ""
        for ch in compound {
            if ch == "." || ch == "#" || ch == "[" || ch == ":" {
                break
            }
            tag.append(ch)
        }
        return tag
    }
}

// MARK: - Domain Selector Cache

nonisolated final class DomainSelectorCache: @unchecked Sendable {
    static let defaultTTL: TimeInterval = 7 * 24 * 60 * 60
    static let defaultMaxDomains: Int = 100

    private nonisolated struct CacheEntry: Codable, Equatable, Sendable {
        let selectors: [String]
        let updatedAt: Date
    }

    private let defaults: UserDefaults
    private let storageKey: String
    private let ttl: TimeInterval
    private let maxDomains: Int
    private let nowProvider: @Sendable () -> Date
    private let lock = NSLock()

    init(
        defaults: UserDefaults = .standard,
        storageKey: String = "stitch.domainSelectorCache",
        ttl: TimeInterval = DomainSelectorCache.defaultTTL,
        maxDomains: Int = DomainSelectorCache.defaultMaxDomains,
        nowProvider: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.defaults = defaults
        self.storageKey = storageKey
        self.ttl = ttl
        self.maxDomains = max(1, maxDomains)
        self.nowProvider = nowProvider
    }

    func selectors(for domain: String) -> [String]? {
        let normalized = domain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return nil }
        lock.lock()
        defer { lock.unlock() }
        var map = loadEntriesLocked()
        guard let entry = map[normalized] else {
            return nil
        }
        let sanitized = CSSSelectorSanitizer.sanitize(entry.selectors)
        guard !sanitized.isEmpty else {
            map.removeValue(forKey: normalized)
            persistEntriesLocked(map)
            return nil
        }
        return sanitized
    }

    func save(selectors: [String], for domain: String) {
        let normalized = domain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return }

        let sanitized = CSSSelectorSanitizer.sanitize(selectors)
        guard !sanitized.isEmpty else { return }

        lock.lock()
        defer { lock.unlock() }
        var map = loadEntriesLocked()
        map[normalized] = CacheEntry(selectors: sanitized, updatedAt: nowProvider())

        if map.count > maxDomains {
            let sortedKeys = map
                .sorted { $0.value.updatedAt > $1.value.updatedAt }
                .prefix(maxDomains)
                .map(\.key)
            let allowed = Set(sortedKeys)
            map = map.filter { allowed.contains($0.key) }
        }

        persistEntriesLocked(map)
    }

    var cachedDomainCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return loadEntriesLocked().count
    }

    func clearAll() {
        lock.lock()
        defer { lock.unlock() }
        defaults.removeObject(forKey: storageKey)
    }

    private func loadEntriesLocked() -> [String: CacheEntry] {
        guard let data = defaults.data(forKey: storageKey) else {
            return [:]
        }

        let now = nowProvider()

        if let decoded = try? JSONDecoder().decode([String: CacheEntry].self, from: data) {
            var valid: [String: CacheEntry] = [:]
            var didPrune = false

            for (rawDomain, entry) in decoded {
                let domain = rawDomain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let age = now.timeIntervalSince(entry.updatedAt)
                let sanitized = CSSSelectorSanitizer.sanitize(entry.selectors)
                if !domain.isEmpty && age <= ttl && !sanitized.isEmpty {
                    valid[domain] = CacheEntry(selectors: sanitized, updatedAt: entry.updatedAt)
                    if sanitized != entry.selectors || domain != rawDomain {
                        didPrune = true
                    }
                } else {
                    didPrune = true
                }
            }

            if valid.count > maxDomains {
                let allowed = Set(
                    valid.sorted { $0.value.updatedAt > $1.value.updatedAt }
                        .prefix(maxDomains)
                        .map(\.key)
                )
                valid = valid.filter { allowed.contains($0.key) }
                didPrune = true
            }

            if didPrune {
                persistEntriesLocked(valid)
            }
            return valid
        }

        // Backward compatibility for legacy `[String: [String]]` cache format.
        if let legacy = try? JSONDecoder().decode([String: [String]].self, from: data) {
            var migrated: [String: CacheEntry] = [:]
            for (rawDomain, rawSelectors) in legacy {
                let domain = rawDomain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let sanitized = CSSSelectorSanitizer.sanitize(rawSelectors)
                if !domain.isEmpty && !sanitized.isEmpty {
                    migrated[domain] = CacheEntry(selectors: sanitized, updatedAt: now)
                }
            }
            if migrated.count > maxDomains {
                let allowed = Set(migrated.keys.sorted().prefix(maxDomains))
                migrated = migrated.filter { allowed.contains($0.key) }
            }
            persistEntriesLocked(migrated)
            return migrated
        }

        return [:]
    }

    private func persistEntriesLocked(_ entries: [String: CacheEntry]) {
        if entries.isEmpty {
            defaults.removeObject(forKey: storageKey)
            return
        }
        if let encoded = try? JSONEncoder().encode(entries) {
            defaults.set(encoded, forKey: storageKey)
        }
    }
}

// MARK: - Pagination Heuristic Fallback

nonisolated enum PaginationHeuristic {
    private static let positivePhrases: [[String]] = [
        ["next"],
        ["next", "page"],
        ["older"],
        ["older", "posts"],
        ["continue", "reading"],
        ["forward"],
        ["page", "suivante"],
        ["suivante"],
        ["nächste"],
        ["siguiente"]
    ]

    private static let exactSymbols: Set<String> = [">", ">>", "›", "»", "→"]

    private static let hardNegativeLabelPhrases: [[String]] = [
        ["prev"],
        ["previous"],
        ["newer"]
    ]

    private static let softNegativeLabelPhrases: [[String]] = [
        ["back"],
        ["first"],
        ["login"],
        ["sign", "in"],
        ["log", "in"],
        ["register"],
        ["share"],
        ["comment"],
        ["comments"],
        ["reply"],
        ["home"],
        ["top"]
    ]

    static func findNextPageURL(in context: PageNavigationContext) -> URL? {
        guard let currentURL = URL(string: context.url) else { return nil }
        let currentKey = canonicalPageKey(currentURL)

        if let relNext = context.relNextURL,
           let resolved = resolveValidPageURL(relNext, relativeTo: currentURL),
           canonicalPageKey(resolved) != currentKey {
            return resolved
        }

        let currentPageNumber = extractPageNumber(from: currentURL)
        var bestCandidate: (url: URL, score: Int)?

        for link in context.links {
            guard let resolved = resolveValidPageURL(link.href, relativeTo: currentURL),
                  canonicalPageKey(resolved) != currentKey
            else {
                continue
            }

            // Stay on same host whenever possible for multi-page articles.
            if let currentHost = currentURL.host?.lowercased(),
               let targetHost = resolved.host?.lowercased(),
               currentHost != targetHost {
                continue
            }

            let trimmedText = link.text.trimmingCharacters(in: .whitespacesAndNewlines)
            let labelTokens = tokenize("\(link.text) \(link.ariaLabel)")
            let ariaTokens = tokenize(link.ariaLabel)
            let relTokens = tokenize(link.rel)
            let classTokens = tokenize(link.className)

            let hasExplicitNextToken = relTokens.contains("next")
                || labelTokens.contains("next")
                || classTokens.contains("next")

            if (relTokens.contains("prev") || relTokens.contains("previous")) && !relTokens.contains("next") {
                continue
            }

            if (classTokens.contains("prev") || classTokens.contains("previous")) && !classTokens.contains("next") {
                continue
            }

            if hardNegativeLabelPhrases.contains(where: { containsPhrase(labelTokens, phrase: $0) }) && !relTokens.contains("next") {
                continue
            }

            if !hasExplicitNextToken && softNegativeLabelPhrases.contains(where: { containsPhrase(labelTokens, phrase: $0) }) {
                continue
            }

            var score = 0
            if relTokens.contains("next") {
                score += 100
            }
            if positivePhrases.contains(where: { containsPhrase(labelTokens, phrase: $0) }) {
                score += 60
            }
            if exactSymbols.contains(trimmedText) {
                score += 50
            }
            if let currentPageNumber,
               let targetPageNumber = extractPageNumber(from: resolved) {
                if targetPageNumber == currentPageNumber + 1 {
                    score += 80
                } else if targetPageNumber <= currentPageNumber {
                    score -= 60
                }
            } else if currentPageNumber == nil,
                      let targetPageNumber = extractPageNumber(from: resolved),
                      targetPageNumber == 2 {
                let currentBase = currentURL.path.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                let targetPath = resolved.path.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                if trimmedText == "2" || hasExplicitNextToken || (!currentBase.isEmpty && targetPath.hasPrefix(currentBase)) {
                    score += 55
                }
            }
            if classTokens.contains("next") || ariaTokens.contains("next") {
                score += 35
            }

            if score >= 35 {
                if bestCandidate == nil || score > bestCandidate!.score {
                    bestCandidate = (resolved, score)
                }
            }
        }

        return bestCandidate?.url
    }

    static func resolveValidPageURL(_ href: String, relativeTo baseURL: URL) -> URL? {
        let trimmed = href.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              !trimmed.hasPrefix("#"),
              !trimmed.lowercased().hasPrefix("javascript:"),
              !trimmed.lowercased().hasPrefix("mailto:"),
              !trimmed.lowercased().hasPrefix("tel:"),
              let resolved = URL(string: trimmed, relativeTo: baseURL)?.absoluteURL,
              let scheme = resolved.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else {
            return nil
        }
        return resolved
    }

    static func canonicalPageKey(_ url: URL) -> String {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: true)
        components?.fragment = nil
        return (components?.string ?? url.absoluteString).lowercased()
    }

    static func extractPageNumber(from url: URL) -> Int? {
        if let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let queryItems = components.queryItems {
            for name in ["page", "p", "pg", "paged", "pagenum"] {
                if let val = queryItems.first(where: { $0.name.lowercased() == name })?.value,
                   let number = Int(val), number >= 1 {
                    return number
                }
            }
        }

        let pathComponents = url.pathComponents
        for (idx, part) in pathComponents.enumerated() {
            let lowered = part.lowercased()
            if ["page", "pages", "p", "pg"].contains(lowered), idx + 1 < pathComponents.count {
                let rawNext = stripPathExtension(pathComponents[idx + 1])
                if let number = Int(rawNext), number >= 1 {
                    return number
                }
            }
        }

        for part in pathComponents.reversed() {
            let stem = stripPathExtension(part).lowercased()
            if let number = extractHyphenatedPageSuffix(from: stem) {
                return number
            }
        }

        return nil
    }

    private static func stripPathExtension(_ component: String) -> String {
        if let dot = component.lastIndex(of: "."), dot > component.startIndex {
            return String(component[..<dot])
        }
        return component
    }

    private static func extractHyphenatedPageSuffix(from stem: String) -> Int? {
        // Matches `page-2`, `article-page-2`, `story_page_2`, `post-pg-3`, `post-p-2`
        let parts = stem.split { $0 == "-" || $0 == "_" }.map(String.init)
        guard parts.count >= 2,
              let last = parts.last,
              let number = Int(last),
              number >= 1
        else {
            return nil
        }
        let marker = parts[parts.count - 2]
        if marker == "page" || marker == "pages" || marker == "pg" {
            return number
        }
        return nil
    }

    private static func tokenize(_ input: String) -> [String] {
        input.lowercased()
            .split { !$0.isLetter && !$0.isNumber }
            .map(String.init)
    }

    private static func containsPhrase(_ tokens: [String], phrase: [String]) -> Bool {
        guard !phrase.isEmpty, tokens.count >= phrase.count else { return false }
        if phrase.count == 1 {
            return tokens.contains(phrase[0])
        }
        let limit = tokens.count - phrase.count
        for start in 0...limit {
            if Array(tokens[start..<(start + phrase.count)]) == phrase {
                return true
            }
        }
        return false
    }
}

// MARK: - Gemini Interactions API Service

nonisolated enum GeminiServiceError: Error, LocalizedError, Equatable {
    case missingAPIKey
    case invalidEndpoint
    case httpError(statusCode: Int, message: String)
    case emptyModelOutput
    case decodingFailed(String)

    var errorDescription: String? {
        switch self {
        case .missingAPIKey:
            return "No Gemini API key configured."
        case .invalidEndpoint:
            return "Invalid Gemini Interactions API endpoint."
        case .httpError(let statusCode, let message):
            return "Gemini API error (\(statusCode)): \(message)"
        case .emptyModelOutput:
            return "Gemini returned no output text."
        case .decodingFailed(let detail):
            return "Failed to decode Gemini response: \(detail)"
        }
    }
}

nonisolated protocol HTTPTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

nonisolated struct URLSessionHTTPTransport: HTTPTransport {
    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try await session.data(for: request)
    }
}

/// JSON value helper for encoding strict JSON Schema dictionaries in Interactions API payloads.
nonisolated enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else if let array = try? container.decode([JSONValue].self) {
            self = .array(array)
        } else if let object = try? container.decode([String: JSONValue].self) {
            self = .object(object)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let s): try container.encode(s)
        case .number(let n): try container.encode(n)
        case .bool(let b): try container.encode(b)
        case .object(let o): try container.encode(o)
        case .array(let a): try container.encode(a)
        case .null: try container.encodeNil()
        }
    }
}

nonisolated struct GeminiInteractionsRequest: Codable, Equatable, Sendable {
    nonisolated struct ResponseFormat: Codable, Equatable, Sendable {
        let type: String
        let mimeType: String
        let schema: [String: JSONValue]

        init(
            type: String = "text",
            mimeType: String = "application/json",
            schema: [String: JSONValue]
        ) {
            self.type = type
            self.mimeType = mimeType
            self.schema = schema
        }

        enum CodingKeys: String, CodingKey {
            case type
            case mimeType = "mime_type"
            case schema
        }
    }

    let model: String
    let input: String
    let responseFormat: ResponseFormat

    enum CodingKeys: String, CodingKey {
        case model
        case input
        case responseFormat = "response_format"
    }
}

/// Decodes Interactions API responses from `steps` (`model_output` -> `content`) and defensive `outputs` fallback.
nonisolated struct GeminiInteractionsResponse: Decodable, Sendable {
    let id: String?
    let status: String?
    let steps: [Step]?
    let outputs: [OutputItem]?

    nonisolated struct Step: Decodable, Sendable {
        let type: String?
        let content: StepContent?
    }

    nonisolated enum StepContent: Decodable, Sendable {
        case text(String)
        case parts([ContentPart])

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let text = try? container.decode(String.self) {
                self = .text(text)
                return
            }
            if let parts = try? container.decode([ContentPart].self) {
                self = .parts(parts)
                return
            }
            self = .text("")
        }

        var extractedText: String? {
            switch self {
            case .text(let value):
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            case .parts(let parts):
                let joined = parts
                    .filter { $0.type == "text" || $0.type == nil }
                    .compactMap(\.text)
                    .joined(separator: "\n")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                return joined.isEmpty ? nil : joined
            }
        }
    }

    nonisolated struct ContentPart: Decodable, Sendable {
        let type: String?
        let text: String?
    }

    nonisolated struct OutputItem: Decodable, Sendable {
        let type: String?
        let text: String?
        let content: StepContent?

        private enum CodingKeys: String, CodingKey {
            case type
            case text
            case content
        }

        init(from decoder: Decoder) throws {
            if let singleValue = try? decoder.singleValueContainer(),
               let plainString = try? singleValue.decode(String.self) {
                self.type = "text"
                self.text = plainString
                self.content = nil
                return
            }

            let container = try decoder.container(keyedBy: CodingKeys.self)
            self.type = try container.decodeIfPresent(String.self, forKey: .type)
            self.text = try container.decodeIfPresent(String.self, forKey: .text)
            self.content = try container.decodeIfPresent(StepContent.self, forKey: .content)
        }

        var extractedText: String? {
            if let type, type != "text" && type != "model_output" {
                return nil
            }
            if let text {
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    return trimmed
                }
            }
            return content?.extractedText
        }
    }

    func extractModelOutputText() -> String? {
        if let steps {
            for step in steps.reversed() {
                if step.type == "model_output" || step.type == nil,
                   let text = step.content?.extractedText {
                    return text
                }
            }
        }
        if let outputs {
            for item in outputs.reversed() {
                if let text = item.extractedText {
                    return text
                }
            }
        }
        return nil
    }
}

/// Client for Gemini `gemini-3.8-flash` via Interactions API (`POST /v1beta/interactions`).
nonisolated final class GeminiService: Sendable {
    static let endpointURL = URL(string: "https://generativelanguage.googleapis.com/v1beta/interactions")!
    static let modelName = "gemini-3.8-flash"
    static let apiRevision = "2026-05-20"

    private let transport: HTTPTransport
    private let keychain: KeychainStoring
    private let selectorCache: DomainSelectorCache

    init(
        transport: HTTPTransport = URLSessionHTTPTransport(),
        keychain: KeychainStoring = KeychainService(),
        selectorCache: DomainSelectorCache = DomainSelectorCache()
    ) {
        self.transport = transport
        self.keychain = keychain
        self.selectorCache = selectorCache
    }

    func detectClutterSelectors(domSummary: DOMSummaryInput) async throws -> [String] {
        if let cached = selectorCache.selectors(for: domSummary.domain) {
            return cached
        }

        guard let apiKey = keychain.loadAPIKey(), !apiKey.isEmpty else {
            throw GeminiServiceError.missingAPIKey
        }
        guard !domSummary.candidates.isEmpty else {
            return []
        }

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let candidatesJSON = String(data: try encoder.encode(domSummary), encoding: .utf8) ?? "{}"

        let prompt = """
        Analyze these DOM element candidates from webpage \(domSummary.url).
        Identify specific CSS selectors for UI clutter and advertisements that should be hidden before taking a clean full-page screenshot:
        1. Fixed/sticky overlays, cookie consent banners, GDPR/CMP popups, newsletter signups, floating chat widgets, app install banners, and sticky promo/header/footer bars.
        2. Inline/in-between article ad containers, ad slots/wrappers, and sponsored recommendation widgets (e.g., Google/DFP ads, Taboola, Outbrain, "Advertisement" or "Sponsored" blocks) appearing within or around the article body.
        Do NOT hide primary article prose, headings, legitimate embeds, or bare HTML structural tags (such as body, main, article, section, div, header).
        DOM summary JSON:
        \(candidatesJSON)
        """

        let schema: [String: JSONValue] = [
            "type": .string("object"),
            "properties": .object([
                "selectors": .object([
                    "type": .string("array"),
                    "items": .object(["type": .string("string")])
                ])
            ]),
            "required": .array([.string("selectors")]),
            "additionalProperties": .bool(false)
        ]

        let result: ClutterSelectorsResult = try await executeStructuredInteraction(
            prompt: prompt,
            responseFormat: schema,
            apiKey: apiKey
        )

        let sanitized = CSSSelectorSanitizer.sanitize(result.selectors)
        if !sanitized.isEmpty {
            selectorCache.save(selectors: sanitized, for: domSummary.domain)
        }
        return sanitized
    }

    func detectNextPageURL(pageContext: PageNavigationContext) async throws -> URL? {
        guard let apiKey = keychain.loadAPIKey(), !apiKey.isEmpty else {
            throw GeminiServiceError.missingAPIKey
        }
        guard let baseURL = URL(string: pageContext.url) else {
            return nil
        }
        if pageContext.relNextURL == nil && pageContext.links.isEmpty {
            return nil
        }

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let contextJSON = String(data: try encoder.encode(pageContext), encoding: .utf8) ?? "{}"

        let prompt = """
        Given the current article/page URL and candidate navigation links below, identify the single next-page URL for multi-page article pagination (e.g. Page 2, Next, Older, Continue Reading).
        Only choose a URL from relNextURL or the provided candidate links. Return null for next_page_url if there is no clear next page of the same article or list.
        Page context JSON:
        \(contextJSON)
        """

        let schema: [String: JSONValue] = [
            "type": .string("object"),
            "properties": .object([
                "next_page_url": .object([
                    "type": .array([.string("string"), .string("null")])
                ]),
                "confidence": .object([
                    "type": .string("number")
                ])
            ]),
            "required": .array([.string("next_page_url"), .string("confidence")]),
            "additionalProperties": .bool(false)
        ]

        let result: NextPageResult = try await executeStructuredInteraction(
            prompt: prompt,
            responseFormat: schema,
            apiKey: apiKey
        )

        if let confidence = result.confidence, (confidence.isNaN || confidence < 0.45) {
            return nil
        }

        guard let rawURL = result.nextPageURL,
              let resolved = PaginationHeuristic.resolveValidPageURL(rawURL, relativeTo: baseURL)
        else {
            return nil
        }

        let currentKey = PaginationHeuristic.canonicalPageKey(baseURL)
        let resolvedKey = PaginationHeuristic.canonicalPageKey(resolved)
        guard resolvedKey != currentKey else {
            return nil
        }

        var allowedKeys = Set<String>()
        if let relNext = pageContext.relNextURL,
           let resolvedRel = PaginationHeuristic.resolveValidPageURL(relNext, relativeTo: baseURL) {
            allowedKeys.insert(PaginationHeuristic.canonicalPageKey(resolvedRel))
        }
        for candidate in pageContext.links {
            if let resolvedCandidate = PaginationHeuristic.resolveValidPageURL(candidate.href, relativeTo: baseURL) {
                allowedKeys.insert(PaginationHeuristic.canonicalPageKey(resolvedCandidate))
            }
        }

        guard allowedKeys.contains(resolvedKey) else {
            return nil
        }

        return resolved
    }

    func buildRequest(prompt: String, responseFormat schema: [String: JSONValue], apiKey: String) throws -> URLRequest {
        let payload = GeminiInteractionsRequest(
            model: Self.modelName,
            input: prompt,
            responseFormat: GeminiInteractionsRequest.ResponseFormat(
                type: "text",
                mimeType: "application/json",
                schema: schema
            )
        )

        var request = URLRequest(url: Self.endpointURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
        request.setValue(Self.apiRevision, forHTTPHeaderField: "Api-Revision")
        request.httpBody = try JSONEncoder().encode(payload)
        return request
    }

    func decodeStructuredOutput<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let interaction = try JSONDecoder().decode(GeminiInteractionsResponse.self, from: data)
        guard let rawText = interaction.extractModelOutputText() else {
            throw GeminiServiceError.emptyModelOutput
        }
        let cleaned = stripMarkdownCodeFences(rawText)
        guard let jsonData = cleaned.data(using: .utf8) else {
            throw GeminiServiceError.decodingFailed("Non-UTF8 JSON text")
        }
        do {
            return try JSONDecoder().decode(T.self, from: jsonData)
        } catch {
            throw GeminiServiceError.decodingFailed(error.localizedDescription)
        }
    }

    private func executeStructuredInteraction<T: Decodable>(
        prompt: String,
        responseFormat schema: [String: JSONValue],
        apiKey: String
    ) async throws -> T {
        let request = try buildRequest(prompt: prompt, responseFormat: schema, apiKey: apiKey)
        let (data, response) = try await transport.data(for: request)

        if let httpResponse = response as? HTTPURLResponse,
           !(200..<300).contains(httpResponse.statusCode) {
            let bodyMessage = String(data: data, encoding: .utf8) ?? "Unknown error"
            throw GeminiServiceError.httpError(statusCode: httpResponse.statusCode, message: bodyMessage)
        }

        return try decodeStructuredOutput(T.self, from: data)
    }

    private func stripMarkdownCodeFences(_ text: String) -> String {
        var result = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if result.hasPrefix("```") {
            if let firstNewline = result.firstIndex(of: "\n") {
                result = String(result[result.index(after: firstNewline)...])
            }
            if result.hasSuffix("```") {
                result = String(result.dropLast(3))
            }
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
