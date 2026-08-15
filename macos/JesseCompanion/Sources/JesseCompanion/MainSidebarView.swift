import AppKit
import SwiftUI

private let sidebarSessionPreviewLimit = 5
enum MainSidebarLayout {
    static let appContentInset: CGFloat = 8
    static let columnSpacing: CGFloat = appContentInset
    static let brandTopInset: CGFloat = 6
    static let brandHeight: CGFloat = 28
    static let sectionSpacing: CGFloat = 20
    static let trailingActionInset: CGFloat = 2
    /// Every trailing session-row element occupies the same square so status
    /// changes and the hover menu share one visual center.
    static let sessionTrailingSlotSize: CGFloat = 24
    /// The native top accessory already starts below the titlebar. Its 14 pt
    /// local inset leaves the brand 16 pt below the traffic-light buttons.
    static let brandAccessoryHeight = appContentInset
        + brandTopInset
        + brandHeight
        + sectionSpacing
    /// The 14 pt native Settings label has a 17 pt line box. Keep 10 pt of
    /// real layout space above and below that line box rather than relying on
    /// optical glyph whitespace.
    static let settingsTextVerticalPadding: CGFloat = 10
    static let settingsControlHeight: CGFloat = 37
    /// Preserves the established optical padding while moving the surface
    /// from NSButton's bezel to the native Clear Glass container.
    static let settingsGlassHorizontalPadding: CGFloat = 18
    static let settingsBarVerticalPadding: CGFloat = 8
    static let settingsIconSize: CGFloat = 16
    /// Matches the icon-to-label spacing used by sidebar navigation rows.
    static let settingsIconTitleSpacing: CGFloat = 8
}

/// Native menu icon measurements. These are assigned to `NSMenuItem.image`
/// directly, because a SwiftUI `Label` frame changes layout but does not
/// reliably control the image representation that AppKit draws in a menu.
enum SidebarMenuMetrics {
    static let iconSize: CGFloat = 16
    static let triggerIconSize: CGFloat = 14
}

struct MainSidebarView: NSViewControllerRepresentable {
    @ObservedObject var store: MainAppStore
    @Binding var theme: String

    func makeNSViewController(context: Context) -> MainSidebarSplitViewController {
        MainSidebarSplitViewController(store: store, theme: $theme)
    }

    func updateNSViewController(
        _ viewController: MainSidebarSplitViewController,
        context: Context
    ) {
        viewController.update(store: store, theme: $theme)
    }
}

@MainActor
final class MainSidebarSplitViewController: NSSplitViewController {
    let sidebarItem: NSSplitViewItem
    let contentHostingController: NSHostingController<MainSidebarContentView>
    let brandAccessoryController: SidebarBrandAccessoryViewController

    init(store: MainAppStore, theme: Binding<String>) {
        contentHostingController = NSHostingController(
            rootView: MainSidebarContentView(store: store, theme: theme)
        )
        brandAccessoryController = SidebarBrandAccessoryViewController()
        sidebarItem = NSSplitViewItem(viewController: contentHostingController)

        super.init(nibName: nil, bundle: nil)

        splitView.isVertical = true
        sidebarItem.canCollapse = false
        addSplitViewItem(sidebarItem)
        sidebarItem.addTopAlignedAccessoryViewController(brandAccessoryController)

        contentHostingController.view.wantsLayer = true
        contentHostingController.view.layer?.backgroundColor = NSColor.clear.cgColor
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.clear.cgColor
    }

    required init?(coder: NSCoder) { nil }

    func update(store: MainAppStore, theme: Binding<String>) {
        contentHostingController.rootView = MainSidebarContentView(store: store, theme: theme)
    }
}

/// The pinned brand header is a native split-view accessory so AppKit owns
/// the overlap with the scrolling content and can render its real Soft Scroll
/// Edge Effect. A SwiftUI safe-area bar inside the nested hosting controller
/// overlaps correctly but doesn't create the AppKit edge effect in this setup.
@MainActor
final class SidebarBrandAccessoryViewController: NSSplitViewItemAccessoryViewController {
    private let hostingController: NSHostingController<SidebarBrandView>

