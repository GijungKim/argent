import XCTest

/// Exact live-element resolution and tapping for the `tapElement` command.
///
/// Kept independent of `ArgentRunnerSession` so a fixture UI-test target can
/// compile this file with RunnerProtocol.swift and exercise the production
/// query/action path against its own XCUIApplication.
enum NativeElementTap {
    private enum TapCountResolution {
        case valid(Int)
        case invalid(Envelope)
    }

    /// Shared tap-count validation for coordinate and semantic taps.
    private static func resolveTapCount(_ request: CommandRequest, command: String)
        -> TapCountResolution
    {
        let taps = request.numberOfTaps ?? 1
        guard (1...10).contains(taps) else {
            return .invalid(
                .failure(
                    .invalidRequest,
                    "\(command) requires numberOfTaps between 1 and 10"
                )
            )
        }
        return .valid(taps)
    }

    /// Resolves exactly one live XCUIElement and taps it directly.
    static func perform(_ request: CommandRequest, on app: XCUIApplication)
        -> Envelope
    {
        guard let selector = request.selector,
            selector.identifier?.isEmpty != true,
            selector.label?.isEmpty != true,
            selector.role?.isEmpty != true,
            selector.identifier != nil || selector.label != nil
        else {
            return .failure(
                .invalidRequest,
                "tapElement requires non-empty selector fields and an identifier or label"
            )
        }

        let taps: Int
        switch resolveTapCount(request, command: "tapElement") {
        case .valid(let value): taps = value
        case .invalid(let error): return error
        }

        var predicates: [NSPredicate] = []
        if let identifier = selector.identifier {
            predicates.append(NSPredicate(format: "identifier == %@", identifier))
        }
        if let label = selector.label {
            predicates.append(NSPredicate(format: "label == %@", label))
        }
        if let role = selector.role {
            let rawTypes = knownElementTypes.compactMap { entry -> NSNumber? in
                guard describeRole(for: entry.type) == role else { return nil }
                return NSNumber(value: entry.type.rawValue)
            }
            guard !rawTypes.isEmpty else {
                return elementNotFound()
            }
            predicates.append(NSPredicate(format: "elementType IN %@", rawTypes))
        }

        let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: predicates)
        let query = app.descendants(matching: .any).matching(predicate)
        let matchCount = query.count

        guard matchCount > 0 else {
            return elementNotFound()
        }
        guard matchCount == 1 else {
            return .failure(
                .elementAmbiguous,
                "tapElement matched multiple elements",
                hint: "Add another exact selector field so exactly one live element matches."
            )
        }

        // Resolve through the unique live query rather than an indexed snapshot
        // of candidates. If the hierarchy changes, XCTest re-evaluates this
        // same full selector instead of retargeting a stored index.
        let element = query.element
        guard element.isEnabled, element.isHittable else {
            return .failure(
                .elementNotInteractable,
                "tapElement matched an element that is disabled or not hittable",
                hint: "Wait for the element to become enabled and hittable, then retry."
            )
        }

        switch taps {
        case 1:
            element.tap()
        case 2:
            element.doubleTap()
        default:
            // Keep the coordinate tap contract: counts above two are separate
            // synthesized taps, not one native multi-tap gesture.
            for _ in 0..<taps {
                element.tap()
            }
        }

