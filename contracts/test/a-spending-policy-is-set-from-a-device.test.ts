/**
 * **A VAULT'S SPENDING POLICY IS SET FROM A SIGNER'S DEVICE, A SECOND SIGNER'S
 * DEVICE OPENS IT, AND THE APPROVALS A POLICY CHANGE NEEDS ARE SET THE SAME WAY;
 * AN APPROVED RUN IS CHARGED TO ITS PERIOD ON A DEVICE, AGAINST THE PERIOD'S
 * RUNNING TOTAL A DEVICE THAT CHARGED NOTHING WORKS OUT AGAIN.**
 *
 * What is real here:
 *   · the chain is the ledger's own state machine, applying each transaction as
 *     its own block, holding the compiled company account;
 *   · every raise, approval and carrying out is made by the page's own device
 *     functions (`setSpendingPolicyOnDevice`, `setPolicyBarOnDevice`,
 *     `spendingPolicyHere`) and built by the device's own builder, reached
 *     through the page's own worker client and the worker's own handler;
 *   · the policy's record is sealed, signed, filed and opened by the product's
 *     own functions, and each signer opens it with their own wrapping secret.
 *
 * **WHAT STANDS IN, NAMED HERE SO NOTHING RELIES ON IT:**
 *   · **no proof is made.** The call reaches the chain unproven and the ledger
 *     is told not to check proofs;
 *   · the company's service is an object in this file: it applies what a device
 *     sends to the chain and keeps the proposals and the policy records in
 *     memory. Its routes are driven in `src/server/`;
 *   · what the chain holds under a key is read straight off the chain's state,
 *     where a device reads it through the indexer the person's own wallet names;
 *   · the company's directory and its founding state are written here, not
 *     filed through the service: the founding seat is the account's own deploy's;
 *   · **a run is raised and approved by calls this file builds itself** with each
 *     signer's whole private state, not by the device's raise: what is tested is
 *     the charge of an approved run, built by the device's builder through the
 *     worker, and the account's state it is built on is read straight off the
 *     chain, where a device reads it at one block through the indexer the
 *     person's own wallet names.
 */
import { describe, it, expect, beforeEach } from 'vitest';
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
import type { PolicyGovernanceDoors } from 'vaults-web-shared/spending-policy-here.js';
import type { GovernedCallService } from 'vaults-web-shared/governed-call-on-device.js';
import { setSpendingPolicyOnDevice, setPolicyBarOnDevice, spendingPolicyHere } from 'vaults-web-shared/spending-policy-here.js';
import type { CompanyRecordsHere } from 'vaults-web-shared/run-rebuilt-here.js';
import { refusalForProven } from '../../src/wiring/proven-submission.js';
import { canonical, newWrappingKeypair, seal, signingPublicKeyOf } from '../../src/core/crypto.js';
import { signedFoundingState } from '../../src/core/founding-state.js';
import { newProposalId } from '../../src/core/proposal-filing.js';
import type { SealedProposal } from '../../src/core/types.js';
import { signCompanyFiling, type SealedCompanyRecord } from '../../src/midnight/sealed-record-wire.js';
import { policyOpeningFromWire, sealSpendingPolicy } from '../../src/midnight/spending-policy-record.js';
import { TEST_TOKEN } from '../../src/testing/assets.js';
import { assetIdHex } from '../../src/core/assets.js';
import { sumTreeOfLeaves } from '../../src/midnight/payout-tree.js';
import { periodOf, type PolicyOpeningOnTheWire } from '../../src/midnight/spending-policy-record.js';
import type { RunToChargeOnTheWire, RunTreeOnTheWire } from 'vaults-web-shared/run-charge-builder.js';
import { keysOnDisk } from './keys-on-disk.js';

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

const KEYS = keysOnDisk();
if (!KEYS.ok) console.log(`  NOT CHECKED HERE: no spending policy was set from a device, because ${KEYS.why}`);

/** Four bands - up to 1,000 at one approval, up to 10,000 at two - a limit of 50,000 a period, periods of thirty days. */
const TERMS = {
  bands: [
    { ceiling: '1000', approvals: '1' }, { ceiling: '10000', approvals: '2' },
    { ceiling: '100000', approvals: '2' }, { ceiling: '1000000', approvals: '2' },
  ],
  periodLimit: '50000', periodStart: '1767225600', periodLength: String(30 * 24 * 3600),
};
const VAULT = 'fa'.repeat(32);