    init() {
        hostingController = NSHostingController(rootView: SidebarBrandView())
        // The split-item accessory already starts at the content-layout edge.
        // Avoid adding a second safe-area inset inside its SwiftUI content.
        hostingController.safeAreaRegions = []

        super.init(nibName: nil, bundle: nil)

        automaticallyAppliesContentInsets = false
        preferredContentSize = NSSize(
            width: 0,
            height: MainSidebarLayout.brandAccessoryHeight
        )
        if #available(macOS 26.1, *) {
            preferredScrollEdgeEffectStyle = .soft
        }

        addChild(hostingController)
        view = hostingController.view
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.clear.cgColor
    }

    required init?(coder: NSCoder) { nil }
}

struct SidebarBrandView: View {
    var body: some View {
        HStack(spacing: 4) {
            JesseBrandMark()
                .frame(width: MainSidebarLayout.brandHeight, height: MainSidebarLayout.brandHeight)
            Text("JesseAgent")
                .font(.system(size: 16, weight: .semibold))
            Spacer(minLength: 0)
        }
        .frame(height: MainSidebarLayout.brandHeight)
        .padding(.top, MainSidebarLayout.appContentInset + MainSidebarLayout.brandTopInset)
        .padding(.bottom, MainSidebarLayout.sectionSpacing)
        .padding(.horizontal, MainSidebarLayout.appContentInset + 2)
    }
}

struct MainSidebarContentView: View {
    @ObservedObject var store: MainAppStore
    @Binding var theme: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                SidebarSectionHeader(title: "Projects", actionTitle: "Add project") {
                    Task { await store.addProject() }
                }

                ForEach(store.projects) { project in
                    SidebarProjectItem(store: store, project: project)
                }

                SidebarSectionHeader(title: "Chat", actionTitle: "New chat", isChat: true) {
                    Task { await store.newChatConversation() }
                }

                chatList
            }
            // Only the row content is inset. Keeping the scroll view itself
            // full width lets the system blend both soft edges across the
            // entire sidebar.
            .padding(.horizontal, MainSidebarLayout.appContentInset)
        }
        .scrollIndicators(.hidden)
        // Keep Settings inside the *same* ScrollView as the sidebar rows.
        // This is the official safeAreaBar + soft scroll-edge arrangement:
        // macOS owns the transition material and lets it span the full
        // sidebar width.  Only the button itself is inset, so neither the
        // soft edge nor the glass shadow can be clipped by content padding.
        .safeAreaBar(edge: .bottom, spacing: 0) {
            HStack(spacing: 0) {
                SidebarSettingsGlassControl(
                    theme: $theme,
                    isLoading: store.isLoading
                )
                .fixedSize()

                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, MainSidebarLayout.appContentInset)
            .padding(.vertical, MainSidebarLayout.settingsBarVerticalPadding)
        }
        // The top edge is owned by the native split-view accessory above.
        // SwiftUI still owns the bottom Settings bar and its soft transition.
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .foregroundStyle(MainPalette.foreground(colorScheme))
    }

    @ViewBuilder
    private var chatList: some View {
        let sessions = store.chatSessions
        let showAll = store.expandedSessionLists.contains("chat")
        let visibleSessions = showAll ? sessions : Array(sessions.prefix(sidebarSessionPreviewLimit))

        if sessions.isEmpty {
            Text("No chats yet")
                .font(.system(size: 14))
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 9)
                .frame(height: 32)
        } else {
            ForEach(visibleSessions) { session in
                SidebarSessionRow(
                    store: store,
                    session: session,
                    workspaceRoot: store.chatWorkspaceRoot,
                    scope: .chat,
                    indented: false,
                    showRunDetails: false
                )
            }
            if visibleSessions.count < sessions.count {
                SidebarShowMoreButton(indented: false) {
                    store.showAllSessions(for: "chat")
                }
            }
        }
    }

}

/// Bridges a native AppKit Clear Glass control into the ScrollView's bottom
/// safe-area bar. The surrounding SwiftUI bar deliberately has no horizontal
/// content inset: it is the system's full-width soft edge.
struct SidebarSettingsGlassControl: NSViewRepresentable {
    @Binding var theme: String
    let isLoading: Bool

    func makeNSView(context: Context) -> SidebarSettingsClearGlassControl {
        let control = SidebarSettingsClearGlassControl()
        configure(control)
        return control
    }

    func updateNSView(_ control: SidebarSettingsClearGlassControl, context: Context) {
        configure(control)
    }

    private func configure(_ control: SidebarSettingsClearGlassControl) {
        let themeBinding = _theme
        control.update(
            selectedTheme: resolvedTheme(for: control),
            isLoading: isLoading,
            onThemeSelected: { selectedTheme in
                themeBinding.wrappedValue = selectedTheme
            }
        )
    }

