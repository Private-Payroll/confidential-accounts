/**
 * **THE PRODUCT'S OWN GOVERNED CALL, DRIVEN INTO THE COMPILED CONTRACT, WITH
 * THE PRIVATE STATE THE CIRCUIT ACTUALLY RECEIVED WATCHED FROM INSIDE.**
 *
 * ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
 *
 * `MidnightLedger.prepare` computes the key a call's private state is filed
 * under, and returns it on the object every caller is already holding. Until
 * this file existed, every caller dropped it: `buildCall` took an address, a
 * circuit name and an argument list, `connect` built the SDK's options object
 * out of a compiled contract and an address, and the key went nowhere. The SDK
 * OMITS the field on a falsy value and then tests for its PRESENCE, so a key
 * that never arrives does not read as `undefined` - it selects a different
 * branch, the public-states one, and the executing circuit's `privateState` is
 * literally `undefined`. **The two calls the whole product rests on, opening a
 * round and approving one, both open by reading a signer's secret key off that
 * object**, so both died inside the circuit runtime dereferencing nothing, in
 * a message that named none of this.
 *
 * **NOT EVERY CIRCUIT DID.** `closeExpiredRun` reads no witness at all and is
 * permissionless on chain on purpose, so it ran correctly with no private
 * state and must go on doing so. That is the last test in this file, and it is
 * here because giving it a private-state precondition would have been a silent
 * removal of a property the contract argues for at length.
 *
 * **NO TEST COULD SEE ANY OF THIS.** The two tests that put the service layer
 * in front of the contract hand the circuit a private state themselves, so
 * they cannot observe what the client passes. The tests in `ledger.test.ts`
 * replace the find with a fake `callTx`, so nothing downstream of it exists to
 * observe. **A fix nobody can watch is what this repository has had to
 * rediscover every time it happened**, which is why this file drives the real
 * thing:
 *
 *   the product's own `AccountService.propose`
 *     -> `MidnightLedger.propose` -> `prepare` -> `buildCall` -> `connect`
 *     -> the REAL `findDeployedPartialContract`
 *     -> the REAL `createCircuitCallTxInterface`
 *     -> the REAL compiled contract, executing `propose`
 *     -> the witnesses, which record the private state they were handed.
 *
 * Nothing between the service and the circuit is faked. What is supplied is
 * the chain either side of it: a contract state, a private-state store, a
 * wallet's public keys, a proof server that refuses and a node that refuses.
 *
 * ── THE PRIVATE-STATE STORE HERE IS A TEST FIXTURE AND NOT A SERVER ─────────
 *
 * `signerStore` below is an in-memory map, built and thrown away inside one
 * test, standing in for the store on a signer's own device. **It is not, and
 * must not become, an argument for putting a private-state provider on the
 * server.** A server holding one signer's secret can produce every signature
 * that secret will ever produce, and that is the whole reason the device-side
 * half of this is still missing.
 *
 * **AND THE THING IT STANDS IN FOR ALREADY EXISTS, WHICH IS WORTH SAYING SO
 * THAT NOBODY READS THIS FILE AS HAVING INTRODUCED IT.** The server's own
 * provider bundle has carried a private-state store all along, and this
 * fixture is not what put it there. What no store anywhere holds is a signer's
 * secret key, blinding factor or scope: nothing in this product writes any of
 * the three, which is why threading the key does not by itself let a server
 * raise a proposal.
 *
 * ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
 *
 * No proof and no chain. The proof server is a refusal, and reaching it is one
 * of the assertions: the circuit ran to the end of its execution and asked for
 * a proof, which is as far as anything can go without a prover and a node.
 * Whether the proof is satisfiable and whether the verifier accepts it are
 * different questions and are not asked here.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The compiled artefacts: the generated contract, the keys and the ABI. */
const MANAGED = join(process.cwd(), 'contracts', 'managed');

/**
 * The private-state base this deployment would be configured with.
 *
 * It is the BASE and not the key. `privateStateKey` suffixes it with the
 * account id, and the difference between the two is one of the things this
 * file pins: a client that filed every account's private state under the base
 * alone would read one account's secret while calling another's contract.
 * **That is why two accounts are made below and not one** - with a single
 * account the base and the key can be collapsed into each other and nothing
 * notices.
 */
