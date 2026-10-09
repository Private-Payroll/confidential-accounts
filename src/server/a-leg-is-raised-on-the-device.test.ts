/**
 * **A LEG OF A RUN IS RAISED ON A SIGNER'S DEVICE, AND THE SERVICE ONLY FILES
 * AND RELAYS IT.** The device reads the run a believed seat filed, checks the
 * leg may be raised, builds the payout tree itself, writes the proposal and the
 * run as raised, signs both with its seat's filing key and proves the raise; the
 * proving's own checks rebuild the run against the chain before the call is
 * built. The service files the two only together, for the seat that signed both,
 * after asking the vault's public money, and relays the call.
 *
 * Over real HTTP with the people invited, accepted and admitted on devices. The
 * chain is the test's: the proposals it holds open, the payments it counts, and
 * the account's marks; the proving is the checks the worker runs before it builds.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode, type JoinCode } from 'midnight-identity/profile/join-code';
import { pureCircuits } from '../../contracts/managed/contract/index.js';
import { fromHex, newWrappingKeypair, randomBytes, toHex, type Hex } from '../core/crypto.js';
import { NIGHT, TEST_SETTLEMENT_ASSET } from '../core/assets.js';
import { newStateBlinding, sealState } from '../core/account.js';
import { signedFoundingState } from '../core/founding-state.js';
import { newProposalId, paysCommitmentOf, signProposalFiling, type SignedProposalFiling } from '../core/proposal-filing.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { openSealedRun, sealedRunOf } from '../core/run-legs.js';
import { signRunFiling } from '../core/run-filing.js';
import { NothingWasSent } from '../core/jobs.js';
import type { LedgerStatus } from '../core/ledger.js';
import { payRecordNonceOf } from '../midnight/run-keys.js';
import { payKeyCommitmentOf } from '../midnight/pay-key-commitment.js';
import { buildRetryRun, buildRun, paidMovementOfLeaf, paidOnceOfNonce, rootOfPayments } from '../midnight/payout-tree.js';
import { theNetwork } from '../midnight/network.js';
import { payeeFor, unshieldedPayeeFor } from '../testing/payees.js';
import { vaultDetails } from '../testing/vault-details.js';
import { acceptAsPayeeHere, invitePayeeHere, openInvitationHere, type InvitingCompany } from 'vaults-web-shared/invitation-on-device.js';
import { admitHere, readPeopleHere, setStatusHere, type PeopleDevice } from 'vaults-web-shared/people-on-device.js';
import { drawRunHere, type RunDrawDoors } from 'vaults-web-shared/run-drawn-here.js';
import { openTheRoundHere, raiseRetryOnDevice, raiseRunOnDevice, sendRaiseFromDevice, sendRetryFromDevice } from 'vaults-web-shared/governed-call-on-device.js';
import { WRITTEN_DOWN_IS_NOT_WHAT_IS_CHECKED } from '../core/device-raise.js';
import { governedCallServiceFor } from 'vaults-web-shared/governed-call-on-device.js';
import { LegNotRaisedHere, type LegRaiseDoors } from 'vaults-web-shared/run-raised-here.js';
import { keptRunHere, runRebuiltHere, type CompanyRecordsHere } from 'vaults-web-shared/run-rebuilt-here.js';
import { RAISE_CHECKS, type RaiseCheck } from 'vaults-web-shared/raise-checks-here.js';
import {
  refuseARaiseThatIsNotTheRecordedOne, refuseWhatThisDeviceDidNotOpen, type GovernedCallOrder, type OpenedRound,
} from 'vaults-web-shared/governed-call-builder.js';
import { refuseWhatThisDeviceDidNotMake, type AccountLedgerView } from 'vaults-web-shared/what-this-device-made.js';
import { chainReadThroughTheWallet } from 'vaults-web-shared/spending-policy-here.js';
import { legToPayHere, privatePaymentsHere } from 'vaults-web-shared/payments-made-here.js';
import { deviceSignerFrom } from 'vaults-web-shared/vault-page-doors.js';
import { spendingPolicyKeysOf } from 'vaults-web-shared/governed-call-builder.js';
import { signCompanyFiling, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { sealSpendingPolicy } from '../midnight/spending-policy-record.js';
import { recordsKeypairFrom } from '../midnight/company-nonce-secret.js';
import { assetIdHex } from '../core/assets.js';
import { runRoutes } from './run-routes.js';
import { proposalRelayRoutes } from './proposal-relays.js';
import {
  aCompanyOfTwoSeats, acmeDirectory, ACME, ADA, ADDRESS, BO, CO, fromAda, KEY, LABEL, ORIGIN, OTHER, sendAs, store, wire, type Seat,
} from './a-company-of-two-seats.test-support.js';

/* The chain, as the test keeps it: the proposals it holds open, the payment entries it counts, and the account's marks. */
const open = new Map<string, number>();
const movements = new Set<string>();
/* What the account's map of roles holds, by key: a vault's policy marker, its policy's commitment. */
const roles = new Map<string, string>();
/* The versions of the vault's spending-policy record the company's store holds. */
const policyVersions: SealedCompanyRecord[] = [];
/* Every set of the account's entries the person's own wallet was asked about. */
const rolesAsked: string[][] = [];
/* What the account writes under a vault's policy marker: any thirty-two bytes, for a marker is read as set or not. */
const MARK = '01'.padEnd(64, '0');
const publicAsks: string[] = [];
let publicRefuses: string | null = null;
let dropTheSend = false;
/** While set, the vault's public money is answered only once it settles: two raises can be checked at once. */
let holdThePublicMoney: Promise<void> | null = null;
const STATE_BLINDING = newStateBlinding();
const COMMITMENT = payKeyCommitmentOf(STATE_BLINDING.payRecordKey as Hex);
let records!: CompanyRecordsHereStore;
type CompanyRecordsHereStore = Parameters<Parameters<typeof aCompanyOfTwoSeats>[0] & {}>[1]['records'];

const ledger = {
  wiring: 'simulated' as const,
  status: async (): Promise<LedgerStatus | null> => ({
    assets: [], openProposals: [...open].map(([id, approvals]) => ({ id: id as Hex, change: '00'.repeat(32) as Hex, approvals })),
    threshold: 1, vaultThresholds: [], signerCount: 2,
  } as unknown as LedgerStatus),
  submitProvenCall: async (_accountId: string, bytes: Uint8Array, circuit: string) => {
    if (dropTheSend) throw new Error('the node dropped the connection');
    const o = JSON.parse(Buffer.from(bytes).toString('utf8')) as { circuit: string; proposal: string };
    if (o.circuit !== circuit) throw new NothingWasSent(`the door was told ${circuit} and handed ${o.circuit}. Nothing was sent.`);
    if (circuit === 'propose') open.set(o.proposal, 0);
    return { ref: `ref-${open.size}`, at: new Date().toISOString() };
  },
};

aCompanyOfTwoSeats((app, deps) => {
  records = deps.records;
  app.use(runRoutes({ signedIn: deps.signedIn, member: deps.member, store, directoryOf: deps.directoryOf, wiring: () => 'simulated' }));
  const ownsProposal: express.RequestHandler = (req, res, next) => {
    const p = store.getProposal(String(req.params.id));
    return p !== null && store.getAccount(p.accountId)?.memberUserIds.includes(req.userId!) ? next() : res.status(404).json({ error: 'not found' });
  };
  app.use(proposalRelayRoutes({
    signedIn: deps.signedIn, member: deps.member, ownsProposal, refuseSigningSecret: (_q, _r, next) => next(),
    store, ledger, directoryOf: deps.directoryOf, recordRefusal: () => undefined, wiring: () => 'simulated',
    proposalIdOf: (h, salt, vault) => MidnightCommitments.proposalId(h as Hex, salt as Hex, vault as Hex | undefined),
    publicMoney: async (ask) => {
      publicAsks.push(JSON.stringify(ask));
      if (holdThePublicMoney !== null) await holdThePublicMoney;
      if (publicRefuses !== null) throw new NothingWasSent(publicRefuses);
    },
  }));
});