    private func resolvedTheme(for control: NSView) -> String {
        if theme == "light" || theme == "dark" {
            return theme
        }
        return control.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? "dark"
            : "light"
    }
}

/// The official AppKit Clear Glass surface.  The borderless native button is
/// its content view so AppKit owns the dynamic material while NSButton keeps
/// standard click, menu and accessibility behavior.
@MainActor
final class SidebarSettingsClearGlassControl: NSGlassEffectView {
    let button = SidebarSettingsGlassButton()
    private var pointerIsInside = false

    override var intrinsicContentSize: NSSize {
        let contentSize = button.intrinsicContentSize
        return NSSize(
            width: contentSize.width + MainSidebarLayout.settingsGlassHorizontalPadding * 2,
            height: MainSidebarLayout.settingsControlHeight
        )
    }

    init() {
        super.init(frame: .zero)
        style = .clear
        tintColor = nil
        cornerRadius = MainSidebarLayout.settingsControlHeight / 2

        button.frame = bounds
        button.autoresizingMask = [.width, .height]
        contentView = button
        updateContentEmphasis()
    }

    required init?(coder: NSCoder) { nil }

    func update(
        selectedTheme: String,
        isLoading: Bool,
        onThemeSelected: @escaping (String) -> Void
    ) {
        button.update(
            selectedTheme: selectedTheme,
            isLoading: isLoading,
            onThemeSelected: onThemeSelected
        )
        invalidateIntrinsicContentSize()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(
            rect: .zero,
            options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
            owner: self,
            userInfo: nil
        ))
    }

    override func mouseEntered(with event: NSEvent) {
        super.mouseEntered(with: event)
        pointerIsInside = true
        updateContentEmphasis()
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        pointerIsInside = false
        updateContentEmphasis()
    }

    private func updateContentEmphasis() {
        // Clear Glass keeps the default state deliberately quiet. Regular
        // Glass only appears while the pointer is over the actionable row.
        style = pointerIsInside ? .regular : .clear
        button.setContentEmphasis(pointerIsInside)
    }
}

/// The interaction content embedded in `SidebarSettingsClearGlassControl`.
/// It is deliberately borderless: the enclosing NSGlassEffectView is the
/// one and only source of the native Liquid Glass surface.
@MainActor
final class SidebarSettingsGlassButton: NSButton {
    private var selectedTheme = "light"
    private var onThemeSelected: (String) -> Void = { _ in }
    private let contentStack = NSStackView()
    private let settingsIconView = NSImageView()
    private let settingsTitleField = NSTextField(labelWithString: "Settings")

    var displayedIconSize: NSSize {
        settingsIconView.image?.size ?? .zero
    }

    var iconTitleSpacing: CGFloat {
        contentStack.spacing
    }

    var displayedTitle: String {
        settingsTitleField.stringValue
    }

    var displayedTitleLineHeight: CGFloat {
        settingsTitleField.intrinsicContentSize.height
    }

    override var intrinsicContentSize: NSSize {
        let titleWidth = (settingsTitleField.stringValue as NSString).size(
            withAttributes: [.font: settingsTitleField.font ?? font ?? .systemFont(ofSize: 14)]
        ).width
        return NSSize(
            width: MainSidebarLayout.settingsIconSize
                + MainSidebarLayout.settingsIconTitleSpacing
                + ceil(titleWidth),
            height: MainSidebarLayout.settingsControlHeight
        )
    }

    init() {
        super.init(frame: .zero)
        isBordered = false
        setButtonType(.momentaryPushIn)
        controlSize = .small
        imagePosition = .noImage
        alignment = .left
        font = .systemFont(ofSize: 14)
        contentTintColor = .secondaryLabelColor
        focusRingType = .none
        identifier = NSUserInterfaceItemIdentifier("sidebar.settings")
        setAccessibilityLabel("Settings")
        target = self
        action = #selector(showThemeMenu)
        configureContent()
    }

    required init?(coder: NSCoder) { nil }

