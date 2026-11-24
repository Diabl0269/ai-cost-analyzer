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

struct Budget: Codable {
    var monthlyBudgetUsd: Double?
    var month: String?
    var spent: Double
    var forecast: Double?
    var daysElapsed: Int?
    var daysInMonth: Int?
    var providers: [String]?
    var spentByProvider: [String: Double]?
    var providerBudgets: [String: Double]?
}

struct MenubarPrefs: Codable, Equatable {
    var showBudgetPie: Bool
    var showProviderPies: Bool
    var showMenuPie: Bool
    var showTodayCost: Bool

    static let defaults = MenubarPrefs(
        showBudgetPie: true,
        showProviderPies: true,
        showMenuPie: true,
        showTodayCost: true
    )
}

struct Summary: Codable {
    var periods: Periods
    var budget: Budget?
    var menubar: MenubarPrefs?
    var indexing: Bool?
    var indexError: String?
    var indexFailureCount: Int?
}

let providerNames: [(String, String)] = [
    ("claude", "Claude Code"), ("codex", "Codex"), ("copilot", "Copilot"), ("opencode", "OpenCode"), ("gemini", "Gemini"),
]

let shortProviderNames: [String: String] = [
    "claude": "Claude",
    "codex": "Codex",
    "copilot": "Copilot",
    "opencode": "OpenCode",
    "gemini": "Gemini",
]

func providerDisplayName(_ key: String) -> String {
    shortProviderNames[key] ?? key
}

func usd(_ v: Double) -> String {
    let abs = Swift.abs(v)
    if abs == 0 { return "$0.00" }
    if abs < 0.0001 { return v < 0 ? "-<$0.0001" : "<$0.0001" }
    if abs < 0.01 { return String(format: "$%.4f", v) }
    return String(format: "$%.2f", v)
}

