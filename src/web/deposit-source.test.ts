/**
 * **A DEPOSIT IS A SOURCE ENDING IN THE VAULT'S ONE PRIVATE DEPOSIT STEP.** The
 * page's source, a private token paid in by the signer's own wallet, goes
 * through that step; a second source, which exists only in this file, plugs
 * into the same step without either the page's source or the step changing.
 * The service and the vault worker are stood in; the step is the page's own.
 */
import { describe, it, expect } from 'vitest';
import { StaticAssetRegistry, type Asset } from '../core/assets.js';
import type { WireRecord } from '../midnight/sealed-record-wire.js';
import { MemorySealedPoolStore } from '../midnight/vault-pool.js';
import { newWrappingKeypair, type Hex } from '../core/crypto.js';
import {
  openCompanyVaultPool, type DepositInFlight, type DepositsInFlight, type VaultChainView, type VaultService,
} from './vault-operation.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import {
  depositFromSource, privateTokenFromTheWallet, type DepositAsk, type DepositSource, type PaidIn,
} from './deposit-source.js';

const VAULT = 'ab'.repeat(32) as Hex;
const ACCOUNT = 'c0'.repeat(32) as Hex;
const PRIVATE_TOKEN = '5e'.repeat(32);
const OTHER_TOKEN = '7a'.repeat(32);
const PARAMS = btoa('midnight:ledger-parameters[v8]:stand-in');

const asset = (code: string, shielded: string | null): Asset => ({
  code, name: code, kind: 'token', decimals: 0, chain: 'midnight',
  ledger: { shielded, unshielded: shielded === null ? 'cd'.repeat(32) : null } as Asset['ledger'], enabled: true, sortOrder: 1,
});
const PRIVATE = asset('PRV', PRIVATE_TOKEN);
const PUBLIC_ONLY = asset('PUB', null);
const REGISTRY = new StaticAssetRegistry([PRIVATE, PUBLIC_ONLY]);

/** A chain moved by hand, a stand-in worker, and the page's doors, with every call to them written down. */
const setUp = async () => {
  const log: string[] = [];
  const notes: string[] = [];
  const held = (c: { nonce: string; token: string; value: string }) => `held:${c.nonce}:${c.token}:${c.value}`;
  const view = (): VaultChainView => ({
    vault: VAULT, onChain: true, committee: null, heldByCommittee: true, fundable: true, state: 'AAAA', notes: [...notes], everCreated: [],
  });
  let lastBuilt: { nonce: string; token: string; value: string } | null = null;
  const service: VaultService = {
    keys: async () => ({ committee: null, why: null, readers: [] }),
    deploy: async () => { throw new Error('no deploy'); },
    handover: async () => { throw new Error('no handover'); },
    chain: async () => view(),
    payoutState: async (v) => ({ vault: v, account: ACCOUNT, blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: PARAMS, accountState: 'A' }),
    deposit: async (_v, tx) => { log.push(`sent ${tx}`); notes.push(held(lastBuilt!)); return { txRef: 'r1', transactionHash: null }; },
    events: async () => { throw new Error('no events'); },
    payout: async () => { throw new Error('no payout'); },
    payoutPublicly: async () => { throw new Error('no payout'); },
  };
  const refuse = async () => { throw new Error('a deposit never asks this'); };
  const builder: VaultBuilderClient = {
    deploy: refuse, handover: refuse, chooseNote: refuse, paymentsFit: refuse, afterPayment: refuse,
    confirmPayment: refuse, creatingTransaction: refuse, payout: refuse, payoutPublicly: refuse, governedCall: refuse,
    commitments: async (i) => ({ output: `out:${i.coin.nonce}`, held: held(i.coin) }),
    deposit: async (i) => { lastBuilt = i.coin; log.push(`built ${i.coin.token.slice(0, 2)} ${i.coin.value}`); return { tx: 'PROVEN' }; },
  } as VaultBuilderClient;
  const kept = new Map<WireRecord, MemorySealedPoolStore>();
  const records = (r: WireRecord) => kept.get(r) ?? kept.set(r, new MemorySealedPoolStore()).get(r)!;
  const wrapping = newWrappingKeypair();
  const inFlight = new Map<string, DepositInFlight>();
  const doors = {
    sleep: async () => {}, waitMs: 3, everyMs: 1, service, records,
    me: { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(9) },
    myRecordsKey: 'ff'.repeat(32) as Hex,
    signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }],
    company: ACCOUNT, builder,
    inFlight: {
      get: async (v) => inFlight.get(v) ?? null, put: async (v, d) => { inFlight.set(v, d); }, forget: async (v) => { inFlight.delete(v); },
    } as DepositsInFlight,
  };
  await openCompanyVaultPool(doors, VAULT);
  return { log, doors, records };
};

