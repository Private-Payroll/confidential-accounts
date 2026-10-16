/**
 * **ONE COMPANY WHOSE SIGNERS CHANGE ON THE CHAIN, OVER REAL HTTP**, for the
 * tests that follow a removal and a seating from the signers' own devices to
 * the chain. Built on `a-company-of-two-seats.test-support.ts` - its directory,
 * records, invitation and people routes and its anchor on the test's chain -
 * with the proposal relays and the roster and vault-key routes mounted beside
 * them. Cy holds a third seat, invited by Ada, and Bo is an admin; Ada's, Bo's
 * and Cy's wallets' records-key statements are in the roster, folded from their
 * own offers.
 *
 * Three pieces are stand-ins, and they are named here:
 *   - **the chain's account**: a map of the proposals it holds open, each with
 *     the signers who approved it, behind the one door a device's proven call
 *     goes through. It does to the test's chain what each call would - a seat
 *     added, a seat taken off - and refuses a change of who is seated below
 *     the seat bar, a removal leaving fewer signers than it, and an approval by
 *     a signer it does not hold. The contract's own circuits are not run;
 *   - **the worker that builds a call**: it asks the questions the worker asks
 *     before it builds, with the contract's own pure circuits, and hands the
 *     order through as the transaction;
 *   - **the service's list of a company's proposals and the account's call
 *     state**: read straight from the store, and fixed.
 */
import { beforeAll, expect } from 'vitest';
import type express from 'express';
import { identityFromSecret } from 'midnight-identity';
import { signRecordsKey } from 'midnight-identity/profile/records-key';
import { newBlinding, sign, toHex, type Hex } from '../core/crypto.js';
import { openAccount, sealAccount } from '../core/account.js';
import { signVaultKeys } from '../core/vault-keys.js';
import { approverRosterFrom } from '../core/vault-approvers.js';
import { newProposalId } from '../core/proposal-filing.js';
import { signedFoundingRoster } from '../core/roster-record.js';
import type { Account, RetirementSignature, SealedAccount } from '../core/types.js';
import type { LedgerStatus } from '../core/ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { policyBarKey } from '../midnight/spending-policy.js';
import { directoryChangeMessage, type ChainHolders, type CommitteeKey } from '../midnight/seat-directory.js';
import type { RecordsAsked } from '../midnight/records-held.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { assetIdHex } from '../core/assets.js';
import { TEST_TOKEN } from '../testing/assets.js';
import { signCompanyFiling } from '../midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../midnight/record-manifest.js';
import { sealSpendingPolicy } from '../midnight/spending-policy-record.js';
import { signedStateHere, type CompanyRecordsHere } from 'vaults-web-shared/run-rebuilt-here.js';
import { spendingPolicyHere } from 'vaults-web-shared/spending-policy-here.js';
import { signerRoutes } from './signer-routes.js';
import { proposalRelayRoutes } from './proposal-relays.js';
import { anchorFunctions, anchorSentInATest, roundsOnATestChain } from '../testing/record-tree-double.js';
import { leavesOfTheContract } from '../testing/directory-seats.js';
import { manifestServiceFor, treeServiceFor } from 'vaults-web-shared/record-entered-here.js';
import {
  anchorServiceFor, anchorTheRecordsHere, directoryChangeFiledHere, recordsHeldHere, type AnchorDoors,
} from 'vaults-web-shared/records-anchored-here.js';
import { attestedIn, directoryHere, directoryWithItsRecordsHere, leaversStatementIn, type DirectoryHere } from 'vaults-web-shared/vault-page-doors.js';
import { foldOffersHere, offerVaultKeysHere, rosterHere, type RosterDoors } from 'vaults-web-shared/roster-here.js';
import { treeKeptInMemory } from 'vaults-web-shared/tree-kept-here.js';
import { governedCallServiceFor, type RemovalDoors } from 'vaults-web-shared/governed-call-on-device.js';
import type { GovernedCallOrder } from 'vaults-web-shared/governed-call-builder.js';
import {
  aCompanyOfTwoSeats, acmeChain, acmeDirectoryDeps, acmeReads, ACME_STATE, ADA, ADDRESS, apiAs, BO, chains, CO, KEY, LABEL, peopleRecords, seatOf, sendAs, store,
  type Seat,
} from './a-company-of-two-seats.test-support.js';

const { refuseARaiseThatIsNotTheRecordedOne, refuseWhatThisDeviceDidNotOpen, identityOfAChange, spendingPolicyKeysOf } = await import('vaults-web-shared/governed-call-builder.js');
const { pureCircuits } = await import('../../contracts/managed/contract/index.js');

