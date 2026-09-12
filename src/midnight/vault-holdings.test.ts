import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VaultLedger, type NotePool } from './vault-ledger.js';
import { chainVaultHoldings } from './vault-holdings.js';
import { pureCircuits as vaultCircuits } from '../../contracts/managed-vault/contract/index.js';
import { commitmentForNote } from './vault-recovery.js';
import { AccountService } from '../core/account.js';
import { SimulatedLedger, SimulatedCommitments, type Ledger } from '../core/ledger.js';
import { FileStore } from '../core/store-file.js';
import { assets as productAssets, ledgerTokenOf, type AssetRegistry } from '../core/assets.js';
import { registryWithTestPrivateForms, testPrivateToken } from '../testing/assets.js';
import { VaultCannotPayThisProposal } from '../core/vault-holdings.js';
import type { Hex } from '../core/crypto.js';
import type { Note } from './vault-notes.js';

/*
 * The vault's state decoder is replaced by the identity function, so a test can
 * hand the client the note set it would have decoded. The commitment circuits
 * are the compiled vault's own.
 */
vi.doMock('../../contracts/managed-vault/contract/index.js', () => ({
  ledger: (d: any) => d,
  pureCircuits: vaultCircuits,
}));

/**
 * **WHAT A VAULT HOLDS IS ASKED OF THE CHAIN THROUGH THE VAULT CLIENT'S OWN TWO
 * READS, AND A PROPOSAL IS REFUSED ON WHAT THE CHAIN SAYS.**
 *
 * The chain here is the provider bundle the vault client reads through, which a
 * test controls by supplying the indexer's answers. Nothing below reads a
 * number the product wrote down for itself.
 */

const VAULT: Hex = 'e3'.repeat(32);
const NIGHT = ledgerTokenOf('NIGHT', 'unshielded');
/* GBP's private token in the test registry, so a proposal in it can be raised against these notes. */
const COLOUR = testPrivateToken('GBP') as Hex;

/* Each records the transaction that created it, which is what a payment reads its place in the tree from. */
const note = (nonce: string, value: bigint): Note => ({
  nonce: nonce.repeat(32) as Hex, token: COLOUR, value, createdIn: 'd0'.repeat(32) as Hex,
});

function vaultClient(opts: {
  publicRows?: Array<[string, bigint]> | 'unreadable';
  pool?: Note[];
  chainNotes?: Note[] | 'unreadable';
}) {
  const asked = { publicBalances: 0, contractState: 0 };
  const pool: NotePool = {
    load: async () => ({ notes: opts.pool ?? [], readAt: { vault: 'unused', version: 1 } }),
    save: async () => { throw new Error('a read must not write the pool'); },
    create: async () => { throw new Error('a read must not create a pool'); },
  };
  const providers = async () => ({
    publicDataProvider: {
      queryUnshieldedBalances: async () => {
        asked.publicBalances++;
        if (opts.publicRows === 'unreadable') return null;
        return (opts.publicRows ?? []).map(([tokenType, balance]) => ({ tokenType, balance }));
      },
      queryContractState: async () => {
        asked.contractState++;
        if (opts.chainNotes === 'unreadable') return null;
        const held = (opts.chainNotes ?? []).map(n => commitmentForNote(vaultCircuits as never, VAULT, n));
        return {
          data: {
            notes: {
              member: (c: Uint8Array) => held.includes(Buffer.from(c).toString('hex')),
              size: () => BigInt(held.length),
            },
          },
        };
      },
    },
  });
  const ledger = new VaultLedger(
    { networkId: 'preview' } as never, {} as never, providers as never, {}, pool, '/nonexistent');
  return { ledger, asked };
}

