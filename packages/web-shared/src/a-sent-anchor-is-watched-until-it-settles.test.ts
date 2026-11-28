/**
 * **WHERE A SENT ANCHOR WENT, WATCHED ON ITS OWN** (`whereTheSendWent`): while the send has not answered, the account's
 * head is read at the watch's interval; `landed` once it is the head the batch makes, `superseded` once it is any other
 * than the one the call names, and nothing more read once the send settled.
 */
import { describe, it, expect } from 'vitest';
import { whereTheSendWent } from './records-anchored-here.js';

const FROM = 'aa'.repeat(32);
const TO = 'bb'.repeat(32);
const OTHER = 'cc'.repeat(32);

/** The account's anchors as the chain answers them in turn: each read gives the next head, the last one from then on. */
const headsInTurn = (...heads: string[]) => {
  let reads = 0;
  const waited: number[] = [];
  const doors = {
    onChain: async () => {
      const head = heads[Math.min(reads, heads.length - 1)]!;
      reads += 1;
      return { landed: [{ head }] } as never;
    },
    watch: {
      everyMs: 1234,
      sleep: async (ms: number) => {
        waited.push(ms);
        await new Promise((r) => {
          setTimeout(r, 0);
        });
      }
    }
  };
  return { doors, reads: () => reads, waited };
};

describe('a sent anchor watched while its send has not answered', () => {
  it("is landed once the head is the one the batch makes, read at the watch's interval until then", async () => {
    const chain = headsInTurn(FROM, FROM, TO);
    /* RED WHEN: the head the batch makes is not taken as landed, or is compared in another letter case. */
    await expect(whereTheSendWent(chain.doors, FROM, TO.toUpperCase(), { done: false })).resolves.toBe('landed');
    expect(chain.reads()).toBe(3);
    /* RED WHEN: the watch reads the chain at another interval than the one it was given. */
    expect(chain.waited).toEqual([1234, 1234, 1234]);
  });

  it('is superseded once the head is any other than the one the call names', async () => {
    const chain = headsInTurn(FROM, OTHER);
    /* RED WHEN: a call naming an old head is waited on after another anchor moved the head past it. */
    await expect(whereTheSendWent(chain.doors, FROM, TO, { done: false })).resolves.toBe('superseded');
  });

  it('reads nothing more, and answers nothing, once the send settled', async () => {
    const chain = headsInTurn(FROM);
    const settled = { done: false };
    let answered = false;
    void whereTheSendWent(chain.doors, FROM, TO, settled).then(() => {
      answered = true;
    });
    await new Promise((r) => {
      setTimeout(r, 5);
    });
    const read = chain.reads();
    expect(read).toBeGreaterThan(0);
    settled.done = true;
    await new Promise((r) => {
      setTimeout(r, 5);
    });
    /* RED WHEN: the watch goes on reading the chain after the send answered, or answers a race already settled. */
    expect(chain.reads()).toBeLessThanOrEqual(read + 1);
    const after = chain.reads();
    await new Promise((r) => {
      setTimeout(r, 5);
    });
    expect(chain.reads()).toBe(after);
    expect(answered).toBe(false);
  });
});
