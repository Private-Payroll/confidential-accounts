/**
 * **THE SIGNER'S OWN SECRET, TAKEN OUT OF A KEYRING AND DRIVEN INTO THE
 * COMPILED CONTRACT, WITH WHAT REACHED THE DEVICE'S STORE READ BACK.**
 *
 * -- WHY THIS FILE IS NOT THE ONE BESIDE IT --------------------------------
 *
 * Its neighbour drives the same call into the same contract and answers a
 * different question: whether the key naming a call's record arrives at all.
 * The record it supplies is an in-memory map built and dropped inside the test,
 * standing in for a device - **and a fixture is a fixture.** With the argument
 * threaded and a record present, nothing in the client refuses; the only thing
 * left between this product and a proposal on a chain was that on a server
 * there is no such record, and there must never be one.
 *
 * **SO THIS FILE REMOVES THE FIXTURE.** The record here is composed, at the
 * moment the circuit asks for one, out of two sources with two different
 * lifetimes: the signer's own material, which is held in memory for a session
 * and written to nothing, and the account's half, which a store holds. Nothing
 * in the path is a stand-in for a device any more. The device's half IS the
 * device's half.
 *
 * -- AND THE WRITE IS WATCHED, WHICH IS THE HALF WITH NO SYMPTOM -----------
 *
 * Opening a round STAGES four fields into the record before the call is built,
 * and it stages them by reading the record and writing it back. **What it reads
 * back carries the signer's secret key, because composing is what a read here
 * does** - so this is not a model of the hazard, it is the hazard, on the
 * product's own path, in this test. What the store was handed is read back and
 * asserted on.
 *
 * The same write happens once more where nothing here can reach: the scheme
 * puts the record back after a transaction that succeeded entirely, which needs
 * a chain. It is the same `set`, so what is asserted below is what would
 * happen there.
 *
 * -- WHAT IS NOT HERE ------------------------------------------------------
 *
 * No proof and no chain. The proof server is a refusal, and reaching it is one
 * of the assertions: the circuit ran to the end and asked for a proof, which is
 * as far as anything goes without a prover and a node.
 *
 * **AND THE SECOND SEAT IS NOT HERE EITHER, WHICH IS SAID RATHER THAN IMPLIED.**
 * The contract is deployed with the founding leaf it is constructed with, and
 * the constructor takes one. So what the approval case below drives is a device
 * holding ONLY its keyring material, with nothing staged, completing the
 * signer check against the deployed tree - which is the whole of what a second
 * signer's device does differently. Putting a second leaf in the tree is the
 * seating operation, and it is not this file's.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  derivedPrivateState, SignerMaterialHeldInMemory,
  type AccountHalfStore, type StorableHalf,
} from '../web/private-state.js';
import { neverPersistedFieldsIn } from './what-a-device-may-persist.js';

/** The compiled artefacts: the generated contract, the keys and the ABI. */
const MANAGED = join(process.cwd(), 'contracts', 'managed');

const PRIVATE_STATE_BASE = 'the-secret-comes-from-the-keyring';

class TheProofServerWasReached extends Error {
  constructor() { super('the proof server was reached, and this test has none'); }
}
class TheChainWasReached extends Error {
  constructor() { super('a submission was reached, and this test has no chain'); }
}

const bytes32 = (seed: number): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (seed * 31 + i * 7) % 256;
  return out;
};

/**
 * Everything this file builds, assembled once per case.
 *
 * `stageTheAccountHalf` is what a company being OPENED on this device would
 * have written. Left out, the device holds its keyring material and nothing
 * else, which is the state a signer who has never raised anything is in.
 */
