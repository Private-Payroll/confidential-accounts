/*
 * The builder's answers that depend only on what is asked are asked once on a device: every opening and every change
 * not yet held goes in one ask, a second read of the same asks nothing, a failed or short answer keeps nothing, and the
 * seats invitations took are joined and kept the same way, with a read that leaves a proposal out keeping nothing. The
 * heads head steps make and the seats holders name are kept the same way, and an answer that is not whole is refused.
 */
import { describe, expect, it } from 'vitest';
import { anchorHeadsKept, builderAnswersOf } from './builder-answers-kept.js';
import { seatsAskedTogether } from './seat-not-read-on-the-chain.js';
import type { VaultBuilderClient } from './vault-worker-client.js';

const opening = (n: number) => ({ publicKey: `0${n}`, scope: `1${n}`, blinding: `2${n}` });

const aBuilder = (
  answer: (openings: readonly { publicKey: string }[]) => unknown[] = (o) =>
    o.map((x) => ({ leaf: `leaf${x.publicKey}`, tag: `tag${x.publicKey}` }))
) => {
  const asked: { openings: string[][]; identities: string[] } = { openings: [], identities: [] };
  let fails = 0;
  const builder = {
    seatOpenings: async ({ openings }: { openings: readonly { publicKey: string }[] }) => {
      asked.openings.push(openings.map((o) => o.publicKey));
      if (fails > 0) {
        fails -= 1;
        throw new Error('the builder could not be reached');
      }
      return { openings: answer(openings) };
    },
    proposalIdentity: async (_change: unknown, salt: string) => {
      asked.identities.push(salt);
      return { chainId: `id${salt}` };
    }
  } as unknown as Pick<VaultBuilderClient, 'seatOpenings' | 'proposalIdentity'>;
  return {
    builder,
    asked,
    failNext: () => {
      fails += 1;
    }
  };
};

describe('WHAT THE BUILDER WORKS OUT FROM WHAT IT IS ASKED ALONE IS ASKED ONCE ON A DEVICE', () => {
  it('openings asked together go in one ask, and a second read of them asks nothing', async () => {
    const { builder, asked } = aBuilder();
    const answers = builderAnswersOf(builder);
    const [a, b] = await Promise.all([
      answers.openings('acc', [opening(1), opening(2)]),
      answers.openings('acc', [opening(2), opening(3)])
    ]);
    /* RED WHEN: each read of the directory asks the builder for every opening again, so its asks grow with every read. */
    expect(asked.openings).toEqual([['01', '02', '03']]);
    expect([a.map((x) => x.leaf), b.map((x) => x.leaf)]).toEqual([
      ['leaf01', 'leaf02'],
      ['leaf02', 'leaf03']
    ]);
    await builderAnswersOf(builder).openings('ACC', [opening(3), opening(1)]);
    expect(asked.openings).toEqual([['01', '02', '03']]);
  });

  it('an opening is asked again on another account, and on another builder', async () => {
    const { builder, asked } = aBuilder();
    await builderAnswersOf(builder).openings('acc', [opening(1)]);
    await builderAnswersOf(builder).openings('other', [opening(1)]);
    /* RED WHEN: an opening's leaf made on one account is used for the same opening on another. */
    expect(asked.openings).toEqual([['01'], ['01']]);
    const another = aBuilder();
    await builderAnswersOf(another.builder).openings('acc', [opening(1)]);
    expect(another.asked.openings).toEqual([['01']]);
  });

  it('a failed ask keeps nothing, so the next read asks again', async () => {
    const { builder, asked, failNext } = aBuilder();
    failNext();
    await expect(builderAnswersOf(builder).openings('acc', [opening(1)])).rejects.toThrow(/could not be reached/u);
    /* RED WHEN: a builder that failed once is never asked again, so its failure is served to every later read. */
    expect((await builderAnswersOf(builder).openings('acc', [opening(1)]))[0]?.leaf).toBe('leaf01');
    expect(asked.openings).toEqual([['01'], ['01']]);
  });

  it('an answer with an opening missing is refused and keeps nothing', async () => {
    let short = true;
    const { builder, asked } = aBuilder((o) =>
      (short ? o.slice(1) : o).map((x) => ({ leaf: `leaf${x.publicKey}`, tag: null }))
    );
    /* RED WHEN: a builder that answers fewer openings than it was asked has its answers matched to the wrong seats. */
    await expect(builderAnswersOf(builder).openings('acc', [opening(1), opening(2)])).rejects.toThrow(
      /entries for the 2 asked/u
    );
    short = false;
    expect((await builderAnswersOf(builder).openings('acc', [opening(1), opening(2)])).map((x) => x.leaf)).toEqual([
      'leaf01',
      'leaf02'
    ]);
    expect(asked.openings).toHaveLength(2);
  });

  it('a proposal is worked out once for each change and salt', async () => {
    const { builder, asked } = aBuilder();
    const change = { kind: 'seat', address: 'a' } as never;
    const answers = builderAnswersOf(builder);
    await Promise.all([
      answers.proposalIdentity(change, 's1'),
      answers.proposalIdentity(change, 's1'),
      answers.proposalIdentity(change, 's2')
    ]);
    /* RED WHEN: every read of the directory asks the builder for every invitation's proposal again. */
    expect((await builderAnswersOf(builder).proposalIdentity(change, 's1')).chainId).toBe('ids1');
    expect(asked.identities).toEqual(['s1', 's2']);
  });
});

