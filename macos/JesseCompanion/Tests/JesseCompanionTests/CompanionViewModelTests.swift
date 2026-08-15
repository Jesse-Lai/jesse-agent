import Foundation
import XCTest
@testable import JesseCompanion

@MainActor
final class CompanionViewModelTests: XCTestCase {
    func testActionTitlesSupportChineseAndEnglish() {
        XCTAssertEqual(CompanionAction.polish.title(in: .simplifiedChinese), "润色")
        XCTAssertEqual(CompanionAction.polish.title(in: .english), "Polish")
        XCTAssertEqual(CompanionAction.ask.title(in: .simplifiedChinese), "做任何事")
        XCTAssertEqual(CompanionAction.ask.title(in: .english), "Do Anything")
        XCTAssertEqual(CompanionAction.image.title(in: .simplifiedChinese), "配图")
        XCTAssertEqual(CompanionAction.image.title(in: .english), "Image")
    }

    func testImageActionProvidesAnAgentImageGenerationInstruction() throws {
        let chinese = try XCTUnwrap(
            CompanionAction.image.agentInstruction(in: .simplifiedChinese)
        )
        let english = try XCTUnwrap(
            CompanionAction.image.agentInstruction(in: .english)
        )

        XCTAssertTrue(chinese.contains("所选内容"))
        XCTAssertTrue(chinese.contains("生图工具"))
        XCTAssertTrue(english.contains("selected content"))
        XCTAssertTrue(english.contains("image-generation tool"))
        XCTAssertNil(CompanionAction.polish.agentInstruction(in: .simplifiedChinese))
    }

    func testOnlySourceMutatingActionsSupportWriteBack() {
        XCTAssertTrue(CompanionAction.polish.supportsWriteBack)
        XCTAssertTrue(CompanionAction.image.supportsWriteBack)
        XCTAssertFalse(CompanionAction.translate.supportsWriteBack)
        XCTAssertFalse(CompanionAction.summarize.supportsWriteBack)
        XCTAssertFalse(CompanionAction.ask.supportsWriteBack)
        XCTAssertFalse(CompanionAction.screenshot.supportsWriteBack)
    }

    func testLanguageCanChangeWithoutResettingTheCurrentSurface() {
        let model = CompanionViewModel(language: .simplifiedChinese)
        model.showSurface(.ask)

        model.setLanguage(.english)

        XCTAssertEqual(model.language, .english)
        XCTAssertEqual(model.surface, .ask)
    }

    func testLanguagePreferenceMenuTagsRoundTrip() {
        for preference in InterfaceLanguagePreference.allCases {
            XCTAssertEqual(
                InterfaceLanguagePreference(menuTag: preference.menuTag),
                preference
            )
        }
    }

    func testReturnsToCleanRingState() {
        let model = CompanionViewModel()
        model.showSurface(.ask)
        model.askDraft = "hello"
        model.setComposerAttachment(CompanionComposerAttachment(
            imageDataURL: "data:image/png;base64,AA==",
            sourceApp: "Preview"
        ))

        model.showRing()

        XCTAssertEqual(model.surface, .ring)
        XCTAssertEqual(model.askDraft, "")
        XCTAssertNil(model.composerAttachment)
        XCTAssertNil(model.selectedResultID)
    }

    func testEachPresentationRequiresItsOwnRingReveal() {
        let model = CompanionViewModel()

        model.prepareForPresentation(context: .empty, results: [])
        let firstPresentationID = model.ringPresentationID
        XCTAssertFalse(model.isRingEntranceRevealed)

        model.revealRing(for: firstPresentationID)
        XCTAssertTrue(model.isRingEntranceRevealed)

        model.prepareForPresentation(context: .empty, results: [])
        let secondPresentationID = model.ringPresentationID
        XCTAssertNotEqual(secondPresentationID, firstPresentationID)
        XCTAssertFalse(model.isRingEntranceRevealed)

        model.revealRing(for: firstPresentationID)
        XCTAssertFalse(model.isRingEntranceRevealed)

        model.revealRing(for: secondPresentationID)
        XCTAssertTrue(model.isRingEntranceRevealed)
    }