const NETWORK = theNetwork();
const VAULT = 'c5'.repeat(32) as Hex;
const NOW = Math.floor(Date.now() / 1000);
const WINDOW = { opensAt: String(NOW + 3600), closesAt: String(NOW + 7200) };
const addressOf = (n: number) => payeeFor(n.toString(16).padStart(2, '0').repeat(32), NETWORK).bech32;
const pay = (n: number) => ({ name: `Payee ${n}`, email: `payee${n}@acme.co`, title: 'Engineer', asset: TEST_SETTLEMENT_ASSET, baseAmount: 700000n + BigInt(n), startDate: '2026-10-01' });
const peopleOn = (s: Seat): PeopleDevice => ({
  company: ACME as InvitingCompany, signingSecret: s.signingSecret, signedInAs: s.person, send: sendAs(s.person), directory: acmeDirectory, network: NETWORK,
});
const aPayee = async (n: number, paidAt = n, paid: { address: string; asset: string } = { address: addressOf(paidAt), asset: TEST_SETTLEMENT_ASSET }) => {
  const code: JoinCode = signJoinCode(identityFromSecret(new Uint8Array(32).fill(n)), LABEL, `usr_${n}`, { kind: 'payee', address: paid.address, payslipKey: newWrappingKeypair().publicKey });
  const made = await invitePayeeHere(ACME, ADA, { ...pay(n), asset: paid.asset as never }, ORIGIN, fromAda);
  const accepted = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs(`usr_${n}`));
  const here = (await readPeopleHere(peopleOn(ADA))).people.find((p) => p.person.id === made.person)!;
  await admitHere(peopleOn(ADA), here, accepted.fingerprint);
  return made.person!;
};
const api = (s: Seat) => async (path: string, init?: RequestInit) => {
  const r = await sendAs(s.person)(path, { method: (init?.method ?? 'GET') as never, ...(init?.body === undefined ? {} : { body: String(init.body) }) });
  if (r.status >= 300) throw Object.assign(new Error(String((r.body as { error?: string }).error ?? r.status)), { status: r.status, body: r.body });
  return r.body;
};
/** What the person's own wallet reads off the chain about payments: the chain as the test keeps it, never what is served. */
const walletReads: string[][] = [];
const recordsOn = (s: Seat): CompanyRecordsHere & { proposals: () => Promise<ReturnType<typeof store.listProposals>> } => ({
  directory: () => acmeDirectory(),
  people: () => readPeopleHere(peopleOn(s)),
  state: (id) => records.get(CO, 'state', id),
  runs: async () => store.listRuns(CO),
  proposals: async () => store.listProposals(CO),
  payments: {
    paidOnceOf: pureCircuits.paidOnceOf, paidMovementOf: pureCircuits.paidMovementOf,
    read: async (entries) => {
      walletReads.push([...entries]);
      return { payKeyCommitment: COMMITMENT, held: entries.filter((e) => movements.has(e)), openRounds: [...open.keys()].sort(), entries: movements.size };
    },
  },
  policy: async () => policy as never,
  spendingPolicies: {
    versions: async (id) => policyVersions.filter((r) => r.id === id),
    file: async () => { throw new Error('no policy is set in this file: each is filed as a seat filed it, by the test'); },
    me: deviceSignerFrom(s.seat, toHex(new Uint8Array(32).fill(s.n + 100))),
    keys: async (input) => spendingPolicyKeysOf({ accountPure: P }, input),
    /* The person's own wallet, reading the chain as the test keeps it - never the state the service serves. */
    onChain: chainReadThroughTheWallet(async (asked) => {
      rolesAsked.push([...asked]);
      return { roles: asked.map((key) => ({ key, value: roles.get(key) ?? null })) };
    }),
  },
});
/** While set, the account state the service serves says nobody is paid and commits to another pay-record key. */
let servedLies = false;
const drawingOn = (s: Seat): RunDrawDoors => ({
  api: api(s), accountId: CO, viewingKey: KEY, keyEpoch: 0, signingSecret: s.signingSecret as Hex, company: { account: ADDRESS, label: LABEL },
  records: recordsOn(s), by: s.person,
});

/** The account as the service serves it to the worker; while `servedLies`, it hides the open rounds and the payments. */
const theChainNow = (): AccountLedgerView => ({
  openProposals: { member: (id) => !servedLies && open.has(toHex(id)) },
  movements: { member: (e) => !servedLies && movements.has(toHex(e)) },
});
const P = pureCircuits as unknown as Parameters<typeof refuseWhatThisDeviceDidNotOpen>[0]['accountPure'];
const proved: Array<{ order: GovernedCallOrder; opened: OpenedRound }> = [];
/** What the worker runs before it builds a call, over the chain as the test holds it; the "proof" names the call. */
const builder = {
  governedCall: async (input: { order: GovernedCallOrder; opened: OpenedRound }) => {
    refuseWhatThisDeviceDidNotOpen({ accountPure: P }, input.order, input.opened);
    refuseWhatThisDeviceDidNotMake({
      runPayload: pureCircuits.runPayload, vaultDetails, payKeyCommitmentOf: pureCircuits.payKeyCommitmentOf,
    }, input.opened, theChainNow(), input.order.circuit === 'propose' ? 'raise' : 'approve');
    refuseARaiseThatIsNotTheRecordedOne({ accountPure: P }, input.order);
    proved.push(input);
    return { tx: Buffer.from(JSON.stringify({ circuit: input.order.circuit, proposal: input.order.proposal })).toString('base64') };
  },
};
let policy: Record<string, unknown> = { threshold: 1, limitsByRole: {} };
const raisingOn = (s: Seat, at?: number): LegRaiseDoors => ({
  service: { ...governedCallServiceFor(api(s)), callState: async () => ({ account: ADDRESS, accountState: '', parameters: '' }) as never },
  builder: builder as never,
  material: { signingSecret: s.signingSecret as Hex, blinding: '00'.repeat(32) as Hex } as never,
  accountId: CO,
  records: recordsOn(s),
  holdings: { held: async () => ({ of: 'held', amount: 10n ** 12n }), fits: async () => ({ of: 'fits' }) },
  filing: { seat: s.seat, keyEpoch: 0, salt: () => toHex(randomBytes(32)), newId: () => newProposalId() },
  company: { account: ADDRESS, label: LABEL },
  runs: {
    detailsOf: vaultDetails, runPayload: pureCircuits.runPayload, proposalIdOf: pureCircuits.proposalIdOf, noVault: pureCircuits.noVault,
    buildRun, buildRetryRun, rootOfPayments,
  },
  waitMs: 50, everyMs: 10, sleep: async () => undefined,
  ...(at === undefined ? {} : { now: () => new Date(at * 1000) }),
});
const RAISE = { viewingKey: KEY, vault: VAULT, ...WINDOW };
/** A signer's service doors, reading the company's proposals sealed as the service stores them. */
const storedFor = (s: Seat) => ({ ...governedCallServiceFor(api(s)), sealedProposals: async () => store.listProposals(CO) });
const filedNow = () => ({ runs: store.listRuns(CO).map((r) => JSON.stringify(r)).join('|'), proposals: store.listProposals(CO).length });

let runId = '';
beforeAll(async () => {
  await records.put(signedFoundingState(CO, sealState({ entries: [] }, STATE_BLINDING, KEY, 0), ADA.signingSecret as Hex));
  await aPayee(61);
  await aPayee(62);
});
beforeEach(async () => {
  open.clear(); movements.clear(); roles.clear(); policyVersions.length = 0; rolesAsked.length = 0; publicAsks.length = 0; publicRefuses = null; proved.length = 0; dropTheSend = false;
  servedLies = false; walletReads.length = 0;
  holdThePublicMoney = null;
  policy = { threshold: 1, limitsByRole: {} };
  for (const r of store.listRuns(CO)) store.putRun({ ...r, accountId: 'acc_set_aside' });
  runId = (await drawRunHere(drawingOn(ADA), { period: '2026-11' })).id;
});

