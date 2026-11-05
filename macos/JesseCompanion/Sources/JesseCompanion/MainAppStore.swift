import AppKit
import Combine
import Foundation
import UniformTypeIdentifiers

enum MainConversationScope: Equatable {
    case chat
    case project(String)
}

enum MainMarkdownBlock: Equatable {
    case markdown(String)
    case code(language: String, content: String)
    case table(headers: [String], rows: [[String]])
}

enum MainMarkdownTextBlock: Equatable {
    case heading(String)
    case body(String)
}

enum MainMarkdownTextParser {
    static func parse(_ value: String) -> [MainMarkdownTextBlock] {
        let lines = value.components(separatedBy: .newlines)
        var blocks: [MainMarkdownTextBlock] = []
        var body: [String] = []

        func flushBody() {
            let text = body.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !text.isEmpty { blocks.append(.body(text)) }
            body.removeAll(keepingCapacity: true)
        }

        for line in lines {
            if let heading = headingText(line) {
                flushBody()
                blocks.append(.heading(heading))
            } else {
                body.append(line)
            }
        }
        flushBody()
        return blocks
    }

    private static func headingText(_ line: String) -> String? {
        let trimmed = line.drop { $0 == " " || $0 == "\t" }
        let markers = trimmed.prefix { $0 == "#" }
        guard (1...6).contains(markers.count) else { return nil }
        let remainder = trimmed.dropFirst(markers.count)
        guard remainder.first == " " else { return nil }
        let text = remainder.dropFirst().trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : text
    }
}

enum MainMarkdownTextStyler {
    static func attributed(_ value: String) -> AttributedString? {
        guard var attributed = try? AttributedString(markdown: value) else { return nil }
        let strongRanges = attributed.runs.compactMap { run -> Range<AttributedString.Index>? in
            guard run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true else { return nil }
            return run.range
        }
        for range in strongRanges {
            var intent = attributed[range].inlinePresentationIntent
            intent?.remove(.stronglyEmphasized)
            attributed[range].inlinePresentationIntent = intent
        }
        return attributed
    }
}

enum MainMarkdownParser {
    static func parse(_ value: String) -> [MainMarkdownBlock] {
        let lines = value.components(separatedBy: .newlines)
        var blocks: [MainMarkdownBlock] = []
        var markdown: [String] = []
        var index = 0

        func flushMarkdown() {
            let text = markdown.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !text.isEmpty { blocks.append(.markdown(text)) }
            markdown.removeAll(keepingCapacity: true)
        }

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let fence = fencePrefix(trimmed) {
                flushMarkdown()
                let language = String(trimmed.dropFirst(fence.count)).trimmingCharacters(in: .whitespaces)
                index += 1
                var content: [String] = []
                while index < lines.count,
                      !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    content.append(lines[index])
                    index += 1
                }
                if index < lines.count { index += 1 }
                blocks.append(.code(language: language, content: content.joined(separator: "\n")))
                continue
            }

            if index + 1 < lines.count,
               isTableRow(line),
               isTableSeparator(lines[index + 1]) {
                flushMarkdown()
                let headers = tableCells(line)
                index += 2
                var rows: [[String]] = []
                while index < lines.count, isTableRow(lines[index]) {
                    rows.append(tableCells(lines[index]))
                    index += 1
                }
                blocks.append(.table(headers: headers, rows: rows))
                continue
            }

            markdown.append(line)
            index += 1
        }
        flushMarkdown()
        return blocks
    }

    private static func fencePrefix(_ line: String) -> String? {
        let prefix = String(line.prefix { $0 == "`" })
        return prefix.count >= 3 ? prefix : nil
    }

    private static func isTableRow(_ line: String) -> Bool {
        tableCells(line).count >= 2 && line.contains("|")
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let cells = tableCells(line)
        return cells.count >= 2 && cells.allSatisfy { cell in
            let body = cell.trimmingCharacters(in: CharacterSet(charactersIn: ":- "))
            return body.isEmpty && cell.filter { $0 == "-" }.count >= 3
        }
    }

    private static func tableCells(_ line: String) -> [String] {
        var value = line.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("|") { value.removeFirst() }
        if value.hasSuffix("|") { value.removeLast() }
        return value.split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }
}

struct MainConversationMessage: Identifiable, Equatable {
    let id: UUID
    let role: String
    var text: String
    var attachments: [AgentImageAttachment]
    var runID: String?
    let createdAt: String?