export { ADA, BO, CO, KEY, LABEL, ADDRESS, acmeChain, apiAs, sendAs, store, chains, seatOf, type Seat };

/** Cy, seated by Ada's invitation: the third seat, an admin. */
export const CY = seatOf('cy', 3, LABEL, ADDRESS, CO, ADA);
/** Each seated person's id in the roster. */
export const ID: Record<string, string> = { ada: 'sgn_ada', bo: 'sgn_bo', cy: 'sgn_cy' };

/* ── the chain's account, stood in ────────────────────────────────────────── */

/** Every proposal the chain holds open, by its identity on chain: what it changes, and who approved it. */
const open = new Map<string, { change: 'add' | 'remove' | 'other'; leaf: string | null; approvedBy: Set<string> }>();
/** The call that closed each proposal the chain no longer holds open. */
const closedWith = new Map<string, string>();
/**
 * What reached the service and the chain, in order: each directory version filed (`directory 5 retire`), each anchor
 * that landed (`anchored`), and each call the chain took, with the leaf it seats or takes off (`chain amendSigner
 * removing <leaf>`).
 */
export const events: string[] = [];
/** The committee key the chain seats each new leaf with, as the joining wallet gives it. */
export const committeeKeyOfLeaf = new Map<string, CommitteeKey>();

const holdingNow = (): ChainHolders => chains.get(CO)!;
/** The test's chain holds `seats`, at `approvals` and with `seatBar` the bar for a change of who is seated. */
export const holdingOf = (seats: readonly { seat: string; committeeKey: CommitteeKey }[], approvals = 1, seatBar = approvals): ChainHolders => ({
  seats: { committee: seats.map((s) => s.committeeKey), threshold: 1, seats: seats.map((s) => s.seat) }, approvals, seatBar,
});
/** The seats the test's chain holds now. */
export const seatsOnTheChain = (): readonly string[] => holdingNow().seats.seats;

/** The chain's own read of the account, as the service's relays read it. */
const status = async (accountId: string): Promise<LedgerStatus | null> => {
  if (accountId !== CO) return null;
  const h = holdingNow();
  return {
    assets: [], openProposals: [...open].map(([id, o]) => ({ id: id as Hex, change: '00'.repeat(32) as Hex, approvals: o.approvedBy.size })),
    threshold: h.approvals, signerCount: h.seats.seats.length,
    vaultThresholds: h.seatBar > h.approvals ? [{ vault: policyBarKey(), threshold: h.seatBar }] : [],
  } as unknown as LedgerStatus;
};

/** The one door a device's proven call reaches the chain through: what each call does to the account, as its circuit does. */
const submitProvenCall = async (_accountId: string, bytes: Uint8Array, circuit: string) => {
  const { signer, order } = JSON.parse(Buffer.from(bytes).toString('utf8')) as { signer: string; order: GovernedCallOrder };
  if (order.circuit !== circuit) throw new Error(`the door was told ${circuit} and handed ${order.circuit}`);
  const h = holdingNow();
  if (!h.seats.seats.includes(signer)) throw new Error('not a signer on this account');
  const proposal = 'proposal' in order ? String(order.proposal).toLowerCase() : '';
  if (order.circuit === 'propose' && 'governance' in order) {
    const g = order.governance as { kind: string; leaf?: string };
    open.set(proposal, { change: g.kind === 'add-signer' ? 'add' : g.kind === 'remove-signer' ? 'remove' : 'other', leaf: g.leaf?.toLowerCase() ?? null, approvedBy: new Set() });
  } else if (order.circuit === 'approve') {
    const o = open.get(proposal);
    if (o === undefined) throw new Error('there is no open proposal with that id');
    if (o.approvedBy.has(signer)) throw new Error('you have already approved this proposal');
    o.approvedBy.add(signer);
  } else if (order.circuit === 'amendSigner') {
    const o = open.get(proposal);
    if (o === undefined) throw new Error('there is no open proposal with that id');
    if (o.approvedBy.size < h.seatBar) throw new Error('not enough approvals');
    const leaf = order.leaf.toLowerCase();
    if (order.removing === true) {
      if (o.change !== 'remove' || o.leaf !== leaf) throw new Error('that proposal is not for this removal');
      if (!h.seats.seats.includes(leaf)) throw new Error('that signer is not seated on this account');
      if (h.seats.seats.length - 1 < h.seatBar) throw new Error('that would leave too few signers to approve anything');
      const at = h.seats.seats.indexOf(leaf);
      chains.set(CO, { ...h, seats: { ...h.seats, seats: h.seats.seats.filter((_, i) => i !== at), committee: h.seats.committee.filter((_, i) => i !== at) } });
    } else {
      if (o.change !== 'add' || o.leaf !== leaf) throw new Error('that proposal is not for this signer');
      const key = committeeKeyOfLeaf.get(leaf);
      if (key === undefined) throw new Error('the test gave no committee key for this leaf');
      chains.set(CO, { ...h, seats: { ...h.seats, seats: [...h.seats.seats, leaf], committee: [...h.seats.committee, key] } });
    }
    open.delete(proposal);
    closedWith.set(proposal, 'amendSigner');
  } else if (order.circuit === 'cancel') {
    open.delete(proposal);
    closedWith.set(proposal, 'cancel');
  } else {
    throw new Error(`this test's chain does not take ${order.circuit}`);
  }
  events.push(order.circuit === 'amendSigner' ? `chain amendSigner ${order.removing === true ? 'removing' : 'adding'} ${order.leaf.toLowerCase()}` : `chain ${order.circuit}`);
  return { ref: `ref-${events.length}`, at: new Date().toISOString() };
};