describe('A LEG IS RAISED ON THE SIGNER\'S DEVICE, AND THE SERVICE FILES AND RELAYS IT', () => {
  it('THE RUN AS RAISED AND ITS PROPOSAL ARE FILED SIGNED BY ADA\'S SEAT, THE RAISE IS RELAYED, AND ANOTHER SIGNER\'S DEVICE BUILDS IT AGAIN', async () => {
    const round = await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    const kept = store.getRun(runId)!;
    const proposal = store.getProposal(round.id)!;
    /* RED WHEN: the run is not re-filed with the raise, or is re-filed without Ada's signature (the raise keeps the filing signature). */
    expect(kept.status).toBe('proposed');
    expect(kept.proposalIds).toEqual([round.id]);
    expect(kept.filedBy?.publicKey).toBe(ADA.statement.signingKey);
    /* RED WHEN: the proposal is filed under another key, or not raised on the chain the call was relayed to. */
    expect(proposal.filedBy?.publicKey).toBe(ADA.statement.signingKey);
    expect(open.has(proposal.chainId)).toBe(true);
    expect(round.raisedAt).toBeTruthy();
    /* RED WHEN: the vault's public money is not asked, or is asked for other payments than the leg's two. */
    expect(publicAsks).toHaveLength(1);
    const asked = JSON.parse(publicAsks[0]!) as { vault: string; payments: Array<{ amount: string }> };
    expect(asked.vault).toBe(VAULT);
    expect(asked.payments.map((p) => p.amount).sort()).toEqual(['700061', '700062']);
    /* RED WHEN: the raise files the run without its seat's signature over the run as raised, which a reader refuses. */
    const read = await keptRunHere(recordsOn(BO), CO, runId, KEY);
    expect(read.run.payout?.[Object.keys(read.run.payout!)[0] as never]?.vault).toBe(VAULT);
    /* RED WHEN: the run raised is not the one another signer's device builds again and would approve. */
    const { made } = await runRebuiltHere(recordsOn(BO), CO, round.id, KEY);
    expect(() => refuseWhatThisDeviceDidNotMake({
      runPayload: pureCircuits.runPayload, vaultDetails, payKeyCommitmentOf: pureCircuits.payKeyCommitmentOf,
    }, { chainId: proposal.chainId, digest: proposal.digest, made }, theChainNow())).not.toThrow();
    /* RED WHEN: another signer's device does not open, as the run it builds again pays, what the filing committed to paying. */
    await expect(openTheRoundHere(storedFor(BO), CO, round.id, KEY, false, recordsOn(BO))).resolves.toMatchObject({ vault: VAULT });
    /* RED WHEN: the viewing key crosses to the service on any request of the raise. */
    expect(wire.some((w) => w.includes(KEY))).toBe(false);
  });

  it('A RUN THE SERVICE CHANGED AFTER A SEAT FILED IT, OR ONE FILED BY A SEAT THAT MAY NOT FILE A RUN, IS NOT RAISED', async () => {
    const kept = store.getRun(runId)!;
    store.putRun({ ...kept, period: '2026-12' });
    const before = filedNow();
    /* RED WHEN: a reader does not check the run's filing signature against the run as kept. */
    await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE })).rejects.toThrow(/does not believe the company's record of this payroll run \(its signature does not cover exactly this run/);
    expect(filedNow()).toEqual(before);
    /* Bo's seat is an approver, which files proposals and not runs. */
    store.putRun({ ...signRunFiling(CO, sealedRunOf(openSealedRun(kept, KEY), KEY, 0), BO.signingSecret as Hex), wiring: 'simulated' });
    /* RED WHEN: a reader believes a run's filer without asking the directory whether that seat may file a run. */
    await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE })).rejects.toThrow(/does not believe the company's record of this payroll run \(it is signed by a seat whose role may not file this kind of record/);
    store.putRun(kept);
    await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE })).resolves.toBeTruthy();
  });

  it('A LEG ALREADY PROPOSED, A WINDOW NO PAYMENT CAN FALL IN, AND THE COMPANY\'S OWN CEILING ARE REFUSED ON THE DEVICE, AND NOTHING IS FILED', async () => {
    const pastClose = { ...RAISE, opensAt: String(NOW - 7200), closesAt: String(NOW - 3600) };
    const backwards = { ...RAISE, opensAt: WINDOW.closesAt, closesAt: WINDOW.opensAt };
    for (const [asked, says] of [[pastClose, /window closed at/], [backwards, /opens at .* and closes at/]] as const) {
      const before = filedNow();
      /* RED WHEN: the device raises a window that has closed, or one that opens after it closes. */
      await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...asked })).rejects.toThrow(says);
      await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...asked })).rejects.toBeInstanceOf(LegNotRaisedHere);
      expect(filedNow()).toEqual(before);
    }
    policy = { threshold: 1, limitsByRole: { admin: { [TEST_SETTLEMENT_ASSET]: { perTransaction: 1000n } } } };
    /* RED WHEN: the device does not apply the company's own ceilings the service applied when it raised runs. */
    await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE })).rejects.toThrow(/per-transaction/);
    policy = { threshold: 1, limitsByRole: {} };
    const first = await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    const before = filedNow();
    /* RED WHEN: a leg already proposed is raised again as a second round over the same people. */
    await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE })).rejects.toThrow(new RegExp(`already proposed, as ${first.id}`));
    expect(filedNow()).toEqual(before);
  });

  it('A VAULT UNDER A SPENDING POLICY FOR ANOTHER CURRENCY ONLY, AND A CHAIN HOLDING WHAT THE RECORDS CANNOT ACCOUNT FOR, AS THE WALLET READS IT, ARE REFUSED BEFORE ANYTHING IS WRITTEN', async () => {
    const proposalsBefore = store.listProposals(CO).length;
    roles.set(toHex(pureCircuits.policyOnKeyOf(fromHex(VAULT))), MARK);
    /* RED WHEN: a raise goes ahead from a vault the chain will charge no run of in this currency. */
    await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE })).rejects.toThrow(/has a spending policy, but none for the currency this run pays in/);
    roles.clear();
    open.set('ee'.repeat(32), 0);
    /* The service serves an account state holding nothing open and nothing paid: the wallet's read is what the check reads. */
    servedLies = true;
    /* RED WHEN: a raise goes ahead while the chain holds a round the company's records do not, or the open rounds are read from the state the service serves, or the refusal does not say why a device cannot confirm over it. */
    await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE })).rejects.toThrow(/1 open round .* cannot be confirmed as repeating these/);
    open.clear();
    movements.add('ab'.repeat(32));
    movements.add('cd'.repeat(32));
    /* RED WHEN: payments the chain counts and the records cannot name are not counted, or are counted from the state the service serves. */
    await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE })).rejects.toThrow(/2 unexplained payment entries/);
    servedLies = false;
    expect(store.listProposals(CO)).toHaveLength(proposalsBefore);
    expect(proved).toHaveLength(0);
  });

  it('THE VAULT\'S PRIVATE MONEY IS ASKED BEFORE ANYTHING IS PROVED OR FILED, AND A RAISE WHOSE PROOF FAILS FILES NOTHING', async () => {
    const stages: string[] = [];
    const short: LegRaiseDoors = { ...raisingOn(ADA), holdings: { held: async () => ({ of: 'held', amount: 5n }), fits: async () => ({ of: 'fits' }) } };
    const before = filedNow();
    const refused = await raiseRunOnDevice(short, { runId, ...RAISE }).catch((e: Error) => e);
    /* RED WHEN: a leg is raised from this device without the vault's private money asked here first. */
    expect((refused as { why?: string }).why).toBe('short');
    expect(filedNow()).toEqual(before);
    expect(proved).toHaveLength(0);
    const failing: LegRaiseDoors = {
      ...raisingOn(ADA), progress: (st) => stages.push(st),
      builder: { governedCall: async () => { throw new Error('you are not a signer'); } } as never,
    };
    /* RED WHEN: anything is filed for a raise this device could not prove. */
    await expect(raiseRunOnDevice(failing, { runId, ...RAISE })).rejects.toThrow('you are not a signer');
    expect(filedNow()).toEqual(before);
    /* RED WHEN: the order changes - above all, the chain read or the proof before the vault is asked and the records are written. */
    expect(stages).toEqual(['checking-the-vault', 'writing-down', 'reading-the-chain', 'building']);
  });

  it('A SECOND RUN FOR THE MONTH OVER THE SAME PEOPLE IS NOT RAISED BESIDE THE FIRST', async () => {
    const second = (await drawRunHere(drawingOn(ADA), { period: '2026-11' })).id;
    await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    const before = filedNow();
    /* RED WHEN: the device raises a run over people another run for the month was raised to pay. */
    await expect(raiseRunOnDevice(raisingOn(ADA), { runId: second, ...RAISE }))
      .rejects.toThrow(new RegExp(`run ${runId} has already been raised for 2026-11 to pay some of the same people`));
    expect(filedNow()).toEqual(before);
  });

  it('THE SERVICE FILES THE RUN ONLY WITH ITS PROPOSAL, SIGNED BY THE SAME SEAT, ADDING THAT ONE PROPOSAL, AND ONLY WHEN THE VAULT\'S PUBLIC MONEY CAN PAY', async () => {
    let filed: { proposal: unknown; run?: unknown; pays?: unknown; tx: string } | undefined;
    const capture = raisingOn(ADA);
    const caught: LegRaiseDoors = { ...capture, service: { ...capture.service, file: async (_a, body) => { filed = body as never; throw new Error('held'); } } };
    await expect(raiseRunOnDevice(caught, { runId, ...RAISE })).rejects.toThrow('held');
    const body = filed!;
    const post = (b: unknown) => sendAs('ada')(`/api/accounts/${CO}/proposals`, { method: 'POST', body: JSON.stringify(b) });
    const before = filedNow();
    const bosRun = signRunFiling(CO, sealedRunOf(openSealedRun(body.run as never, KEY), KEY, 0), BO.signingSecret as Hex);
    const twoAdded = signRunFiling(CO, { ...sealedRunOf(openSealedRun(body.run as never, KEY), KEY, 0), proposalIds: [...(body.run as { proposalIds: string[] }).proposalIds, 'prp_another0000'] }, ADA.signingSecret as Hex);
    for (const [b, says] of [
      [{ ...body, run: bosRun }, /signed by two different keys/],
      [{ ...body, run: twoAdded }, /does not add exactly this proposal/],
      [{ ...body, pays: undefined }, /does not say what it pays/],
    ] as const) {
      /* RED WHEN: the service files a run raised with another seat's key, one naming proposals it did not raise, or one whose payments it cannot ask the vault for. */
      const r = await post(b);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(String((r.body as { error: string }).error)).toMatch(says);
      expect(filedNow()).toEqual(before);
    }
    publicRefuses = 'the vault holds 3 of TEST publicly and this raise pays 1400123. Nothing was raised.';
    /* RED WHEN: the vault's public money is not asked before the raise is written down. */
    const refused = await post(body);
    expect(refused.status).toBe(422);
    expect(filedNow()).toEqual(before);
    publicRefuses = null;
    const r = await post(body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(store.getRun(runId)!.status).toBe('proposed');
  });

  /** Two raises of this test's run, each made and held on Ada's device before anything is filed. */
  const twoRaisesHeld = async (): Promise<Array<{ proposal: SignedProposalFiling; run: unknown; pays: { vault: string; asset: string; payments: Array<{ kind: string; token: string; amount: string }> }; salt: string; tx: string; version: string }>> => {
    const bodies: never[] = [];
    for (let i = 0; i < 2; i++) {
      const capture = raisingOn(ADA);
      const caught: LegRaiseDoors = { ...capture, service: { ...capture.service, file: async (_a, b) => { bodies.push(b as never); throw new Error('held'); } } };
      await expect(raiseRunOnDevice(caught, { runId, ...RAISE })).rejects.toThrow('held');
    }
    return bodies;
  };
  const filingOf = (b: { proposal: SignedProposalFiling }) => {
    const { filedBy: _signature, ...rest } = b.proposal;
    return rest;
  };

  it('THE VAULT\'S PUBLIC MONEY IS ASKED FOR WHAT THE PROPOSAL ITSELF COMMITS TO PAYING, FROM THE VAULT ITS IDENTITY NAMES', async () => {
    const [body] = await twoRaisesHeld();
    const post = (b: unknown) => sendAs('ada')(`/api/accounts/${CO}/proposals`, { method: 'POST', body: JSON.stringify(b) });
    const before = filedNow();
    const less = { ...body!.pays, payments: body!.pays.payments.map((p) => ({ ...p, amount: '1' })) };
    /* RED WHEN: the service asks the vault for payments the page declares rather than the ones the proposal commits to. */
    const fewer = await post({ ...body, pays: less });
    expect(fewer.status).toBe(422);
    expect(String((fewer.body as { error: string }).error)).toMatch(/not what its proposal commits to paying/u);
    /* A vault other than the proposal's, with a filing re-signed by Ada to commit to it, so only the vault is wrong. */
    const OTHER_VAULT = 'd6'.repeat(32);
    const elsewhere = { ...body!.pays, vault: OTHER_VAULT };
    const resigned = signProposalFiling(CO, { ...filingOf(body!), pays: paysCommitmentOf(elsewhere, body!.salt) }, ADA.signingSecret as Hex);
    /* RED WHEN: the vault the public money is asked of is not compared with the vault the proposal's identity names. */
    const other = await post({ ...body, proposal: resigned, pays: elsewhere });
    expect(other.status).toBe(422);
    expect(String((other.body as { error: string }).error)).toMatch(/not the vault its proposal is raised for/u);
    /* RED WHEN: a proposal's filing that does not commit to what it pays is filed with a run. */
    const unpaying = signProposalFiling(CO, { ...filingOf(body!), pays: undefined }, ADA.signingSecret as Hex);
    expect(String(((await post({ ...body, proposal: unpaying })).body as { error: string }).error)).toMatch(/not what its proposal commits to paying/u);
    expect(publicAsks).toEqual([]);
    expect(filedNow()).toEqual(before);
    /* RED WHEN: what the vault is asked for is not what the proposal pays. */
    expect((await post(body)).status).toBe(200);
    expect(JSON.parse(publicAsks[0]!)).toEqual({ vault: VAULT, asset: body!.pays.asset, payments: body!.pays.payments });
  });

  it('TWO RAISES OF ONE RUN FILED AT ONCE: ONE IS WRITTEN DOWN, AND THE OTHER IS REFUSED BY NAME WITHOUT DROPPING IT', async () => {
    const [first, second] = await twoRaisesHeld();
    const post = (b: unknown) => sendAs('ada')(`/api/accounts/${CO}/proposals`, { method: 'POST', body: JSON.stringify(b) });
    let release!: () => void;
    holdThePublicMoney = new Promise<void>((r) => { release = r; });
    const both = [post(first), post(second)];
    /* Both have read the run and wait on the vault's public money before either writes. */
    while (publicAsks.length < 2) await new Promise((r) => setTimeout(r, 5));
    release();
    const [a, b] = await Promise.all(both);
    const statuses = [a!.status, b!.status].sort();
    /* RED WHEN: the run is written back with no condition, so the second raise is filed over the first and drops its proposal. */
    expect(statuses).toEqual([200, 422]);
    const loser = (a!.status === 422 ? a : b)!;
    expect(String((loser.body as { error: string }).error)).toMatch(new RegExp(`another raise of run ${runId} was written down while this one was checked`));
    const winner = a!.status === 200 ? first! : second!;
    expect(store.getRun(runId)!.proposalIds).toEqual([winner.proposal.id]);
    /* RED WHEN: the refused raise's proposal is written down though its run was not. */
    expect(store.getProposal((winner === first ? second : first)!.proposal.id)).toBeNull();
    expect(open.size).toBe(1);
  });

  it('THE RUN AS RAISED AND ITS PROPOSAL ARE WRITTEN IN ONE WRITE: NO WRITE EVER HOLDS A RUN NAMING A PROPOSAL THE STORE DOES NOT', async () => {
    /* What the store held at each of its writes during the raise: the run's proposals that the store did not hold. */
    const unwritten: string[][] = [];
    const writes = vi.spyOn(store as unknown as { flush: () => void }, 'flush').mockImplementation(() => {
      const kept = store.getRun(runId);
      unwritten.push((kept?.proposalIds ?? []).filter((id) => store.getProposal(id) === null));
    });
    try {
      const round = await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
      expect(store.getRun(runId)!.proposalIds).toEqual([round.id]);
    } finally {
      writes.mockRestore();
    }
    /* RED WHEN: the run as raised is written in a write of its own before its proposal, so a failure between leaves a run naming a proposal never written. */
    expect(unwritten.length).toBeGreaterThan(0);
    expect(unwritten.filter((ids) => ids.length > 0)).toEqual([]);
  });

  it('A RAISE SENT AGAIN IS HELD TO WHAT ITS PROPOSAL COMMITS TO PAYING: A RUN RE-FILED TO PAY OTHERWISE AFTER IT WAS WRITTEN DOWN IS NOT SENT', async () => {
    dropTheSend = true;
    await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE })).rejects.toThrow();
    dropTheSend = false;
    const kept = store.getRun(runId)!;
    const run = openSealedRun(kept, KEY);
    const leg = Object.keys(run.payout!)[0] as keyof NonNullable<typeof run.payout>;
    const proposalId = run.proposalIds[leg]!;
    expect(store.getProposal(proposalId)?.txRef).toBeUndefined();
    /* A believed seat re-files the run with the leg's first payment one unit more, after its proposal was written down. */
    const recorded = run.payout![leg]!;
    const changed = { ...run, payout: { ...run.payout, [leg]: { ...recorded, facts: recorded.facts.map((f, i) => (i === 0 ? { ...f, amount: f.amount + 1n } : f)) } } };
    store.putRun({ ...signRunFiling(CO, sealedRunOf(changed, KEY, 0), ADA.signingSecret as Hex), wiring: 'simulated' });
    const sends = proved.length;
    const sending = raisingOn(ADA);
    const again = { ...sending, service: { ...sending.service, sealedProposals: async () => store.listProposals(CO) } };
    /* RED WHEN: what a send again checks is compared with a value made from the same record, so it cannot differ, rather than with the proposal's own commitment. */
    await expect(sendRaiseFromDevice(again, { viewingKey: KEY, runId })).rejects.toThrow(WRITTEN_DOWN_IS_NOT_WHAT_IS_CHECKED);
    expect(proved).toHaveLength(sends);
    /* The run as its proposal was written down is sent. */
    store.putRun(kept);
    await expect(sendRaiseFromDevice(again, { viewingKey: KEY, runId })).resolves.toMatchObject({ id: proposalId });
    expect(proved).toHaveLength(sends + 1);
  });

  it('THE FILING ROUTE FILES NOTHING FOR A SEAT THAT MAY NOT FILE A RUN, A RUN IT DOES NOT KEEP OR KEEPS FOR ANOTHER COMPANY, ANOTHER KEY OR MONTH, OR A RUN NOT RAISED', async () => {
    const [body] = await twoRaisesHeld();
    const raisedRun = openSealedRun(body!.run as never, KEY);
    const asFiled = (r: Record<string, unknown>, by: Seat = ADA) =>
      signRunFiling(CO, { ...sealedRunOf(raisedRun, KEY, 0), ...r } as never, by.signingSecret as Hex);
    const post = (b: unknown, as = 'ada') => sendAs(as)(`/api/accounts/${CO}/proposals`, { method: 'POST', body: JSON.stringify(b) });
    const kept = store.getRun(runId)!;
    /* Another company keeps a run under a name this one's filing names. */
    store.putRun({ ...kept, id: 'run_heldbyothers', accountId: OTHER });
    const bosProposal = signProposalFiling(CO, filingOf(body!), BO.signingSecret as Hex);
    const before = filedNow();
    for (const [why, b, as, says] of [
      ['a seat whose role may not file a run', { ...body, proposal: bosProposal, run: asFiled({}, BO) }, 'bo', /your seat on this company may not raise payroll runs/u],
      ['a run this company does not keep', { ...body, run: asFiled({ id: 'run_notkepthere1' }) }, 'ada', /keeps no payroll run by that name/u],
      ['a run kept for another company', { ...body, run: asFiled({ id: 'run_heldbyothers' }) }, 'ada', /keeps no payroll run by that name/u],
      ['another key epoch', { ...body, run: asFiled({ keyEpoch: 1 }) }, 'ada', /not the run this company keeps under that name, under the key it uses now/u],
      ['another month', { ...body, run: asFiled({ period: '2026-12' }) }, 'ada', /not the run this company keeps under that name, under the key it uses now/u],
      ['a run not raised', { ...body, run: asFiled({ status: 'draft' }) }, 'ada', /a run is raised while it is unpaid, and is kept as raised/u],
    ] as const) {
      const r = await post(b, as);
      /* RED WHEN: the filing route files a raise that refusal names, or refuses it for any other reason. */
      expect(r.status, why).toBe(422);
      expect(String((r.body as { error: string }).error), why).toMatch(says);
      expect(filedNow(), why).toEqual(before);
    }
    /* RED WHEN: a raise is filed over a run the company already holds as settled. */
    store.putRun({ ...kept, status: 'settled' });
    const settled = await post(body);
    expect([settled.status, String((settled.body as { error: string }).error)]).toEqual([422, expect.stringMatching(/a run is raised while it is unpaid/u)]);
    store.putRun(kept);
    /* The raise as made is filed. */
    expect((await post(body)).status).toBe(200);
  });

  it('A RAISE THAT DROPS A PROPOSAL STILL OPEN FROM ITS RUN IS NOT FILED, AND ONE THAT DROPS A WITHDRAWN ONE IS', async () => {
    /* Two raises of the leg, made on Ada's device before either is filed, over two windows: two proposals of their own. */
    const held: Array<{ proposal: SignedProposalFiling }> = [];
    for (const closesAt of [RAISE.closesAt, String(Number(RAISE.closesAt) + 60)]) {
      const capture = raisingOn(ADA);
      const caught: LegRaiseDoors = { ...capture, service: { ...capture.service, file: async (_a, b) => { held.push(b as never); throw new Error('held'); } } };
      await expect(raiseRunOnDevice(caught, { runId, ...RAISE, closesAt })).rejects.toThrow('held');
    }
    const [first, second] = held;
    const post = (b: unknown) => sendAs('ada')(`/api/accounts/${CO}/proposals`, { method: 'POST', body: JSON.stringify(b) });
    expect((await post(first)).status).toBe(200);
    const before = filedNow();
    /* The second raise was made before the first was filed: its run names its own proposal and not the first, which is open. */
    const dropped = await post(second);
    /* RED WHEN: a raise is filed whose run lets go of a proposal that is still open, which can then never be withdrawn from the run. */
    expect(dropped.status).toBe(422);
    expect(String((dropped.body as { error: string }).error)).toMatch(/does not add exactly this proposal/u);
    expect(filedNow()).toEqual(before);
    /* Withdrawn, the first may leave the run, and the leg is raised again as the second. */
    const firstKept = store.getProposal(first!.proposal.id)!;
    store.putProposal({ ...firstKept, status: 'cancelled' });
    expect((await post(second)).status).toBe(200);
    expect(store.getRun(runId)!.proposalIds).toEqual([second!.proposal.id]);
  });

  it('A WINDOW THAT IS NOT WHOLE SECONDS SINCE THE UNIX EPOCH IS REFUSED ON THE DEVICE, FOR A LEG AND A RETRY, AND NOTHING IS FILED', async () => {
    const before = filedNow();
    for (const bound of ['1800000000.5', '1.8e9', ' 1800000000', '-1', '']) {
      for (const window of [{ ...RAISE, opensAt: bound }, { ...RAISE, closesAt: bound }]) {
        /* RED WHEN: a window bound that is not whole seconds is taken, read as another time, or reaches the chain. */
        await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...window }), JSON.stringify(window)).rejects.toThrow(/a window bound is whole seconds since the Unix epoch/u);
        await expect(raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...window, indices: [0] }), JSON.stringify(window)).rejects.toThrow(/a window bound is whole seconds since the Unix epoch/u);
      }
    }
    expect(filedNow()).toEqual(before);
    expect(proved).toHaveLength(0);
  });

  it('ANOTHER SIGNER\'S DEVICE DOES NOT OPEN A PAYROLL PROPOSAL WHOSE FILING COMMITS TO PAYING OTHER THAN THE RUN IT BUILDS AGAIN', async () => {
    const round = await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    const kept = store.getProposal(round.id)!;
    const asFiled = { id: kept.id, digest: kept.digest, chainId: kept.chainId, keyEpoch: kept.keyEpoch, createdAt: kept.createdAt, sealed: kept.sealed };
    /* Ada's seat signs a filing of the same proposal committing to one payment of 1, as a filer misleading the service would. */
    const offBy = signProposalFiling(CO, { ...asFiled, pays: '5a'.repeat(32) as Hex }, ADA.signingSecret as Hex);
    store.putProposal({ ...kept, pays: offBy.pays, filedBy: offBy.filedBy });
    /* RED WHEN: an approver's device does not hold the filing's commitment to the run it builds again. */
    await expect(openTheRoundHere(storedFor(BO), CO, round.id, KEY, false, recordsOn(BO)))
      .rejects.toThrow(/says it pays is not what this device builds the run to pay/u);
    /* RED WHEN: a payroll proposal a seat filed with no commitment to what it pays is opened as if it had one. */
    const none = signProposalFiling(CO, asFiled, ADA.signingSecret as Hex);
    store.putProposal({ ...kept, pays: undefined, filedBy: none.filedBy });
    await expect(openTheRoundHere(storedFor(BO), CO, round.id, KEY, false, recordsOn(BO)))
      .rejects.toThrow(/says it pays is not what this device builds the run to pay/u);
    store.putProposal(kept);
    await expect(openTheRoundHere(storedFor(BO), CO, round.id, KEY, false, recordsOn(BO))).resolves.toBeTruthy();
  });

});

