import { describe, expect, it } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import {
  BalanceRefused, PAGE_TOKEN_KINDS, base64FromBytes, payForThePage, readWhatThePageAsks,
} from './balance-for-page.js';
import type { BalanceDoors, FacadeForBalancing, LedgerForBalancing, UnboundTransactionLike } from './balance-for-page.js';

const VAULT = '54ef954a25aefff8e1675af10a852ef29d5de5c63a51b64b978bf7bd0eaeca4e';
const OTHER = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8';
const GBP = 'ab'.repeat(32);
const NIGHT = '00'.repeat(32);
const TX = base64FromBytes(new Uint8Array([1, 2, 3]));

/** A transaction as the ledger hands one back, reduced to what the wallet reads. */
const intoTheVault = { inputs: [], outputs: [{ contractAddress: VAULT }], transients: [] };
const txOf = (
  actions: unknown[],
  imbalances: Array<[{ tag: string; raw?: string }, bigint]>,
  segments: number[] = [1],
  shape: Partial<UnboundTransactionLike> = {},
): UnboundTransactionLike => ({
  intents: new Map(segments.map((s) => [s, { actions }])),
  imbalances: (segment: number) => new Map(segment === 0 ? imbalances : []),
  guaranteedOffer: intoTheVault,
  ...shape,
});
const ledgerReturning = (tx: unknown): LedgerForBalancing & { asked: unknown[][] } => {
  const asked: unknown[][] = [];
  return {
    asked,
    Transaction: { deserialize: (...args: unknown[]) => { asked.push(args); return tx; } },
  };
};
const deposit = { address: VAULT, entryPoint: 'deposit' };
const refusal = (fn: () => unknown): string => {
  try { fn(); return 'accepted'; } catch (e) { return e instanceof BalanceRefused ? e.message : `threw ${String(e)}`; }
};