        return .success(MessagePayload(message: "tapped"))
    }

    private static func elementNotFound() -> Envelope {
        .failure(
            .elementNotFound,
            "tapElement found no matching element",
            hint: "Re-observe the screen and use a selector that identifies one live element."
        )
    }

    /// The XCTest type-to-role mapping used by the TypeScript describe adapter.
    /// Types absent from that map retain their stable runner type name.
    private static func describeRole(for type: XCUIElement.ElementType) -> String {
        switch type {
        case .button, .checkBox, .menuItem, .cell:
            return "AXButton"
        case .staticText:
            return "AXStaticText"
        case .image:
            return "AXImage"
        case .link:
            return "AXLink"
        case .textField, .secureTextField, .searchField, .textView:
            return "AXTextField"
        case .tabBar:
            return "AXTabBar"
        case .switch, .toggle, .slider, .stepper, .datePicker, .picker,
            .pickerWheel:
            return "AXAdjustable"
        default:
            return elementTypeName(type)
        }
    }

    /// One explicit source of truth for every XCTest type name understood by
    /// describe and semantic role predicates. No numeric ranges are inferred.
    private static let knownElementTypes: [
        (type: XCUIElement.ElementType, name: String)
    ] = [
        (.any, "Any"),
        (.other, "Other"),
        (.application, "Application"),
        (.group, "Group"),
        (.window, "Window"),
        (.sheet, "Sheet"),
        (.drawer, "Drawer"),
        (.alert, "Alert"),
        (.dialog, "Dialog"),
        (.button, "Button"),
        (.radioButton, "RadioButton"),
        (.radioGroup, "RadioGroup"),
        (.checkBox, "CheckBox"),
        (.disclosureTriangle, "DisclosureTriangle"),
        (.popUpButton, "PopUpButton"),
        (.comboBox, "ComboBox"),
        (.menuButton, "MenuButton"),
        (.toolbarButton, "ToolbarButton"),
        (.popover, "Popover"),
        (.keyboard, "Keyboard"),
        (.key, "Key"),
        (.navigationBar, "NavigationBar"),
        (.tabBar, "TabBar"),
        (.tabGroup, "TabGroup"),
        (.toolbar, "Toolbar"),
        (.statusBar, "StatusBar"),
        (.table, "Table"),
        (.tableRow, "TableRow"),
        (.tableColumn, "TableColumn"),
        (.outline, "Outline"),
        (.outlineRow, "OutlineRow"),
        (.browser, "Browser"),
        (.collectionView, "CollectionView"),
        (.slider, "Slider"),
        (.pageIndicator, "PageIndicator"),
        (.progressIndicator, "ProgressIndicator"),
        (.activityIndicator, "ActivityIndicator"),
        (.segmentedControl, "SegmentedControl"),
        (.picker, "Picker"),
        (.pickerWheel, "PickerWheel"),
        (.switch, "Switch"),
        (.toggle, "Toggle"),
        (.link, "Link"),
        (.image, "Image"),
        (.icon, "Icon"),
        (.searchField, "SearchField"),
        (.scrollView, "ScrollView"),
        (.scrollBar, "ScrollBar"),
        (.staticText, "StaticText"),
        (.textField, "TextField"),
        (.secureTextField, "SecureTextField"),
        (.datePicker, "DatePicker"),
        (.textView, "TextView"),
        (.menu, "Menu"),
        (.menuItem, "MenuItem"),
        (.menuBar, "MenuBar"),
        (.menuBarItem, "MenuBarItem"),
        (.map, "Map"),
        (.webView, "WebView"),
        (.incrementArrow, "IncrementArrow"),
        (.decrementArrow, "DecrementArrow"),
        (.timeline, "Timeline"),
        (.ratingIndicator, "RatingIndicator"),
        (.valueIndicator, "ValueIndicator"),
        (.splitGroup, "SplitGroup"),
        (.splitter, "Splitter"),
        (.relevanceIndicator, "RelevanceIndicator"),
        (.colorWell, "ColorWell"),
        (.helpTag, "HelpTag"),
        (.matte, "Matte"),
        (.dockItem, "DockItem"),
        (.ruler, "Ruler"),
        (.rulerMarker, "RulerMarker"),
        (.grid, "Grid"),
        (.levelIndicator, "LevelIndicator"),
        (.cell, "Cell"),
        (.layoutArea, "LayoutArea"),
        (.layoutItem, "LayoutItem"),
        (.handle, "Handle"),
        (.stepper, "Stepper"),
        (.tab, "Tab"),
        (.touchBar, "TouchBar"),
        (.statusItem, "StatusItem"),
    ]

    /// Stable XCTest type names shared by semantic roles and snapshot payloads.
    /// Future unknown enum cases preserve the existing `Other` fallback.
    static func elementTypeName(_ type: XCUIElement.ElementType) -> String {
        knownElementTypes.first { $0.type == type }?.name ?? "Other"
    }
}
