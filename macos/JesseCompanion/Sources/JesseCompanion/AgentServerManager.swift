import Foundation
import Darwin
import OSLog

final class AgentServerManager {
    private static let logger = Logger(subsystem: "com.jesse.agent.companion", category: "server")
    private static let requiredAPIVersion = 3
    private static let requiredCapabilities = [
        "quick-tasks-v1",
        "chat-v1",
        "do-anything-v1",
        "agent-runs-v1",
        "scoped-run-control-v1",
        "managed-workspaces-v1",
    ]
    static let baseURL: URL = {
        let port = ProcessInfo.processInfo.environment["JESSE_DESKTOP_PORT"] ?? "8787"
        return URL(string: "http://127.0.0.1:\(port)/")!
    }()

    static func sessionURL(_ sessionID: String) -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "scope", value: "chat"),
            URLQueryItem(name: "session", value: sessionID),
        ]
        return components.url ?? baseURL
    }
    private var process: Process?

    func stop() {
        guard let process, process.isRunning else { return }
        process.terminate()
        self.process = nil
    }

    func ensureRunning() {
        Task.detached { [weak self] in
            guard let self else { return }
            await self.prepareServer()
        }
    }

    private func prepareServer() async {
        if let payload = await Self.healthPayload() {
            if Self.isCompatible(payload) {
                Self.logger.notice("Compatible Jesse desktop service is already running")
                return
            }

            guard Self.isManagedJesseServer(payload) else {
                Self.logger.error("Desktop port is occupied by an unrelated service")
                return
            }
            Self.logger.notice("Replacing an incompatible Jesse desktop service")
            guard await Self.stopListeningProcesses() else {
                Self.logger.error("Could not stop the incompatible Jesse desktop service")
                return
            }
        } else if !Self.listenerPIDs().isEmpty {
            Self.logger.error("Desktop port is occupied by a service without a recognizable health response")
            return
        }

        launchDevelopmentServer()
        for _ in 0..<80 {
            if let payload = await Self.healthPayload(), Self.isCompatible(payload) {
                Self.logger.notice("Jesse desktop service is ready")
                return
            }
            try? await Task.sleep(for: .milliseconds(250))
        }
        Self.logger.error("Jesse desktop service did not become ready")
    }

    private func launchDevelopmentServer() {
        if let bundled = Self.bundledService() {
            let process = Process()
            process.executableURL = bundled.node
            let config = FileManager.default.homeDirectoryForCurrentUser
                .appending(path: "Library/Application Support/JesseAgent/.env")
            process.arguments = ["--env-file-if-exists=\(config.path)", bundled.desktopServer.path]
            process.currentDirectoryURL = bundled.root
            var environment = ProcessInfo.processInfo.environment
            environment["JESSE_PACKAGED"] = "1"
            environment["JESSE_WEB_ROOT"] = bundled.web.path
            environment["JESSE_IDE_SERVER_ENTRY"] = bundled.ideServer.path
            environment["JESSE_NODE_PATH"] = bundled.node.path
            process.environment = environment
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                self.process = process
                Self.logger.notice("Started bundled Jesse Agent service process \(process.processIdentifier)")
            } catch {
                Self.logger.error("Could not start bundled Jesse Agent service: \(error.localizedDescription, privacy: .public)")
            }
            return
        }

        let root = Self.agentRoot()
        guard FileManager.default.fileExists(atPath: root.appending(path: "package.json").path) else { return }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", "cd \(Self.shellQuote(root.path)) && npm run desktop"]
        process.currentDirectoryURL = root
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            self.process = process
            Self.logger.notice("Started Jesse desktop service process \(process.processIdentifier)")
        } catch {
            Self.logger.error("Could not start Jesse desktop service: \(error.localizedDescription, privacy: .public)")
            return
        }
    }

    private static func healthPayload() async -> [String: Any]? {
        do {
            var request = URLRequest(url: baseURL.appending(path: "api/health"))
            request.timeoutInterval = 1
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return payload
        } catch {
            return nil
        }
    }

    private static func isCompatible(_ payload: [String: Any]) -> Bool {
        guard payload["service"] as? String == "jesse-desktop",
              let apiVersion = payload["apiVersion"] as? Int,
              apiVersion >= requiredAPIVersion,
              let capabilities = payload["capabilities"] as? [String] else { return false }
        return requiredCapabilities.allSatisfy { capabilities.contains($0) }
    }

    private static func isManagedJesseServer(_ payload: [String: Any]) -> Bool {
        if payload["service"] as? String == "jesse-desktop" { return true }
        guard let reportedRoot = payload["agentRoot"] as? String else { return false }
        return URL(fileURLWithPath: reportedRoot).standardizedFileURL == agentRoot().standardizedFileURL
    }

    private static func stopListeningProcesses() async -> Bool {
        let pids = listenerPIDs().filter { $0 != getpid() }
        guard !pids.isEmpty else { return true }
        for pid in pids {
            guard kill(pid, SIGTERM) == 0 else {
                logger.error("Could not stop desktop service process \(pid)")
                return false
            }
        }
        for _ in 0..<20 {
            if listenerPIDs().isEmpty { return true }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return false
    }

    private static func listenerPIDs() -> [pid_t] {
        guard let port = baseURL.port else { return [] }
        let output = Pipe()
        let command = Process()
        command.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        command.arguments = ["-nP", "-t", "-iTCP:\(port)", "-sTCP:LISTEN"]
        command.standardOutput = output
        command.standardError = FileHandle.nullDevice
        do {
            try command.run()
            command.waitUntilExit()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            let text = String(data: data, encoding: .utf8) ?? ""
            return text.split(whereSeparator: \.isNewline).compactMap { pid_t($0) }
        } catch {
            logger.error("Could not inspect desktop port: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    private static func agentRoot() -> URL {
        if let override = ProcessInfo.processInfo.environment["JESSE_AGENT_ROOT"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    }

    private static func bundledService() -> (
        root: URL,
        node: URL,
        desktopServer: URL,
        ideServer: URL,
        web: URL
    )? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let root = resources.appending(path: "AgentService", directoryHint: .isDirectory)
        let node = root.appending(path: "runtime/node")
        let desktopServer = root.appending(path: "dist/desktopServer.js")
        let ideServer = root.appending(path: "dist/ideServer.js")
        let web = root.appending(path: "web", directoryHint: .isDirectory)
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: desktopServer.path),
              FileManager.default.fileExists(atPath: ideServer.path),
              FileManager.default.fileExists(atPath: web.appending(path: "index.html").path) else {
            return nil
        }
        return (root, node, desktopServer, ideServer, web)
    }

    private static func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
