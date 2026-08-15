import AppKit
import SwiftUI

final class MainAppWindow: NSWindow {
    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown,
           event.clickCount == 2,
           isTitleBarPoint(event.locationInWindow),
           !isStandardWindowButtonPoint(event.locationInWindow) {
            performTitleBarDoubleClickAction()
            return
        }

        super.sendEvent(event)
    }

    func isTitleBarPoint(_ point: NSPoint) -> Bool {
        point.x >= 0 && point.x <= frame.width
            && point.y >= contentLayoutRect.maxY && point.y <= frame.height
    }

    private func isStandardWindowButtonPoint(_ point: NSPoint) -> Bool {
        let buttonTypes: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
        return buttonTypes.contains { type in
            guard let button = standardWindowButton(type), !button.isHidden else { return false }
            return button.bounds.contains(button.convert(point, from: nil))
        }
    }

    private func performTitleBarDoubleClickAction() {
        switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick")?.lowercased() {
        case "minimize":
            performMiniaturize(nil)
        case "none":
            break
        default:
            performZoom(nil)
        }
    }
}

@MainActor
final class MainWindowController: NSWindowController, NSWindowDelegate {
    private static let trafficLightEdgeInset: CGFloat = 16
    private static let trafficLightHorizontalStep: CGFloat = 23

    let store: MainAppStore

    init(client: AgentClient) {
        store = MainAppStore(client: client)
        let root = MainAppRootView(store: store)
        let window = MainAppWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1220, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Jesse Agent"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isOpaque = false
        window.backgroundColor = .clear
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("JesseAgent.MainWindow")
        let hostingController = NSHostingController(rootView: root)
        hostingController.view.wantsLayer = true
        hostingController.view.layer?.backgroundColor = NSColor.clear.cgColor
        window.contentViewController = hostingController
        super.init(window: window)
        window.delegate = self
        positionTrafficLights()
    }

    required init?(coder: NSCoder) { nil }

    func show(sessionID: String? = nil) {
        showWindow(nil)
        window?.centerIfNeeded()
        positionTrafficLights()
        scheduleTrafficLightPositioning()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        if let sessionID { Task { await store.openSessionFromDeepLink(sessionID) } }
    }

    func windowDidResize(_ notification: Notification) {
        positionTrafficLights()
        scheduleTrafficLightPositioning()
    }

    func windowDidBecomeKey(_ notification: Notification) {
        positionTrafficLights()
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        positionTrafficLights()
        scheduleTrafficLightPositioning()
    }

    private func scheduleTrafficLightPositioning() {
        DispatchQueue.main.async { [weak self] in
            self?.positionTrafficLights()
        }
    }

    private func positionTrafficLights() {
        guard let window,
              let close = window.standardWindowButton(.closeButton),
              let minimize = window.standardWindowButton(.miniaturizeButton),
              let zoom = window.standardWindowButton(.zoomButton),
              let container = close.superview else { return }

        let buttons = [close, minimize, zoom]
        for (index, button) in buttons.enumerated() {
            button.setFrameOrigin(NSPoint(
                x: Self.trafficLightEdgeInset + CGFloat(index) * Self.trafficLightHorizontalStep,
                y: container.bounds.maxY - Self.trafficLightEdgeInset - button.frame.height
            ))
        }
    }

}

private extension NSWindow {
    func centerIfNeeded() {
        if !isVisible && frame.origin == .zero { center() }
    }
}
