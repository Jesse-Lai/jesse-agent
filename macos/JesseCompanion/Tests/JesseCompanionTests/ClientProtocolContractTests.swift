import Foundation
import XCTest
@testable import JesseCompanion

final class ClientProtocolContractTests: XCTestCase {
    func testSharedClientFixtureDecodesInSwift() throws {
        var fixtureURL = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { fixtureURL.deleteLastPathComponent() }
        fixtureURL.append(path: "contracts/client-protocol-v1.json")
        let data = try Data(contentsOf: fixtureURL)
        let fixture = try JSONDecoder().decode(ClientFixture.self, from: data)

        XCTAssertEqual(fixture.project.name, "JesseAgent")
        XCTAssertEqual(fixture.session.metadata?.origin, "mac")
        XCTAssertEqual(fixture.run.id, fixture.envelope.run.id)
        XCTAssertEqual(fixture.envelope.output?.request?.toolName, "edit_file")
    }

    private struct ClientFixture: Decodable {
        let project: DesktopProject
        let session: DesktopSessionSummary
        let run: AgentRunSnapshot
        let envelope: AgentRunEnvelope
    }
}
