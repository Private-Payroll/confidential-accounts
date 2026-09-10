/**
 * **WRITES OVER ONE FEE PAYER RUN ONE AT A TIME.**
 *
 * The fee payer keeps whose transaction it is paying for, and what it expected
 * to pay, on itself. Two writes at once would share both, and the fee record
 * for the first would name the second company: wrong rather than absent, and
 * not recoverable from a shielded transaction afterwards.
 */
import { describe, it, expect } from 'vitest';
import { ChainLedger } from './chain.js';
import { WalletFeeSponsor, type SponsorWallet } from '../midnight/sponsor.js';
import type { SponsoredFee } from '../midnight/sponsored-fees.js';
import type { Deployment } from './deployment.js';
import type { WriteCapability } from './write-capability.js';

const DEPLOYMENT: Deployment = {
  network: 'stagenet',
  contractAddress: 'bcb61fef',
  indexerUrl: 'https://indexer.example/api/v4/graphql',
  indexerWsUrl: 'wss://indexer.example/api/v4/graphql/ws',
  nodeUrl: 'https://rpc.example',
  proverUrl: 'http://prover.invalid:1',
  sealedStateRoot: '/nowhere/.midnight/sealed',
  privateStateId: 'confidential-accounts-stagenet',
  zkConfigPath: '/nowhere/contracts/managed',
};

const capabilityWith = (sponsor: WriteCapability['sponsor']): WriteCapability => ({
  maintenanceAuthority: { kind: 'unmaintainable' } as never,
  compiled: { it: 'is here' },
  customer: {
    coinPublicKey: () => 'not-a-secret: a test literal',
    encryptionPublicKey: () => 'not-a-secret: a test literal',
    balanceOwnLegs: async (tx: unknown) => tx,
    release: async () => {},
  } as WriteCapability['customer'],
  sponsor,
  storagePassword: async () => 'not-a-secret: a test literal',
});

/** A promise and the function that settles it, so a test decides when a write finishes. */
const gate = () => {
  let open!: () => void;
  let fail!: (e: Error) => void;
  const p = new Promise<void>((res, rej) => { open = res; fail = rej; });
  return { p, open, fail };
};
const tick = () => new Promise(r => setTimeout(r, 5));

const namingSponsor = (named: string[]) => ({
  addFeeAndFinalise: async (tx: unknown) => tx,
  submit: async () => ({ ref: 'tx', at: '' }),
  release: async () => {},
  payingFor: (id: string) => { named.push(id); },
  capacity: async () => ({ dust: 0n, night: 0n }),
}) as unknown as WriteCapability['sponsor'];

describe('writes over one fee payer wait their turn', () => {
  /*
   * RED WHEN: `write` calls `go()` directly instead of waiting behind the lane
   * - the second company is named, and its ledger call starts, while the first
   * write is still running.
   */
  it('the second write is not named or started until the first has settled', async () => {
    const named: string[] = [];
    const reached: string[] = [];
    const first = gate();
    const inner: any = {
      open: async (id: string) => { reached.push(id); if (id === 'a') await first.p; return { ref: id }; },
    };
    const ledger = new ChainLedger(inner, DEPLOYMENT, capabilityWith(namingSponsor(named)));

    const a = ledger.open('a', {} as never);
    const b = ledger.open('b', {} as never);
    await tick();
    expect(reached, 'the second write reached the ledger while the first was running').toEqual(['a']);
    expect(named, 'the second company was named while the first was being paid for').toEqual(['a']);

    first.open();
    await expect(a).resolves.toEqual({ ref: 'a' });
    await expect(b).resolves.toEqual({ ref: 'b' });
    expect(reached).toEqual(['a', 'b']);
    expect(named).toEqual(['a', 'b']);
  });

  /*
   * RED WHEN: the lane is kept on the ledger object rather than keyed on the
   * fee payer - two ledgers over one wallet then run at once.
   */
  it('two ledgers over the same fee payer queue behind each other', async () => {
    const named: string[] = [];
    const reached: string[] = [];
    const first = gate();
    const inner: any = {
      open: async (id: string) => { reached.push(id); if (id === 'a') await first.p; return { ref: id }; },
    };
    const capability = capabilityWith(namingSponsor(named));
    const one = new ChainLedger(inner, DEPLOYMENT, capability);
    const two = new ChainLedger(inner, DEPLOYMENT, capability);

    const a = one.open('a', {} as never);
    const b = two.open('b', {} as never);
    await tick();
    expect(reached, 'a second ledger over the same wallet did not wait').toEqual(['a']);
    first.open();
    await Promise.all([a, b]);
    expect(reached).toEqual(['a', 'b']);
  });

  /*
   * RED WHEN: the lane stores the write's own promise, so a failed write
   * rejects every write queued behind it with somebody else's error.
   */
  it('a write that fails lets the next one go, and keeps its own error', async () => {
    const named: string[] = [];
    const first = gate();
    const inner: any = {
      open: async (id: string) => { if (id === 'a') await first.p; return { ref: id }; },
    };
    const ledger = new ChainLedger(inner, DEPLOYMENT, capabilityWith(namingSponsor(named)));

    const a = ledger.open('a', {} as never);
    const b = ledger.open('b', {} as never);
    first.fail(new Error('the proof server went away'));
    await expect(a).rejects.toThrow('the proof server went away');
    await expect(b).resolves.toEqual({ ref: 'b' });
    expect(named).toEqual(['a', 'b']);
  });

  /*
   * **THE PROPERTY THE QUEUE IS FOR, WITH THE REAL FEE PAYER.** Two companies
   * created at once, each write balancing, pausing, and submitting; the record
   * of what was paid must name the company each payment was for.
   *
   * RED WHEN: the queue is removed. The second write names its company while
   * the first is between balancing and submitting, and the first payment is
   * recorded against the second company.
   */
  it('two companies created at once are each recorded against their own payment', async () => {
    const records: SponsoredFee[] = [];
    let n = 0;
    const wallet: SponsorWallet = {
      shieldedSecretKeys: 'k', dustSecretKey: 'd',
      estimateFee: async () => 100n,
      balanceFinalizedTransaction: async (tx: unknown) => ({ recipe: tx }),
      finalizeRecipe: async (r: any) => r.recipe,
      submitTransaction: async (tx: unknown) => `ref-${String(tx)}`,
      revert: async () => {},
      paidFee: async (ref: string) => (ref === 'ref-a' ? 90n : 80n),
      balances: async () => ({ dust: 0n, night: 0n }),
    } as unknown as SponsorWallet;
    const sponsor = new WalletFeeSponsor(wallet, undefined, { record: (e) => { records.push(e); } });

    const inner: any = {
      open: async (id: string) => {
        const finalised = await sponsor.addFeeAndFinalise(id, new Date(Date.now() + 60_000));
        n++;
        await tick();
        await tick();
        return sponsor.submit(finalised);
      },
    };
    const ledger = new ChainLedger(inner, DEPLOYMENT, capabilityWith(sponsor as never));
    await Promise.all([ledger.open('a', {} as never), ledger.open('b', {} as never)]);

    expect(n).toBe(2);
    const byRef = Object.fromEntries(records.map(r => [r.ref, r]));
    expect(byRef['ref-a']?.company, 'the first payment was filed against another company').toBe('a');
    expect(byRef['ref-b']?.company).toBe('b');
    expect(String(byRef['ref-a']?.actual)).toBe('90');
  });
});
