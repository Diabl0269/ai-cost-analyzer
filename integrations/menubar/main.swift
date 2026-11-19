import AppKit
import Foundation

// AI Cost Analyzer menu-bar app: a thin client of GET /api/analytics/summary on 127.0.0.1.
// Settings (later wins): Resources/config.json {port,node,cli}, env CCA_PORT/CCA_NODE/CCA_CLI,
// args --port N --node PATH --cli PATH. The app never manages server autostart itself; the
// "Start server" item runs `<node> <cli> autostart enable --port N`.

let loginLabel = "com.ai-cost-analyzer.menubar"

struct Config { var port = 4141; var node: String?; var cli: String? }

func loadConfig(_ args: [String]) -> Config {
    var c = Config()
    if let url = Bundle.main.url(forResource: "config", withExtension: "json"),
       let data = try? Data(contentsOf: url),
       let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        if let p = o["port"] as? Int { c.port = p }
        c.node = o["node"] as? String ?? c.node
        c.cli = o["cli"] as? String ?? c.cli
    }
    let env = ProcessInfo.processInfo.environment
    if let p = env["CCA_PORT"].flatMap({ Int($0) }) { c.port = p }
    if let n = env["CCA_NODE"], !n.isEmpty { c.node = n }
    if let n = env["CCA_CLI"], !n.isEmpty { c.cli = n }
    var i = 0
    while i < args.count {
        let next = i + 1 < args.count ? args[i + 1] : nil
        switch args[i] {
        case "--port": if let p = next.flatMap({ Int($0) }) { c.port = p }; i += 1
        case "--node": c.node = next; i += 1
        case "--cli": c.cli = next; i += 1
        default: break
        }
        i += 1
    }
    return c
}

// MARK: login LaunchAgent (separate from the server's autostart agent)

let plistURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/LaunchAgents/\(loginLabel).plist")

func shell(_ cmd: String, _ args: [String]) -> Int32 {
    let p = Process(); p.executableURL = URL(fileURLWithPath: cmd); p.arguments = args
    p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return 127 }
    p.waitUntilExit(); return p.terminationStatus
}

func loginEnabled() -> Bool { FileManager.default.fileExists(atPath: plistURL.path) }

func setLogin(_ on: Bool) -> Bool {
    let target = "gui/\(getuid())/\(loginLabel)"
    _ = shell("/bin/launchctl", ["bootout", target])
    if !on { try? FileManager.default.removeItem(at: plistURL); return true }
    let exe = Bundle.main.executablePath ?? CommandLine.arguments[0]
    let plist: [String: Any] = ["Label": loginLabel, "ProgramArguments": [exe], "RunAtLoad": true,
                                "ProcessType": "Interactive", "LimitLoadToSessionType": "Aqua"]
    do {
        try FileManager.default.createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: plistURL)
    } catch { return false }
    // Not bootstrapped now: the app is already running; the agent takes effect at next login.
    return true
}

let rawArgs = Array(CommandLine.arguments.dropFirst())
if let i = rawArgs.firstIndex(of: "--login") {
    switch i + 1 < rawArgs.count ? rawArgs[i + 1] : "" {
    case "enable": print(setLogin(true) ? "login item enabled" : "failed to enable login item")
    case "disable": _ = setLogin(false); print("login item disabled")
    case "status": print(loginEnabled() ? "login item: enabled" : "login item: disabled")
    default: print("usage: --login enable|disable|status"); exit(2)
    }
    exit(0)
}

// MARK: app

// `--dump`: one fetch, print the rendered title/menu to stdout, exit (no GUI; used for checks).
func dump(_ c: Config) -> Never {
    let session = URLSession(configuration: .ephemeral)
    let base = "http://127.0.0.1:\(c.port)"
    func call(_ path: String, _ post: Bool) -> Data? {
        var r = URLRequest(url: URL(string: base + path)!, timeoutInterval: 15)
        if post { r.httpMethod = "POST" }
        var out: Data?; let sem = DispatchSemaphore(value: 0)
        session.dataTask(with: r) { d, resp, _ in
            if (200..<300).contains((resp as? HTTPURLResponse)?.statusCode ?? 0) { out = d ?? Data() }; sem.signal()
        }.resume(); sem.wait(); return out
    }
    guard call("/api/auth/session", true) != nil,
          let d = call("/api/analytics/summary", false),
          let s = try? JSONDecoder().decode(Summary.self, from: d) else { print(offlineTitle); exit(0) }
    let r = render(s)
    print(r.title)
    for i in r.items { print(i.separator ? "---" : i.text); i.children.forEach { print("--" + $0) } }
    exit(0)
}
if rawArgs.contains("--dump") { dump(loadConfig(rawArgs)) }

final class App: NSObject, NSApplicationDelegate, URLSessionDataDelegate {
    let config: Config
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let session = URLSession(configuration: .ephemeral)
    lazy var eventSession = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
    var timer: Timer?
    var eventTask: URLSessionDataTask?
    var eventBuffer = Data()
    var last: Summary?
    var offline = false
    var started = false
    var base: String { "http://127.0.0.1:\(config.port)" }

    init(_ c: Config) { config = c }