const PRIVATE_STATE_BASE = 'the-key-reaches-the-circuit';

/**
 * The proof server, refusing.
 *
 * A distinct class rather than a string match, so that "the call got as far as
 * asking for a proof" is a fact this file can assert on rather than infer from
 * the shape of a message the SDK wraps twice.
 */
class TheProofServerWasReached extends Error {
  constructor() { super('the proof server was reached, and this test has none'); }
}

/**
 * The chain, refusing, and it is a DIFFERENT class on purpose.
 *
 * Proving and submitting are two doors and only one of them is meant to be
 * reached here. Given one class for both, a change that submitted without
 * proving would leave every assertion in this file green, and submitting is
 * the door past which money can move.
 */
class TheChainWasReached extends Error {
  constructor() { super('a submission was reached, and this test has no chain'); }
}

/** Deterministic 32 bytes, so a failure fails the same way twice. */
const bytes32 = (seed: number): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (seed * 31 + i * 7) % 256;
  return out;
};

/**
 * Everything this file builds, assembled once per test.
 *
 * A function rather than a `beforeEach`, because two of the five tests want to
 * change one thing about the world before driving a call, and a shared mutable
 * fixture is how a test comes to depend on the one before it.
 */
async function aSignersDevice(opts: { fileTheDeviceRecord?: boolean } = {}) {
  const fileTheDeviceRecord = opts.fileTheDeviceRecord ?? true;

  const { applyNetworkId } = await import('./network.js');
  /*
   * `undeployed`, and it is the honest name for a test with no chain. The
   * network id is interpolated into every address the SDK encodes, so it has
   * to be set before a coin public key is sampled or parsed.
   */
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
   * ── THE WITNESSES, WRAPPED SO THEY SAY WHAT THEY WERE HANDED ──────────────
   *
   * The REAL witness functions run; each one records the private state it was
   * given on the way past. This is the observation point, and it is inside the
   * contract rather than beside it: a recorder anywhere above the compiled
   * contract would be recording what this file passed, which is the thing
   * under test.
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

  /*
   * ── TWO ACCOUNTS, BOTH MADE BY THE PRODUCT ────────────────────────────────
   *
   * Made through `AccountService` against the simulated ledger, because
   * creating one is a deploy and there is no chain here. **What matters is
   * that the signer's material is the service's own**: the secret key, the
   * blinding and the scope below are the ones `AccountService.create` minted
   * for Ada and would have handed to her device, and the founding leaf the
   * contract is deployed with is the one the service computed from them. A
   * test that invented any of the four would be asserting against itself.
   *
   * **THE SECOND ACCOUNT IS NOT DECORATION.** It is a real second record, on
   * the same store, under its own key, holding a different signer's secret. It
   * is what turns "the circuit got A's secret" from a claim about presence
   * into a claim about WHICH RECORD - and a client that addressed the store by
   * anything other than this account's own key would read Bruno's.
   */
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'the-key-reaches-')), 'db.json'));
  const maker = new AccountService(
    store, new SimulatedLedger(MidnightCommitments), MidnightCommitments);
  const created = await maker.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
  const other = await maker.create('Southwind Ltd', [{ name: 'Bruno', role: 'admin' }], 1);
  const accountId = created.account.id;
  const ada = created.secrets[0]!;
  const bruno = other.secrets[0]!;
  const foundingLeaf = created.account.signers[0]!.leafCommitment!;

  /*
   * ── WHAT A SEATED SIGNER'S DEVICE HOLDS ───────────────────────────────────
   *
   * Two halves, and the split is the point.
   *
   * The ACCOUNT's half is what the deploy writes: an asset blinding, the
   * reserved "no asset", a salt, a zero change. Those are supplied here
   * because no chain deployed this contract; their VALUES are immaterial to
   * every assertion below, and `stageChange` overwrites three of the four on
   * the way through `prepare`.
   *
   * The DEVICE's half is `secretKey`, `blinding` and `scope`, and it is the
   * half the deploy deliberately does not write. **No product path puts them
   * anywhere a witness can read them, which is why threading the key is not by
   * itself enough to raise a proposal.** They are here because this fixture is
   * standing in for the device that holds them.
   */
  const recordFor = (secrets: { signingSecret: string; blinding: string; scope: string }) => ({
    secretKey: fromHex(secrets.signingSecret),
    blinding: fromHex(secrets.blinding),
    scope: fromHex(secrets.scope),
    assetBlinding: bytes32(11),
    assetId: bytes32(0),
    proposalSalt: bytes32(13),
    changeAmount: 0n,
    changeBatchDigest: bytes32(17),
    pinnedPath: null,
  });
  const deviceRecord = recordFor(ada);

  /*
   * ── THE STORE, WHICH KNOWS TWO ACCOUNTS AND NOTHING ELSE ──────────────────
   *
   * Each account's record is filed under `privateStateKey(base, its own id)`
   * and under nothing else. Any other key answers with nothing.
   */
  const key = privateStateKey(PRIVATE_STATE_BASE, accountId);
  const otherKey = privateStateKey(PRIVATE_STATE_BASE, other.account.id);
  const filed = new Map<string, unknown>();
  if (fileTheDeviceRecord) filed.set(key, deviceRecord);
  /*
   * **THE OTHER ACCOUNT'S RECORD IS FILED SECOND, AND THE ORDER IS THE WHOLE
   * OF WHAT MAKES THE COLLISION OBSERVABLE.** With a key that names the
   * account the two records cannot meet and the order means nothing. With a
   * key that has stopped naming it they land on the same entry, and the one
   * written last is the one the circuit is handed - so filing the OTHER
   * account last is what turns "the key stopped naming the account" into a
   * signer's secret that is not this signer's, rather than into nothing at
   * all.
   */
  filed.set(otherKey, recordFor(bruno));

  const askedFor: string[] = [];
  /*
   * **WHAT WAS WRITTEN, AND NOT ONLY WHAT WAS READ.** Staging a change is a
   * write, and it is a write to the same record the SDK later reads - so a
   * client addressing the store by the wrong key writes there as well as
   * reading there, and a test that watched only reads would see half of it.
   */
  const wrote: string[] = [];
  const signerStore = {
    get: async (k: string) => { askedFor.push(k); return filed.get(k) ?? null; },
    set: async (k: string, v: unknown) => { wrote.push(k); filed.set(k, v); },
    setContractAddress: () => {},
    setSigningKey: async () => {},
  };

  const walletProvider = {
    getCoinPublicKey: () => ledgerApi.sampleCoinPublicKey(),
    getEncryptionPublicKey: () => ledgerApi.sampleEncryptionPublicKey(),
  };
  const zkConfigProvider = new NodeZkConfigProvider(MANAGED);

  /*
   * ── A REAL DEPLOYED STATE, BUILT IN PROCESS ───────────────────────────────
   *
   * The SDK's own unproven deploy runs the contract's constructor with the
   * founding leaf and attaches every compiled verifier key, which is what
   * `findDeployedPartialContract` compares against byte for byte. Nothing is
   * submitted and nothing is proved: only the state is kept.
   */
  const unprovenDeploy: any = await createUnprovenDeployTx(
    { zkConfigProvider, privateStateProvider: signerStore, walletProvider } as any,
    {
      compiledContract: compiled,
      args: [fromHex(foundingLeaf)],
      privateStateId: key,
      initialPrivateState: deviceRecord,
    } as any,
  );
  const deployedState = unprovenDeploy.public.initialContractState;
  const address = String(ledgerApi.sampleContractAddress());
  /* The constructor's own pass is not what this file watches. */
  seen.length = 0;
  askedFor.length = 0;

  const providers = {
    zkConfigProvider,
    privateStateProvider: signerStore,
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
      indexerUrl: 'http://indexer.invalid',
      indexerWsUrl: 'ws://indexer.invalid',
      proverUrl: 'http://prover.invalid',
      nodeUrl: 'http://node.invalid',
      zkConfigPath: MANAGED,
      networkId: 'undeployed',
      privateStateId: PRIVATE_STATE_BASE,
    },
    /*
     * **A SPONSOR THAT REFUSES EVERY SPENDING DOOR BY NAME.**
     *
     * Nothing on this path is meant to reach a fee payer - the proof server
     * refuses before anything is balanced or submitted - so the three methods
     * that could move money throw rather than pretend. If a change ever makes
     * one of them reachable, the test says which one instead of returning a
     * plausible nothing.
     */
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

  /** Raises a governance round the way a customer's request does. */
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

  /** Sweeps a run whose window has closed. The permissionless one. */
  const sweepAnExpiredRun = () =>
    midnight.closeExpiredRun(accountId, '11'.repeat(32), { signerId: ada.signerId } as any);

  return {
    accountId, ada, bruno, key, otherKey, seen, askedFor, wrote, midnight, raiseARound,
    sweepAnExpiredRun, toHex, address,
  };
}