    init(
        id: UUID = UUID(),
        role: String,
        text: String,
        attachments: [AgentImageAttachment] = [],
        runID: String? = nil,
        createdAt: String? = ISO8601DateFormatter().string(from: Date())
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.attachments = attachments
        self.runID = runID
        self.createdAt = createdAt
    }
}

@MainActor
final class MainAppStore: ObservableObject {
    @Published var projects: [DesktopProject] = []
    @Published var sessionsByWorkspace: [String: [DesktopSessionSummary]] = [:]
    @Published var expandedProjectPaths: Set<String>
    @Published var expandedSessionLists: Set<String> = []
    @Published var changelogs: [DesktopDailyChangelog] = []
    @Published var selectedChangelog: DesktopDailyChangelogDetail?
    @Published var selectedChangelogImageURL: URL?
    @Published var messages: [MainConversationMessage] = []
    @Published var outputs: [DesktopOutputItem] = []
    @Published var scope: MainConversationScope = .chat
    @Published var selectedSessionID: String?
    @Published var draft = ""
    @Published var permissionMode = "default"
    @Published var activeRun: AgentRunSnapshot?
    @Published var activeRuns: [String: AgentRunSnapshot] = [:]
    @Published var pendingApproval: AgentApprovalRequest?
    @Published var pendingApprovals: [String: AgentApprovalRequest] = [:]
    @Published var queuedPrompt: String?
    @Published var attachments: [DoAnythingImageAttachment] = []
    @Published var workspaceMetadata: DesktopWorkspaceMetadata?
    @Published var errorMessage: String?
    @Published var isLoading = false
    @Published private var viewedRunStates: [String: String]

    private let client: AgentClient
    private let defaults: UserDefaults
    private(set) var chatWorkspaceRoot = ""
    private var runTasks: [String: Task<Void, Never>] = [:]
    private var globalRunTask: Task<Void, Never>?
    private var assistantMessageIDs: [String: UUID] = [:]
    private var handledRunEvents: Set<String> = []
    private var locallyStreamedRunIDs: Set<String> = []
    private var sessionBootstrap: (
        id: UUID,
        workspaceRoot: String,
        generation: UInt,
        task: Task<DesktopRunStartResponse, Error>
    )?
    private var conversationGeneration: UInt = 0

    init(client: AgentClient, defaults: UserDefaults = .standard) {
        self.client = client
        self.defaults = defaults
        let storedPaths = defaults.stringArray(forKey: Self.expandedProjectsDefaultsKey) ?? []
        expandedProjectPaths = Set(storedPaths)
        viewedRunStates = defaults.dictionary(forKey: Self.viewedRunStatesDefaultsKey) as? [String: String] ?? [:]
    }

    deinit {
        for task in runTasks.values { task.cancel() }
        sessionBootstrap?.task.cancel()
        globalRunTask?.cancel()
    }

    var workspaceRoot: String {
        switch scope {
        case .chat: chatWorkspaceRoot
        case .project(let path): path
        }
    }

    var selectedProject: DesktopProject? {
        guard case .project(let path) = scope else { return nil }
        return projects.first { $0.path == path }
    }

    var sessions: [DesktopSessionSummary] {
        sessions(for: workspaceRoot)
    }

    var chatSessions: [DesktopSessionSummary] {
        sessions(for: chatWorkspaceRoot)
    }

