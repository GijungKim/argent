import XCTest

/// Add this file, RunnerProtocol.swift, and NativeElementTap.swift to the
/// separate fixture's UI-test target. Do not run against a personal app.
final class NativeElementTapRegressionTests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testFormSheetSearch() throws {
        try compareSearch(mode: "embedded", button: "open-embedded-picker")
    }

    func testFullScreenSearch() throws {
        try compareSearch(mode: "fullScreen", button: "open-full-screen-picker")
    }

    func testRejectsUnsafeSelectors() throws {
        app.launch()
        XCTAssertTrue(app.buttons["open-embedded-picker"].waitForExistence(timeout: 10))
        let cases: [([String: String], RunnerErrorCode)] = [
            (["identifier": "missing-fixture-button"], .elementNotFound),
            (["identifier": "OPEN-EMBEDDED-PICKER"], .elementNotFound),
            (["identifier": "duplicate-fixture-button"], .elementAmbiguous),
            (["identifier": "disabled-fixture-button"], .elementNotInteractable),
            (["role": "AXButton"], .invalidRequest),
            (["label": ""], .invalidRequest),
        ]
        for (selector, expected) in cases {
            let result = NativeElementTap.perform(try request(selector), on: app)
            XCTAssertFalse(result.ok)
            XCTAssertEqual(result.error?.code, expected.rawValue)
            XCTAssertFalse(app.buttons["picker-cancel"].exists, "A rejected selector must not open a picker")
        }
    }

    func testMutationPolicy() {
        XCTAssertFalse(CommandKind.tapElement.isReadOnly)
        XCTAssertTrue(CommandKind.tapElement.requiresAppBundleId)
        XCTAssertTrue(CommandKind.tapElement.retainsResponseInJournal)
        XCTAssertEqual(CommandKind.tapElement.executionTimeout, CommandKind.tap.executionTimeout)
    }

    private func compareSearch(mode: String, button: String) throws {
        app.launch()
        XCTAssertTrue(app.buttons[button].waitForExistence(timeout: 10))
        let opened = NativeElementTap.perform(try request(["identifier": button]), on: app)
        XCTAssertTrue(opened.ok)
        XCTAssertTrue(app.buttons["picker-cancel"].waitForExistence(timeout: 20), "Approve standard Screen Time access manually before running")
        XCTAssertTrue(app.collectionViews.firstMatch.waitForExistence(timeout: 10))
        let snapshot = try app.snapshot()
        let raw = try XCTUnwrap(findSearch(snapshot))
        let live = app.searchFields.firstMatch
        XCTAssertTrue(live.exists)
        let liveBefore = live.frame
        XCTAssertFalse(app.keyboards.firstMatch.exists)

        let origin = app.frame.origin
        app.coordinate(withNormalizedOffset: .zero).withOffset(
            CGVector(dx: raw.frame.midX - origin.x, dy: raw.frame.midY - origin.y)
        ).tap()
        let keyboardAfterSnapshotCenter = app.keyboards.firstMatch.waitForExistence(timeout: 3)
        attachScreen("native-picker-\(mode)-before")

        // This is the production implementation, not a duplicate test-only tap.
        let tapped = NativeElementTap.perform(
            try request(["label": "Search", "role": "AXTextField"]), on: app
        )
        XCTAssertTrue(tapped.ok, "The production native tap command must succeed")
        let keyboardAfterNativeTap = app.keyboards.firstMatch.waitForExistence(timeout: 5)
        XCTAssertTrue(keyboardAfterNativeTap)
        let liveAfter = live.frame
        attachScreen("native-picker-\(mode)-after")
        let geometry: [String: Any] = [
            "presentationMode": mode,
            "snapshotSearchY": raw.frame.minY,
            "liveSearchBeforeY": liveBefore.minY,
            "liveSearchAfterY": liveAfter.minY,
            "keyboardAfterSnapshotCenter": keyboardAfterSnapshotCenter,
            "keyboardAfterNativeTap": keyboardAfterNativeTap,
        ]
        let data = try JSONSerialization.data(withJSONObject: geometry, options: [.sortedKeys])
        print("ARGENT_NATIVE_TAP_EVIDENCE \(String(decoding: data, as: UTF8.self))")
        let cancelled = NativeElementTap.perform(try request(["identifier": "picker-cancel"]), on: app)
        XCTAssertTrue(cancelled.ok)
        XCTAssertTrue(app.buttons[button].waitForExistence(timeout: 5))
    }

    private func request(_ selector: [String: String]) throws -> CommandRequest {
        let data = try JSONSerialization.data(withJSONObject: ["command": "tapElement", "selector": selector])
        return try JSONDecoder().decode(CommandRequest.self, from: data)
    }

    private func findSearch(_ snapshot: XCUIElementSnapshot) -> XCUIElementSnapshot? {
        if snapshot.elementType == .searchField { return snapshot }
        for child in snapshot.children {
            if let found = findSearch(child) { return found }
        }
        return nil
    }

    private func attachScreen(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
