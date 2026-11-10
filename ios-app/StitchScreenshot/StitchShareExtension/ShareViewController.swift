import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private let cardView = UIView()
    private let titleLabel = UILabel()
    private let urlLabel = UILabel()
    private let statusLabel = UILabel()
    private let openButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)

    private var deepLinkURL: URL?

    override func viewDidLoad() {
        super.viewDidLoad()
        configureUI()
        extractSharedURL()
    }

    private func configureUI() {
        view.backgroundColor = UIColor.black.withAlphaComponent(0.35)

        cardView.translatesAutoresizingMaskIntoConstraints = false
        cardView.backgroundColor = .systemBackground
        cardView.layer.cornerRadius = 16
        cardView.layer.shadowColor = UIColor.black.cgColor
        cardView.layer.shadowOpacity = 0.18
        cardView.layer.shadowRadius = 14
        cardView.layer.shadowOffset = CGSize(width: 0, height: 6)
        view.addSubview(cardView)

        titleLabel.text = "StitchScreenshot"
        titleLabel.font = .preferredFont(forTextStyle: .headline)
        titleLabel.textAlignment = .center

        urlLabel.text = "Reading shared link..."
        urlLabel.font = .preferredFont(forTextStyle: .footnote)
        urlLabel.textColor = .secondaryLabel
        urlLabel.numberOfLines = 3
        urlLabel.textAlignment = .center

        statusLabel.text = ""
        statusLabel.font = .preferredFont(forTextStyle: .caption1)
        statusLabel.textColor = .tertiaryLabel
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 2

        var openConfig = UIButton.Configuration.filled()
        openConfig.title = "Open in StitchScreenshot"
        openConfig.cornerStyle = .medium
        openButton.configuration = openConfig
        openButton.isEnabled = false
        openButton.addTarget(self, action: #selector(didTapOpen), for: .touchUpInside)

        var cancelConfig = UIButton.Configuration.plain()
        cancelConfig.title = "Cancel"
        cancelButton.configuration = cancelConfig
        cancelButton.addTarget(self, action: #selector(didTapCancel), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [
            titleLabel,
            urlLabel,
            statusLabel,
            openButton,
            cancelButton
        ])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        cardView.addSubview(stack)

        NSLayoutConstraint.activate([
            cardView.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            cardView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            cardView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),

            stack.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: cardView.bottomAnchor, constant: -16),
            stack.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -20)
        ])
    }

    private func extractSharedURL() {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem] else {
            showNoURLFound()
            return
        }

        let providers = items.compactMap(\.attachments).flatMap { $0 }

        if let urlProvider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }) {
            urlProvider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { [weak self] item, _ in
                DispatchQueue.main.async {
                    if let url = item as? URL, self?.isSupportedWebURL(url) == true {
                        self?.handleResolvedURL(url)
                    } else if let text = item as? String, let extracted = self?.extractWebURL(from: text) {
                        self?.handleResolvedURL(extracted)
                    } else {
                        self?.tryExtractFromTextProviders(providers)
                    }
                }
            }
            return
        }

        tryExtractFromTextProviders(providers)
    }

    private func tryExtractFromTextProviders(_ providers: [NSItemProvider]) {
        guard let textProvider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) }) else {
            showNoURLFound()
            return
        }

        textProvider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { [weak self] item, _ in
            DispatchQueue.main.async {
                if let text = item as? String, let url = self?.extractWebURL(from: text) {
                    self?.handleResolvedURL(url)
                } else {
                    self?.showNoURLFound()
                }
            }
        }
    }

    private func handleResolvedURL(_ sharedURL: URL) {
        urlLabel.text = sharedURL.absoluteString
        guard let deepLink = buildDeepLink(for: sharedURL) else {
            showNoURLFound()
            return
        }

        deepLinkURL = deepLink
        openButton.isEnabled = true
        statusLabel.text = "Handing off to StitchScreenshot..."
        openHostApp(with: deepLink)
    }

    private func showNoURLFound() {
        urlLabel.text = "No webpage URL found in shared item."
        statusLabel.text = "Share a Safari/browser webpage link to capture it."
        openButton.isEnabled = false
    }

    @objc private func didTapOpen() {
        guard let deepLinkURL else { return }
        openHostApp(with: deepLinkURL)
    }

    @objc private func didTapCancel() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }

    private func openHostApp(with url: URL) {
        var responder: UIResponder? = self
        while let current = responder {
            if let application = current as? UIApplication {
                application.open(url, options: [:]) { [weak self] success in
                    DispatchQueue.main.async {
                        if success {
                            self?.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
                        } else {
                            self?.statusLabel.text = "Tap 'Open in StitchScreenshot' to continue."
                        }
                    }
                }
                return
            }
            responder = current.next
        }

        statusLabel.text = "Tap 'Open in StitchScreenshot' to continue."
    }

    private func buildDeepLink(for targetURL: URL) -> URL? {
        var components = URLComponents()
        components.scheme = "stitchscreenshot"
        components.host = "capture"
        components.queryItems = [URLQueryItem(name: "url", value: targetURL.absoluteString)]
        return components.url
    }

    private func isSupportedWebURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }

    private func extractWebURL(from text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let direct = URL(string: trimmed), isSupportedWebURL(direct) {
            return direct
        }
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return nil
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        for match in detector.matches(in: text, options: [], range: range) {
            if let url = match.url, isSupportedWebURL(url) {
                return url
            }
        }
        return nil
    }
}