    func applicationDidFinishLaunching(_ n: Notification) {
        item.button?.title = "…"
        rebuild()
        fetchSummary(connectEvents: true)
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.fetchSummary(connectEvents: false) }
    }

    func request(_ path: String, post: Bool = false, _ done: @escaping (Data?) -> Void) {
        var r = URLRequest(url: URL(string: base + path)!, timeoutInterval: 15)
        if post { r.httpMethod = "POST" }
        session.dataTask(with: r) { data, resp, _ in
            // The auth endpoint answers 204, so accept any 2xx.
            done((200..<300).contains((resp as? HTTPURLResponse)?.statusCode ?? 0) ? (data ?? Data()) : nil)
        }.resume()
    }

    @objc func refresh() { fetchSummary(connectEvents: false) }

    func fetchSummary(connectEvents: Bool) {
        request("/api/auth/session", post: true) { [weak self] ok in
            guard let self = self else { return }
            guard ok != nil else { return self.apply(nil) }
            self.request("/api/analytics/summary") { data in
                let s = data.flatMap { try? JSONDecoder().decode(Summary.self, from: $0) }
                self.apply(s)
                if connectEvents { self.subscribeToEvents() }
            }
        }
    }

    func subscribeToEvents() {
        eventTask?.cancel()
        eventBuffer = Data()
        var request = URLRequest(url: URL(string: base + "/api/events")!, timeoutInterval: 60 * 60)
        if let cookies = session.configuration.httpCookieStorage?.cookies(for: request.url!) {
            request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: cookies)
        }
        eventTask = eventSession.dataTask(with: request)
        eventTask?.resume()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        eventBuffer.append(data)
        while let separator = eventBuffer.range(of: Data("\n\n".utf8)) {
            let frame = eventBuffer.prefix(upTo: separator.lowerBound)
            eventBuffer.removeSubrange(..<separator.upperBound)
            guard let text = String(data: frame, encoding: .utf8) else { continue }
            if refreshesSummary(text) {
                DispatchQueue.main.async { self.fetchSummary(connectEvents: false) }
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard session === eventSession, task === eventTask else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.subscribeToEvents() }
    }

    func apply(_ s: Summary?) {
        DispatchQueue.main.async {
            self.offline = s == nil
            if let s = s { self.last = s }
            self.rebuild()
        }
    }

    func rebuild() {
        let menu = NSMenu()
        if offline || last == nil {
            item.button?.attributedTitle = NSAttributedString(string: offlineTitle, attributes: [.foregroundColor: NSColor.systemRed])
            menu.addItem(withTitle: "AI Cost Analyzer is not reachable on port \(config.port)", action: nil, keyEquivalent: "")
            if config.node != nil && config.cli != nil {
                menu.addItem(target("Start server", #selector(startServer)))
            } else {
                menu.addItem(withTitle: "Run: ai-cost-analyzer autostart enable", action: nil, keyEquivalent: "")
            }
            if started { menu.addItem(withTitle: "Starting… press Refresh in a moment", action: nil, keyEquivalent: "") }
        } else if let s = last {
            let r = render(s)
            item.button?.attributedTitle = NSAttributedString(string: r.title)
            for it in r.items {
                if it.separator { menu.addItem(.separator()); continue }
                let m = NSMenuItem(title: it.text, action: nil, keyEquivalent: "")
                m.attributedTitle = NSAttributedString(string: it.text, attributes: attrs(it.tone))
                if !it.children.isEmpty {
                    let sub = NSMenu()
                    it.children.forEach { sub.addItem(withTitle: $0, action: nil, keyEquivalent: "") }
                    m.submenu = sub
                } else if it.tone == .normal {
                    m.action = nil
                }
                menu.addItem(m)
            }
        }
        menu.addItem(.separator())
        menu.addItem(target("Open dashboard", #selector(openDashboard)))
        menu.addItem(target("Refresh", #selector(refresh), key: "r"))
        let login = target("Launch at login", #selector(toggleLogin))
        login.state = loginEnabled() ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())
        menu.addItem(target("Quit", #selector(quit), key: "q"))
        item.menu = menu
    }

    func attrs(_ t: Tone) -> [NSAttributedString.Key: Any] {
        switch t {
        case .red: return [.foregroundColor: NSColor.systemRed]
        case .orange: return [.foregroundColor: NSColor.systemOrange]
        case .gray: return [.foregroundColor: NSColor.secondaryLabelColor]
        case .strong: return [.foregroundColor: NSColor.labelColor, .font: NSFont.boldSystemFont(ofSize: NSFont.systemFontSize)]
        case .header: return [.foregroundColor: NSColor.secondaryLabelColor, .font: NSFont.systemFont(ofSize: 11, weight: .semibold)]
        case .normal: return [.foregroundColor: NSColor.labelColor]
        }
    }

    func target(_ title: String, _ sel: Selector, key: String = "") -> NSMenuItem {
        let m = NSMenuItem(title: title, action: sel, keyEquivalent: key); m.target = self; return m
    }

    @objc func openDashboard() { NSWorkspace.shared.open(URL(string: base)!) }
    @objc func quit() { NSApp.terminate(nil) }
    @objc func toggleLogin() { _ = setLogin(!loginEnabled()); rebuild() }

    @objc func startServer() {
        guard let node = config.node, let cli = config.cli else { return }
        started = true; rebuild()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [cli, "autostart", "enable", "--port", String(config.port)]
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self?.started = false; self?.refresh() }
        }
        try? p.run()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = App(loadConfig(rawArgs))
app.delegate = delegate
app.run()