    func update(
        selectedTheme: String,
        isLoading: Bool,
        onThemeSelected: @escaping (String) -> Void
    ) {
        self.selectedTheme = selectedTheme
        self.onThemeSelected = onThemeSelected
        // Keep the system button's own title/image empty: the native stack
        // below controls their spacing while the NSButton still supplies the
        // official Liquid Glass bezel, hover, press, and keyboard behavior.
        title = ""
        image = nil
        settingsTitleField.stringValue = "Settings"
        settingsIconView.image = sidebarIcon(named: "ic_fluent_settings_24_regular")
        invalidateIntrinsicContentSize()
        toolTip = isLoading ? "Loading settings" : "Settings"
        rebuildThemeMenu()
    }

    func setContentEmphasis(_ isEmphasized: Bool) {
        let color: NSColor = isEmphasized ? .labelColor : .secondaryLabelColor
        contentTintColor = color
        settingsIconView.contentTintColor = color
        settingsTitleField.textColor = color
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard isEnabled, !isHidden, bounds.contains(point) else { return nil }
        // The title and image are native subviews solely for layout. Route
        // their clicks back to the glass button so its action remains intact.
        return self
    }

    @objc private func showThemeMenu() {
        guard let menu else { return }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: bounds.maxY), in: self)
    }

    @objc private func selectLightTheme() {
        onThemeSelected("light")
    }

    @objc private func selectDarkTheme() {
        onThemeSelected("dark")
    }

    private func rebuildThemeMenu() {
        let themeMenu = NSMenu(title: "Settings")
        themeMenu.autoenablesItems = false
        themeMenu.addItem(themeMenuItem(
            title: "Light mode",
            icon: "ic_fluent_weather_sunny_24_regular",
            selected: selectedTheme == "light",
            action: #selector(selectLightTheme)
        ))
        themeMenu.addItem(themeMenuItem(
            title: "Dark mode",
            icon: "ic_fluent_weather_moon_24_regular",
            selected: selectedTheme == "dark",
            action: #selector(selectDarkTheme)
        ))
        menu = themeMenu
    }

    private func configureContent() {
        settingsIconView.imageScaling = .scaleProportionallyDown
        settingsIconView.contentTintColor = .secondaryLabelColor
        settingsIconView.setAccessibilityElement(false)

        settingsTitleField.font = font
        settingsTitleField.textColor = .secondaryLabelColor
        settingsTitleField.lineBreakMode = .byTruncatingTail
        settingsTitleField.setAccessibilityElement(false)

        contentStack.orientation = .horizontal
        contentStack.alignment = .centerY
        contentStack.distribution = .fill
        contentStack.spacing = MainSidebarLayout.settingsIconTitleSpacing
        contentStack.setAccessibilityElement(false)
        contentStack.addArrangedSubview(settingsIconView)
        contentStack.addArrangedSubview(settingsTitleField)
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        settingsIconView.translatesAutoresizingMaskIntoConstraints = false

        addSubview(contentStack)
        NSLayoutConstraint.activate([
            settingsIconView.widthAnchor.constraint(
                equalToConstant: MainSidebarLayout.settingsIconSize
            ),
            settingsIconView.heightAnchor.constraint(
                equalToConstant: MainSidebarLayout.settingsIconSize
            ),
            contentStack.centerXAnchor.constraint(equalTo: centerXAnchor),
            contentStack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    /// `FluentIconAssets` caches the source image shared by every sidebar
    /// item. Copy it before changing its display size so the Settings control
    /// matches the sidebar's 16 pt icon without resizing other callers.
    private func sidebarIcon(named name: String) -> NSImage? {
        guard let sourceImage = FluentIconAssets.image(named: name),
              let resizedImage = sourceImage.copy() as? NSImage else {
            return nil
        }
        resizedImage.size = NSSize(
            width: MainSidebarLayout.settingsIconSize,
            height: MainSidebarLayout.settingsIconSize
        )
        resizedImage.isTemplate = true
        return resizedImage
    }

    private func themeMenuItem(
        title: String,
        icon: String,
        selected: Bool,
        action: Selector
    ) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        // Native menus preserve an NSImage's requested display size. Reuse
        // the Settings icon's 16 pt copy so the theme glyphs do not inherit
        // the Fluent source asset's larger 24 pt size.
        item.image = sidebarIcon(named: icon)
        item.state = selected ? .on : .off
        return item
    }
}

private struct SidebarSectionHeader: View {
    let title: String
    let actionTitle: String
    var isChat = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 0) {
            Text(title)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            SidebarActionButton(
                icon: "ic_fluent_add_24_regular",
                help: actionTitle,
                action: action
            )
            .opacity(hovering ? 1 : 0)
            .allowsHitTesting(hovering)
            .accessibilityIdentifier(isChat ? "sidebar.chat.new" : "sidebar.projects.add")
        }
        .font(.system(size: 14))
        .frame(height: 28)
        .padding(.leading, 9)
        .padding(.trailing, MainSidebarLayout.trailingActionInset)
        .padding(.top, isChat ? MainSidebarLayout.sectionSpacing : 0)
        .padding(.bottom, isChat ? 12 : 6)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}