describe('THE SEATS INVITATIONS TOOK ARE ASKED OF THE CHAIN ONCE FOR A READ', () => {
  const aChain = (leaveOut: string | null = null) => {
    const asked: string[][] = [];
    const read = async (proposals: readonly string[]) => {
      asked.push([...proposals]);
      return Object.fromEntries(proposals.filter((p) => p !== leaveOut).map((p) => [p, p === 'p1' ? 'leaf1' : null]));
    };
    return { read, asked };
  };

  it('proposals asked in one turn go in one read, and asked again they read nothing', async () => {
    const { read, asked } = aChain();
    const seats = seatsAskedTogether(read);
    const [a, b] = await Promise.all([seats(['p1', 'p2']), seats(['p2'])]);
    /* RED WHEN: each read of the directory asks the chain about every invitation's proposal again. */
    expect(asked).toEqual([['p1', 'p2']]);
    expect([a, b]).toEqual([{ p1: 'leaf1', p2: null }, { p2: null }]);
    expect(await seats(['p1'])).toEqual({ p1: 'leaf1' });
    expect(asked).toHaveLength(1);
  });

  it('a read that leaves a proposal out is refused and keeps nothing', async () => {
    const chain = aChain('p2');
    const seats = seatsAskedTogether(chain.read);
    /* RED WHEN: a proposal the chain's read left out is taken as one that took no seat. */
    await expect(seats(['p1', 'p2'])).rejects.toThrow(/left a proposal out/u);
    await expect(seats(['p1'])).resolves.toEqual({ p1: 'leaf1' });
    expect(chain.asked).toEqual([['p1', 'p2'], ['p1']]);
  });

  it('a failed read reaches every reader as it was thrown, and the next read asks again', async () => {
    let fail = true;
    const asked: string[][] = [];
    const named = Object.assign(new Error('no indexer'), { name: 'NoIndexerToReadTheChain' });
    const seats = seatsAskedTogether(async (proposals) => {
      asked.push([...proposals]);
      if (fail) throw named;
      return Object.fromEntries(proposals.map((p) => [p, null]));
    });
    /* RED WHEN: a read stopped for want of an indexer reaches its reader as some other stop, or is kept for the next read. */
    await expect(seats(['p1'])).rejects.toBe(named);
    fail = false;
    await expect(seats(['p1'])).resolves.toEqual({ p1: null });
    expect(asked).toHaveLength(2);
  });
});

