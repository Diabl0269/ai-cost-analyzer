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

// MARK: Pie Chart Rendering (CoreGraphics / AppKit)

func providerColor(_ key: String?, ratio: Double = 0) -> NSColor {
    switch key {
    case "claude":   return NSColor(srgbRed: 0.85, green: 0.46, blue: 0.31, alpha: 1)
    case "codex":    return NSColor(srgbRed: 0.16, green: 0.71, blue: 0.50, alpha: 1)
    case "copilot":  return NSColor(srgbRed: 0.25, green: 0.52, blue: 0.96, alpha: 1)
    case "opencode": return NSColor(srgbRed: 0.10, green: 0.68, blue: 0.78, alpha: 1)
    case "gemini":   return NSColor(srgbRed: 0.56, green: 0.40, blue: 0.96, alpha: 1)
    default:
        if ratio >= 1.0 { return .systemRed }
        if ratio >= 0.85 { return .systemOrange }
        return NSColor(srgbRed: 0.16, green: 0.71, blue: 0.50, alpha: 1)
    }
}

func healthColor(_ ratio: Double) -> NSColor {
    if ratio >= 1.0 { return .systemRed }
    if ratio >= 0.85 { return .systemOrange }
    return .labelColor
}

func drawPieChart(in rect: NSRect, pie: BudgetPie, donutRatio: CGFloat = 0, showCenterPercent: Bool = false) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let inset: CGFloat = rect.width >= 32 ? 1.5 : 1.0
    let circleRect = rect.insetBy(dx: inset, dy: inset)
    let center = NSPoint(x: circleRect.midX, y: circleRect.midY)
    let radius = min(circleRect.width, circleRect.height) / 2.0

    ctx.saveGState()

    // Track disc (adapts cleanly to Light and Dark menu bar / popover)
    let trackPath = NSBezierPath(ovalIn: circleRect)
    NSColor.labelColor.withAlphaComponent(0.14).setFill()
    trackPath.fill()

    // Filled pie wedges starting at 12 o'clock (90°) sweeping clockwise
    var currentAngle: CGFloat = 90.0
    for slice in pie.slices where slice.fraction > 0 {
        let sweep = CGFloat(min(1.0, slice.fraction)) * 360.0
        let endAngle = currentAngle - sweep
        let wedge = NSBezierPath()
        wedge.move(to: center)
        wedge.appendArc(withCenter: center, radius: radius, startAngle: currentAngle, endAngle: endAngle, clockwise: true)
        wedge.close()

        let fillColor: NSColor
        if pie.ratio >= 1.0 && pie.slices.count <= 1 && slice.provider == nil {
            fillColor = .systemRed
        } else {
            fillColor = providerColor(slice.provider, ratio: pie.ratio)
        }
        fillColor.setFill()
        wedge.fill()
        currentAngle = endAngle
    }

    // Subtle slice dividers on larger pies with multiple providers
    if pie.slices.count > 1 && rect.width >= 28 {
        var sepAngle: CGFloat = 90.0
        ctx.setLineWidth(1.0)
        NSColor.windowBackgroundColor.withAlphaComponent(0.7).setStroke()
        for slice in pie.slices where slice.fraction > 0 {
            let rad = sepAngle * .pi / 180.0
            let line = NSBezierPath()
            line.move(to: center)
            line.line(to: NSPoint(x: center.x + cos(rad) * radius, y: center.y + sin(rad) * radius))
            line.stroke()
            sepAngle -= CGFloat(min(1.0, slice.fraction)) * 360.0
        }
    }

    // Optional transparent donut cutout for the expanded dropdown pie
    if donutRatio > 0 {
        let innerRadius = radius * donutRatio
        let innerRect = NSRect(
            x: center.x - innerRadius,
            y: center.y - innerRadius,
            width: innerRadius * 2,
            height: innerRadius * 2
        )
        ctx.saveGState()
        ctx.setBlendMode(.clear)
        NSBezierPath(ovalIn: innerRect).fill()
        ctx.restoreGState()

        if showCenterPercent {
            let text = percentLabel(pie.ratio)
            let fontSize: CGFloat = text.count >= 4 ? 10 : 12
            let font = NSFont.monospacedDigitSystemFont(ofSize: fontSize, weight: .bold)
            let attrs: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: healthColor(pie.ratio),
            ]
            let attrStr = NSAttributedString(string: text, attributes: attrs)
            let size = attrStr.size()
            let textPoint = NSPoint(
                x: center.x - size.width / 2.0,
                y: center.y - size.height / 2.0
            )
            attrStr.draw(at: textPoint)
        }
    }

    // Crisp outer ring (red when over budget, orange when >= 85%, subtle adaptive ring otherwise)
    let ringColor: NSColor
    let ringWidth: CGFloat
    if pie.ratio >= 1.0 {
        ringColor = .systemRed
        ringWidth = rect.width >= 32 ? 2.0 : 1.4
    } else if pie.ratio >= 0.85 {
        ringColor = .systemOrange
        ringWidth = rect.width >= 32 ? 1.5 : 1.15
    } else {
        ringColor = NSColor.labelColor.withAlphaComponent(0.32)
        ringWidth = rect.width >= 32 ? 1.0 : 0.8
    }
    trackPath.lineWidth = ringWidth
    ringColor.setStroke()
    trackPath.stroke()

    ctx.restoreGState()
}

