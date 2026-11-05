import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWatcher } from '../../server/watcher.js';

describe.each(['chatSessions', 'emptyWindowChatSessions'])('Copilot snapshot watcher at %s root', leaf => {
  it('indexes a changed JSON snapshot when the watch event contains only its basename', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cca-watch-'));
    const root = join(home, leaf); mkdirSync(root);
    const requestIncremental = vi.fn();
    const watcher = startWatcher([root], { requestIncremental });
    try {
      const file = join(root, 'synthetic.json');
      writeFileSync(file, JSON.stringify({ sessionId: 'synthetic', requests: [] }));
      await vi.waitFor(() => expect(requestIncremental).toHaveBeenCalledWith([file]), { timeout: 6000, interval: 50 });
    } finally { watcher.dispose(); rmSync(home, { recursive: true, force: true }); }
  }, 10000);
});
