/**
 * A COMPANY IS CREATED IN TWO STEPS: A DEPLOY, THEN ONE UPDATE THAT ONLY INSERTS.
 *
 * The account's twelve circuits no longer fit one transaction under the
 * per-transaction ceiling (`scripts/dispatch-ceiling.ts`, 31,997 bytes written).
 * So the deploy carries `FIRST_STEP_CIRCUITS`, and one maintenance update, signed
 * by the key the deploy installed, inserts `SECOND_STEP_CIRCUITS`.
 *
 * The first block needs nothing on disk: the lists, the refusals, and the builder
 * against stand-in ledger pieces. The second builds both transactions for real,
 * applies them to an empty ledger in memory, reads the account back, and measures
 * each with the ledger's own cost function. Nothing is proved or submitted.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEPLOYED_CIRCUITS, FIRST_STEP_CIRCUITS, SECOND_STEP_CIRCUITS, assertCreationSteps,
  creationStepOf,
} from './deferral.js';
import {
  buildCreationInsert, requireCreatableAuthority, type CreationInsertPrimitives,
} from './partial-contract.js';
import { BYTES_WRITTEN_LIMIT, extrinsicCeiling } from '../../scripts/dispatch-ceiling.js';

const HEADER = new TextEncoder().encode('midnight:verifier-key[v6]:');
const standIn = (name: string) => {
  const k = new Uint8Array(HEADER.length + 8);
  k.set(HEADER);
  k.set(new TextEncoder().encode(name.slice(0, 8)), HEADER.length);
  return k;
};
const keysFor = (names: readonly string[], make = standIn) =>
  new Map(names.map((n) => [n, make(n)] as [string, Uint8Array]));

/** Ledger pieces that record what they were built with, so the builder's output can be read. */
const recording = (): CreationInsertPrimitives & { built: any[] } => {
  const built: any[] = [];
  return {
    built,
    VerifierKeyInsert: class { constructor(public operation: string, public vk: any) {} } as any,
    ContractOperationVersionedVerifierKey: class { constructor(public version: string, public rawVk: Uint8Array) {} } as any,
    MaintenanceUpdate: class {
      readonly dataToSign = new Uint8Array([1]);
      constructor(public address: string, public updates: any[], public counter: bigint) { built.push(this); }
      addSignature() { return this; }
    } as any,
  };
};

describe('the two steps, as lists', () => {
  it('the first step is the eight a company governs itself with, and pays with none of them', () => {
    /* A product decision, written out: a change to it should have to change this line. */
    expect([...FIRST_STEP_CIRCUITS]).toEqual([
      'adopt', 'amendSigner', 'approve', 'cancel', 'closeExpiredRun', 'propose',
      'removeSignerAndSetThreshold', 'setThreshold',
    ]);
    /* RED WHEN the payment step is moved into the deploy, so an unfinished company could pay. */
    expect(FIRST_STEP_CIRCUITS as readonly string[]).not.toContain('recordPaymentFromVault');
  });

  it('the second step inserts the rest, the payment step among them', () => {
    expect([...SECOND_STEP_CIRCUITS]).toEqual([
      'recordPaymentFromVault', 'retireVault', 'sealPayKey', 'setVaultThreshold',
    ]);
  });

  it('the two steps add up to the account: every circuit in exactly one', () => {
    /* RED WHEN a circuit is put in both steps, or left out of both. */
    expect(() => assertCreationSteps()).not.toThrow();
    expect(DEPLOYED_CIRCUITS.map(creationStepOf).filter((s) => s === null)).toEqual([]);
    expect([...FIRST_STEP_CIRCUITS, ...SECOND_STEP_CIRCUITS].sort()).toEqual([...DEPLOYED_CIRCUITS]);
    expect(creationStepOf('recordPayment')).toBeNull();
  });
});

describe('who can create a company', () => {
  const signingKey = { tag: 'schnorr', value: 'ab'.repeat(32) };

  it('the recorded single key can: it installs itself and signs the second step', () => {
    const choice = { kind: 'single-key' as const, signingKey, temporary: { fixedBy: 'a later deployment' } };
    expect(requireCreatableAuthority(choice)).toBe(choice);
  });

  it('an unmaintainable account is refused before anything is deployed: it could never take the second step', () => {
    /* RED WHEN the refusal is dropped: the deploy would leave an account that can never pay. */
    expect(() => requireCreatableAuthority({ kind: 'unmaintainable' }))
      .toThrow(/can never take the second\. Nothing was deployed/);
  });

  it("a committee is refused here: this process holds none of its members' keys", () => {
    expect(() => requireCreatableAuthority({
      kind: 'committee', committee: [{ tag: 'schnorr', value: 'cd'.repeat(32) }], threshold: 1,
    })).toThrow(/holds\s+none of their signing keys/);
  });
});

