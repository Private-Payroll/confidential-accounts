/**
 * **A SERVICE A TEST STARTS IS STOPPED WHOLE, AND THE TEST CAN SAY SO.**
 *
 * The service is started through `tsx`, and `tsx` runs it as a child process
 * of its own. Killing `tsx` with `SIGKILL` cannot be passed on, so the service
 * underneath outlived every run that started it, still listening, until the
 * machine ran out of memory.
 *
 * So the launcher is started as the leader of a process group of its own, the
 * whole group is killed, and everything ever seen running under it is killed
 * and looked for again after. What runs under it is read off the process table
 * from the start, every fifth of a second, so a process that later leaves the
 * group, or whose parent exits, is still known. `ps -A -o` reads the same
 * columns on macOS and on Linux, which is why it is used rather than `/proc`,
 * which macOS does not have.
 *
 * What it cannot know of is a process started and orphaned inside one fifth of
 * a second, between two reads: that one is neither killed nor reported.
 *
 * **EVERY PROCESS A CASE STARTED IS STOPPED AFTER THE CASE**, whether the case
 * finished, failed or ran out of time: `stopEverythingStarted` is what each
 * file's `afterEach` calls, so a case that never reached its own stop still
 * reaches the check.
 */
import {
  execFileSync, spawn, type ChildProcess, type ChildProcessByStdio, type SpawnOptionsWithStdioTuple,
  type StdioNull, type StdioPipe,
} from 'node:child_process';
import type { Readable } from 'node:stream';

/** Every process seen running under a launcher since it started, and the watch that keeps reading. */
const watched = new Map<ChildProcess, { readonly seen: Map<number, number>; readonly timer: ReturnType<typeof setInterval> }>();

/**
 * Starts `command` as the leader of its own process group, so the group can be
 * stopped as one, and keeps reading what runs under it until it is stopped.
 */
export const startInItsOwnGroup = (
  command: string, args: ReadonlyArray<string>, options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable> => {
  const child = spawn(command, [...args], { ...options, detached: true });
  const pid = child.pid;
  if (pid !== undefined) {
    /* Each process by its id and the group it was in when seen. */
    const seen = new Map<number, number>();
    const timer = setInterval(() => {
      const group = new Map(processTable().map((r) => [r.pid, r.pgid]));
      for (const p of runningUnder(pid)) if (!seen.has(p) && group.has(p)) seen.set(p, group.get(p)!);
    }, 200);
    timer.unref();
    watched.set(child, { seen, timer });
  }
  return child;
};

interface ProcessRow { readonly pid: number; readonly ppid: number; readonly pgid: number; readonly zombie: boolean }

const processTable = (): ProcessRow[] =>
  execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/u))
    .filter((cols) => cols.length >= 4 && cols.slice(0, 3).every((c) => /^\d+$/u.test(c)))
    .map(([pid, ppid, pgid, stat]) => ({
      pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), zombie: stat!.startsWith('Z'),
    }));

/**
 * Every process running under `pid`, at any depth, and every process in the
 * group `pid` leads, as the process table shows it now. The group is read too
 * because a process whose parent has already exited is no longer under it.
 */
export const runningUnder = (pid: number): number[] => {
  const table = processTable();
  const found: number[] = table.filter((r) => r.pgid === pid && r.pid !== pid && !r.zombie).map((r) => r.pid);
  const queue = [pid, ...found];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const row of table) {
      if (row.ppid === parent && !row.zombie && !found.includes(row.pid)) {
        found.push(row.pid);
        queue.push(row.pid);
      }
    }
  }
  return found;
};

/** Of `pids`, the ones still running: a process that has exited and not yet been collected is not running. */
export const stillRunning = (pids: ReadonlyArray<number>): number[] => {
  const live = new Set(processTable().filter((r) => !r.zombie).map((r) => r.pid));
  return pids.filter((p) => live.has(p));
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Kills the launcher's whole process group and waits for everything that was
 * running under it to be gone. Returns what is still running when `withinMs`
 * runs out, which is empty when the stop worked.
 */
export const stopTheWholeGroup = async (child: ChildProcess, withinMs = 10_000): Promise<number[]> => {
  const pid = child.pid;
  if (pid === undefined) return [];
  const watch = watched.get(child);
  if (watch !== undefined) clearInterval(watch.timer);
  watched.delete(child);
  const under = [...new Set([...(watch?.seen.keys() ?? []), ...runningUnder(pid)])];
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((r) => child.once('exit', () => r()));
  const kill = (target: number) => {
    try {
      process.kill(target, 'SIGKILL');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    }
  };
  kill(-pid);
  /*
   * And each one seen under it that the group's kill does not reach: one still
   * in another group it was seen in, or one that has since made a group of its
   * own, which is how a process leaves its group. An id the system has given to
   * an unrelated process since is in neither, so it is left alone (and named
   * below if it is still running).
   */
  const now = new Map(processTable().filter((r) => !r.zombie).map((r) => [r.pid, r.pgid]));
  for (const [p, group] of watch?.seen ?? []) {
    const groupNow = now.get(p);
    if (groupNow !== undefined && groupNow !== pid && (groupNow === group || groupNow === p)) kill(p);
  }
  const until = Date.now() + withinMs;
  await Promise.race([exited, sleep(withinMs)]);
  let left = stillRunning([pid, ...under]);
  while (left.length > 0 && Date.now() < until) {
    await sleep(50);
    left = stillRunning([pid, ...under]);
  }
  return left;
};

/**
 * **STOPS EVERY LAUNCHER STARTED AND NOT YET STOPPED**, each whole, and returns
 * whatever is still running after: what a file's `afterEach` checks, so a case
 * that ended before stopping what it started is checked all the same.
 */
export const stopEverythingStarted = async (withinMs = 10_000): Promise<number[]> => {
  const left: number[] = [];
  for (const child of [...watched.keys()]) left.push(...await stopTheWholeGroup(child, withinMs));
  return left;
};
