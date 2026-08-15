import Foundation
import XCTest
@testable import JesseCompanion

final class AgentClientTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.handler = nil
        super.tearDown()
    }

    func testDecodesStreamingTextAndImageCompletion() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/quick-tasks")
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: [
                "content-type": "application/x-ndjson",
            ])!
            let lines = [
                #"{"type":"delta","text":"优化"}"#,
                #"{"type":"delta","text":"完成"}"#,
                #"{"type":"done","text":"优化完成","imageDataURL":"data:image/png;base64,AA=="}"#,
            ].joined(separator: "\n") + "\n"
            return (response, Data(lines.utf8))
        }
        let client = AgentClient(baseURL: URL(string: "http://127.0.0.1:8787/")!, session: mockSession())
        let request = QuickTaskRequest(action: .image, instruction: nil, selectedText: "内容", sourceApp: "Notion", imageDataURL: nil)

        var deltas = ""
        var completion: (String, String?)?
        for try await event in client.streamQuickTask(request) {
            switch event {
            case .delta(let text): deltas += text
            case .completed(let text, let image): completion = (text, image)
            case .failed(let message): XCTFail("Unexpected failure: \(message)")
            }
        }

        XCTAssertEqual(deltas, "优化完成")
        XCTAssertEqual(completion?.0, "优化完成")
        XCTAssertEqual(completion?.1, "data:image/png;base64,AA==")
    }

    func testDecodesModelFailureEventWithoutThrowingAwayMessage() async throws {
        MockURLProtocol.handler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, Data("{\"type\":\"error\",\"error\":\"模型暂时不可用\"}\n".utf8))
        }
        let client = AgentClient(baseURL: URL(string: "http://127.0.0.1:8787/")!, session: mockSession())
        let request = QuickTaskRequest(action: .ask, instruction: "问题", selectedText: nil, sourceApp: nil, imageDataURL: nil)

        var failure: String?
        for try await event in client.streamQuickTask(request) {
            if case .failed(let message) = event { failure = message }
        }

        XCTAssertEqual(failure, "模型暂时不可用")
    }

    func testTurnsTruncatedStreamIntoVisibleFailure() async throws {
        MockURLProtocol.handler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, Data("{\"type\":\"delta\",\"text\":\"处理中\"}\n".utf8))
        }
        let client = AgentClient(baseURL: URL(string: "http://127.0.0.1:8787/")!, session: mockSession())
        let request = QuickTaskRequest(action: .ask, instruction: "问题", selectedText: nil, sourceApp: nil, imageDataURL: nil)

        var failure: String?
        for try await event in client.streamQuickTask(request) {
            if case .failed(let message) = event { failure = message }
        }

        XCTAssertEqual(
            failure,
            InterfaceLanguage.current.text(
                "Jesse Agent 连接意外中断，请重试。",
                "The Jesse Agent connection ended unexpectedly. Try again."
            )
        )
    }

    func testSurfacesNonSuccessStatusAndResponseBody() async throws {
        MockURLProtocol.handler = { request in
            let response = HTTPURLResponse(url: request.url!, statusCode: 400, httpVersion: nil, headerFields: nil)!
            return (response, Data("{\"error\":\"polish requires selectedText\"}".utf8))
        }
        let client = AgentClient(baseURL: URL(string: "http://127.0.0.1:8787/")!, session: mockSession())
        let request = QuickTaskRequest(action: .polish, instruction: nil, selectedText: nil, sourceApp: "Notion", imageDataURL: nil)

        do {
            for try await _ in client.streamQuickTask(request) {}
            XCTFail("Expected the request to fail")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("HTTP 400"))
            XCTAssertTrue(error.localizedDescription.contains("polish requires selectedText"))
        }
    }

    func testFetchesFullAgentProgress() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/agent-status")
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let body = #"{"busy":true,"pendingApprovals":1,"sessionId":"session-123","messageCount":12,"cwd":"/tmp/project"}"#
            return (response, Data(body.utf8))
        }
        let client = AgentClient(baseURL: URL(string: "http://127.0.0.1:8787/")!, session: mockSession())

        let status = try await client.fetchAgentStatus()

        XCTAssertTrue(status.busy)
        XCTAssertEqual(status.pendingApprovals, 1)
        XCTAssertEqual(status.sessionId, "session-123")
        XCTAssertEqual(status.messageCount, 12)
    }

    func testStartsPersistentDoAnythingSessionWithPageContext() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/do-anything")
            let body = try self.requestBody(from: request)
            let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            let context = try XCTUnwrap(payload["context"] as? [String: Any])
            XCTAssertEqual(payload["prompt"] as? String, "用它做一个 Demo")
            XCTAssertEqual(context["sourceURL"] as? String, "https://github.com/vercel/next.js")
            XCTAssertEqual(context["selectedText"] as? String, "Agent Heavy Mode / Multi-Agent")
            XCTAssertNil(payload["sessionId"])

            let response = HTTPURLResponse(url: request.url!, statusCode: 202, httpVersion: nil, headerFields: nil)!
            let json = #"{"run":{"id":"run-1","sessionId":"session-1","workspaceRoot":"/chat","executionRoot":"/chat/workspaces/session-1","status":"queued","source":{"app":"Google Chrome","url":"https://github.com/vercel/next.js"},"createdAt":"2026-08-09T00:00:00.000Z","updatedAt":"2026-08-09T00:00:00.000Z"},"sessionId":"session-1","runId":"run-1","cursor":1}"#
            return (response, Data(json.utf8))
        }
        let client = AgentClient(baseURL: URL(string: "http://127.0.0.1:8787/")!, session: mockSession())

        let response = try await client.startDoAnything(DoAnythingRequest(
            prompt: "用它做一个 Demo",
            sessionId: nil,
            permissionMode: "default",
            context: DoAnythingSourceContext(
                sourceApp: "Google Chrome",
                sourceBundleIdentifier: "com.google.Chrome",
                sourceURL: "https://github.com/vercel/next.js",
                sourceTitle: "vercel/next.js",
                selectedText: "Agent Heavy Mode / Multi-Agent"
            )
        ))

        XCTAssertEqual(response.sessionId, "session-1")
        XCTAssertEqual(response.run.executionRoot, "/chat/workspaces/session-1")
        XCTAssertEqual(response.run.source?.url, "https://github.com/vercel/next.js")
    }

    func testStartsPersistentDoAnythingSessionWithScreenshotAttachment() async throws {
        let screenshot = "data:image/png;base64,AA=="
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/do-anything")
            let body = try self.requestBody(from: request)
            let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            let attachments = try XCTUnwrap(payload["attachments"] as? [[String: Any]])
            let attachment = try XCTUnwrap(attachments.first)
            XCTAssertEqual(payload["prompt"] as? String, "")
            XCTAssertEqual(attachment["type"] as? String, "image")
            XCTAssertEqual(attachment["mimeType"] as? String, "image/png")
            XCTAssertEqual(attachment["dataURL"] as? String, screenshot)
            XCTAssertEqual(attachment["source"] as? String, "user")

            let response = HTTPURLResponse(url: request.url!, statusCode: 202, httpVersion: nil, headerFields: nil)!
            let json = #"{"run":{"id":"run-1","sessionId":"session-1","workspaceRoot":"/chat","executionRoot":"/chat/workspaces/session-1","status":"queued","createdAt":"2026-08-09T00:00:00.000Z","updatedAt":"2026-08-09T00:00:00.000Z"},"sessionId":"session-1","runId":"run-1","cursor":1}"#
            return (response, Data(json.utf8))
        }
        let client = AgentClient(baseURL: URL(string: "http://127.0.0.1:8787/")!, session: mockSession())

        let response = try await client.startDoAnything(DoAnythingRequest(
            prompt: "",
            sessionId: nil,
            permissionMode: "default",
            context: DoAnythingSourceContext(
                sourceApp: "Microsoft Edge",
                sourceBundleIdentifier: "com.microsoft.edgemac",
                sourceURL: nil,
                sourceTitle: nil,
                selectedText: nil
            ),
            attachments: [DoAnythingImageAttachment(dataURL: screenshot)]
        ))

        XCTAssertEqual(response.sessionId, "session-1")
    }

    func testStreamsSharedAgentRunEventsUntilDone() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/runs/events")
            XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "runId" })?.value, "run-1")
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: [
                "content-type": "text/event-stream",
            ])!
            let run = #"{"id":"run-1","sessionId":"session-1","workspaceRoot":"/chat","executionRoot":"/chat/workspaces/session-1","status":"running","createdAt":"2026-08-09T00:00:00.000Z","updatedAt":"2026-08-09T00:00:01.000Z"}"#
            let doneRun = run.replacingOccurrences(of: #""status":"running""#, with: #""status":"completed""#)
            let lines = [
                "event: run",
                "data: {\"cursor\":2,\"run\":\(run),\"output\":{\"type\":\"agent_event\",\"event\":{\"type\":\"assistant_delta\",\"text\":\"OK\"}}}",
                "",
                "event: run",
                "data: {\"cursor\":3,\"run\":\(run),\"output\":{\"type\":\"agent_event\",\"event\":{\"type\":\"assistant_attachment\",\"attachment\":{\"type\":\"image\",\"mimeType\":\"image/png\",\"dataURL\":\"data:image/png;base64,AA==\",\"source\":\"generated\"}}}}",
                "",
                "event: run",
                "data: {\"cursor\":4,\"run\":\(doneRun),\"output\":{\"type\":\"done\",\"sessionId\":\"session-1\",\"messageCount\":3,\"cancelled\":false}}",
                "",
            ].joined(separator: "\n")
            return (response, Data(lines.utf8))
        }
        let client = AgentClient(baseURL: URL(string: "http://127.0.0.1:8787/")!, session: mockSession())

        var received: [AgentRunEnvelope] = []
        for try await envelope in client.streamAgentRun(runID: "run-1", after: 1) {
            received.append(envelope)
        }

        XCTAssertEqual(received.map(\.cursor), [2, 3, 4])
        XCTAssertEqual(received.first?.output?.event?.text, "OK")
        XCTAssertEqual(
            received[1].output?.event?.attachment?.dataURL,
            "data:image/png;base64,AA=="
        )
        XCTAssertEqual(received[1].output?.event?.attachment?.source, "generated")
        XCTAssertEqual(received.last?.run.status, .completed)
    }

    func testRunStreamReconnectsFromTheLastDecodedCursor() async throws {
        var afterValues: [String] = []
        var requestCount = 0
        MockURLProtocol.handler = { request in
            requestCount += 1
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            afterValues.append(query?.first(where: { $0.name == "after" })?.value ?? "")
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: [
                "content-type": "text/event-stream",
            ])!
            let status = requestCount == 1 ? "running" : "completed"
            let cursor = requestCount == 1 ? 4 : 5
            let output = requestCount == 1
                ? #"{"type":"agent_event","event":{"type":"assistant_delta","text":"A"}}"#
                : #"{"type":"done","sessionId":"session-1","messageCount":2,"cancelled":false}"#
            let body = "data: {\"cursor\":\(cursor),\"run\":{\"id\":\"run-1\",\"sessionId\":\"session-1\",\"workspaceRoot\":\"/chat\",\"executionRoot\":\"/chat/workspaces/session-1\",\"status\":\"\(status)\",\"createdAt\":\"2026-08-09T00:00:00.000Z\",\"updatedAt\":\"2026-08-09T00:00:01.000Z\"},\"output\":\(output)}\n"
            return (response, Data(body.utf8))
        }
        let client = AgentClient(baseURL: URL(string: "http://127.0.0.1:8787/")!, session: mockSession())

        var cursors: [Int] = []
        for try await envelope in client.streamAgentRun(runID: "run-1", after: 3) {
            cursors.append(envelope.cursor)
        }

        XCTAssertEqual(cursors, [4, 5])
        XCTAssertEqual(afterValues, ["3", "4"])
    }

    func testSessionURLDeepLinksIntoTheMatchingChat() throws {
        let url = AgentServerManager.sessionURL("session-123")
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value) })

        XCTAssertEqual(components.path, "/")
        XCTAssertEqual(query["scope"], "chat")
        XCTAssertEqual(query["session"], "session-123")
    }

    func testApprovalAndCancelCarryTheVisibleRunID() async throws {
        var payloads: [(String, [String: Any])] = []
        MockURLProtocol.handler = { request in
            let body = try self.requestBody(from: request)
            let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            payloads.append((request.url?.path ?? "", payload))
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, Data(#"{"ok":true}"#.utf8))
        }
        let client = AgentClient(baseURL: URL(string: "http://127.0.0.1:8787/")!, session: mockSession())

        try await client.submitApproval(id: "approval-1", choice: "allow_once", runID: "run-visible")
        try await client.cancelAgentRun(runID: "run-visible")

        XCTAssertEqual(payloads.count, 2)
        XCTAssertEqual(payloads[0].0, "/api/approval")
        XCTAssertEqual(payloads[0].1["runId"] as? String, "run-visible")
        XCTAssertEqual(payloads[1].0, "/api/cancel")
        XCTAssertEqual(payloads[1].1["runId"] as? String, "run-visible")
    }

    private func mockSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private func requestBody(from request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        let stream = try XCTUnwrap(request.httpBodyStream)
        stream.open()
        defer { stream.close() }

        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeContentData) }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

private final class MockURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
