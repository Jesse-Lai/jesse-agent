import AppKit
import Foundation
import XCTest
@testable import JesseCompanion

@MainActor
final class MainAppStoreTests: XCTestCase {
    func testSidebarKeepsWorkspaceSessionsAndExpansionIndependent() {
        let store = MainAppStore(client: AgentClient(baseURL: URL(string: "http://127.0.0.1:8787/")!))
        let projectA = "/tmp/project-a"
        let projectB = "/tmp/project-b"
        let sessionA = DesktopSessionSummary(
            id: "session-a", title: "A", lastUserMessage: nil, pinned: nil, metadata: nil, lastRun: nil
        )
        let sessionB = DesktopSessionSummary(
            id: "session-b", title: "B", lastUserMessage: nil, pinned: nil, metadata: nil, lastRun: nil
        )
        store.sessionsByWorkspace = [projectA: [sessionA], projectB: [sessionB]]
        store.scope = .project(projectA)

        store.setProjectExpanded(projectA, expanded: true)
        store.setProjectExpanded(projectB, expanded: true)
        store.showAllSessions(for: projectB)

        XCTAssertEqual(store.sessions.map(\.id), ["session-a"])
        XCTAssertEqual(store.sessions(for: projectB).map(\.id), ["session-b"])
        XCTAssertEqual(store.expandedProjectPaths, [projectA, projectB])
        XCTAssertTrue(store.expandedSessionLists.contains(projectB))
        XCTAssertEqual(store.scope, .project(projectA), "Expanding another project must not change the active scope")

        store.setProjectExpanded(projectB, expanded: false)
        XCTAssertTrue(store.expandedProjectPaths.contains(projectA))
        XCTAssertFalse(store.expandedProjectPaths.contains(projectB))

        UserDefaults.standard.removeObject(forKey: "jesse.main.expandedProjects")
    }

    func testSidebarResultDotsDisappearAfterViewingAndReturnForNewResults() throws {
        let suiteName = "JesseAgent.MainAppStoreTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = MainAppStore(
            client: AgentClient(baseURL: URL(string: "http://127.0.0.1:8787/")!),
            defaults: defaults
        )
        let workspaceRoot = "/tmp/project"
        let completed = DesktopSessionSummary(
            id: "session",
            title: "Completed",
            lastUserMessage: nil,
            pinned: nil,
            metadata: nil,
            lastRun: DesktopSessionRunState(
                runId: "run-1",
                status: .completed,
                startedAt: "2026-08-14T00:00:00Z",
                updatedAt: "2026-08-14T00:01:00Z",
                finishedAt: "2026-08-14T00:01:00Z",
                error: nil
            )
        )

        XCTAssertTrue(store.shouldShowResultDot(for: completed, workspaceRoot: workspaceRoot))
        store.markSessionRunViewed(completed, workspaceRoot: workspaceRoot)
        XCTAssertFalse(store.shouldShowResultDot(for: completed, workspaceRoot: workspaceRoot))

        let newerFailure = DesktopSessionSummary(
            id: completed.id,
            title: "Failed",
            lastUserMessage: nil,
            pinned: nil,
            metadata: nil,
            lastRun: DesktopSessionRunState(
                runId: "run-2",
                status: .failed,
                startedAt: "2026-08-14T00:02:00Z",
                updatedAt: "2026-08-14T00:03:00Z",
                finishedAt: "2026-08-14T00:03:00Z",
                error: "Failed"
            )
        )
        XCTAssertTrue(store.shouldShowResultDot(for: newerFailure, workspaceRoot: workspaceRoot))

        let running = DesktopSessionSummary(
            id: "running",
            title: "Running",
            lastUserMessage: nil,
            pinned: nil,
            metadata: nil,
            lastRun: DesktopSessionRunState(
                runId: "run-3",
                status: .running,
                startedAt: "2026-08-14T00:04:00Z",
                updatedAt: "2026-08-14T00:04:00Z",
                finishedAt: nil,
                error: nil
            )
        )
        XCTAssertFalse(store.shouldShowResultDot(for: running, workspaceRoot: workspaceRoot))

