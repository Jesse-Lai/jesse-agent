import AppKit
import SwiftUI
import XCTest
@testable import JesseCompanion

@MainActor
final class MainWindowVisualTests: XCTestCase {
    func testMarkdownTableUsesRelaxedSpacingMetrics() {
        XCTAssertEqual(MainMarkdownTableMetrics.horizontalCellPadding, 12)
        XCTAssertEqual(MainMarkdownTableMetrics.bodyVerticalCellPadding, 9)
        XCTAssertEqual(MainMarkdownTableMetrics.headerVerticalCellPadding, 10)
        XCTAssertEqual(MainMarkdownTableMetrics.textLineSpacing, 4)
        XCTAssertEqual(MainMarkdownTableMetrics.otherColumnMaximumWidth, 420)
    }

    func testSidebarWidthHasStableResizeBounds() {
        XCTAssertEqual(MainSidebarMetrics.clamp(120), MainSidebarMetrics.minimumWidth)
        XCTAssertEqual(MainSidebarMetrics.clamp(320), MainSidebarMetrics.defaultWidth)
        XCTAssertEqual(MainSidebarMetrics.clamp(800), MainSidebarMetrics.maximumWidth)
        XCTAssertLessThan(MainSidebarMetrics.maximumWidth, 1220 / 2)
    }

    func testSidebarUsesExplicitTwentyPointSectionSpacing() {
        XCTAssertEqual(MainSidebarLayout.sectionSpacing, 20)
        XCTAssertEqual(MainSidebarLayout.trailingActionInset, 2)
        XCTAssertEqual(MainSidebarLayout.sessionTrailingSlotSize, 24)
        XCTAssertEqual(MainSidebarLayout.columnSpacing, MainSidebarLayout.appContentInset)
        XCTAssertEqual(MainSidebarLayout.appContentInset + MainSidebarLayout.brandTopInset, 14)
        XCTAssertEqual(MainSidebarLayout.brandAccessoryHeight, 62)
    }

    func testSidebarNativeMenuImagesUseAnExplicitSixteenPointSize() throws {
        let image = try XCTUnwrap(
            SidebarNativeMenuIcon.image(named: "ic_fluent_rename_24_regular", size: SidebarMenuMetrics.iconSize)
        )
        XCTAssertEqual(image.size.width, 16, accuracy: 0.01)
        XCTAssertEqual(image.size.height, 16, accuracy: 0.01)
    }

    func testSessionAndProjectMenuTriggersUseTheSameFourteenPointIconSize() throws {
        XCTAssertEqual(SidebarMenuMetrics.triggerIconSize, 14)
        let image = try XCTUnwrap(
            SidebarNativeMenuIcon.image(
                named: "ic_fluent_more_vertical_24_regular",
                size: SidebarMenuMetrics.triggerIconSize
            )
        )
        XCTAssertEqual(image.size.width, 14, accuracy: 0.01)
        XCTAssertEqual(image.size.height, 14, accuracy: 0.01)
    }

    func testSessionMenuTriggerUsesSharedSwiftUIIconWithoutChangingItsHitTarget() {
        let control = SidebarSessionMenuControl()
        control.frame = NSRect(x: 0, y: 0, width: 24, height: 24)

        XCTAssertNil(control.image)
        XCTAssertEqual(control.intrinsicContentSize, NSSize(width: 24, height: 24))
        XCTAssertTrue(control.hitTest(NSPoint(x: 12, y: 12)) === control)
        XCTAssertNil(control.hitTest(NSPoint(x: 25, y: 12)))
    }