describe('the second step, as built', () => {
  const ADDRESS = 'ab'.repeat(32);

  it("inserts exactly the second step's circuits, in order, at the counter it was given, and nothing else", () => {
    const P = recording();
    const out = buildCreationInsert(P, {
      address: ADDRESS, counter: 0n, onChain: [...FIRST_STEP_CIRCUITS], keys: keysFor(SECOND_STEP_CIRCUITS),
    });
    const u = P.built[0];
    expect(u.address).toBe(ADDRESS);
    expect(u.counter).toBe(0n);
    /* RED WHEN the update carries anything but one insert per second-step circuit. */
    expect(u.updates.map((x: any) => [x.constructor === P.VerifierKeyInsert, x.operation, x.vk.version]))
      .toEqual(SECOND_STEP_CIRCUITS.map((n) => [true, n, 'v3']));
    expect(out.inserted).toEqual([...SECOND_STEP_CIRCUITS]);
  });

  it('refuses a key set that is not exactly the second step', () => {
    const P = recording();
    const missing = keysFor(SECOND_STEP_CIRCUITS.slice(1));
    expect(() => buildCreationInsert(P, { address: ADDRESS, counter: 0n, onChain: [...FIRST_STEP_CIRCUITS], keys: missing }))
      .toThrow(/inserts exactly .* and was handed keys for/);
    const extra = keysFor([...SECOND_STEP_CIRCUITS, 'approve']);
    expect(() => buildCreationInsert(P, { address: ADDRESS, counter: 0n, onChain: [...FIRST_STEP_CIRCUITS], keys: extra }))
      .toThrow(/inserts exactly/);
    expect(P.built).toEqual([]);
  });

  it('refuses an account that already carries a second-step circuit, rather than inserting over it', () => {
    const P = recording();
    /* RED WHEN the builder inserts over a key the account already holds: the ledger refuses, and the fee is spent. */
    expect(() => buildCreationInsert(P, {
      address: ADDRESS, counter: 1n, onChain: [...FIRST_STEP_CIRCUITS, 'sealPayKey'], keys: keysFor(SECOND_STEP_CIRCUITS),
    })).toThrow(/already carries sealPayKey/);
  });

  it('refuses an account whose deploy is not the first step', () => {
    const P = recording();
    expect(() => buildCreationInsert(P, {
      address: ADDRESS, counter: 0n, onChain: FIRST_STEP_CIRCUITS.filter((n) => n !== 'approve'),
      keys: keysFor(SECOND_STEP_CIRCUITS),
    })).toThrow(/does not carry approve/);
  });

  it('refuses a key that is not a compiled verifier key of the version this product builds', () => {
    const P = recording();
    const keys = keysFor(SECOND_STEP_CIRCUITS);
    keys.set('sealPayKey', new TextEncoder().encode('midnight:verifier-key[v7]:xx'));
    expect(() => buildCreationInsert(P, { address: ADDRESS, counter: 0n, onChain: [...FIRST_STEP_CIRCUITS], keys }))
      .toThrow(/key handed in for sealPayKey is not a compiled verifier key/);
  });
});

/* ------------------------------------------------------------------ */

const KEYS = join(import.meta.dirname, '..', '..', 'contracts', 'managed', 'keys');
const KEYED = DEPLOYED_CIRCUITS.every((n) => existsSync(join(KEYS, `${n}.verifier`)));