describe('WHAT THE WALLET READS BEFORE A PERSON IS SHOWN ANYTHING', () => {
  it('reads the bytes as a PROVEN, UNBOUND transaction and nothing else', () => {
    const ledger = ledgerReturning(txOf([deposit], [[{ tag: 'shielded', raw: GBP }, -1000n]]));
    readWhatThePageAsks(ledger, TX, VAULT);
    expect(ledger.asked[0]!.slice(0, 3)).toEqual(['signature', 'proof', 'pre-binding']);
    expect(Array.from(ledger.asked[0]![3] as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('what leaves is what the transaction consumes beyond what it supplies, and DUST is never on the list', () => {
    const { leaves } = readWhatThePageAsks(ledgerReturning(txOf([deposit], [
      [{ tag: 'shielded', raw: GBP }, -1000n],
      [{ tag: 'dust' }, -999n],
      [{ tag: 'shielded', raw: 'cd'.repeat(32) }, 0n],
      [{ tag: 'shielded', raw: 'ef'.repeat(32) }, 7n],
    ])), TX, VAULT);
    expect(leaves).toEqual([{ token: GBP, amount: '1000', kind: 'shielded' }]);
  });

  it('A COIN FOR ANYONE BUT THE VAULT IS REFUSED, AND SO IS PUBLIC MONEY, A SPEND OF THE PAGE\'S OWN, OR A SECOND COIN', () => {
    const owes: Array<[{ tag: string; raw?: string }, bigint]> = [[{ tag: 'shielded', raw: GBP }, -1000n]];
    const read = (shape: Partial<UnboundTransactionLike>, imbalances = owes) =>
      refusal(() => readWhatThePageAsks(ledgerReturning(txOf([deposit], imbalances, [1], shape)), TX, VAULT));
    /* A coin for the page itself, beside the deposit, paid for by this wallet. */
    expect(read({ guaranteedOffer: { inputs: [], transients: [], outputs: [{ contractAddress: VAULT }, {}] } }))
      .toMatch(/creates a coin for someone other than the vault/u);
    expect(read({ fallibleOffer: new Map([[1, { inputs: [], transients: [], outputs: [{ contractAddress: OTHER }] }]]) }))
      .toMatch(/creates a coin for someone other than the vault/u);
    expect(read({ guaranteedOffer: { inputs: [], transients: [], outputs: [{ contractAddress: VAULT }, { contractAddress: VAULT }] } }))
      .toMatch(/creates 2 coins/u);
    expect(read({ guaranteedOffer: undefined })).toMatch(/creates 0 coins/u);
    expect(read({ guaranteedOffer: { inputs: [{}], transients: [], outputs: [{ contractAddress: VAULT }] } }))
      .toMatch(/spends coins of its own/u);
    expect(read({ guaranteedOffer: { inputs: [], transients: [{}], outputs: [{ contractAddress: VAULT }] } }))
      .toMatch(/spends coins of its own/u);
    expect(read({ intents: new Map([[1, { actions: [deposit], guaranteedUnshieldedOffer: { inputs: [], outputs: [{}] } }]]) }))
      .toMatch(/moves public money/u);
    expect(read({ intents: new Map([[1, { actions: [deposit], fallibleUnshieldedOffer: { inputs: [{}], outputs: [] } }]]) }))
      .toMatch(/moves public money/u);
    expect(read({}, [[{ tag: 'unshielded', raw: NIGHT }, -5n]])).toMatch(/needs public money/u);
    expect(read({}, [...owes, [{ tag: 'shielded', raw: 'cd'.repeat(32) }, -1n]])).toMatch(/more than one kind of token/u);
    /* The vault's address in another spelling, and empty public offers, are the deposit itself. */
    expect(read({
      guaranteedOffer: { inputs: [], transients: [], outputs: [{ contractAddress: VAULT.toUpperCase() }] },
      intents: new Map([[1, { actions: [deposit], guaranteedUnshieldedOffer: { inputs: [], outputs: [] } }]]),
    })).toBe('accepted');
  });

  it('A CALL INTO ANYTHING BUT THE NAMED VAULT IS REFUSED, AND SO IS A DEPLOY OR A RULES CHANGE', () => {
    const owes: Array<[{ tag: string; raw?: string }, bigint]> = [[{ tag: 'shielded', raw: GBP }, -1n]];
    expect(refusal(() => readWhatThePageAsks(ledgerReturning(txOf([{ address: OTHER, entryPoint: 'deposit' }], owes)), TX, VAULT)))
      .toMatch(/calls a contract other than the vault it names/u);
    expect(refusal(() => readWhatThePageAsks(ledgerReturning(txOf([deposit, { address: OTHER, entryPoint: 'x' }], owes)), TX, VAULT)))
      .toMatch(/other than the vault/u);
    expect(refusal(() => readWhatThePageAsks(ledgerReturning(txOf([{ initialState: {} }], owes)), TX, VAULT)))
      .toMatch(/deploys one or changes one's rules/u);
    expect(refusal(() => readWhatThePageAsks(ledgerReturning(txOf([{ address: VAULT, updates: [] }], owes)), TX, VAULT)))
      .toMatch(/deploys one or changes one's rules/u);
    /* The same vault spelled another way is the same vault. */
    expect(refusal(() => readWhatThePageAsks(ledgerReturning(txOf([{ address: VAULT.toUpperCase(), entryPoint: 'deposit' }], owes)), TX, VAULT)))
      .toBe('accepted');
  });

  it('a transaction that calls nothing, or needs nothing from this wallet, is refused', () => {
    expect(refusal(() => readWhatThePageAsks(ledgerReturning(txOf([], [[{ tag: 'shielded', raw: GBP }, -1n]])), TX, VAULT)))
      .toMatch(/calls nothing/u);
    expect(refusal(() => readWhatThePageAsks(ledgerReturning({ imbalances: () => new Map() }), TX, VAULT)))
      .toMatch(/calls nothing/u);
    expect(refusal(() => readWhatThePageAsks(ledgerReturning(txOf([deposit], [[{ tag: 'dust' }, -9n]])), TX, VAULT)))
      .toMatch(/needs nothing from this wallet/u);
  });

  it('with the real ledger: bytes that are not a proven transaction are refused, and so is an unproven deploy', () => {
    const real = L as unknown as LedgerForBalancing;
    expect(refusal(() => readWhatThePageAsks(real, TX, VAULT))).toMatch(/not a proven transaction/u);
    const deploy = L.Transaction.fromParts('undeployed', undefined, undefined,
      L.Intent.new(new Date(Date.now() + 60_000)).addDeploy(new L.ContractDeploy(new L.ContractState())));
    expect(refusal(() => readWhatThePageAsks(real, base64FromBytes(deploy.serialize()), VAULT)))
      .toMatch(/not a proven transaction/u);
  });
});

describe('THE PRESS', () => {
  const tx = txOf([deposit], [[{ tag: 'shielded', raw: GBP }, -1000n]]);
  const doorsWith = (facade: Partial<FacadeForBalancing>, log: string[]): BalanceDoors => ({
    ledger: async () => ledgerReturning(tx),
    facade: async () => ({
      balanceUnboundTransaction: async (_t, _k, options) => { log.push(`balance ${options.tokenKindsToBalance.join(',')} ttl=${options.ttl.getTime()}`); return 'recipe'; },
      signRecipe: async (r) => { log.push(`sign ${String(r)}`); return 'signed'; },
      finalizeRecipe: async (r) => { log.push(`finish ${String(r)}`); return { serialize: () => new Uint8Array([9, 9]) }; },
      revert: async (r) => { log.push(`revert ${String(r)}`); },
      ...facade,
    }) as FacadeForBalancing,
    keys: () => ({ shieldedSecretKeys: 'z', dustSecretKey: 'd' }),
    signSegment: () => async () => ({}) as never,
    now: () => 1_000,
  });

  it('balances the shielded leg ONLY, signs, finishes, and hands back the bytes', async () => {
    const log: string[] = [];
    expect(await payForThePage(doorsWith({}, log), tx)).toBe(base64FromBytes(new Uint8Array([9, 9])));
    expect(log).toEqual(['balance shielded ttl=1201000', 'sign recipe', 'finish signed']);
    expect([...PAGE_TOKEN_KINDS]).toEqual(['shielded']);
  });

  it('a signature or a finish that fails lets the booking go, and the failure is the one reported', async () => {
    for (const broken of [
      { signRecipe: async () => { throw new Error('no signature'); } },
      { finalizeRecipe: async () => { throw new Error('no proof'); } },
    ]) {
      const log: string[] = [];
      await expect(payForThePage(doorsWith(broken, log), tx)).rejects.toThrow(/no (signature|proof)/u);
      expect(log.at(-1)).toBe('revert recipe');
    }
    const log: string[] = [];
    await expect(payForThePage(doorsWith({
      finalizeRecipe: async () => { throw new Error('no proof'); },
      revert: async () => { log.push('revert failed'); throw new Error('cannot let go'); },
    }, log), tx)).rejects.toThrow('no proof');
    expect(log).toContain('revert failed');
  });

  it('a balance that fails books nothing, so nothing is let go', async () => {
    const log: string[] = [];
    await expect(payForThePage(doorsWith({
      balanceUnboundTransaction: async () => { throw new Error('not enough'); },
    }, log), tx)).rejects.toThrow('not enough');
    expect(log).toEqual([]);
  });
});