    func testRingDismissalOnlyConcealsTheCurrentPresentation() {
        let model = CompanionViewModel()
        model.prepareForPresentation(context: .empty, results: [])
        let firstPresentationID = model.ringPresentationID
        model.revealRing(for: firstPresentationID)

        model.prepareForPresentation(context: .empty, results: [])
        let currentPresentationID = model.ringPresentationID
        model.revealRing(for: currentPresentationID)

        model.concealRing(for: firstPresentationID)
        XCTAssertTrue(model.isRingEntranceRevealed)

        model.concealRing(for: currentPresentationID)
        XCTAssertFalse(model.isRingEntranceRevealed)
    }

    func testReturningToRingDoesNotReplayWindowEntrance() {
        let model = CompanionViewModel()
        model.prepareForPresentation(context: .empty, results: [])
        model.showSurface(.ask)

        model.showRing()

        XCTAssertEqual(model.surface, .ring)
        XCTAssertTrue(model.isRingEntranceRevealed)
    }

    func testMergesResultsInDateOrderAndCapsHistory() {
        let model = CompanionViewModel()
        let values = (0..<32).map { index in
            makeResult(id: "result-\(index)", createdAt: Date(timeIntervalSince1970: TimeInterval(index)))
        }

        model.replaceResults(values)

        XCTAssertEqual(model.results.count, 30)
        XCTAssertEqual(model.results.first?.id, "result-31")
        XCTAssertEqual(model.results.last?.id, "result-2")
    }

    func testStreamingResultDoesNotOverwriteActiveDraft() {
        let model = CompanionViewModel()
        var result = makeResult(id: "active", text: "first", state: .running)
        model.mergeResult(result, present: true)

        result.text = "first second"
        model.mergeResult(result)
        XCTAssertEqual(model.resultDraft, "first second")

        model.isEditingResult = true
        model.resultDraft = "edited locally"
        result.text = "server update"
        model.mergeResult(result)

        XCTAssertEqual(model.resultDraft, "edited locally")
        XCTAssertEqual(model.selectedResult?.text, "server update")
    }

    func testRunningResultsOnlyContainsActiveTasks() {
        let model = CompanionViewModel()
        model.replaceResults([
            makeResult(id: "running", state: .running),
            makeResult(id: "done", state: .completed),
            makeResult(id: "failed", state: .failed),
        ])

        XCTAssertEqual(model.runningResults.map(\.id), ["running"])
    }

    func testForwardsTypedCommands() {
        let model = CompanionViewModel()
        var commands: [CompanionCommand] = []
        model.commandHandler = { commands.append($0) }

        model.send(.selectAction(.translate))
        model.send(.returnToRing)

        XCTAssertEqual(commands, [.selectAction(.translate), .returnToRing])
    }

    func testDoAnythingKeepsOneSessionAcrossFollowUpTurns() {
        let model = CompanionViewModel()
        model.beginAgentTurn(prompt: "用这个仓库做一个 Demo")
        model.attachAgentRun(makeAgentRun(id: "run-1", sessionID: "session-1", status: .running))
        model.applyAgentRunEnvelope(AgentRunEnvelope(
            cursor: 1,
            run: makeAgentRun(id: "run-1", sessionID: "session-1", status: .running),
            output: AgentRunOutput(
                type: "agent_event",
                event: AgentEventPayload(
                    type: "assistant_text",
                    text: "Demo 已创建",
                    name: nil,
                    ok: nil,
                    content: nil,
                    reason: nil
                ),
                request: nil,
                id: nil,
                choice: nil,
                error: nil,
                cancelled: nil
            )
        ))
        model.applyAgentRunEnvelope(AgentRunEnvelope(
            cursor: 2,
            run: makeAgentRun(id: "run-1", sessionID: "session-1", status: .completed),
            output: AgentRunOutput(
                type: "done",
                event: nil,
                request: nil,
                id: nil,
                choice: nil,
                error: nil,
                cancelled: false
            )
        ))

        model.beginAgentTurn(prompt: "换成深色主题")

        XCTAssertEqual(model.agentSession?.sessionID, "session-1")
        XCTAssertEqual(model.agentSession?.messages.map(\.text), [
            "用这个仓库做一个 Demo",
            "Demo 已创建",
            "换成深色主题",
        ])
        XCTAssertEqual(model.agentSession?.status, .queued)
    }

