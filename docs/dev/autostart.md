# macOS autostart

`server/autostart.ts` manages a per-user LaunchAgent (`com.ai-cost-analyzer.server`) so the server
starts at login and restarts after a crash.

```sh
ai-cost-analyzer autostart enable  [--port N] [--home DIR]
ai-cost-analyzer autostart disable
ai-cost-analyzer autostart status  [--port N]
```

- `cli.ts` routes `argv[0] === 'autostart'` before `parseFlags`.
- Plist: `~/Library/LaunchAgents/com.ai-cost-analyzer.server.plist` (0644). `ProgramArguments` are
  absolute (`process.execPath`, the sibling `cli.js`, `--no-open --port N`) because launchd's PATH is
  minimal and Node may come from nvm. Only `CCA_*` (except `CCA_PORT`), `CODEX_HOME`,
  `COPILOT_HOME` and `HOME` are copied into the job; `--home` becomes `CCA_HOME`.
- `RunAtLoad`, `KeepAlive {SuccessfulExit: false}`, `ThrottleInterval 30`, `ProcessType Background`.
  Logs: `~/Library/Logs/ai-cost-analyzer/server.{out,err}.log` (directory 0700).
- `enable`: write plist, `launchctl bootout` (ignored if not loaded), `bootstrap gui/<uid>`,
  `kickstart -k`. Re-running is safe. `disable`: `bootout` + delete plist. `status`: plist present,
  `launchctl print` state/pid, and an HTTP probe of `/api/status`.
- Non-darwin platforms are refused before anything runs. If the Node path or install location
  changes (nvm switch, reinstall), run `enable` again.
- Busy port: when plain `ai-cost-analyzer` finds our server already answering on the port
  (`probeServer`: 200 with `version`, or our JSON 401/403), it opens the browser to it and exits
  instead of failing with EADDRINUSE.
- Testing: all effects go through `AutostartDeps` (exec, fs, probe). Tests never call real
  `launchctl`; keep it that way.