async function aDeviceWithAKeyring(opts: { stageTheAccountHalf?: boolean } = {}) {
  const stageTheAccountHalf = opts.stageTheAccountHalf ?? true;

  const { applyNetworkId } = await import('./network.js');
  await applyNetworkId('undeployed');

  const ledgerApi: any = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
  const witnessModule = await import('../../contracts/src/witnesses.js');
  const CompiledContract: any = await import('@midnight-ntwrk/compact-js/effect/CompiledContract');
  const generated: any = await import('../../contracts/managed/contract/index.js');
  const { NodeZkConfigProvider } =
    await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
  const { createUnprovenDeployTx } = await import('@midnight-ntwrk/midnight-js-contracts');

  const { AccountService } = await import('../core/account.js');
  const { SimulatedLedger } = await import('../core/ledger.js');
  const { MidnightCommitments } = await import('./commitments.js');
  const { FileStore } = await import('../core/store-file.js');
  const { MidnightLedger, privateStateKey } = await import('./ledger.js');
  const { fromHex, toHex } = await import('../core/crypto.js');

  /*
   * The REAL witnesses run; each records the record it was handed on the way
   * past. The observation point is INSIDE the contract, because a recorder
   * anywhere above it would be recording what this file passed rather than what
   * the composition produced.
   */
  const seen: Array<{ witness: string; privateState: any }> = [];
  const recording: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(witnessModule.witnesses as Record<string, any>)) {
    recording[name] = (ctx: any, ...rest: unknown[]) => {
      seen.push({ witness: name, privateState: ctx?.privateState });
      return fn(ctx, ...rest);
    };
  }
  const compiled = CompiledContract.make('ConfidentialAccount', generated.Contract).pipe(
    CompiledContract.withWitnesses(recording),
    CompiledContract.withCompiledFileAssets(MANAGED),
  );

  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'from-the-keyring-')), 'db.json'));
  const maker = new AccountService(
    store, new SimulatedLedger(MidnightCommitments), MidnightCommitments);
  const created = await maker.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
  const accountId = created.account.id;
  /*
   * **THIS IS THE KEYRING ENTRY AND NOT A FIXTURE.** These three fields are
   * what the service minted for Ada and handed to her device, and they are the
   * three the keyring seals under the key her wallet releases. A test that
   * invented any of them would be asserting against itself.
   */
  const ada = created.secrets[0]!;
  const keyringEntry = {
    signingSecret: ada.signingSecret,
    blinding: ada.blinding,
    scope: ada.scope,
  };
  const foundingLeaf = created.account.signers[0]!.leafCommitment!;

  const key = privateStateKey(PRIVATE_STATE_BASE, accountId);

  /* ---- the device's two sources ---- */

  const held = new SignerMaterialHeldInMemory();
  held.hold(key, keyringEntry);

  /**
   * The account's half, and what reached it.
   *
   * Whichever durable store a device ends up using is somebody else's decision;
   * what this stands in for is the SHAPE of one - it is handed a value and it
   * keeps what it was handed. **That is what makes the assertion meaningful:
   * a store that filtered anything itself would be doing the work under test.**
   */
  const written: StorableHalf[] = [];
  const filed = new Map<string, StorableHalf>();
  const accountHalf: AccountHalfStore = {
    get: async (address, id) => filed.get(`${address}:${id}`),
    set: async (address, id, half) => { written.push(half); filed.set(`${address}:${id}`, half); },
    remove: async (address, id) => { filed.delete(`${address}:${id}`); },
    clear: async () => { filed.clear(); },
  };

  const provider = derivedPrivateState({ signerMaterial: (id) => held.for(id), accountHalf });

  const walletProvider = {
    getCoinPublicKey: () => ledgerApi.sampleCoinPublicKey(),
    getEncryptionPublicKey: () => ledgerApi.sampleEncryptionPublicKey(),
  };
  const zkConfigProvider = new NodeZkConfigProvider(MANAGED);

  /*
   * **THE DEPLOY IS NOT A DEVICE OPERATION AND IS NOT DRIVEN THROUGH THE
   * DEVICE'S PROVIDER.** Creating a company is server-side here; what a browser
   * does is call circuits on one that exists. The throwaway below builds a real
   * deployed state - the constructor run with the founding leaf, every compiled
   * verifier key attached - and is then dropped. Nothing is submitted or proved.
   */
  const forTheDeployOnly = {
    get: async () => null, set: async () => {},
    setContractAddress: () => {}, setSigningKey: async () => {},
  };
  const unprovenDeploy: any = await createUnprovenDeployTx(
    { zkConfigProvider, privateStateProvider: forTheDeployOnly, walletProvider } as any,
    { compiledContract: compiled, args: [fromHex(foundingLeaf)] } as any,
  );
  const deployedState = unprovenDeploy.public.initialContractState;
  const address = String(ledgerApi.sampleContractAddress());

  /*
   * What OPENING the company on this device wrote: the account's asset
   * blinding, and the three the staging step overwrites on its way through.
   * The values are immaterial to every assertion; their PRESENCE is what
   * separates the two cases below.
   */
  if (stageTheAccountHalf) {
    filed.set(`${address}:${key}`, {
      assetBlinding: bytes32(11),
      assetId: bytes32(0),
      proposalSalt: bytes32(13),
      changeAmount: 0n,
      changeBatchDigest: bytes32(17),
    });
  }

  seen.length = 0;
  written.length = 0;

  const providers = {
    zkConfigProvider,
    privateStateProvider: provider,
    walletProvider,
    proofProvider: { proveTx: async () => { throw new TheProofServerWasReached(); } },
    midnightProvider: { submitTx: async () => { throw new TheChainWasReached(); } },
    publicDataProvider: {
      queryContractState: async () => deployedState,
      queryZSwapAndContractState: async () => [
        new ledgerApi.ZswapChainState(),
        deployedState,
        ledgerApi.LedgerParameters.initialParameters(),
      ],
      queryBlock: async () => ({ hash: '00'.repeat(32) }),
    },
  };

  const midnight = new MidnightLedger(
    {
      indexerUrl: 'http://indexer.invalid', indexerWsUrl: 'ws://indexer.invalid',
      proverUrl: 'http://prover.invalid', nodeUrl: 'http://node.invalid',
      zkConfigPath: MANAGED, networkId: 'undeployed', privateStateId: PRIVATE_STATE_BASE,
    },
    {
      addFeeAndFinalise: () => { throw new Error('a fee payer was reached and this test has none'); },
      submit: () => { throw new Error('a submission was reached and this test has none'); },
      release: () => { throw new Error('a release was reached and this test has none'); },
      payingFor: () => {},
      capacity: async () => ({ dust: 0n, night: 0n }),
    },
    { put: async () => {}, get: async () => null },
    async () => address,
    async () => providers,
    compiled,
  );

  const service = new AccountService(store, midnight, MidnightCommitments);

  const raiseARound = () => service.propose({
    accountId,
    viewingKey: created.viewingKey,
    kind: 'transfer',
    summary: 'one salary',
    payload: {
      entries: [{
        id: 'e1', kind: 'transfer', asset: 'GBP', amount: 10_00n,
        counterparty: 'a supplier', memo: '', at: '',
      }],
    },
    proposedBy: ada.signerId,
  });

  /** What a second signer's device does: approve, holding only its keyring. */
  const approveSomebodyElsesRound = () =>
    (midnight as any).buildCall(address, 'approve', [new Uint8Array(32)], key);

  return {
    accountId, keyringEntry, key, seen, written, held, midnight, address,
    raiseARound, approveSomebodyElsesRound, toHex,
  };
}