describe('§1 each form is asked with its own read, and each refusal keeps its kind', () => {
  it('a public balance is the indexer\'s figure for the contract in that token', async () => {
    const { ledger, asked } = vaultClient({ publicRows: [[NIGHT, 12n], [COLOUR, 99n]] });
    /* RED WHEN the public form is routed to the note pool, or the token is ignored. */
    expect(await chainVaultHoldings(ledger).held(VAULT, 'unshielded', NIGHT)).toEqual({ of: 'held', amount: 12n });
    expect(asked).toEqual({ publicBalances: 1, contractState: 0 });
  });

  it('a private balance is the notes the chain\'s commitment set holds, and only then', async () => {
    const notes = [note('01', 60n), note('02', 40n)];
    const { ledger, asked } = vaultClient({ pool: notes, chainNotes: notes });
    /* RED WHEN the private form is routed to the public read. */
    expect(await chainVaultHoldings(ledger).held(VAULT, 'shielded', COLOUR)).toEqual({ of: 'held', amount: 100n });
    expect(asked).toEqual({ publicBalances: 0, contractState: 1 });
  });

  it('a pool the chain contradicts is CONTRADICTED, not summed and not unreadable', async () => {
    const { ledger } = vaultClient({ pool: [note('01', 60n), note('02', 40n)], chainNotes: [note('01', 60n)] });
    /* RED WHEN the private read sums the local pool without the chain's set, or reports it as a read that failed. */
    const answer = await chainVaultHoldings(ledger).held(VAULT, 'shielded', COLOUR);
    expect(answer.of).toBe('contradicted');
  });

  it('a chain that cannot be read is UNREADABLE in either form, never zero', async () => {
    const { ledger } = vaultClient({ publicRows: 'unreadable', pool: [note('01', 5n)], chainNotes: 'unreadable' });
    expect((await chainVaultHoldings(ledger).held(VAULT, 'unshielded', NIGHT)).of).toBe('unreadable');
    expect((await chainVaultHoldings(ledger).held(VAULT, 'shielded', COLOUR)).of).toBe('unreadable');
  });

  it('whether payments FIT is the note a payment would spend, not the total', async () => {
    const twoSixties = [note('01', 60n), note('02', 60n)];
    const pay = (...amounts: bigint[]) => amounts.map(amount => ({ payee: { kind: 'shielded' as const }, token: COLOUR, amount }));
    const { ledger } = vaultClient({ pool: twoSixties, chainNotes: twoSixties });
    const holdings = chainVaultHoldings(ledger);
    /* RED WHEN a total of 120 is taken to cover one payment of 100. */
    const one = await holdings.fits(VAULT, pay(100n));
    expect(one.of).toBe('does-not-fit');
    expect((one as { why: string }).why).toMatch(/no single note covers 100/);
    expect(await holdings.fits(VAULT, pay(60n, 60n))).toEqual({ of: 'fits' });
    const contradicted = vaultClient({ pool: twoSixties, chainNotes: [twoSixties[0]!] });
    expect((await chainVaultHoldings(contradicted.ledger).fits(VAULT, pay(10n))).of).toBe('contradicted');
    const dark = vaultClient({ pool: twoSixties, chainNotes: 'unreadable' });
    expect((await chainVaultHoldings(dark.ledger).fits(VAULT, pay(10n))).of).toBe('unreadable');
  });
});