private struct SidebarProjectItem: View {
    @ObservedObject var store: MainAppStore
    let project: DesktopProject
    @Environment(\.colorScheme) private var colorScheme
    @State private var hovering = false
    @State private var projectMenuPresented = false

    private var isExpanded: Bool {
        store.expandedProjectPaths.contains(project.path)
    }

    private var isActive: Bool {
        store.selectedProject?.path == project.path && store.selectedSessionID == nil
    }

    private var sessions: [DesktopSessionSummary] {
        store.sessions(for: project.path)
    }

    private var visibleSessions: [DesktopSessionSummary] {
        store.expandedSessionLists.contains(project.path)
            ? sessions
            : Array(sessions.prefix(sidebarSessionPreviewLimit))
    }

    var body: some View {
        VStack(spacing: 2) {
            HStack(spacing: 4) {
                Button {
                    Task { await store.toggleProject(project) }
                } label: {
                    HStack(spacing: 4) {
                        FluentIcon(name: "ic_fluent_folder_24_regular")
                            .frame(width: 16, height: 16)
                            .frame(width: 28, height: 28)
                        Text(project.name.isEmpty ? project.path : project.name)
                            .font(.system(size: 14))
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(project.path)

                HStack(spacing: 0) {
                    SidebarActionButton(icon: "ic_fluent_add_24_regular", help: "New chat") {
                        Task { await store.newProjectConversation(project) }
                    }
                    .accessibilityIdentifier("sidebar.project.new.\(project.path)")

                    Button {
                        projectMenuPresented.toggle()
                    } label: {
                        SidebarOverflowIcon()
                    }
                    .buttonStyle(.plain)
                    .popover(isPresented: $projectMenuPresented, arrowEdge: .leading) {
                        SidebarProjectMenu(
                            path: project.path,
                            rename: {
                                projectMenuPresented = false
                                Task { await store.renameProject(project) }
                            },
                            remove: {
                                projectMenuPresented = false
                                Task { await store.removeProject(project) }
                            },
                            copyPath: {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(project.path, forType: .string)
                                projectMenuPresented = false
                            }
                        )
                    }
                    .help("Project menu")
                    .accessibilityLabel("Project menu")
                    .accessibilityIdentifier("sidebar.project.menu.\(project.path)")
                }
                .opacity(hovering ? 1 : 0)
                .allowsHitTesting(hovering)
            }
            .padding(.leading, 2)
            .padding(.trailing, MainSidebarLayout.trailingActionInset)
            .frame(height: 32)
            .contentShape(Rectangle())
            .background(
                isActive
                    ? MainPalette.navActive(colorScheme)
                    : hovering
                        ? MainPalette.hover(colorScheme)
                        : .clear
            )
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .onHover { hovering = $0 }
            .accessibilityIdentifier("sidebar.project.\(project.path)")

            if isExpanded {
                if sessions.isEmpty {
                    Text("No sessions")
                        .font(.system(size: 14))
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 34)
                        .frame(height: 32)
                } else {
                    ForEach(visibleSessions) { session in
                        SidebarSessionRow(
                            store: store,
                            session: session,
                            workspaceRoot: project.path,
                            scope: .project(project.path),
                            indented: true,
                            showRunDetails: true
                        )
                    }
                    if visibleSessions.count < sessions.count {
                        SidebarShowMoreButton(indented: true) {
                            store.showAllSessions(for: project.path)
                        }
                    }
                }
            }
        }
    }
}

private struct SidebarSessionRow: View {
    @ObservedObject var store: MainAppStore
    let session: DesktopSessionSummary
    let workspaceRoot: String
    let scope: MainConversationScope
    let indented: Bool
    let showRunDetails: Bool
    @Environment(\.colorScheme) private var colorScheme
    @State private var hovering = false

    private var title: String {
        if !session.title.isEmpty { return session.title }
        if let message = session.lastUserMessage, !message.isEmpty { return message }
        return "Untitled session"
    }

