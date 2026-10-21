import FamilyControls
import SwiftUI
import UIKit

/// Use this as the app entry point of a separate, signed iOS fixture.
/// Only the standard Family Controls entitlement is needed.
@main
struct FamilyPickerFixture: App {
    var body: some Scene {
        WindowGroup { PickerRootHost() }
    }
}

private struct PickerRootHost: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> PickerRootController {
        PickerRootController()
    }

    func updateUIViewController(_ controller: PickerRootController, context: Context) {}
}

@MainActor
private final class PickerRootController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let embedded = button("Open embedded picker", id: "open-embedded-picker", action: #selector(openEmbedded))
        let fullScreen = button("Open full-screen picker", id: "open-full-screen-picker", action: #selector(openFullScreen))
        let disabled = button("Disabled fixture button", id: "disabled-fixture-button", action: #selector(openEmbedded))
        disabled.isEnabled = false
        let duplicateA = button("Duplicate fixture button", id: "duplicate-fixture-button", action: #selector(openEmbedded))
        let duplicateB = button("Duplicate fixture button", id: "duplicate-fixture-button", action: #selector(openFullScreen))
        let stack = UIStackView(arrangedSubviews: [embedded, fullScreen, disabled, duplicateA, duplicateB])
        stack.axis = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
        ])
    }

    private func button(_ title: String, id: String, action: Selector) -> UIButton {
        var configuration = UIButton.Configuration.filled()
        configuration.title = title
        let button = UIButton(configuration: configuration)
        button.accessibilityIdentifier = id
        button.addTarget(self, action: action, for: .touchUpInside)
        return button
    }

    @objc private func openEmbedded() { openPicker(style: .formSheet) }
    @objc private func openFullScreen() { openPicker(style: .fullScreen) }

    private func openPicker(style: UIModalPresentationStyle) {
        guard presentedViewController == nil else { return }
        Task { @MainActor [weak self] in
            do {
                try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
            } catch {
                return
            }
            guard let self, presentedViewController == nil else { return }
            let host = UIHostingController(rootView: TemporaryPicker {
                self.dismiss(animated: true)
            })
            host.modalPresentationStyle = style
            present(host, animated: true)
        }
    }
}

private struct TemporaryPicker: View {
    @State private var selection = FamilyActivitySelection()
    let dismiss: () -> Void

    var body: some View {
        NavigationStack {
            FamilyActivityPicker(selection: $selection)
                .navigationTitle("Choose apps")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel", action: clearAndDismiss)
                            .accessibilityIdentifier("picker-cancel")
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done", action: clearAndDismiss)
                            .accessibilityIdentifier("picker-done")
                    }
                }
        }
    }

    private func clearAndDismiss() {
        selection = FamilyActivitySelection()
        dismiss()
    }
}
