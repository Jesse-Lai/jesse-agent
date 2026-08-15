import AppKit
import SwiftUI

struct MainAppRootView: View {
    @ObservedObject var store: MainAppStore
    @AppStorage("jesse.main.theme") private var theme = "system"
    @AppStorage("jesse.main.sidebarWidth") private var savedSidebarWidth = Double(MainSidebarMetrics.defaultWidth)
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.controlActiveState) private var inheritedControlActiveState
    @State private var permissionModeHovering = false
    @State private var composerTextHeight = MainComposerMetrics.minimumTextHeight
    @State private var sidebarDragStartWidth: CGFloat?
    @State private var draggedSidebarWidth: CGFloat?
    @Namespace private var composerTransition

    var body: some View {
        ZStack {
            MainWindowGlassBackground()
                .ignoresSafeArea()

            HStack(spacing: MainSidebarLayout.columnSpacing) {
                sidebar
                    .frame(width: displayedSidebarWidth)
                    .frame(maxHeight: .infinity)

                conversationSurface
                    .padding(.vertical, MainSidebarLayout.appContentInset)
                    .padding(.trailing, MainSidebarLayout.appContentInset)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .overlay(alignment: .leading) {
                sidebarResizeHandle
                    .offset(
                        x: displayedSidebarWidth
                            + MainSidebarLayout.columnSpacing / 2
                            - MainSidebarMetrics.handleWidth / 2
                    )
                    .zIndex(10)
            }
            // The sidebar must reach the physical window edge so its native
            // split-item accessory can render the Soft Scroll Edge Effect at
            // full width. Its rows retain the same 8 pt content inset inside
            // MainSidebarContentView; the conversation keeps its own outer
            // 8 pt top/right/bottom gutter here.
            .ignoresSafeArea(.container, edges: .top)
        }
        .frame(minWidth: 960, minHeight: 640)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // Keep the app's presentation stable when another app becomes key.
        // In particular, Liquid Glass otherwise switches to its dimmed
        // inactive appearance even though this window remains visible.
        .environment(\.controlActiveState, .key)
        .onAppear {
            savedSidebarWidth = Double(MainSidebarMetrics.clamp(CGFloat(savedSidebarWidth)))
        }
        .preferredColorScheme(preferredColorScheme)
        .task { await store.load() }
        .alert("Jesse Agent", isPresented: Binding(
            get: { store.errorMessage != nil },
            set: { if !$0 { store.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { store.errorMessage = nil }
        } message: {
            Text(store.errorMessage ?? "")
        }
        .sheet(item: $store.selectedChangelog) { detail in
            MainChangelogDetailView(
                detail: detail,
                imageURL: store.selectedChangelogImageURL,
                close: { store.closeChangelog() },
                openSession: { sessionID in
                    store.closeChangelog()
                    Task { await store.openSessionFromDeepLink(sessionID) }
                }
            )
        }
    }

    private var preferredColorScheme: ColorScheme? {
        switch theme {
        case "light": .light
        case "dark": .dark
        default: nil
        }
    }

    private var sidebar: some View {
        MainSidebarView(store: store, theme: $theme)
    }

    private var displayedSidebarWidth: CGFloat {
        draggedSidebarWidth ?? MainSidebarMetrics.clamp(CGFloat(savedSidebarWidth))
    }

    private var sidebarResizeHandle: some View {
        Color.clear
        .frame(width: MainSidebarMetrics.handleWidth)
        .frame(maxHeight: .infinity)
        .contentShape(Rectangle())
        .accessibilityIdentifier("main-sidebar-resize-handle")
        .help("Drag to resize sidebar")
        .onContinuousHover { phase in
            switch phase {
            case .active:
                NSCursor.resizeLeftRight.set()
            case .ended:
                NSCursor.arrow.set()
            }
        }
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    if sidebarDragStartWidth == nil {
                        sidebarDragStartWidth = MainSidebarMetrics.clamp(CGFloat(savedSidebarWidth))
                    }
                    guard let start = sidebarDragStartWidth else { return }
                    draggedSidebarWidth = MainSidebarMetrics.clamp(start + value.translation.width)
                }
                .onEnded { _ in
                    if let width = draggedSidebarWidth {
                        savedSidebarWidth = Double(MainSidebarMetrics.clamp(width))
                    }
                    sidebarDragStartWidth = nil
                    draggedSidebarWidth = nil
                }
        )
    }

    private var conversationSurface: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if store.messages.isEmpty {
                    emptyConversation
                } else {
                    activeConversation
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if !inspectorOutputs.isEmpty {
                inspector
                    .frame(width: 238)
                    .padding(.top, 58)
                    .padding(.trailing, 16)
            }

        }
        .foregroundStyle(MainPalette.foreground(colorScheme))
        .background(MainPalette.mainBackground(colorScheme))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var emptyConversation: some View {
        ZStack {
            if !store.changelogs.isEmpty {
                VStack(spacing: 10) {
                    Spacer()
                    HStack(spacing: -28) {
                        ForEach(store.changelogs.prefix(3)) { changelog in
                            Button {
                                Task { await store.openChangelog(changelog) }
                            } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    Rectangle()
                                        .fill(LinearGradient(
                                            colors: [Color(hex: 0xEAF1F8), Color(hex: 0xBFD3E5)],
                                            startPoint: .topLeading,
                                            endPoint: .bottomTrailing
                                        ))
                                        .frame(height: 112)
                                    Text(changelog.headline)
                                        .font(.system(size: 12, weight: .medium))
                                        .foregroundStyle(Color(hex: 0x3D3328))
                                        .lineLimit(1)
                                }
                                .padding(9)
                                .frame(width: 210, height: 172, alignment: .top)
                                .background(.white)
                                .shadow(color: Color.black.opacity(0.13), radius: 2, x: 1, y: 2)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.bottom, 18)
                    composer
                    Spacer()
                }
            } else {
                composer
                    .frame(maxWidth: 654)
            }
        }
        .padding(.horizontal, 24)
    }

    private var activeConversation: some View {
        GeometryReader { geometry in
            let transcriptWidth = max(
                0,
                geometry.size.width - (MainConversationLayout.horizontalInset * 2)
            )
            let readingColumnWidth = min(
                MainConversationLayout.readingWidth,
                transcriptWidth
            )
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(store.messages) { message in
                            MainMessageView(
                                message: message,
                                edit: { store.editMessage(message) },
                                retry: { store.retryMessage(message) },
                                addToDraft: { store.addMessageToDraft(message) }
                            )
                            .id(message.id)
                            .frame(
                                width: readingColumnWidth,
                                alignment: message.role == "user" ? .trailing : .leading
                            )

                            if message.id == reasoningAnchorMessageID, !reasoningActivities.isEmpty {
                                MainReasoningView(
                                    activities: reasoningActivities,
                                    running: store.isRunning
                                )
                                .id(MainConversationLayout.reasoningViewID)
                                .frame(width: readingColumnWidth, alignment: .leading)
                            }
                        }
                    }
                    .frame(width: readingColumnWidth, alignment: .leading)
                    .padding(.top, 56)
                    .padding(.bottom, 28)
                    .frame(width: transcriptWidth, alignment: .center)
                    .frame(maxWidth: .infinity, alignment: .center)
                }
                .scrollIndicators(.hidden)
                // Keep the stationary controls in the scroll view's own safe
                // area. This gives SwiftUI the relationship it needs to
                // render the native soft transition over content scrolling
                // behind the composer.
                .safeAreaBar(edge: .bottom, spacing: 0) {
                    activeConversationControls
                }
                .scrollEdgeEffectStyle(.soft, for: .bottom)
                .onChange(of: store.messages) { _, messages in
                    if let id = messages.last?.id {
                        withAnimation { proxy.scrollTo(id, anchor: .bottom) }
                    }
                }
                .onChange(of: reasoningActivities) { _, activities in
                    guard !activities.isEmpty else { return }
                    withAnimation {
                        proxy.scrollTo(MainConversationLayout.reasoningViewID, anchor: .bottom)
                    }
                }
            }
        }
    }

    private var activeConversationControls: some View {
        VStack(spacing: 0) {
            if let approval = store.pendingApproval {
                approvalCard(approval)
            }
            if let queued = store.queuedPrompt {
                HStack {
                    Image(systemName: "arrow.turn.down.right")
                    Text(queued).lineLimit(1)
                    Spacer()
                    Button("Edit") { store.draft = queued; store.queuedPrompt = nil }
                    Button("Delete") { store.queuedPrompt = nil }
                }
                .font(.caption).padding(10).background(.quaternary)
            }
            composer
                .padding(.bottom, 32)
        }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if !store.attachments.isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(Array(store.attachments.enumerated()), id: \.offset) { index, attachment in
                            ZStack(alignment: .topTrailing) {
                                if let image = DataURLDecoder.image(attachment.dataURL) {
                                    Image(nsImage: image).resizable().scaledToFill()
                                        .frame(width: 74, height: 58)
                                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                                }
                                Button { store.removeAttachment(at: index) } label: {
                                    Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.65))
                                }
                                .buttonStyle(.plain).offset(x: 5, y: -5)
                            }
                        }
                    }
                    .padding(.top, 5)
                }
            }
            HStack(alignment: .bottom) {
                Menu {
                    Button("Attach images…") { store.chooseImages() }
                    Button("Paste image") { store.pasteImages() }
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 14))
                        .frame(width: 24, height: 36)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .frame(height: MainComposerMetrics.actionHeight, alignment: .center)
                .frame(maxHeight: .infinity, alignment: .bottom)

                MainComposerTextView(
                    text: $store.draft,
                    measuredHeight: $composerTextHeight,
                    placeholder: "Do Anything",
                    onSubmit: send
                )
                .frame(height: composerTextHeight)
                .frame(maxHeight: .infinity, alignment: .bottom)

                Menu {
                    Button("Ask for approval") { store.permissionMode = "default" }
                    Button("Plan") { store.permissionMode = "plan" }
                } label: {
                    Text(store.permissionMode == "plan" ? "Plan" : "Ask for approval")
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .frame(height: 36)
                        .background(
                            permissionModeHovering
                                ? MainPalette.modeChipHover(colorScheme)
                                : MainPalette.modeChip(colorScheme),
                            in: Capsule()
                        )
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .frame(height: MainComposerMetrics.actionHeight, alignment: .center)
                .frame(maxHeight: .infinity, alignment: .bottom)
                .onHover { permissionModeHovering = $0 }

                Spacer()
                if store.isRunning {
                    Button { Task { await store.stop() } } label: {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(MainPalette.mainBackground(colorScheme))
                            .frame(width: 36, height: 36)
                            .background(MainPalette.foreground(colorScheme), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .frame(height: MainComposerMetrics.actionHeight, alignment: .center)
                    .frame(maxHeight: .infinity, alignment: .bottom)
                } else {
                    Button(action: send) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(sendDisabled ? Color(hex: 0x87898D) : MainPalette.mainBackground(colorScheme))
                            .frame(width: 36, height: 36)
                            .background(sendDisabled ? Color(hex: 0xE0E0E0) : MainPalette.foreground(colorScheme), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(sendDisabled)
                    .frame(height: MainComposerMetrics.actionHeight, alignment: .center)
                    .frame(maxHeight: .infinity, alignment: .bottom)
                }
            }
            .frame(
                height: max(MainComposerMetrics.actionHeight, composerTextHeight),
                alignment: .bottom
            )
        }
        .padding(.vertical, 8)
        .padding(.leading, 24)
        .padding(.trailing, 8)
        .frame(maxWidth: 654)
        // Use SwiftUI's native macOS 26 Liquid Glass surface. The regular
        // variant remains legible on the conversation's near-white canvas,
        // while interactive() supplies the system pointer response.
        .glassEffect(
            .regular
                .tint(
                    Color.white
                        .opacity(composerGlassDepthTintOpacity)
                )
                .interactive(),
            in: .rect(cornerRadius: MainComposerMetrics.glassCornerRadius)
        )
        .background {
            MainComposerFigmaShadows()
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
        .matchedGeometryEffect(id: "main-composer", in: composerTransition)
        .dropDestination(for: URL.self) { urls, _ in
            store.addImages(urls)
            return true
        }
    }

    private func send() {
        if store.messages.isEmpty {
            withAnimation(.smooth(duration: MainComposerMetrics.placementAnimationDuration)) {
                store.send()
            }
        } else {
            store.send()
        }
    }

    private var sendDisabled: Bool {
        store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && store.attachments.isEmpty
    }

    private var composerGlassDepthTintOpacity: Double {
        inheritedControlActiveState == .inactive
            ? MainComposerMetrics.inactiveGlassDepthTintOpacity
            : MainComposerMetrics.glassDepthTintOpacity
    }

    private var reasoningAnchorMessageID: UUID? {
        store.messages.last(where: { $0.role == "user" })?.id
    }

    private var reasoningActivities: [DesktopOutputItem] {
        store.outputs.filter { output in
            switch output.kind {
            case .activity:
                output.title != "Connected"
            case .command, .file:
                true
            case .diff, .source:
                false
            }
        }
    }

    private func approvalCard(_ approval: AgentApprovalRequest) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(approval.title).font(.headline)
            Text(approval.detail).font(.caption).foregroundStyle(.secondary)
            if let diff = approval.diff, !diff.isEmpty {
                ScrollView(.horizontal) { Text(diff).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                    .frame(maxHeight: 120)
            }
            HStack {
                Button("Reject") { Task { await store.approve("reject_once") } }
                Spacer()
                Button("Allow for session") { Task { await store.approve("allow_for_session") } }
                Button("Allow once") { Task { await store.approve("allow_once") } }.buttonStyle(.borderedProminent)
            }
        }
        .padding(14)
        .frame(maxWidth: 654)
        .background(MainPalette.raised(colorScheme), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(MainPalette.divider(colorScheme)))
        .padding(.horizontal, 16)
    }

    private var inspector: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Outputs & Sources")
                .font(.system(size: 13, weight: .semibold))
                .padding(.horizontal, 12)
                .padding(.top, 12)
                .padding(.bottom, 8)
            ScrollView {
                LazyVStack(spacing: 4) {
                    ForEach(inspectorOutputs) { output in
                    DisclosureGroup {
                        Text(output.detail).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 6)
                    } label: {
                        Label(output.title, systemImage: icon(for: output.kind))
                            .font(.system(size: 12))
                            .lineLimit(1)
                    }
                    .padding(.horizontal, 4)
                    }
                }
                .padding(8)
            }
        }
        .foregroundStyle(.secondary)
        .background(MainPalette.raised(colorScheme).opacity(0.96), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(MainPalette.divider(colorScheme)))
        .shadow(color: Color.black.opacity(0.18), radius: 26, y: 12)
        .frame(maxHeight: 520)
    }

    private var inspectorOutputs: [DesktopOutputItem] {
        store.outputs.filter { $0.kind != .activity }
    }

    private func icon(for kind: DesktopOutputItem.Kind) -> String {
        switch kind {
        case .file: "doc"
        case .diff: "doc.text.magnifyingglass"
        case .command: "terminal"
        case .source: "link"
        case .activity: "bolt"
        }
    }
}