describe.skipIf(!KEYED)('both steps, applied to an empty ledger and measured with its own cost function [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  const run = async () => {
    const L: any = await import('@midnightntwrk/ledger-v9');
    const rt: any = await import('@midnight-ntwrk/compact-runtime');
    const { AccountSimulator, privateStateFor } = await import('../../contracts/test/simulator.js');
    const NET = 'undeployed';
    const NOW = new Date();
    const seconds = BigInt(Math.floor(NOW.getTime() / 1000));
    const blockContext = {
      secondsSinceEpoch: seconds, secondsSinceEpochErr: 30,
      parentBlockHash: '00'.repeat(32), lastBlockTime: seconds - 6n,
    };
    const ttl = () => new Date(NOW.getTime() + 1_800_000);
    const strictness = () => {
      const s = new L.WellFormedStrictness();
      s.enforceBalancing = false; s.verifyNativeProofs = false;
      s.verifyContractProofs = false; s.enforceLimits = true; s.verifySignatures = true;
      return s;
    };
    const key = (n: string) => new Uint8Array(readFileSync(join(KEYS, `${n}.verifier`)));
    const sk = L.signingKeyFromBip340(new Uint8Array(32).fill(7));

    /* The constructor's own state, carrying only the operations named. */
    const sim = await AccountSimulator.create(privateStateFor(1));
    const constructed: any = sim.contractStateForCall;
    const deployOf = (names: readonly string[]) => {
      const cs: any = new rt.ContractState();
      cs.data = constructed.data;
      for (const n of names) {
        const op = new rt.ContractOperation();
        op.verifierKey = key(n);
        cs.setOperation(n, op);
      }
      const ledgerState = L.ContractState.deserialize(cs.serialize());
      ledgerState.maintenanceAuthority = new L.ContractMaintenanceAuthority([L.signatureVerifyingKey(sk)], 1, 0n);
      return new L.ContractDeploy(ledgerState);
    };
    const dep = deployOf(FIRST_STEP_CIRCUITS);
    const first = L.Transaction.fromParts(NET, undefined, undefined, L.Intent.new(ttl()).addDeploy(dep));
    let ls = L.LedgerState.blank(NET);
    [ls] = ls.apply(first.wellFormed(ls, strictness(), NOW), new L.TransactionContext(ls, blockContext));

    const built = buildCreationInsert(L as CreationInsertPrimitives, {
      address: dep.address, counter: 0n, onChain: [...FIRST_STEP_CIRCUITS],
      keys: new Map(SECOND_STEP_CIRCUITS.map((n) => [n, key(n)] as [string, Uint8Array])),
    });
    const update: any = built.update;
    const signed = update.addSignature(0n, L.signData(sk, update.dataToSign));
    const second = L.Transaction.fromParts(NET, undefined, undefined, L.Intent.new(ttl()).addMaintenanceUpdate(signed));
    const [after] = ls.apply(second.wellFormed(ls, strictness(), NOW), new L.TransactionContext(ls, blockContext));
    const state = after.index(dep.address);

    const whole = L.Transaction.fromParts(NET, undefined, undefined, L.Intent.new(ttl()).addDeploy(deployOf(DEPLOYED_CIRCUITS)));
    /* The ledger's own cost function, at its own parameters. */
    const written = (tx: any) => Number(tx.cost(L.LedgerParameters.initialParameters()).bytesWritten);
    return {
      operations: [...state.operations()].map(String).sort(),
      counter: state.maintenanceAuthority.counter as bigint,
      firstWritten: written(first),
      secondWritten: written(second),
      wholeWritten: written(whole),
      readBack: (n: string) => state.operation(n).verifierKey as Uint8Array,
      key,
    };
  };

  it('THE HEADLINE: after both steps the account carries every circuit, each with its own key', async () => {
    const r = await run();
    /* RED WHEN the second step inserts less than the rest of the account. */
    expect(r.operations).toEqual([...DEPLOYED_CIRCUITS]);
    for (const n of DEPLOYED_CIRCUITS) expect(Array.from(r.readBack(n))).toEqual(Array.from(r.key(n)));
    /* The update moved the maintenance counter on once, so it cannot be replayed. */
    expect(r.counter).toBe(1n);
  });

  it('each step fits under the per-transaction ceiling, and the whole account in one deploy does not', async () => {
    const r = await run();
    const ceiling = extrinsicCeiling(BYTES_WRITTEN_LIMIT);
    expect(ceiling).toBe(31_997);
    /* RED WHEN a step is changed so it no longer fits: the chain refuses a transaction over the ceiling. */
    expect(r.firstWritten).toBeLessThan(ceiling);
    expect(r.secondWritten).toBeLessThan(ceiling);
    /* And the reason there are two steps at all, measured rather than assumed. */
    expect(r.wholeWritten).toBeGreaterThan(ceiling);
    /* Unproven and unbalanced: a proven deploy has moved by about 260 either way, so keep that room. */
    expect(ceiling - r.firstWritten).toBeGreaterThan(260);
  });
});
