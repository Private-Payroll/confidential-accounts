import type { Port } from 'midnight-identity/profile/store';

/* Lets a test wait for a store write nobody awaits: the screens save their history with `void save(...)` so a write
 * never gates an answer, and a test that reads the store at once races that save. */

/** A store that counts its writes. A save that rewrites one key twice counts two. */
export interface WatchedPort extends Port {
  /** How many writes this store has taken. Monotonic, never reset. */
  writes(): number;
  /** How many of those wrote a sealed record. Monotonic, never reset. */
  sealedWrites(): number;
  /** Everything in it, joined — for the tests that assert a secret is absent. */
  all(): string;
}

/** Whether a write put a sealed record in the store, read off the three fields `seal` produces. */
const isSealedRecord = (value: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      'v' in parsed &&
      typeof parsed.v === 'number' &&
      'iv' in parsed &&
      typeof parsed.iv === 'string' &&
      'sealed' in parsed &&
      typeof parsed.sealed === 'string'
    );
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
    removeItem: (k) => {
      writes += 1;
      map.delete(k);
    },
    writes: () => writes,
    sealedWrites: () => sealedWrites,
    all: () => [...map.values()].join('\n')
  };
};

/** Long enough for a loaded laptop, short enough that a write which never comes fails the test, not hangs the suite. */
const LIMIT_MS = 8_000;

/** One turn of the event loop, which is what a not-awaited promise needs. */
const tick = async (): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
};

/** Call it before the press and await what it returns after: it waits for a new sealed record, then for writes to stop.
 * Waiting only for a write would return mid-save; waiting only for quiet would return before the save began. */
export function afterWrites(port: WatchedPort): () => Promise<void> {
  /* Sealed records, not writes: a sign-in also writes a note at once, while the history's seal finishes later on
   * `crypto.subtle`, so counting every write returned before the history reached the store. */
  const before = port.sealedWrites();
  return async (): Promise<void> => {
    const deadline = Date.now() + LIMIT_MS;
    while (port.sealedWrites() === before) {
      if (Date.now() > deadline) {
        throw new Error(
          'no sealed record was written to the store after the press. Either the write never ' +
            'happened — which is the defect this is here to catch — or this was called ' +
            'after the press rather than before it.'
        );
      }
      await tick();
    }
    let seen = port.writes();
    let quiet = 0;
    while (quiet < 2) {
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