    var isRunning: Bool {
        activeRuns.values.contains(where: { $0.status.isActive })
            || activeRun?.status.isActive == true
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        for attempt in 0..<40 {
            do {
                async let loadedProjects = client.fetchProjects()
                async let loadedChat = client.fetchChatWorkspace()
                projects = try await loadedProjects
                chatWorkspaceRoot = try await loadedChat
                try await refreshSessions(workspaceRoot: chatWorkspaceRoot)
                for project in projects {
                    try? await refreshSessions(workspaceRoot: project.path)
                }
                await startGlobalRunObservation()
                errorMessage = nil
                return
            } catch {
                if attempt == 39 {
                    errorMessage = error.localizedDescription
                    return
                }
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
    }

    func selectChat() async {
        scope = .chat
        clearConversation()
        await refreshSessionsIgnoringError(workspaceRoot: chatWorkspaceRoot)
    }

    func selectProject(_ project: DesktopProject) async {
        scope = .project(project.path)
        setProjectExpanded(project.path, expanded: true)
        clearConversation()
        await refreshSessionsIgnoringError(workspaceRoot: project.path)
        do { changelogs = try await client.fetchChangelogs(projectPath: project.path) }
        catch { changelogs = [] }
    }

    func newConversation() {
        clearConversation()
        draft = ""
    }

    func newChatConversation() async {
        scope = .chat
        clearConversation()
        draft = ""
        await refreshSessionsIgnoringError(workspaceRoot: chatWorkspaceRoot)
    }

    func newProjectConversation(_ project: DesktopProject) async {
        scope = .project(project.path)
        setProjectExpanded(project.path, expanded: true)
        clearConversation()
        draft = ""
        await refreshSessionsIgnoringError(workspaceRoot: project.path)
        do { changelogs = try await client.fetchChangelogs(projectPath: project.path) }
        catch { changelogs = [] }
    }

    func toggleProject(_ project: DesktopProject) async {
        if selectedProject?.path != project.path {
            await selectProject(project)
            return
        }
        let willExpand = !expandedProjectPaths.contains(project.path)
        setProjectExpanded(project.path, expanded: willExpand)
        if willExpand {
            await refreshSessionsIgnoringError(workspaceRoot: project.path)
        } else {
            expandedSessionLists.remove(project.path)
        }
    }

    func setProjectExpanded(_ projectPath: String, expanded: Bool) {
        if expanded { expandedProjectPaths.insert(projectPath) }
        else { expandedProjectPaths.remove(projectPath) }
        defaults.set(Array(expandedProjectPaths).sorted(), forKey: Self.expandedProjectsDefaultsKey)
    }

    func showAllSessions(for key: String) {
        expandedSessionLists.insert(key)
    }

    func sessions(for workspaceRoot: String) -> [DesktopSessionSummary] {
        guard !workspaceRoot.isEmpty else { return [] }
        return sessionsByWorkspace[workspaceRoot] ?? []
    }

    func shouldShowResultDot(for session: DesktopSessionSummary, workspaceRoot: String) -> Bool {
        guard let run = session.lastRun else { return false }
        switch run.status {
        case .completed, .failed:
            return viewedRunStates[viewedRunStateKey(sessionID: session.id, workspaceRoot: workspaceRoot)]
                != viewedRunStateFingerprint(run)
        case .queued, .running, .waitingApproval, .cancelled:
            return false
        }
    }

    func markSessionRunViewed(_ session: DesktopSessionSummary, workspaceRoot: String) {
        guard let run = session.lastRun else { return }
        let key = viewedRunStateKey(sessionID: session.id, workspaceRoot: workspaceRoot)
        let fingerprint = viewedRunStateFingerprint(run)
        guard viewedRunStates[key] != fingerprint else { return }
        viewedRunStates[key] = fingerprint
        defaults.set(viewedRunStates, forKey: Self.viewedRunStatesDefaultsKey)
    }

    func openSession(_ session: DesktopSessionSummary) async {
        await openSession(session, workspaceRoot: workspaceRoot, scope: scope)
    }

    func openSession(
        _ session: DesktopSessionSummary,
        workspaceRoot root: String,
        scope targetScope: MainConversationScope
    ) async {
        guard !root.isEmpty else { return }
        scope = targetScope
        if case .project(let projectPath) = targetScope {
            setProjectExpanded(projectPath, expanded: true)
        }
        clearConversation()
        do {
            let result = try await client.readSession(workspaceRoot: root, sessionID: session.id)
            markSessionRunViewed(session, workspaceRoot: root)
            selectedSessionID = result.sessionId ?? session.id
            messages = (result.messages ?? []).map {
                MainConversationMessage(
                    role: $0.role,
                    text: $0.content,
                    attachments: $0.attachments ?? [],
                    createdAt: $0.createdAt
                )
            }
            outputs = sourceOutputs(from: result.metadata)
            workspaceMetadata = result.metadata?.workspace
            errorMessage = nil
            await attachToActiveRun()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func send() {
        let prompt = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!prompt.isEmpty || !attachments.isEmpty), !workspaceRoot.isEmpty else { return }
        let submittedAttachments = attachments
        attachments = []
        draft = ""
        let userMessage = MainConversationMessage(
            role: "user",
            text: prompt,
            attachments: submittedAttachments.map {
                AgentImageAttachment(mimeType: $0.mimeType, dataURL: $0.dataURL, name: $0.name, source: "user")
            }
        )
        messages.append(userMessage)
        startRun(prompt: prompt, attachments: submittedAttachments, userMessageID: userMessage.id)
    }

    func chooseImages() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg, .webP]
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK else { return }
        addImages(panel.urls)
    }

    func addImages(_ urls: [URL]) {
        do {
            var next = attachments
            for url in urls {
                let data = try Data(contentsOf: url, options: .mappedIfSafe)
                let mime: String
                switch url.pathExtension.lowercased() {
                case "png": mime = "image/png"
                case "jpg", "jpeg": mime = "image/jpeg"
                case "webp": mime = "image/webp"
                default: throw ImageAttachmentError.unsupported
                }
                next = try ImageAttachmentValidator.appending(
                    data: data,
                    mimeType: mime,
                    name: url.lastPathComponent,
                    to: next
                )
            }
            attachments = next
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func pasteImages(from pasteboard: NSPasteboard = .general) {
        let fileURLs = pasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        )?.compactMap { ($0 as? NSURL).map { $0 as URL } } ?? []
        if !fileURLs.isEmpty {
            addImages(fileURLs)
            return
        }

        let directTypes: [(NSPasteboard.PasteboardType, String, String)] = [
            (.init(UTType.png.identifier), "image/png", "Pasted Image.png"),
            (.init(UTType.jpeg.identifier), "image/jpeg", "Pasted Image.jpg"),
            (.init(UTType.webP.identifier), "image/webp", "Pasted Image.webp"),
        ]
        for (type, mimeType, name) in directTypes {
            guard let data = pasteboard.data(forType: type) else { continue }
            appendPastedImage(data: data, mimeType: mimeType, name: name)
            return
        }

        if let tiff = pasteboard.data(forType: .tiff),
           let representation = NSBitmapImageRep(data: tiff),
           let png = representation.representation(using: .png, properties: [:]) {
            appendPastedImage(data: png, mimeType: "image/png", name: "Pasted Image.png")
            return
        }
        errorMessage = ImageAttachmentError.clipboardHasNoImage.localizedDescription
    }

    func removeAttachment(at index: Int) {
        guard attachments.indices.contains(index) else { return }
        attachments.remove(at: index)
    }

    func editMessage(_ message: MainConversationMessage) {
        draft = message.text
    }

    func retryMessage(_ message: MainConversationMessage) {
        draft = message.text
        send()
    }

    func addMessageToDraft(_ message: MainConversationMessage) {
        guard !message.text.isEmpty else { return }
        let quoted = message.text
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { "> \($0)" }
            .joined(separator: "\n")
        draft = [draft.trimmingCharacters(in: .whitespacesAndNewlines), quoted]
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
    }

    private func appendPastedImage(data: Data, mimeType: String, name: String) {
        do {
            attachments = try ImageAttachmentValidator.appending(
                data: data,
                mimeType: mimeType,
                name: name,
                to: attachments
            )
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func stop(runID: String? = nil) async {
        let targetRunID = runID ?? activeRuns.values
            .filter { $0.status.isActive }
            .sorted { $0.updatedAt > $1.updatedAt }
            .first?.id ?? activeRun?.id
        guard let targetRunID else { return }
        do {
            try await client.cancelAgentRun(runID: targetRunID)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func approve(_ choice: String, runID: String? = nil) async {
        let targetRunID = runID ?? pendingApprovals.keys.first ?? activeRun?.id
        guard let targetRunID,
              let approval = pendingApprovals[targetRunID] ?? pendingApproval else { return }
        do {
            try await client.submitApproval(id: approval.id, choice: choice, runID: targetRunID)
            pendingApprovals.removeValue(forKey: targetRunID)
            refreshPendingApproval()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func addProject() async {
        do {
            let result = try await client.pickProject()
            projects = try await client.fetchProjects()
            if let path = result.projectPath, let project = projects.first(where: { $0.path == path }) {
                await selectProject(project)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func renameProject(_ project: DesktopProject) async {
        guard let name = prompt(title: "Rename Project", value: project.name), !name.isEmpty else { return }
        do {
            try await client.renameProject(path: project.path, name: name)
            projects = try await client.fetchProjects()
        } catch { errorMessage = error.localizedDescription }
    }

    func removeProject(_ project: DesktopProject) async {
        guard confirm(title: "Remove Project", message: "Remove \(project.name) from Jesse Agent? Files will not be deleted.") else { return }
        do {
            try await client.removeProject(path: project.path)
            projects = try await client.fetchProjects()
            sessionsByWorkspace.removeValue(forKey: project.path)
            setProjectExpanded(project.path, expanded: false)
            expandedSessionLists.remove(project.path)
            if selectedProject?.path == project.path { await selectChat() }
        } catch { errorMessage = error.localizedDescription }
    }

    func renameSession(_ session: DesktopSessionSummary) async {
        await renameSession(session, workspaceRoot: workspaceRoot)
    }

    func renameSession(_ session: DesktopSessionSummary, workspaceRoot root: String) async {
        guard let title = prompt(title: "Rename Chat", value: session.title), !title.isEmpty else { return }
        do {
            try await client.renameSession(workspaceRoot: root, sessionID: session.id, title: title)
            await refreshSessionsIgnoringError(workspaceRoot: root)
        } catch { errorMessage = error.localizedDescription }
    }

    func archiveSession(_ session: DesktopSessionSummary) async {
        await archiveSession(session, workspaceRoot: workspaceRoot)
    }

    func archiveSession(_ session: DesktopSessionSummary, workspaceRoot root: String) async {
        guard confirm(title: "Archive Chat", message: "Archive \(session.title)?") else { return }
        do {
            try await client.archiveSession(workspaceRoot: root, sessionID: session.id)
            if selectedSessionID == session.id, workspaceRoot == root { clearConversation() }
            await refreshSessionsIgnoringError(workspaceRoot: root)
        } catch { errorMessage = error.localizedDescription }
    }

    func openSessionFromDeepLink(_ sessionID: String) async {
        if let session = chatSessions.first(where: { $0.id == sessionID }) {
            await openSession(session, workspaceRoot: chatWorkspaceRoot, scope: .chat)
            return
        }
        for project in projects {
            let projectSessions = sessions(for: project.path)
            let cachedSession = projectSessions.first(where: { $0.id == sessionID })
            let fetchedSessions = cachedSession == nil
                ? (try? await client.fetchSessions(workspaceRoot: project.path))
                : nil
            if let session = cachedSession ?? fetchedSessions?.first(where: { $0.id == sessionID }) {
                setProjectExpanded(project.path, expanded: true)
                await openSession(session, workspaceRoot: project.path, scope: .project(project.path))
                return
            }
        }
        errorMessage = "Session \(sessionID) was not found."
    }

    func promoteWorkspace() async {
        guard workspaceMetadata?.kind == "scratch", let selectedSessionID else { return }
        let suggestedName = workspaceMetadata?.displayName ?? "Jesse Project"
        guard let name = prompt(title: "Save as Project", value: suggestedName), !name.isEmpty else { return }
        do {
            let result = try await client.promoteWorkspace(workspaceRoot: workspaceRoot, sessionID: selectedSessionID, name: name)
            workspaceMetadata = result.workspace
            try await client.registerProject(path: result.executionRoot)
            projects = try await client.fetchProjects()
        } catch { errorMessage = error.localizedDescription }
    }

    func openChangelog(_ summary: DesktopDailyChangelog) async {
        guard case .project(let projectPath) = scope else { return }
        do {
            selectedChangelog = try await client.fetchChangelog(projectPath: projectPath, date: summary.date)
            selectedChangelogImageURL = summary.imageAvailable
                ? client.changelogImageURL(projectPath: projectPath, date: summary.date)
                : nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func closeChangelog() {
        selectedChangelog = nil
        selectedChangelogImageURL = nil
    }

    private func startRun(
        prompt: String,
        attachments: [DoAnythingImageAttachment] = [],
        userMessageID: UUID? = nil
    ) {
        let root = workspaceRoot
        let chatMode: Bool? = scope == .chat ? true : nil
        let generation = conversationGeneration
        let existingSessionID = selectedSessionID
        errorMessage = nil
        let makeRequest: (String?) -> DesktopRunStartRequest = { sessionID in
            DesktopRunStartRequest(
                prompt: prompt,
                sessionId: sessionID,
                permissionMode: self.permissionMode,
                context: .init(workspaceRoot: root, chatMode: chatMode),
                attachments: attachments.isEmpty ? nil : attachments
            )
        }

        let startTask: Task<DesktopRunStartResponse, Error>
        let bootstrapID: UUID?
        if let existingSessionID {
            startTask = Task { try await client.startRun(makeRequest(existingSessionID)) }
            bootstrapID = nil
        } else if let bootstrap = sessionBootstrap,
                  bootstrap.workspaceRoot == root,
                  bootstrap.generation == generation {
            startTask = Task {
                let first = try await bootstrap.task.value
                return try await self.client.startRun(makeRequest(first.sessionId))
            }
            bootstrapID = nil
        } else {
            let id = UUID()
            let task = Task { try await client.startRun(makeRequest(nil)) }
            sessionBootstrap = (id, root, generation, task)
            startTask = task
            bootstrapID = id
        }

        let localTaskID = UUID().uuidString
        let task = Task { [weak self] in
            guard let self else { return }
            defer { runTasks[localTaskID] = nil }
            do {
                let start = try await startTask.value
                if let bootstrapID, sessionBootstrap?.id == bootstrapID { sessionBootstrap = nil }
                guard !Task.isCancelled,
                      conversationGeneration == generation,
                      workspaceRoot == root,
                      selectedSessionID == nil || selectedSessionID == existingSessionID || selectedSessionID == start.sessionId else {
                    return
                }
                selectedSessionID = start.sessionId
                if let userMessageID,
                   let index = messages.firstIndex(where: { $0.id == userMessageID }) {
                    messages[index].runID = start.runId
                }
                registerActiveRun(start.run)
                workspaceMetadata = start.run.workspace
                await refreshSessionsIgnoringError(workspaceRoot: root)
                locallyStreamedRunIDs.insert(start.runId)
                defer { locallyStreamedRunIDs.remove(start.runId) }
                for try await envelope in client.streamAgentRun(runID: start.runId, after: start.cursor) {
                    handle(envelope)
                }
            } catch is CancellationError {
                return
            } catch {
                if let bootstrapID, sessionBootstrap?.id == bootstrapID { sessionBootstrap = nil }
                if conversationGeneration == generation, workspaceRoot == root {
                    errorMessage = error.localizedDescription
                }
            }
        }
        runTasks[localTaskID] = task
    }

    private func handle(_ envelope: AgentRunEnvelope, fromGlobalStream: Bool = false) {
        if fromGlobalStream, locallyStreamedRunIDs.contains(envelope.run.id) { return }
        let eventKey = "\(envelope.run.id):\(envelope.cursor)"
        guard envelope.run.workspaceRoot == workspaceRoot,
              envelope.run.sessionId == selectedSessionID,
              handledRunEvents.insert(eventKey).inserted else { return }
        if envelope.run.status.isActive {
            registerActiveRun(envelope.run)
        } else {
            activeRuns.removeValue(forKey: envelope.run.id)
            activeRun = newestActiveRun() ?? envelope.run
            pendingApprovals.removeValue(forKey: envelope.run.id)
            refreshPendingApproval()
        }
        guard let output = envelope.output else { return }
        switch output.type {
        case "ready":
            outputs.append(.init(
                kind: .activity,
                title: "Connected",
                detail: envelope.run.executionRoot,
                succeeded: true,
                runID: envelope.run.id
            ))
        case "approval_request":
            if let request = output.request {
                pendingApprovals[envelope.run.id] = request
                refreshPendingApproval()
                for file in request.files ?? [] {
                    outputs.append(.init(
                        kind: .file,
                        title: file,
                        detail: request.detail,
                        succeeded: nil,
                        runID: envelope.run.id
                    ))
                }
                if let diff = request.diff, !diff.isEmpty {
                    outputs.append(.init(
                        kind: .diff,
                        title: "Proposed diff",
                        detail: diff,
                        succeeded: nil,
                        runID: envelope.run.id
                    ))
                }
            }
        case "approval_response":
            pendingApprovals.removeValue(forKey: envelope.run.id)
            refreshPendingApproval()
        case "agent_event":
            if let event = output.event { handle(event, runID: envelope.run.id) }
        case "error":
            errorMessage = output.error
        case "done":
            activeRuns.removeValue(forKey: envelope.run.id)
            activeRun = newestActiveRun() ?? envelope.run
            pendingApprovals.removeValue(forKey: envelope.run.id)
            refreshPendingApproval()
            assistantMessageIDs.removeValue(forKey: envelope.run.id)
            Task { await refreshSessionsIgnoringError(workspaceRoot: envelope.run.workspaceRoot) }
        default:
            break
        }
    }

    private func handle(_ event: AgentEventPayload, runID: String) {
        switch event.type {
        case "assistant_delta":
            appendAssistant(event.text ?? "", runID: runID)
        case "assistant_text":
            setAssistant(event.text ?? "", runID: runID)
        case "assistant_attachment":
            guard let attachment = event.attachment else { return }
            if let index = assistantMessageIndex(runID: runID) {
                if !messages[index].attachments.contains(attachment) { messages[index].attachments.append(attachment) }
            } else {
                messages.append(.init(role: "assistant", text: "", attachments: [attachment], runID: runID))
                assistantMessageIDs[runID] = messages.last?.id
            }
        case "turn_start":
            outputs.append(.init(kind: .activity, title: "Thinking", detail: "Agent turn started", succeeded: nil, runID: runID))
        case "tool_start":
            assistantMessageIDs.removeValue(forKey: runID)
            outputs.append(.init(kind: .activity, title: event.name ?? "Tool", detail: "Running", succeeded: nil, runID: runID))
        case "tool_result":
            let name = event.name ?? "Tool result"
            let kind: DesktopOutputItem.Kind = switch name {
            case "write_file", "edit_file": .file
            case "run_command", "run_background_command": .command
            default: .activity
            }
            outputs.append(.init(kind: kind, title: name, detail: event.content ?? "", succeeded: event.ok, runID: runID))
        case "error":
            errorMessage = event.reason
        default:
            break
        }
    }

    private func appendAssistant(_ text: String, runID: String) {
        if let index = assistantMessageIndex(runID: runID) { messages[index].text += text }
        else {
            let message = MainConversationMessage(role: "assistant", text: text, runID: runID)
            assistantMessageIDs[runID] = message.id
            messages.append(message)
        }
    }

    private func setAssistant(_ text: String, runID: String) {
        if let index = assistantMessageIndex(runID: runID) { messages[index].text = text }
        else {
            let message = MainConversationMessage(role: "assistant", text: text, runID: runID)
            assistantMessageIDs[runID] = message.id
            messages.append(message)
        }
    }

    private func assistantMessageIndex(runID: String) -> Int? {
        guard let id = assistantMessageIDs[runID] else { return nil }
        return messages.firstIndex { $0.id == id }
    }

    private func registerActiveRun(_ run: AgentRunSnapshot) {
        activeRuns[run.id] = run
        activeRun = newestActiveRun()
    }

    private func newestActiveRun() -> AgentRunSnapshot? {
        activeRuns.values
            .filter { $0.status.isActive }
            .max { $0.updatedAt < $1.updatedAt }
    }

    private func refreshPendingApproval() {
        pendingApproval = activeRuns.values
            .filter { $0.status.isActive && pendingApprovals[$0.id] != nil }
            .max { $0.updatedAt < $1.updatedAt }
            .flatMap { pendingApprovals[$0.id] }
            ?? pendingApprovals.values.first
    }

    private func attachToActiveRun() async {
        guard let selectedSessionID else { return }
        do {
            let result = try await client.fetchRuns(sessionID: selectedSessionID, includeEvents: true)
            let runs = result.runs.filter { $0.status.isActive }
            guard !runs.isEmpty else { return }
            let orderedRuns = runs.sorted { $0.createdAt < $1.createdAt }
            for run in orderedRuns { registerActiveRun(run) }
            let userMessageIndices = messages.indices.filter {
                messages[$0].role == "user" && messages[$0].runID == nil
            }.suffix(orderedRuns.count)
            for (index, run) in zip(userMessageIndices, orderedRuns) {
                messages[index].runID = run.id
            }
            let runIDs = Set(runs.map(\.id))
            for envelope in result.events ?? [] where runIDs.contains(envelope.run.id) { handle(envelope) }
            for run in runs {
                let taskID = run.id
                runTasks[taskID]?.cancel()
                locallyStreamedRunIDs.insert(run.id)
                runTasks[taskID] = Task { [weak self] in
                    guard let self else { return }
                    defer {
                        self.runTasks[taskID] = nil
                        self.locallyStreamedRunIDs.remove(run.id)
                    }
                    do {
                        for try await envelope in self.client.streamAgentRun(runID: run.id, after: result.cursor) {
                            self.handle(envelope)
                        }
                    } catch is CancellationError {
                        return
                    } catch {
                        self.errorMessage = error.localizedDescription
                    }
                }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func startGlobalRunObservation() async {
        guard globalRunTask == nil else { return }
        let initialCursor = (try? await client.fetchRuns().cursor) ?? 0
        globalRunTask = Task { [weak self] in
            guard let self else { return }
            do {
                for try await envelope in self.client.streamAllAgentRuns(after: initialCursor) {
                    await self.refreshSessionsIgnoringError(workspaceRoot: envelope.run.workspaceRoot)
                    self.handle(envelope, fromGlobalStream: true)
                }
            } catch is CancellationError {
                return
            } catch {
                self.errorMessage = error.localizedDescription
                self.globalRunTask = nil
            }
        }
    }

    private func refreshSessions(workspaceRoot: String) async throws {
        guard !workspaceRoot.isEmpty else { return }
        let sessions = try await client.fetchSessions(workspaceRoot: workspaceRoot)
        sessionsByWorkspace[workspaceRoot] = sessions
        if workspaceRoot == self.workspaceRoot,
           let selectedSessionID,
           let selectedSession = sessions.first(where: { $0.id == selectedSessionID }) {
            markSessionRunViewed(selectedSession, workspaceRoot: workspaceRoot)
        }
    }

    private func refreshSessionsIgnoringError(workspaceRoot: String) async {
        do { try await refreshSessions(workspaceRoot: workspaceRoot) }
        catch { errorMessage = error.localizedDescription }
    }

    private static let expandedProjectsDefaultsKey = "jesse.main.expandedProjects"
    private static let viewedRunStatesDefaultsKey = "jesse.main.viewedRunStates"

    private func viewedRunStateKey(sessionID: String, workspaceRoot: String) -> String {
        "\(workspaceRoot)\u{1F}\(sessionID)"
    }

    private func viewedRunStateFingerprint(_ run: DesktopSessionRunState) -> String {
        "\(run.runId)\u{1F}\(run.status.rawValue)\u{1F}\(run.updatedAt)"
    }

    private func clearConversation() {
        conversationGeneration &+= 1
        for task in runTasks.values { task.cancel() }
        runTasks.removeAll()
        sessionBootstrap = nil
        selectedSessionID = nil
        activeRun = nil
        activeRuns = [:]
        pendingApproval = nil
        pendingApprovals = [:]
        queuedPrompt = nil
        attachments = []
        workspaceMetadata = nil
        selectedChangelog = nil
        selectedChangelogImageURL = nil
        messages = []
        outputs = []
        assistantMessageIDs = [:]
        handledRunEvents = []
        locallyStreamedRunIDs = []
    }

    private func sourceOutputs(from metadata: DesktopSessionMetadata?) -> [DesktopOutputItem] {
        guard let source = metadata?.source else { return [] }
        return [DesktopOutputItem(
            kind: .source,
            title: source.title ?? source.app ?? "Source",
            detail: source.url ?? source.bundleIdentifier ?? "",
            succeeded: true
        )]
    }

    private func prompt(title: String, value: String) -> String? {
        let alert = NSAlert()
        alert.messageText = title
        let field = NSTextField(string: value)
        field.frame = NSRect(x: 0, y: 0, width: 320, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn ? field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) : nil
    }

    private func confirm(title: String, message: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }
}

enum ImageAttachmentError: LocalizedError {
    case tooMany
    case tooLarge
    case combinedTooLarge
    case unsupported
    case clipboardHasNoImage

    var errorDescription: String? {
        switch self {
        case .tooMany: "You can attach up to 8 images."
        case .tooLarge: "Each image must be 16 MB or smaller."
        case .combinedTooLarge: "All images together must be 16 MB or smaller."
        case .unsupported: "Only PNG, JPEG, and WebP images are supported."
        case .clipboardHasNoImage: "The clipboard does not contain a supported image."
        }
    }
}

enum ImageAttachmentValidator {
    static let maximumCount = 8
    static let maximumBytes = 16 * 1024 * 1024
    static let supportedMIMETypes = Set(["image/png", "image/jpeg", "image/webp"])

    static func appending(
        data: Data,
        mimeType: String,
        name: String,
        to current: [DoAnythingImageAttachment]
    ) throws -> [DoAnythingImageAttachment] {
        guard supportedMIMETypes.contains(mimeType) else { throw ImageAttachmentError.unsupported }
        guard current.count < maximumCount else { throw ImageAttachmentError.tooMany }
        guard data.count <= maximumBytes else { throw ImageAttachmentError.tooLarge }

        let attachment = DoAnythingImageAttachment(
            dataURL: "data:\(mimeType);base64,\(data.base64EncodedString())",
            name: name
        )
        let next = current + [attachment]
        let combined = next.reduce(0) { result, attachment in
            result + (DataURLDecoder.decode(attachment.dataURL)?.count ?? maximumBytes + 1)
        }
        guard combined <= maximumBytes else { throw ImageAttachmentError.combinedTooLarge }
        return next
    }
}
