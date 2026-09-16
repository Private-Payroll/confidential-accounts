/**
 * **A TRANSACTION A SIGNER'S DEVICE PROVED IS PAID FOR ONLY IF IT CALLS THE
 * COMPANY'S OWN CONTRACT, AND EVERY FAILURE BEFORE THE SUBMISSION SAYS NOTHING
 * WAS SENT.**
 *
 * The first half is the pure rule. The second drives `ChainLedger` with a
 * ledger double that answers the company's address, and with a company side and
 * a fee payer that record what they were asked for.
 */
import { describe, it, expect } from 'vitest';
import { refusalForProven } from './proven-submission.js';
import { ChainLedger } from './chain.js';
import type { Deployment } from './deployment.js';
import type { WriteCapability } from './write-capability.js';
import { saysNothingWasSent } from '../core/jobs.js';

const OURS = 'aa'.repeat(32);
const THEIRS = 'bb'.repeat(32);
const call = (address: string) => ({ address, entryPoint: 'approve' });
const tx = (...intents: unknown[][]) => ({ intents: new Map(intents.map((actions, i) => [i + 1, { actions }])) });

describe('what a proven transaction may do before it is paid for', () => {
  /* RED WHEN: the rule refuses a transaction that only calls the company's own contract. */
  it('calls to the company\'s own contract are paid for, however the address is spelled', () => {
    expect(refusalForProven(tx([call(OURS)]), OURS)).toBeNull();
    expect(refusalForProven(tx([call(OURS.toUpperCase())], [call(OURS)]), `0x${OURS}`)).toBeNull();
  });

  /* RED WHEN: the address comparison is removed, so we pay for calls into anybody's contract. */
  it('a call to another contract is refused, even beside one to ours', () => {
    expect(String(refusalForProven(tx([call(OURS), call(THEIRS)]), OURS))).toMatch(/not this company's/);
    expect(String(refusalForProven(tx([call(OURS)], [call(THEIRS)]), OURS))).toMatch(/not this company's/);
  });

  /* RED WHEN: an action that is not a call - a deploy, a maintenance update - is let through. */
  it('anything that is not a call is refused', () => {
    expect(String(refusalForProven(tx([call(OURS), { address: OURS }]), OURS))).toMatch(/something other than call/);
    expect(String(refusalForProven(tx([{ initialState: {} }]), OURS))).toMatch(/something other than call/);
    expect(() => refusalForProven(tx([call(OURS), null]), OURS)).not.toThrow();
    expect(String(refusalForProven(tx([call(OURS), null]), OURS))).toMatch(/something other than call/);
  });

  /*
   * **THE COMPANY'S WALLET BALANCES WHATEVER IT IS HANDED**, so a transaction
   * that moves coins of its own has the company pay for them on one member's
   * word. RED WHEN: any one of the five places a transaction can move coins is
   * not read - one mutation per place.
   */
  it('a transaction that moves any coins is refused, wherever it moves them', () => {
    const paying = { outputs: [{ to: 'somebody', value: 1n }], inputs: [], transients: [] };
    const empty = { outputs: [], inputs: [], transients: [] };
    const call1 = (extra: Record<string, unknown>) =>
      ({ intents: new Map([[1, { actions: [call(OURS)], ...extra }]]) });
    const cases: Array<[string, unknown]> = [
      ['a shielded guaranteed offer', { ...tx([call(OURS)]), guaranteedOffer: paying }],
      ['a shielded fallible offer', { ...tx([call(OURS)]), fallibleOffer: new Map([[1, paying]]) }],
      ['an unshielded guaranteed offer', call1({ guaranteedUnshieldedOffer: { inputs: [], outputs: [{ value: 1n }] } })],
      ['an unshielded fallible offer', call1({ fallibleUnshieldedOffer: { inputs: [{ value: 1n }], outputs: [] } })],
      ['DUST spent by the device', call1({ dustActions: { spends: [{ vFee: 1n }], registrations: [] } })],
      ['a DUST registration', call1({ dustActions: { spends: [], registrations: [{}] } })],
      ['an offer that cannot be read', { ...tx([call(OURS)]), guaranteedOffer: 'x' }],
      ['an offer whose parts cannot be read', { ...tx([call(OURS)]), guaranteedOffer: { inputs: [], outputs: 'x', transients: [] } }],
      ['fallible offers that are not a map', { ...tx([call(OURS)]), fallibleOffer: [paying] }],
      ['a transient', { ...tx([call(OURS)]), guaranteedOffer: { ...empty, transients: [{}] } }],
    ];
    for (const [what, t] of cases) {
      expect(String(refusalForProven(t, OURS)), what).toMatch(/moves coins/);
    }
    /* The positive control: offers that are present and move nothing are not a reason to refuse. */
    expect(refusalForProven({
      ...call1({ guaranteedUnshieldedOffer: { inputs: [], outputs: [] }, dustActions: { spends: [], registrations: [] } }),
      guaranteedOffer: empty, fallibleOffer: new Map([[1, empty]]),
    }, OURS)).toBeNull();
  });

  /*
   * AGAINST THE LEDGER'S OWN OBJECTS, SO THE FIELD NAMES ARE THE LEDGER'S AND
   * NOT A GUESS. RED WHEN: the unshielded offer is read under any other name.
   */
  it('reads the coins a transaction the ledger built would move', async () => {
    const l: any = await import('@midnightntwrk/ledger-v9');
    const quiet = l.Intent.new(new Date(Date.now() + 60_000));
    const plain = l.Transaction.fromParts('undeployed', undefined, undefined, quiet);
    expect(String(refusalForProven(plain, OURS))).toMatch(/calls nothing/);
    const paying = l.Intent.new(new Date(Date.now() + 60_000));
    paying.guaranteedUnshieldedOffer = l.UnshieldedOffer.new(
      [], [{ value: 5n, owner: '00'.repeat(32), type: '00'.repeat(32) }], []);
    const moving = l.Transaction.fromParts('undeployed', undefined, undefined, paying);
    expect(String(refusalForProven(moving, OURS))).toMatch(/moves coins/);
  });

  /* RED WHEN: a transaction with nothing to read, or nothing in it, is paid for. */
  it('a transaction that calls nothing, or cannot be read, is refused', () => {
    expect(String(refusalForProven({}, OURS))).toMatch(/calls nothing/);
    expect(String(refusalForProven({ intents: new Map() }, OURS))).toMatch(/calls nothing/);
    expect(String(refusalForProven(tx([]), OURS))).toMatch(/calls nothing/);
    expect(String(refusalForProven({ intents: new Map([[1, {}]]) }, OURS))).toMatch(/could not be read/);
    expect(String(refusalForProven(null, OURS))).toMatch(/calls nothing/);
  });
});

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
  vaultZkConfigPath: '/nowhere/contracts/managed-vault',
};

type Step = string;

const rig = (over: {
  address?: string | null;
  submit?: () => Promise<{ ref: string; at: string }>;
  addFee?: () => Promise<unknown>;
} = {}) => {
  const steps: Step[] = [];
  const capability: WriteCapability = {
    maintenanceAuthority: { kind: 'unmaintainable' },
    compiled: { it: 'is here' },
    customer: {
      coinPublicKey: () => 'not-a-secret: a test literal',
      encryptionPublicKey: () => 'not-a-secret: a test literal',
      balanceOwnLegs: async (t: unknown) => { steps.push('company balances'); return { companyBalanced: t }; },
      release: async () => { steps.push('company releases'); },
    } as WriteCapability['customer'],
    sponsor: {
      addFeeAndFinalise: over.addFee ?? (async (t: unknown) => { steps.push('fee added'); return { paid: t }; }),
      submit: over.submit ?? (async () => { steps.push('submitted'); return { ref: 'ref-from-the-fee-payer', at: '' }; }),
      release: async () => { steps.push('fee payer releases'); },
      payingFor: (id: string) => { steps.push(`paying for ${id}`); },
      capacity: async () => ({ dust: 0n, night: 0n }),
    } as WriteCapability['sponsor'],
    storagePassword: async () => 'not-a-secret: a test literal',
  };
  const inner: any = {
    address: async () => (over.address === null ? null : { value: over.address ?? OURS, source: 'chain' }),
  };
  return { steps, capability, ledger: new ChainLedger(inner, DEPLOYMENT, capability) };
};

const BYTES = new Uint8Array([1, 2, 3]);
const reads = (t: unknown) => async () => t;

describe('sending a transaction a device proved', () => {
  /*
   * RED WHEN: either party is skipped, the order changes, or the company is
   * not named to the fee payer first.
   */
  it('names the company, balances its side, adds the fee, and submits', async () => {
    const r = rig();
    const ref = await r.ledger.submitProven('acc_1', BYTES, reads(tx([call(OURS)])));
    expect(ref.ref).toBe('ref-from-the-fee-payer');
    expect(r.steps).toEqual(['paying for acc_1', 'company balances', 'fee added', 'submitted']);
  });

  /* RED WHEN: the contract check is removed or moved after the balance. */
  it('refuses a call to another contract before anything is booked', async () => {
    const r = rig();
    const refused: any = await r.ledger.submitProven('acc_1', BYTES, reads(tx([call(THEIRS)]))).catch((e) => e);
    expect(refused, 'a call to another contract was sent').toBeInstanceOf(Error);
    expect(refused.message).toMatch(/not this company's/);
    expect(saysNothingWasSent(refused)).toBe(true);
    expect(r.steps).toEqual(['paying for acc_1']);
  });

  /* RED WHEN: a company with no recorded contract is sent anything. */
  it('refuses when the company has no contract to send to', async () => {
    const r = rig({ address: null });
    const refused: any = await r.ledger.submitProven('acc_1', BYTES, reads(tx([call(OURS)]))).catch((e) => e);
    expect(refused.message).toMatch(/no contract on this chain/);
    expect(saysNothingWasSent(refused)).toBe(true);
  });

  /*
   * RED WHEN: a failure while the fee is added is reported as an unknown
   * outcome, or the company's booking is not released.
   */
  it('a fee refusal is nothing sent, and the company\'s booking is let go', async () => {
    const r = rig({ addFee: async () => { throw new Error('this transaction would spend 9 SPECKs'); } });
    const refused: any = await r.ledger.submitProven('acc_1', BYTES, reads(tx([call(OURS)]))).catch((e) => e);
    expect(refused.message).toMatch(/would spend 9 SPECKs/);
    expect(saysNothingWasSent(refused), 'a failure before the submission was called unknown').toBe(true);
    expect(r.steps).toContain('company releases');
    expect(r.steps).not.toContain('submitted');
  });

  /* RED WHEN: a submission that threw is reported as nothing sent. It may have landed. */
  it('a submission that throws is an unknown outcome', async () => {
    const r = rig({ submit: async () => { throw new Error('the node closed the socket'); } });
    const failed: any = await r.ledger.submitProven('acc_1', BYTES, reads(tx([call(OURS)]))).catch((e) => e);
    expect(failed.message).toMatch(/closed the socket/);
    expect(saysNothingWasSent(failed)).toBe(false);
  });

  /* RED WHEN: a deployment that cannot write reaches the ledger, or its refusal loses the mark. */
  it('a deployment that cannot write refuses, touching nothing', async () => {
    let touched = false;
    const inner: any = new Proxy({}, { get: () => () => { touched = true; } });
    const ledger = new ChainLedger(inner, DEPLOYMENT);
    const refused: any = await ledger.submitProven('acc_1', BYTES, reads(tx([call(OURS)]))).catch((e) => e);
    expect(refused.message).toMatch(/cannot write to it/);
    expect(saysNothingWasSent(refused)).toBe(true);
    expect(touched).toBe(false);
  });

  /* RED WHEN: a transaction that cannot be read is reported as an unknown outcome. */
  it('bytes that are not a transaction are nothing sent', async () => {
    const r = rig();
    const refused: any = await r.ledger.submitProven('acc_1', BYTES,
      async () => { throw new Error('not a transaction'); }).catch((e) => e);
    expect(refused.message).toMatch(/not a transaction/);
    expect(saysNothingWasSent(refused)).toBe(true);
  });

  /*
   * AGAINST THE LEDGER'S OWN READER. RED WHEN: the default reader stops using
   * the proven, unbound markers, so bytes a device proved cannot be read.
   */
  it('the default reader refuses bytes that are not a proven transaction, as nothing sent', async () => {
    const r = rig();
    const refused: any = await r.ledger.submitProven('acc_1', BYTES).catch((e) => e);
    expect(refused).toBeInstanceOf(Error);
    expect(refused.message, 'the bytes were not read by the ledger at all').not.toMatch(/calls nothing|could not be read/);
    expect(saysNothingWasSent(refused)).toBe(true);
    expect(r.steps).toEqual(['paying for acc_1']);
  });
});
