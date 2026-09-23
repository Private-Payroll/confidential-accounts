/**
 * **EACH QUESTION THE PAGE AND THE SERVICE BOTH ASK HAS ONE ANSWER.**
 *
 * The record of a vault's notes against the chain, whether the notes can make
 * the payments, and which payments a proposal is built over are each decided
 * in one place and read by both sides. What runs here is the service's own
 * vault client and this device's own reader over the same record and the same
 * chain; the chain, the record's store and the device's background thread are
 * the doubles, and nothing else is.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pureCircuits as vaultCircuits } from '../../contracts/managed-vault/contract/index.js';
import { VaultLedger } from '../midnight/vault-ledger.js';
import { chainVaultHoldings } from '../midnight/vault-holdings.js';
import { commitmentForNote } from '../midnight/vault-recovery.js';
import { poolAgainstChain } from '../midnight/pool-against-chain.js';
import { paymentsFit, paymentsFitAnswer, type Note } from '../midnight/vault-notes.js';
import { toHex, type Hex } from '../core/crypto.js';
import { refuseWhatTheVaultCannotPay, type HoldingAnswer, type VaultCannotPayThisProposal } from '../core/vault-holdings.js';
import { paymentChecked, paymentsCheckedDigest, paymentsOnTheWire } from '../core/device-raise.js';
import { registryWithTestPrivateForms, testPrivateToken } from '../testing/assets.js';
import { deviceVaultHoldings, type ChainNotesView, type DeviceHoldingsDoors, type PoolNote } from './device-vault-holdings.js';
import { paymentsFitNotes } from './vault-builder.js';
import { answerVaultAsk } from './vault-worker-entry.js';
import { vaultBuilderOver } from './vault-worker-client.js';
import {
  sendRaiseFromDevice, sendRetryFromDevice,
  type GovernedCallService, type RaiseDoors, type RaiseOrderOnTheWire, type RetryOrderOnTheWire,
} from './governed-call-on-device.js';

/*
 * The vault's generated module, faked down to its reader and its shape, with
 * the REAL pure circuits: every commitment compared below is the one the chain
 * would hold, computed the one way both sides compute it.
 */
const SLOTS = ['cell', 'map', 'map', 'cell', 'map'] as const;
const shapedLike = (slots: readonly string[]) => ({
  state: { type: () => 'array', asArray: () => slots.map((k) => ({ type: () => k })) },
});
vi.doMock('../../contracts/managed-vault/contract/index.js', () => ({
  ledger: (d: unknown) => d,
  pureCircuits: vaultCircuits,
  Contract: class {
    constructor(_w: unknown) { /* runs no circuit */ }
    async initialState() { return { currentContractState: { data: shapedLike(SLOTS) } }; }
  },
}));

const VAULT = 'a7'.repeat(32) as Hex;
const GBP = testPrivateToken('GBP') as Hex;
const EUR = testPrivateToken('EUR') as Hex;
const coin = (n: number, value: bigint, token: Hex = GBP) =>
  ({ nonce: n.toString(16).padStart(64, '0') as Hex, token, value });
const heldOf = (c: { nonce: Hex; token: Hex; value: bigint }) => commitmentForNote(vaultCircuits as never, VAULT, c);

/** The service's vault client over a record holding `pool` and a chain holding `chain` (or not answering). */
const theService = (pool: ReturnType<typeof coin>[], chain: ReturnType<typeof coin>[] | 'unreadable') => {
  const onChain = chain === 'unreadable' ? [] : chain.map(heldOf);
  const providers = async () => ({
    publicDataProvider: {
      queryContractState: async () => (chain === 'unreadable' ? null : {
        data: {
          ...shapedLike(SLOTS),
          notes: { member: (c: Uint8Array) => onChain.includes(toHex(c)), size: () => BigInt(onChain.length) },
        },
      }),
    },
  });
  const notes: Note[] = pool.map((c) => ({ ...c, index: 0n }));
  const ledger = new VaultLedger(
    { networkId: 'preview' } as never, {} as never, providers as never, {},
    { load: async () => ({ notes }) } as never, '/nowhere');
  return chainVaultHoldings(ledger);
};

