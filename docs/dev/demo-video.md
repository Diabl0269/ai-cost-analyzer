# demo-video — the narrated screen tour

Owns: `scripts/demo-video.ts`, `scripts/demo-video/*`. Output: `docs/demo/` (`demo.mp4`,
`demo.webm`, `demo.gif`, `poster.jpg`, `narration.txt`). Nothing here touches the index or the
server's state — the pricing scene edits a local draft and never presses **Save**.

```
scripts/demo-video.ts          CLI, timing, orchestration, the report it prints
scripts/demo-video/scenes.ts   the tour: one entry per scene (narration, minimum length, actions)
scripts/demo-video/stage.ts    synthetic cursor, title cards, the paced pointer/keyboard helpers
scripts/demo-video/tts.ts      `say` voice selection, per-scene AIFFs, ffprobe durations
scripts/demo-video/render.ts   the ffmpeg passes (mixdown, mp4, webm, gif, poster, probes)
```

## Recording

It needs a **running, indexed server**, same contract as `scripts/screenshot.ts`, and the built
server rather than the Vite dev server. Node 22 (`nvm use`).

```sh
npm run build
node dist/server/cli.js --port 4153 --no-open        # or point --claude-dir at a demo dataset
node --import tsx/esm scripts/demo-video.ts --base http://127.0.0.1:4153 --out docs/demo
```

Against the synthetic fixtures instead of your own transcripts:

```sh
node dist/server/cli.js --claude-dir tests/fixtures/projects \
  --home .cca-scratch/demo-video/home --port 4153 --no-open
node --import tsx/esm scripts/demo-video.ts --base http://127.0.0.1:4153 \
  --out .cca-scratch/demo-video/out --frames
```

| flag | default | what |
|---|---|---|
| `--base <url>` | `http://127.0.0.1:4141` | the running server |
| `--out <dir>` | `docs/demo` | where the five output files land |
| `--scratch <dir>` | `.cca-scratch/demo-video/work` | AIFFs, the raw webm recording, palette, review frames |
| `--voice <name>` | best installed en_US | any name from `say -v '?'` |
| `--no-audio` | off | silent video; scene lengths fall back to their `min` |
| `--gif-seconds <n>` | `28` | how much of the tour the GIF covers |
| `--width` / `--height` | `1440` / `900` | viewport **and** video size |
| `--frames` | off | also writes `intro/midtour/search/outro.png` into the scratch dir for review |

`--frames` is the review loop: look at those four PNGs before shipping a recording. They catch the
things a green exit code does not — a missing cursor, a card that lost its fonts, a blank frame.

## How the timing works

Narration is synthesised **first**, so every scene's length is known before the browser opens:
`duration = max(narration + 0.9 s, scene.min)`. Playwright starts recording the moment the page
exists — before the app has loaded — so the tour's clock `t0` is taken after the first navigation
settles, and the difference (the "pre-roll", ~1.5 s) is trimmed off the front during transcode.
Audio therefore starts at 00:00 of the finished file, and each segment is placed with `adelay`,
which is sample-accurate rather than frame-accurate. The printed table is the contract: scene id,
start, duration.

Every scene is wrapped in `Stage.safe`, and every pointer helper degrades to a logged `skip` when
its target is missing. A sparse dataset produces a thinner tour, never an aborted recording. The
one failure a scene cannot describe is a renderer crash, so `page.on('crash')` logs it and the
script warns when the recording came out more than 2 s shorter than the plan.

Selectors are roles, ARIA labels and the app's own `data-` hooks (`[data-day-index]`,
`[data-bar-index]`, `[data-row-index]`, `[data-turn]`, `[data-hit]`, `[data-page-search]`,
`[data-app-rail]`) — never CSS-module class names, which are hashed at build time. If you rename a
tab or a KPI label, `scenes.ts` is the one file to update.

## Voices

