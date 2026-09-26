/**
 * **THE WALLET PAYS A PAGE'S PUBLIC DEPOSIT ONLY AS IT SHOWED IT, AND PAYS NOTHING
 * ELSE PUBLICLY.** What the wallet reads from a public deposit, what it balances
 * on the press, and the check of what it added before anything is signed, each
 * driven over a transaction's shape. The same wallet steps over what the page,
 * the wallet SDK's own public balancing and the ledger really build are watched
 * in `contracts/test/a-private-payment-from-the-page.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  BalanceRefused, PAGE_TOKEN_KINDS, PUBLIC_DEPOSIT_TOKEN_KINDS, base64FromBytes, payForThePage, readWhatThePageAsks,
  whyThePublicBalancingIsNotWhatWasApproved,
} from './balance-for-page.js';
import type { BalanceDoors, FacadeForBalancing, LedgerForBalancing, UnboundTransactionLike } from './balance-for-page.js';

const VAULT = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e';
const TOKEN = 'cd'.repeat(32);
const OTHER = 'ef'.repeat(32);
const ME = '46'.repeat(32);
const STRANGER = '33'.repeat(32);
const TX = base64FromBytes(new Uint8Array([1, 2, 3]));

const effects = (over: Record<string, unknown> = {}) => ({
  claimedNullifiers: [], claimedShieldedReceives: [], claimedShieldedSpends: [], claimedContractCalls: [],
  shieldedMints: new Map(), unshieldedMints: new Map(), unshieldedOutputs: new Map(), claimedUnshieldedSpends: new Map(),
  unshieldedInputs: new Map([[{ tag: 'unshielded', raw: TOKEN }, 700n]]),
  ...over,
});
/** A page's public deposit as the ledger hands one back: one call, no coin, owing 700 of the token in the guaranteed part. */
const publicDeposit = (over: {
  call?: Record<string, unknown>; actions?: unknown[]; shape?: Partial<UnboundTransactionLike>;
  owed?: Array<[{ tag: string; raw?: string }, bigint]>;
} = {}): UnboundTransactionLike => ({
  intents: new Map([[5, {
    actions: over.actions ?? [{ address: VAULT, entryPoint: 'depositUnshielded', guaranteedTranscript: { effects: effects() }, ...over.call }],
  }]]),
  imbalances: (segment: number) => new Map(segment === 0 ? (over.owed ?? [[{ tag: 'unshielded', raw: TOKEN }, -700n], [{ tag: 'dust' }, -3n]]) : []),
  ...over.shape,
});
const ledgerReturning = (tx: unknown): LedgerForBalancing => ({ Transaction: { deserialize: () => tx } });
const refusal = (fn: () => unknown): string => {
  try { fn(); return 'accepted'; } catch (e) { return e instanceof BalanceRefused ? e.message : `threw ${String(e)}`; }
};