/**
 * The field a named witness actually read, as hex - or a sentence saying what
 * happened instead.
 *
 * A SENTENCE RATHER THAN A THROW, so that a failure reports which of the three
 * things went wrong - the witness was never reached, it was reached with no
 * private state, or it was reached with the wrong one - instead of collapsing
 * all three into an assertion that says only "not equal".
 */
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

/** What the circuit runtime says, unwrapped enough to read. */
const because = async (run: () => Promise<unknown>): Promise<string> => {
  try { await run(); return 'it did not fail at all'; } catch (e: any) { return String(e?.message ?? e); }
};

describe('a governed call carries the private state key the product computed for it', () => {
  /**
   * **THE CIRCUIT RECEIVES THIS ACCOUNT'S OWN SIGNER'S RECORD.**
   *
   * ONE ASSERTION, AND IT IS THE ONE THAT FIRES. The call is expected to
   * reject at the proof server and that rejection is the next test's business;
   * swallowing it here is what keeps this test's single assertion the one that
   * reports, rather than a rejection matcher above it firing first and hiding
   * what the circuit actually got.
   *
   * RED WHEN: `connect` stops passing `privateStateId` to
   * `findDeployedPartialContract` - the SDK takes the public-states branch and
   * `localSecretKey` is handed `undefined`. RED WHEN: `buildCall` stops
   * passing `call.privateStateId`, or passes a constant, the address, or the
   * circuit name. RED WHEN: `prepare` files under the bare base. RED WHEN:
   * `privateStateKey` stops suffixing the account id - the two accounts then
   * collapse onto one key and the circuit is handed Bruno's secret. All
   * watched.
   */
  it('hands the compiled contract the secret key the service minted for that signer', async () => {
    const d = await aSignersDevice();
    await d.raiseARound().catch(() => undefined);

    expect(fieldSeenBy(d.seen, 'localSecretKey', 'secretKey', d.toHex))
      .toBe(d.ada.signingSecret);
  }, 300_000);

  /**
   * **THE WHOLE CIRCUIT EXECUTED, WHICH IS WHAT THE SECRET IS FOR.**
   *
   * `propose` opens with `requireSigner()`, which reads the signer's secret
   * key, blinding and scope and then proves a Merkle path to the leaf they
   * commit to; nine witnesses answer before the transaction is built. Reaching
   * the PROOF SERVER means all of that happened. **The proof server and the
   * chain throw different errors on purpose**, so a change that submitted
   * without proving fails here rather than passing.
   *
   * ONE ASSERTION. The three field checks that stood here were removed rather
   * than kept: the contract couples them - a wrong blinding or scope produces
   * a different leaf and `signerPath` refuses first - so they could not fail
   * while this one passed, and an assertion that cannot fail is the defect
   * this repository has paid for before.
   *
   * RED WHEN: the argument is removed at either site - execution stops inside
   * `localSecretKey` and the failure is the circuit runtime's, not the proof
   * server's.
   */
  it('runs the whole circuit and stops at the proof server', async () => {
    const d = await aSignersDevice();
    await expect(d.raiseARound()).rejects.toThrow(/the proof server was reached/);
  }, 300_000);

  /**
   * **THE KEY IS THE ACCOUNT'S OWN, AND THE SDK IS WHAT ASKED FOR IT.**
   *
   * `prepare` stages the change under this key before the call is built, so
   * one read is the product's own. The SECOND is the SDK's, inside
   * `getContractStates`, and it is the one that only happens when the argument
   * arrives.
   *
   * RED WHEN: `prepare` files under the bare base - the WRITE is under the
   * wrong key and the first assertion is the one that reports it. RED WHEN:
   * the argument is removed - there is one read, not two. RED WHEN: a
   * different key is passed - the second read names it and it is not this
   * one. RED WHEN: the key stops naming the account - under a key that
   * collides two accounts everything in the file fires, and under a key that
   * keeps the account id but changes its shape the LAST assertion here is the
   * only one in the file that notices, which is why it is written as a claim
   * about the key rather than about its effect.
   */
  it('is asked for by the SDK under the account-suffixed key, not the bare base', async () => {
    const d = await aSignersDevice();
    await d.raiseARound().catch(() => undefined);

    expect(d.wrote).toEqual([d.key]);
    expect(d.askedFor).toEqual([d.key, d.key]);
    expect(d.key.endsWith(`:${d.accountId}`)).toBe(true);
  }, 300_000);

  /**
   * **AND THE REFUSAL IS A SENTENCE, WHICH IS THE OTHER THING THE ARGUMENT
   * BUYS.**
   *
   * With the key passed, a call against an account this device was never
   * seated on is refused by the SDK naming the private state id it looked
   * under. Without it, the same situation is a dereference of `undefined`
   * inside the circuit runtime, which names nothing and reads as key
   * corruption.
   *
   * **`buildCall` IS DRIVEN DIRECTLY HERE AND THIS TEST THEREFORE COVERS THE
   * REFUSAL AND NOT THE NINE CALL SITES** - it passes the key itself, so a
   * caller that dropped it would leave this test green. Tests one and three
   * are what cover the call sites. It is driven directly because `propose` and
   * `proposeRun` - the only two doors that stage a private state before they
   * call - would refuse at the staging step instead, and the other doors need
   * an open proposal on chain that this fixture has not got.
   *
   * RED WHEN: `connect` stops passing the key on - the failure is the
   * anonymous one again and names no id.
   */
  it('refuses by naming the private state id when the device holds no record', async () => {
    const d = await aSignersDevice({ fileTheDeviceRecord: false });
    await expect(
      (d.midnight as any).buildCall(d.address, 'approve', [new Uint8Array(32)], d.key),
    ).rejects.toThrow(new RegExp(`No private state found at private state ID '${d.key}'`));
  }, 300_000);
});

