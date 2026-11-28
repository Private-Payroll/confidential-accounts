/**
 * **A READ OF THE CHAIN GOES BEFORE A DOWNLOAD OF PROVING MATERIAL.** The vault worker counts each read it is
 * answering, and the proving warm-up waits while one is under way, so the read a person is waiting on is not slowed
 * by downloads started at sign-in.
 */
import { SERVICE_READ_BOUND_MS } from './read-bound.js';

/**
 * The reads of the network this worker has been asked for and not yet answered, each counted from when it arrives
 * until it is answered, or until SERVICE_READ_BOUND_MS after it started, when the page has stopped waiting for it.
 */
let readsUnderWay = 0;
let whenNoReads: Array<() => void> = [];
export const aReadArrived = (): void => {
  readsUnderWay += 1;
};
export const aReadEnded = (): void => {
  readsUnderWay -= 1;
  if (readsUnderWay > 0) return;
  const go = whenNoReads;
  whenNoReads = [];
  for (const g of go) g();
};

/**
 * Resolves when this worker has no read of the network under way, and after
 * SERVICE_READ_BOUND_MS at the latest: the page stops waiting for a read then,
 * so nothing waits on one longer.
 */
export const readsGoFirst = (): Promise<void> => {
  if (readsUnderWay === 0) return Promise.resolve();
  return new Promise((go) => {
    const timer = setTimeout(() => {
      whenNoReads = whenNoReads.filter((g) => g !== done);
      go();
    }, SERVICE_READ_BOUND_MS);
    const done = (): void => {
      clearTimeout(timer);
      go();
    };
    whenNoReads.push(done);
  });
};