/** This device's reader over the same record and the same chain, as the service's view hands it over. */
const theDevice = (
  pool: ReturnType<typeof coin>[], chain: ReturnType<typeof coin>[] | 'unreadable',
  over: Partial<DeviceHoldingsDoors> = {},
) => deviceVaultHoldings({
  chain: async (): Promise<ChainNotesView> => {
    if (chain === 'unreadable') throw new Error('the chain could not be read for this vault: no state');
    return { onChain: true, notesFromThisBuild: true, notes: chain.map(heldOf).map((h) => h.toUpperCase()) };
  },
  pool: async () => pool.map((c) => ({ ...c, createdIn: 'ee'.repeat(32) as Hex })),
  heldCommitmentOf: async (_v, n) => heldOf(n),
  paymentsFit: async (notes, payments) => paymentsFitNotes({
    notes: notes.map((n) => ({ nonce: n.nonce, token: n.token, value: n.value.toString(), createdIn: n.createdIn! })),
    payments: payments.map((p) => ({ token: p.token, amount: p.amount.toString() })),
  }),
  ...over,
});

const answerOf = (a: HoldingAnswer) => (a.of === 'held' ? `held ${a.amount}` : a.of);
const assetGBP = registryWithTestPrivateForms().require('GBP' as never);
const refusalOf = async (reader: ReturnType<typeof theService>, amount: bigint) =>
  refuseWhatTheVaultCannotPay(reader, {
    vault: VAULT, asset: assetGBP, total: amount, payees: 1n,
    payments: [{ payee: { kind: 'shielded' }, token: GBP, amount }],
  }, ['shielded']).then(() => 'pays', (e: VaultCannotPayThisProposal) => e.why);