enum MainSidebarMetrics {
    static let minimumWidth: CGFloat = 240
    static let defaultWidth: CGFloat = 320
    static let maximumWidth: CGFloat = 420
    static let handleWidth: CGFloat = 10

    static func clamp(_ width: CGFloat) -> CGFloat {
        min(maximumWidth, max(minimumWidth, width))
    }
}

private struct MainWindowGlassBackground: View {
    var body: some View {
        MainWindowVisualEffectView(
            material: .underWindowBackground,
            blendingMode: .behindWindow,
            state: .active
        )
        .overlay {
            Color.white.opacity(0.08)
                .allowsHitTesting(false)
        }
    }
}

struct MainWindowVisualEffectView: NSViewRepresentable {
    let material: NSVisualEffectView.Material
    let blendingMode: NSVisualEffectView.BlendingMode
    let state: NSVisualEffectView.State

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        configure(view)
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        configure(view)
    }

    private func configure(_ view: NSVisualEffectView) {
        view.material = material
        view.blendingMode = blendingMode
        view.state = state
        view.isEmphasized = false
    }
}

enum MainPalette {
    static func foreground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0xEEF2F7) : Color.black.opacity(0.86)
    }

    static func responseForeground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.white.opacity(0.80) : Color.black.opacity(0.80)
    }

    static func mainBackground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0x0F1117) : .white
    }

    static func raised(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0x2C313F) : Color(hex: 0xF4F7FC)
    }

    static func divider(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0x4B5468).opacity(0.3) : Color.black.opacity(0.10)
    }

    static func navActive(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.black.opacity(0.34) : Color.black.opacity(0.105)
    }

    static func hover(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.black.opacity(0.24) : Color.black.opacity(0.065)
    }

    static func modeChip(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.white.opacity(0.10) : Color(hex: 0xD5E1EF).opacity(0.72)
    }

    static func modeChipHover(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0x4B5468) : Color(hex: 0xD5E1EF)
    }

    static func userMessage(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.white.opacity(0.10) : Color(hex: 0xD5E1EF).opacity(0.52)
    }

    static func codeBackground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0x05070A) : Color(hex: 0xEEF5FE)
    }

    static func tableHeaderBackground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0x262626) : Color(hex: 0xF5F5F5)
    }
}

private extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

struct JesseBrandMark: View {
    var body: some View {
        Group {
            if let image = JesseBrandAssets.image {
                Image(nsImage: image).resizable().scaledToFit()
            } else {
                Image(systemName: "sparkles")
                    .font(.system(size: 15, weight: .medium))
            }
        }
        .padding(4)
    }
}

@MainActor
private enum JesseBrandAssets {
    static let image: NSImage? = {
        if let url = Bundle.main.url(forResource: "JesseMark", withExtension: "png") {
            return NSImage(contentsOf: url)
        }
#if DEBUG
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("desktop-app/assets/jesse-mark.png")
        return NSImage(contentsOf: source)
#else
        return nil
#endif
    }()
}

enum MainConversationTypography {
    static let headingFontSize: CGFloat = 16
    static let bodyFontSize: CGFloat = 14
    static let auxiliaryFontSize: CGFloat = 13
}

enum MainConversationLayout {
    static let readingWidth: CGFloat = 654
    static let horizontalInset: CGFloat = 16
    static let reasoningViewID = "conversation.reasoning"
}

enum MainMarkdownTableMetrics {
    static let horizontalCellPadding: CGFloat = 12
    static let bodyVerticalCellPadding: CGFloat = 9
    static let headerVerticalCellPadding: CGFloat = 10
    static let textLineSpacing: CGFloat = 4
    static let blockVerticalPadding: CGFloat = 4
    static let cornerRadius: CGFloat = 10
    static let firstColumnMinimumWidth: CGFloat = 88
    static let firstColumnIdealWidth: CGFloat = 104
    static let firstColumnMaximumWidth: CGFloat = 128
    static let otherColumnMinimumWidth: CGFloat = 180
    static let otherColumnIdealWidth: CGFloat = 240
    static let otherColumnMaximumWidth: CGFloat = 420
}

