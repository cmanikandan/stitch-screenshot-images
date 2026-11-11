import Foundation
import XCTest

final class StitchScreenshotUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testBrowserLandingControlsAndSettingsSheetSmoke() throws {
        let app = XCUIApplication()
        app.launch()

        let addressField = app.textFields["Enter URL or paste link..."]
        XCTAssertTrue(addressField.waitForExistence(timeout: 5))

        XCTAssertTrue(app.staticTexts["StitchScreenshot"].exists)
        XCTAssertTrue(app.buttons["Paste URL & Open"].exists)

        let swiftQuickLink = app.buttons.containing(
            NSPredicate(format: "label CONTAINS %@", "Wikipedia: Swift")
        ).firstMatch
        XCTAssertTrue(swiftQuickLink.exists)

        let fullPageButton = app.buttons["Full Page"]
        let autoStitchButton = app.buttons["Auto Stitch"]
        let appendButton = app.buttons["Append"]

        XCTAssertTrue(fullPageButton.exists)
        XCTAssertTrue(autoStitchButton.exists)
        XCTAssertTrue(appendButton.exists)

        // Capture buttons remain disabled until a page has committed content.
        XCTAssertFalse(fullPageButton.isEnabled)
        XCTAssertFalse(autoStitchButton.isEnabled)
        XCTAssertFalse(appendButton.isEnabled)

        let settingsButton = app.buttons["Settings"]
        XCTAssertTrue(settingsButton.exists)
        settingsButton.tap()

        let doneButton = app.buttons["Done"]
        XCTAssertTrue(doneButton.waitForExistence(timeout: 3))
        doneButton.tap()
    }
}