/** Where each proposal stands on the test's chain, as each person's own wallet reads it. */
export const theChain = roundsOnATestChain(async () => [...open].map(([id, o]) => ({ id, approvals: o.approvedBy.size })),
  (id) => { const c = closedWith.get(id); return c === undefined ? [] : [c]; });

/* ── the company: three seats, every wallet's statement in the roster ─────── */

const signerOf = (s: Seat) => ({
  id: ID[s.person]!, leafCommitment: s.seat as Hex, userId: s.person, name: s.person, status: 'active' as const,
  signingPublicKey: s.statement.signingKey as Hex, wrappingPublicKey: 'ab'.repeat(32) as Hex, role: 'admin' as const,
});
/** What a seat's wallet released for the company, and the statement it signed over the records key. */
export const walletOf = (s: { n: number; seat: string }) => ({
  companyKey: toHex(new Uint8Array(32).fill(s.n + 100)) as Hex,
  recordsKey: signRecordsKey(identityFromSecret(new Uint8Array(32).fill(s.n)), LABEL, ADDRESS, new Uint8Array(32).fill(s.n + 100), s.seat),
});
/** Acme's first roster, filed by Ada's founding seat with her vault keys. */
const firstRoster = () => {
  const adas = walletOf(ADA).recordsKey;
  const signers = [ADA, BO, CY].map(signerOf).map((x) => (x.id !== ID.ada ? x : {
    ...x, vaultKeys: signVaultKeys(CO, ID.ada!, {
      committeeKey: ADA.committeeKey as never, recordsKey: adas.recordsKey as Hex, recordsKeyStatement: adas.signature as Hex, recordsKeySeat: ADA.seat as Hex,
    }, ADA.signingSecret as Hex),
  }));
  return signedFoundingRoster(CO, { name: 'Acme', signers }, KEY, ADA.signingSecret as Hex);
};

/* ── one device of one seat ─────────────────────────────────────────────── */

/** A device's read of the company's `api`, as the page's own `api` reads it: a refusal throws, with the service's words. */
export const api = (person: string) => apiAs(person);

/** One seat's device reading and filing the roster under the filing key its entry names. */
export const rosterDoorsOf = (s: Pick<Seat, 'person' | 'signingSecret' | 'entered'>): RosterDoors => ({
  api: api(s.person), accountId: CO, viewingKey: KEY, signingSecret: s.signingSecret as Hex, label: LABEL, account: ADDRESS,
  reads: acmeReads, entered: s.entered,
});
/** The records-key statements the roster this device believes holds, as the page reads them (`attestedIn`). */
export const attestedByTheRoster = (s: Pick<Seat, 'person' | 'signingSecret' | 'entered'>) => async () => attestedIn((await rosterHere(rosterDoorsOf(s))).account);
/** The company's directory and records as `s`'s device believes them, its statements read from the roster it believes. */
export const directoryOf = (s: Pick<Seat, 'person' | 'signingSecret' | 'entered'>) => (asked?: RecordsAsked): Promise<DirectoryHere> =>
  directoryHere({ ...acmeDirectoryDeps(), attested: attestedByTheRoster(s) }, asked);