private struct MainMarkdownTableHeaderBoundsPreferenceKey: PreferenceKey {
    static var defaultValue: [Anchor<CGRect>] = []

    static func reduce(value: inout [Anchor<CGRect>], nextValue: () -> [Anchor<CGRect>]) {
        value.append(contentsOf: nextValue())
    }
}

enum MainComposerMetrics {
    static let actionHeight: CGFloat = 36
    static let placementAnimationDuration = 0.42
    static let glassCornerRadius: CGFloat = 30
    static let glassDepthTintOpacity: Double = 0.30
    // Liquid Glass applies a denser, grayer tint when its window is inactive.
    // Removing our additional white tint in that state keeps the native glass
    // fill aligned with the focused 30% treatment.
    static let inactiveGlassDepthTintOpacity: Double = 0
    static let figmaShadowLayers = [
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
    ]
    static let textFontSize = MainConversationTypography.bodyFontSize
    static let textVerticalInset: CGFloat = 9.5
    static let minimumTextHeight: CGFloat = actionHeight
    static let maximumTextHeight: CGFloat = 144

    static func clampedTextHeight(_ contentHeight: CGFloat) -> CGFloat {
        min(max(ceil(contentHeight), minimumTextHeight), maximumTextHeight)
    }
}

struct MainComposerShadowLayer: Equatable {
    let colorHex: UInt32
    let opacity: Double
    let x: CGFloat
    let y: CGFloat
    let blur: CGFloat
    let spread: CGFloat
    let showsBehindTransparentAreas: Bool
}

