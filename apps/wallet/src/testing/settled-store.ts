import type { Port } from 'midnight-identity/profile/store';

/**
 * **A WAY FOR A TEST TO WAIT FOR A WRITE NOBODY AWAITS.** Second cause.
 *
 * `screens/approve.tsx` writes its history entry with `void save(...)` —
 * deliberately not awaited, and **correctly so: a key that has gone cannot be
 * un-given, so the write must never gate the answer**, and a failed write
 * raises a visible problem instead. That is product behaviour and it stays.
 *
 * The consequence is that the screen says *"They have the key"* BEFORE the
 * record reaches the store, so a test that reads storage on the next line is
 * racing a promise it cannot see. It usually wins. Under load it does not:
 * §1 watched *"THE KEY IS ON NO SCREEN, IN NO RECORD, IN NO STORE AND IN NO
 * URL"* fail at **106 milliseconds** on its POSITIVE control while every
 * key-absence assertion in it passed.
 *
 * **106ms AND 1,017ms ARE DIFFERENT DEFECTS AND THEY LOOK IDENTICAL**, which is
 * the whole of it: a project whose people have learned that red means run
 * it again cannot tell them apart, and one of the two is real.
 *
 * ── WHY THIS AND NOT ANOTHER `waitFor` ────────────────────────────────────
 *
 * The tests that already survive this race each wait for **what was written** —
 * *wait until a release is in the profile*, *wait until a grant has a
 * disclosure*. That works and it has two faults. It has to be written afresh
 * for every kind of write, so a screen with no release to wait for has no
 * pattern to copy; and **it is a wait a test can simply forget**, which is
 * exactly how the 106ms failure got in and stayed.
 *
 * **This waits for THE WRITE, not for what the write said.** It is content-free,
 * so it is the same three lines on every screen, and it cannot pass early:
 * `afterWrites` records the count BEFORE the press and refuses to return until
 * a NEW write has both arrived and stopped. A test that forgets it fails
 * noisily rather than intermittently.
 */

/** The number this counts is writes, not keys: a save that rewrites one key
 * twice is two. Quiescence is what is being waited for, not a total. */
export interface WatchedPort extends Port {
  /** How many writes this store has taken. Monotonic, never reset. */
  writes(): number;
  /** How many of those wrote a sealed record. Monotonic, never reset. */
  sealedWrites(): number;
  /** Everything in it, joined — for the tests that assert a secret is absent. */
  all(): string;
}

/**
 * **WHETHER A WRITE PUT A SEALED RECORD IN THE STORE**, read off the value's
 * shape: the three fields `seal` produces. Nothing about what it says.
 */
const isSealedRecord = (value: string): boolean => {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown> | null;
    return parsed !== null && typeof parsed === 'object'
      && typeof parsed.v === 'number' && typeof parsed.iv === 'string' && typeof parsed.sealed === 'string';
  } catch {
    return false;
  }
};

export const watchedStore = (): WatchedPort => {
  const map = new Map<string, string>();
  let writes = 0;
  let sealedWrites = 0;
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      writes += 1;
      if (isSealedRecord(v)) sealedWrites += 1;
      map.set(k, v);
    },
    removeItem: (k) => { writes += 1; map.delete(k); },
    writes: () => writes,
    sealedWrites: () => sealedWrites,
    all: () => [...map.values()].join('\n'),
  };
};

/** Long enough for a loaded laptop, short enough that a write which never comes
 * is reported as a test failure rather than as the suite hanging. */
const LIMIT_MS = 8_000;

/** One turn of the event loop, which is what a not-awaited promise needs. */
const tick = async (): Promise<void> => {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
};

/**
 * **CALL IT BEFORE THE PRESS; AWAIT WHAT IT RETURNS AFTER.**
 *
 *     const written = afterWrites(port);
 *     fireEvent.click(screen.getByText('Sign in to …'));
 *     await afterTheSigning();     // the screen has settled
 *     await written();          // now the store may be read
 *
 * **The two halves are both necessary.** Waiting only for a write to ARRIVE
 * would return in the middle of a save that writes more than one key; waiting
 * only for quiet would return immediately, before the write had begun. So it
 * waits for a new write and then for that to stop.
 */
export function afterWrites(port: WatchedPort): () => Promise<void> {
  /*
   * **IT COUNTS SEALED RECORDS, NOT WRITES, AND A SIGN-IN IS WHY.**
   *
   * The press on a sign-in makes two writes. The note of which wallet answered
   * is written at once, in the same turn as the answer. The history is written
   * by `void save(...)`, and a save seals the profile with `crypto.subtle`,
   * which resolves when the platform's crypto finishes rather than on the next
   * turn of the loop. Counting every write, the first one satisfied the wait,
   * two quiet turns passed while the seal was still running, and the test read
   * the store before the history reached it. That is a race decided by how busy
   * the machine is, and on an idle one it is usually won.
   *
   * Every press this helper is used for ends in exactly that save, so waiting
   * for a sealed record is waiting for the write the test is about, and nothing
   * shorter can satisfy it.
   */
  const before = port.sealedWrites();
  return async (): Promise<void> => {
    const deadline = Date.now() + LIMIT_MS;
    while (port.sealedWrites() === before) {
      if (Date.now() > deadline) {
        throw new Error(
          'no sealed record was written to the store after the press. Either the write never '
          + 'happened — which is the defect this is here to catch — or this was called '
          + 'after the press rather than before it.');
      }
      // eslint-disable-next-line no-await-in-loop
      await tick();
    }
    let seen = port.writes();
    let quiet = 0;
    while (quiet < 2) {
      // eslint-disable-next-line no-await-in-loop
      await tick();
      if (port.writes() === seen) {
        quiet += 1;
      } else {
        quiet = 0;
        seen = port.writes();
      }
      if (Date.now() > deadline) {
        throw new Error('the store never stopped being written to.');
      }
    }
  };
}