/** What `s`'s device anchors and files a directory change through, against the test's chain. */
export const anchorDoorsOf = (s: Pick<Seat, 'person' | 'signingSecret' | 'entered'>, kept = treeKeptInMemory()): AnchorDoors => ({
  accountId: CO,
  changes: kept.changes,
  material: { signingSecret: s.signingSecret as Hex, blinding: '22'.repeat(32) as Hex, scope: '33'.repeat(32) as Hex } as never,
  manifest: manifestServiceFor(api(s.person)),
  tree: treeServiceFor(api(s.person)),
  directory: () => directoryWithItsRecordsHere({ ...acmeDirectoryDeps(), attested: attestedByTheRoster(s) }),
  directoryFilings: async () => store.directoryFilingsOf(CO),
  fileDirectory: async (filing) => {
    const r = await sendAs(s.person)(`/api/accounts/${CO}/directory/${filing.version}`, { method: 'POST', body: JSON.stringify(filing) });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    events.push(`directory ${filing.version} ${filing.change.kind}`);
  },
  onChain: acmeChain.onChain,
  service: {
    callState: async () => ({ account: ADDRESS, accountState: acmeChain.head(), parameters: '', blockHash: 'b' }) as never,
    sendProven: async (_c, tx) => {
      const { previous, batch, held, tag } = JSON.parse(tx) as { previous: Hex; batch: Hex; held: { approvals: number; signerRoot: Hex }; tag: Hex };
      acmeChain.move(previous, batch, held, tag);
      events.push('anchored');
    },
    sealedProposals: async (c) => store.listProposals(c),
    foundingRecords: anchorServiceFor(api(s.person)).foundingRecords,
  },
  builder: { ...anchorFunctions, anchor: anchorSentInATest },
});

/** Every batch of the company's records `s`'s device reads, judged from the company's first header: where the check stopped, if it did. */
export const recordsReadBy = (s: Pick<Seat, 'person' | 'signingSecret' | 'entered'>, asked: RecordsAsked) => recordsHeldHere(anchorDoorsOf(s), asked);

/** The device of a seat - a removal's and a seating's doors - with what it keeps across opens. */
export const deviceOf = (s: Pick<Seat, 'person' | 'signingSecret' | 'entered' | 'seat'>): RemovalDoors => {
  const kept = treeKeptInMemory();
  const signatures = new Map<string, RetirementSignature[]>();
  const anchor = anchorDoorsOf(s, kept);
  return {
    service: { ...governedCallServiceFor(api(s.person)), callState: async () => ({ account: ADDRESS, blockHash: 'b', accountState: 'AS', parameters: 'PP' }) as never },
    builder: {
      governedCall: async ({ order, opened }) => {
        refuseWhatThisDeviceDidNotOpen({ accountPure: pureCircuits as never }, order, opened);
        refuseARaiseThatIsNotTheRecordedOne({ accountPure: pureCircuits as never }, order);
        return { tx: Buffer.from(JSON.stringify({ signer: s.seat, order })).toString('base64') };
      },
      proposalIdentity: async (change, salt) => identityOfAChange({ accountPure: pureCircuits as never }, change, salt),
    },
    material: { signingSecret: s.signingSecret as Hex, blinding: '22'.repeat(32), scope: '33'.repeat(32) },
    accountId: CO,
    records: {
      directory: directoryOf(s),
      state: async (id: string) => (id === ACME_STATE.id ? ACME_STATE : null),
      people: async () => { throw new Error('no person is read in this test'); },
      runs: async () => [],
      proposals: async () => store.listProposals(CO),
      roundsOnChain: theChain,
    } as never,
    filing: { seat: s.seat, keyEpoch: 0, salt: () => newBlinding(), newId: () => newProposalId(), entered: s.entered },
    approvers: async () => approverRosterFrom({
      threshold: holdingNow().approvals, vaultThresholds: [], seated: seatsOnTheChain().map((leaf) => ({ leaf })), adoptedVaults: [], companyWide: 'cc'.repeat(32),
    }),
    vaultName: () => 'company-wide runs',
    leaves: leavesOfTheContract,
    sleep: async () => {}, waitMs: 40, everyMs: 1,
    anchorDirectory: () => anchorTheRecordsHere(anchor),
    leaversStatement: async (seat) => leaversStatementIn(await attestedByTheRoster(s)(), seat, LABEL, ADDRESS),
    directoryChange: (change, signedFor) => directoryChangeFiledHere(anchor, change, signedFor),
    kept: kept.changes,
    signatures: {
      keep: async (_c, id, given) => {
        const was = signatures.get(id) ?? [];
        signatures.set(id, [...was.filter((x) => !given.some((y) => y.publicKey === x.publicKey && y.signedFor === x.signedFor)), ...given]);
      },
      all: async (_c, id) => signatures.get(id) ?? [],
    },
  };
};