private struct MainComposerFigmaShadows: View {
    // A 48 pt Figma blur needs more than 48 pt of drawing room for its
    // Gaussian falloff. The expanded Canvas never participates in layout.
    private let overflow: CGFloat = 112

    var body: some View {
        GeometryReader { proxy in
            Canvas { context, canvasSize in
                let composerRect = CGRect(
                    x: overflow,
                    y: overflow,
                    width: proxy.size.width,
                    height: proxy.size.height
                )
                let composerPath = Path(
                    roundedRect: composerRect,
                    cornerRadius: MainComposerMetrics.glassCornerRadius
                )

                // Figma lists the visually frontmost effect first.
                for shadow in MainComposerMetrics.figmaShadowLayers.reversed() {
                    let shadowRect = composerRect.insetBy(
                        dx: -shadow.spread,
                        dy: -shadow.spread
                    )
                    let shadowPath = Path(
                        roundedRect: shadowRect,
                        cornerRadius: max(
                            0,
                            MainComposerMetrics.glassCornerRadius + shadow.spread
                        )
                    )

                    context.drawLayer { layer in
                        // Keep the three zero-blur stroke-building layers
                        // outside the glass. Only the blue ambient shadow is
                        // allowed behind the translucent surface.
                        if !shadow.showsBehindTransparentAreas {
                            var exterior = Path(CGRect(origin: .zero, size: canvasSize))
                            exterior.addPath(composerPath)
                            layer.clip(to: exterior, style: FillStyle(eoFill: true))
                        }
                        layer.addFilter(.shadow(
                            color: Color(hex: shadow.colorHex).opacity(shadow.opacity),
                            radius: shadow.blur,
                            x: shadow.x,
                            y: shadow.y,
                            options: .shadowOnly
                        ))
                        layer.fill(shadowPath, with: .color(.white))
                    }
                }
            }
            .frame(
                width: proxy.size.width + overflow * 2,
                height: proxy.size.height + overflow * 2
            )
            .offset(x: -overflow, y: -overflow)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct MainComposerTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var measuredHeight: CGFloat
    let placeholder: String
    let onSubmit: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = ComposerScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = false
        scrollView.borderType = .noBorder
        scrollView.documentCursor = .iBeam

        let textView = SubmitTextView()
        textView.delegate = context.coordinator
        textView.submit = onSubmit
        textView.isRichText = false
        textView.isEditable = true
        textView.isSelectable = true
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.font = .systemFont(ofSize: MainComposerMetrics.textFontSize)
        textView.textContainerInset = NSSize(
            width: 0,
            height: MainComposerMetrics.textVerticalInset
        )
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(
            width: scrollView.contentSize.width,
            height: .greatestFiniteMagnitude
        )
        textView.minSize = NSSize(width: 0, height: MainComposerMetrics.minimumTextHeight)
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.frame = NSRect(origin: .zero, size: scrollView.contentSize)
        textView.string = text
        textView.placeholderText = placeholder
        scrollView.documentView = textView
        scrollView.didLayout = { [weak scrollView, weak coordinator = context.coordinator] in
            guard let scrollView, let coordinator else { return }
            coordinator.updateHeight(in: scrollView)
        }
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? SubmitTextView else { return }
        context.coordinator.parent = self
        textView.submit = onSubmit
        if textView.string != text { textView.string = text }
        textView.needsDisplay = true
        context.coordinator.updateHeight(in: scrollView)
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MainComposerTextView
        init(parent: MainComposerTextView) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
            textView.needsDisplay = true
            if let scrollView = textView.enclosingScrollView {
                updateHeight(in: scrollView)
            }
        }

        func updateHeight(in scrollView: NSScrollView) {
            guard let textView = scrollView.documentView as? NSTextView,
                  let textContainer = textView.textContainer,
                  let layoutManager = textView.layoutManager else { return }

            let availableWidth = scrollView.contentSize.width
            guard availableWidth > 0 else { return }

            textContainer.containerSize = NSSize(
                width: availableWidth,
                height: .greatestFiniteMagnitude
            )
            layoutManager.ensureLayout(for: textContainer)

            let font = textView.font ?? NSFont.systemFont(ofSize: MainComposerMetrics.textFontSize)
            let laidOutTextHeight = max(
                layoutManager.defaultLineHeight(for: font),
                layoutManager.usedRect(for: textContainer).height
            )
            let contentHeight = laidOutTextHeight + (textView.textContainerInset.height * 2)
            let nextHeight = MainComposerMetrics.clampedTextHeight(contentHeight)
            let documentHeight = max(nextHeight, ceil(contentHeight))
            if abs(textView.frame.width - availableWidth) > 0.5
                || abs(textView.frame.height - documentHeight) > 0.5 {
                textView.setFrameSize(NSSize(width: availableWidth, height: documentHeight))
            }

            guard abs(parent.measuredHeight - nextHeight) > 0.5 else { return }
            DispatchQueue.main.async { [weak self] in
                guard let self,
                      abs(self.parent.measuredHeight - nextHeight) > 0.5 else { return }
                self.parent.measuredHeight = nextHeight
            }
        }
    }

