/**
 * A narrated screen tour of the Ledger, rendered to the files the README embeds.
 *
 * Usage:
 *   node --import tsx/esm scripts/demo-video.ts --base http://127.0.0.1:4141 --out docs/demo \
 *     [--voice 'Ava (Premium)'] [--no-audio] [--gif-seconds 28] [--width 1440 --height 900] \
 *     [--scratch .cca-scratch/demo-video/work] [--frames]
 *
 * Requires a running, indexed server — same contract as `scripts/screenshot.ts`. Nothing here
 * writes to the server: the pricing scene edits a local draft and never presses Save.
 *
 * How the timing works. Narration is synthesised first, so every scene's duration is known before
 * the browser opens: `max(narration + 0.9s, scene.min)`. Playwright starts recording the moment
 * the page exists, which is before the app has loaded, so the tour's clock `t0` is taken after the
 * first navigation settles and the difference is trimmed off the front of the video during
 * transcode. Audio therefore starts at 00:00 of the finished file and each segment is delayed to
 * its scene's cumulative start — exact to the sample, not to the frame.
 */
import { chromium } from '@playwright/test';
import { mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { SCENES, POSTER_SCENE, type Scene } from './demo-video/scenes.js';
import { CURSOR_INIT, Stage, sleep } from './demo-video/stage.js';
import { installedVoices, pickVoice, probeDuration, synthesize, type Segment } from './demo-video/tts.js';
import {
  encodeGif,
  encodeMp4,
  encodePoster,
  encodeWebm,
  extractFrame,
  fileSize,
  humanSize,
  mixNarration,
  probeStreams,
  volumeDetect,
} from './demo-video/render.js';

/** Silence between the end of a scene's narration and the start of the next. */
const NARRATION_PAD_SECONDS = 0.9;
const GIF_MAX_BYTES = 12 * 1024 * 1024;

/** Tried in order against `/api/search`; the first one with hits is what the search scene types. */
const SEARCH_CANDIDATES = ['cache', 'tests', 'refactor', 'error', 'the'];

interface Args {
  base: string;
  out: string;
  scratch: string;
  voice?: string;
  audio: boolean;
  gifSeconds: number;
  width: number;
  height: number;
  frames: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    base: 'http://127.0.0.1:4141',
    out: 'docs/demo',
    scratch: '.cca-scratch/demo-video/work',
    audio: true,
    gifSeconds: 28,
    width: 1440,
    height: 900,
    frames: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--base' && next) { args.base = next.replace(/\/$/, ''); i++; }
    else if (flag === '--out' && next) { args.out = next; i++; }
    else if (flag === '--scratch' && next) { args.scratch = next; i++; }
    else if (flag === '--voice' && next) { args.voice = next; i++; }
    else if (flag === '--no-audio') args.audio = false;
    else if (flag === '--gif-seconds' && next) { args.gifSeconds = Number(next); i++; }
    else if (flag === '--width' && next) { args.width = Number(next); i++; }
    else if (flag === '--height' && next) { args.height = Number(next); i++; }
    else if (flag === '--frames') args.frames = true;
    else if (flag === '--help' || flag === '-h') { process.stdout.write(usage()); process.exit(0); }
    else throw new Error(`unknown argument: ${String(flag)}`);
  }
  if (!Number.isFinite(args.gifSeconds) || args.gifSeconds <= 0) throw new Error('--gif-seconds must be a positive number');
  if (!Number.isFinite(args.width) || !Number.isFinite(args.height)) throw new Error('--width/--height must be numbers');
  return args;
}

function usage(): string {
  return [
    'scripts/demo-video.ts — narrated screen tour of the Ledger',
    '',
    '  --base <url>          running, indexed server (default http://127.0.0.1:4141)',
    '  --out <dir>           where demo.mp4/webm/gif, poster.jpg and narration.txt land',
    '  --scratch <dir>       working files (default .cca-scratch/demo-video/work)',
    '  --voice <name>        a `say -v ?` voice; defaults to the best installed en_US one',
    '  --no-audio            silent video, scene lengths fall back to their minimums',
    '  --gif-seconds <n>     how much of the tour the GIF covers (default 28)',
    '  --width/--height <n>  viewport and video size (default 1440×900)',
    '  --frames              also write four review frames into the scratch dir',
    '',
  ].join('\n');
}

interface Plan {
  scene: Scene;
  startMs: number;
  durationMs: number;
}

/** Scene lengths from the measured narration, floored at each scene's own minimum. */
function planScenes(scenes: Scene[], segments: Segment[] | null): Plan[] {
  let cursor = 0;
  return scenes.map((scene, index) => {
    const spoken = segments?.[index]?.seconds ?? 0;
    const seconds = Math.max(spoken + NARRATION_PAD_SECONDS, scene.min);
    const plan: Plan = { scene, startMs: Math.round(cursor * 1000), durationMs: Math.round(seconds * 1000) };
    cursor += seconds;
    return plan;
  });
}