describe('1. THE DEVICE AND THE SERVICE GIVE THE SAME ANSWER ON THE SAME RECORD AND CHAIN', () => {
  const A = coin(1, 600n);
  const B = coin(2, 400n);
  const C = coin(3, 250n);
  const cases: Array<[string, ReturnType<typeof coin>[], ReturnType<typeof coin>[] | 'unreadable', string]> = [
    ['they agree', [A, B], [A, B], 'held 1000'],
    ['they agree on an empty vault', [], [], 'held 0'],
    ['the record holds a note the chain does not', [A, B], [A], 'contradicted'],
    ['the chain holds a note the record does not', [A], [A, B], 'contradicted'],
    ['the record is empty and the chain is not', [], [C], 'contradicted'],
    ['as many notes, but not the same ones', [A], [B], 'contradicted'],
    ['the record holds one note twice', [A, A], [A], 'contradicted'],
    ['the chain does not answer', [A], 'unreadable', 'unreadable'],
  ];
  for (const [why, pool, chain, expected] of cases) {
    it(why, async () => {
      const service = await theService(pool, chain).held(VAULT, 'shielded', GBP);
      const device = await theDevice(pool, chain).held(VAULT, 'shielded', GBP);
      /* RED WHEN: either side classifies the drift differently - a copy of the comparison has come back, or it was changed on one side. */
      expect(answerOf(device), 'device').toBe(expected);
      expect(answerOf(service), 'service').toBe(expected);
    });
  }

  it('A DRIFTED CHAIN IS CONTRADICTED, NEVER SHORT, ON BOTH SIDES', async () => {
    /*
     * The record holds 600 and the chain holds two notes: a reader that summed the record would say the vault is
     * 400 short of a 1,000 payment and tell a person to deposit money the vault may already hold.
     */
    for (const reader of [theService([A], [A, B]), theDevice([A], [A, B])]) {
      /* RED WHEN: the chain holding more than the record is read as a balance. */
      expect(await refusalOf(reader, 1_000n)).toBe('contradicted');
    }
    for (const reader of [theService([], [C]), theDevice([], [C])]) {
      expect(await refusalOf(reader, 1n)).toBe('contradicted');
    }
  });

  it('decides the answer in one place, which both sides call', () => {
    const held = [{ note: 'a', commitment: 'x' }, { note: 'b', commitment: 'y' }];
    const chain = (xs: string[]) => ({ has: (c: string) => xs.includes(c), size: BigInt(xs.length) });
    /* RED WHEN: the comparison's answers or their order change - the record claiming more is named before any count. */
    expect(poolAgainstChain(held, chain(['x', 'y']))).toEqual({ of: 'agrees' });
    expect(poolAgainstChain(held, chain(['x']))).toEqual({ of: 'pool-claims-more', missing: ['b'] });
    expect(poolAgainstChain(held, chain(['x', 'y', 'z']))).toEqual({ of: 'counts-differ', chainHolds: 3n, poolHolds: 2n });
    expect(poolAgainstChain(held, chain(['z', 'w']))).toEqual({ of: 'pool-claims-more', missing: ['a', 'b'] });
    expect(poolAgainstChain([], chain([]))).toEqual({ of: 'agrees' });
    /* RED WHEN: a record holding one note twice is read as agreeing - its value would be counted twice. */
    expect(poolAgainstChain([{ note: 'a', commitment: 'x' }, { note: 'a2', commitment: 'x' }], chain(['x'])))
      .toEqual({ of: 'counts-differ', chainHolds: 1n, poolHolds: 2n });
  });

  it('no file compares a record of notes with the chain but the one that decides it', () => {
    /* RED WHEN: a reader counts or matches the chain's notes itself again rather than asking `poolAgainstChain`. */
    for (const f of ['src/midnight/vault-ledger.ts', 'src/web/device-vault-holdings.ts']) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).toMatch(/poolAgainstChain\(/u);
      expect(text, f).not.toMatch(/\.size\s*(!==|===)\s*(notes\.length|held)\b|missing\.push\(|notes\.filter\(\(n\)\s*=>\s*!onChain/u);
    }
  });
});

describe('2. A SHORTFALL IS "DOES NOT FIT" BY ITS TYPE, WHATEVER ITS WORDS', () => {
  const pool = [coin(1, 60n), coin(2, 60n)];

  it('the walk answers a real shortfall with its type, and the refusal a payment gives keeps its words', () => {
    const answer = paymentsFitAnswer({ notes: pool.map((c) => ({ ...c, index: 0n, createdIn: 'ee'.repeat(32) as Hex })) },
      [{ token: GBP, amount: 100n }]);
    expect(answer).toMatchObject({ of: 'does-not-fit', payment: 1, payments: 1 });
    /* RED WHEN: the payment path's own sentence changes while this answer is read - the two are written by one function. */
    expect(() => paymentsFit({ notes: pool.map((c) => ({ ...c, index: 0n, createdIn: 'ee'.repeat(32) as Hex })) },
      [{ token: GBP, amount: 100n }])).toThrow((answer as { why: string }).why);
  });

  it('the device reads the answer, not the sentence', async () => {
    const reworded = theDevice(pool, pool, {
      paymentsFit: async () => ({ of: 'does-not-fit', payment: 1, payments: 1, why: 'the notes are each smaller than the payment' }),
    });
    /* RED WHEN: "does not fit" is recognised by the words it opens with - these words open with nothing it knew. */
    expect(await reworded.fits(VAULT, [{ payee: { kind: 'shielded' }, token: GBP, amount: 100n }]))
      .toEqual({ of: 'does-not-fit', why: 'the notes are each smaller than the payment' });
    /* And a real one, through the real walk. */
    const real = await theDevice(pool, pool).fits(VAULT, [{ payee: { kind: 'shielded' }, token: GBP, amount: 100n }]);
    expect(real.of).toBe('does-not-fit');
    /* RED WHEN: the advice to merge reaches a screen - no vault can merge its notes. */
    expect((real as { why: string }).why).toMatch(/^payment 1 of 1 cannot be made out of this vault: no single note covers 100/u);
    expect((real as { why: string }).why).not.toMatch(/Merge/u);
  });

  it('a failure to ask is passed on as that, never as money short', async () => {
    const thrown = new Error('payment 1 of 1 cannot be made out of this vault: the background thread did not start');
    const device = theDevice(pool, pool, { paymentsFit: async () => { throw thrown; } });
    /* RED WHEN: a thrown error whose words look like a shortfall is read as one. */
    await expect(device.fits(VAULT, [{ payee: { kind: 'shielded' }, token: GBP, amount: 10n }])).rejects.toBe(thrown);
    const nonsense = theDevice(pool, pool, { paymentsFit: async () => ({ of: 'maybe' }) as never });
    /* RED WHEN: an answer that is neither is read as either. */
    await expect(nonsense.fits(VAULT, [{ payee: { kind: 'shielded' }, token: GBP, amount: 10n }])).rejects.toThrow(/did not finish on this device\. Reload the page and try again/u);
  });
});

/* ── 3. the device refuses what the service will not raise ───────────────── */

const LEG = { asset: 'GBP', payments: [0, 1].map(() => ({ kind: 'shielded', token: GBP as string, amount: '100' })) };
const RUN = { root: '88'.repeat(32), payees: '2', opensAt: '1', closesAt: '2', vault: VAULT as string };
const HALF = { assetId: '44'.repeat(32), assetBlinding: '55'.repeat(32), proposalSalt: '66'.repeat(32), changeAmount: '1', changeBatchDigest: '77'.repeat(32) };
const ORDER: RaiseOrderOnTheWire = {
  proposalId: 'prp_1', chainId: 'cc'.repeat(32),
  order: { circuit: 'propose', run: RUN, half: HALF, proposal: 'cc'.repeat(32) },
  paymentsChecked: paymentsCheckedDigest(LEG.payments),
};
const aSender = (order: RaiseOrderOnTheWire) => {
  const log: string[] = [];
  const service = {
    legPayments: async () => { log.push('leg-payments'); return LEG; },
    raiseOrder: async () => order,
    retryOrder: async () => ({ ...order, indices: [0, 1] }),
    retryPayments: async () => { log.push('retry-payments'); return LEG; },
    callState: async () => { log.push('call-state'); return { account: 'ac'.repeat(32), blockHash: 'b', accountState: 'AS', parameters: 'PP' }; },
    sendRaise: async () => { log.push('send'); return { id: 'prp_1', chainId: 'cc'.repeat(32), status: 'open', raisedAt: 'now' }; },
    sendRetry: async () => { log.push('send'); return { id: 'prp_1', chainId: 'cc'.repeat(32), status: 'open', raisedAt: 'now' }; },
    standing: async () => ({ id: 'prp_1', chainId: 'cc'.repeat(32), status: 'open', raisedAt: 'now' }),
  } as unknown as GovernedCallService;
  const pool = [coin(1, 1_000n)];
  const doors: RaiseDoors = {
    service, holdings: theDevice(pool, pool), assets: registryWithTestPrivateForms(),
    builder: { governedCall: async () => { log.push('build'); return { tx: 'TX' }; } },
    material: { signingSecret: '11'.repeat(32), blinding: '22'.repeat(32), scope: '33'.repeat(32) },
    accountId: 'acc_1', sleep: async () => {}, waitMs: 2, everyMs: 1,
  };
  return { log, doors };
};

describe('3. THE DEVICE REFUSES A LEG WHOSE PAYMENTS ARE NOT WHAT THE SERVICE WILL RAISE', () => {
  it('builds and sends when the proposal written down pays what was checked', async () => {
    const s = aSender(ORDER);
    await sendRaiseFromDevice(s.doors, { runId: 'run_1', viewingKey: 'vk', asset: 'GBP' });
    expect(s.log).toEqual(['leg-payments', 'call-state', 'build', 'send']);
  });

  for (const [why, order] of [
    ['an amount changed', { ...ORDER, paymentsChecked: paymentsCheckedDigest([LEG.payments[0]!, { ...LEG.payments[1]!, amount: '101' }]) }],
    ['one payment fewer', { ...ORDER, paymentsChecked: paymentsCheckedDigest(LEG.payments.slice(1)) }],
    ['no digest at all', { ...ORDER, paymentsChecked: undefined as never }],
  ] as const) {
    it(`refuses a raise before anything is built or sent: ${why}`, async () => {
      const s = aSender(order);
      /* RED WHEN: the device checks the list it was handed against itself and builds a proposal that pays something else. */
      await expect(sendRaiseFromDevice(s.doors, { runId: 'run_1', viewingKey: 'vk', asset: 'GBP' }))
        .rejects.toThrow(/not the payments in the proposal written down for it, so this device did not build it\. Nothing was sent\. Reload the page/u);
      expect(s.log).toEqual(['leg-payments']);
    });
  }

  it('checks the count of payees against the proposal written down, not against the list', async () => {
    const s = aSender({ ...ORDER, order: { ...ORDER.order, run: { ...RUN, payees: '3' } } });
    /* RED WHEN: the count the signers approve is taken from the same list it is compared with. */
    await expect(sendRaiseFromDevice(s.doors, { runId: 'run_1', viewingKey: 'vk', asset: 'GBP' }))
      .rejects.toThrow(/raised over 3 payments and 2 were handed in/u);
    expect(s.log).toEqual(['leg-payments']);
    const unread = aSender({ ...ORDER, order: { ...ORDER.order, run: { ...RUN, payees: 'two' } } });
    await expect(sendRaiseFromDevice(unread.doors, { runId: 'run_1', viewingKey: 'vk', asset: 'GBP' }))
      .rejects.toThrow(/does not say how many people it pays/u);
  });

  it('refuses a retry the same way', async () => {
    const order = { ...ORDER, paymentsChecked: paymentsCheckedDigest(LEG.payments.slice(1)) };
    const s = aSender(order);
    await expect(sendRetryFromDevice(s.doors, { runId: 'run_1', viewingKey: 'vk', asset: 'GBP', proposalId: 'prp_1' }))
      .rejects.toThrow(/not the payments in the proposal written down/u);
    expect(s.log).toEqual(['retry-payments']);
    const good = aSender({ ...ORDER, indices: [0, 1] } as RetryOrderOnTheWire);
    await sendRetryFromDevice(good.doors, { runId: 'run_1', viewingKey: 'vk', asset: 'GBP', proposalId: 'prp_1' });
    expect(good.log).toEqual(['retry-payments', 'call-state', 'build', 'send']);
  });
});

describe('4. THE PAYMENTS A DIGEST COVERS ARE WRITTEN IN ONE PLACE', () => {
  it('builds, sends and digests one shape', () => {
    const fact = { payee: { kind: 'shielded' as const, address: 'someone' }, token: GBP, amount: 100n };
    const checked = paymentChecked(fact);
    /* RED WHEN: anything but the kind, the token and the amount is carried - above all who is paid. */
    expect(checked).toEqual({ kind: 'shielded', token: GBP, amount: 100n });
    expect(paymentsOnTheWire([checked])).toEqual([{ kind: 'shielded', token: GBP, amount: '100' }]);
    /* RED WHEN: what the service holds and what it hands to a device digest apart. */
    expect(paymentsCheckedDigest([checked])).toBe(paymentsCheckedDigest(paymentsOnTheWire([checked])));
    /* A list is not a payment: if this line compiles, the shape has been loosened. */
    // @ts-expect-error a payment is its kind, token and amount by name, never a list of three
    expect(() => paymentsCheckedDigest([['shielded', GBP, '100']])).toThrow();
  });

  it('no file outside the one that defines it spells the three fields out again', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/u.test(n) && !/\.test\.tsx?$/u.test(n)) files.push(p);
      }
    };
    walk('src');
    const spelled = /\[\s*\w+(\.payee)?\.kind\s*,\s*\w+\.token\s*,\s*\w+\.amount\s*\]|\{\s*kind:\s*\w+(\.payee)?\.kind\s*,\s*token:\s*\w+\.token\s*,\s*amount:\s*\w+\.amount(\.toString\(\))?\s*\}/u;
    const found = files.filter((f) => relative('.', f) !== join('src', 'core', 'device-raise.ts') && spelled.test(readFileSync(f, 'utf8')));
    /* RED WHEN: a site builds the digested list by hand again - it can then drift from the shape the other side digests. */
    expect(found).toEqual([]);
    expect(files.length).toBeGreaterThan(100);
  });
});

