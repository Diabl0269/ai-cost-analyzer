import Foundation

// Pure formatting for the menu-bar app. Mirrors integrations/swiftbar/ai-cost-analyzer.5m.sh:
// a null cost is unknown (unpriced / no token telemetry) and is never printed as $0.

struct Tokens: Codable { var total: Double }

struct Usage: Codable {
    var cost: Double?
    var costStatus: String
    var estimatedCost: Double?
    var tokens: Tokens
    var sessions: Int
    var unavailableSessions: Int
}

struct Period: Codable {
    var total: Usage
    var byProvider: [String: Usage]
}

struct Periods: Codable { var today: Period; var week: Period }

struct Budget: Codable { var monthlyBudgetUsd: Double?; var spent: Double }

struct Summary: Codable {
    var periods: Periods
    var budget: Budget?
    var indexing: Bool?
    var indexError: String?
    var indexFailureCount: Int?
}

let providerNames: [(String, String)] = [
    ("claude", "Claude Code"), ("codex", "Codex"), ("copilot", "Copilot"), ("opencode", "OpenCode"), ("gemini", "Gemini"),
]

func usd(_ v: Double) -> String {
    let abs = Swift.abs(v)
    if abs == 0 { return "$0.00" }
    if abs < 0.0001 { return v < 0 ? "-<$0.0001" : "<$0.0001" }
    if abs < 0.01 { return String(format: "$%.4f", v) }
    return String(format: "$%.2f", v)
}

func money(_ u: Usage) -> String {
    guard let c = u.cost else { return u.costStatus == "unpriced" ? "unpriced" : "n/a" }
    return u.costStatus == "partial" ? usd(c) + "+" : usd(c)
}

func estimate(_ u: Usage) -> String {
    guard let e = u.estimatedCost, e != 0 else { return "" }
    return "≈ \(usd(e)) (estimate)"
}

func line(_ u: Usage) -> String {
    let e = estimate(u)
    if e.isEmpty {
        let m = money(u)
        return m == "n/a" ? "no token data" : m == "unpriced" ? "no price yet" : m
    }
    return u.cost == nil ? e : money(u) + " + " + e
}

func tokens(_ n: Double) -> String {
    if n >= 1e6 { return String(format: "%.1fM", n / 1e6) }
    if n >= 1e3 { return String(format: "%.1fk", n / 1e3) }
    return String(Int(n))
}

func sessions(_ n: Int) -> String { "\(n) \(n == 1 ? "session" : "sessions")" }

enum Tone { case normal, strong, header, red, orange, gray }

struct Item {
    var text: String
    var tone: Tone = .normal
    var children: [String] = []
    var separator = false
}

struct Rendered { var title: String; var items: [Item] }

func render(_ d: Summary) -> Rendered {
    let today = d.periods.today, week = d.periods.week
    let warn = d.indexError != nil || (d.indexFailureCount ?? 0) > 0
    let head = (today.total.cost == nil && !estimate(today.total).isEmpty) ? estimate(today.total) : money(today.total)
    let title = head + " today" + (warn ? " ⚠" : (d.indexing == true ? " ⟳" : ""))
    let sep = Item(text: "", separator: true)
    var out: [Item] = [
        Item(text: "Today: \(line(today.total))", tone: .strong),
        Item(text: "Last 7 days: \(line(week.total))", tone: .strong),
    ]
    if today.total.costStatus == "partial" || week.total.costStatus == "partial" {
        out.append(Item(text: "+ means at least this much: some usage has no price yet", tone: .gray))
    }
    var rows: [Item] = []
    for (key, name) in providerNames {
        guard let t = today.byProvider[key], let w = week.byProvider[key] else { continue }
        if t.sessions + w.sessions + t.unavailableSessions + w.unavailableSessions == 0 { continue }
        var kids = ["Today: \(tokens(t.tokens.total)) tokens, \(sessions(t.sessions))",
                    "Last 7 days: \(tokens(w.tokens.total)) tokens, \(sessions(w.sessions))"]
        if t.costStatus == "unavailable" || w.costStatus == "unavailable" {
            kids.append("Some sessions saved no token counts, so their cost can't be shown")
        }
        rows.append(Item(text: "\(name): \(line(t)) today, \(line(w)) in 7 days", children: kids))
    }
    if !rows.isEmpty { out.append(sep); out.append(Item(text: "By tool", tone: .header)); out += rows }
    if let b = d.budget, let limit = b.monthlyBudgetUsd {
        out.append(Item(text: "This month: \(usd(b.spent)) of \(usd(limit)) budget"))
    }
    out.append(sep)
    if let e = d.indexError { out.append(Item(text: "⚠ Index error: " + String(e.prefix(80)), tone: .red)) }
    if let n = d.indexFailureCount, n > 0 { out.append(Item(text: "⚠ \(n) session(s) failed to index", tone: .orange)) }
    if d.indexing == true { out.append(Item(text: "Indexing…", tone: .gray)) }
    return Rendered(title: title, items: out)
}

func refreshesSummary(_ frame: String) -> Bool {
    frame.split(separator: "\n").contains { line in
        line == "event: indexed" || line == "event: sessionsChanged"
    }
}

let offlineTitle = "⚠ offline"
