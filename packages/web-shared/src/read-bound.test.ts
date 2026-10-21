import { afterEach, describe, expect, it, vi } from 'vitest';
import { readsAnswered, serviceRead, SERVICE_READ_BOUND_MS } from './read-bound.js';

/**
 * **A SIGN-OUT WAITS FOR THE READS OF THE SERVICE THAT ARE IN FLIGHT, FOR A BOUND, AND THEN GOES AHEAD.**
 *
 * RED WHEN: `readsAnswered` answers while a read of the service started before it is still unanswered and the
 * bound has not run out; it keeps waiting past its bound; it waits for a read that was started after it was
 * asked, or for a read that has answered, refused or run out of time; or a read is held in flight after it ended.
 */
afterEach(() => { vi.useRealTimers(); });

const pending = () => {
  let answer!: (v: string) => void;
  let refuse!: (e: Error) => void;
  const work = () => new Promise<string>((a, r) => { answer = a; refuse = r; });
  return { work, answer: (v: string) => { answer(v); }, refuse: (e: Error) => { refuse(e); } };
};
const isDone = async (p: Promise<void>): Promise<boolean> => {
  let done = false;
  void p.then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(0);
  return done;
};

describe('the reads of the service in flight', () => {
  it('answers at once when none is in flight', async () => {
    vi.useFakeTimers();
    expect(await isDone(readsAnswered(5_000))).toBe(true);
  });

  it('waits for a read in flight to answer, and not beyond it', async () => {
    vi.useFakeTimers();
    const read = pending();
    const got = serviceRead('The service (/api/a)', read.work);
    const waited = readsAnswered(5_000);
    expect(await isDone(waited)).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(await isDone(waited)).toBe(false);
    read.answer('x');
    await got;
    expect(await isDone(waited)).toBe(true);
  });

  it('a read that is refused, or runs out of its own time, counts as answered', async () => {
    vi.useFakeTimers();
    const refused = pending();
    const lost = serviceRead('The service (/api/r)', refused.work).catch(() => 'refused');
    const stuck = serviceRead('The service (/api/s)', () => new Promise<string>(() => {})).catch(() => 'ran out');
    const waited = readsAnswered(SERVICE_READ_BOUND_MS * 2);
    refused.refuse(new Error('401'));
    expect(await isDone(waited)).toBe(false);
    await vi.advanceTimersByTimeAsync(SERVICE_READ_BOUND_MS);
    expect(await isDone(waited)).toBe(true);
    expect([await lost, await stuck]).toEqual(['refused', 'ran out']);
  });

  it('goes ahead when the bound runs out and a read has still not answered', async () => {
    vi.useFakeTimers();
    void serviceRead('The service (/api/slow)', () => new Promise<string>(() => {})).catch(() => {});
    const waited = readsAnswered(5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(await isDone(waited)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await isDone(waited)).toBe(true);
    await vi.advanceTimersByTimeAsync(SERVICE_READ_BOUND_MS);
  });

  it('does not wait for a read started after it was asked, nor for one that has ended', async () => {
    vi.useFakeTimers();
    const ended = pending();
    const first = serviceRead('The service (/api/e)', ended.work);
    ended.answer('x');
    await first;
    const waited = readsAnswered(5_000);
    expect(await isDone(waited)).toBe(true);
    const during = pending();
    const asked = readsAnswered(5_000);
    void serviceRead('The service (/api/later)', during.work);
    expect(await isDone(asked)).toBe(true);
    during.answer('y');
  });
});