describe('A DEPOSIT FROM A SOURCE', () => {
  it('THE PAGE\'S SOURCE: THE VAULT RECEIVES THE ASSET\'S PRIVATE TOKEN, AND THE WALLET IS HANDED THE PROVEN DEPOSIT AND NOTHING ELSE', async () => {
    const { log, doors } = await setUp();
    const asked: unknown[] = [];
    const source = privateTokenFromTheWallet(async (ask) => { asked.push(ask); log.push('wallet'); return { transaction: `${ask.transaction}+coins`, leaves: [] }; }, REGISTRY);
    const done = await depositFromSource(doors, VAULT, source, { code: 'PRV', value: 40n });
    /* RED WHEN: the vault is given another token than the asset's private one, or another amount. */
    expect(done.note.token).toBe(PRIVATE_TOKEN);
    expect(done.note.value).toBe(40n);
    /* RED WHEN: the wallet is not asked between the build and the send, or the service sends anything but what it answered. */
    expect(log).toEqual([`built ${PRIVATE_TOKEN.slice(0, 2)} 40`, 'wallet', 'sent PROVEN+coins']);
    /* RED WHEN: the source hands the wallet anything beyond the company, the vault and the proven deposit. */
    expect(asked).toEqual([{ company: ACCOUNT, vault: VAULT, transaction: 'PROVEN' }]);
  });

  it('THE PAGE\'S SOURCE PASSES ON ONLY WHAT AN ASK IS, WHATEVER ELSE IT IS HANDED', async () => {
    const asked: unknown[] = [];
    const source = privateTokenFromTheWallet(async (ask) => { asked.push(ask); return { transaction: 'T', leaves: [] }; }, REGISTRY);
    await source.payIn({ company: ACCOUNT, vault: VAULT, transaction: 'PROVEN', nonce: '11'.repeat(32) } as DepositAsk);
    /* RED WHEN: payIn hands the wallet the object it was given, so anything added to an ask reaches the wallet. */
    expect(asked).toEqual([{ company: ACCOUNT, vault: VAULT, transaction: 'PROVEN' }]);
  });

  it('AN ASSET THE SOURCE CANNOT BRING, OR AN AMOUNT OF NOTHING, IS REFUSED BEFORE ANYTHING IS CHOSEN, FILED, BUILT OR ASKED', async () => {
    for (const [why, brought] of [
      ['an asset with no private form', { code: 'PUB', value: 40n }],
      ['an amount of nothing', { code: 'PRV', value: 0n }],
    ] as const) {
      const { log, doors, records } = await setUp();
      const source = privateTokenFromTheWallet(async () => { log.push('wallet'); return { transaction: 'T', leaves: [] }; }, REGISTRY);
      /* RED WHEN: the source's refusal or the amount is asked after the vault's step has chosen and filed a coin. */
      const e = await depositFromSource(doors, VAULT, source, brought).catch((x: Error) => x);
      /* RED WHEN: the source's own check is gone, and the asset registry's refusal, worded for a payment, reaches the screen. */
      expect((e as Error).message, why).toMatch(brought.value === 0n ? /^an amount of nothing is not a deposit/ : /cannot go into a vault from your wallet's private balance/);
      expect((e as Error).message, why).not.toMatch(/pa(id|y)(ment| out)/i);
      expect(log, why).toEqual([]);
      expect(await records('deposit-journal').get(VAULT), why).toBeNull();
    }
  });

  it('A SECOND SOURCE PLUGS INTO THE SAME STEP, AND NEITHER THE PAGE\'S SOURCE NOR THE STEP CHANGES FOR IT', async () => {
    /*
     * A source that exists only here: the company brings one asset and the vault receives another token, and what
     * pays it in is not the page's wallet. Nothing in the page's source or the vault's step knows it exists.
     */
    const asked: DepositAsk[] = [];
    const elsewhere: DepositSource = {
      endsIn: 'private-deposit',
      money: ({ value }) => ({ token: OTHER_TOKEN as Hex, value: value * 2n }),
      payIn: async (ask): Promise<PaidIn> => { asked.push(ask); return { transaction: `${ask.transaction}+from-elsewhere`, leaves: [] }; },
    };
    const { log, doors } = await setUp();
    const done = await depositFromSource(doors, VAULT, elsewhere, { code: 'PRV', value: 21n });
    /* RED WHEN: the step takes its token or amount from anywhere but the source's `money`, or sends anything but what its `payIn` answered. */
    expect({ token: done.note.token, value: done.note.value }).toEqual({ token: OTHER_TOKEN, value: 42n });
    expect(log).toEqual([`built ${OTHER_TOKEN.slice(0, 2)} 42`, 'sent PROVEN+from-elsewhere']);
    expect(asked).toEqual([{ company: ACCOUNT, vault: VAULT, transaction: 'PROVEN' }]);
    /* And the page's source, beside it, is as it was. */
    const again = await setUp();
    const page = privateTokenFromTheWallet(async (ask) => ({ transaction: `${ask.transaction}+coins`, leaves: [] }), REGISTRY);
    const mine = await depositFromSource(again.doors, VAULT, page, { code: 'PRV', value: 21n });
    expect({ token: mine.note.token, value: mine.note.value }).toEqual({ token: PRIVATE_TOKEN, value: 21n });
  });

  it('A SOURCE THAT ENDS IN A STEP THIS PAGE DOES NOT HAVE IS REFUSED BEFORE ITS MONEY IS ASKED', async () => {
    const { log, doors, records } = await setUp();
    let asked = false;
    const unknown = {
      endsIn: 'somewhere-else',
      money: () => { asked = true; return { token: OTHER_TOKEN as Hex, value: 1n }; },
      payIn: async () => { log.push('paid'); return { transaction: 'T', leaves: [] }; },
    } as unknown as DepositSource;
    /* RED WHEN: a source is sent down the private step whatever step it says it ends in. */
    await expect(depositFromSource(doors, VAULT, unknown, { code: 'PRV', value: 1n })).rejects.toThrow(/cannot make this kind of deposit/);
    expect(asked).toBe(false);
    expect(log).toEqual([]);
    expect(await records('deposit-journal').get(VAULT)).toBeNull();
  });
});
