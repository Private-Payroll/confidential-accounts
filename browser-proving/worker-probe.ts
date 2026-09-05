/**
 * Drives the Worker from the page, exactly as the web app will.
 *
 * Three claims, none of which the unit tests can make:
 *
 *   1. the protocol survives a real `postMessage` boundary, where only
 *      structured-cloneable values cross and nothing shares a reference;
 *   2. the work happens on ANOTHER thread — checked by keeping the main thread
 *      busy and watching the job finish anyway;
 *   3. the jobs are still there for a second Worker after the first is gone,
 *      which is what a reloaded tab actually does.
 */
import { JobClient, webPort } from '../src/core/jobs-worker.js';

const out = document.getElementById('out')!;
const lines: string[] = [];
const say = (s: string) => { lines.push(s); out.textContent = lines.join('\n'); };
const result: Record<string, unknown> = {};

const makeWorker = (db: string) => {
  const w = new Worker(new URL('./worker-entry.ts', import.meta.url), { type: 'module' });
  return w;
};

async function main() {
  result.indexedDB = typeof indexedDB !== 'undefined';
  say(`IndexedDB available on the page: ${result.indexedDB}`);

  const dbName = 'probe-jobs-' + Math.random().toString(36).slice(2, 8);
  (globalThis as any).__DB_NAME__ = dbName;

  const worker = makeWorker(dbName);
  const client = new JobClient(webPort(worker as any));

  const seen: string[] = [];
  client.onChange((j) => seen.push(`${j.id}:${j.state}`));

  const job = await client.enqueue({ accountId: 'acc_1', kind: 'approve', signerId: 'A' });
  say(`enqueued ${job.id} — durable before anything was proved`);
  result.enqueued = job.id;

  /*
   * Block the MAIN thread while the Worker proves.
   *
   * This is the whole point of the file. A busy loop here would starve a
   * promise-based "background" task completely; if the job still finishes, the
   * work genuinely happened somewhere else.
   */
  const spinUntil = Date.now() + 120;
  while (Date.now() < spinUntil) { /* deliberately blocking */ }
  result.mainThreadBlockedMs = 120;

  await client.drain();
  const done = await client.get(job.id);
  result.state = done?.state;
  result.txRef = done?.txRef;
  say(`after drain: ${done?.state}, tx ${done?.txRef}`);

  const states = seen.filter((s) => s.startsWith(job.id)).map((s) => s.split(':')[1]);
  result.transitions = states;
  say(`transitions across the thread: ${states.join(' -> ')}`);

  // 3. A second Worker over the same database: what a reloaded tab does.
  const second = makeWorker(dbName);
  const client2 = new JobClient(webPort(second as any));
  const recovered = await client2.get(job.id);
  result.survivedRestart = recovered?.state === 'settled' && recovered?.id === job.id;
  say(`a fresh Worker found the finished job: ${result.survivedRestart}`);

  const pendingAfter = await client2.pending();
  result.pendingAfterRestart = pendingAfter.length;
  say(`nothing left pending: ${pendingAfter.length === 0}`);

  // And that a job left unfinished IS picked up rather than forgotten.
  const leftover = await client2.enqueue({ accountId: 'acc_1', kind: 'execute', signerId: 'A' });
  const third = makeWorker(dbName);
  const client3 = new JobClient(webPort(third as any));
  const found = await client3.get(leftover.id);
  result.unfinishedIsVisible = !!found;
  say(`an unfinished job is visible to a later Worker: ${result.unfinishedIsVisible}`);

  worker.terminate(); second.terminate(); third.terminate();
  result.ok =
    result.state === 'settled' &&
    result.survivedRestart === true &&
    result.unfinishedIsVisible === true &&
    states.join(',') === 'queued,proving,proven,submitting,settled';
}

main().then(
  () => { (window as any).__RESULT__ = result; say('\nDONE'); },
  (e) => {
    result.ok = false;
    result.error = String(e?.stack ?? e?.message ?? e);
    (window as any).__RESULT__ = result;
    say('\nFAILED: ' + result.error);
  },
);