/* ── A RETRY OF SOME OF A LEG'S PEOPLE ────────────────────────────────────── */

/** After the leg's window has closed, and a retry's window after that. */
const AFTER = NOW + 7300;
const RETRY = { viewingKey: KEY, vault: VAULT, opensAt: String(NOW + 8000), closesAt: String(NOW + 9000) };
/**
 * An approver's device judged at `at`, by its own clock: a retry is approved
 * only once its leg's own round can no longer pay everybody on it.
 */
const atTime = async <T>(at: number, act: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at * 1000);
  try {
    return await act();
  } finally {
    vi.useRealTimers();
  }
};
const legOf = (id: string) => {
  const run = openSealedRun(store.getRun(id)!, KEY);
  return run.payout![Object.keys(run.payout!)[0] as never]!;
};

/* ── A RUN FROM A VAULT UNDER A SPENDING POLICY ───────────────────────────── */

/** The vault's policy for the leg's currency, as a seat filed it and the chain holds it: four bands, a limit and the periods. */
const aPolicyOnTheVault = (terms: {
  bands: Array<{ ceiling: string; approvals: string }>; periodLimit: string; periodStart: string; periodLength: string;
}): void => {
  const asset = assetIdHex(TEST_SETTLEMENT_ASSET);
  const opening = { terms, blinding: 'b5'.repeat(32) };
  const keys = spendingPolicyKeysOf({ accountPure: P }, { vault: VAULT, asset, assetBlinding: STATE_BLINDING.assetBlinding, policy: opening });
  const signers = [ADA, BO].map((x) => ({ id: x.seat, wrappingPublicKey: recordsKeypairFrom(new Uint8Array(32).fill(x.n + 100)).publicKey }));
  policyVersions.push(signCompanyFiling(sealSpendingPolicy({
    company: CO, id: keys.policyKey as Hex, version: 1, keyEpoch: 0, secrets: { vault: VAULT, asset: asset as Hex, opening }, signers,
  }), ADA.signingSecret as Hex));
  roles.set(keys.onKey, MARK);
  roles.set(keys.policyKey, keys.commitment!);
};
/* The leg pays 700061 and 700062: 1400123 in all, in the second band, which needs two approvals. */
const BANDS = [
  { ceiling: '1000', approvals: '1' }, { ceiling: '2000000', approvals: '2' }, { ceiling: '3000000', approvals: '2' }, { ceiling: '4000000', approvals: '3' },
];
const ONE_LONG_PERIOD = { bands: BANDS, periodLimit: '1000000000', periodStart: '0', periodLength: '10000000000' };
/** What paying a leg is made with on a device: the contract's own circuits, and nobody yet recorded paid. */
const PAYING = {
  detailsOf: vaultDetails, runPayload: pureCircuits.runPayload, proposalIdOf: pureCircuits.proposalIdOf, paidAmong: async () => null,
};