macOS `say` does the narration; there is no network call and no third-party TTS. Selection order:
any installed en_US voice whose `say -v '?'` name contains **(Premium)**, then **(Enhanced)**, then
**Samantha** (the compact voice every Mac ships with), then any other en_US voice. `--voice` wins
over all of it.

A compact voice is noticeably robotic. To install a good one:

> System Settings → Accessibility → Spoken Content → System Voice → **Manage Voices…** →
> English (US) → download e.g. **Ava (Premium)** or **Zoe (Premium)**

then rerun with `--voice 'Ava (Premium)'`. The names include the parenthesised tier, so quote them.

Two implementation notes:

- **AIFF is big-endian.** `--data-format=LEF32@22050` is rejected by `say` with
  `Opening output file failed: fmt?`; `tts.ts` uses `BEF32@22050` (the same 32-bit float at the
  same rate) and falls back through `LEF32@22050` and `BEI16@22050` in case a future macOS differs.
- **`say` needs an unsandboxed shell.** In a sandboxed agent shell it exits 0 while writing a 4 KB
  header and no samples. `tts.ts` checks the file size and says so rather than shipping a silent
  video; run it with the sandbox off (or use `--no-audio`).

## Output and sizes

Measured against the synthetic fixtures at 1440×900, a 94 s tour:

| file | codec | size |
|---|---|---|
| `demo.mp4` | H.264 crf 19 preset slow, yuv420p, 30 fps, `+faststart` · AAC 128 kbps | ~10 MB |
| `demo.webm` | VP9 crf 34 · Opus 96 kbps | ~7 MB |
| `demo.gif` | first `--gif-seconds`, 1000 px, 12 fps, `palettegen stats_mode=diff` + `paletteuse dither=sierra2_4a` | ~10 MB |
| `poster.jpg` | one frame from the Overview scene, 1440 px, mjpeg `-q:v 3` (≈ quality 85) | ~110 KB |
| `narration.txt` | the script, with each scene's start and duration | ~2 KB |

The GIF has a **12 MB budget**. `encodeGif` steps down a ladder
(12 fps/1000 px → 10/1000 → 10/900 → 8/800 → 8/720) until it fits and prints which rung it used;
if even the last rung is over, the report says so instead of failing. Lower `--gif-seconds` first —
it is the cheapest lever.

## Where the README embeds it

GitHub renders **GIFs inline** in a README and does not play mp4/webm there, so the README leads
with the GIF and links the video files:

```md
![AI Cost Analyzer — a 28-second tour](docs/demo/demo.gif)

Full narrated tour (94 s): [demo.mp4](docs/demo/demo.mp4) · [demo.webm](docs/demo/demo.webm) ·
[narration script](docs/demo/narration.txt)
```

A linked `.mp4`/`.webm` opens in GitHub's file viewer with a player, which is why both codecs are
produced: the mp4 is not the only playable file. `poster.jpg` is for anywhere that wants a still
(a release note, an issue, a slide) and for `<video poster>` if the video is ever embedded in a
page we control.

## Editing the tour

`scenes.ts` is the whole script. A scene is `{ id, narration, min, run }`; keep the sum of the
durations in the **75–100 s** band (the report prints the total) and keep each `run` inside its
slot — `holdUntilEnd()` idles out whatever is left, and starting late is logged with `+Nms late`.
`POSTER_SCENE` names the scene the poster frame is cut from.

> The GIF embedded in the README must stay under 10 MB or GitHub serves it as a link instead of
> animating it inline. The shipped `docs/demo/demo.gif` was re-encoded from `demo.mp4` at 820 px,
> 10 fps, first 26 s (`ffmpeg -t 26 -i demo.mp4 -vf "fps=10,scale=820:-1,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a"`);
> pass `--gif-seconds 26 --gif-width 820` or re-encode the same way after a new recording.

> The recording that ships in `docs/demo/` may come from any screen-recording pipeline that follows
> the same tour; `scripts/demo-video.ts` is the reproducible in-repo path and produces equivalent
> output (mp4, gif, poster, narration).
