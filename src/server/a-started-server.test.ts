/**
 * **WHAT A TEST STARTS IS STOPPED WHOLE, EVEN WHAT LEAVES ITS GROUP OR OUTLIVES
 * ITS CASE.** The launcher here is Node itself: it starts a middle process that
 * starts two more and exits - one in a process group of its own from the start,
 * one that leaves the launcher's group after the watch has seen it there - so
 * neither is under anybody the launcher leads, or in its group, when the stop
 * comes. That is what a stop reading the process table only when it stops
 * cannot find.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startInItsOwnGroup, stillRunning, stopEverythingStarted, stopTheWholeGroup } from './a-started-server.test-support.js';

const dir = mkdtempSync(join(tmpdir(), 'started-'));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The launcher: a process that starts a middle one, which starts two and exits
 * a second later. One is in a group of its own from the start; the other starts
 * in the launcher's group and makes a group of its own after a second, once the
 * watch has seen it there. The middle one writes down all three ids.
 */
const launcher = (pidFile: string) => startInItsOwnGroup(process.execPath, ['-e', `
  const { spawn } = require('node:child_process');
  spawn(process.execPath, ['-e', \`
    const { spawn } = require('node:child_process');
    const away = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    away.unref();
    const leaver = spawn('perl', ['-MPOSIX', '-e', 'sleep 1; POSIX::setsid(); sleep 1000'], { stdio: 'ignore' });
    leaver.unref();
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, [away.pid, leaver.pid, process.pid].join(' '));
    setTimeout(() => process.exit(0), 1500);
  \`], { stdio: 'ignore' });
  setInterval(() => {}, 1000);
`], { stdio: ['ignore', 'pipe', 'pipe'] });

/** The three ids the middle process wrote down, once it has exited, so nothing it started is under the launcher any more. */
const recorded = async (pidFile: string): Promise<{ away: number; leaver: number }> => {
  while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8') === '') await sleep(50);
  const [away, leaver, middle] = readFileSync(pidFile, 'utf8').split(' ').map(Number);
  for (let i = 0; i < 100 && stillRunning([middle!]).length > 0; i++) await sleep(50);
  expect(stillRunning([middle!])).toEqual([]);
  return { away: away!, leaver: leaver! };
};

afterEach(async () => {
  expect(await stopEverythingStarted()).toEqual([]);
}, 30_000);

describe('A STARTED SERVICE IS STOPPED WHOLE', () => {
  it('A PROCESS THAT LEFT THE GROUP, AND WHOSE PARENT HAS EXITED, IS STOPPED WITH IT', async () => {
    const pidFile = join(dir, 'away-1');
    const child = launcher(pidFile);
    const { away, leaver } = await recorded(pidFile);
    /* Their parent has exited: nothing the launcher leads holds either, and neither is in its group now. */
    expect(stillRunning([away, leaver])).toEqual([away, leaver]);
    const left = await stopTheWholeGroup(child);
    /* RED WHEN: the stop reads what runs under the launcher only when it stops, so the process that was never in its group is not killed. */
    expect(stillRunning([away])).toEqual([]);
    /* RED WHEN: a process seen in the launcher's group that has made a group of its own since is not killed. */
    expect(stillRunning([leaver])).toEqual([]);
    expect(left).toEqual([]);
  }, 30_000);

  it('WHAT A CASE STARTED AND NEVER STOPPED IS STOPPED AFTER IT, AND CHECKED', async () => {
    const pidFile = join(dir, 'away-2');
    const child = launcher(pidFile);
    const { away, leaver } = await recorded(pidFile);
    /* The case ends here without stopping anything, as one that ran out of time does. */
    /* RED WHEN: what is stopped after a case is only what the case itself handed over to be stopped. */
    expect(await stopEverythingStarted()).toEqual([]);
    expect(stillRunning([away, leaver, child.pid!])).toEqual([]);
  }, 30_000);
});
