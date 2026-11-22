# Native menu-bar app (macOS)

An optional replacement for the SwiftBar plugin (`docs/dev/widget.md`): a small AppKit app
(`NSStatusItem`, accessory / `LSUIElement`, no Dock icon) in `integrations/menubar/`. It is a thin
client of `GET /api/analytics/summary` on `127.0.0.1` and is provider-agnostic: the server decides
what is priced.

```sh
ai-cost-analyzer menubar install [--port N]   # build + copy to ~/Applications/AI Cost Analyzer.app + open
ai-cost-analyzer menubar build   [--port N]   # build only (~/Library/Caches/ai-cost-analyzer/menubar/)
ai-cost-analyzer menubar status
ai-cost-analyzer menubar login enable|disable|status   # launch the app at login
ai-cost-analyzer menubar uninstall
```

## Files

- `Format.swift` — pure formatting + `render(Summary) -> Rendered` (title, items). Same semantics as
  the SwiftBar plugin: `$X today`; `partial` → `$X+`; `unavailable` → `n/a` (rows: `no token data`), `unpriced` → `unpriced` (rows: `no price yet`)
  (never `$0`); `estimatedCost` is shown beside, as `≈ $X (estimate)`, never inside cost; `⚠` for
  index errors / failures, `⟳` while indexing. Copilot credits are not reported by the summary and
  are never shown as USD.
- `main.swift` — config, polling (60 s + Refresh), auth, menu, login agent.
- `Info.plist` — template (`__VERSION__` replaced at build).
- `tests/main.swift` — formatter self-test (`swiftc Format.swift tests/main.swift`); run by
  `tests/server/menubar.test.ts` when `swiftc` exists on macOS, skipped otherwise.

## Behaviour

- Auth mirrors the plugin: `POST /api/auth/session` (answers 204) into an ephemeral cookie store,
  then `GET /api/analytics/summary`. Any failure → title `⚠ offline`.
- Offline menu: **Start server** runs `<node> <cli.js> autostart enable --port N` and shows a failure
  item when stale paths or a nonzero launch prevent startup. Enabling waits for an authenticated probe
  or times out with the server log path. The app does not manage autostart itself. Node and `cli.js`
  paths are baked into `Contents/Resources/config.json`
  at build time (the app is launched without your shell environment); override with `CCA_NODE`,
  `CCA_CLI`, `CCA_PORT` or `--node`, `--cli`, `--port`. Rebuild (`menubar install`) if Node moves.
- Port: `CCA_PORT` or `--port` (default 4141), baked in at build via `--port`/`CCA_PORT`.
- "Launch at login" (menu item or `menubar login`) writes
  `~/Library/LaunchAgents/com.ai-cost-analyzer.menubar.plist` (`RunAtLoad`, Aqua session only),
  separate from the server's `com.ai-cost-analyzer.server` agent. The binary also accepts
  `--login enable|disable|status` and `--dump` (print the rendered menu once; no GUI).

## Build / packaging

`menubar build` needs `swiftc` (Xcode Command Line Tools: `xcode-select --install`) and ad-hoc signs
with `codesign --sign -`. The Swift sources (~15 KB) are listed in `package.json` `files`
(`integrations/menubar`) so `menubar build` works from an installed npm package. Non-darwin is
refused. `server/menubar.ts` takes every effect through `MenubarDeps` (tests mock exec).
The ad-hoc signed app built locally is not notarized; it runs because it was built on this machine.

## Layout and hidden tools

The menu opens with bold `Today` / `Last 7 days` totals, a gray note explaining `+` when any total is
partial, then a `By tool` section (one row per tool with usage, submenu for tokens and sessions).
Tools turned off in Settings (`hiddenProviders`) are left out of both the rows and the totals; the
summary endpoint omits them from `byProvider` and `total`. The dashboard's own totals are unchanged.