describe('§2 a proposal raised against the chain\'s answer, through the vault client\'s own reads', () => {
  const harness = (opts: Parameters<typeof vaultClient>[0], registry: AssetRegistry) => {
    const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-s114-chain-')), 'db.json'));
    const inner = new SimulatedLedger(SimulatedCommitments);
    const raised = { count: 0 };
    const ledger = new Proxy(inner, {
      get(target, prop) {
        const value = (target as any)[prop];
        if (prop === 'proposeRun') return async (...a: unknown[]) => { raised.count++; return value.apply(target, a); };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Ledger;
    const client = vaultClient(opts);
    const accounts = new AccountService(store, ledger, SimulatedCommitments, registry, chainVaultHoldings(client.ledger));
    return { accounts, raised, asked: client.asked };
  };

  const raise = async (
    h: ReturnType<typeof harness>, asset: string, kind: 'shielded' | 'unshielded', token: string, amounts: bigint[],
  ) => {
    const created = await h.accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
    return h.accounts.proposeRun({
      accountId: created.account.id, viewingKey: created.viewingKey, summary: 'paying from the vault',
      payload: { entries: amounts.map((amount, i) => ({
        id: `e${i}`, kind: 'transfer', asset, amount, counterparty: `payee ${i}`, memo: '', at: '',
      })) },
      asset,
      run: { root: 'd1'.repeat(32), payees: BigInt(amounts.length), opensAt: 1_900_000_000n, closesAt: 1_900_086_400n, vault: VAULT },
      payments: amounts.map(amount => ({ payee: { kind }, token, amount })),
      proposedBy: created.secrets[0]!.signerId,
    });
  };

  it('REFUSES NIGHT paid publicly, from the product registry, when the chain says the vault holds less', async () => {
    const h = harness({ publicRows: [[NIGHT, 9_999_999n]] }, productAssets);
    const failed = await raise(h, 'NIGHT', 'unshielded', NIGHT, [10_000_000n])
      .then(() => null, (e: unknown) => e as VaultCannotPayThisProposal);
    expect(failed).toBeInstanceOf(VaultCannotPayThisProposal);
    expect(failed!.message).toMatch(/holds 9\.999999 NIGHT publicly and this proposal asks it to pay 10\.000000/);
    expect(h.raised.count).toBe(0);
  });

  it('RAISES NIGHT paid publicly when the chain says the vault holds it', async () => {
    const h = harness({ publicRows: [[NIGHT, 10_000_000n]] }, productAssets);
    await raise(h, 'NIGHT', 'unshielded', NIGHT, [10_000_000n]);
    expect(h.raised.count).toBe(1);
  });

  it('REFUSES when the chain has published nothing for the vault, and says to try again', async () => {
    const h = harness({ publicRows: 'unreadable' }, productAssets);
    await expect(raise(h, 'NIGHT', 'unshielded', NIGHT, [1n])).rejects.toThrow(/what the vault holds of NIGHT publicly could not be read from the chain.*If the chain was slow to answer, try again/s);
    expect(h.raised.count).toBe(0);
  });

  it('REFUSES a private proposal whose total the chain confirms but no single note can pay', async () => {
    const twoSixties = [note('01', 60n), note('02', 60n)];
    const h = harness({ pool: twoSixties, chainNotes: twoSixties }, registryWithTestPrivateForms());
    /* RED WHEN the private question is answered by `balance` alone. */
    await expect(raise(h, 'GBP', 'shielded', COLOUR, [100n]))
      .rejects.toThrow(/holds enough GBP in total, but its notes cannot make each payment in turn \(payment 1 of 1 cannot be made out of this vault: no single note covers 100: the largest is 60 and the pool holds 120 across 2 notes\)\. A private/);
    /* RED WHEN the reason passes on advice to merge notes, which no vault can do. */
    await expect(raise(harness({ pool: twoSixties, chainNotes: twoSixties }, registryWithTestPrivateForms()), 'GBP', 'shielded', COLOUR, [100n]))
      .rejects.not.toThrow(/Merge/);
    expect(h.raised.count).toBe(0);
    const h2 = harness({ pool: twoSixties, chainNotes: twoSixties }, registryWithTestPrivateForms());
    await raise(h2, 'GBP', 'shielded', COLOUR, [60n, 60n]);
    expect(h2.raised.count).toBe(1);
  });

  it('REFUSES a private proposal against a pool the chain contradicts, and does not say to try again', async () => {
    const h = harness({ pool: [note('01', 60n), note('02', 60n)], chainNotes: [note('01', 60n)] }, registryWithTestPrivateForms());
    const failed = await raise(h, 'GBP', 'shielded', COLOUR, [10n]).then(() => null, (e: unknown) => e as VaultCannotPayThisProposal);
    expect(failed!.why).toBe('contradicted');
    expect(failed!.message).not.toMatch(/try again/i);
    expect(h.raised.count).toBe(0);
  });
});