func makeMenuBarPiesImage(_ pies: [BudgetPie]) -> NSImage? {
    guard !pies.isEmpty else { return nil }
    let pieSize: CGFloat = 15.0
    let gap: CGFloat = 4.5
    let padX: CGFloat = 1.5
    let height: CGFloat = 18.0
    let width = padX * 2 + CGFloat(pies.count) * pieSize + CGFloat(max(0, pies.count - 1)) * gap

    let image = NSImage(size: NSSize(width: width, height: height), flipped: false) { _ in
        for (idx, pie) in pies.enumerated() {
            let x = padX + CGFloat(idx) * (pieSize + gap)
            let y = (height - pieSize) / 2.0
            drawPieChart(in: NSRect(x: x, y: y, width: pieSize, height: pieSize), pie: pie)
        }
        return true
    }
    image.isTemplate = false
    return image
}

func formatMonthTitle(_ ym: String?) -> String {
    guard let ym = ym, ym.count == 7 else { return "THIS MONTH" }
    let parts = ym.split(separator: "-")
    guard parts.count == 2, let m = Int(parts[1]), (1...12).contains(m) else { return ym }
    let months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
    return "\(months[m - 1]) \(parts[0])"
}

// MARK: Custom Dropdown Menu View for Monthly Budget Pies

final class PieCanvasView: NSView {
    let pie: BudgetPie
    let donutRatio: CGFloat
    let showCenterPercent: Bool

    init(frame: NSRect, pie: BudgetPie, donutRatio: CGFloat, showCenterPercent: Bool) {
        self.pie = pie
        self.donutRatio = donutRatio
        self.showCenterPercent = showCenterPercent
        super.init(frame: frame)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ dirtyRect: NSRect) {
        drawPieChart(in: bounds, pie: pie, donutRatio: donutRatio, showCenterPercent: showCenterPercent)
    }
}

final class ColorDotView: NSView {
    let dotColor: NSColor
    init(color: NSColor) {
        self.dotColor = color
        super.init(frame: NSRect(x: 0, y: 0, width: 7, height: 7))
    }
    required init?(coder: NSCoder) { fatalError() }
    override var intrinsicContentSize: NSSize { NSSize(width: 7, height: 7) }
    override func draw(_ dirtyRect: NSRect) {
        dotColor.setFill()
        NSBezierPath(ovalIn: bounds).fill()
    }
}

func makeLabel(_ text: String, font: NSFont, color: NSColor, align: NSTextAlignment = .left) -> NSTextField {
    let f = NSTextField(labelWithString: text)
    f.font = font
    f.textColor = color
    f.alignment = align
    f.lineBreakMode = .byTruncatingTail
    f.maximumNumberOfLines = 2
    f.translatesAutoresizingMaskIntoConstraints = false
    return f
}