describe('the sweep of an expired run is not given a private state it does not read', () => {
  /**
   * **THE ONE GOVERNED CALL THAT WORKED BEFORE ANY OF THIS, AND MUST GO ON
   * WORKING FOR A CLIENT THAT HOLDS NOTHING.**
   *
   * `closeExpiredRun` calls no witness. It is permissionless on chain by
   * design: all it can remove is an authorisation that has already expired,
   * and the contract's own argument for leaving it open is that an account
   * whose signers have all left must still be able to have its expired rows
   * swept. **Requiring a private-state record would put a precondition on the
   * sweep of any client that has never staged a call against this account**,
   * and it would be invisible - the refusal would come from the SDK and name
   * a store, not the property it had removed. (A stranger in the contract's
   * sense builds the call themselves and never reaches this class at all;
   * what is modelled here is the case this product actually has, and it is
   * the one that regressed.)
   *
   * The device here holds NO record. The call still reaches the contract and
   * fails on the contract's own business rule, which is the right refusal:
   * this fixture has no open proposal to close.
   *
   * RED WHEN: `prepare` gives this circuit a key like the other eight - the
   * SDK then refuses first, with "No private state found at private state ID",
   * and the store is asked a question nobody needed the answer to. Watched.
   */
  it('reaches the contract from a device that holds no record at all', async () => {
    const d = await aSignersDevice({ fileTheDeviceRecord: false });

    expect(await because(() => d.sweepAnExpiredRun()))
      .toMatch(/there is no open proposal with that id/);
  }, 300_000);

  /**
   * **AND IT DOES NOT ASK FOR ONE EVEN WHERE ONE EXISTS.**
   *
   * A SECOND TEST AND NOT A SECOND ASSERTION, and the split is deliberate.
   * With no record filed, the store being unasked cannot fail: the call would
   * have refused at the store before it reached the contract, and the test
   * above would have reported that instead. With a record filed, the sweep
   * succeeds either way and the only observable difference is whether the
   * question was asked. **Each half of the property therefore needs the world
   * the other half cannot have.**
   *
   * RED WHEN: `prepare` gives this circuit a key - the store is asked for a
   * record the circuit will not read, and this is the assertion that says so.
   */
  it('does not ask the store for a record even where one is filed', async () => {
    const d = await aSignersDevice();

    await d.sweepAnExpiredRun().catch(() => undefined);
    expect(d.askedFor).toEqual([]);
  }, 300_000);
});
