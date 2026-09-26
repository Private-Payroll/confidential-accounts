/**
 * **THE SERVICE PAYS THE FEE ON A PUBLIC DEPOSIT ONLY WHEN IT IS EXACTLY THE
 * TOKEN AND AMOUNT THE PAGE ASKED FOR, INTO THIS VAULT, PAID FROM THE
 * DEPOSITOR'S OWN PUBLIC MONEY.** Each refusal is driven over a transaction's
 * shape, one part changed at a time. The same reader over what the page, the
 * wallet SDK and the ledger really build is watched in
 * `contracts/test/a-private-payment-from-the-page.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { refusalForDeposit, refusalForPublicDeposit, type PublicDepositExpectations } from './vault-submission.js';

const VAULT = 'ab'.repeat(32);
const TOKEN = 'cd'.repeat(32);
const OTHER = 'ef'.repeat(32);
const PAYER_KEY = { tag: 'schnorr', value: '11'.repeat(32) };
const PAYER = '22'.repeat(32);
const STRANGER = '33'.repeat(32);
const addressOf = (owner: unknown): string => {
  if ((owner as { value?: unknown })?.value === PAYER_KEY.value) return PAYER;
  throw new Error('not a key');
};
const EXPECT: PublicDepositExpectations = { vault: VAULT, token: TOKEN, amount: 700n, addressOf };

const effects = (over: Record<string, unknown> = {}) => ({
  claimedNullifiers: [], claimedShieldedReceives: [], claimedShieldedSpends: [], claimedContractCalls: [],
  shieldedMints: new Map(), unshieldedMints: new Map(), unshieldedOutputs: new Map(), claimedUnshieldedSpends: new Map(),
  unshieldedInputs: new Map([[{ tag: 'unshielded', raw: TOKEN }, 700n]]),
  ...over,
});
/** A public deposit as the wallet finishes it: its coin of 1,000 in, 300 back to itself, nothing owed but DUST. */
const finished = (over: {
  call?: Record<string, unknown>; intent?: Record<string, unknown>; top?: Record<string, unknown>;
  owed?: Array<[{ tag: string; raw?: string }, bigint]>;
} = {}) => ({
  intents: new Map([[7, {
    actions: [{ address: VAULT, entryPoint: 'depositUnshielded', guaranteedTranscript: { effects: effects() }, ...over.call }],
    guaranteedUnshieldedOffer: {
      inputs: [{ value: 1000n, owner: PAYER_KEY, type: TOKEN }],
      outputs: [{ value: 300n, owner: PAYER, type: TOKEN }],
    },
    ...over.intent,
  }]]),
  imbalances: (segment: number) => new Map(segment === 0 ? (over.owed ?? [[{ tag: 'unshielded', raw: TOKEN }, 0n], [{ tag: 'dust' }, -5n]]) : []),
  ...over.top,
});

