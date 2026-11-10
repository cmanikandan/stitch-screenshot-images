import SwiftUI

/// Settings sheet for optional Gemini Keychain API key, export format, decluttering, and cache management.
struct SettingsView: View {
    @Bindable var settings: AppSettingsStore

    @Environment(\.dismiss) private var dismiss
    @State private var apiKeyInput: String = ""
    @State private var hasStoredKey: Bool = false
    @State private var cachedDomainCount: Int = 0
    @State private var feedbackMessage: String?

    private let keychain = KeychainService()
    private let selectorCache = DomainSelectorCache()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Image(systemName: hasStoredKey ? "checkmark.shield.fill" : "key")
                            .foregroundStyle(hasStoredKey ? .green : .secondary)
                        Text(hasStoredKey ? "Gemini API key stored in Keychain" : "No API key stored (optional)")
                            .font(.subheadline)
                    }

                    SecureField("Paste Gemini API key", text: $apiKeyInput)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    HStack {
                        Button("Save Key") {
                            saveAPIKey()
                        }
                        .disabled(apiKeyInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                        Spacer()

                        if hasStoredKey {
                            Button("Remove Key", role: .destructive) {
                                deleteAPIKey()
                            }
                        }
                    }
                } header: {
                    Text("Gemini AI (gemini-3.8-flash)")
                } footer: {
                    Text("Optional. Stored securely in iOS Keychain and used via Gemini Interactions API for smart clutter selector detection and multi-page next-link detection.")
                }

                Section("Image Output") {
                    Picker("Default Format", selection: $settings.outputFormat) {
                        ForEach(ImageExportFormat.allCases) { format in
                            Text(format.displayName).tag(format)
                        }
                    }

                    if settings.outputFormat == .jpeg {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text("JPEG Quality")
                                Spacer()
                                Text("\(Int(round(settings.jpegQuality * 100)))%")
                                    .foregroundStyle(.secondary)
                                    .monospacedDigit()
                            }
                            Slider(value: $settings.jpegQuality, in: 0.5...1.0, step: 0.05)
                        }
                    }
                }

                Section {
                    Toggle("Auto-Clean Clutter & Overlays", isOn: $settings.autoCleanClutter)

                    Stepper(
                        "Max Auto-Capture Pages: \(settings.maxAutoPages)",
                        value: $settings.maxAutoPages,
                        in: 2...15
                    )
                } header: {
                    Text("Capture Behavior")
                } footer: {
                    Text("Temporarily hides cookie banners, sticky bars, and popups before capturing, then restores the page.")
                }

                Section("Domain Selector Cache") {
                    HStack {
                        Text("Cached Domains")
                        Spacer()
                        Text("\(cachedDomainCount)")
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }

                    Button("Clear Domain Selector Cache", role: .destructive) {
                        selectorCache.clearAll()
                        cachedDomainCount = selectorCache.cachedDomainCount
                        feedbackMessage = "Cleared cached domain selectors."
                    }
                    .disabled(cachedDomainCount == 0)
                }

                if let feedbackMessage {
                    Section {
                        Text(feedbackMessage)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                refreshState()
            }
        }
    }

    private func refreshState() {
        hasStoredKey = keychain.loadAPIKey() != nil
        cachedDomainCount = selectorCache.cachedDomainCount
    }

    private func saveAPIKey() {
        do {
            try keychain.saveAPIKey(apiKeyInput)
            apiKeyInput = ""
            hasStoredKey = keychain.loadAPIKey() != nil
            feedbackMessage = "Saved API key securely to Keychain."
        } catch {
            feedbackMessage = error.localizedDescription
        }
    }

    private func deleteAPIKey() {
        do {
            try keychain.deleteAPIKey()
            apiKeyInput = ""
            hasStoredKey = false
            feedbackMessage = "Removed API key from Keychain."
        } catch {
            feedbackMessage = error.localizedDescription
        }
    }
}