describe('A RUN FROM A VAULT UNDER A SPENDING POLICY IS RAISED AT ITS BAND, AND ONLY WHEN THE CHAIN WILL CHARGE IT', () => {
  it('IS RAISED NEEDING THE APPROVALS ITS BAND NEEDS, READ THROUGH THE PERSON\'S OWN WALLET, AND ANOTHER SIGNER\'S DEVICE BUILDS IT AGAIN AND APPROVES IT', async () => {
    aPolicyOnTheVault(ONE_LONG_PERIOD);
    const round = await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    const proposal = store.getProposal(round.id)!;
    const leg = Object.values(openSealedRun(store.getRun(runId)!, KEY).payout!)[0]!;
    /* RED WHEN: the raise binds no approvals into the run, so the chain would refuse to charge it after every approval and fee. */
    expect(proposal.digest).toBe(toHex(pureCircuits.runPayload(fromHex(leg.root), leg.payees, leg.opensAt, leg.closesAt, 2n)));
    /* RED WHEN: the run as filed does not keep the approvals it was raised needing, so no other device can build it again. */
    expect(leg.required).toBe(2n);
    /* RED WHEN: the vault's marker and the policy's commitment are read anywhere but through the person's own wallet. */
    expect(rolesAsked.flat()).toEqual(expect.arrayContaining([...roles.keys()]));
    /* RED WHEN: another signer's device does not build the same run again, and run the policy check, and approve it. */
    const { made } = await runRebuiltHere(recordsOn(BO), CO, round.id, KEY);
    expect(made.required).toBe('2');
    const asked = rolesAsked.length;
    await expect(approvingOn(recordsOn(BO), round.id)).resolves.toMatchObject({ vault: VAULT });
    /* RED WHEN: the approving device does not read the policy itself. */
    expect(rolesAsked.length).toBeGreaterThan(asked);
    /* RED WHEN: the device that pays it makes its identity again without the approvals it was raised needing, and refuses the approved run after every fee. */
    await expect(privatePaymentsHere(recordsOn(BO), CO, runId, KEY, PAYING)).resolves.toMatchObject({ proposal: proposal.chainId });
    /* RED WHEN: the paying device charges the run as another proposal, or at other approvals than its identity was made again with. */
    await expect(legToPayHere(recordsOn(BO), CO, runId, KEY, PAYING)).resolves.toMatchObject({ proposalId: round.id, order: { required: '2' } });
  });

  it('A RAISE FROM THE VAULT THAT DID NOT REACH THE CHAIN IS SENT AGAIN AT THE APPROVALS IT WAS WRITTEN DOWN NEEDING', async () => {
    aPolicyOnTheVault(ONE_LONG_PERIOD);
    dropTheSend = true;
    await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE })).rejects.toThrow();
    dropTheSend = false;
    const run = openSealedRun(store.getRun(runId)!, KEY);
    const proposalId = Object.values(run.proposalIds)[0]!;
    const sending = raisingOn(ADA);
    const again = { ...sending, service: { ...sending.service, sealedProposals: async () => store.listProposals(CO) } };
    /* RED WHEN: a raise sent again drops the approvals its band needs, so its identity is not the one written down and it can never be sent. */
    await expect(sendRaiseFromDevice(again, { viewingKey: KEY, runId })).resolves.toMatchObject({ id: proposalId });
    expect(open.has(store.getProposal(proposalId)!.chainId)).toBe(true);
  });

  it('A RETRY FROM THE VAULT IS RAISED AT THE BAND OF WHAT IT PAYS, KEPT WITH IT, AND APPROVED AT THAT BAND', async () => {
    /* The leg's 1400123 needs two approvals; one person's 700062 needs one. */
    aPolicyOnTheVault({ ...ONE_LONG_PERIOD, bands: [{ ceiling: '1000000', approvals: '1' }, ...BANDS.slice(1)] });
    const leg = await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    const retry = await raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...RETRY, indices: [1] });
    const recorded = Object.values(openSealedRun(store.getRun(runId)!, KEY).payout!)[0]!;
    /* RED WHEN: a retry is raised at the leg's band, or at none - it is charged on its own total. */
    expect(recorded.required).toBe(2n);
    expect(recorded.retries?.[0]?.required).toBe(1n);
    const r = recorded.retries![0]!;
    expect(store.getProposal(retry.id)!.digest).toBe(toHex(pureCircuits.runPayload(fromHex(r.root), r.payees, r.opensAt, r.closesAt, 1n)));
    /* RED WHEN: another signer's device does not build the retry again at the approvals it was raised needing. */
    await expect(atTime(AFTER, () => approvingOn(recordsOn(BO), retry.id))).resolves.toMatchObject({ vault: VAULT });
    expect(leg.id).not.toBe(retry.id);
    /* RED WHEN: the device that pays the retry makes its identity again at the leg's approvals, or at none. */
    await expect(privatePaymentsHere(recordsOn(BO), CO, runId, KEY, PAYING, undefined, retry.id))
      .resolves.toMatchObject({ proposal: store.getProposal(retry.id)!.chainId });
    /* RED WHEN: the retry is charged as its leg's proposal, or at the leg's approvals. */
    await expect(legToPayHere(recordsOn(BO), CO, runId, KEY, PAYING, undefined, retry.id)).resolves.toMatchObject({ proposalId: retry.id, order: { required: '1' } });
  });

  it('A RETRY FROM THE VAULT THAT DID NOT REACH THE CHAIN IS SENT AGAIN AT THE APPROVALS IT WAS WRITTEN DOWN NEEDING', async () => {
    /* One person's 700062 needs one approval: the retry is written down needing one, not none. */
    aPolicyOnTheVault({ ...ONE_LONG_PERIOD, bands: [{ ceiling: '1000000', approvals: '1' }, ...BANDS.slice(1)] });
    await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    dropTheSend = true;
    await expect(raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...RETRY, indices: [1] })).rejects.toThrow();
    dropTheSend = false;
    const written = Object.values(openSealedRun(store.getRun(runId)!, KEY).payout!)[0]!.retries![0]!;
    expect(written.required).toBe(1n);
    const proposalId = written.proposalId!;
    expect(open.has(store.getProposal(proposalId)!.chainId)).toBe(false);
    const sending = raisingOn(ADA, AFTER);
    const again = { ...sending, service: { ...sending.service, sealedProposals: async () => store.listProposals(CO) } };
    /* RED WHEN: a retry sent again drops the approvals its band needs, so its identity is not the one written down and it can never be sent. */
    await expect(atTime(AFTER, () => sendRetryFromDevice(again, { viewingKey: KEY, runId, proposalId }))).resolves.toMatchObject({ id: proposalId });
    expect(open.has(store.getProposal(proposalId)!.chainId)).toBe(true);
  });

  it('A VAULT WITH NO POLICY MARKER IS RAISED AS IT ALWAYS WAS, NEEDING NO APPROVALS BEYOND ITS OWN', async () => {
    const round = await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    const leg = Object.values(openSealedRun(store.getRun(runId)!, KEY).payout!)[0]!;
    /* RED WHEN: a vault with no policy is raised any differently from before. */
    expect(store.getProposal(round.id)!.digest).toBe(toHex(pureCircuits.runPayload(fromHex(leg.root), leg.payees, leg.opensAt, leg.closesAt, 0n)));
  });

  it('A WINDOW CROSSING FROM ONE PERIOD INTO THE NEXT, A TOTAL ABOVE EVERY BAND, AND ONE OVER THE LIMIT PER PERIOD ARE REFUSED BEFORE ANYTHING IS WRITTEN OR PROVED', async () => {
    const cases = [
      ['a window across two periods', { ...ONE_LONG_PERIOD, periodStart: String(NOW), periodLength: '5400' }, /does not lie inside one period/u],
      ['a window before the first period', { ...ONE_LONG_PERIOD, periodStart: String(NOW + 4000) }, /does not lie inside one period/u],
      ['a total above every band', { ...ONE_LONG_PERIOD, bands: BANDS.map((b) => ({ ...b, ceiling: '1000' })) }, /this run's total is above every band of the spending policy/u],
      ['a total over the limit', { ...ONE_LONG_PERIOD, periodLimit: '1400122' }, /more than the vault it is paid from may pay in one period/u],
    ] as const;
    for (const [why, terms, says] of cases) {
      roles.clear();
      policyVersions.length = 0;
      aPolicyOnTheVault({ ...terms, bands: [...terms.bands] });
      const before = filedNow();
      /* RED WHEN: a run the chain would never charge is raised, its approvals collected and its fees spent. */
      await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE }), why).rejects.toThrow(says);
      expect(filedNow(), why).toEqual(before);
      expect(proved, why).toHaveLength(0);
    }
    roles.clear();
    policyVersions.length = 0;
    aPolicyOnTheVault({ ...ONE_LONG_PERIOD, periodLimit: '1400123' });
    /* The control: exactly the limit, inside one period, in a band. */
    await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE })).resolves.toBeTruthy();
  });

  it('AN APPROVER REFUSES A ROUND NEEDING FEWER APPROVALS THAN ITS BAND, AS ITS OWN DEVICE READS THE POLICY NOW', async () => {
    /* Raised from a vault with no policy, needing none; the vault is then put under a policy. */
    const round = await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    aPolicyOnTheVault(ONE_LONG_PERIOD);
    /* RED WHEN: the policy check runs only where a round is raised, so an approver collects approvals the chain will not charge. */
    await expect(approvingOn(recordsOn(BO), round.id)).rejects.toThrow(/raised needing 0 approvals, and its band .* needs 2/u);
  });

  it('A RAISE AND A RETRY ARE EACH DECIDED ON ONE READ OF THE COMPANY\'S PROPOSALS AND ONE READ OF THE VAULT\'S POLICY', async () => {
    aPolicyOnTheVault({ ...ONE_LONG_PERIOD, bands: [{ ceiling: '1000000', approvals: '1' }, ...BANDS.slice(1)] });
    let reads = 0;
    const counted = (at?: number): LegRaiseDoors => {
      const doors = raisingOn(ADA, at);
      return { ...doors, records: { ...doors.records, proposals: async () => { reads += 1; return store.listProposals(CO); } } };
    };
    const policyReads = rolesAsked.length;
    await raiseRunOnDevice(counted(), { runId, ...RAISE });
    /* RED WHEN: the raise checks read the proposals or the policy again, so the raise is decided on two reads that can disagree. */
    expect([reads, rolesAsked.length - policyReads]).toEqual([1, 1]);
    reads = 0;
    const before = rolesAsked.length;
    await raiseRetryOnDevice(counted(AFTER), { runId, ...RETRY, indices: [1] });
    /* RED WHEN: the retry's own refusals and the raise checks each read the proposals for themselves. */
    expect([reads, rolesAsked.length - before]).toEqual([1, 1]);
  });

  it('A DEVICE THAT CANNOT READ THE VAULT\'S POLICY RAISES NOTHING, AND NOTHING IS WRITTEN', async () => {
    const before = filedNow();
    const { spendingPolicies: _none, ...withoutPolicies } = recordsOn(ADA);
    /* RED WHEN: a device that cannot tell whether the vault has a policy raises as if it had none. */
    await expect(raiseRunOnDevice({ ...raisingOn(ADA), records: withoutPolicies }, { runId, ...RAISE }))
      .rejects.toThrow(/could not read the spending policy of the vault this run is paid from/u);
    expect(filedNow()).toEqual(before);
    expect(proved).toHaveLength(0);
  });
});