    private var isActive: Bool {
        store.selectedSessionID == session.id && store.workspaceRoot == workspaceRoot
    }

    private var isShortcut: Bool {
        showRunDetails && session.metadata?.origin == "shortcut"
    }

    var body: some View {
        HStack(spacing: 4) {
            Button {
                Task { await store.openSession(session, workspaceRoot: workspaceRoot, scope: scope) }
            } label: {
                HStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(title)
                            .font(.system(size: 14))
                            .lineLimit(1)
                            .truncationMode(.tail)
                        if isShortcut {
                            Text(shortcutDetail)
                                .font(.system(size: 11))
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            ZStack(alignment: .trailing) {
                if showRunDetails, let status = session.lastRun?.status {
                    runStatusIndicator(status)
                        .opacity(hovering ? 0 : 1)
                }

                SidebarSessionMenuButton(
                    rename: { Task { await store.renameSession(session, workspaceRoot: workspaceRoot) } },
                    archive: { Task { await store.archiveSession(session, workspaceRoot: workspaceRoot) } },
                    copyTitle: {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(title, forType: .string)
                    }
                )
                .opacity(hovering ? 1 : 0)
                .allowsHitTesting(hovering)
                .help("Chat menu")
                .accessibilityLabel("Chat menu")
                .accessibilityIdentifier("sidebar.session.menu.\(workspaceRoot).\(session.id)")
            }
            .frame(
                minWidth: MainSidebarLayout.sessionTrailingSlotSize,
                minHeight: MainSidebarLayout.sessionTrailingSlotSize,
                alignment: .trailing
            )
        }
        .padding(.leading, indented ? 34 : 9)
        .padding(.trailing, MainSidebarLayout.trailingActionInset)
        .frame(height: isShortcut ? 48 : 32)
        .contentShape(Rectangle())
        .background(
            isActive
                ? MainPalette.navActive(colorScheme)
                : hovering
                    ? MainPalette.hover(colorScheme)
                    : .clear
        )
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .onHover { hovering = $0 }
        .contextMenu {
            Button { Task { await store.renameSession(session, workspaceRoot: workspaceRoot) } } label: {
                SidebarContextMenuLabel(title: "Rename chat", icon: "ic_fluent_rename_24_regular")
            }
            Button(role: .destructive) { Task { await store.archiveSession(session, workspaceRoot: workspaceRoot) } } label: {
                SidebarContextMenuLabel(title: "Archive chat", icon: "ic_fluent_archive_24_regular")
            }
            Divider()
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(title, forType: .string)
            } label: {
                SidebarContextMenuLabel(title: "Copy title", icon: "ic_fluent_copy_24_regular")
            }
        }
        .help(title)
        .accessibilityIdentifier("sidebar.session.\(workspaceRoot).\(session.id)")
    }

    private var shortcutDetail: String {
        [shortcutSourceLabel, runStatusLabel(session.lastRun?.status)]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    private var shortcutSourceLabel: String {
        guard let source = session.metadata?.source else { return "Shortcut" }
        if let value = source.url, let url = URL(string: value), let host = url.host {
            if host == "github.com" {
                let parts = url.pathComponents.filter { $0 != "/" }
                if parts.count >= 2 { return "\(parts[0])/\(parts[1])" }
            }
            return host
        }
        return source.app ?? "Shortcut"
    }

    @ViewBuilder
    private func runStatusIndicator(_ status: AgentRunStatus) -> some View {
        switch status {
        case .queued, .running:
            SidebarSessionTrailingSlot {
                SidebarRunProgressView(label: runStatusLabel(status))
            }
        case .waitingApproval:
            HStack(spacing: 8) {
                Text("Awaiting approval")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color(red: 0.00, green: 0.61, blue: 0.25))
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(.horizontal, 8)
                    .frame(height: 22)
                    .background(Color(red: 0.84, green: 0.95, blue: 0.87))
                    .clipShape(Capsule())
                SidebarSessionTrailingSlot {
                    SidebarRunProgressView(label: "Awaiting approval")
                }
            }
        case .completed:
            if store.shouldShowResultDot(for: session, workspaceRoot: workspaceRoot) {
                SidebarSessionTrailingSlot {
                    Circle()
                        .fill(Color(red: 0.23, green: 0.51, blue: 0.96))
                        .frame(width: 7, height: 7)
                        .accessibilityLabel("Completed, unread")
                }
            }
        case .failed:
            if store.shouldShowResultDot(for: session, workspaceRoot: workspaceRoot) {
                SidebarSessionTrailingSlot {
                    Circle()
                        .fill(Color(red: 0.82, green: 0.29, blue: 0.29))
                        .frame(width: 7, height: 7)
                        .accessibilityLabel("Error, unread")
                }
            }
        case .cancelled:
            EmptyView()
        }
    }

    private func runStatusLabel(_ status: AgentRunStatus?) -> String {
        switch status {
        case .queued: "Queued"
        case .running: "Running"
        case .waitingApproval: "Awaiting approval"
        case .completed: "Completed"
        case .failed: "Failed"
        case .cancelled: "Stopped"
        case nil: ""
        }
    }
}

private struct SidebarSessionTrailingSlot<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .frame(
                width: MainSidebarLayout.sessionTrailingSlotSize,
                height: MainSidebarLayout.sessionTrailingSlotSize,
                alignment: .center
            )
    }
}