describe('WHAT THE WALLET READS FROM A PAGE\'S PUBLIC DEPOSIT', () => {
  it('NAMES ONE PUBLIC TOKEN AND ITS AMOUNT AS LEAVING THIS WALLET, READ FROM THE TRANSACTION', () => {
    const read = readWhatThePageAsks(ledgerReturning(publicDeposit()), TX, VAULT);
    /* RED WHEN: a public deposit is read as private, or its token or amount are taken from anywhere but the call's own effects. */
    expect(read.pays).toBe('public');
    expect(read.leaves).toEqual([{ token: TOKEN, amount: '700', kind: 'unshielded' }]);
  });

  it('REFUSES A PUBLIC DEPOSIT THAT ASKS FOR ANYTHING MORE, OR OWES ANYTHING ELSE', () => {
    const one = { address: VAULT, entryPoint: 'depositUnshielded', guaranteedTranscript: { effects: effects() } };
    const cases: Array<[string, UnboundTransactionLike, RegExp]> = [
      ['two calls', publicDeposit({ actions: [one, one] }), /calls the vault's public deposit more than once/],
      ['another contract', publicDeposit({ call: { address: 'ee'.repeat(32) } }), /calls a contract other than the vault/],
      ['money paid out', publicDeposit({ call: { guaranteedTranscript: { effects: effects({ unshieldedOutputs: new Map([[{ tag: 'unshielded', raw: TOKEN }, 1n]]) }) } } }), /more than public money going into the vault/],
      ['a coin claimed', publicDeposit({ call: { guaranteedTranscript: { effects: effects({ claimedShieldedSpends: ['c'] }) } } }), /more than public money/],
      ['a public coin claimed for someone', publicDeposit({ call: { guaranteedTranscript: { effects: effects({ claimedUnshieldedSpends: new Map([[['t', 'a'], 1n]]) }) } } }), /more than public money/],
      ['two tokens', publicDeposit({ call: { guaranteedTranscript: { effects: effects({ unshieldedInputs: new Map([[{ tag: 'unshielded', raw: TOKEN }, 700n], [{ tag: 'unshielded', raw: OTHER }, 1n]]) }) } } }), /more than one public token/],
      ['owes more than the vault receives', publicDeposit({ owed: [[{ tag: 'unshielded', raw: TOKEN }, -701n]] }), /owes something other than what it puts into the vault/],
      ['owes another token', publicDeposit({ owed: [[{ tag: 'unshielded', raw: TOKEN }, -700n], [{ tag: 'unshielded', raw: OTHER }, -1n]] }), /owes something other/],
      ['owes private money', publicDeposit({ owed: [[{ tag: 'unshielded', raw: TOKEN }, -700n], [{ tag: 'shielded', raw: OTHER }, -1n]] }), /needs private money from this wallet as well/],
      ['unreadable', publicDeposit({ call: { guaranteedTranscript: { effects: null } } }), /could not read what the page's public deposit asks for/],
      ['no transcript', publicDeposit({ call: { guaranteedTranscript: undefined } }), /could not read/],
      ['a DUST registration riding along', publicDeposit({ shape: { intents: new Map([[5, { actions: [one], dustActions: { spends: [], registrations: [{}] } }]]) } }), /also spends or registers DUST/],
      ['a DUST spend riding along', publicDeposit({ shape: { intents: new Map([[5, { actions: [one], dustActions: { spends: [{}], registrations: [] } }]]) } }), /also spends or registers DUST/],
      ['a token minted', publicDeposit({ call: { guaranteedTranscript: { effects: effects({ unshieldedMints: new Map([['d', 1n]]) }) } } }), /more than public money/],
      ['another contract called from it', publicDeposit({ call: { guaranteedTranscript: { effects: effects({ claimedContractCalls: [[0n, 'x', 'y', 0n]] }) } } }), /more than public money/],
      ['moves public money of its own', publicDeposit({ shape: { intents: new Map([[5, { actions: [one], guaranteedUnshieldedOffer: { inputs: [], outputs: [1] } }]]) } }), /moves public money/],
    ];
    for (const [why, tx, says] of cases) {
      /* RED WHEN: the wallet shows a person a public deposit that pays for more than the vault receives. */
      expect(refusal(() => readWhatThePageAsks(ledgerReturning(tx), TX, VAULT)), why).toMatch(says);
    }
  });

  it('A CALL TO ANYTHING BUT THE PUBLIC DEPOSIT WITH NO COIN IS STILL REFUSED AS BEFORE', () => {
    const noCoin = publicDeposit({ call: { entryPoint: 'deposit' } });
    /* RED WHEN: the public reading swallows a private deposit that makes no coin. */
    expect(refusal(() => readWhatThePageAsks(ledgerReturning(noCoin), TX, VAULT))).toMatch(/creates 0 coins in the vault/);
  });
});

describe('THE PRESS, FOR A PUBLIC DEPOSIT', () => {
  const LEAVES = [{ token: TOKEN, amount: '700', kind: 'unshielded' as const }];
  const added = (outputs: Array<{ value: bigint; owner: string; type: string }>, inputs = [{ value: 1000n, type: TOKEN }]) =>
    ({ intents: new Map([[5, { guaranteedUnshieldedOffer: { inputs, outputs } }]]), imbalances: () => new Map() });
  const doorsWith = (recipe: unknown, log: string[], own: string | null = ME): BalanceDoors => ({
    ledger: async () => ledgerReturning(publicDeposit()),
    facade: async () => ({
      balanceUnboundTransaction: async (_t, _k, options) => { log.push(`balance ${options.tokenKindsToBalance.join(',')}`); return recipe; },
      signRecipe: async () => { log.push('sign'); return 'signed'; },
      finalizeRecipe: async () => { log.push('finish'); return { serialize: () => new Uint8Array([7]) }; },
      revert: async () => { log.push('revert'); },
    }) as FacadeForBalancing,
    keys: () => ({ shieldedSecretKeys: 'z', dustSecretKey: 'd' }),
    signSegment: () => async () => ({}) as never,
    ...(own === null ? {} : { ownPublicAddress: () => own }),
    now: () => 1_000,
  });

  it('BALANCES THE PUBLIC LEG ONLY, CHECKS WHAT IT ADDED, THEN SIGNS AND FINISHES', async () => {
    const log: string[] = [];
    const recipe = { type: 'UNBOUND_TRANSACTION', baseTransaction: added([{ value: 300n, owner: ME, type: TOKEN }]) };
    expect(await payForThePage(doorsWith(recipe, log), publicDeposit(), { pays: 'public', leaves: LEAVES })).toBe(base64FromBytes(new Uint8Array([7])));
    /* RED WHEN: a public deposit is balanced in any kind but the public one, or signed before what was added is checked. */
    expect(log).toEqual(['balance unshielded', 'sign', 'finish']);
    expect([...PUBLIC_DEPOSIT_TOKEN_KINDS]).toEqual(['unshielded']);
    /* And a private deposit still balances only the private leg. */
    expect([...PAGE_TOKEN_KINDS]).toEqual(['shielded']);
    const privately: string[] = [];
    await payForThePage(doorsWith('recipe', privately), publicDeposit());
    expect(privately[0]).toBe('balance shielded');
  });

  it('SIGNS NOTHING, AND LETS THE BOOKING GO, WHEN WHAT IT ADDED IS NOT WHAT WAS SHOWN', async () => {
    const cases: Array<[string, unknown]> = [
      ['change to a stranger', { baseTransaction: added([{ value: 300n, owner: STRANGER, type: TOKEN }]) }],
      ['more spent than shown', { baseTransaction: added([{ value: 299n, owner: ME, type: TOKEN }]) }],
      ['less spent than shown', { baseTransaction: added([{ value: 301n, owner: ME, type: TOKEN }]) }],
      ['another token spent', { baseTransaction: added([{ value: 300n, owner: ME, type: TOKEN }], [{ value: 1000n, type: TOKEN }, { value: 5n, type: OTHER }]) }],
      ['a second transaction added', { baseTransaction: added([{ value: 300n, owner: ME, type: TOKEN }]), balancingTransaction: {} }],
      ['DUST actions in what it would sign', { baseTransaction: { ...added([{ value: 300n, owner: ME, type: TOKEN }]), intents: new Map([[5, { guaranteedUnshieldedOffer: { inputs: [{ value: 1000n, type: TOKEN }], outputs: [{ value: 300n, owner: ME, type: TOKEN }] }, dustActions: { spends: [], registrations: [{}] } }]]) } }],
      ['a private coin in what it would sign', { baseTransaction: { ...added([{ value: 300n, owner: ME, type: TOKEN }]), guaranteedOffer: { inputs: [], outputs: [1] } } }],
      ['nothing readable', { balancingTransaction: {} }],
    ];
    for (const [why, recipe] of cases) {
      const log: string[] = [];
      /* RED WHEN: the wallet signs a public payment it did not show, or keeps what it booked for it. */
      await expect(payForThePage(doorsWith(recipe, log), publicDeposit(), { pays: 'public', leaves: LEAVES }), why)
        .rejects.toThrow(/so it signed nothing\. Nothing has been paid\./);
      expect(log, why).toEqual(['balance unshielded', 'revert']);
    }
  });

  it('PAYS NOTHING PUBLICLY WITHOUT ITS OWN ADDRESS, OR FOR ANYTHING BUT ONE PUBLIC AMOUNT', async () => {
    for (const [why, doors, approved] of [
      ['no address', doorsWith({}, [], null), { pays: 'public' as const, leaves: LEAVES }],
      ['a private amount', doorsWith({}, []), { pays: 'public' as const, leaves: [{ ...LEAVES[0]!, kind: 'shielded' as const }] }],
      ['two amounts', doorsWith({}, []), { pays: 'public' as const, leaves: [LEAVES[0]!, LEAVES[0]!] }],
    ] as const) {
      const log: string[] = [];
      await expect(payForThePage({ ...doors, facade: async () => { log.push('facade'); return doors.facade(); } }, publicDeposit(), approved), why)
        .rejects.toBeInstanceOf(BalanceRefused);
      /* RED WHEN: the wallet starts balancing a public payment it cannot check. */
      expect(log, why).toEqual([]);
    }
  });

  it('THE CHECK ITSELF: ONLY CHANGE BACK TO THIS WALLET, AND EXACTLY THE AMOUNT SHOWN, NET', () => {
    expect(whyThePublicBalancingIsNotWhatWasApproved({ baseTransaction: added([{ value: 300n, owner: ME, type: TOKEN }]) }, LEAVES[0]!, ME)).toBeNull();
    expect(whyThePublicBalancingIsNotWhatWasApproved({ baseTransaction: added([], [{ value: 700n, type: TOKEN }]) }, LEAVES[0]!, `0x${ME.toUpperCase()}`)).toBeNull();
    expect(whyThePublicBalancingIsNotWhatWasApproved({ baseTransaction: added([]) }, LEAVES[0]!, ME)).toMatch(/different public amount/);
  });
});
