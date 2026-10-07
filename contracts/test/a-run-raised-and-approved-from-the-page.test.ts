/**
 * **A PAYROLL RUN RAISED AND APPROVED FROM A SIGNER'S DEVICE, THROUGH THE
 * WORKER'S OWN MESSAGE HANDLING, AND APPLIED BY THE CHAIN.**
 *
 * What is real here:
 *   · the chain is the ledger's own state machine, applying each transaction as
 *     its own block;
 *   · the company account is the compiled account, deployed with the state its
 *     own constructor writes for one founding signer and this build's circuits;
 *   · the raise and the approval are built by the device's own builder, reached
 *     through the page's own worker client and the worker's own handler, from
 *     key material shaped exactly as the keyring holds it, with the account's
 *     half of a raise as the service hands it over;
 *   · what the device sends is read by the service's own reader and passed by
 *     the service's own check before the chain applies it.
 *
 * **WHAT THIS DOES NOT SHOW, SAID HERE SO NOTHING RELIES ON IT:**
 *   · **no proof is made.** The call reaches the chain unproven and the ledger
 *     is told not to check proofs;
 *   · no fee is balanced and nothing reaches a network, an indexer, a browser
 *     or a wallet;
 *   · the service's routes and its records are not driven here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as L from '@midnightntwrk/ledger-v9';
import * as runtime from '@midnight-ntwrk/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as contracts from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import * as accountModule from '../managed/contract/index.js';
import { witnesses, type AccountPrivateState } from '../src/witnesses.js';
import { privateStateFor, leafOfDevice, change, COMPANY_LABEL } from './simulator.js';
import { DEPLOYED_CIRCUITS } from '../../src/midnight/deferral.js';
import { answerVaultAsk } from 'vaults-web-shared/vault-worker-entry.js';
import { vaultBuilderOver, type AccountCallChainOnTheWire, type VaultAnswer } from 'vaults-web-shared/vault-worker-client.js';
import type { GovernedCallOrder, OpenedRound, SignerMaterial } from 'vaults-web-shared/governed-call-builder.js';
import { refusalForProven } from '../../src/wiring/proven-submission.js';
import { keysOnDisk } from './keys-on-disk.js';
import { newWrappingKeypair } from '../../src/core/crypto.js';
import { NO_ASSET } from '../../src/core/assets.js';
import { buildRun, type PaymentFacts } from '../../src/midnight/payout-tree.js';
import { payeeFor, payFor } from '../../src/testing/payees.js';
import { vaultDetails } from '../../src/testing/vault-details.js';
import { TEST_TOKEN } from '../../src/testing/assets.js';
import type { RunMadeHere } from 'vaults-web-shared/what-this-device-made.js';

const NET = 'undeployed';
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const asRuntime = (state: { serialize(): Uint8Array }) => (runtime as any).ContractState.deserialize(state.serialize());
const accountLedgerOf = (state: { serialize(): Uint8Array }) => (accountModule as any).ledger(asRuntime(state).data);
const circuits = (accountModule as any).pureCircuits;

/** The ledger's own state machine, one transaction per block. */
class Chain {
  state: any = L.LedgerState.blank(NET);
  apply(tx: any): { ok: boolean; error: string } {
    const s = new L.WellFormedStrictness();
    s.enforceBalancing = false; s.verifyNativeProofs = false; s.verifyContractProofs = false;
    s.enforceLimits = false; s.verifySignatures = true;
    const now = new Date();
    const t = BigInt(Math.floor(now.getTime() / 1000));
    const [next, result] = this.state.apply(tx.wellFormed(this.state, s, now),
      new L.TransactionContext(this.state, {
        secondsSinceEpoch: t, secondsSinceEpochErr: 30, parentBlockHash: '00'.repeat(32), lastBlockTime: t - 6n,
      }));
    const ok = result.type === 'success';
    if (ok) this.state = next.postBlockUpdate(now);
    return { ok, error: String(result.error ?? '') };
  }
  contract(address: string): any { return this.state.index(address); }
}

/*
 * **THE ACCOUNT'S VERIFIER KEYS, WHICH ONLY A FULL COMPILE PRODUCES.** Skipped
 * by name where they are absent, and the job that builds the keys runs this
 * file by name.
 */
/* Every circuit of the account and of the vault has its verifier key on disk, and each is the key this build compiled. */
const KEYS = keysOnDisk();
const KEYS_ON_DISK = KEYS.ok;
if (!KEYS_ON_DISK) {
  console.log(`  NOT CHECKED HERE: a run was not raised and approved from a device, because ${KEYS.why}`);
}

