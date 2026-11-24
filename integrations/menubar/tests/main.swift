import Foundation

var failed = 0
func eq<T: Equatable>(_ a: T, _ b: T, _ msg: String) {
    if a != b { failed += 1; print("FAIL \(msg): got \(a) want \(b)") }
}
func u(_ cost: Double?, _ status: String, est: Double? = nil, s: Int = 1) -> Usage {
    Usage(cost: cost, costStatus: status, estimatedCost: est, tokens: Tokens(total: 1500), sessions: s, unavailableSessions: 0)
}
func summary(_ t: Usage, _ w: Usage? = nil, _ by: [String: Usage] = [:], budget: Budget? = nil, menubar: MenubarPrefs? = nil) -> Summary {
    Summary(periods: Periods(today: Period(total: t, byProvider: by), week: Period(total: w ?? t, byProvider: by)),
            budget: budget, menubar: menubar, indexing: false, indexError: nil, indexFailureCount: nil)
}

eq(money(u(1.234, "recorded")), "$1.23", "recorded")
eq(money(u(1.234, "partial")), "$1.23+", "partial")
eq(money(u(nil, "unavailable")), "n/a", "unavailable not $0")
eq(money(u(nil, "unpriced")), "unpriced", "unpriced not $0")
eq(money(u(0, "recorded")), "$0.00", "no activity")
eq(money(u(0.0049347, "recorded")), "$0.0049", "small activity is not zero")
eq(line(u(1, "partial", est: 0.4)), "$1.00+ + ≈ $0.40 (estimate)", "est beside")
eq(line(u(nil, "unpriced", est: 0.4)), "≈ $0.40 (estimate)", "est only")
eq(tokens(1_234_000), "1.2M", "M"); eq(tokens(1500), "1.5k", "k"); eq(tokens(12), "12", "plain")
eq(render(summary(u(2, "recorded"))).title, "$2.00 today", "title")
eq(render(summary(u(2, "partial"))).title, "$2.00+ today", "title partial")
eq(render(summary(u(nil, "unpriced", est: 1))).title, "≈ $1.00 (estimate) today", "title est")
eq(render(summary(u(nil, "unavailable"))).title, "n/a today", "title n/a")
var s = summary(u(2, "recorded")); s.indexError = "boom"
eq(render(s).title, "$2.00 today ⚠", "title warn")
s.indexError = nil; s.indexing = true
eq(render(s).title, "$2.00 today ⟳", "title indexing")
let r = render(summary(u(3, "recorded"), nil, ["codex": u(3, "recorded"), "claude": u(0, "recorded", s: 0)]))
eq(r.items.filter { $0.text.hasPrefix("Codex") }.count, 1, "active provider listed")
eq(r.items.filter { $0.text.hasPrefix("Claude") }.count, 0, "idle provider hidden")
eq(refreshesSummary("event: sessionsChanged\ndata: {}"), true, "sessions changed refreshes")
eq(refreshesSummary("event: indexed\ndata: {}"), true, "indexed refreshes")
eq(refreshesSummary("event: settingsChanged\ndata: {}"), true, "settings changed refreshes")
eq(refreshesSummary("event: ping\ndata: {}"), false, "ping does not refresh")

// Monthly budget pie: shared budget for OpenCode + Copilot while Gemini is unlimited.
let budget = Budget(
    monthlyBudgetUsd: 100,
    month: "2026-11",
    spent: 45,
    forecast: 90,
    daysElapsed: 15,
    daysInMonth: 30,
    providers: ["opencode", "copilot"],
    spentByProvider: ["opencode": 30, "copilot": 15, "gemini": 20],
    providerBudgets: ["claude": 50]
)
let pieSummary = summary(
    u(5, "recorded"),
    nil,
    ["opencode": u(3, "recorded"), "copilot": u(2, "recorded"), "gemini": u(4, "recorded")],
    budget: budget,
    menubar: MenubarPrefs(showBudgetPie: true, showProviderPies: true, showMenuPie: true, showTodayCost: true)
)
let pies = budgetPies(pieSummary)
eq(pies.count, 2, "shared pie + per-provider pie")
eq(pies[0].scopeLabel, "Copilot + OpenCode", "shared budget scope label")
eq(pies[0].slices.count, 2, "two provider slices")
eq(pies[0].slices[0].provider, "copilot", "copilot slice")
eq(pies[0].slices[1].provider, "opencode", "opencode slice")
eq(pies[0].unlimited.count, 1, "gemini listed as unlimited")
eq(pies[0].unlimited[0].provider, "gemini", "gemini unlimited provider")
eq(pies[0].unlimited[0].spent, 20, "gemini unlimited spent")
eq(pies[1].provider, "claude", "claude per-provider pie")
eq(pies[1].limit, 50, "claude limit")

// Configurable visibility: hide today cost -> empty title when pies are visible.
let pieOnly = summary(
    u(5, "recorded"),
    nil,
    [:],
    budget: budget,
    menubar: MenubarPrefs(showBudgetPie: true, showProviderPies: false, showMenuPie: true, showTodayCost: false)
)
let pieOnlyRendered = render(pieOnly)
eq(pieOnlyRendered.barPies.count, 1, "only shared pie in menu bar")
eq(pieOnlyRendered.title, "", "title hidden when showTodayCost is false and pie is shown")
eq(pieOnlyRendered.menuPies.count, 2, "menu still shows both pies")

// Hide menu pie -> falls back to text budget line.
let noMenuPie = summary(
    u(5, "recorded"),
    nil,
    [:],
    budget: budget,
    menubar: MenubarPrefs(showBudgetPie: false, showProviderPies: false, showMenuPie: false, showTodayCost: true)
)
let noMenuPieRendered = render(noMenuPie)
eq(noMenuPieRendered.barPies.count, 0, "no bar pies when disabled")
eq(noMenuPieRendered.menuPies.count, 0, "no menu pies when disabled")
eq(noMenuPieRendered.items.contains { $0.text.contains("$45.00 of $100.00") }, true, "fallback text line")

// Decode from the API's JSON (extra fields ignored, null cost allowed).
let json = #"{"periods":{"today":{"total":{"cost":null,"costStatus":"unavailable","tokens":{"total":0,"input":0},"sessions":1,"unavailableSessions":1,"partialSessions":0},"byProvider":{}},"week":{"total":{"cost":1.5,"costStatus":"recorded","tokens":{"total":9},"sessions":1,"unavailableSessions":0},"byProvider":{}}},"generatedAt":"x"}"#
let dec = try? JSONDecoder().decode(Summary.self, from: Data(json.utf8))
eq(dec.map { render($0).title }, "n/a today", "decode")
if failed > 0 { print("\(failed) failed"); exit(1) }
print("ok")