private struct SidebarRunProgressView: View {
    let label: String

    var body: some View {
        ProgressView()
            .progressViewStyle(.circular)
            .controlSize(.small)
            .frame(width: 16, height: 16)
            .accessibilityLabel(label)
    }
}

private struct SidebarActionButton: View {
    let icon: String
    let help: String
    let action: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            FluentIcon(name: icon)
                .frame(width: 14, height: 14)
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
                .background(hovering ? MainPalette.hover(colorScheme) : .clear)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(help)
        .accessibilityLabel(help)
    }
}

private struct SidebarOverflowIcon: View {
    var body: some View {
        FluentIcon(name: "ic_fluent_more_vertical_24_regular")
            .frame(
                width: SidebarMenuMetrics.triggerIconSize,
                height: SidebarMenuMetrics.triggerIconSize
            )
            .frame(
                width: MainSidebarLayout.sessionTrailingSlotSize,
                height: MainSidebarLayout.sessionTrailingSlotSize
            )
            .contentShape(Rectangle())
    }
}

/// A real AppKit menu trigger. Unlike SwiftUI `Menu`, it assigns an image with
/// an explicit 16 pt `NSImage.size` to every `NSMenuItem`, so AppKit draws the
/// requested size instead of re-rendering an unconstrained SwiftUI label.
private struct SidebarSessionMenuButton: NSViewRepresentable {
    let rename: () -> Void
    let archive: () -> Void
    let copyTitle: () -> Void

    func makeNSView(context: Context) -> SidebarSessionMenuControl {
        let control = SidebarSessionMenuControl()
        control.update(rename: rename, archive: archive, copyTitle: copyTitle)
        return control
    }

    func updateNSView(_ control: SidebarSessionMenuControl, context: Context) {
        control.update(rename: rename, archive: archive, copyTitle: copyTitle)
    }
}

@MainActor
final class SidebarSessionMenuControl: NSButton {
    private var renameHandler: () -> Void = {}
    private var archiveHandler: () -> Void = {}
    private var copyTitleHandler: () -> Void = {}
    private let iconView = NSHostingView(rootView: SidebarOverflowIcon())

    override var intrinsicContentSize: NSSize {
        NSSize(
            width: MainSidebarLayout.sessionTrailingSlotSize,
            height: MainSidebarLayout.sessionTrailingSlotSize
        )
    }

