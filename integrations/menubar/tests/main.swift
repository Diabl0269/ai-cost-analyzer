import Foundation

var failed = 0
func eq<T: Equatable>(_ a: T, _ b: T, _ msg: String) {
    if a != b { failed += 1; print("FAIL \(msg): got \(a) want \(b)") }
}
func u(_ cost: Double?, _ status: String, est: Double? = nil, s: Int = 1) -> Usage {
    Usage(cost: cost, costStatus: status, estimatedCost: est, tokens: Tokens(total: 1500), sessions: s, unavailableSessions: 0)
}
func summary(_ t: Usage, _ w: Usage? = nil, _ by: [String: Usage] = [:]) -> Summary {
    Summary(periods: Periods(today: Period(total: t, byProvider: by), week: Period(total: w ?? t, byProvider: by)),
            budget: nil, indexing: false, indexError: nil, indexFailureCount: nil)
}

eq(money(u(1.234, "recorded")), "$1.23", "recorded")
eq(money(u(1.234, "partial")), "$1.23+", "partial")
eq(money(u(nil, "unavailable")), "n/a", "unavailable not $0")
eq(money(u(nil, "unpriced")), "unpriced", "unpriced not $0")
eq(money(u(0, "recorded")), "$0.00", "no activity")
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
// Decode from the API's JSON (extra fields ignored, null cost allowed).
let json = #"{"periods":{"today":{"total":{"cost":null,"costStatus":"unavailable","tokens":{"total":0,"input":0},"sessions":1,"unavailableSessions":1,"partialSessions":0},"byProvider":{}},"week":{"total":{"cost":1.5,"costStatus":"recorded","tokens":{"total":9},"sessions":1,"unavailableSessions":0},"byProvider":{}}},"generatedAt":"x"}"#
let dec = try? JSONDecoder().decode(Summary.self, from: Data(json.utf8))
eq(dec.map { render($0).title }, "n/a today", "decode")
if failed > 0 { print("\(failed) failed"); exit(1) }
print("ok")