    final class SubmitTextView: NSTextView {
        var submit: (() -> Void)?
        var placeholderText = ""

        override func draw(_ dirtyRect: NSRect) {
            super.draw(dirtyRect)
            guard string.isEmpty, !placeholderText.isEmpty else { return }
            placeholderText.draw(
                at: NSPoint(x: 0, y: textContainerOrigin.y + 1),
                withAttributes: [
                    .font: font ?? NSFont.systemFont(ofSize: MainComposerMetrics.textFontSize),
                    .foregroundColor: NSColor.placeholderTextColor,
                ]
            )
        }

        override func doCommand(by selector: Selector) {
            let modifiers = NSApp.currentEvent?.modifierFlags ?? []
            if selector == #selector(insertNewline(_:)), !modifiers.contains(.shift) {
                submit?()
                return
            }
            super.doCommand(by: selector)
        }

        override func performKeyEquivalent(with event: NSEvent) -> Bool {
            guard event.type == .keyDown,
                  event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                  let key = event.charactersIgnoringModifiers?.lowercased() else {
                return super.performKeyEquivalent(with: event)
            }

            switch key {
            case "c":
                copy(self)
                return true
            case "v":
                paste(self)
                return true
            case "x":
                cut(self)
                return true
            case "a":
                selectAll(self)
                return true
            default:
                return super.performKeyEquivalent(with: event)
            }
        }

        override func resetCursorRects() {
            super.resetCursorRects()
            addCursorRect(bounds, cursor: .iBeam)
        }
    }

    final class ComposerScrollView: NSScrollView {
        var didLayout: (() -> Void)?

        override func layout() {
            super.layout()
            didLayout?()
        }

        override func resetCursorRects() {
            super.resetCursorRects()
            addCursorRect(bounds, cursor: .iBeam)
        }
    }
}