async function findRecording(dir: string): Promise<string> {
  const entries = await readdir(dir);
  const webm = entries.filter((name) => name.endsWith('.webm')).sort();
  const last = webm[webm.length - 1];
  if (!last) throw new Error(`Playwright wrote no video into ${dir}`);
  return path.join(dir, last);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (line: string): void => { process.stdout.write(`${line}\n`); };

  // A fresh recording dir: `findRecording` takes the newest .webm, and a stale one from an
  // earlier run in the same scratch space would be indistinguishable.
  const videoDir = path.join(args.scratch, 'recording');
  await rm(videoDir, { recursive: true, force: true });
  const audioDir = path.join(args.scratch, 'audio');
  await mkdir(args.out, { recursive: true });
  await mkdir(videoDir, { recursive: true });
  await mkdir(audioDir, { recursive: true });

  // 1. Narration first: the tour cannot be paced until the segments have been measured.
  let voice = 'none (--no-audio)';
  let segments: Segment[] | null = null;
  if (args.audio) {
    voice = pickVoice(await installedVoices(), args.voice);
    log(`voice: ${voice}`);
    segments = await synthesize(SCENES, voice, audioDir);
  } else {
    log('voice: none (--no-audio)');
  }

  const plan = planScenes(SCENES, segments);
  const totalMs = plan.reduce((sum, item) => sum + item.durationMs, 0);
  const totalSeconds = totalMs / 1000;
  log(`planned total: ${totalSeconds.toFixed(2)}s across ${plan.length} scenes`);

  const scriptFile = path.join(args.out, 'narration.txt');
  await writeFile(
    scriptFile,
    [
      '# AI Cost Analyzer — demo narration',
      `# voice: ${voice} · rate ${178} wpm · planned total ${totalSeconds.toFixed(1)}s`,
      '',
      ...plan.map((item) => `[${(item.startMs / 1000).toFixed(1)}s · ${(item.durationMs / 1000).toFixed(1)}s] ${item.scene.id}\n${item.scene.narration}\n`),
    ].join('\n'),
    'utf8',
  );

  // 2. Record.
  const browser = await chromium.launch();
  let videoFile: string;
  let preRollMs = 0;
  let actualMs = 0;
  try {
    const context = await browser.newContext({
      viewport: { width: args.width, height: args.height },
      deviceScaleFactor: 1,
      colorScheme: 'light',
      reducedMotion: 'no-preference',
      recordVideo: { dir: videoDir, size: { width: args.width, height: args.height } },
    });
    // Paper, always — the theme scene switches to slate on camera.
    await context.addInitScript(() => {
      (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem('cca.theme', 'paper');
    });
    await context.addInitScript({ content: CURSOR_INIT });

    const page = await context.newPage();
    const recordingStartedAt = Date.now();
    // A renderer crash is the one failure a scene's own try/catch cannot describe.
    page.on('crash', () => { log('  !! the page crashed — the rest of the tour will be missing'); });
    page.on('close', () => { log('  !! the page closed'); });
    page.on('pageerror', (error) => { log(`  !! page error: ${error.message.split('\n')[0]}`); });

    // Boot once so the app takes its session cookie and the fonts are in cache; the time this
    // costs is trimmed off the front of the video rather than eaten by the intro scene.
    await page.goto(`${args.base}/`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForTimeout(700);

    // The row the "most expensive session" scenes open. Read over the API, not by scraping.
    let sessionId: string | null = null;
    try {
      const response = await page.request.get(`${args.base}/api/sessions?sort=cost&limit=1`);
      if (response.ok()) {
        const body = (await response.json()) as { sessions?: { id: string }[] };
        sessionId = body.sessions?.[0]?.id ?? null;
      }
    } catch {
      sessionId = null;
    }
    log(sessionId ? 'target session: resolved from /api/sessions?sort=cost' : 'target session: none in index');

    // A search term that actually hits in *this* index. A hard-coded word shows an empty state
    // on a small fixture set, which is the one scene where empty says nothing about the app.
    let searchQuery = SEARCH_CANDIDATES[0] ?? 'the';
    for (const candidate of SEARCH_CANDIDATES) {
      try {
        const response = await page.request.get(`${args.base}/api/search?q=${encodeURIComponent(candidate)}&limit=5`);
        if (!response.ok()) continue;
        const body = (await response.json()) as { groups?: unknown[] };
        if ((body.groups?.length ?? 0) > 0) { searchQuery = candidate; break; }
      } catch {
        // keep trying the next candidate
      }
    }
    log(`search term: "${searchQuery}"`);

    // Park the pointer low and slightly off centre: the first move is then a glide rather than a
    // jump from 0,0, and it does not sit on top of the intro card's wordmark.
    await page.mouse.move(Math.round(args.width * 0.52), Math.round(args.height * 0.86), { steps: 1 });

    const stage = new Stage(page, args.base, log);
    const t0 = Date.now();
    preRollMs = t0 - recordingStartedAt;

    for (const item of plan) {
      await sleep(t0 + item.startMs - Date.now());
      const startedLate = Date.now() - (t0 + item.startMs);
      stage.setSceneEnd(t0 + item.startMs + item.durationMs);
      log(`scene ${item.scene.id} @ ${(item.startMs / 1000).toFixed(1)}s${startedLate > 150 ? ` (+${startedLate}ms late)` : ''}`);
      await stage.safe(`scene ${item.scene.id}`, () => item.scene.run({ stage, sessionId, searchQuery }));
      await stage.holdUntilEnd();
    }

    actualMs = Date.now() - t0;
    await context.close();
    videoFile = await findRecording(videoDir);
  } finally {
    await browser.close();
  }

  log(`recorded ${(actualMs / 1000).toFixed(2)}s (pre-roll trimmed: ${(preRollMs / 1000).toFixed(2)}s)`);

  // 3. Stitch. The finished file is as long as the plan, so the audio lines up — unless the
  // recording is shorter (a crashed renderer), in which case say so rather than mux silence.
  const recordedSeconds = (await probeDuration(videoFile)) - preRollMs / 1000;
  if (recordedSeconds < totalSeconds - 2) {
    log(`  !! recording is ${(totalSeconds - recordedSeconds).toFixed(1)}s shorter than the plan; the tail is missing`);
  }
  const outputDuration = Math.min(totalSeconds, recordedSeconds);
  let audioFile: string | null = null;
  if (segments) {
    audioFile = path.join(audioDir, 'narration.wav');
    await mixNarration(segments, plan.map((item) => item.startMs), outputDuration, audioFile);
  }

  const encodeInput = {
    video: videoFile,
    preRollSeconds: preRollMs / 1000,
    audio: audioFile,
    width: args.width,
    height: args.height,
    durationSeconds: outputDuration,
  };

  const mp4 = path.join(args.out, 'demo.mp4');
  const webm = path.join(args.out, 'demo.webm');
  const gif = path.join(args.out, 'demo.gif');
  const poster = path.join(args.out, 'poster.jpg');

  await encodeMp4(encodeInput, mp4);
  await encodeWebm(encodeInput, webm);
  const gifResult = await encodeGif(mp4, Math.min(args.gifSeconds, outputDuration), gif, path.join(args.scratch, 'palette.png'), GIF_MAX_BYTES);
  const posterPlan = plan.find((item) => item.scene.id === POSTER_SCENE) ?? plan[1] ?? plan[0];
  const posterAt = posterPlan ? posterPlan.startMs / 1000 + Math.min(2, posterPlan.durationMs / 2000) : 2;
  await encodePoster(mp4, posterAt, 1440, poster);

  if (args.frames) {
    const framesDir = path.join(args.scratch, 'frames');
    await mkdir(framesDir, { recursive: true });
    const picks: { name: string; at: number }[] = [
      { name: 'intro', at: 1.2 },
      { name: 'midtour', at: posterAt },
      { name: 'search', at: (plan.find((p) => p.scene.id === 'search')?.startMs ?? 0) / 1000 + 5 },
      { name: 'outro', at: Math.max(0, outputDuration - 1.5) },
    ];
    for (const pick of picks) {
      const file = path.join(framesDir, `${pick.name}.png`);
      await extractFrame(mp4, pick.at, file);
      log(`frame ${pick.name} @ ${pick.at.toFixed(1)}s → ${file}`);
    }
  }

  // 4. Report.
  log('');
  log('scene                 start      dur   narration');
  log('--------------------- -------- ------- ---------------------------------------------');
  for (const item of plan) {
    const words = item.scene.narration.length > 44 ? `${item.scene.narration.slice(0, 43)}…` : item.scene.narration;
    log(
      `${item.scene.id.padEnd(21)} ${(item.startMs / 1000).toFixed(2).padStart(7)}s ${(item.durationMs / 1000).toFixed(2).padStart(6)}s  ${words}`,
    );
  }
  log(`${'TOTAL'.padEnd(21)} ${''.padStart(8)} ${totalSeconds.toFixed(2).padStart(6)}s`);
  log('');
  for (const file of [mp4, webm, gif, poster, scriptFile]) {
    log(`${path.relative(process.cwd(), file).padEnd(28)} ${humanSize(await fileSize(file)).padStart(10)}`);
  }
  log(`gif settings: ${gifResult.fps} fps · ${gifResult.width}px · ${humanSize(gifResult.bytes)}${gifResult.bytes > GIF_MAX_BYTES ? '  ⚠ over the 12 MB target' : ''}`);
  log('');
  log(`ffprobe ${path.basename(mp4)}:`);
  log(await probeStreams(mp4));
  if (audioFile) {
    log('');
    log(`volumedetect ${path.basename(mp4)}: ${await volumeDetect(mp4)}`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
