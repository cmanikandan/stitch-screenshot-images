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

// MARK: - Domain Selector Cache

nonisolated final class DomainSelectorCache: @unchecked Sendable {
    private let defaults: UserDefaults
    private let storageKey: String
    private let lock = NSLock()

    init(
        defaults: UserDefaults = .standard,
        storageKey: String = "stitch.domainSelectorCache"
    ) {
        self.defaults = defaults
        self.storageKey = storageKey
    }

    func selectors(for domain: String) -> [String]? {
        let normalized = domain.lowercased()
        lock.lock()
        defer { lock.unlock() }
        let map = loadMapLocked()
        return map[normalized]
    }

    func save(selectors: [String], for domain: String) {
        let normalized = domain.lowercased()
        guard !normalized.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        var map = loadMapLocked()
        map[normalized] = selectors
        if let encoded = try? JSONEncoder().encode(map) {
            defaults.set(encoded, forKey: storageKey)
        }
    }

    var cachedDomainCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return loadMapLocked().count
    }

    func clearAll() {
        lock.lock()
        defer { lock.unlock() }
        defaults.removeObject(forKey: storageKey)
    }

    private func loadMapLocked() -> [String: [String]] {
        guard let data = defaults.data(forKey: storageKey),
              let map = try? JSONDecoder().decode([String: [String]].self, from: data)
        else {
            return [:]
        }
        return map
    }
}

// MARK: - Pagination Heuristic Fallback

nonisolated enum PaginationHeuristic {
    private static let positiveTokens = [
        "next", "next page", "older", "older posts", "continue reading",
        "forward", "page suivante", "nächste", "siguiente"
    ]
    private static let exactSymbols: Set<String> = [">", ">>", "›", "»", "→"]
    private static let negativeTokens = [
        "prev", "previous", "back", "newer", "first", "login", "sign in",
        "register", "share", "comment", "reply", "home", "top"
    ]

    static func findNextPageURL(in context: PageNavigationContext) -> URL? {
        guard let currentURL = URL(string: context.url) else { return nil }

        if let relNext = context.relNextURL,
           let resolved = resolveValidPageURL(relNext, relativeTo: currentURL),
           resolved.absoluteString != currentURL.absoluteString {
            return resolved
        }

        let currentPageNumber = extractPageNumber(from: currentURL)
        var bestCandidate: (url: URL, score: Int)?

        for link in context.links {
            guard let resolved = resolveValidPageURL(link.href, relativeTo: currentURL),
                  resolved.absoluteString != currentURL.absoluteString
            else {
                continue
            }

            // Stay on same host whenever possible for multi-page articles.
            if let currentHost = currentURL.host?.lowercased(),
               let targetHost = resolved.host?.lowercased(),
               currentHost != targetHost {
                continue
            }

            let combined = "\(link.text) \(link.ariaLabel) \(link.className) \(link.rel)"
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            let trimmedText = link.text.trimmingCharacters(in: .whitespacesAndNewlines)

            if negativeTokens.contains(where: { combined.contains($0) }) {
                continue
            }

            var score = 0
            if link.rel.lowercased().split(separator: " ").contains("next") {
                score += 100
            }
            if positiveTokens.contains(where: { combined.contains($0) }) {
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
                    score -= 40
                }
            }
            if link.className.lowercased().contains("next") || link.ariaLabel.lowercased().contains("next") {
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
              let resolved = URL(string: trimmed, relativeTo: baseURL)?.absoluteURL,
              let scheme = resolved.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else {
            return nil
        }
        return resolved
    }

    static func extractPageNumber(from url: URL) -> Int? {
        if let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let queryItems = components.queryItems {
            for name in ["page", "p", "pg", "paged"] {
                if let val = queryItems.first(where: { $0.name.lowercased() == name })?.value,
                   let number = Int(val), number >= 1 {
                    return number
                }
            }
        }

        let pathComponents = url.pathComponents
        for (idx, part) in pathComponents.enumerated() {
            if part.lowercased() == "page", idx + 1 < pathComponents.count,
               let number = Int(pathComponents[idx + 1]), number >= 1 {
                return number
            }
        }
        return nil
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
    let model: String
    let input: String
    let responseFormat: [String: JSONValue]
    let generationConfig: GenerationConfig

    struct GenerationConfig: Codable, Equatable, Sendable {
        let temperature: Double
    }

    enum CodingKeys: String, CodingKey {
        case model
        case input
        case responseFormat = "response_format"
        case generationConfig = "generation_config"
    }
}

/// Decodes Interactions API responses from `steps` (`model_output` -> `content`) and defensive `outputs` fallback.
nonisolated struct GeminiInteractionsResponse: Decodable, Sendable {
    let id: String?
    let status: String?
    let steps: [Step]?
    let outputs: [OutputItem]?

    struct Step: Decodable, Sendable {
        let type: String?
        let content: StepContent?
    }

    enum StepContent: Decodable, Sendable {
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
                let joined = parts.compactMap(\.text).joined(separator: "\n")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                return joined.isEmpty ? nil : joined
            }
        }
    }

    struct ContentPart: Decodable, Sendable {
        let type: String?
        let text: String?
    }

    struct OutputItem: Decodable, Sendable {
        let type: String?
        let text: String?
        let content: StepContent?

        var extractedText: String? {
            if let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return text.trimmingCharacters(in: .whitespacesAndNewlines)
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
        Analyze these fixed/sticky/overlay DOM element candidates from webpage \(domSummary.url).
        Identify CSS selectors for UI clutter that should be hidden before taking a clean full-page screenshot (e.g., cookie consent banners, GDPR popups, newsletter signups, floating chat widgets, sticky header/footer bars, app install banners).
        Do NOT hide primary article content or main page containers.
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

        let sanitized = result.selectors
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        selectorCache.save(selectors: sanitized, for: domSummary.domain)
        return sanitized
    }

    func detectNextPageURL(pageContext: PageNavigationContext) async throws -> URL? {
        guard let apiKey = keychain.loadAPIKey(), !apiKey.isEmpty else {
            throw GeminiServiceError.missingAPIKey
        }
        guard let baseURL = URL(string: pageContext.url) else {
            return nil
        }

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let contextJSON = String(data: try encoder.encode(pageContext), encoding: .utf8) ?? "{}"

        let prompt = """
        Given the current article/page URL and candidate navigation links below, identify the single next-page URL for multi-page article pagination (e.g. Page 2, Next, Older, Continue Reading).
        Return null for next_page_url if there is no clear next page of the same article or list.
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

        guard let rawURL = result.nextPageURL else {
            return nil
        }
        return PaginationHeuristic.resolveValidPageURL(rawURL, relativeTo: baseURL)
    }

    func buildRequest(prompt: String, responseFormat: [String: JSONValue], apiKey: String) throws -> URLRequest {
        let payload = GeminiInteractionsRequest(
            model: Self.modelName,
            input: prompt,
            responseFormat: responseFormat,
            generationConfig: .init(temperature: 0.1)
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
        responseFormat: [String: JSONValue],
        apiKey: String
    ) async throws -> T {
        let request = try buildRequest(prompt: prompt, responseFormat: responseFormat, apiKey: apiKey)
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
