import AppKit
import Foundation

struct ControlResult: Decodable {
    let ok: Bool
    let state: String
    let url: String?
    let dataDir: String?
    let message: String?
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private let heading = NSMenuItem(title: "PlanBridge · 正在准备…", action: nil, keyEquivalent: "")
    private let toggleItem = NSMenuItem(title: "运行服务器", action: #selector(toggleServer), keyEquivalent: "")
    private let consoleItem = NSMenuItem(title: "打开控制台…", action: #selector(openConsole), keyEquivalent: "")
    private let refreshItem = NSMenuItem(title: "重新检查", action: #selector(refresh), keyEquivalent: "")
    private let quitItem = NSMenuItem(title: "退出 PlanBridge", action: #selector(quit), keyEquivalent: "q")
    private var state = "stopped"
    private var busy = false
    private var prepared = false
    private var terminationRequested = false
    private var allowTermination = false
    private var timer: Timer?
    private var message: String?
    private let endpoint = "http://127.0.0.1:4317"
    private var storage = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/PlanBridge", isDirectory: true)

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let identifier = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
            .contains(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            NSApp.terminate(nil)
            return
        }
        NSApp.setActivationPolicy(.accessory)
        menu.autoenablesItems = false
        heading.isEnabled = false
        menu.addItem(heading)
        menu.addItem(toggleItem)
        menu.addItem(consoleItem)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(refreshItem)
        let logs = NSMenuItem(title: "查看运行日志…", action: #selector(openLogs), keyEquivalent: "")
        let data = NSMenuItem(title: "显示数据文件夹…", action: #selector(openData), keyEquivalent: "")
        menu.addItem(logs)
        menu.addItem(data)
        menu.addItem(NSMenuItem.separator())
        let about = NSMenuItem(title: "关于 PlanBridge…", action: #selector(about), keyEquivalent: "")
        menu.addItem(about)
        menu.addItem(quitItem)
        for item in [toggleItem, consoleItem, refreshItem, logs, data, about, quitItem] { item.target = self }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.menu = menu
        updateAppearance()
        perform("prepare", showErrors: true)
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            guard let self = self, self.prepared, !self.busy else { return }
            self.perform("status", showErrors: false)
        }
    }

    private func updateAppearance() {
        let running = state == "running"
        let label: String
        if busy { label = "正在处理…" }
        else {
            switch state {
            case "running": label = "已运行"
            case "stopped": label = "已停止"
            case "occupied": label = "端口被占用"
            default: label = "需要检查"
            }
        }
        heading.title = "PlanBridge · \(label)"
        heading.toolTip = message
        toggleItem.state = running ? .on : .off
        toggleItem.isEnabled = !busy && prepared && state != "occupied"
        consoleItem.isEnabled = !busy && running
        refreshItem.isEnabled = !busy
        quitItem.isEnabled = !busy
        let symbol = busy ? "ellipsis.circle" : (running ? "power.circle.fill" : "power.circle")
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "PlanBridge，\(label)")
        image?.isTemplate = true
        statusItem.button?.image = image
        statusItem.button?.toolTip = "PlanBridge · \(label)"
        statusItem.button?.setAccessibilityLabel("PlanBridge，服务器\(label)")
    }

    private func perform(_ action: String, showErrors: Bool, quitAfter: Bool = false) {
        guard !busy else { return }
        busy = true
        updateAppearance()
        let resources = Bundle.main.resourceURL!
        let targetStorage = storage
        DispatchQueue.global(qos: .userInitiated).async {
            let result: ControlResult
            do {
                let node = resources.appendingPathComponent("runtime/node")
                let helper = resources.appendingPathComponent("server/macos/app-control.mjs")
                let process = Process()
                let output = Pipe()
                process.executableURL = node
                process.arguments = ["--no-use-env-proxy", helper.path, action]
                process.currentDirectoryURL = resources.appendingPathComponent("server")
                var environment = ProcessInfo.processInfo.environment
                environment.removeValue(forKey: "NODE_OPTIONS")
                environment["PLANBRIDGE_DATA_DIR"] = targetStorage.path
                environment["PLANBRIDGE_NODE_BIN"] = node.path
                environment["PLANBRIDGE_PORT"] = "4317"
                if let data = try? Data(contentsOf: resources.appendingPathComponent("installation.json")),
                   let installation = try? JSONSerialization.jsonObject(with: data) as? [String: String],
                   let legacy = installation["legacyDataDir"] {
                    environment["PLANBRIDGE_LEGACY_DATA_DIR"] = legacy
                }
                process.environment = environment
                process.standardOutput = output
                process.standardError = FileHandle.nullDevice
                try process.run()
                let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
                DispatchQueue.global().asyncAfter(deadline: .now() + (action == "prepare" ? 90 : 30), execute: deadline)
                let bytes = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                deadline.cancel()
                guard bytes.count < 64 * 1024 else { throw CocoaError(.fileReadCorruptFile) }
                result = try JSONDecoder().decode(ControlResult.self, from: bytes)
            } catch {
                result = ControlResult(ok: false, state: "error", url: nil, dataDir: nil,
                    message: "无法控制本地服务。请确认 App 文件完整，再点击“重新检查”。")
            }
            DispatchQueue.main.async {
                self.busy = false
                self.state = result.state
                self.message = result.message
                if let dataDir = result.dataDir { self.storage = URL(fileURLWithPath: dataDir, isDirectory: true) }
                if action == "prepare" && result.ok { self.prepared = true }
                self.updateAppearance()
                if quitAfter {
                    if result.ok && result.state == "stopped" {
                        self.allowTermination = true
                        NSApp.reply(toApplicationShouldTerminate: true)
                    }
                    else { self.showQuitFailure(result.message, occupied: result.state == "occupied") }
                } else if self.terminationRequested {
                    self.perform("stop", showErrors: false, quitAfter: true)
                } else if !result.ok && showErrors {
                    self.showError(result.message ?? "服务操作未完成，请查看运行日志。")
                }
            }
        }
    }

    @objc private func toggleServer() { perform(state == "running" ? "stop" : "start", showErrors: true) }
    @objc private func refresh() { perform(prepared ? "status" : "prepare", showErrors: true) }
    @objc private func openConsole() { NSWorkspace.shared.open(URL(string: endpoint + "/")!) }
    @objc private func openData() { NSWorkspace.shared.open(storage) }
    @objc private func openLogs() {
        let file = storage.appendingPathComponent("server.log")
        if FileManager.default.fileExists(atPath: file.path) { NSWorkspace.shared.open(file) }
        else { showError("尚未生成运行日志。打开服务器后会在数据文件夹中创建日志。") }
    }
    @objc private func about() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "PlanBridge"
        alert.informativeText = "本地 ChatGPT API 网关\n\n勾选“运行服务器”启动，取消勾选停止。\n地址：\(endpoint)/v1\n\n退出 App 时会停止服务器。登录与密钥保存在本机数据文件夹中。"
        alert.addButton(withTitle: "好")
        alert.runModal()
    }
    @objc private func quit() { NSApp.terminate(nil) }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if allowTermination || statusItem == nil { return .terminateNow }
        if !terminationRequested {
            terminationRequested = true
            timer?.invalidate()
            if !busy { perform("stop", showErrors: false, quitAfter: true) }
        }
        return .terminateLater
    }
    private func showQuitFailure(_ details: String?, occupied: Bool) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = occupied ? "端口由其他服务占用" : "服务器未能确认停止"
        alert.informativeText = occupied ? "退出 PlanBridge 不会停止占用端口的其他程序。" : (details ?? "请先检查服务状态。") + "\n仅退出 App 可能会让服务器继续运行。"
        alert.addButton(withTitle: "返回 App")
        alert.addButton(withTitle: "仅退出 App")
        if alert.runModal() == .alertSecondButtonReturn {
            allowTermination = true
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        else {
            terminationRequested = false
            NSApp.reply(toApplicationShouldTerminate: false)
            timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
                guard let self = self, self.prepared, !self.busy else { return }
                self.perform("status", showErrors: false)
            }
        }
    }
    private func showError(_ text: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "PlanBridge"
        alert.informativeText = text
        alert.addButton(withTitle: "好")
        alert.runModal()
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
