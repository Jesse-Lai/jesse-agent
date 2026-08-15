import AppKit
import Carbon
import OSLog
import ServiceManagement

enum JesseAgentDeepLink {
    static func sessionID(from url: URL) -> String? {
        guard url.scheme?.lowercased() == "jesseagent" else { return nil }
        let pathComponents = url.path.split(separator: "/").map(String.init)
        let raw: String?
        if url.host?.lowercased() == "session" {
            raw = pathComponents.first
        } else {
            raw = pathComponents.last
        }
        guard let decoded = raw?.removingPercentEncoding?.trimmingCharacters(in: .whitespacesAndNewlines),
              !decoded.isEmpty else { return nil }
        return decoded
    }
}

enum AppLaunchPolicy {
    static func shouldOpenMainWindow(launchedAsLoginItem: Bool) -> Bool {
        !launchedAsLoginItem
    }

    static func launchedAsLoginItem(from event: NSAppleEventDescriptor?) -> Bool {
        event?.paramDescriptor(forKeyword: AEKeyword(keyAELaunchedAsLogInItem))?.booleanValue ?? false
    }
}

enum CompanionMainMenu {
    static func make(language: InterfaceLanguage) -> NSMenu {
        let mainMenu = NSMenu()
        let editItem = NSMenuItem(
            title: language.text("编辑", "Edit"),
            action: nil,
            keyEquivalent: ""
        )
        let editMenu = NSMenu(title: editItem.title)

        let undoItem = NSMenuItem(
            title: language.text("撤销", "Undo"),
            action: Selector(("undo:")),
            keyEquivalent: "z"
        )
        undoItem.keyEquivalentModifierMask = .command
        editMenu.addItem(undoItem)

        let redoItem = NSMenuItem(
            title: language.text("重做", "Redo"),
            action: Selector(("redo:")),
            keyEquivalent: "Z"
        )
        redoItem.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(redoItem)
        editMenu.addItem(.separator())

        let cutItem = NSMenuItem(
            title: language.text("剪切", "Cut"),
            action: #selector(NSText.cut(_:)),
            keyEquivalent: "x"
        )
        cutItem.keyEquivalentModifierMask = .command
        editMenu.addItem(cutItem)

        let copyItem = NSMenuItem(
            title: language.text("复制", "Copy"),
            action: #selector(NSText.copy(_:)),
            keyEquivalent: "c"
        )
        copyItem.keyEquivalentModifierMask = .command
        editMenu.addItem(copyItem)

        let pasteItem = NSMenuItem(
            title: language.text("粘贴", "Paste"),
            action: #selector(NSText.paste(_:)),
            keyEquivalent: "v"
        )
        pasteItem.keyEquivalentModifierMask = .command
        editMenu.addItem(pasteItem)

        editMenu.addItem(.separator())
        let selectAllItem = NSMenuItem(
            title: language.text("全选", "Select All"),
            action: #selector(NSText.selectAll(_:)),
            keyEquivalent: "a"
        )
        selectAllItem.keyEquivalentModifierMask = .command
        editMenu.addItem(selectAllItem)
        mainMenu.addItem(editItem)
        mainMenu.setSubmenu(editMenu, for: editItem)
        return mainMenu
    }
}

@main
@MainActor
final class JesseCompanionApp: NSObject, NSApplicationDelegate {
    private static let logger = Logger(subsystem: "com.jesse.agent.companion", category: "app")
    private var statusItem: NSStatusItem?
    private var hotKey: GlobalHotKey?
    private var loginItem: NSMenuItem?
    private var ringController: RingWindowController?
    private var mainWindowController: MainWindowController?
    private var activeShortcut = Shortcut.optionA
    private var preferredShortcutUnavailable = false
    private var languagePreference = InterfaceLanguagePreference.current
    private let accessibility = AccessibilityService()
    private let serverManager = AgentServerManager()

    static func main() {
        let app = NSApplication.shared
        let delegate = JesseCompanionApp()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMainMenu()
        serverManager.ensureRunning()
        let agentClient = AgentClient(baseURL: AgentServerManager.baseURL)
        let mainWindowController = MainWindowController(client: agentClient)
        self.mainWindowController = mainWindowController
        ringController = RingWindowController(
            accessibility: accessibility,
            agentClient: agentClient,
            language: languagePreference.resolvedLanguage,
            openAgentHandler: { [weak self] sessionID in
                self?.showMainWindow(sessionID: sessionID)
            }
        )
        for shortcut in [Shortcut.optionA, .optionSpace] {
            let candidate = GlobalHotKey(keyCode: shortcut.keyCode, modifiers: shortcut.carbonModifiers) { [weak self] in
                self?.toggleRing()
            }
            if candidate.isRegistered {
                hotKey = candidate
                activeShortcut = shortcut
                preferredShortcutUnavailable = shortcut != .optionA
                break
            }
        }
        Self.logger.notice(
            "Companion launched; shortcut=\(self.activeShortcut.displayName(in: self.languagePreference.resolvedLanguage), privacy: .public); registered=\(self.hotKey?.isRegistered == true)"
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(systemLocaleDidChange),
            name: NSLocale.currentLocaleDidChangeNotification,
            object: nil
        )
        configureStatusItem()
        let launchedAsLoginItem = AppLaunchPolicy.launchedAsLoginItem(
            from: NSAppleEventManager.shared().currentAppleEvent
        )
        if AppLaunchPolicy.shouldOpenMainWindow(launchedAsLoginItem: launchedAsLoginItem) {
            showMainWindow()
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showMainWindow()
        return true
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            guard let sessionID = JesseAgentDeepLink.sessionID(from: url) else { continue }
            showMainWindow(sessionID: sessionID)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        hotKey?.unregister()
        serverManager.stop()
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func toggleRing() {
        guard let ringController else { return }
        Self.logger.notice("Toggle requested; visible=\(ringController.isVisible)")
        if ringController.isVisible {
            ringController.hide()
        } else {
            showRing()
        }
    }

    private func showRing() {
        guard let ringController else { return }
        let context = accessibility.captureFocusedContext()
        ringController.show(context: context, near: NSEvent.mouseLocation)
    }

    @objc private func openAgent() {
        showMainWindow()
    }

    @objc private func openWebAgent() {
        NSWorkspace.shared.open(AgentServerManager.baseURL)
    }

    @objc private func showRecentResults() {
        ringController?.showRecentResults(near: NSEvent.mouseLocation)
    }

    private func showMainWindow(sessionID: String? = nil) {
        mainWindowController?.show(sessionID: sessionID)
    }

    @objc private func showPermissions() {
        let context = accessibility.captureFocusedContext(promptForPermission: true)
        ringController?.show(context: context, near: NSEvent.mouseLocation)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    @objc private func toggleLaunchAtLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
            updateLoginItemState()
        } catch {
            NSSound.beep()
        }
    }

    @objc private func selectLanguage(_ sender: NSMenuItem) {
        guard let preference = InterfaceLanguagePreference(menuTag: sender.tag) else { return }
        languagePreference = preference
        preference.save()
        ringController?.setLanguage(preference.resolvedLanguage)
        configureMainMenu()
        rebuildStatusMenu()
    }

    @objc private func systemLocaleDidChange() {
        guard languagePreference == .system else { return }
        ringController?.setLanguage(languagePreference.resolvedLanguage)
        configureMainMenu()
        rebuildStatusMenu()
    }

    private func configureMainMenu() {
        NSApp.mainMenu = CompanionMainMenu.make(language: languagePreference.resolvedLanguage)
    }

    private func configureStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem = item
        rebuildStatusMenu()
    }