private struct MainChangelogDetailView: View {
    let detail: DesktopDailyChangelogDetail
    let imageURL: URL?
    let close: () -> Void
    let openSession: (String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(detail.headline).font(.title2).fontWeight(.semibold)
                    Text("\(detail.projectName) · \(detail.date)").foregroundStyle(.secondary)
                }
                Spacer()
                Button("Done", action: close).keyboardShortcut(.cancelAction)
            }
            .padding(20)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let imageURL {
                        AsyncImage(url: imageURL) { image in
                            image.resizable().scaledToFit()
                        } placeholder: {
                            ProgressView().frame(maxWidth: .infinity, minHeight: 180)
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    Text(detail.summary).font(.body).textSelection(.enabled)
                    ForEach(Array(detail.highlights.enumerated()), id: \.offset) { _, highlight in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(highlight.title).font(.headline)
                            Text(highlight.detail).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                    }
                    if !detail.changedFiles.isEmpty {
                        GroupBox("Changed files") {
                            VStack(alignment: .leading, spacing: 5) {
                                ForEach(detail.changedFiles, id: \.self) { file in
                                    Text(file).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                                }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    if !detail.verification.isEmpty {
                        GroupBox("Verification") {
                            VStack(alignment: .leading, spacing: 5) {
                                ForEach(detail.verification, id: \.self) { item in Label(item, systemImage: "checkmark.circle") }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    if !detail.sourceSessions.isEmpty {
                        GroupBox("Source chats") {
                            VStack(alignment: .leading, spacing: 8) {
                                ForEach(detail.sourceSessions, id: \.self) { sessionID in
                                    Button(sessionID) { openSession(sessionID) }
                                }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                .padding(22)
            }
        }
        .frame(minWidth: 680, idealWidth: 760, minHeight: 560, idealHeight: 700)
    }
}

private struct MainReasoningView: View {
    let activities: [DesktopOutputItem]
    let running: Bool
    @Environment(\.colorScheme) private var colorScheme
    @State private var isExpanded = true

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { isExpanded.toggle() } label: {
                HStack(spacing: 8) {
                    if running {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "checkmark.circle")
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                    }

                    Text("Reasoning")
                        .font(.system(size: MainConversationTypography.bodyFontSize, weight: .medium))

                    if !isExpanded, let latestActivity {
                        Text(latestActivity.title)
                            .font(.system(size: MainConversationTypography.auxiliaryFontSize))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(visibleActivities) { activity in
                        MainReasoningActivityRow(
                            activity: activity,
                            active: running && activity.id == latestActivity?.id
                        )
                    }
                }
                .padding(.leading, 4)
            }
        }
        .foregroundStyle(MainPalette.responseForeground(colorScheme))
        .padding(.top, 4)
        .padding(.bottom, 2)
        .accessibilityIdentifier(MainConversationLayout.reasoningViewID)
        .onChange(of: running) { wasRunning, isRunning in
            if wasRunning && !isRunning { isExpanded = false }
        }
    }

    private var latestActivity: DesktopOutputItem? { activities.last }
    private var visibleActivities: ArraySlice<DesktopOutputItem> { activities.suffix(6) }
}

private struct MainReasoningActivityRow: View {
    let activity: DesktopOutputItem
    let active: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            statusIcon
                .frame(width: 14)

            Text(activity.title)
                .font(.system(size: MainConversationTypography.auxiliaryFontSize, weight: .medium))
                .lineLimit(1)

            if !activity.detail.isEmpty {
                Text(activity.detail)
                    .font(.system(size: MainConversationTypography.auxiliaryFontSize))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    @ViewBuilder
    private var statusIcon: some View {
        if active {
            ProgressView()
                .controlSize(.mini)
        } else if activity.succeeded == false {
            Image(systemName: "xmark.circle")
                .foregroundStyle(.red)
        } else if activity.succeeded == true {
            Image(systemName: "checkmark.circle")
                .foregroundStyle(.secondary)
        } else {
            Image(systemName: "circle.fill")
                .font(.system(size: 5))
                .foregroundStyle(.tertiary)
        }
    }
}

struct MainMessageView: View {
    let message: MainConversationMessage
    let edit: () -> Void
    let retry: () -> Void
    let addToDraft: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var isHovering = false

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 0) {
                if isUser { Spacer(minLength: 22) }
                messageContent
                    .frame(
                        maxWidth: isUser ? 510 : .infinity,
                        alignment: isUser ? .trailing : .leading
                    )
                if !isUser { Spacer(minLength: 0) }
            }

            HStack(spacing: 6) {
                if isUser { Spacer(minLength: 0) }
                if !messageTime.isEmpty {
                    Text(messageTime)
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                messageAction("doc.on.doc", help: "Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(message.text, forType: .string)
                }
                if isUser {
                    messageAction("square.and.pencil", help: "Edit") { edit() }
                }
                if !isUser { Spacer(minLength: 0) }
            }
            .frame(height: 24)
            .opacity(isHovering ? 1 : 0)
            .accessibilityHidden(!isHovering)
            .animation(.easeOut(duration: 0.12), value: isHovering)
        }
        .frame(
            maxWidth: isUser ? .infinity : MainConversationLayout.readingWidth,
            alignment: isUser ? .trailing : .leading
        )
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .center)
        .padding(.top, 16)
        .contentShape(Rectangle())
        .onHover { isHovering = $0 }
        .contextMenu {
            Button("Copy") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(message.text, forType: .string)
            }
            if isUser {
                Button("Edit") { edit() }
                Button("Retry") { retry() }
            }
            Button("Add to prompt") { addToDraft() }
        }
    }

    private var messageContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !message.attachments.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(Array(message.attachments.enumerated()), id: \.offset) { _, attachment in
                            MainAttachmentView(attachment: attachment)
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }
            if !message.text.isEmpty {
                MainMarkdownView(value: message.text)
            }
        }
        .font(.system(size: MainConversationTypography.bodyFontSize))
        .foregroundStyle(isUser ? MainPalette.foreground(colorScheme) : MainPalette.responseForeground(colorScheme))
        .lineSpacing(5)
        .padding(.horizontal, isUser ? 16 : 0)
        .padding(.vertical, isUser ? 10 : 0)
        .background(
            isUser ? MainPalette.userMessage(colorScheme) : .clear,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
    }

    private var isUser: Bool { message.role == "user" }

    private var messageTime: String {
        guard let value = message.createdAt else { return "" }
        let formatter = ISO8601DateFormatter()
        guard let date = formatter.date(from: value) else { return "" }
        return date.formatted(date: .omitted, time: .shortened)
    }

    private func messageAction(_ systemName: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 12))
                .foregroundStyle(.tertiary)
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

private struct MainMarkdownView: View {
    let value: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(MainMarkdownParser.parse(value).enumerated()), id: \.offset) { _, block in
                switch block {
                case .markdown(let text):
                    MainMarkdownTextView(value: text)
                case .code(let language, let content):
                    VStack(alignment: .leading, spacing: 0) {
                        HStack {
                            Text(language.isEmpty ? "Code" : language)
                                .font(.system(size: MainConversationTypography.auxiliaryFontSize))
                                .foregroundStyle(.secondary)
                            Spacer()
                            Button {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(content, forType: .string)
                            } label: { Image(systemName: "doc.on.doc") }
                            .buttonStyle(.plain).help("Copy code")
                        }
                        .padding(.horizontal, 10)
                        .frame(height: 32)
                        Divider().opacity(0.5)
                        ScrollView(.horizontal) {
                            Text(content)
                                .font(.system(size: MainConversationTypography.auxiliaryFontSize, design: .monospaced))
                                .textSelection(.enabled)
                                .lineSpacing(3)
                                .padding(12)
                        }
                    }
                    .background(MainPalette.codeBackground(colorScheme), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(MainPalette.divider(colorScheme)))
                case .table(let headers, let rows):
                    MainMarkdownTableView(headers: headers, rows: rows)
                        .padding(.vertical, MainMarkdownTableMetrics.blockVerticalPadding)
                }
            }
        }
    }

}