describe.skipIf(!KEYS.ok)('A VAULT\'S SPENDING POLICY, SET FROM SIGNERS\' DEVICES [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  let chain: Chain;
  let company: string;
  let founder: AccountPrivateState;
  let blake: AccountPrivateState;
  let proposals: SealedProposal[];
  let policies: SealedCompanyRecord[];
  const viewingKey = 'cd'.repeat(32);
  const wrapping = { ada: newWrappingKeypair(), blake: newWrappingKeypair() };

  const accountZk = new NodeZkConfigProvider(new URL('../managed', import.meta.url).pathname);
  const accountCompiled = CompiledContract.make('ConfidentialAccount', (accountModule as any).Contract).pipe(
    CompiledContract.withWitnesses(witnesses as never));
  const builder = () => {
    const deps = async () => ({
      ledger: L, runtimeState: (runtime as any).ContractState,
      contracts, accountCompiled, accountZkConfig: accountZk, accountPure: circuits, accountLedger: (accountModule as any).ledger,
      prove: async (unproven: any) => unproven,
    });
    const listeners: Array<(e: { data: unknown }) => void> = [];
    return vaultBuilderOver({
      addEventListener: (_t, l) => { listeners.push(l); },
      postMessage: (message) => {
        void answerVaultAsk(deps as never, message as never).then(
          (a: VaultAnswer) => listeners.forEach((l) => l({ data: a })),
          (e: Error) => listeners.forEach((l) => l({ data: { id: (message as { id: number }).id, ok: false, error: e.message } })));
      },
    }, NET);
  };

  const ledgerNow = () => accountLedgerOf(chain.contract(company));
  const callState = (): AccountCallChainOnTheWire => ({
    blockHash: '00'.repeat(32),
    accountState: b64(chain.contract(company).serialize()),
    parameters: b64(L.LedgerParameters.initialParameters().serialize()),
  });
  const send = (tx: string): void => {
    const read = L.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', Buffer.from(tx, 'base64'));
    const refusal = refusalForProven(read, company);
    if (refusal !== null) throw new Error(`the service refused it: ${refusal}`);
    const applied = chain.apply(read);
    if (!applied.ok) throw new Error(`the chain refused it: ${applied.error}`);
  };
  const keyringOf = (s: AccountPrivateState): SignerMaterial => ({ signingSecret: hex(s.secretKey), blinding: hex(s.blinding), scope: hex(s.scope) });
  const roles = (key: string): string | null => {
    const k = Buffer.from(key, 'hex');
    return ledgerNow().signerRoles.member(k) ? hex(ledgerNow().signerRoles.lookup(k)) : null;
  };
  const barOnChain = (key: string): bigint | null => {
    const k = Buffer.from(key, 'hex');
    return ledgerNow().thresholds.member(k) ? ledgerNow().thresholds.lookup(k) : null;
  };

  /* ── a governance call made directly, for what this file sets up rather than tests ── */
  const directly = async (who: AccountPrivateState, order: GovernedCallOrder, opened: OpenedRound) =>
    send((await builder().governedCall({ account: company, order, material: keyringOf(who), chain: callState(), opened })).tx);
  const raisedAndCarried = async (
    who: AccountPrivateState, governance: any, payload: Uint8Array, seed: number, carry: ((id: string, salt: string) => GovernedCallOrder) | null,
  ) => {
    const c = change(0n, seed);
    const id = hex(circuits.proposalIdOf(payload, circuits.noVault(), c.salt));
    const opened: OpenedRound = {
      chainId: id, digest: hex(payload), vault: hex(circuits.noVault()), salt: hex(c.salt), summary: '', governance,
      half: { assetId: hex(c.asset), changeAmount: '0', changeBatchDigest: hex(c.batch) },
    };
    await directly(who, {
      circuit: 'propose', ...(governance.kind === 'adopt-vault' ? { adoption: governance } : { governance }), proposal: id,
      half: { assetId: hex(c.asset), assetBlinding: hex(who.assetBlinding), proposalSalt: hex(c.salt), changeAmount: '0', changeBatchDigest: hex(c.batch) },
    } as GovernedCallOrder, opened);
    await directly(who, { circuit: 'approve', proposal: id }, opened);
    if (carry === null) return { id, salt: hex(c.salt), opened };
    await directly(who, carry(id, hex(c.salt)), opened);
    return { id, salt: hex(c.salt), opened };
  };

  /* ── the company's service, kept in memory: what a device sends is applied to the chain ── */
  const round = (p: SealedProposal) => ({
    id: p.id, chainId: p.chainId, status: p.status, approvalCount: p.approvalCount, ...(p.raisedAt ? { raisedAt: p.raisedAt } : {}),
  });
  const counted = (p: SealedProposal): SealedProposal => {
    const k = Buffer.from(p.chainId, 'hex');
    const open = ledgerNow().openProposals.member(k);
    const count = ledgerNow().approvalCounts.member(k) ? Number(ledgerNow().approvalCounts.lookup(k)) : 0;
    const next = { ...p, approvalCount: count, status: (open || !p.raisedAt ? 'open' : 'executed') as SealedProposal['status'] };
    proposals = proposals.map((x) => (x.id === p.id ? next : x));
    return next;
  };
  const byId = (id: string) => counted(proposals.find((p) => p.id === id)!);
  const service: GovernedCallService = {
    callState: async () => ({ ...callState(), account: company }),
    send: async () => { throw new Error('every proposal here is filed with its raise'); },
    approve: async (id, { tx }) => { send(tx); return round(byId(id)); },
    standing: async (id) => round(byId(id)),
    carry: async (id, { tx }) => { send(tx); return round(byId(id)); },
    file: async (_account, body) => {
      send(body.tx);
      const f = body.proposal;
      const p: SealedProposal = {
        id: f.id, accountId: company, status: 'open', createdAt: f.createdAt, digest: f.digest, chainId: f.chainId,
        approvalCount: 0, raisedAt: new Date().toISOString(), keyEpoch: f.keyEpoch, filedBy: f.filedBy, sealed: f.sealed,
      } as SealedProposal;
      proposals.push(p);
      return round(counted(p));
    },
    bars: async () => ({
      threshold: Number(ledgerNow().threshold),
      vaultThresholds: [...ledgerNow().thresholds].map(([k, v]: [Uint8Array, bigint]) => ({ vault: hex(k), threshold: Number(v) })),
    }),
    sealedProposals: async () => proposals.map(counted),
  };

  /* ── the company's records, as each signer's device reads them ── */
  const seatOf = (s: AccountPrivateState, person: 'ada' | 'blake') => ({
    seat: hex(leafOfDevice(s)), person, signingKey: signingPublicKeyOf(hex(s.secretKey)), wrappingKey: wrapping[person].publicKey,
    committeeKey: { tag: 'ed25519', value: person.repeat(8) }, role: 'admin' as const, retired: null,
  });
  const recordsFor = (who: AccountPrivateState, person: 'ada' | 'blake'): CompanyRecordsHere => {
    const seats = [seatOf(founder, 'ada'), seatOf(blake, 'blake')];
    const state = signedFoundingState(company, {
      keyEpoch: 0,
      sealed: seal(canonical({ state: {}, blinding: { assetBlinding: hex(founder.assetBlinding), payoutSeeds: [], payRecordKey: 'ab'.repeat(32) } }), viewingKey),
    } as never, hex(founder.secretKey));
    const notHere = async () => { throw new Error('not read here'); };
    return {
      directory: async () => ({
        dir: { company, version: 1, seats },
        holders: {
          committee: seats.map((s) => s.committeeKey), seats: seats.map((s) => s.seat), approvals: 1, adoptedVaults: [VAULT],
          founding: seats[0]!.seat, foundingCommittee: [seats[0]!.committeeKey], account: company,
        } as never,
        another: new Set(),
      }) as never,
      people: notHere as never, runs: notHere as never, policy: notHere as never,
      state: async (id) => (id === '0' ? state : null),
      proposals: async () => proposals,
      payments: { paidOnceOf: () => { throw new Error('not read here'); }, paidMovementOf: () => { throw new Error('not read here'); }, read: notHere as never },
      spendingPolicies: {
        versions: async (id) => policies.filter((r) => r.id === id),
        file: async (rec) => {
          const newest = policies.filter((r) => r.id === rec.id).reduce((n, r) => Math.max(n, r.version), 0);
          if (rec.version !== newest + 1) throw new Error(`version ${rec.version} is not the next`);
          policies.push(signCompanyFiling(rec, hex(who.secretKey)));
        },
        me: { signerId: hex(leafOfDevice(who)), wrappingSecret: wrapping[person].secret },
        keys: (input) => builder().spendingPolicyKeys(input),
        /* STAND-IN, NAMED: the wallet's read of the account's map of roles, answered from this file's ledger directly. */
        onChain: async (keys) => new Map(keys.map((k) => [k, roles(k)])),
      },
    };
  };
  const doorsFor = (who: AccountPrivateState, person: 'ada' | 'blake'): PolicyGovernanceDoors => ({
    service, builder: builder(), material: keyringOf(who), accountId: company, records: recordsFor(who, person),
    filing: { seat: hex(leafOfDevice(who)), keyEpoch: 0, salt: () => hex(crypto.getRandomValues(new Uint8Array(32))), newId: () => newProposalId() },
    approvers: async () => { throw new Error('a spending policy changes no seat and no vault\'s threshold'); },
    vaultName: () => 'the vault',
    sleep: async () => {}, waitMs: 10, everyMs: 1,
  });
  const readBy = (who: AccountPrivateState, person: 'ada' | 'blake') =>
    spendingPolicyHere({ records: recordsFor(who, person), accountId: company, viewingKey }, { vault: VAULT, asset: TEST_TOKEN });

  beforeEach(async () => {
    setNetworkId(NET as never);
    chain = new Chain();
    proposals = [];
    policies = [];
    founder = privateStateFor(1);
    blake = privateStateFor(2);
    const init = await new (accountModule as any).Contract(witnesses).initialState(
      runtime.createConstructorContext(founder, '0'.repeat(64)), leafOfDevice(founder), COMPANY_LABEL);
    const accountState = L.ContractState.deserialize(init.currentContractState.serialize());
    for (const c of DEPLOYED_CIRCUITS) {
      const op = new L.ContractOperation();
      op.verifierKey = new Uint8Array(readFileSync(new URL(`../managed/keys/${c}.verifier`, import.meta.url)));
      accountState.setOperation(c, op);
    }
    const deploy = new L.ContractDeploy(accountState);
    const seeded = chain.apply(L.Transaction.fromParts(NET, undefined, undefined, L.Intent.new(new Date(Date.now() + 600_000)).addDeploy(deploy)));
    if (!seeded.ok) throw new Error(`the company account was not deployed: ${seeded.error}`);
    company = String(deploy.address).toLowerCase();
    /* A second signer, seated at a threshold of one, and the vault the policy is for, adopted. */
    const leaf = hex(leafOfDevice(blake));
    await raisedAndCarried(founder, { kind: 'add-signer', leaf }, circuits.signerAddPayload(leafOfDevice(blake)), 11,
      (id, salt) => ({ circuit: 'amendSigner', leaf, proposal: id, proposalSalt: salt }));
    await raisedAndCarried(founder, { kind: 'adopt-vault', vault: VAULT }, circuits.adoptVaultPayload(Buffer.from(VAULT, 'hex')), 12,
      (id, salt) => ({ circuit: 'adopt', vault: VAULT, proposal: id, proposalSalt: salt }));
  });

  it('A POLICY IS SET FROM ONE SIGNER\'S DEVICE, AND A SECOND SIGNER\'S DEVICE OPENS IT FROM THE COMPANY\'S RECORDS', async () => {
    expect(await readBy(blake, 'blake')).toMatchObject({ state: 'none' });
    const set = await setSpendingPolicyOnDevice(doorsFor(founder, 'ada'), { viewingKey, vault: VAULT, asset: TEST_TOKEN, terms: TERMS });
    /* RED WHEN: setPolicy cannot be raised, approved or carried out from a device - no vault ever has a policy. */
    expect(set.state).toBe('done');
    const read = await readBy(blake, 'blake');
    /* RED WHEN: the policy's record is not sealed to every signer - a second device cannot open the policy it must pay under. */
    expect(read.state).toBe('set');
    if (read.state !== 'set') return;
    expect(read.opening.terms).toEqual(TERMS);
    /* RED WHEN: the opening a second device takes is not the one whose commitment the chain holds. */
    expect(hex(circuits.policyCommitmentOf(policyOpeningFromWire(read.opening)))).toBe(roles(read.keys.policyKey));
    expect(roles(read.keys.onKey)).not.toBeNull();
    /* Setting a policy raises the approvals a policy change needs to its highest band. */
    expect(barOnChain(read.keys.barKey)).toBe(2n);
  });

  it('A VERSION OF THE RECORD THAT DOES NOT OPEN WHAT THE CHAIN HOLDS IS PASSED OVER, AND WITH NONE THAT DOES THE POLICY IS REFUSED', async () => {
    await setSpendingPolicyOnDevice(doorsFor(founder, 'ada'), { viewingKey, vault: VAULT, asset: TEST_TOKEN, terms: TERMS });
    const real = await readBy(blake, 'blake');
    if (real.state !== 'set') throw new Error('the policy was not set');
    /* A newer version, signed by a seat, with a lower limit: the chain does not hold its commitment. */
    const forged = sealSpendingPolicy({
      company, id: real.keys.policyKey, version: 2, keyEpoch: 0,
      secrets: { vault: VAULT, asset: TEST_TOKEN, opening: { terms: { ...TERMS, periodLimit: '1' }, blinding: 'ee'.repeat(32) } },
      signers: [{ id: hex(leafOfDevice(founder)), wrappingPublicKey: wrapping.ada.publicKey }, { id: hex(leafOfDevice(blake)), wrappingPublicKey: wrapping.blake.publicKey }],
    });
    policies.push(signCompanyFiling(forged, hex(founder.secretKey)));
    const again = await readBy(blake, 'blake');
    /* RED WHEN: the newest version is believed for what it says - a device holds a policy the chain does not. */
    expect(again).toMatchObject({ state: 'set', version: 1 });
    if (again.state === 'set') expect(again.opening.terms.periodLimit).toBe('50000');
    /* With only the version the chain does not hold, nothing is guessed. */
    policies = policies.filter((r) => r.version === 2);
    /* RED WHEN: a record that opens no commitment the chain holds is taken as the vault's policy. */
    await expect(readBy(blake, 'blake')).rejects.toThrow(/None of the company's records of this vault's spending policy opens the policy the chain holds/u);
  });

  it('THE APPROVALS A POLICY CHANGE NEEDS ARE SET FROM A DEVICE, AND THE NEXT POLICY THEN WAITS FOR THEM', async () => {
    const barKey = await builder().policyBarKey();
    const bar = await setPolicyBarOnDevice(doorsFor(founder, 'ada'), { viewingKey, newBar: 2, seated: 2 });
    /* RED WHEN: setPolicyBar cannot be raised, approved or carried out from a device. */
    expect(bar.state).toBe('done');
    expect(barOnChain(barKey)).toBe(2n);
    const first = await setSpendingPolicyOnDevice(doorsFor(founder, 'ada'), { viewingKey, vault: VAULT, asset: TEST_TOKEN, terms: TERMS });
    /* RED WHEN: a policy change is carried out at the account's threshold of one rather than the bar of two. */
    expect(first.state).toBe('waiting-for-approvals');
    expect((await readBy(blake, 'blake')).state).toBe('none');
    /* The second signer's device sets the same terms: it opens the policy filed for them, approves it and carries it out. */
    const second = await setSpendingPolicyOnDevice(doorsFor(blake, 'blake'), { viewingKey, vault: VAULT, asset: TEST_TOKEN, terms: TERMS });
    expect(second.state).toBe('done');
    expect(policies).toHaveLength(1);
    const read = await readBy(founder, 'ada');
    expect(read).toMatchObject({ state: 'set', version: 1 });
  });

  it('THE WORKER SAYS THE APPROVALS A RUN\'S BAND NEEDS BY THE CONTRACT\'S OWN FUNCTION, AND NONE FOR A TOTAL ABOVE EVERY BAND', async () => {
    const opening = { terms: TERMS, blinding: 'b1'.repeat(32) };
    const ask = (total?: string) => builder().spendingPolicyKeys({
      vault: VAULT, asset: TEST_TOKEN, assetBlinding: hex(founder.assetBlinding), policy: opening, ...(total === undefined ? {} : { total }),
    });
    /* RED WHEN: a total is put in another band than the contract's - at its ceiling, just over it, or in the last band. */
    expect((await ask('1000')).required).toBe('1');
    expect((await ask('1001')).required).toBe('2');
    expect((await ask('1000000')).required).toBe('2');
    expect((await ask('1000')).required).toBe(String(circuits.bandApprovals(policyOpeningFromWire(opening).terms.bands, 1000n)));
    /* RED WHEN: a total above every band is given any number of approvals - the chain would never charge it. */
    expect((await ask('1000001')).required).toBeNull();
    /* RED WHEN: a band is worked out when no total was asked about. */
    expect('required' in (await ask())).toBe(false);
  });

  it('A DEVICE ASKED TO CARRY OUT A POLICY WITH ANY OPENING BUT THE ONE APPROVED BUILDS NOTHING', async () => {
    const opening = { terms: TERMS, blinding: 'b1'.repeat(32) };
    const keys = await builder().spendingPolicyKeys({ vault: VAULT, asset: TEST_TOKEN, assetBlinding: hex(founder.assetBlinding), policy: opening });
    const governance = { kind: 'spending-policy', vault: VAULT, assetKey: keys.assetKey, commitment: keys.commitment! };
    const payload = circuits.setPolicyPayload(Buffer.from(VAULT, 'hex'), Buffer.from(keys.assetKey, 'hex'), Buffer.from(keys.commitment!, 'hex'));
    const r = await raisedAndCarried(founder, governance, payload, 31, null);
    const order = (policy: typeof opening, assetBlinding = hex(founder.assetBlinding)): GovernedCallOrder => ({
      circuit: 'setPolicy', vault: VAULT, commitment: keys.commitment!, proposal: r.id, proposalSalt: r.salt,
      asset: TEST_TOKEN, assetBlinding, policy,
    });
    /* RED WHEN: the opening carried out is not checked against the commitment approved - the chain would refuse after a fee. */
    await expect(directly(founder, order({ terms: { ...TERMS, periodLimit: '1' }, blinding: opening.blinding }), r.opened))
      .rejects.toThrow(/^the spending policy the service sent to this device does not match the company's own record/u);
    /* RED WHEN: the currency's key is not made again from what the device is handed. */
    await expect(directly(founder, order(opening, 'bb'.repeat(32)), r.opened))
      .rejects.toThrow(/^the spending policy the service sent to this device does not match the company's own record/u);
    /* RED WHEN: a policy is carried out on another vault, or under another commitment, than the one approved. */
    await expect(directly(founder, { ...order(opening), vault: 'fb'.repeat(32) } as GovernedCallOrder, r.opened))
      .rejects.toThrow(/^the spending policy the service sent to this device does not match the company's own record/u);
    await expect(directly(founder, { ...order(opening), commitment: 'cc'.repeat(32) } as GovernedCallOrder, r.opened))
      .rejects.toThrow(/^the spending policy the service sent to this device does not match the company's own record/u);
    expect(roles(keys.policyKey)).toBeNull();
    await directly(founder, order(opening), r.opened);
    expect(roles(keys.policyKey)).toBe(keys.commitment);
  });

  it('A DEVICE CARRIES OUT ONLY THE APPROVALS A POLICY CHANGE NEEDS THAT WERE APPROVED', async () => {
    const r = await raisedAndCarried(founder, { kind: 'policy-bar', bar: '2' }, circuits.setPolicyBarPayload(2n), 41, null);
    const barKey = await builder().policyBarKey();
    /* RED WHEN: a bar other than the one approved is carried out. */
    await expect(directly(founder, { circuit: 'setPolicyBar', bar: '1', proposal: r.id, proposalSalt: r.salt }, r.opened))
      .rejects.toThrow(/^the number of approvals a change to a spending policy needs the service sent to this device does not match/u);
    expect(barOnChain(barKey)).toBeNull();
    await directly(founder, { circuit: 'setPolicyBar', bar: '2', proposal: r.id, proposalSalt: r.salt }, r.opened);
    expect(barOnChain(barKey)).toBe(2n);
  });

  it('A DEVICE SETTING ONE POLICY OR BAR NEVER APPROVES ANOTHER THAT IS WAITING', async () => {
    expect((await setPolicyBarOnDevice(doorsFor(founder, 'ada'), { viewingKey, newBar: 2, seated: 2 })).state).toBe('done');
    const a = await setSpendingPolicyOnDevice(doorsFor(founder, 'ada'), { viewingKey, vault: VAULT, asset: TEST_TOKEN, terms: TERMS });
    expect(a.state).toBe('waiting-for-approvals');
    const b = await setSpendingPolicyOnDevice(doorsFor(blake, 'blake'), { viewingKey, vault: VAULT, asset: TEST_TOKEN, terms: { ...TERMS, periodLimit: '60000' } });
    /* RED WHEN: a device asked for one policy approves another waiting for the same vault - an approval for terms nobody on it chose. */
    expect(b.state).toBe('waiting-for-approvals');
    if (a.state !== 'waiting-for-approvals' || b.state !== 'waiting-for-approvals') return;
    expect(b.round.id).not.toBe(a.round.id);
    expect((await service.standing(a.round.id)).approvalCount).toBe(1);
    const lower = await setPolicyBarOnDevice(doorsFor(founder, 'ada'), { viewingKey, newBar: 1, seated: 2 });
    const same = await setPolicyBarOnDevice(doorsFor(blake, 'blake'), { viewingKey, newBar: 2, seated: 2 });
    /* RED WHEN: a device asked for one bar approves another bar waiting. */
    expect([lower.state, same.state]).toEqual(['waiting-for-approvals', 'waiting-for-approvals']);
    if (lower.state !== 'waiting-for-approvals' || same.state !== 'waiting-for-approvals') return;
    expect(same.round.id).not.toBe(lower.round.id);
    expect((await service.standing(lower.round.id)).approvalCount).toBe(1);
  });
  /* ── a run raised and approved on the chain, for the charge to be tested on ── */
  const ASSET = assetIdHex(TEST_TOKEN).toLowerCase();
  const callDirectly = async (who: AccountPrivateState, circuitId: string, args: unknown[], extra: Partial<AccountPrivateState> = {}) => {
    const keys = L.ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(7));
    const built = await (contracts as any).createUnprovenCallTxFromInitialStates(accountZk, {
      compiledContract: accountCompiled, circuitId, contractAddress: company, coinPublicKey: keys.coinPublicKey,
      initialContractState: (runtime as any).ContractState.deserialize(chain.contract(company).serialize()),
      initialZswapChainState: new L.ZswapChainState(), ledgerParameters: L.LedgerParameters.initialParameters(),
      initialPrivateState: { ...who, ...extra }, args,
    }, keys.encryptionPublicKey);
    send(b64(built.private.unprovenTx.serialize()));
  };
  /*
   * The policy a run is charged under starts its first period a day before now, so a run's window - the minute
   * before now to an hour after - lies inside one period whenever this file runs, never across a boundary.
   */
  const CHARGED_TERMS = { ...TERMS, periodStart: String(Math.floor(Date.now() / 1000) - 24 * 3600) };
  const windowNow = () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    return { opensAt: now - 60n, closesAt: now + 3600n };
  };
  const raiseARun = async (amounts: bigint[], seed: number, approvers: AccountPrivateState[], required: bigint) => {
    const leaves = amounts.map((_, i) => hex(Uint8Array.from({ length: 32 }, (_, j) => (seed * 31 + i * 7 + j) & 0xff)));
    const tree = sumTreeOfLeaves(leaves as never, amounts, ASSET as never);
    const w = windowNow();
    const c = change(0n, seed);
    const root = Buffer.from(tree.root, 'hex');
    const vault = Buffer.from(VAULT, 'hex');
    const payload = circuits.runPayload(root, BigInt(leaves.length), w.opensAt, w.closesAt, required);
    const id = circuits.proposalIdOf(payload, vault, c.salt);
    await callDirectly(founder, 'propose', [new Uint8Array(32), root, BigInt(leaves.length), w.opensAt, w.closesAt, required, true, vault], {
      assetId: c.asset, assetBlinding: founder.assetBlinding, proposalSalt: c.salt, changeAmount: 0n, changeBatchDigest: c.batch,
    });
    for (const who of approvers) {
      await callDirectly(who, 'approve', [id], { runOpenings: { [hex(id)]: { payload, vault, salt: c.salt } } });
    }
    const run: RunToChargeOnTheWire = {
      proposal: hex(id), vault: VAULT, salt: hex(c.salt), required: required.toString(), opensAt: w.opensAt.toString(), closesAt: w.closesAt.toString(),
      asset: ASSET, assetBlinding: hex(founder.assetBlinding), policy: { terms: CHARGED_TERMS, blinding: '' }, root: tree.root, leaves,
      amounts: amounts.map(String),
    };
    return { run, tree: { root: tree.root, leaves, amounts: amounts.map(String) } as RunTreeOnTheWire, total: tree.total };
  };
  /** The policy set from Ada's device, as Blake's device opens it from the company's records. */
  const policySet = async () => {
    expect((await setSpendingPolicyOnDevice(doorsFor(founder, 'ada'), { viewingKey, vault: VAULT, asset: TEST_TOKEN, terms: CHARGED_TERMS })).state).toBe('done');
    const read = await readBy(blake, 'blake');
    if (read.state !== 'set') throw new Error('the policy was not set');
    return read;
  };
  const opened = (run: RunToChargeOnTheWire, opening: PolicyOpeningOnTheWire): RunToChargeOnTheWire => ({ ...run, policy: opening });
  const charge = (run: RunToChargeOnTheWire, runs: RunTreeOnTheWire[]) =>
    builder().clearRun({ account: company, run, runs, chain: { accountState: callState().accountState, parameters: callState().parameters } });
  const totalNow = (opening: PolicyOpeningOnTheWire, period: bigint, runs: RunTreeOnTheWire[]) =>
    builder().periodTotal({ accountState: callState().accountState, total: { vault: VAULT, asset: ASSET, assetBlinding: hex(founder.assetBlinding), policy: opening, period: period.toString(), runs } });
  const clearedOnChain = (id: string) => hex(ledgerNow().openProposals.lookup(Buffer.from(id, 'hex'))) === hex(circuits.clearedMark());
  const standingNow = (proposal: string) => builder().runCharged({ accountState: callState().accountState, proposal });

  it('AN APPROVED RUN IS CHARGED TO ITS PERIOD ON A DEVICE, ONCE, AND A SECOND DEVICE THAT CHARGED NOTHING CHARGES THE NEXT RUN OF THE SAME PERIOD', async () => {
    const policy = await policySet();
    const first = await raiseARun([300n, 400n], 51, [founder], 1n);
    const run1 = opened(first.run, policy.opening);
    const period = periodOf(policyOpeningFromWire(policy.opening), { opensAt: BigInt(run1.opensAt), closesAt: BigInt(run1.closesAt) });
    if (period === null) throw new Error('the run\'s window lies in no single period of the policy, so nothing here can be charged');
    expect(await totalNow(policy.opening, period, [first.tree])).toBe('0');
    const charged = await charge(run1, [first.tree]);
    /* RED WHEN: clearRun cannot be built and proved on a device - a run from a policy vault is never paid. */
    expect(charged.tx).not.toBeNull();
    expect(charged.spent).toBe('0');
    /* RED WHEN: the worker answers a run charged before the chain holds it so - a device then pays it on a read that does not show the charge. */
    expect(await standingNow(run1.proposal)).toBe('open');
    send(charged.tx!);
    expect(clearedOnChain(run1.proposal)).toBe(true);
    /* RED WHEN: the worker does not see the chain's own mark of a charged run - a device that relayed one waits for it for ever. */
    expect(await standingNow(run1.proposal)).toBe('charged');
    /* RED WHEN: a proposal the chain does not hold open is answered as open or charged - a device would wait on a run nothing can charge. */
    expect(await standingNow('0e'.repeat(32))).toBe('not-open');
    /* RED WHEN: a run the chain holds as charged is charged again - a fee for a call the chain refuses. */
    expect(await charge(run1, [first.tree])).toEqual({ tx: null, spent: null });

    /* Blake's device charged nothing and keeps nothing: it works the period's total out again from the chain and the records. */
    const second = await raiseARun([800n], 52, [founder], 1n);
    const run2 = opened(second.run, (await readBy(blake, 'blake') as typeof policy).opening);
    /* RED WHEN: the total is taken from anything but what the chain marks charged and the records say each run paid. */
    expect(await totalNow(policy.opening, period, [first.tree, second.tree])).toBe('700');
    /* RED WHEN: a device short of a charged run's record believes a total the chain does not hold - it is refused, not guessed. */
    await expect(charge(run2, [second.tree])).rejects.toThrow(/do not account for everything the chain has charged to this vault in this period/u);
    /* RED WHEN: a total the chain's commitment does not open is believed - here a record whose amounts are not the ones its root commits to. */
    const lied: RunTreeOnTheWire = { ...first.tree, amounts: ['30', '40'] };
    await expect(totalNow(policy.opening, period, [lied, second.tree])).rejects.toThrow(/do not account for everything/u);
    /* RED WHEN: a run raised twice over the same tree is counted twice. */
    expect(await totalNow(policy.opening, period, [first.tree, first.tree, second.tree])).toBe('700');
    const next = await charge(run2, [first.tree, second.tree]);
    expect(next.spent).toBe('700');
    send(next.tx!);
    expect(clearedOnChain(run2.proposal)).toBe(true);
    expect(await totalNow(policy.opening, period, [first.tree, second.tree])).toBe('1500');
  });

  it('A CHARGE IS REFUSED ON THE DEVICE, BEFORE ANYTHING IS SENT, FOR A RUN NOT ITS PROPOSAL, SHORT OF ITS APPROVALS, OVER THE PERIOD\'S LIMIT, OR AGAINST ANOTHER POLICY', async () => {
    const policy = await policySet();
    const small = await raiseARun([500n], 61, [], 1n);
    const run = opened(small.run, policy.opening);
    /* RED WHEN: the approvals the run is charged with are not the ones its identity was made with. */
    await expect(charge({ ...run, required: '2' }, [small.tree])).rejects.toThrow(/not the ones its proposal was raised with/u);
    /* RED WHEN: a run is charged before it has the approvals it needs - the chain's own refusal, said on the device in its own words. */
    await expect(charge(run, [small.tree])).rejects.toThrow(/could not be charged to its period: not enough approvals yet\. Nothing was proved or sent\.$/u);
    /* RED WHEN: a charge is built against an opening the chain does not hold. */
    await expect(charge({ ...run, policy: { ...policy.opening, blinding: 'ee'.repeat(32) } }, [small.tree])).rejects.toThrow(/not the one the chain holds/u);
    /* A run of 49,700 needs two approvals; with 500 approved before it, it takes the period past its limit of 50,000. */
    await callDirectly(founder, 'approve', [Buffer.from(run.proposal, 'hex')], {
      runOpenings: { [run.proposal]: { payload: circuits.runPayload(Buffer.from(run.root, 'hex'), 1n, BigInt(run.opensAt), BigInt(run.closesAt), 1n), vault: Buffer.from(VAULT, 'hex'), salt: Buffer.from(run.salt, 'hex') } },
    });
    send((await charge(run, [small.tree])).tx!);
    const big = await raiseARun([49_700n], 62, [founder, blake], 2n);
    /* RED WHEN: a run past the period's limit is built and sent - the chain refuses it after a fee. */
    await expect(charge(opened(big.run, policy.opening), [small.tree, big.tree])).rejects.toThrow(/past its limit for the period/u);
    expect(clearedOnChain(big.run.proposal)).toBe(false);
  });
});