    func testStartingANewAgentTurnDoesNotReuseThePreviousSession() {
        let model = CompanionViewModel()
        model.beginAgentTurn(prompt: "第一轮")
        model.attachAgentRun(makeAgentRun(id: "run-1", sessionID: "session-1", status: .completed))

        model.beginAgentTurn(prompt: "生成配图", startsNewSession: true)

        XCTAssertNil(model.agentSession?.sessionID)
        XCTAssertNil(model.agentSession?.runID)
        XCTAssertEqual(model.agentSession?.messages.map(\.text), ["生成配图"])
        XCTAssertEqual(model.agentSession?.status, .queued)
    }

    func testDoAnythingKeepsScreenshotOnTheSubmittedUserMessage() {
        let model = CompanionViewModel()
        let screenshot = "data:image/png;base64,AA=="

        model.beginAgentTurn(prompt: "", imageDataURL: screenshot)

        XCTAssertEqual(model.agentSession?.messages.count, 1)
        XCTAssertEqual(model.agentSession?.messages.first?.text, "")
        XCTAssertEqual(model.agentSession?.messages.first?.imageDataURL, screenshot)
    }

    func testGeneratedAgentImageAppearsInTheShortcutConversation() {
        let model = CompanionViewModel()
        let imageDataURL = "data:image/png;base64,AA=="
        let run = makeAgentRun(id: "run-image", sessionID: "session-image", status: .running)
        model.beginAgentTurn(prompt: "生成配图", startsNewSession: true)
        model.attachAgentRun(run)

        model.applyAgentRunEnvelope(AgentRunEnvelope(
            cursor: 2,
            run: run,
            output: AgentRunOutput(
                type: "agent_event",
                event: AgentEventPayload(
                    type: "assistant_attachment",
                    attachment: AgentImageAttachment(
                        type: "image",
                        mimeType: "image/png",
                        dataURL: imageDataURL,
                        assetId: nil,
                        url: nil,
                        name: "Generated image.png",
                        source: "generated"
                    )
                ),
                request: nil,
                id: nil,
                choice: nil,
                error: nil,
                cancelled: nil
            )
        ))

        let message = model.agentSession?.messages.last
        XCTAssertEqual(message?.role, "assistant")
        XCTAssertEqual(message?.imageDataURL, imageDataURL)
        XCTAssertEqual(message?.imageDelivery, .saved)

        if let messageID = message?.id {
            model.setAgentImageDelivery(messageID: messageID, delivery: .inserted)
        }
        XCTAssertEqual(model.agentSession?.messages.last?.imageDelivery, .inserted)
    }

    func testSourceContextCanBeRemovedBeforeSubmission() {
        let model = CompanionViewModel()
        XCTAssertTrue(model.isSourceContextAttached)
        model.clearSourceContext()
        XCTAssertFalse(model.isSourceContextAttached)
    }

    private func makeAgentRun(id: String, sessionID: String, status: AgentRunStatus) -> AgentRunSnapshot {
        AgentRunSnapshot(
            id: id,
            sessionId: sessionID,
            workspaceRoot: "/tmp/chat",
            executionRoot: "/tmp/chat/workspaces/\(sessionID)",
            status: status,
            source: nil,
            createdAt: "2026-08-09T00:00:00.000Z",
            updatedAt: "2026-08-09T00:00:01.000Z",
            finishedAt: status.isActive ? nil : "2026-08-09T00:00:01.000Z",
            error: nil
        )
    }

    private func makeResult(
        id: String,
        text: String = "text",
        state: QuickTaskResult.State = .completed,
        createdAt: Date = Date(timeIntervalSince1970: 0)
    ) -> QuickTaskResult {
        QuickTaskResult(
            id: id,
            action: .ask,
            title: "问一下",
            text: text,
            state: state,
            sourceApp: "Notes",
            createdAt: createdAt,
            imageDataURL: nil,
            delivery: .saved
        )
    }
}
