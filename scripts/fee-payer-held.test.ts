import { describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';
import { AGAIN_SOON_MS, STUCK_MS, feePayerHeld, type HeldParts } from './fee-payer-held.js';

/** A running wallet the test can fail: its whole state and its DUST part each a subject. */
function parts(name: string) {
  const whole = new Subject<unknown>();
  const dust = new Subject<unknown>();
  const stopped: string[] = [];
  const held: HeldParts & { name: string } = {
    name,
    provider: { name },
    facade: { state: () => whole, dust: { state: dust } },
    dust: () => 1n,
    night: () => 1n,
    stop: () => {
      stopped.push(name);
    }
  };
  return { held, whole, dust, stopped };
}

const settled = () =>
  new Promise((r) => {
    setTimeout(r, 0);
  });

function holderOver(first: ReturnType<typeof parts>, next: Array<ReturnType<typeof parts> | Error>, clock = { t: 0 }) {
  const rebuilds: boolean[] = [];
  const saved: string[] = [];
  const notes: string[] = [];
  const holder = feePayerHeld(first.held, {
    rebuild: async (fromTheChain) => {
      rebuilds.push(fromTheChain);
      const n = next.shift();
      if (n === undefined || n instanceof Error) throw n ?? new Error('nothing to build');
      return n.held;
    },
    save: async (p) => {
      saved.push((p as { name?: string }).name ?? '?');
    },
    note: (l) => {
      notes.push(l);
    },
    now: () => clock.t
  });
  return { holder, rebuilds, saved, notes };
}

describe("the fee payer's wallet is held in one place and built again when it fails", () => {
  /* RED WHEN: a failure of the DUST part is not watched, so nothing builds the wallet again. */
  it('a failure of the DUST part starts one rebuild, and a second failure while it builds starts none', async () => {
    const a = parts('a');
    const b = parts('b');
    const { rebuilds, notes } = holderOver(a, [b]);
    a.dust.error(new Error('Wallet.Sync: unknown block hash'));
    a.whole.error(new Error('[object ErrorEvent]'));
    await settled();
    expect(rebuilds).toEqual([false]);
    expect(notes[0]).toContain('its DUST part failed (Wallet.Sync: unknown block hash)');
  });

  /* RED WHEN: the rebuilt wallet takes over the moment it is built, in the middle of a payment. */
  it('the rebuilt wallet is used only once it is handed over, the old one is stopped and the new one saved', async () => {
    const a = parts('a');
    const b = parts('b');
    const { holder, saved } = holderOver(a, [b]);
    a.whole.error(new Error('[object ErrorEvent]'));
    await settled();
    expect(holder.current()).toBe(a.held);
    holder.settle();
    await settled();
    expect(holder.current()).toBe(b.held);
    expect(a.stopped).toEqual(['a']);
    expect(saved).toEqual(['b']);
  });

  /* RED WHEN: a saved state that failed once is restored again straight after, and fails the same way. */
  it('a failure soon after a rebuild reads the chain itself; one much later reads the saved state again', async () => {
    const clock = { t: 0 };
    const a = parts('a');
    const b = parts('b');
    const c = parts('c');
    const d = parts('d');
    const { holder, rebuilds } = holderOver(a, [b, c, d], clock);
    holder.recover('first');
    await settled();
    holder.settle();
    clock.t += AGAIN_SOON_MS - 1;
    holder.recover('soon after');
    await settled();
    holder.settle();
    clock.t += AGAIN_SOON_MS;
    holder.recover('much later');
    await settled();
    expect(rebuilds).toEqual([false, true, false]);
  });

  /* RED WHEN: a rebuild that fails replaces the wallet with nothing, or stops the next failure from trying again. */
  it('a rebuild that fails leaves the wallet in place, and the next failure tries again', async () => {
    const a = parts('a');
    const b = parts('b');
    const { holder, rebuilds, notes } = holderOver(a, [new Error('the indexer is away'), b]);
    holder.recover('first');
    await settled();
    holder.settle();
    expect(holder.current()).toBe(a.held);
    holder.recover('again');
    await settled();
    holder.settle();
    expect(holder.current()).toBe(b.held);
    expect(rebuilds).toHaveLength(2);
    expect(notes.join('\n')).toContain('failed (the indexer is away)');
  });

  /* RED WHEN: a save during a rebuild writes the failing wallet's state where the rebuild is about to read it. */
  it('nothing is saved while a rebuild is under way or waiting to be handed over', async () => {
    const a = parts('a');
    const b = parts('b');
    const { holder, saved } = holderOver(a, [b]);
    holder.recover('stuck');
    await holder.save();
    await settled();
    await holder.save();
    expect(saved).toEqual([]);
    holder.settle();
    await holder.save();
    expect(saved).toEqual(['b', 'b']);
  });

  /*
   * RED WHEN: a height left below the chain's is never noticed, because the wallet's own streams never report it.
   * RED WHEN: a height that is still moving, or one at the chain's, is taken as stuck.
   */
  it("a DUST height left below the chain's for long enough starts a rebuild; a moving or current one does not", async () => {
    vi.useFakeTimers();
    try {
      const clock = { t: 0 };
      const a = parts('a');
      const { holder, rebuilds } = holderOver(a, [parts('b')], clock);
      let reading = { applied: 10n as bigint | null, tip: 20n };
      const stop = holder.watchHeight(async () => reading, 1_000);
      const tick = async (ms: number) => {
        for (let left = ms; left > 0; left -= 1_000) {
          clock.t += 1_000;
          await vi.advanceTimersByTimeAsync(1_000);
        }
      };
      await tick(1_000);
      for (let i = 0; i < 5; i += 1) {
        reading = { applied: 11n + BigInt(i), tip: 20n };
        await tick(STUCK_MS / 5);
      }
      expect(rebuilds, 'a moving height was taken as stuck').toEqual([]);
      reading = { applied: 20n, tip: 20n };
      await tick(STUCK_MS + 1_000);
      expect(rebuilds, 'a current height was taken as stuck').toEqual([]);
      reading = { applied: 20n, tip: 25n };
      await tick(1_000);
      await tick(STUCK_MS + 1_000);
      expect(rebuilds).toEqual([false]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