describe('A RETRY IS RAISED ON THE SIGNER\'S DEVICE, OVER A TREE OF ONLY THE PEOPLE IT NAMES', () => {
  it('IS FILED WITH THE RUN AS RAISED, OVER ITS OWN TREE, AND ANOTHER SIGNER\'S DEVICE BUILDS IT AGAIN', async () => {
    await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    const leg = legOf(runId);
    const round = await raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...RETRY, indices: [1] });
    const retry = legOf(runId).retries!.find((r) => r.proposalId === round.id)!;
    /* RED WHEN: the retry is raised over the leg's whole tree - its approval then lets anybody on the leg be paid. */
    expect(retry.originalIndices).toEqual([1]);
    expect(retry.payees).toBe(1n);
    expect(retry.root).not.toBe(leg.root);
    /* RED WHEN: the retry is not filed with the run, or the run loses the seat's signature. */
    expect(store.getRun(runId)!.proposalIds).toContain(round.id);
    expect(store.getRun(runId)!.filedBy?.publicKey).toBe(ADA.statement.signingKey);
    expect(open.has(store.getProposal(round.id)!.chainId)).toBe(true);
    /* RED WHEN: the retry another signer's device builds again is not the one raised. */
    const { made } = await runRebuiltHere(recordsOn(BO), CO, round.id, KEY);
    expect(made.retry).toEqual([1]);
    const proposal = store.getProposal(round.id)!;
    expect(() => refuseWhatThisDeviceDidNotMake({
      runPayload: pureCircuits.runPayload, vaultDetails, payKeyCommitmentOf: pureCircuits.payKeyCommitmentOf,
    }, { chainId: proposal.chainId, digest: proposal.digest, made }, theChainNow())).not.toThrow();
    /* RED WHEN: the vault's public money is asked about the leg's people rather than the retry's one. */
    expect((JSON.parse(publicAsks.at(-1)!) as { payments: Array<{ amount: string }> }).payments.map((p) => p.amount)).toEqual([String(leg.facts![1]!.amount)]);
    /* RED WHEN: an approver holds a retry's commitment to the leg's whole list of payments rather than the people it names. */
    await expect(atTime(AFTER, () => openTheRoundHere(storedFor(BO), CO, round.id, KEY, false, recordsOn(BO)))).resolves.toMatchObject({ vault: VAULT });
  });

  it('A RETRY THAT NAMES NOBODY, SOMEBODY TWICE OR NOBODY ON THE LEG, OR OF A LEG NOT RAISED, IS REFUSED AND NOTHING IS FILED', async () => {
    const before = filedNow();
    /* RED WHEN: a retry of a leg with no round on the chain is raised. */
    await expect(raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...RETRY, indices: [0] })).rejects.toThrow(/has not been raised/);
    expect(filedNow()).toEqual(before);
    await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    const raised = filedNow();
    for (const [indices, says] of [[[], /names nobody/], [[0, 0], /named twice/], [[5], /there is no person 5/]] as const) {
      /* RED WHEN: a retry naming nobody, somebody twice or somebody not on the leg is raised. */
      await expect(raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...RETRY, indices: [...indices] })).rejects.toThrow(says);
      expect(filedNow()).toEqual(raised);
    }
  });

  it('A RETRY OF A LEG THE CHAIN WAS NEVER SEEN TO HOLD, OR OF A LEG WHOSE RECORD DOES NOT BUILD ITS LEAVES AGAIN, IS REFUSED', async () => {
    dropTheSend = true;
    await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE })).rejects.toThrow(/dropped the connection/);
    dropTheSend = false;
    /* RED WHEN: a retry is raised on a leg whose own round never reached the chain. */
    await expect(raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...RETRY, indices: [0] })).rejects.toThrow(/has no round the chain has been seen to hold/);
    const other = (await drawRunHere(drawingOn(ADA), { period: '2026-12' })).id;
    await raiseRunOnDevice(raisingOn(ADA), { runId: other, ...RAISE });
    const kept = openSealedRun(store.getRun(other)!, KEY);
    const leg = Object.keys(kept.payout!)[0] as keyof typeof kept.payout;
    const swapped = { ...kept, payout: { ...kept.payout!, [leg]: { ...kept.payout![leg]!, leaves: ['ee'.repeat(32), ...kept.payout![leg]!.leaves.slice(1)] } } };
    store.putRun({ ...signRunFiling(CO, sealedRunOf(swapped as never, KEY, 0), ADA.signingSecret as Hex), wiring: 'simulated' });
    /* RED WHEN: a retry is built from leaves its leg's record holds without building them again here - it would pay at other leaves. */
    await expect(raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId: other, ...RETRY, indices: [0] })).rejects.toThrow(/does not build its own leaves again/);
  });

  it('WHILE THE LEG CAN STILL PAY, OR ANOTHER RETRY CAN, OR ONE WRITTEN DOWN IS NOT YET SENT, A RETRY OF THE SAME PEOPLE IS REFUSED', async () => {
    await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    /* RED WHEN: a retry is raised while the leg's own round can still pay the same people. */
    await expect(raiseRetryOnDevice(raisingOn(ADA, NOW), { runId, ...RETRY, indices: [0] })).rejects.toThrow(/can still pay everybody on it until/);
    const first = await raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...RETRY, indices: [0] });
    /* RED WHEN: a second retry covers somebody a live retry can still pay. */
    await expect(raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...RETRY, indices: [0, 1] }))
      .rejects.toThrow(new RegExp(`#1 is already on retry ${first.id}`));
    dropTheSend = true;
    await expect(raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...RETRY, indices: [1] })).rejects.toThrow(/dropped the connection/);
    dropTheSend = false;
    /* RED WHEN: a retry written down and not sent is raised again as a second round, rather than sent as itself. */
    await expect(raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...RETRY, indices: [1] })).rejects.toThrow(/already written down, as prp_/);
  });

  it('A RETRY OF SOMEBODY THE CHAIN RECORDS PAID FOR THE MONTH IS REFUSED WHERE IT IS PROVED', async () => {
    await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    const record = legOf(runId).records![0]!;
    movements.add(paidOnceOfNonce(payRecordNonceOf(STATE_BLINDING.payRecordKey as Hex, record)));
    /* Paid by the leg's own round: both entries a payment leaves, each known to the company's records. */
    movements.add(paidMovementOfLeaf(legOf(runId).leaves[0]!));
    const before = filedNow();
    /* RED WHEN: a retry is proved over somebody the chain already records paid for the month. */
    await expect(raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...RETRY, indices: [0] })).rejects.toThrow(/already recorded as paid/);
    expect(filedNow()).toEqual(before);
    /* RED WHEN: who is paid is read from the account state the service serves, which here says nobody is, and not by the wallet. */
    servedLies = true;
    await expect(raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...RETRY, indices: [0] })).rejects.toThrow(/already recorded as paid/);
    expect(filedNow()).toEqual(before);
  });

  it('A SERVED STATE THAT LIES ABOUT THE PAY-RECORD KEY OR WHO IS PAID CHANGES NOTHING: THE WALLET\'S READ IS WHAT IS CHECKED', async () => {
    servedLies = true;
    /* RED WHEN: the pay-record key is held to the commitment the service served rather than the one the wallet read. */
    const sent = await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    expect(sent.raisedAt).toBeTruthy();
    /* RED WHEN: the wallet is not asked about the payments of everybody the run pays. */
    const record = legOf(runId).records!;
    expect(walletReads.at(-1)).toEqual(record.map((r) => paidOnceOfNonce(payRecordNonceOf(STATE_BLINDING.payRecordKey as Hex, r))));
  });
});