func makeBudgetMenuView(_ pies: [BudgetPie]) -> NSView {
    let cardWidth: CGFloat = 304
    let root = NSView(frame: NSRect(x: 0, y: 0, width: cardWidth, height: 10))
    let mainStack = NSStackView()
    mainStack.orientation = .vertical
    mainStack.alignment = .leading
    mainStack.spacing = 10
    mainStack.edgeInsets = NSEdgeInsets(top: 8, left: 14, bottom: 8, right: 14)
    mainStack.translatesAutoresizingMaskIntoConstraints = false
    root.addSubview(mainStack)

    NSLayoutConstraint.activate([
        mainStack.leadingAnchor.constraint(equalTo: root.leadingAnchor),
        mainStack.trailingAnchor.constraint(equalTo: root.trailingAnchor),
        mainStack.topAnchor.constraint(equalTo: root.topAnchor),
        mainStack.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        root.widthAnchor.constraint(equalToConstant: cardWidth),
    ])

    let sharedPies = pies.filter { $0.isShared }
    let providerPies = pies.filter { !$0.isShared }

    for pie in sharedPies {
        let row = NSStackView()
        row.orientation = .horizontal
        row.alignment = .top
        row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false

        let pieView = PieCanvasView(
            frame: NSRect(x: 0, y: 0, width: 58, height: 58),
            pie: pie,
            donutRatio: 0.56,
            showCenterPercent: true
        )
        pieView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            pieView.widthAnchor.constraint(equalToConstant: 58),
            pieView.heightAnchor.constraint(equalToConstant: 58),
        ])
        row.addArrangedSubview(pieView)

        let info = NSStackView()
        info.orientation = .vertical
        info.alignment = .leading
        info.spacing = 3
        info.translatesAutoresizingMaskIntoConstraints = false

        let headerText = "MONTHLY BUDGET · \(formatMonthTitle(pie.month))"
        info.addArrangedSubview(makeLabel(
            headerText,
            font: NSFont.systemFont(ofSize: 10, weight: .semibold),
            color: .secondaryLabelColor
        ))

        let amountStr = NSMutableAttributedString(
            string: usd(pie.spent),
            attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 14, weight: .bold),
                .foregroundColor: healthColor(pie.ratio),
            ]
        )
        amountStr.append(NSAttributedString(
            string: " of \(usd(pie.limit))",
            attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular),
                .foregroundColor: NSColor.secondaryLabelColor,
            ]
        ))
        let amountLabel = NSTextField(labelWithAttributedString: amountStr)
        amountLabel.translatesAutoresizingMaskIntoConstraints = false
        info.addArrangedSubview(amountLabel)

        if let forecast = pie.forecast {
            let delta = pie.limit - forecast
            let tail = delta >= 0 ? "\(usd(delta)) to spare" : "\(usd(-delta)) over"
            let forecastColor: NSColor = delta >= 0 ? .secondaryLabelColor : .systemRed
            info.addArrangedSubview(makeLabel(
                "Forecast \(usd(forecast)) · \(tail)",
                font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular),
                color: forecastColor
            ))
        }

        if let scope = pie.scopeLabel {
            info.addArrangedSubview(makeLabel(
                "Counts: \(scope)",
                font: NSFont.systemFont(ofSize: 10.5, weight: .medium),
                color: .secondaryLabelColor
            ))
        }

        // Provider breakdown legend
        if !pie.slices.isEmpty && pie.slices.contains(where: { $0.provider != nil }) {
            let legend = NSStackView()
            legend.orientation = .vertical
            legend.alignment = .leading
            legend.spacing = 2
            legend.translatesAutoresizingMaskIntoConstraints = false

            for slice in pie.slices {
                let itemRow = NSStackView()
                itemRow.orientation = .horizontal
                itemRow.alignment = .centerY
                itemRow.spacing = 5
                itemRow.translatesAutoresizingMaskIntoConstraints = false

                let dot = ColorDotView(color: providerColor(slice.provider, ratio: pie.ratio))
                dot.translatesAutoresizingMaskIntoConstraints = false
                NSLayoutConstraint.activate([
                    dot.widthAnchor.constraint(equalToConstant: 7),
                    dot.heightAnchor.constraint(equalToConstant: 7),
                ])
                itemRow.addArrangedSubview(dot)
                itemRow.addArrangedSubview(makeLabel(
                    "\(slice.label) \(usd(slice.amount))",
                    font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular),
                    color: .labelColor
                ))
                legend.addArrangedSubview(itemRow)
            }
            info.addArrangedSubview(legend)
        }

        if !pie.unlimited.isEmpty {
            let parts = pie.unlimited.map { u -> String in
                u.spent > 0 ? "\(u.label) (\(usd(u.spent)))" : u.label
            }
            let unl = makeLabel(
                "Unlimited: \(parts.joined(separator: ", "))",
                font: NSFont.systemFont(ofSize: 10.5, weight: .regular),
                color: .tertiaryLabelColor
            )
            unl.preferredMaxLayoutWidth = cardWidth - 104
            info.addArrangedSubview(unl)
        }

        row.addArrangedSubview(info)
        mainStack.addArrangedSubview(row)
    }

    if !providerPies.isEmpty {
        if !sharedPies.isEmpty {
            let div = NSBox()
            div.boxType = .separator
            div.translatesAutoresizingMaskIntoConstraints = false
            mainStack.addArrangedSubview(div)
            div.widthAnchor.constraint(equalToConstant: cardWidth - 28).isActive = true
        }
        mainStack.addArrangedSubview(makeLabel(
            "TOOL BUDGETS · \(formatMonthTitle(providerPies.first?.month))",
            font: NSFont.systemFont(ofSize: 10, weight: .semibold),
            color: .secondaryLabelColor
        ))

        for pie in providerPies {
            let pRow = NSStackView()
            pRow.orientation = .horizontal
            pRow.alignment = .centerY
            pRow.spacing = 8
            pRow.translatesAutoresizingMaskIntoConstraints = false

            let mini = PieCanvasView(
                frame: NSRect(x: 0, y: 0, width: 20, height: 20),
                pie: pie,
                donutRatio: 0,
                showCenterPercent: false
            )
            mini.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                mini.widthAnchor.constraint(equalToConstant: 20),
                mini.heightAnchor.constraint(equalToConstant: 20),
            ])
            pRow.addArrangedSubview(mini)

            let nameLabel = makeLabel(
                pie.label,
                font: NSFont.systemFont(ofSize: 12, weight: .medium),
                color: .labelColor
            )
            pRow.addArrangedSubview(nameLabel)

            let spacer = NSView()
            spacer.translatesAutoresizingMaskIntoConstraints = false
            spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
            pRow.addArrangedSubview(spacer)

            let spendLabel = makeLabel(
                "\(usd(pie.spent)) / \(usd(pie.limit))",
                font: NSFont.monospacedDigitSystemFont(ofSize: 11.5, weight: .regular),
                color: .secondaryLabelColor,
                align: .right
            )
            pRow.addArrangedSubview(spendLabel)

            let pctLabel = makeLabel(
                percentLabel(pie.ratio),
                font: NSFont.monospacedDigitSystemFont(ofSize: 11.5, weight: .semibold),
                color: healthColor(pie.ratio),
                align: .right
            )
            pctLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 34).isActive = true
            pRow.addArrangedSubview(pctLabel)

            mainStack.addArrangedSubview(pRow)
            pRow.widthAnchor.constraint(equalToConstant: cardWidth - 28).isActive = true
        }
    }

    root.layoutSubtreeIfNeeded()
    let fitting = root.fittingSize
    root.frame = NSRect(x: 0, y: 0, width: cardWidth, height: max(fitting.height, 40))
    return root
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
    for p in r.menuPies {
        let scope = p.scopeLabel.map { " (\($0))" } ?? ""
        print("[pie] \(p.label)\(scope): \(usd(p.spent)) / \(usd(p.limit)) (\(percentLabel(p.ratio)))")
    }
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
    var startError: String?
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
            item.button?.image = nil
            item.button?.toolTip = "AI Cost Analyzer (offline)"
            item.button?.attributedTitle = NSAttributedString(string: offlineTitle, attributes: [.foregroundColor: NSColor.systemRed])
            menu.addItem(withTitle: "AI Cost Analyzer is not reachable on port \(config.port)", action: nil, keyEquivalent: "")
            if config.node != nil && config.cli != nil {
                menu.addItem(target("Start server", #selector(startServer)))
            } else {
                menu.addItem(withTitle: "Run: ai-cost-analyzer autostart enable", action: nil, keyEquivalent: "")
            }
            if started { menu.addItem(withTitle: "Starting… press Refresh in a moment", action: nil, keyEquivalent: "") }
            if let startError = startError {
                menu.addItem(withTitle: startError, action: nil, keyEquivalent: "")
            }
        } else if let s = last {
            let r = render(s)
            if let img = makeMenuBarPiesImage(r.barPies) {
                item.button?.image = img
                item.button?.imagePosition = r.title.isEmpty ? .imageOnly : .imageLeading
                item.button?.attributedTitle = r.title.isEmpty ? NSAttributedString(string: "") : NSAttributedString(string: " " + r.title)
            } else {
                item.button?.image = nil
                item.button?.imagePosition = .noImage
                item.button?.attributedTitle = NSAttributedString(string: r.title)
            }
            item.button?.toolTip = menuBarTooltip(s)

            if !r.menuPies.isEmpty {
                let pieItem = NSMenuItem()
                pieItem.view = makeBudgetMenuView(r.menuPies)
                menu.addItem(pieItem)
                menu.addItem(.separator())
            }

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
        menu.addItem(target("Configure budget…", #selector(openBudgetSettings)))
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
    @objc func openBudgetSettings() { NSWorkspace.shared.open(URL(string: base + "/settings#budget")!) }
    @objc func quit() { NSApp.terminate(nil) }
    @objc func toggleLogin() { _ = setLogin(!loginEnabled()); rebuild() }

    @objc func startServer() {
        guard let node = config.node, let cli = config.cli else { return }
        guard FileManager.default.isExecutableFile(atPath: node), FileManager.default.fileExists(atPath: cli) else {
            startError = "Start failed: reinstall the menu-bar app"
            rebuild()
            return
        }
        started = true
        startError = nil
        rebuild()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [cli, "autostart", "enable", "--port", String(config.port)]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] process in
            let failed = process.terminationStatus != 0
            DispatchQueue.main.asyncAfter(deadline: .now() + (failed ? 0 : 2)) {
                self?.started = false
                if failed { self?.startError = "Start failed: reinstall or check server logs" }
                self?.rebuild()
                if !failed { self?.refresh() }
            }
        }
        do {
            try p.run()
        } catch {
            started = false
            startError = "Start failed: reinstall the menu-bar app"
            rebuild()
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = App(loadConfig(rawArgs))
app.delegate = delegate
app.run()
