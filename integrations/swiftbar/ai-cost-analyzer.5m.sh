#!/bin/bash
# <xbar.title>AI Cost Analyzer</xbar.title>
# <xbar.desc>Today's and this week's AI coding spend from a local AI Cost Analyzer server.</xbar.desc>
# <xbar.dependencies>curl, osascript</xbar.dependencies>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
#
# Reads http://127.0.0.1:$CCA_PORT (default 4141). Needs no jq: JSON is parsed with osascript.

PORT="${CCA_PORT:-4141}"
BASE="http://127.0.0.1:${PORT}"
JAR="$(mktemp -t cca-widget)"
trap 'rm -f "$JAR"' EXIT

offline() {
  echo "⚠ offline | color=red"
  echo "---"
  echo "AI Cost Analyzer is not reachable on port ${PORT}"
  echo "Start it: ai-cost-analyzer autostart enable"
  echo "Refresh | refresh=true"
}

curl -fsS --max-time 5 -c "$JAR" -X POST "${BASE}/api/auth/session" -o /dev/null 2>/dev/null || { offline; exit 0; }
JSON="$(curl -fsS --max-time 15 -b "$JAR" "${BASE}/api/analytics/summary" 2>/dev/null)" || { offline; exit 0; }

CCA_JSON="$JSON" CCA_BASE="$BASE" osascript -l JavaScript -e '
ObjC.import("stdlib");
function run() {
  var d = JSON.parse($.getenv("CCA_JSON"));
  var base = $.getenv("CCA_BASE");
  var NAMES = { claude: "Claude Code", codex: "Codex", copilot: "Copilot", opencode: "OpenCode", gemini: "Gemini" };
  // null cost = unknown (unpriced or no token telemetry): never print it as $0.
  function money(u) {
    if (u.cost === null) return u.costStatus === "unpriced" ? "unpriced" : "n/a";
    var text = "$" + u.cost.toFixed(2);
    return u.costStatus === "partial" ? text + "+" : text;
  }
  // Estimates (estimateAs rules) are shown beside, never inside, recorded cost.
  function est(u) {
    return u.estimatedCost ? "≈ $" + u.estimatedCost.toFixed(2) + " (estimate)" : "";
  }
  function line(u) {
    var e = est(u);
    return e ? (u.cost === null ? e : money(u) + " + " + e) : money(u);
  }
  function tok(n) {
    return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
  }
  function sess(n) { return n + (n === 1 ? " session" : " sessions"); }
  var today = d.periods.today, week = d.periods.week;
  var warn = d.indexError || d.indexFailureCount > 0;
  var title = (today.total.cost === null && today.total.estimatedCost ? est(today.total) : money(today.total)) + " today" + (warn ? " ⚠" : d.indexing ? " ⟳" : "");
  var out = [title, "---"];
  out.push("Today " + line(today.total) + " · 7 days " + line(week.total));
  out.push("---");
  Object.keys(NAMES).forEach(function (p) {
    var t = today.byProvider[p], w = week.byProvider[p];
    if (!t || !w) return;
    if (t.sessions + w.sessions + t.unavailableSessions + w.unavailableSessions === 0) return;
    out.push(NAMES[p] + ": " + line(t) + " today · " + line(w) + " week");
    out.push("--Today: " + tok(t.tokens.total) + " tokens, " + sess(t.sessions));
    out.push("--Week: " + tok(w.tokens.total) + " tokens, " + sess(w.sessions));
    if (t.costStatus === "unavailable" || w.costStatus === "unavailable") out.push("--No token telemetry recorded for some sessions");
  });
  if (today.total.costStatus === "partial" || week.total.costStatus === "partial")
    out.push("+ = some usage is unpriced or incomplete");
  var b = d.budget;
  if (b && b.monthlyBudgetUsd !== null)
    out.push("Month: $" + b.spent.toFixed(2) + " of $" + b.monthlyBudgetUsd.toFixed(2) + " budget");
  out.push("---");
  if (d.indexError) out.push("⚠ Index error: " + String(d.indexError).slice(0, 80) + " | color=red");
  if (d.indexFailureCount > 0) out.push("⚠ " + d.indexFailureCount + " session(s) failed to index | color=orange");
  if (d.indexing) out.push("Indexing… | color=gray");
  out.push("Open dashboard | href=" + base);
  out.push("Refresh | refresh=true");
  return out.join("\n");
}
' || offline