/* ── THE RAISE CHECKS: ONE LIST, RUN BY THE RAISER AND BY EVERY APPROVER ──── */

/** Bo's device, reading the company's people with `p` of them as people it does not believe. */
const doubting = (...people: string[]): CompanyRecordsHere => ({
  ...recordsOn(BO),
  people: async () => {
    const read = await readPeopleHere(peopleOn(BO));
    return { ...read, notBelieved: [...read.notBelieved, ...people] };
  },
});
const approvingOn = (records: CompanyRecordsHere, id: string) => openTheRoundHere(storedFor(BO), CO, id, KEY, false, records);

describe('THE RAISE CHECKS ARE ONE LIST, RUN WHERE A ROUND IS RAISED AND AGAIN WHEREVER IT IS APPROVED', () => {
  it('EVERY CHECK ON THE LIST RUNS WHERE A LEG IS RAISED, WHERE A RETRY IS RAISED, AND WHERE EACH IS APPROVED', async () => {
    const ran: string[] = [];
    const list = RAISE_CHECKS as RaiseCheck[];
    list.push({ name: 'watched', check: (r) => { ran.push(r.made.retry === undefined ? 'leg' : `retry ${r.made.retry.join()}`); } });
    try {
      const leg = await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
      await approvingOn(recordsOn(BO), leg.id);
      const retry = await raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...RETRY, indices: [1] });
      await atTime(AFTER, () => approvingOn(recordsOn(BO), retry.id));
    } finally {
      list.pop();
    }
    /* RED WHEN: a raise, a retry or an approval of either skips the list, or runs a list of its own. */
    expect(ran).toEqual(['leg', 'leg', 'retry 1', 'retry 1']);
  });

  it('AN APPROVER REFUSES A LEG OVER THE COMPANY\'S CEILING, AND THE REFUSAL DOES NOT SAY THE SERVICE APPLIES IT', async () => {
    const round = await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    /* The company's own ceiling, as the approving device reads it now, is lower than the leg pays. */
    policy = { threshold: 1, limitsByRole: { admin: { [TEST_SETTLEMENT_ASSET]: { perTransaction: 1000n } } } };
    const refused = await approvingOn(recordsOn(BO), round.id).catch((e: Error) => e);
    /* RED WHEN: an approver does not run the ceiling the raiser ran, judged for the seat that filed the proposal. */
    expect(String((refused as Error).message)).toMatch(/this company's own policy, which the chain does not apply: .* per-transaction .* for role "admin"/u);
    /* RED WHEN: the ceiling's refusal still says the service applies it. */
    expect(String((refused as Error).message)).not.toMatch(/applied by this service/u);
    policy = { threshold: 1, limitsByRole: {} };
    await expect(approvingOn(recordsOn(BO), round.id)).resolves.toMatchObject({ vault: VAULT });
  });

  it('AN APPROVER REFUSES WHILE THE CHAIN, AS ITS OWN WALLET READS IT, HOLDS A ROUND THE COMPANY\'S RECORDS DO NOT', async () => {
    const round = await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    open.set('ef'.repeat(32), 0);
    /* RED WHEN: an approver does not run the check the raiser ran, or runs it on the account state the service serves. */
    servedLies = true;
    await expect(approvingOn(recordsOn(BO), round.id)).rejects.toThrow(/1 open round .* that this company's records cannot account for/u);
    servedLies = false;
    open.delete('ef'.repeat(32));
    await expect(approvingOn(recordsOn(BO), round.id)).resolves.toMatchObject({ vault: VAULT });
  });

  it('AN APPROVER REFUSES A LEG PAYING SOMEBODY IT WOULD NOT PAY', async () => {
    const round = await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    const second = openSealedRun(store.getRun(runId)!, KEY).employees[1]!;
    /* RED WHEN: an approver of a leg does not hold everybody on it to the people it believes. */
    await expect(approvingOn(doubting(second.id), round.id)).rejects.toThrow(new RegExp(`${second.name} is on this run, and this device does not believe`, 'u'));
  });

  it('A RETRY IS APPROVED WHEN SOMEBODY IT DOES NOT NAME HAS LEFT, AND REFUSED WHEN SOMEBODY IT NAMES HAS', async () => {
    await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    const round = await raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...RETRY, indices: [1] });
    const [first, second] = openSealedRun(store.getRun(runId)!, KEY).employees;
    /* RED WHEN: an approver of a retry holds everybody on the leg to the people it believes, so one who left blocks every retry. */
    await expect(atTime(AFTER, () => approvingOn(doubting(first!.id), round.id))).resolves.toMatchObject({ vault: VAULT });
    /* RED WHEN: an approver of a retry does not hold the people it names to the people it believes. */
    await expect(atTime(AFTER, () => approvingOn(doubting(second!.id), round.id))).rejects.toThrow(new RegExp(`${second!.name} is on this run, and this device does not believe`, 'u'));
  });
});