private struct MainMarkdownTextView: View {
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(MainMarkdownTextParser.parse(value).enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let text):
                    markdown(text)
                        .font(.system(size: MainConversationTypography.headingFontSize, weight: .bold))
                        .textSelection(.enabled)
                case .body(let text):
                    markdown(text)
                        .font(.system(size: MainConversationTypography.bodyFontSize, weight: .regular))
                        .textSelection(.enabled)
                }
            }
        }
    }

    private func markdown(_ value: String) -> Text {
        guard let attributed = MainMarkdownTextStyler.attributed(value) else { return Text(value) }
        return Text(attributed)
    }
}

private struct MainMarkdownTableView: View {
    let headers: [String]
    let rows: [[String]]
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    cells(headers, isHeader: true)
                }
                .anchorPreference(
                    key: MainMarkdownTableHeaderBoundsPreferenceKey.self,
                    value: .bounds,
                    transform: { [$0] }
                )
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    Divider().opacity(0.55).gridCellColumns(max(1, headers.count))
                    GridRow {
                        cells(row, isHeader: false)
                    }
                    .id(index)
                }
            }
            .frame(minWidth: 620, alignment: .leading)
            .backgroundPreferenceValue(MainMarkdownTableHeaderBoundsPreferenceKey.self) { anchors in
                GeometryReader { proxy in
                    let frames = anchors.map { proxy[$0] }
                    if let minY = frames.map(\.minY).min(),
                       let maxY = frames.map(\.maxY).max() {
                        Rectangle()
                            .fill(MainPalette.tableHeaderBackground(colorScheme))
                            .frame(width: proxy.size.width, height: maxY - minY)
                            .offset(y: minY)
                    }
                }
            }
        }
        .scrollIndicators(.hidden)
        .background(MainPalette.mainBackground(colorScheme))
        .clipShape(RoundedRectangle(cornerRadius: MainMarkdownTableMetrics.cornerRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: MainMarkdownTableMetrics.cornerRadius, style: .continuous)
                .stroke(MainPalette.divider(colorScheme))
        )
    }

    @ViewBuilder
    private func cells(_ values: [String], isHeader: Bool) -> some View {
        ForEach(headers.indices, id: \.self) { index in
            markdown(index < values.count ? values[index] : "")
                .font(.system(size: MainConversationTypography.auxiliaryFontSize, weight: isHeader ? .semibold : .regular))
                .lineSpacing(MainMarkdownTableMetrics.textLineSpacing)
                .textSelection(.enabled)
                .padding(.horizontal, MainMarkdownTableMetrics.horizontalCellPadding)
                .padding(
                    .vertical,
                    isHeader
                        ? MainMarkdownTableMetrics.headerVerticalCellPadding
                        : MainMarkdownTableMetrics.bodyVerticalCellPadding
                )
                .frame(
                    minWidth: index == 0
                        ? MainMarkdownTableMetrics.firstColumnMinimumWidth
                        : MainMarkdownTableMetrics.otherColumnMinimumWidth,
                    idealWidth: index == 0
                        ? MainMarkdownTableMetrics.firstColumnIdealWidth
                        : MainMarkdownTableMetrics.otherColumnIdealWidth,
                    maxWidth: index == 0
                        ? MainMarkdownTableMetrics.firstColumnMaximumWidth
                        : MainMarkdownTableMetrics.otherColumnMaximumWidth,
                    alignment: .leading
                )
        }
    }

    private func markdown(_ value: String) -> Text {
        guard let attributed = MainMarkdownTextStyler.attributed(value) else { return Text(value) }
        return Text(attributed)
    }
}

private struct MainAttachmentView: View {
    let attachment: AgentImageAttachment

    var body: some View {
        Group {
            if let dataURL = attachment.dataURL, let image = DataURLDecoder.image(dataURL) {
                Image(nsImage: image).resizable().scaledToFit()
            } else if let url = attachment.url, let remote = URL(string: url, relativeTo: AgentServerManager.baseURL) {
                AsyncImage(url: remote) { image in image.resizable().scaledToFit() } placeholder: { ProgressView() }
            } else {
                Image(systemName: "photo")
            }
        }
        .frame(width: 180, height: 130)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}