func percentLabel(_ ratio: Double) -> String {
    let pct = max(0, Int((ratio * 100).rounded()))
    return "\(pct)%"
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

// MARK: Monthly budget pies

struct PieSlice: Equatable {
    var provider: String?
    var label: String
    var amount: Double
    var fraction: Double
}

struct UnlimitedProvider: Equatable {
    var provider: String
    var label: String
    var spent: Double
}

struct BudgetPie: Equatable {
    var id: String
    var isShared: Bool
    var provider: String?
    var label: String
    var scopeLabel: String?
    var month: String?
    var spent: Double
    var limit: Double
    var ratio: Double
    var forecast: Double?
    var daysElapsed: Int?
    var daysInMonth: Int?
    var slices: [PieSlice]
    var unlimited: [UnlimitedProvider]
}

func budgetPies(_ d: Summary) -> [BudgetPie] {
    guard let b = d.budget else { return [] }
    var pies: [BudgetPie] = []
    let spentMap = b.spentByProvider ?? [:]

    if let limit = b.monthlyBudgetUsd, limit > 0 {
        let countedSet: Set<String>? = b.providers.map { Set($0) }
        var countedEntries: [(String, String, Double)] = []
        var unlimited: [UnlimitedProvider] = []

        for (key, _) in providerNames {
            let name = providerDisplayName(key)
            let amt = spentMap[key] ?? 0
            if let allowed = countedSet {
                if allowed.contains(key) {
                    if amt > 0 { countedEntries.append((key, name, amt)) }
                } else if d.periods.today.byProvider[key] != nil || amt > 0 {
                    unlimited.append(UnlimitedProvider(provider: key, label: name, spent: amt))
                }
            } else if amt > 0 {
                countedEntries.append((key, name, amt))
            }
        }

        let ratio = b.spent / limit
        var slices: [PieSlice] = []
        let sliceSum = countedEntries.reduce(0.0) { $0 + $1.2 }
        if sliceSum > 0 {
            let denom = ratio >= 1.0 ? sliceSum : limit
            slices = countedEntries.map { (key, name, amt) in
                PieSlice(provider: key, label: name, amount: amt, fraction: min(1.0, amt / denom))
            }
        } else if b.spent > 0 {
            slices = [PieSlice(provider: nil, label: "Monthly spend", amount: b.spent, fraction: min(1.0, ratio))]
        }

        let scopeLabel: String?
        if let allowed = b.providers {
            let names = providerNames.map { $0.0 }.filter { allowed.contains($0) }.map(providerDisplayName)
            scopeLabel = names.isEmpty ? "No tools selected" : names.joined(separator: " + ")
        } else {
            scopeLabel = nil
        }

        pies.append(BudgetPie(
            id: "monthly",
            isShared: true,
            provider: nil,
            label: "Monthly budget",
            scopeLabel: scopeLabel,
            month: b.month,
            spent: b.spent,
            limit: limit,
            ratio: ratio,
            forecast: b.forecast,
            daysElapsed: b.daysElapsed,
            daysInMonth: b.daysInMonth,
            slices: slices,
            unlimited: unlimited
        ))
    }

    if let pBudgets = b.providerBudgets {
        for (key, _) in providerNames {
            guard let limit = pBudgets[key], limit > 0 else { continue }
            let name = providerDisplayName(key)
            let spent = spentMap[key] ?? 0
            let ratio = spent / limit
            let slices = spent > 0 ? [PieSlice(provider: key, label: name, amount: spent, fraction: min(1.0, ratio))] : []
            pies.append(BudgetPie(
                id: "provider:\(key)",
                isShared: false,
                provider: key,
                label: name,
                scopeLabel: nil,
                month: b.month,
                spent: spent,
                limit: limit,
                ratio: ratio,
                forecast: nil,
                daysElapsed: b.daysElapsed,
                daysInMonth: b.daysInMonth,
                slices: slices,
                unlimited: []
            ))
        }
    }

    return pies
}

func menuBarPies(_ d: Summary) -> [BudgetPie] {
    let prefs = d.menubar ?? .defaults
    return budgetPies(d).filter { pie in
        pie.isShared ? prefs.showBudgetPie : prefs.showProviderPies
    }
}

func menuBarTooltip(_ d: Summary) -> String {
    let pies = menuBarPies(d)
    guard !pies.isEmpty else { return "AI Cost Analyzer" }
    return pies.map { pie in
        let scope = pie.scopeLabel.map { " (\($0))" } ?? ""
        return "\(pie.label)\(scope): \(usd(pie.spent)) / \(usd(pie.limit)) (\(percentLabel(pie.ratio)))"
    }.joined(separator: "\n")
}

enum Tone { case normal, strong, header, red, orange, gray }

struct Item {
    var text: String
    var tone: Tone = .normal
    var children: [String] = []
    var separator = false
}

struct Rendered {
    var title: String
    var items: [Item]
    var barPies: [BudgetPie]
    var menuPies: [BudgetPie]
}

func render(_ d: Summary) -> Rendered {
    let prefs = d.menubar ?? .defaults
    let today = d.periods.today, week = d.periods.week
    let warn = d.indexError != nil || (d.indexFailureCount ?? 0) > 0
    let head = (today.total.cost == nil && !estimate(today.total).isEmpty) ? estimate(today.total) : money(today.total)
    let suffix = warn ? " ⚠" : (d.indexing == true ? " ⟳" : "")
    let barPies = menuBarPies(d)
    let allPies = budgetPies(d)
    let menuPies = prefs.showMenuPie ? allPies : []

    let title: String
    if !prefs.showTodayCost && !barPies.isEmpty {
        title = suffix.trimmingCharacters(in: .whitespaces)
    } else {
        title = head + " today" + suffix
    }

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
    if menuPies.isEmpty, let b = d.budget, let limit = b.monthlyBudgetUsd {
        out.append(Item(text: "This month: \(usd(b.spent)) of \(usd(limit)) budget"))
    }
    out.append(sep)
    if let e = d.indexError { out.append(Item(text: "⚠ Index error: " + String(e.prefix(80)), tone: .red)) }
    if let n = d.indexFailureCount, n > 0 { out.append(Item(text: "⚠ \(n) session(s) failed to index", tone: .orange)) }
    if d.indexing == true { out.append(Item(text: "Indexing…", tone: .gray)) }
    return Rendered(title: title, items: out, barPies: barPies, menuPies: menuPies)
}

func refreshesSummary(_ frame: String) -> Bool {
    frame.split(separator: "\n").contains { line in
        line == "event: indexed" || line == "event: sessionsChanged" || line == "event: settingsChanged"
    }
}

let offlineTitle = "⚠ offline"