/**
 * Mounts the company before a file's tests run: the two-seat company's routes, and beside them the proposal relays,
 * the roster and vault-key routes and the company's proposal list. Then Cy's entry is filed, Bo and Cy offer their
 * vault keys and Ada's device folds them into the roster, Ada's seat makes Bo an admin, every version is anchored from
 * Ada's device while the account asks one approval, and the test's chain then holds the three seats at `seatBar`.
 */
export function aCompanyWhoseSignersChange(seatBar = 2): void {
  aCompanyOfTwoSeats((app: express.Express, deps) => {
    const ownsProposal: express.RequestHandler = (req, res, next) => {
      const p = store.getProposal(String(req.params.id));
      return p !== null && store.getAccount(p.accountId)?.memberUserIds.includes(req.userId!) ? next() : res.status(404).json({ error: 'not found' });
    };
    const refuseSigningSecret: express.RequestHandler = (req, res, next) =>
      (req.body && typeof req.body === 'object' && 'signingSecret' in req.body ? res.status(400).json({ code: 'signing-secret-refused' }) : next());
    app.get('/api/accounts/:id', deps.signedIn, deps.member, (req, res) => {
      const id = String(req.params.id);
      res.json({ ...store.getAccount(id), roster: store.newestRoster(id) });
    });
    app.get('/api/accounts/:id/proposals', deps.signedIn, deps.member, (req, res) => { res.json(store.listProposals(String(req.params.id))); });
    app.use(signerRoutes({
      signedIn: deps.signedIn, member: deps.member, store, records: () => deps.records, directoryOf: deps.directoryOf,
      ledger: { status, holdsSigner: async (_a, seat) => seatsOnTheChain().includes(String(seat)) },
    }));
    app.use(proposalRelayRoutes({
      signedIn: deps.signedIn, member: deps.member, ownsProposal, refuseSigningSecret,
      store, ledger: { wiring: 'simulated' as never, status, submitProvenCall: submitProvenCall as never }, directoryOf: deps.directoryOf,
      recordRefusal: () => undefined,
      proposalIdOf: (h, salt, vault) => MidnightCommitments.proposalId(h as Hex, salt as Hex, vault as Hex | undefined),
    }));
  }, { roster: firstRoster });

  beforeAll(async () => {
    const account = {
      id: CO, name: 'Acme', createdAt: 'now', signers: [ADA, BO, CY].map(signerOf), policy: { threshold: 1 }, wrappedKeys: [],
      recovery: { signerIds: [], threshold: 1 }, contractAddress: ADDRESS, companyLabel: LABEL,
    } as unknown as Account;
    store.putAccount(sealAccount(account, KEY, [], 0));
    chains.set(CO, holdingOf([ADA, BO, CY]));
    const r = await sendAs('cy')(`/api/accounts/${CO}/directory/4`, { method: 'POST', body: JSON.stringify({ company: CO, version: 4, change: { kind: 'claim', entry: CY.entry } }) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    for (const s of [BO, CY]) {
      await offerVaultKeysHere(api(s.person), CO, {
        signerId: ID[s.person]!, signingSecret: s.signingSecret as Hex, committeeKey: s.committeeKey as never,
        ...walletOf(s), entry: s.statement, viewingKey: KEY,
      });
    }
    await anchorTheRecordsHere(anchorDoorsOf(ADA));
    expect(await foldOffersHere(rosterDoorsOf(ADA))).toEqual({ folded: [BO.seat, CY.seat], refused: [] });
    /* Bo, an approver until now, is made an admin by Ada's seat while the account asks one approval of a change of who holds it. */
    const unsigned = { kind: 'role', seat: BO.seat, role: 'admin', threshold: 1, signatures: [] } as const;
    const message = directoryChangeMessage(CO, 5, unsigned as never);
    const role = await sendAs('ada')(`/api/accounts/${CO}/directory/5`, { method: 'POST', body: JSON.stringify({ company: CO, version: 5, change: {
      ...unsigned, signatures: [{ publicKey: ADA.statement.signingKey as Hex, signature: sign(message, ADA.signingSecret) }] } }) });
    expect(role.status, JSON.stringify(role.body)).toBe(201);
    await anchorTheRecordsHere(anchorDoorsOf(ADA));
    chains.set(CO, holdingOf([ADA, BO, CY], 1, seatBar));
    events.length = 0;
  });
}

/* ── a vault's spending policy, held on the test's chain ──────────────────── */

/** The vault whose spending policy a seat files, and the currency it is for. */
export const VAULT = 'fa'.repeat(32);
const TERMS = {
  bands: [{ ceiling: '10', approvals: '1' }, { ceiling: '20', approvals: '1' }, { ceiling: '30', approvals: '1' }, { ceiling: '40', approvals: '1' }],
  periodLimit: '100', periodStart: '0', periodLength: '60',
};
/** What the account's map of roles holds for the vault's policy, by key: its marker and its commitment. */
const policyOnChain = new Map<string, string>();
/** The secret a seat's device opens what is sealed to its records key with, from what its wallet released for the company. */
const recordsSecretOf = (s: { n: number }): Hex => toHex(hkdf(sha256, new Uint8Array(32).fill(s.n + 100),
  new TextEncoder().encode('confidential-accounts/company-records-wrapping/v1'), new Uint8Array(0), 32)) as Hex;
/** The contract's own keys for the vault's policy and the commitment `opening` makes, with the account's blinding from its signed state. */
const policyKeys = async (records: CompanyRecordsHere, opening?: { terms: typeof TERMS; blinding: string }) => spendingPolicyKeysOf(
  { accountPure: pureCircuits as never },
  { vault: VAULT, asset: assetIdHex(TEST_TOKEN), assetBlinding: (await signedStateHere(records, CO, KEY)).assetBlinding, ...(opening === undefined ? {} : { policy: opening as never }) },
);
/** `s`'s device's company records, with the vault's spending policies read as its own seat. */
const policyRecordsOf = (s: Pick<Seat, 'person' | 'signingSecret' | 'entered' | 'seat' | 'n'>): CompanyRecordsHere => ({
  ...(deviceOf(s).records as CompanyRecordsHere),
  spendingPolicies: {
    versions: (id) => peopleRecords.versions(CO, 'spending-policy', id),
    file: async () => { throw new Error('no policy is filed through this read'); },
    me: { signerId: s.seat, wrappingSecret: recordsSecretOf(s) },
    keys: async (i) => spendingPolicyKeysOf({ accountPure: pureCircuits as never }, i),
    onChain: async (keys) => new Map(keys.map((k) => [k.toLowerCase(), policyOnChain.get(k.toLowerCase()) ?? null])),
  },
});
/**
 * **THE VAULT'S SPENDING POLICY, FILED BY `by`** sealed to the records key of each seat in `to` as the directory holds
 * it, signed by its seat, kept where the service keeps the company's records and entered from its device; the test's
 * chain then holds the vault's marker and the policy's commitment. Returns the version filed.
 */
export const aPolicyFiledBy = async (by: Seat, to: readonly Seat[]): Promise<number> => {
  const records = policyRecordsOf(by);
  const opening = { terms: TERMS, blinding: newBlinding() };
  const keys = await policyKeys(records, opening);
  const version = (await peopleRecords.versions(CO, 'spending-policy', keys.policyKey)).length + 1;
  const here = await directoryOf(by)();
  const rec = signCompanyFiling(sealSpendingPolicy({
    company: CO, id: keys.policyKey as Hex, version, keyEpoch: 0,
    secrets: { vault: VAULT, asset: TEST_TOKEN, opening },
    signers: to.map((x) => ({ id: x.seat, wrappingPublicKey: here.dir.seats.find((d) => d.seat === x.seat)!.wrappingKey })) as never,
  }), by.signingSecret as Hex);
  await peopleRecords.put(rec);
  await by.entered.enter([companyRecordEntry(rec)]);
  policyOnChain.set(keys.onKey.toLowerCase(), '01');
  policyOnChain.set(keys.policyKey.toLowerCase(), keys.commitment!.toLowerCase());
  return version;
};
/** The vault's policy as `s`'s device reads it, with its own seat's records key (`spendingPolicyHere`). */
export const policyReadBy = (s: Pick<Seat, 'person' | 'signingSecret' | 'entered' | 'seat' | 'n'>) =>
  spendingPolicyHere({ records: policyRecordsOf(s), accountId: CO, viewingKey: KEY }, { vault: VAULT, asset: TEST_TOKEN });

/** The company as the service holds it now, opened with the viewing key. */
export const companyNow = (): ReturnType<typeof openAccount> => openAccount(store.getAccount(CO) as SealedAccount, KEY, store.newestRoster(CO) as never);