/** A builder whose heads are named by the step's batch, and whose holders' seats by their approvals, counting each ask. */
const aHeadsBuilder = () => {
  const asked: { after: string[]; holders: number[] }[] = [];
  let short: 'head' | 'seats' | false = false;
  const builder = {
    anchorHeads: async ({
      after,
      holders
    }: {
      after: readonly { batch: string }[];
      holders?: readonly { approvals: number }[];
    }) => {
      asked.push({ after: after.map((x) => x.batch), holders: (holders ?? []).map((h) => h.approvals) });
      const answer = {
        after: after.map((x) => `head${x.batch}`),
        seats: after.map(() => ['s']),
        holderSeats: (holders ?? []).map((h) => [`seat${h.approvals}`])
      };
      if (short === 'head') return { ...answer, after: answer.after.slice(1) };
      if (short === 'seats') {
        const { seats: _left, ...rest } = answer;
        return rest;
      }
      return answer;
    }
  } as unknown as Pick<VaultBuilderClient, 'anchorHeads'>;
  return {
    builder,
    asked,
    shortNext: (of: 'head' | 'seats' = 'head') => {
      short = of;
    },
    whole: () => {
      short = false;
    }
  };
};
const step = (batch: string) =>
  ({ previous: 'aa', batch, held: { approvals: 1, signerRoot: 'bb', signers: [] }, tag: 'cc' }) as never;
const holders = (approvals: number) => ({ approvals, signerRoot: 'bb', signers: [] }) as never;

describe('THE HEADS A BUILDER MAKES AND THE SEATS HOLDERS NAME ARE ASKED ONCE ON A DEVICE', () => {
  it('a second ask for the same steps and holders asks nothing, and a new one asks only what is not held', async () => {
    const { builder, asked } = aHeadsBuilder();
    expect(await anchorHeadsKept(builder)({ after: [step('1'), step('2')], holders: [holders(1)] })).toEqual({
      after: ['head1', 'head2'],
      seats: [['s'], ['s']],
      holderSeats: [['seat1']]
    });
    /* RED WHEN: every held read of a step asks the builder for the same heads again, so its calls grow with the reads. */
    expect(await anchorHeadsKept(builder)({ after: [step('2'), step('1')], holders: [holders(1)] })).toEqual({
      after: ['head2', 'head1'],
      seats: [['s'], ['s']],
      holderSeats: [['seat1']]
    });
    await anchorHeadsKept(builder)({ after: [step('3'), step('1')], holders: [holders(2)] });
    expect(asked).toEqual([
      { after: ['1', '2'], holders: [1] },
      { after: ['3'], holders: [2] }
    ]);
  });

  it('an answer short of a head is refused and keeps nothing, and another builder asks again', async () => {
    const { builder, asked, shortNext, whole } = aHeadsBuilder();
    shortNext();
    /* RED WHEN: a short answer is kept, mended or handed on, so a caller matches heads to steps they were not made from. */
    await expect(anchorHeadsKept(builder)({ after: [step('1'), step('2')] })).rejects.toThrow(
      /did not answer one head/u
    );
    whole();
    expect((await anchorHeadsKept(builder)({ after: [step('1')] })).after).toEqual(['head1']);
    expect(asked.map((a) => a.after)).toEqual([['1', '2'], ['1']]);
    const other = aHeadsBuilder();
    await anchorHeadsKept(other.builder)({ after: [step('1')] });
    expect(other.asked.map((a) => a.after)).toEqual([['1']]);
  });

  it('an answer that leaves the seats out, asked after a step is kept, is refused rather than handed back in its own order', async () => {
    const { builder, shortNext } = aHeadsBuilder();
    await anchorHeadsKept(builder)({ after: [step('1')] });
    shortNext('seats');
    /* RED WHEN: the answer for the steps not kept is handed back as if it answered every step asked, so a head lands on another step. */
    await expect(anchorHeadsKept(builder)({ after: [step('1'), step('2')] })).rejects.toThrow(
      /did not answer one head/u
    );
  });
});