describe('8. THE BACKGROUND THREAD\'S "payments-fit" STEP AND THE DEVICE READER\'S OWN BRANCHES', () => {
  const wire = (c: ReturnType<typeof coin>) => ({ nonce: c.nonce, token: c.token, value: c.value.toString(), createdIn: 'ee'.repeat(32) });

  it('the step answers with the walk\'s typed answer, and crosses to the page as it is', async () => {
    const ask = (payments: Array<{ token: string; amount: string }>) =>
      answerVaultAsk(async () => ({}) as never, { id: 7, network: 'preview', ask: 'payments-fit', notes: [wire(coin(1, 60n))], payments } as never);
    /* RED WHEN: the step stops answering, or answers a shortfall as an error the page must read the words of. */
    expect(await ask([{ token: GBP, amount: '60' }])).toEqual({ id: 7, ok: true, ask: 'payments-fit', answer: { of: 'fits' } });
    expect(await ask([{ token: GBP, amount: '61' }])).toMatchObject({ id: 7, ok: true, answer: { of: 'does-not-fit', payment: 1 } });
    /* RED WHEN: a payment it cannot read is answered as a shortfall rather than refused. */
    await expect(ask([{ token: 'not hex', amount: '1' }])).rejects.toThrow(/notes were not walked/u);

    const listeners: Array<(e: { data: unknown }) => void> = [];
    const client = vaultBuilderOver({
      addEventListener: (_t, l) => { listeners.push(l); },
      postMessage: (m) => {
        void answerVaultAsk(async () => ({}) as never, m as never).then(
          (data) => listeners.forEach((l) => l({ data })),
          (e: Error) => listeners.forEach((l) => l({ data: { id: (m as { id: number }).id, ok: false, error: e.message } })));
      },
    }, 'preview');
    expect(await client.paymentsFit({ notes: [wire(coin(1, 60n))], payments: [{ token: GBP, amount: '61' }] }))
      .toMatchObject({ of: 'does-not-fit', payment: 1, payments: 1 });
  });

  const one = [coin(1, 600n), coin(2, 50n, EUR)];
  it('reads only the token asked about, out of a record the chain agrees with in full', async () => {
    /* RED WHEN: another token's notes are summed into this one's balance. */
    expect(await theDevice(one, one).held(VAULT, 'shielded', GBP.toUpperCase())).toEqual({ of: 'held', amount: 600n });
    expect(await theDevice(one, one).held(VAULT, 'shielded', EUR)).toEqual({ of: 'held', amount: 50n });
  });

  for (const [why, view, expected] of [
    ['no vault at this address yet', { onChain: false }, /no vault at this address/u],
    ['a view that says nothing about being on chain', {}, /no vault at this address/u],
    ['onChain as a word rather than true', { onChain: 'true' }, /no vault at this address/u],
    ['no list of notes', { onChain: true, notesFromThisBuild: true }, /did not say which notes/u],
    ['notes that are not a list', { onChain: true, notesFromThisBuild: true, notes: 'c1' }, /did not say which notes/u],
    ['notes read off a ledger of another shape', { onChain: true, notesFromThisBuild: false, notes: [], notesWhy: 'it holds 4 fields' }, /did not confirm that this vault is laid out the way .*: it holds 4 fields$/u],
    ['notes nobody vouched for', { onChain: true, notes: [] }, /did not confirm that this vault is laid out the way/u],
  ] as const) {
    it(`is unreadable, never a balance: ${why}`, async () => {
      const device = theDevice([], [], { chain: async () => view as never });
      /* RED WHEN: this branch reads as an empty vault - a balance of zero, or a comparison against nothing. */
      const held = await device.held(VAULT, 'shielded', GBP);
      expect(held.of).toBe('unreadable');
      expect((held as { why: string }).why).toMatch(expected);
    });
  }

  it('says which way the counts differ', async () => {
    const A = coin(1, 600n);
    const more = await theDevice([A], [A, coin(2, 1n)]).held(VAULT, 'shielded', GBP);
    const twice = await theDevice([A, A], [A]).held(VAULT, 'shielded', GBP);
    /* RED WHEN: a record counting one note twice is told it is missing money that reached the vault. */
    expect((more as { why: string }).why).toMatch(/money reached the vault that the record does not show$/u);
    expect((twice as { why: string }).why).toMatch(/the record counts one note the chain holds more than once$/u);
  });

  it('a chain that throws is unreadable, with its reason', async () => {
    const device = theDevice(one, 'unreadable');
    /* RED WHEN: a failed read escapes as an exception or reads as a disagreement. */
    expect(await device.held(VAULT, 'shielded', GBP)).toEqual({
      of: 'unreadable', why: 'the chain could not be asked what this vault holds: the chain could not be read for this vault: no state',
    });
  });

  it('leaves public money to the service, on both questions', async () => {
    const device = theDevice(one, one);
    expect((await device.held(VAULT, 'unshielded', GBP)).of).toBe('unreadable');
    /* RED WHEN: a run with a public payee is walked through the notes, which know nothing of public money. */
    expect((await device.fits(VAULT, [{ payee: { kind: 'unshielded' }, token: GBP, amount: 1n }])).of).toBe('unreadable');
    /* RED WHEN: a run that pays both ways has its public payment walked through the notes. */
    expect((await device.fits(VAULT, [
      { payee: { kind: 'shielded' }, token: GBP, amount: 1n }, { payee: { kind: 'unshielded' }, token: GBP, amount: 1n },
    ])).of).toBe('unreadable');
  });
});
