import { describe, it, expect } from 'vitest';
import { ChainLedger } from './chain.js';
import { saysNothingWasSent } from '../core/jobs.js';
import type { Deployment } from './deployment.js';
import type { WriteCapability } from './write-capability.js';

/*
 * `ChainLedger.sendVault`: a transaction a device built for a vault, paid for
 * by the fee payer alone, through the one lane every write takes.
 */
const DEPLOYMENT = { network: 'stagenet', indexerUrl: 'x', indexerWsUrl: 'x' } as unknown as Deployment;

interface Tx { bound: boolean; hash: string; log: string[] }

const setUp = (payer: Partial<WriteCapability['sponsor']> = {}) => {
  const log: string[] = [];
  const sponsor = {
    addFeeAndFinalise: async (tx: Tx) => { log.push(`fee bound=${tx.bound}`); return { ...tx, transactionHash: () => tx.hash }; },
    submit: async () => { log.push('submit'); return { ref: 'ref-1', at: 'now' }; },
    release: async () => { log.push('release'); },
    payingFor: (id: string) => { log.push(`paying for ${id}`); },
    capacity: async () => ({ dust: 1n, night: 1n }),
    ...payer,
  } as unknown as WriteCapability['sponsor'];
  const ledger = new ChainLedger({} as never, DEPLOYMENT, {
    maintenanceAuthority: { kind: 'unmaintainable' } as never,
    compiled: {},
    customer: {
      coinPublicKey: () => '', encryptionPublicKey: () => '', release: async () => {},
      balanceOwnLegs: async () => { log.push('THE COMPANY SIDE WAS ASKED'); return null; },
    },
    sponsor,
    storagePassword: async () => 'x',
  });
  const unbound = (): Tx & { bind(): Tx } => ({ bound: false, hash: 'h1', log, bind: () => ({ bound: true, hash: 'h1', log }) });
  return { ledger, log, unbound };
};

describe('A VAULT TRANSACTION A DEVICE SENT', () => {
  it('moving nothing: read, checked, BOUND HERE, paid for by the fee payer alone, and sent - with its hash', async () => {
    const { ledger, log, unbound } = setUp();
    const sent = await ledger.sendVault('acc_1', 'deploying a vault', 'proven-moving-nothing', new Uint8Array([1]),
      () => null, async () => unbound());
    expect(sent).toEqual({ ref: 'ref-1', at: 'now', transactionHash: 'h1' });
    expect(log).toEqual(['paying for acc_1', 'fee bound=true', 'submit']);
  });

  it('finished by the depositor: already bound, so it is handed to the fee payer as it came', async () => {
    const { ledger, log } = setUp();
    await ledger.sendVault('acc_1', 'a deposit', 'finished-by-the-depositor', new Uint8Array([1]),
      () => null, async () => ({ bound: true, hash: 'h2', log }));
    expect(log).toEqual(['paying for acc_1', 'fee bound=true', 'submit']);
    expect(log).not.toContain('THE COMPANY SIDE WAS ASKED');
  });

  it('A REFUSAL, A TRANSACTION THAT CANNOT BE READ, OR A FEE THAT FAILS: NOTHING WAS SENT, AND IT SAYS SO', async () => {
    const refused = setUp();
    const e1 = await refused.ledger.sendVault('acc_1', 'x', 'proven-moving-nothing', new Uint8Array([1]),
      () => 'not this. Nothing was sent.', async () => refused.unbound()).catch((e) => e);
    expect(saysNothingWasSent(e1)).toBe(true);
    expect(e1.message).toBe('not this. Nothing was sent.');
    expect(refused.log).toEqual(['paying for acc_1']);

    const unreadable = setUp();
    const e2 = await unreadable.ledger.sendVault('acc_1', 'a deposit', 'finished-by-the-depositor', new Uint8Array([1]),
      () => null, async () => { throw new Error('garbage'); }).catch((e) => e);
    expect(saysNothingWasSent(e2)).toBe(true);
    expect(unreadable.log).not.toContain('submit');

    const noFee = setUp({ addFeeAndFinalise: async () => { throw new Error('over the ceiling'); } });
    const e3 = await noFee.ledger.sendVault('acc_1', 'x', 'proven-moving-nothing', new Uint8Array([1]),
      () => null, async () => noFee.unbound()).catch((e) => e);
    expect(saysNothingWasSent(e3)).toBe(true);
    expect(e3.message).toMatch(/over the ceiling/);
  });

  it('A SUBMISSION THAT FAILS MAY HAVE LANDED, AND IS NOT MARKED AS NOTHING SENT', async () => {
    const { ledger, unbound } = setUp({ submit: async () => { throw new Error('the node did not answer'); } });
    const e = await ledger.sendVault('acc_1', 'x', 'proven-moving-nothing', new Uint8Array([1]),
      () => null, async () => unbound()).catch((err) => err);
    expect(e.message).toBe('the node did not answer');
    expect(saysNothingWasSent(e)).toBe(false);
  });

  it('a transaction with no hash is still sent, and says it has none', async () => {
    const { ledger } = setUp({ addFeeAndFinalise: async (tx: unknown) => tx } as never);
    const sent = await ledger.sendVault('acc_1', 'x', 'finished-by-the-depositor', new Uint8Array([1]),
      () => null, async () => ({ transactionHash: () => { throw new Error('unproven'); } }));
    expect(sent.transactionHash).toBeNull();
  });

  it('a deployment that cannot write sends nothing, and says so', async () => {
    const ledger = new ChainLedger({} as never, DEPLOYMENT, undefined);
    let read = false;
    const e = await ledger.sendVault('acc_1', 'deploying a vault', 'proven-moving-nothing', new Uint8Array([1]),
      () => null, async () => { read = true; return null; }).catch((err) => err);
    expect(saysNothingWasSent(e)).toBe(true);
    expect(read).toBe(false);
  });
});

describe('THE SERVICE READS ONLY PROVEN TRANSACTIONS', () => {
  it('refuses an unproven deposit, which would carry its coin in the material its proof is made from', async () => {
    const { readFinishedTransaction, readProvenTransaction } = await import('./proven-submission.js');
    const L: any = await import('@midnightntwrk/ledger-v9');
    const unproven = L.Transaction.fromParts('undeployed', undefined, undefined,
      L.Intent.new(new Date(Date.now() + 60_000)));
    await expect(readProvenTransaction(unproven.serialize())).rejects.toThrow();
    await expect(readFinishedTransaction(unproven.bind().serialize())).rejects.toThrow();
  });
});