/* ── THE CHECKS ON A LEG'S ROUNDS AND A RETRY'S, RUN BY EVERY APPROVER ────── */

/** A window for the leg raised again after the first one's has closed. */
const LATER = { viewingKey: KEY, vault: VAULT, opensAt: String(AFTER + 100), closesAt: String(AFTER + 3600) };
/** The company's record of a proposal, set to `status` where it is kept, as a withdrawal that did or did not take. */
const standing = (id: string, status: 'open' | 'cancelled') => store.putProposal({ ...store.getProposal(id)!, status });

describe('EVERY APPROVER OF A ROUND RUNS THE CHECKS ITS RAISER RAN ON THE LEG\'S OTHER ROUNDS', () => {
  it('A LEG RAISED AGAIN IS REFUSED BY AN APPROVER WHILE A RETRY ON IT CAN STILL PAY SOME OF ITS PEOPLE', async () => {
    const first = await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    const retry = await raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...RETRY, indices: [1] });
    standing(retry.id, 'cancelled');
    standing(first.id, 'cancelled');
    const again = await raiseRunOnDevice(raisingOn(ADA, AFTER), { runId, ...LATER });
    /* The company's records hold the retry live after all: its withdrawal did not take. */
    standing(retry.id, 'open');
    /* RED WHEN: an approver of a leg does not ask whether a retry on it can still pay some of the same people. */
    await expect(approvingOn(recordsOn(BO), again.id)).rejects.toThrow(new RegExp(`a retry on it is still live \\(${retry.id}\\)`, 'u'));
    standing(retry.id, 'cancelled');
    /* RED WHEN: an approver refuses the leg's round because the run points at it - the proposal it is approving. */
    await expect(approvingOn(recordsOn(BO), again.id)).resolves.toMatchObject({ vault: VAULT });
  });

  it('A LEG RAISED AGAIN IS REFUSED BY AN APPROVER WHILE THE LEG\'S EARLIER ROUND MAY STILL BE ON THE CHAIN', async () => {
    const first = await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    standing(first.id, 'cancelled');
    const again = await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    /* The company's records hold the first round live after all: its withdrawal did not take. */
    standing(first.id, 'open');
    /* RED WHEN: an approver of a leg does not ask whether another round of the leg may still be on the chain. */
    await expect(approvingOn(recordsOn(BO), again.id)).rejects.toThrow(new RegExp(`is written down as ${first.id}, which may be on the chain`, 'u'));
    standing(first.id, 'cancelled');
    /* RED WHEN: an approver counts the proposal it is approving as another round of the leg. */
    await expect(approvingOn(recordsOn(BO), again.id)).resolves.toMatchObject({ vault: VAULT });
  });

  it('A RETRY IS REFUSED BY AN APPROVER WHILE ITS LEG\'S OWN ROUND CAN STILL PAY, OR WAS NEVER SEEN ON THE CHAIN', async () => {
    const leg = await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    const round = await raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...RETRY, indices: [1] });
    /* RED WHEN: an approver of a retry does not ask whether the leg's own round can still pay everybody on it, by its own clock. */
    await expect(atTime(NOW, () => approvingOn(recordsOn(BO), round.id))).rejects.toThrow(/can still pay everybody on it until/u);
    await expect(atTime(AFTER, () => approvingOn(recordsOn(BO), round.id))).resolves.toMatchObject({ vault: VAULT });
    const kept = store.getProposal(leg.id)!;
    store.putProposal({ ...kept, raisedAt: undefined });
    /* RED WHEN: an approver of a retry does not ask whether the leg's own round was ever seen on the chain. */
    await expect(atTime(AFTER, () => approvingOn(recordsOn(BO), round.id))).rejects.toThrow(/has no round the chain has been seen to hold/u);
    store.putProposal(kept);
  });

  it('A RETRY IS REFUSED BY AN APPROVER WHILE ANOTHER RETRY OF THE LEG CAN STILL PAY SOMEBODY IT NAMES', async () => {
    await raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE });
    const one = await raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...RETRY, indices: [0] });
    standing(one.id, 'cancelled');
    const both = await raiseRetryOnDevice(raisingOn(ADA, AFTER), { runId, ...RETRY, indices: [0, 1] });
    /* The company's records hold the first retry live after all: its withdrawal did not take. */
    standing(one.id, 'open');
    /* RED WHEN: an approver of a retry does not ask whether another retry can still pay somebody it names. */
    await expect(atTime(AFTER, () => approvingOn(recordsOn(BO), both.id))).rejects.toThrow(new RegExp(`#1 is already on retry ${one.id}`, 'u'));
    standing(one.id, 'cancelled');
    /* RED WHEN: an approver counts the retry it is approving as another retry over the same people. */
    await expect(atTime(AFTER, () => approvingOn(recordsOn(BO), both.id))).resolves.toMatchObject({ vault: VAULT });
  });
});

/* Last of all, because the two people it adds stay on the company's roster. */
describe('ONE ADDRESS IS NOT PAID TWICE FOR A MONTH', () => {
  it('TWO PEOPLE PAID AT ONE ADDRESS ARE NOT RAISED, SO THE ADDRESS IS NOT PAID TWICE FOR THE MONTH', async () => {
    for (const r of store.listRuns(CO)) store.putRun({ ...r, accountId: 'acc_set_aside' });
    const one = await aPayee(63, 70);
    const two = await aPayee(64, 70);
    const both = (await drawRunHere(drawingOn(ADA), { period: '2026-12' })).id;
    expect(openSealedRun(store.getRun(both)!, KEY).employees.map((e) => e.id)).toEqual(expect.arrayContaining([one, two]));
    const before = filedNow();
    /* Last, because the two stay on the company's roster. RED WHEN: the device raises a run that pays one address twice for one month. */
    await expect(raiseRunOnDevice(raisingOn(ADA), { runId: both, ...RAISE })).rejects.toThrow(/are paid at the same address/);
    expect(filedNow()).toEqual(before);
  });
});

/* After the two above, who are made leavers first: a person paid publicly, in a token with a public form. */
describe('A PUBLIC PAYEE IS RAISED FROM THE DEVICE AS PUBLIC', () => {
  it('A LEG PAYING A PUBLIC ADDRESS IS RAISED FROM THE DEVICE, ITS PUBLIC MONEY ASKED AS PUBLIC, AND A RAISE NAMING THE PAYMENT PRIVATE IS NOT FILED', async () => {
    for (const r of store.listRuns(CO)) store.putRun({ ...r, accountId: 'acc_set_aside' });
    for (const here of (await readPeopleHere(peopleOn(ADA))).people.filter((p) => ['Payee 63', 'Payee 64'].includes(p.person.name))) {
      await setStatusHere(peopleOn(ADA), here, 'leaver');
    }
    await aPayee(65, 65, { address: unshieldedPayeeFor('65'.repeat(32), NETWORK).bech32, asset: NIGHT });
    const drawn = (await drawRunHere(drawingOn(ADA), { period: '2027-01' })).id;
    let filed: { proposal: SignedProposalFiling; pays: { vault: string; asset: string; payments: Array<{ kind: string; token: string; amount: string }> } } | undefined;
    const capture = raisingOn(ADA);
    const caught: LegRaiseDoors = { ...capture, service: { ...capture.service, file: async (_a, b) => { filed = b as never; throw new Error('held'); } } };
    await expect(raiseRunOnDevice(caught, { runId: drawn, ...RAISE, asset: NIGHT, form: 'unshielded' })).rejects.toThrow('held');
    /* RED WHEN: a public payee's payment is named as anything but public, so the vault is asked for it as private money. */
    expect(filed!.pays.payments.map((p) => [p.kind, p.amount])).toEqual([['unshielded', '700065']]);
    const post = (b: unknown) => sendAs('ada')(`/api/accounts/${CO}/proposals`, { method: 'POST', body: JSON.stringify(b) });
    const before = filedNow();
    const asked = publicAsks.length;
    const asPrivate = { ...filed, pays: { ...filed!.pays, payments: filed!.pays.payments.map((p) => ({ ...p, kind: 'shielded' })) } };
    const refused = await post(asPrivate);
    /* RED WHEN: a raise that names a public payment private is filed, or the vault's public money is asked for it. */
    expect(refused.status).toBe(422);
    expect(String((refused.body as { error: string }).error)).toMatch(/not what its proposal commits to paying/u);
    expect(filedNow()).toEqual(before);
    expect(publicAsks).toHaveLength(asked);
    /* The raise as made is filed, and the vault's public money asked for the public payment. */
    expect((await post(filed)).status).toBe(200);
    expect(JSON.parse(publicAsks.at(-1)!)).toMatchObject({ asset: NIGHT, payments: [{ kind: 'unshielded', amount: '700065' }] });
  });
});
