import { describe, it, expect } from 'vitest';
import { ChainLedger, vaultTransactionReader } from './chain.js';
import { readFinishedTransaction, readProvenTransaction } from './proven-submission.js';
import { saysNothingWasSent, NothingWasSent } from '../core/jobs.js';
import { FeeNotPaid, NetworkRefused, WalletFeeSponsor, feeAnswerCodeOf } from '../midnight/sponsor.js';
import { FeeRefused } from '../midnight/fee-ceiling.js';
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

  it('moving only the vault\'s own coins: read, checked, BOUND HERE, and paid for by the fee payer alone', async () => {
    /* RED WHEN: only 'proven-moving-nothing' is bound here - a payment out then reaches the fee payer unbound. */
    const { ledger, log, unbound } = setUp();
    const sent = await ledger.sendVault('acc_1', 'a private payment out of a vault', 'proven-moving-the-vaults-own-coins',
      new Uint8Array([1]), () => null, async () => unbound());
    expect(sent).toEqual({ ref: 'ref-1', at: 'now', transactionHash: 'h1' });
    expect(log).toEqual(['paying for acc_1', 'fee bound=true', 'submit']);
    expect(log).not.toContain('THE COMPANY SIDE WAS ASKED');
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

  /*
   * RED WHEN: a fee the fee payer refused reaches the person without the code that says the fee was not paid.
   */
  it('a fee that was not paid says so with its code, whatever stopped it, and nothing is sent', async () => {
    const ceiling = setUp({ addFeeAndFinalise: async () => { throw new NothingWasSent('over the ceiling'); } });
    const e1 = await ceiling.ledger.sendVault('acc_1', 'x', 'proven-moving-nothing', new Uint8Array([1]),
      () => null, async () => ceiling.unbound()).catch((e) => e);
    expect(feeAnswerCodeOf(e1)).toBe('fee-not-paid');
    expect(e1.message).toBe('over the ceiling');
    expect(ceiling.log).not.toContain('submit');

    const behind = setUp({ addFeeAndFinalise: async () => { throw new FeeNotPaid('the view is behind'); } });
    const e2 = await behind.ledger.sendVault('acc_1', 'x', 'proven-moving-nothing', new Uint8Array([1]),
      () => null, async () => behind.unbound()).catch((e) => e);
    expect(feeAnswerCodeOf(e2)).toBe('fee-not-paid');
    expect(e2.message).toBe('the view is behind');
  });

  /*
   * RED WHEN: a transaction the node refused at its door is reported as one that may have landed.
   */
  it('a submission the node refused at its door is nothing sent, with its code', async () => {
    const { ledger, unbound } = setUp({ submit: async () => { throw new NetworkRefused('refused at the door'); } });
    const e = await ledger.sendVault('acc_1', 'x', 'proven-moving-nothing', new Uint8Array([1]),
      () => null, async () => unbound()).catch((err) => err);
    expect(saysNothingWasSent(e)).toBe(true);
    expect(feeAnswerCodeOf(e)).toBe('network-refused');
  });

  /*
   * RED WHEN: the page is handed the hash of a transaction that was refused, instead of the one the fee payer sent again.
   */
  it('when the fee payer sent the transaction again with a fresh proof, the hash returned is the one it sent', async () => {
    const { ledger, unbound } = setUp({ submit: async () => ({ ref: 'ref-2', at: 'later', transactionHash: 'h-again' }) });
    const sent = await ledger.sendVault('acc_1', 'x', 'proven-moving-nothing', new Uint8Array([1]),
      () => null, async () => unbound());
    expect(sent).toEqual({ ref: 'ref-2', at: 'later', transactionHash: 'h-again' });
  });

  /*
   * RED WHEN: a fee over the ceiling is given the code that tells the person to try again, though every try is refused.
   */
  it('a fee over the ceiling keeps its own words and carries no code', async () => {
    const dear = setUp({ addFeeAndFinalise: async () => { throw new FeeRefused('this transaction would spend more DUST than one may'); } });
    const e = await dear.ledger.sendVault('acc_1', 'x', 'proven-moving-nothing', new Uint8Array([1]),
      () => null, async () => dear.unbound()).catch((err) => err);
    expect(saysNothingWasSent(e)).toBe(true);
    expect(e).toBeInstanceOf(FeeRefused);
    expect(feeAnswerCodeOf(e)).toBeNull();
  });

  /*
   * RED WHEN: after the node refused the spend proof, a second balance that cannot be made reaches the route as a
   * submission that may have landed.
   */
  it('a refused spend proof whose fee cannot be balanced again is nothing sent, through the real fee payer', async () => {
    const refusal = Object.assign(new Error('Transaction submission error'), {
      cause: { code: 1010, message: '1010: Invalid Transaction: Custom error: 170', data: 'Custom error: 170' },
    });
    let balanced = 0;
    const payer = new WalletFeeSponsor({
      shieldedSecretKeys: 's', dustSecretKey: 'd',
      balanceFinalizedTransaction: async (tx: unknown) => { balanced += 1; if (balanced > 1) throw new Error('could not balance dust'); return { tx }; },
      finalizeRecipe: async () => ({ intents: new Map(), transactionHash: () => 'h1' }),
      submitTransaction: async () => { throw refusal; },
      revert: async () => {},
      estimateFee: async () => 1n,
      paidFee: async () => null,
      balances: async () => ({ dust: 1n, night: 1n }),
    }, { perTransaction: 1_000n });
    const { unbound } = setUp();
    const ledger = new ChainLedger({} as never, DEPLOYMENT, {
      maintenanceAuthority: { kind: 'unmaintainable' } as never, compiled: {},
      customer: { coinPublicKey: () => '', encryptionPublicKey: () => '', release: async () => {}, balanceOwnLegs: async () => null },
      sponsor: payer as never, storagePassword: async () => 'x',
    });
    const e = await ledger.sendVault('acc_1', 'x', 'proven-moving-nothing', new Uint8Array([1]),
      () => null, async () => unbound()).catch((err) => err);
    expect(balanced).toBe(2);
    expect(saysNothingWasSent(e)).toBe(true);
    expect(feeAnswerCodeOf(e)).toBe('fee-not-paid');
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
  it('reads what a depositor\'s wallet finished as finished, and everything else a device sends as proven', () => {
    /* RED WHEN: a payment out is read as finished - it arrives proven and unbound, and would not be read at all. */
    expect(vaultTransactionReader('finished-by-the-depositor')).toBe(readFinishedTransaction);
    expect(vaultTransactionReader('proven-moving-nothing')).toBe(readProvenTransaction);
    expect(vaultTransactionReader('proven-moving-the-vaults-own-coins')).toBe(readProvenTransaction);
  });

  it('refuses an unproven deposit, which would carry its coin in the material its proof is made from', async () => {
    const { readFinishedTransaction, readProvenTransaction } = await import('./proven-submission.js');
    const L: any = await import('@midnightntwrk/ledger-v9');
    const unproven = L.Transaction.fromParts('undeployed', undefined, undefined,
      L.Intent.new(new Date(Date.now() + 60_000)));
    await expect(readProvenTransaction(unproven.serialize())).rejects.toThrow();
    await expect(readFinishedTransaction(unproven.bind().serialize())).rejects.toThrow();
  });
});