describe('A PUBLIC DEPOSIT, AS THE SERVICE READS IT', () => {
  it('TAKES EXACTLY ONE PUBLIC DEPOSIT OF THIS TOKEN AND AMOUNT INTO THIS VAULT, PAID BY THE DEPOSITOR, OWING ONLY DUST', () => {
    expect(refusalForPublicDeposit(finished(), EXPECT)).toBeNull();
    /* And the private deposit's reader never takes it. */
    expect(refusalForDeposit(finished(), { vault: VAULT })).toMatch(/moves public money as well/);
  });

  it('REFUSES EVERYTHING ELSE, SAYING NOTHING WAS SENT', () => {
    const cases: Array<[string, unknown, PublicDepositExpectations, RegExp]> = [
      ['another vault named', finished(), { ...EXPECT, vault: 'ee'.repeat(32) }, /must call this vault's public deposit and nothing else/],
      ['another amount named', finished(), { ...EXPECT, amount: 699n }, /exactly the token and amount asked for/],
      ['another token named', finished(), { ...EXPECT, token: OTHER }, /exactly the token and amount asked for/],
      ['the private deposit called', finished({ call: { entryPoint: 'deposit' } }), EXPECT, /must call this vault's public deposit/],
      ['two calls', { ...finished(), intents: new Map([[7, { ...finished().intents.get(7)!, actions: [finished().intents.get(7)!.actions[0], finished().intents.get(7)!.actions[0]] }]]) }, EXPECT, /must call this vault's public deposit and nothing else/],
      ['two sets of actions', { ...finished(), intents: new Map([[7, finished().intents.get(7)!], [8, finished().intents.get(7)!]]) }, EXPECT, /exactly one set of actions/],
      ['a deploy', finished({ call: { entryPoint: undefined } }), EXPECT, /must call this vault's public deposit/],
      ['the call pays money out', finished({ call: { guaranteedTranscript: { effects: effects({ unshieldedOutputs: new Map([[{ tag: 'unshielded', raw: TOKEN }, 1n]]) }) } } }), EXPECT, /asks for more than public money going into the vault/],
      ['the call takes a coin', finished({ call: { guaranteedTranscript: { effects: effects({ claimedShieldedReceives: ['c'] }) } } }), EXPECT, /asks for more than public money/],
      ['the call mints', finished({ call: { guaranteedTranscript: { effects: effects({ unshieldedMints: new Map([['d', 1n]]) }) } } }), EXPECT, /asks for more than public money/],
      ['the call claims a public coin to someone', finished({ call: { guaranteedTranscript: { effects: effects({ claimedUnshieldedSpends: new Map([[['t', 'a'], 1n]]) }) } } }), EXPECT, /asks for more than public money/],
      ['the call asks for two tokens', finished({ call: { guaranteedTranscript: { effects: effects({ unshieldedInputs: new Map([[{ tag: 'unshielded', raw: TOKEN }, 700n], [{ tag: 'unshielded', raw: OTHER }, 1n]]) }) } } }), EXPECT, /exactly the token and amount/],
      ['split over both parts, to another total', finished({ call: { fallibleTranscript: { effects: effects({ unshieldedInputs: new Map([[{ tag: 'unshielded', raw: TOKEN }, 1n]]) }) } } }), EXPECT, /exactly the token and amount/],
      ['no transcript', finished({ call: { guaranteedTranscript: undefined } }), EXPECT, /could not be read/],
      ['unreadable effects', finished({ call: { guaranteedTranscript: { effects: { ...effects(), unshieldedInputs: [] } } } }), EXPECT, /could not be read/],
      ['a private coin as well', finished({ top: { guaranteedOffer: { inputs: [], outputs: [1], transients: [] } } }), EXPECT, /moves private money as well/],
      ['a private coin in a fallible part', finished({ top: { fallibleOffer: new Map([[1, { inputs: [], outputs: [1], transients: [] }]]) } }), EXPECT, /moves private money as well/],
      ['owing in the intent\'s own part', finished({ top: { imbalances: (s: number) => new Map(s === 7 ? [[{ tag: 'unshielded', raw: TOKEN }, -1n]] : []) } }), EXPECT, /does not balance in its own money/],
      ['a fee paid elsewhere', finished({ intent: { dustActions: { spends: [1], registrations: [] } } }), EXPECT, /already pays a network fee/],
      ['nobody pays for it', finished({ intent: { guaranteedUnshieldedOffer: undefined }, owed: [[{ tag: 'unshielded', raw: TOKEN }, -700n]] }), EXPECT, /nobody's public money pays for it/],
      ['change to a stranger', finished({ intent: { guaranteedUnshieldedOffer: { inputs: [{ value: 1000n, owner: PAYER_KEY, type: TOKEN }], outputs: [{ value: 300n, owner: STRANGER, type: TOKEN }] } } }), EXPECT, /pays public money to someone other than the vault/],
      ['an input nobody can name', finished({ intent: { guaranteedUnshieldedOffer: { inputs: [{ value: 1000n, owner: { value: 'x' }, type: TOKEN }], outputs: [] } } }), EXPECT, /could not be read/],
      ['it does not balance', finished({ owed: [[{ tag: 'unshielded', raw: TOKEN }, -1n]] }), EXPECT, /does not balance in its own money/],
      ['it owes private money', finished({ owed: [[{ tag: 'shielded', raw: TOKEN }, -1n]] }), EXPECT, /does not balance in its own money/],
      ['its sums cannot be read', finished({ top: { imbalances: undefined } }), EXPECT, /could not be read/],
    ];
    for (const [why, tx, expect_, says] of cases) {
      const refusal = refusalForPublicDeposit(tx, expect_);
      /* RED WHEN: the service pays the fee on a public deposit that is not exactly what the page asked for. */
      expect(refusal, why).toMatch(says);
      expect(refusal, why).toMatch(/Nothing was sent/);
    }
  });
});