/** What a named witness actually read, as hex, or a sentence saying what went wrong. */
const fieldSeenBy = (
  seen: Array<{ witness: string; privateState: any }>,
  witness: string,
  field: 'secretKey' | 'blinding' | 'scope',
  toHex: (b: Uint8Array) => string,
): string => {
  const entry = seen.find((s) => s.witness === witness);
  if (!entry) return `the witness ${witness} was never reached`;
  if (entry.privateState == null) return 'the circuit was handed no private state';
  const value = entry.privateState[field];
  if (!(value instanceof Uint8Array)) return `the private state carried no ${field}`;
  return toHex(value);
};

const because = async (run: () => Promise<unknown>): Promise<string> => {
  try { await run(); return 'it did not fail at all'; } catch (e: any) { return String(e?.message ?? e); }
};

const KEYS_ON_DISK = existsSync(new URL('../../contracts/managed/keys/adopt.verifier', import.meta.url));
if (!KEYS_ON_DISK) {
  console.log(
    '  NOT CHECKED HERE: the verifier keys a governed call is built against are not on disk,'
    + ' so the assertions that drive one into the compiled contract did not run.'
    + ' `npm run compact` builds them.',
  );
}

describe.skipIf(!KEYS_ON_DISK)('a governed call is built from the keyring and not from a stored record [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  /**
   * **THE CIRCUIT IS HANDED THE SECRET THE KEYRING HOLDS, AND NO STORE WAS
   * ASKED FOR IT.**
   *
   * The value asserted against is the one the service minted for this signer
   * and would have sealed into her keyring. Nothing wrote it into a record
   * anywhere: it was put into memory and composed at the moment the witness
   * asked.
   *
   * RED WHEN: the composition takes the signer's three from the store instead
   * of from memory - there is nothing there, so the field is absent and this
   * reports that it was. Watched.
   */
  it('hands the compiled contract the signing key held in this device\'s keyring', async () => {
    const d = await aDeviceWithAKeyring();
    await d.raiseARound().catch(() => undefined);

    expect(fieldSeenBy(d.seen, 'localSecretKey', 'secretKey', d.toHex))
      .toBe(d.keyringEntry.signingSecret);
  }, 300_000);

  /**
   * **THE WHOLE CIRCUIT EXECUTED, WHICH IS WHAT THE THREE ARE FOR.**
   *
   * Opening a round proves a Merkle path to the leaf the signer's secret key,
   * blinding and scope commit to, and then reads five more fields. Reaching the
   * PROOF SERVER means every one of that happened against the deployed tree.
   * The proof server and the chain throw different errors on purpose, so a
   * change that submitted without proving fails here rather than passing.
   *
   * ONE ASSERTION. A wrong blinding or scope produces a different leaf and the
   * path refuses first, so separate field checks could not fail while this one
   * passes - and an assertion that cannot fail is the defect this repository
   * has paid for before.
   *
   * RED WHEN: the scope is filled in rather than refused, or the blinding is
   * taken from anywhere but the keyring - the leaf then is not the one the
   * account holds and the failure is "you are not a signer on this account".
   * Watched.
   */
  it('proves the signer\'s membership from that material and stops at the proof server', async () => {
    const d = await aDeviceWithAKeyring();
    await expect(d.raiseARound()).rejects.toThrow(/the proof server was reached/);
  }, 300_000);

  /**
   * **THE ONE THAT MATTERS MOST, AND IT IS NOT A MODEL OF THE HAZARD.**
   *
   * Opening a round reads this device's record and writes it back with four
   * fields staged into it. What it reads back CARRIES THE SIGNER'S SECRET KEY,
   * because composing is what a read here does - so the write below is handed
   * a real signing key, on the product's own path, in this run.
   *
   * The store keeps whatever it is handed and filters nothing, so what comes
   * back out is what the write allowed through. **The scheme makes the same
   * write once more after a transaction that settles, which needs a chain; it
   * is the same `set`, so this is that write too.**
   *
   * **AND THIS CASE READS THE SAME LIST OF NAMES THE CODE DROPS BY, WHICH IS
   * SAID HERE RATHER THAN LEFT TO BE FOUND.** Take a name off that list and the
   * dropping and the looking go blind together - measured, by removing one and
   * watching this case stay green while a signing key reached the store. The
   * case below it is the one that does not depend on the list, and it is there
   * for that reason rather than as a second opinion.
   *
   * RED WHEN: the write stops dropping what must not be stored - every one of
   * the five is then named here by the reader that looks for them. Watched.
   */
  it('writes nothing to the device\'s store that must never have a second copy', async () => {
    const d = await aDeviceWithAKeyring();
    await d.raiseARound().catch(() => undefined);

    expect(d.written.length, 'the round was never staged, so nothing was written and this case '
      + 'asserted about nothing').toBeGreaterThan(0);
    expect(d.written.flatMap((half) => neverPersistedFieldsIn(half))).toEqual([]);
  }, 300_000);

  /**
   * **AND NOT UNDER ANY OTHER NAME EITHER, WHICH IS A CLAIM ABOUT BYTES AND
   * NOT ABOUT A LIST.**
   *
   * The case above reads the same list of names the code drops by, so the two
   * can go blind together. This one compares what reached the store against the
   * three values the service actually minted for this signer - values this file
   * holds and the module under test never sees as strings. A list cannot be
   * dropped out from under it, and a secret written under a name that IS
   * allowed - the account's asset blinding is thirty-two bytes and is meant to
   * be written - is named here and nowhere else.
   *
   * RED WHEN: a field the list allows is made to carry the signer's own key -
   * every other case over this module stays green and this one names the field.
   * Watched.
   */
  it('writes nothing the keyring minted, under any name at all', async () => {
    const d = await aDeviceWithAKeyring();
    await d.raiseARound().catch(() => undefined);

    const minted = new Set([
      d.keyringEntry.signingSecret, d.keyringEntry.blinding, d.keyringEntry.scope,
    ]);
    expect(d.written.length, 'the round was never staged, so nothing was written and this case '
      + 'asserted about nothing').toBeGreaterThan(0);
    expect(d.written.flatMap((half) => Object.entries(half)
      .filter(([, value]) => value instanceof Uint8Array && minted.has(d.toHex(value)))
      .map(([name]) => name))).toEqual([]);
  }, 300_000);

  /**
   * **AND WHAT IT DOES WRITE IS THE THING THE NEXT CALL NEEDS.**
   *
   * A write that kept nothing would satisfy the case above and would lose the
   * salt four governance circuits recompute a round's identity from. A reverted
   * salt is not a wrong number; it is a round whose id nobody can reproduce.
   *
   * RED WHEN: the write drops the account's half along with the rest. Watched.
   */
  it('does write the salt and the change the round is recognised by', async () => {
    const d = await aDeviceWithAKeyring();
    await d.raiseARound().catch(() => undefined);

    expect(Object.keys(d.written[0]!).sort())
      .toEqual(['assetBlinding', 'assetId', 'changeAmount', 'changeBatchDigest', 'proposalSalt']);
  }, 300_000);
});