        let cancelled = DesktopSessionSummary(
            id: "cancelled",
            title: "Cancelled",
            lastUserMessage: nil,
            pinned: nil,
            metadata: nil,
            lastRun: DesktopSessionRunState(
                runId: "run-4",
                status: .cancelled,
                startedAt: "2026-08-14T00:05:00Z",
                updatedAt: "2026-08-14T00:06:00Z",
                finishedAt: "2026-08-14T00:06:00Z",
                error: nil
            )
        )
        XCTAssertFalse(store.shouldShowResultDot(for: cancelled, workspaceRoot: workspaceRoot))
    }

    func testAttachmentValidatorEnforcesCountAndCombinedSize() throws {
        var attachments: [DoAnythingImageAttachment] = []
        for index in 0..<ImageAttachmentValidator.maximumCount {
            attachments = try ImageAttachmentValidator.appending(
                data: Data([UInt8(index)]),
                mimeType: "image/png",
                name: "\(index).png",
                to: attachments
            )
        }
        XCTAssertEqual(attachments.count, 8)

        XCTAssertThrowsError(try ImageAttachmentValidator.appending(
            data: Data([9]),
            mimeType: "image/png",
            name: "9.png",
            to: attachments
        )) { error in
            guard case ImageAttachmentError.tooMany = error else {
                return XCTFail("Expected tooMany, got \(error)")
            }
        }

        let first = try ImageAttachmentValidator.appending(
            data: Data(repeating: 1, count: 9 * 1024 * 1024),
            mimeType: "image/jpeg",
            name: "first.jpg",
            to: []
        )
        XCTAssertThrowsError(try ImageAttachmentValidator.appending(
            data: Data(repeating: 2, count: 8 * 1024 * 1024),
            mimeType: "image/webp",
            name: "second.webp",
            to: first
        )) { error in
            guard case ImageAttachmentError.combinedTooLarge = error else {
                return XCTFail("Expected combinedTooLarge, got \(error)")
            }
        }
    }

    func testAttachmentValidatorRejectsUnsupportedAndOversizedImages() {
        XCTAssertThrowsError(try ImageAttachmentValidator.appending(
            data: Data([1]),
            mimeType: "image/gif",
            name: "image.gif",
            to: []
        )) { error in
            guard case ImageAttachmentError.unsupported = error else {
                return XCTFail("Expected unsupported, got \(error)")
            }
        }
        XCTAssertThrowsError(try ImageAttachmentValidator.appending(
            data: Data(repeating: 0, count: ImageAttachmentValidator.maximumBytes + 1),
            mimeType: "image/png",
            name: "large.png",
            to: []
        )) { error in
            guard case ImageAttachmentError.tooLarge = error else {
                return XCTFail("Expected tooLarge, got \(error)")
            }
        }
    }

    func testPasteImageAddsSupportedClipboardPayload() {
        let pasteboard = NSPasteboard(name: .init("JesseAgent.MainAppStoreTests.\(UUID().uuidString)"))
        pasteboard.clearContents()
        pasteboard.setData(Data([1, 2, 3]), forType: .init("public.png"))
        let store = MainAppStore(client: AgentClient(baseURL: URL(string: "http://127.0.0.1:8787/")!))

        store.pasteImages(from: pasteboard)

        XCTAssertEqual(store.attachments.count, 1)
        XCTAssertEqual(store.attachments.first?.mimeType, "image/png")
        XCTAssertNil(store.errorMessage)
    }

    func testDeepLinkAndLoginLaunchPolicy() {
        XCTAssertEqual(
            JesseAgentDeepLink.sessionID(from: URL(string: "jesseagent://session/session-123")!),
            "session-123"
        )
        XCTAssertNil(JesseAgentDeepLink.sessionID(from: URL(string: "https://example.com/session/session-123")!))
        XCTAssertTrue(AppLaunchPolicy.shouldOpenMainWindow(launchedAsLoginItem: false))
        XCTAssertFalse(AppLaunchPolicy.shouldOpenMainWindow(launchedAsLoginItem: true))
    }

    func testMarkdownParserSeparatesCodeAndTables() {
        let blocks = MainMarkdownParser.parse("""
        Intro **text**.

        ```swift
        let answer = 42
        ```

        | Name | State |
        | --- | --- |
        | Mac | Ready |
        """)

        XCTAssertEqual(blocks, [
            .markdown("Intro **text**."),
            .code(language: "swift", content: "let answer = 42"),
            .table(headers: ["Name", "State"], rows: [["Mac", "Ready"]]),
        ])
    }

    func testMarkdownTextParserCreatesHeadingAndBodyTiers() {
        XCTAssertEqual(
            MainMarkdownTextParser.parse("""
            Intro paragraph.

            ## Small heading

            Body with **emphasis**.
            """),
            [
                .body("Intro paragraph."),
                .heading("Small heading"),
                .body("Body with **emphasis**."),
            ]
        )
    }

    func testMarkdownTextStylerRemovesStrongWeightButKeepsMarkdownContent() throws {
        let attributed = try XCTUnwrap(MainMarkdownTextStyler.attributed("**Priority** and `code`"))
        XCTAssertEqual(String(attributed.characters), "Priority and code")
        XCTAssertFalse(attributed.runs.contains { run in
            run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
        })
        XCTAssertTrue(attributed.runs.contains { run in
            run.inlinePresentationIntent?.contains(.code) == true
        })
    }
}