    init() {
        super.init(frame: .zero)
        setButtonType(.momentaryChange)
        isBordered = false
        bezelStyle = .inline
        imagePosition = .noImage
        image = nil
        title = ""

        // Render the trigger through the exact same SwiftUI FluentIcon view
        // as the project row. AppKit's template-image button treatment makes
        // the same SVG appear lighter and optically smaller.
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.setAccessibilityElement(false)
        addSubview(iconView)
        NSLayoutConstraint.activate([
            iconView.leadingAnchor.constraint(equalTo: leadingAnchor),
            iconView.trailingAnchor.constraint(equalTo: trailingAnchor),
            iconView.topAnchor.constraint(equalTo: topAnchor),
            iconView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        target = self
        action = #selector(showMenu)
        toolTip = "Chat menu"
        setAccessibilityLabel("Chat menu")
    }

    required init?(coder: NSCoder) { nil }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard isEnabled, !isHidden, alphaValue > 0, bounds.contains(point) else { return nil }
        return self
    }

    func update(rename: @escaping () -> Void, archive: @escaping () -> Void, copyTitle: @escaping () -> Void) {
        renameHandler = rename
        archiveHandler = archive
        copyTitleHandler = copyTitle
    }

    @objc private func showMenu() {
        let menu = NSMenu(title: "Chat actions")
        menu.autoenablesItems = false
        menu.addItem(makeMenuItem(
            title: "Rename chat",
            icon: "ic_fluent_rename_24_regular",
            action: #selector(rename)
        ))
        menu.addItem(makeMenuItem(
            title: "Archive chat",
            icon: "ic_fluent_archive_24_regular",
            action: #selector(archive)
        ))
        menu.addItem(.separator())
        menu.addItem(makeMenuItem(
            title: "Copy title",
            icon: "ic_fluent_copy_24_regular",
            action: #selector(copyTitle)
        ))
        menu.popUp(positioning: nil, at: NSPoint(x: bounds.maxX, y: bounds.minY), in: self)
    }

    private func makeMenuItem(title: String, icon: String, action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.image = SidebarNativeMenuIcon.image(named: icon, size: SidebarMenuMetrics.iconSize)
        return item
    }

    @objc private func rename() { renameHandler() }
    @objc private func archive() { archiveHandler() }
    @objc private func copyTitle() { copyTitleHandler() }
}

@MainActor
enum SidebarNativeMenuIcon {
    /// Copy before assigning the requested size: FluentIconAssets caches source
    /// images, and changing a cached image would resize icons elsewhere.
    static func image(named name: String, size: CGFloat) -> NSImage? {
        guard let source = FluentIconAssets.image(named: name),
              let result = source.copy() as? NSImage else {
            return nil
        }
        result.size = NSSize(width: size, height: size)
        result.isTemplate = true
        return result
    }
}

/// The right-click fallback still comes from SwiftUI, but receives the same
/// explicitly-sized source image as the AppKit overflow menu.
private struct SidebarContextMenuLabel: View {
    let title: String
    let icon: String

    var body: some View {
        Label {
            Text(title)
        } icon: {
            Group {
                if let image = SidebarNativeMenuIcon.image(named: icon, size: SidebarMenuMetrics.iconSize) {
                    Image(nsImage: image)
                        .resizable()
                        .renderingMode(.template)
                        .aspectRatio(contentMode: .fit)
                } else {
                    Color.clear
                }
            }
            .frame(width: SidebarMenuMetrics.iconSize, height: SidebarMenuMetrics.iconSize)
        }
    }
}

private struct SidebarProjectMenu: View {
    let path: String
    let rename: () -> Void
    let remove: () -> Void
    let copyPath: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 2) {
            SidebarPopoverButton(
                title: "Rename project",
                icon: "ic_fluent_rename_24_regular",
                action: rename
            )
            SidebarPopoverButton(
                title: "Remove project",
                icon: "ic_fluent_delete_24_regular",
                isDestructive: true,
                action: remove
            )

            Divider()
                .padding(.vertical, 2)

            SidebarPopoverButton(
                title: path,
                icon: "ic_fluent_copy_24_regular",
                monospaced: true,
                truncationMode: .middle,
                action: copyPath
            )
            .help("Copy path: \(path)")
        }
        .padding(5)
        .frame(width: 232)
        .foregroundStyle(MainPalette.foreground(colorScheme))
    }
}

private struct SidebarPopoverButton: View {
    let title: String
    let icon: String
    var isDestructive = false
    var monospaced = false
    var truncationMode: Text.TruncationMode = .tail
    let action: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                FluentIcon(name: icon)
                    .frame(width: 16, height: 16)
                Text(title)
                    .font(monospaced ? .system(size: 12, design: .monospaced) : .system(size: 14))
                    .lineLimit(1)
                    .truncationMode(truncationMode)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, minHeight: 32, maxHeight: 32, alignment: .leading)
            .foregroundStyle(isDestructive ? Color.red : MainPalette.foreground(colorScheme))
            .contentShape(Rectangle())
            .background(hovering ? MainPalette.hover(colorScheme) : .clear)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

private struct SidebarShowMoreButton: View {
    let indented: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text("Show more")
                .font(.system(size: 14))
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, indented ? 34 : 9)
                .frame(height: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(indented ? "sidebar.project.showMore" : "sidebar.chat.showMore")
    }
}