describe.skipIf(!KEYS_ON_DISK)('approving from a device that has staged nothing [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  /**
   * **AN APPROVAL NEEDS THE KEYRING AND THE PUBLIC TREE, AND NOTHING DURABLE
   * AT ALL.**
   *
   * The approval circuit reads four things: the approver's own secret key,
   * blinding and scope, and a path through the signer tree - which is public
   * and on chain. It reads no salt, no asset and no amount. **So the device
   * below holds its keyring material and has staged nothing whatsoever**, and
   * the refusal it meets is the contract's own business rule about a proposal
   * this test has not opened - which is reached AFTER the signer check has
   * already passed.
   *
   * That is the whole of what an account of several people rests on: an account
   * whose approvals only work on the machine that raised the run is not one.
   *
   * RED WHEN: the composition refuses, or answers with nothing, when the
   * account's half is absent - the failure is then the scheme naming a record
   * it could not find, before the contract is reached at all. Watched.
   */
  it('completes the signer check with no account material on the device', async () => {
    const d = await aDeviceWithAKeyring({ stageTheAccountHalf: false });

    expect(await because(() => d.approveSomebodyElsesRound()))
      .toMatch(/there is no open proposal with that id/);
  }, 300_000);

  /**
   * **AND IT REFUSES BY NAME ON A DEVICE THAT WAS NEVER SEATED.**
   *
   * With no material held, the composition answers with nothing and the scheme
   * refuses naming the record it looked for. Without that, the same situation
   * is a dereference of nothing inside the circuit runtime, which names none of
   * this and reads as key corruption.
   *
   * RED WHEN: a device holding no material composes a record anyway - the
   * circuit then runs against values that prove nothing. Watched.
   */
  it('refuses by naming the record when this device holds no keyring material', async () => {
    const d = await aDeviceWithAKeyring({ stageTheAccountHalf: false });
    d.held.releaseAll();

    expect(await because(() => d.approveSomebodyElsesRound()))
      .toMatch(new RegExp(`No private state found at private state ID '${d.key}'`));
  }, 300_000);
});