    private func rebuildStatusMenu() {
        guard let item = statusItem else { return }
        let language = languagePreference.resolvedLanguage
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "Jesse Agent")
            button.toolTip = "Jesse Agent · \(activeShortcut.displayName(in: language))"
            button.action = #selector(toggleRing)
            button.target = self
        }

        let menu = NSMenu()
        let showItem = menu.addItem(
            withTitle: language.text("显示快捷方式", "Show Shortcuts"),
            action: #selector(toggleRing),
            keyEquivalent: activeShortcut.keyEquivalent
        )
        showItem.keyEquivalentModifierMask = activeShortcut.modifierMask
        showItem.target = self
        if preferredShortcutUnavailable {
            let notice = NSMenuItem(
                title: language.text("⌥A 已被占用，已改用 ⌥空格键", "⌥A is unavailable; using ⌥Space"),
                action: nil,
                keyEquivalent: ""
            )
            notice.isEnabled = false
            menu.addItem(notice)
        }
        menu.addItem(
            withTitle: language.text("打开 Jesse Agent", "Open Jesse Agent"),
            action: #selector(openAgent),
            keyEquivalent: ""
        ).target = self
        menu.addItem(
            withTitle: language.text("在浏览器中打开", "Open in Browser"),
            action: #selector(openWebAgent),
            keyEquivalent: ""
        ).target = self
        menu.addItem(
            withTitle: language.text("最近结果", "Recent Results"),
            action: #selector(showRecentResults),
            keyEquivalent: ""
        ).target = self

        let languageItem = NSMenuItem(
            title: language.text("语言", "Language"),
            action: nil,
            keyEquivalent: ""
        )
        let languageMenu = NSMenu(title: languageItem.title)
        for preference in InterfaceLanguagePreference.allCases {
            let option = NSMenuItem(
                title: preference.menuTitle(in: language),
                action: #selector(selectLanguage),
                keyEquivalent: ""
            )
            option.target = self
            option.tag = preference.menuTag
            option.state = preference == languagePreference ? .on : .off
            languageMenu.addItem(option)
        }
        menu.addItem(languageItem)
        menu.setSubmenu(languageMenu, for: languageItem)

        menu.addItem(NSMenuItem.separator())
        menu.addItem(
            withTitle: language.text("检查系统权限", "Check Permissions"),
            action: #selector(showPermissions),
            keyEquivalent: ""
        ).target = self
        let launchAtLogin = menu.addItem(
            withTitle: language.text("登录时自动启动", "Launch at Login"),
            action: #selector(toggleLaunchAtLogin),
            keyEquivalent: ""
        )
        launchAtLogin.target = self
        loginItem = launchAtLogin
        updateLoginItemState()
        menu.addItem(NSMenuItem.separator())
        menu.addItem(
            withTitle: language.text("退出 Jesse Agent", "Quit Jesse Agent"),
            action: #selector(quit),
            keyEquivalent: "q"
        ).target = self
        item.menu = menu
    }

    private func updateLoginItemState() {
        loginItem?.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    private struct Shortcut: Equatable {
        let keyCode: UInt32
        let carbonModifiers: UInt32
        let keyEquivalent: String
        let modifierMask: NSEvent.ModifierFlags
        let displayName: String

        func displayName(in language: InterfaceLanguage) -> String {
            self == .optionSpace ? language.text("⌥空格键", "⌥Space") : displayName
        }

        static let optionSpace = Shortcut(
            keyCode: UInt32(kVK_Space),
            carbonModifiers: UInt32(optionKey),
            keyEquivalent: " ",
            modifierMask: .option,
            displayName: "⌥空格键"
        )
        static let optionA = Shortcut(
            keyCode: UInt32(kVK_ANSI_A),
            carbonModifiers: UInt32(optionKey),
            keyEquivalent: "a",
            modifierMask: .option,
            displayName: "⌥A"
        )
    }
}