describe.skipIf(!KEYS_ON_DISK)('A PAYROLL RUN RAISED AND APPROVED FROM THE SIGNER\'S OWN DEVICE [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  let chain: Chain;
  let company: string;
  let founder: AccountPrivateState;
  let asked: string[];
  let handed: AccountPrivateState[];

  const accountZk = new NodeZkConfigProvider(new URL('../managed', import.meta.url).pathname);
  const accountCompiled = CompiledContract.make('ConfidentialAccount', (accountModule as any).Contract).pipe(
    CompiledContract.withWitnesses(witnesses as never));

  /**
   * **THE CALL BUILDERS THE WORKER IS GIVEN, AND ONLY ONE OF THEM MAY BE
   * REACHED.** Every other name on the package - the ones that read and write a
   * private-state store among them - throws when it is asked for, and every
   * record handed to the one that is reached is kept here to be read after.
   */
  const onlyTheValueBuilder = () => new Proxy({}, {
    get: (_t, name) => {
      asked.push(String(name));
      if (name !== 'createUnprovenCallTxFromInitialStates') throw new Error(`the builder reached ${String(name)}`);
      return async (zk: unknown, options: { initialPrivateState: AccountPrivateState }, ...rest: unknown[]) => {
        handed.push(options.initialPrivateState);
        return (contracts as any).createUnprovenCallTxFromInitialStates(zk, options, ...rest);
      };
    },
  });

  /**
   * What a signer's device opens from the company's own records for each run
   * written down, by identity: the run's payload, its vault, the sealed salt and
   * change. Every call is handed it, as the page hands it. The page's opening itself runs over real records in
   * `packages/web-shared/src/the-device-proves-what-it-opened.test.ts`.
   */
  const opened = new Map<string, OpenedRound>();
  const openedFor = (order: GovernedCallOrder): OpenedRound => {
    const { half, made, ...record } = opened.get(order.proposal)!;
    /* A run is raised as this device made it again, with every round the company's records hold to check the chain against. */
    const raising = { period: '2026-09', knownRounds: [...opened.keys()], knownLeaves: [], knownNonces: [] };
    return order.circuit === 'propose'
      ? { ...record, half: half!, ...(made?.kind !== 'payroll' ? {} : { made: { ...made, raising } }) }
      : { ...record, ...(made === undefined ? {} : { made }) };
  };

  const builder = () => {
    const deps = async () => ({
      ledger: L, runtimeState: (runtime as any).ContractState,
      contracts: onlyTheValueBuilder(),
      accountCompiled, accountZkConfig: accountZk, accountPure: circuits,
      /* What an approval of a run is checked against: the account's ledger as the chain holds it, and the vault's circuits. */
      accountLedger: (accountModule as any).ledger, vaultDetails,
      /* No proof is made here: what the chain is handed is the unproven call. */
      prove: async (unproven: any) => unproven,
    });
    const listeners: Array<(e: { data: unknown }) => void> = [];
    const client = vaultBuilderOver({
      addEventListener: (_t, l) => { listeners.push(l); },
      postMessage: (message) => {
        void answerVaultAsk(deps as never, message as never).then(
          (a: VaultAnswer) => listeners.forEach((l) => l({ data: a })),
          (e: Error) => listeners.forEach((l) => l({ data: { id: (message as { id: number }).id, ok: false, error: e.message } })));
      },
    }, NET);
    return {
      governedCall: (input: Omit<Parameters<typeof client.governedCall>[0], 'opened'>) =>
        client.governedCall({ ...input, opened: openedFor(input.order) }),
      client,
    };
  };

  /**
   * **THE COMPANY COMMITS TO ITS PAY-RECORD KEY**, from the founding signer's device, as
   * a company created on its founding signer's device does: the proposal
   * raised, approved and carried out. An approval of a run checks the run's
   * pay-record key against this commitment.
   */
  const commitThePayKey = async (b: ReturnType<typeof builder>, key: string) => {
    const standing = () => b.client.payKeyStanding!({
      account: company, accountState: callState().accountState, key, signingSecret: hex(founder.secretKey),
      wrappingPublicKey: newWrappingKeypair().publicKey,
    });
    const s = await standing();
    const r = s.round;
    const payKey = { kind: 'pay-key', commitment: r.commitment } as const;
    const half = { assetId: NO_ASSET, changeAmount: '0', changeBatchDigest: '00'.repeat(32) };
    opened.set(r.proposal, { chainId: r.proposal, digest: r.payload, vault: s.noVault, salt: r.salt, summary: '', governance: payKey, half });
    for (const order of [
      { circuit: 'propose', payKey, half: { ...half, assetBlinding: hex(new Uint8Array(randomBytes(32))), proposalSalt: r.salt }, proposal: r.proposal },
      { circuit: 'approve', proposal: r.proposal, of: { governance: payKey, proposalSalt: r.salt } },
      { circuit: 'sealPayKey', wrap: s.wrap, commitment: r.commitment, proposal: r.proposal, proposalSalt: r.salt },
    ] as GovernedCallOrder[]) {
      const sent = send((await b.governedCall({ account: company, order, material: keyringOf(founder), chain: callState() })).tx);
      if (!sent.ok) throw new Error(`committing the pay-record key: ${order.circuit} was refused: ${sent.error}`);
    }
    expect((await standing()).committed).toBe(r.commitment);
  };

  /** The account as the chain holds it now, the way the service hands it over. */
  const callState = (): AccountCallChainOnTheWire => ({
    blockHash: '00'.repeat(32),
    accountState: b64(chain.contract(company).serialize()),
    parameters: b64(L.LedgerParameters.initialParameters().serialize()),
  });

  /** The signer's material, in the shape the keyring holds it. */
  const keyringOf = (s: AccountPrivateState): SignerMaterial => ({
    signingSecret: hex(s.secretKey), blinding: hex(s.blinding), scope: hex(s.scope),
  });

  /** What the device sent, read by the service's own reader and check, then applied. */
  const send = (tx: string) => {
    const read = L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', Buffer.from(tx, 'base64'));
    const refusal = refusalForProven(read, company);
    if (refusal !== null) throw new Error(`the service refused it: ${refusal}`);
    return chain.apply(read);
  };

  /** A run's order and the id the chain will hold it under. */
  const aRun = (seed: number) => {
    const c = change(BigInt(1_000 + seed), seed);
    const now = BigInt(Math.floor(Date.now() / 1000));
    /*
     * **A REAL RUN, AS THE APPROVING DEVICE MAKES IT AGAIN**: three payees,
     * their leaves from a payout seed and the pay-record key. Which seat's
     * signature makes the state they come from believed is settled where the
     * run is read, from the account's deploy: `src/server/the-company-state-is-believed-from-the-deploys-seat.test.ts`.
     */
    const facts: PaymentFacts[] = [0, 1, 2].map((i) => ({
      payee: payeeFor(`a${i + 1}`.repeat(32), NET), token: TEST_TOKEN, amount: BigInt(100 + seed + i),
    }));
    const pay = payFor(facts, { people: ['p1', 'p2', 'p3'] });
    const seeds = [{ epoch: 0, seed: hex(new Uint8Array(randomBytes(32))) as never }];
    const identity = { accountId: 'acc_page', runId: `run_${seed}`, epoch: 0 };
    const tree = buildRun(seeds, identity, facts, vaultDetails, pay, TEST_TOKEN).tree;
    const run = {
      root: tree.root as string, payees: String(tree.payees),
      opensAt: String(now - 60n), closesAt: String(now + 3_600n), vault: hex(new Uint8Array(randomBytes(32))),
    };
    const made: RunMadeHere = {
      kind: 'payroll', seeds, payKey: pay.key, identity, facts, records: pay.records,
      asset: TEST_TOKEN, opensAt: run.opensAt, closesAt: run.closesAt, required: '0',
    };
    const payload = circuits.runPayload(Buffer.from(run.root, 'hex'), 3n, BigInt(run.opensAt), BigInt(run.closesAt), 0n);
    const id = hex(circuits.proposalIdOf(payload, Buffer.from(run.vault, 'hex'), c.salt));
    const order: GovernedCallOrder = {
      circuit: 'propose', run, proposal: id,
      half: {
        assetId: hex(c.asset), assetBlinding: hex(founder.assetBlinding), proposalSalt: hex(c.salt),
        changeAmount: c.amount.toString(), changeBatchDigest: hex(c.batch),
      },
    };
    opened.set(id, {
      chainId: id, digest: hex(payload), vault: run.vault, salt: hex(c.salt), summary: '',
      half: { assetId: hex(c.asset), changeAmount: c.amount.toString(), changeBatchDigest: hex(c.batch) }, made,
    });
    return { order, id, made, payKey: pay.key };
  };
  const ledgerNow = () => accountLedgerOf(chain.contract(company));
  const approvalsOf = (id: string): bigint | null => {
    const l = ledgerNow();
    const key = Buffer.from(id, 'hex');
    return l.approvalCounts.member(key) ? l.approvalCounts.lookup(key) : null;
  };

  beforeEach(async () => {
    setNetworkId(NET as never);
    chain = new Chain();
    asked = [];
    handed = [];
    founder = privateStateFor(1);
    const init = await new (accountModule as any).Contract(witnesses).initialState(
      runtime.createConstructorContext(founder, '0'.repeat(64)), leafOfDevice(founder), COMPANY_LABEL);
    const accountState = L.ContractState.deserialize(init.currentContractState.serialize());
    for (const c of DEPLOYED_CIRCUITS) {
      const op = new L.ContractOperation();
      op.verifierKey = new Uint8Array(readFileSync(new URL(`../managed/keys/${c}.verifier`, import.meta.url)));
      accountState.setOperation(c, op);
    }
    const deploy = new L.ContractDeploy(accountState);
    const seeded = chain.apply(L.Transaction.fromParts(NET, undefined, undefined,
      L.Intent.new(new Date(Date.now() + 600_000)).addDeploy(deploy)));
    if (!seeded.ok) throw new Error(`the company account was not deployed: ${seeded.error}`);
    company = String(deploy.address).toLowerCase();
  });

  it('A RUN IS RAISED FROM THE DEVICE AND THE CHAIN HOLDS IT UNDER THE ID ITS OWN PARTS MAKE', async () => {
    const run = aRun(1);
    /* A run is raised only against the pay-record key the company committed to on the chain. */
    await commitThePayKey(builder(), aRun(0).payKey);
    const built = await builder().governedCall({ account: company, order: run.order, material: keyringOf(founder), chain: callState() });
    /* RED WHEN: the builder drops the salt or the vault from the call, or builds another branch - the id then differs. */
    expect(send(built.tx)).toEqual({ ok: true, error: '' });
    expect(ledgerNow().openProposals.member(Buffer.from(run.id, 'hex'))).toBe(true);
    expect(approvalsOf(run.id)).toBe(0n);
  });

  it('AND IS APPROVED FROM THE DEVICE: THE CHAIN COUNTS ONE APPROVAL, AND A SECOND ONE FROM THE SAME SIGNER IS REFUSED', async () => {
    const run = aRun(2);
    const b = builder();
    await commitThePayKey(b, aRun(0).payKey);
    expect(send((await b.governedCall({ account: company, order: run.order, material: keyringOf(founder), chain: callState() })).tx).ok).toBe(true);
    const approve: GovernedCallOrder = { circuit: 'approve', proposal: run.id };
    /* RED WHEN: the approval is built from anything but this signer's own three, or names another round. */
    expect(send((await b.governedCall({ account: company, order: approve, material: keyringOf(founder), chain: callState() })).tx))
      .toEqual({ ok: true, error: '' });
    expect(approvalsOf(run.id)).toBe(1n);
    /* The contract's own duplicate guard, reached from the device's own build: a nullifier this signer already spent. */
    await expect(b.governedCall({ account: company, order: approve, material: keyringOf(founder), chain: callState() }))
      .rejects.toThrow(/already approved/u);
  });

  it('AN APPROVAL IS NOT BUILT FOR A RUN OTHER THAN THE ONE THIS DEVICE MADE AGAIN, READ AGAINST THE CHAIN ITSELF', async () => {
    const run = aRun(5);
    const b = builder();
    await commitThePayKey(b, aRun(0).payKey);
    expect(send((await b.governedCall({ account: company, order: run.order, material: keyringOf(founder), chain: callState() })).tx).ok).toBe(true);
    const approve: GovernedCallOrder = { circuit: 'approve', proposal: run.id };
    const honest = opened.get(run.id)!;
    for (const [why, made, says] of [
      ['another amount', { ...run.made, facts: run.made.facts.map((f, i) => (i === 0 ? { ...f, amount: f.amount + 1n } : f)) }, /is not what this device rebuilt/u],
      ['a pay-record key the company did not commit to', { ...run.made, payKey: '5b'.repeat(32) }, /pay-record key other than the one the company committed to/u],
    ] as Array<[string, RunMadeHere, RegExp]>) {
      opened.set(run.id, { ...honest, made });
      /* RED WHEN: the worker proves an approval for a run it did not make again, or with a pay-record key the chain does not hold. */
      await expect(b.governedCall({ account: company, order: approve, material: keyringOf(founder), chain: callState() }), why).rejects.toThrow(says);
    }
    expect(approvalsOf(run.id)).toBe(0n);
    opened.set(run.id, honest);
    /* RED WHEN: the run this device made, read against the real chain, is refused. */
    expect(send((await b.governedCall({ account: company, order: approve, material: keyringOf(founder), chain: callState() })).tx).ok).toBe(true);
    expect(approvalsOf(run.id)).toBe(1n);
  });

  it('FOUR GOVERNED CALLS IN A ROW THROUGH ONE CLIENT EACH LAND AS THEMSELVES: nothing one call staged is seen, or put back, by the next', async () => {
    const b = builder();
    await commitThePayKey(b, aRun(0).payKey);
    /* The four counted below are the run's: the pay-record key's three calls came before. */
    handed.length = 0;
    const first = aRun(3);
    const second = aRun(4);
    for (const order of [first.order, { circuit: 'approve', proposal: first.id } as const,
      second.order, { circuit: 'approve', proposal: second.id } as const]) {
      const built = await b.governedCall({ account: company, order, material: keyringOf(founder), chain: callState() });
      expect(send(built.tx).ok).toBe(true);
    }
    /* RED WHEN: a record is kept between calls and the second raise is built with the first's salt - its id is then wrong. */
    expect(first.id).not.toBe(second.id);
    expect(approvalsOf(first.id)).toBe(1n);
    expect(approvalsOf(second.id)).toBe(1n);
    /* Four calls, four records, none of them the same object. */
    expect(handed).toHaveLength(4);
    expect(new Set(handed).size).toBe(4);
  });

  it('REACHES ONE CALL BUILDER AND NO PRIVATE-STATE STORE, AND OVERWRITES THE SIGNER\'S THREE WHEN THE CALL IS DONE', async () => {
    const run = aRun(5);
    /* A run is raised only against the pay-record key the company committed to on the chain. */
    await commitThePayKey(builder(), aRun(0).payKey);
    asked = [];
    await builder().governedCall({ account: company, order: run.order, material: keyringOf(founder), chain: callState() });
    /* RED WHEN: the worker is given, or reaches for, any other entry point of the package. */
    expect(new Set(asked)).toEqual(new Set(['createUnprovenCallTxFromInitialStates']));
    /* RED WHEN: the record keeps the signer's key after the call. */
    const [record] = handed;
    expect(record!.secretKey.every((x) => x === 0)).toBe(true);
    expect(record!.blinding.every((x) => x === 0)).toBe(true);
    expect(record!.scope.every((x) => x === 0)).toBe(true);
    /* And the keyring's own values are untouched: the record was composed from copies. */
    expect(keyringOf(founder).signingSecret).not.toBe('00'.repeat(32));
  });

  it('KEY MATERIAL SAVED BEFORE SCOPES WERE RECORDED IS REFUSED BY NAME, BEFORE ANYTHING IS BUILT', async () => {
    const run = aRun(6);
    /* A run is raised only against the pay-record key the company committed to on the chain. */
    await commitThePayKey(builder(), aRun(0).payKey);
    handed.length = 0;
    const { scope: _none, ...beforeScopes } = keyringOf(founder);
    /* RED WHEN: the absence is read as some value - the build is then reached and fails as "not a signer", or worse, lands. */
    await expect(builder().governedCall({ account: company, order: run.order, material: beforeScopes, chain: callState() }))
      .rejects.toThrow(/written before vault scopes were recorded/u);
    expect(handed).toHaveLength(0);
  });

  it('AND A SCOPE READ AS THIRTY-TWO ZERO BYTES IS NOT A SIGNER: this is the failure the refusal above stands in front of', async () => {
    const run = aRun(7);
    /* A run is raised only against the pay-record key the company committed to on the chain. */
    await commitThePayKey(builder(), aRun(0).payKey);
    /* RED WHEN: a zero scope proves membership - the refusal above would then be protecting nothing. */
    await expect(builder().governedCall({
      account: company, order: run.order, material: { ...keyringOf(founder), scope: '00'.repeat(32) }, chain: callState(),
    })).rejects.toThrow(/not a signer/u);
    expect(ledgerNow().openProposals.member(Buffer.from(run.id, 'hex'))).toBe(false);
  });

  it('SOMEBODY WHO IS NOT A SIGNER CANNOT RAISE, AND A PROPOSAL THAT IS NOT OPEN CANNOT BE APPROVED', async () => {
    const run = aRun(8);
    /* A run is raised only against the pay-record key the company committed to on the chain. */
    await commitThePayKey(builder(), aRun(0).payKey);
    await expect(builder().governedCall({
      account: company, order: run.order, material: keyringOf(privateStateFor(9)), chain: callState(),
    })).rejects.toThrow(/not a signer/u);
    await expect(builder().governedCall({
      account: company, order: { circuit: 'approve', proposal: run.id }, material: keyringOf(founder), chain: callState(),
    })).rejects.toThrow(/no open proposal/u);
  });
});