    func testMainWindowUsesNativeBehindWindowGlass() throws {
        let controller = MainWindowController(
            client: AgentClient(baseURL: URL(string: "http://127.0.0.1:9")!)
        )
        let window = try XCTUnwrap(controller.window)
        window.setFrame(NSRect(x: 100, y: 100, width: 1220, height: 780), display: false)
        window.contentView?.layoutSubtreeIfNeeded()

        XCTAssertEqual(window.titleVisibility, .hidden)
        XCTAssertFalse(window.isOpaque)
        XCTAssertEqual(window.backgroundColor, .clear)
        let closeButton = try XCTUnwrap(window.standardWindowButton(.closeButton))
        let minimizeButton = try XCTUnwrap(window.standardWindowButton(.miniaturizeButton))
        let zoomButton = try XCTUnwrap(window.standardWindowButton(.zoomButton))
        let titlebar = try XCTUnwrap(closeButton.superview)
        XCTAssertEqual(closeButton.frame.minX, 16, accuracy: 0.5)
        XCTAssertEqual(minimizeButton.frame.minX - closeButton.frame.minX, 23, accuracy: 0.5)
        XCTAssertEqual(zoomButton.frame.minX - minimizeButton.frame.minX, 23, accuracy: 0.5)
        XCTAssertEqual(titlebar.bounds.maxY - closeButton.frame.maxY, 16, accuracy: 0.5)
        let trafficLightBottomInset = titlebar.bounds.maxY - closeButton.frame.minY
        let contentSafeAreaTopInset = try XCTUnwrap(window.contentView).safeAreaInsets.top
        let brandTopInset = contentSafeAreaTopInset
            + MainSidebarLayout.appContentInset
            + MainSidebarLayout.brandTopInset
        XCTAssertEqual(brandTopInset - trafficLightBottomInset, 16, accuracy: 0.5)
        let mainWindow = try XCTUnwrap(window as? MainAppWindow)
        let titleBarPoint = NSPoint(x: window.frame.width / 2, y: window.frame.height - 1)
        let contentPoint = NSPoint(x: window.frame.width / 2, y: window.contentLayoutRect.maxY - 1)
        XCTAssertTrue(mainWindow.isTitleBarPoint(titleBarPoint))
        XCTAssertFalse(mainWindow.isTitleBarPoint(contentPoint))
        let visualEffect = try XCTUnwrap(findVisualEffectView(in: window.contentView))
        XCTAssertEqual(visualEffect.material, .underWindowBackground)
        XCTAssertEqual(visualEffect.blendingMode, .behindWindow)
        XCTAssertEqual(visualEffect.state, .active)

        let sidebarController = MainSidebarSplitViewController(
            store: controller.store,
            theme: .constant("system")
        )
        XCTAssertEqual(
            sidebarController.sidebarItem.topAlignedAccessoryViewControllers,
            [sidebarController.brandAccessoryController]
        )
        XCTAssertFalse(
            sidebarController.brandAccessoryController.automaticallyAppliesContentInsets
        )
        XCTAssertEqual(
            sidebarController.brandAccessoryController.preferredContentSize.height,
            MainSidebarLayout.brandAccessoryHeight,
            accuracy: 0.5
        )
        if #available(macOS 26.1, *) {
            XCTAssertTrue(
                sidebarController.brandAccessoryController.preferredScrollEdgeEffectStyle
                    === NSScrollEdgeEffectStyle.soft
            )
        }
        // Settings lives in MainSidebarContentView's bottom safe-area bar,
        // not in a separate split accessory.  That keeps the native Soft
        // Scroll Edge Effect in the same ScrollView as the sidebar content.
        XCTAssertTrue(sidebarController.sidebarItem.bottomAlignedAccessoryViewControllers.isEmpty)
    }

    func testSettingsUsesNativeClearGlassWithBorderlessButtonContent() throws {
        let settingsControl = SidebarSettingsClearGlassControl()
        settingsControl.update(
            selectedTheme: "light",
            isLoading: false,
            onThemeSelected: { _ in }
        )
        let settingsButton = settingsControl.button

        XCTAssertEqual(settingsControl.style, .clear)
        XCTAssertNil(settingsControl.tintColor)
        XCTAssertEqual(
            settingsControl.cornerRadius,
            MainSidebarLayout.settingsControlHeight / 2,
            accuracy: 0.5
        )
        XCTAssertTrue(settingsControl.contentView === settingsButton)
        XCTAssertFalse(settingsButton.isBordered)
        XCTAssertEqual(settingsButton.imagePosition, .noImage)
        XCTAssertEqual(settingsButton.displayedTitle, "Settings")
        XCTAssertEqual(settingsButton.identifier?.rawValue, "sidebar.settings")
        XCTAssertEqual(settingsButton.controlSize, .small)
        XCTAssertEqual(try XCTUnwrap(settingsButton.font).pointSize, 14, accuracy: 0.5)
        XCTAssertEqual(
            settingsButton.displayedIconSize.width,
            MainSidebarLayout.settingsIconSize,
            accuracy: 0.5
        )
        XCTAssertEqual(
            settingsButton.displayedIconSize.height,
            MainSidebarLayout.settingsIconSize,
            accuracy: 0.5
        )
        XCTAssertEqual(
            settingsButton.iconTitleSpacing,
            MainSidebarLayout.settingsIconTitleSpacing,
            accuracy: 0.5
        )
        XCTAssertEqual(
            settingsControl.intrinsicContentSize.height,
            MainSidebarLayout.settingsControlHeight,
            accuracy: 0.5
        )
        XCTAssertEqual(MainSidebarLayout.settingsTextVerticalPadding, 10, accuracy: 0.5)
        XCTAssertEqual(
            (settingsControl.intrinsicContentSize.height - settingsButton.displayedTitleLineHeight) / 2,
            MainSidebarLayout.settingsTextVerticalPadding,
            accuracy: 0.5
        )
        XCTAssertEqual(
            settingsControl.intrinsicContentSize.width,
            settingsButton.intrinsicContentSize.width
                + MainSidebarLayout.settingsGlassHorizontalPadding * 2,
            accuracy: 0.5
        )
        XCTAssertEqual(settingsButton.menu?.items.count, 2)
        XCTAssertEqual(settingsButton.menu?.items.first?.state, .on)
        XCTAssertEqual(settingsButton.menu?.items.last?.state, .off)
        for item in try XCTUnwrap(settingsButton.menu).items {
            let image = try XCTUnwrap(item.image)
            XCTAssertEqual(image.size.width, MainSidebarLayout.settingsIconSize, accuracy: 0.5)
            XCTAssertEqual(image.size.height, MainSidebarLayout.settingsIconSize, accuracy: 0.5)
        }
    }

    func testSettingsControlIsHostedInsideTheSidebarContent() throws {
        let store = MainAppStore(
            client: AgentClient(baseURL: URL(string: "http://127.0.0.1:9")!)
        )
        let host = NSHostingView(
            rootView: MainSidebarContentView(store: store, theme: .constant("light"))
        )
        host.frame = NSRect(x: 0, y: 0, width: 320, height: 640)
        host.layoutSubtreeIfNeeded()

        let settingsButton = try XCTUnwrap(findButton(withIdentifier: "sidebar.settings", in: host))
        let buttonFrame = settingsButton.convert(settingsButton.bounds, to: host)
        XCTAssertEqual(buttonFrame.minX, MainSidebarLayout.appContentInset, accuracy: 0.5)
        XCTAssertEqual(buttonFrame.height, MainSidebarLayout.settingsControlHeight, accuracy: 0.5)
        XCTAssertGreaterThan(buttonFrame.width, 36)
        XCTAssertLessThan(buttonFrame.maxX, host.bounds.maxX)
    }

    func testMainRootRendersAtProductWindowSize() throws {
        let client = AgentClient(baseURL: URL(string: "http://127.0.0.1:9")!)
        let store = MainAppStore(client: client)
        let projects = [
            DesktopProject(name: "AgentService", path: "/projects/AgentService", lastUsedAt: "", source: "test"),
            DesktopProject(name: "Jesse-agent", path: "/projects/Jesse-agent", lastUsedAt: "", source: "test"),
            DesktopProject(name: "PPT Projects", path: "/projects/PPT", lastUsedAt: "", source: "test"),
            DesktopProject(name: "one-copilot-mobile-template-agent-copy", path: "/projects/mobile", lastUsedAt: "", source: "test"),
        ]
        store.projects = projects
        store.scope = .project(projects[0].path)
        store.expandedProjectPaths = [projects[0].path, projects[1].path]
        store.sessionsByWorkspace = [
            projects[0].path: (1...18).map {
                DesktopSessionSummary(id: "a-\($0)", title: "Project conversation \($0)", lastUserMessage: nil, pinned: nil, metadata: nil, lastRun: nil)
            },
            projects[1].path: [
                DesktopSessionSummary(id: "b-1", title: "Start coding session", lastUserMessage: nil, pinned: nil, metadata: nil, lastRun: nil),
                DesktopSessionSummary(id: "b-2", title: "Review implementation", lastUserMessage: nil, pinned: nil, metadata: nil, lastRun: nil),
            ],
        ]
        store.expandedSessionLists.insert(projects[0].path)
        let host = NSHostingView(rootView: MainAppRootView(store: store)
            .environment(\.colorScheme, .light))
        host.frame = NSRect(x: 0, y: 0, width: 1220, height: 780)
        host.layoutSubtreeIfNeeded()

        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            XCTFail("Could not allocate a bitmap for the main window")
            return
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        XCTAssertEqual(bitmap.size.width, 1220)
        XCTAssertEqual(bitmap.size.height, 780)

        if let path = ProcessInfo.processInfo.environment["JESSE_UI_SNAPSHOT_PATH"],
           let png = bitmap.representation(using: .png, properties: [:]) {
            try png.write(to: URL(fileURLWithPath: path), options: .atomic)
        }
    }

    func testMultilineComposerGrowsBeforeItScrolls() throws {
        let client = AgentClient(baseURL: URL(string: "http://127.0.0.1:9")!)
        let store = MainAppStore(client: client)
        let host = NSHostingView(rootView: MainAppRootView(store: store)
            .environment(\.colorScheme, .light))
        host.frame = NSRect(x: 0, y: 0, width: 1220, height: 780)
        host.layoutSubtreeIfNeeded()

        let textView = try XCTUnwrap(findTextView(containing: "", in: host))
        let composerScrollView = try XCTUnwrap(textView.enclosingScrollView)
        let textFont = try XCTUnwrap(textView.font)
        XCTAssertFalse(composerScrollView.hasVerticalScroller)
        XCTAssertEqual(
            textFont.pointSize,
            MainConversationTypography.bodyFontSize,
            accuracy: 0.5
        )
        XCTAssertEqual(
            textView.textContainerInset.height,
            MainComposerMetrics.textVerticalInset,
            accuracy: 0.5
        )
        XCTAssertEqual(
            composerScrollView.frame.height,
            MainComposerMetrics.minimumTextHeight,
            accuracy: 0.5
        )

        let multilineDraft = "第一行\n第二行\n第三行\n第四行"
        textView.string = multilineDraft
        textView.didChangeText()

        for _ in 0..<3 {
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }

        XCTAssertEqual(store.draft, multilineDraft)
        XCTAssertGreaterThan(composerScrollView.frame.height, MainComposerMetrics.minimumTextHeight)
        XCTAssertLessThanOrEqual(composerScrollView.frame.height, MainComposerMetrics.maximumTextHeight)

        let textContainer = try XCTUnwrap(textView.textContainer)
        let layoutManager = try XCTUnwrap(textView.layoutManager)
        layoutManager.ensureLayout(for: textContainer)
        let lastLineBottomSpacing = textView.frame.height
            - textView.textContainerOrigin.y
            - layoutManager.usedRect(for: textContainer).maxY
        XCTAssertEqual(
            lastLineBottomSpacing,
            MainComposerMetrics.textVerticalInset,
            accuracy: 0.5
        )

        textView.string = ""
        textView.didChangeText()
        for _ in 0..<3 {
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }

        XCTAssertEqual(store.draft, "")
        XCTAssertEqual(
            composerScrollView.frame.height,
            MainComposerMetrics.minimumTextHeight,
            accuracy: 0.5
        )
    }

    func testComposerPreservesLiquidGlassFootprint() throws {
        XCTAssertEqual(MainComposerMetrics.glassDepthTintOpacity, 0.30, accuracy: 0.001)

        let store = MainAppStore(
            client: AgentClient(baseURL: URL(string: "http://127.0.0.1:9")!)
        )
        let host = NSHostingView(rootView: MainAppRootView(store: store)
            .environment(\.colorScheme, .light))
        host.frame = NSRect(x: 0, y: 0, width: 1220, height: 780)
        host.layoutSubtreeIfNeeded()

        let textView = try XCTUnwrap(findTextView(containing: "", in: host))
        let composerScrollView = try XCTUnwrap(textView.enclosingScrollView)
        XCTAssertGreaterThan(composerScrollView.frame.width, 350)
        XCTAssertEqual(
            composerScrollView.frame.height,
            MainComposerMetrics.minimumTextHeight,
            accuracy: 0.5
        )
    }

    func testComposerUsesTheFourFigmaShadowLayersWithoutChangingGlassMetrics() {
        XCTAssertEqual(MainComposerMetrics.glassCornerRadius, 30, accuracy: 0.001)
        XCTAssertEqual(MainComposerMetrics.glassDepthTintOpacity, 0.30, accuracy: 0.001)
        XCTAssertEqual(MainComposerMetrics.inactiveGlassDepthTintOpacity, 0, accuracy: 0.001)
        XCTAssertEqual(MainComposerMetrics.figmaShadowLayers, [
            MainComposerShadowLayer(
                colorHex: 0xDBDBDB,
                opacity: 1,
                x: 1.25,
                y: 0,
                blur: 0,
                spread: -0.75,
                showsBehindTransparentAreas: false
            ),
            MainComposerShadowLayer(
                colorHex: 0xDBDBDB,
                opacity: 1,
                x: 0,
                y: 0,
                blur: 0,
                spread: 0.5,
                showsBehindTransparentAreas: false
            ),
            MainComposerShadowLayer(
                colorHex: 0xDBDBDB,
                opacity: 1,
                x: -1.25,
                y: 0,
                blur: 0,
                spread: -0.75,
                showsBehindTransparentAreas: false
            ),
            MainComposerShadowLayer(
                colorHex: 0x3F9CFF,
                opacity: 0.30,
                x: 0,
                y: 0,
                blur: 48,
                spread: 0,
                showsBehindTransparentAreas: true
            ),
        ])
    }

    private func findVisualEffectView(in view: NSView?) -> NSVisualEffectView? {
        guard let view else { return nil }
        if let visualEffect = view as? NSVisualEffectView { return visualEffect }
        for subview in view.subviews {
            if let result = findVisualEffectView(in: subview) { return result }
        }
        return nil
    }

    private func findTextView(containing text: String, in view: NSView?) -> NSTextView? {
        guard let view else { return nil }
        if let textView = view as? NSTextView, textView.string == text { return textView }
        for subview in view.subviews {
            if let result = findTextView(containing: text, in: subview) { return result }
        }
        return nil
    }

    private func findButton(withIdentifier identifier: String, in view: NSView?) -> NSButton? {
        guard let view else { return nil }
        if let button = view as? NSButton,
           button.identifier?.rawValue == identifier {
            return button
        }
        for subview in view.subviews {
            if let result = findButton(withIdentifier: identifier, in: subview) { return result }
        }
        return nil
    }

    func testConversationTranscriptRendersWebMessageHierarchy() throws {
        let messages = [
            MainConversationMessage(
                role: "user",
                text: "去日本 2 人 7 天，预算 10000 块",
                createdAt: "2026-08-13T04:00:00Z"
            ),
            MainConversationMessage(
                role: "assistant",
                text: "建议走 **大阪—京都—奈良** 关西线，避开东京，预算更可控。\n\n| 天数 | 行程 |\n| --- | --- |\n| D1 | 抵达大阪，道顿堀、心斋桥 |\n| D2 | 大阪城、通天阁、新世界 |\n| D3 | 前往京都，伏见稻荷、鸭川 |\n| D4 | 清水寺、二年坂、祇园 |\n\n**预算：** 往返机票约 ¥3,000，住宿 6 晚 ¥2,400。",
                createdAt: "2026-08-13T04:01:00Z"
            ),
        ]
        let root = VStack(spacing: 0) {
            ForEach(messages) { message in
                MainMessageView(message: message, edit: {}, retry: {}, addToDraft: {})
            }
            Spacer(minLength: 0)
        }
        .frame(width: 1100, height: 700, alignment: .top)
        .padding(24)
        .background(Color.white)
        .environment(\.colorScheme, .light)

        let host = NSHostingView(rootView: root)
        host.frame = NSRect(x: 0, y: 0, width: 1148, height: 748)
        host.layoutSubtreeIfNeeded()
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            XCTFail("Could not allocate a conversation bitmap")
            return
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        XCTAssertEqual(bitmap.size.width, 1148)
        XCTAssertEqual(bitmap.size.height, 748)

        if let path = ProcessInfo.processInfo.environment["JESSE_CONVERSATION_SNAPSHOT_PATH"],
           let png = bitmap.representation(using: .png, properties: [:]) {
            try png.write(to: URL(fileURLWithPath: path), options: .atomic)
        }
    }

    func testActiveConversationRendersUserQueryAtReadingColumnTrailingEdge() throws {
        let client = AgentClient(baseURL: URL(string: "http://127.0.0.1:9")!)
        let store = MainAppStore(client: client)
        store.messages = [
            MainConversationMessage(role: "assistant", text: "上一条居中的 Assistant 回复"),
            MainConversationMessage(role: "user", text: "还有什么"),
            MainConversationMessage(role: "assistant", text: "后续回复继续保持阅读宽度。"),
        ]

        let host = NSHostingView(rootView: MainAppRootView(store: store)
            .environment(\.colorScheme, .light))
        host.frame = NSRect(x: 0, y: 0, width: 1900, height: 1100)
        host.layoutSubtreeIfNeeded()

        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            XCTFail("Could not allocate an active conversation bitmap")
            return
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        XCTAssertEqual(bitmap.size.width, 1900)
        XCTAssertEqual(bitmap.size.height, 1100)

        if let path = ProcessInfo.processInfo.environment["JESSE_ACTIVE_CONVERSATION_SNAPSHOT_PATH"],
           let png = bitmap.representation(using: .png, properties: [:]) {
            try png.write(to: URL(fileURLWithPath: path), options: .atomic)
        }
    }

    func testRunningReasoningRendersInlineWithTheConversation() throws {
        let client = AgentClient(baseURL: URL(string: "http://127.0.0.1:9")!)
        let store = MainAppStore(client: client)
        store.scope = .chat
        store.workspaceMetadata = DesktopWorkspaceMetadata(
            id: "chat",
            kind: "scratch",
            path: "/chat",
            displayName: "Chat"
        )
        store.messages = [
            MainConversationMessage(role: "user", text: "你能干什么？"),
        ]
        store.outputs = [
            DesktopOutputItem(kind: .activity, title: "Thinking", detail: "Understanding the request", succeeded: nil),
            DesktopOutputItem(kind: .activity, title: "Searching", detail: "Reviewing available capabilities", succeeded: nil),
        ]
        store.activeRun = AgentRunSnapshot(
            id: "run-visual",
            sessionId: "session-visual",
            workspaceRoot: "/chat",
            executionRoot: "/chat",
            status: .running,
            source: nil,
            createdAt: "2026-08-13T04:00:00Z",
            updatedAt: "2026-08-13T04:00:01Z",
            finishedAt: nil,
            error: nil
        )

        let host = NSHostingView(rootView: MainAppRootView(store: store)
            .environment(\.colorScheme, .light))
        host.frame = NSRect(x: 0, y: 0, width: 1900, height: 1100)
        host.layoutSubtreeIfNeeded()

        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            XCTFail("Could not allocate an inline reasoning bitmap")
            return
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        XCTAssertEqual(bitmap.size.width, 1900)
        XCTAssertEqual(bitmap.size.height, 1100)

        if let path = ProcessInfo.processInfo.environment["JESSE_REASONING_SNAPSHOT_PATH"],
           let png = bitmap.representation(using: .png, properties: [:]) {
            try png.write(to: URL(fileURLWithPath: path), options: .atomic)
        }
    }
}
