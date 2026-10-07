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
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode, type JoinCode } from 'midnight-identity/profile/join-code';
import { pureCircuits } from '../../contracts/managed/contract/index.js';
import { fromHex, newWrappingKeypair, randomBytes, toHex, type Hex } from '../core/crypto.js';
import { TEST_SETTLEMENT_ASSET } from '../core/assets.js';
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
import { payeeFor } from '../testing/payees.js';
import { vaultDetails } from '../testing/vault-details.js';
import { acceptAsPayeeHere, invitePayeeHere, openInvitationHere, type InvitingCompany } from 'vaults-web-shared/invitation-on-device.js';
import { admitHere, readPeopleHere, type PeopleDevice } from 'vaults-web-shared/people-on-device.js';
import { drawRunHere, type RunDrawDoors } from 'vaults-web-shared/run-drawn-here.js';
import { openTheRoundHere, raiseRetryOnDevice, raiseRunOnDevice } from 'vaults-web-shared/governed-call-on-device.js';
import { governedCallServiceFor } from 'vaults-web-shared/governed-call-on-device.js';
import { LegNotRaisedHere, type LegRaiseDoors } from 'vaults-web-shared/run-raised-here.js';
import { keptRunHere, runRebuiltHere, type CompanyRecordsHere } from 'vaults-web-shared/run-rebuilt-here.js';
import {
  refuseARaiseThatIsNotTheRecordedOne, refuseWhatThisDeviceDidNotOpen, type GovernedCallOrder, type OpenedRound,
} from 'vaults-web-shared/governed-call-builder.js';
import { refuseWhatThisDeviceDidNotMake, type AccountLedgerView } from 'vaults-web-shared/what-this-device-made.js';
import { runRoutes } from './run-routes.js';
import { proposalRelayRoutes } from './proposal-relays.js';
import {
  aCompanyOfTwoSeats, acmeDirectory, ACME, ADA, ADDRESS, BO, CO, fromAda, KEY, LABEL, ORIGIN, sendAs, store, wire, type Seat,
} from './a-company-of-two-seats.test-support.js';

/* The chain, as the test keeps it: the proposals it holds open, the payment entries it counts, and the account's marks. */
const open = new Map<string, number>();
const movements = new Set<string>();
const marks = new Set<string>();
const publicAsks: string[] = [];
let publicRefuses: string | null = null;
let dropTheSend = false;
/** While set, the vault's public money is answered only once it settles: two raises can be checked at once. */
let holdThePublicMoney: Promise<void> | null = null;
const STATE_BLINDING = newStateBlinding();
const PAY_KEY_AT = toHex(pureCircuits.payKeyCommitmentKey());
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
const aPayee = async (n: number, paidAt = n) => {
  const code: JoinCode = signJoinCode(identityFromSecret(new Uint8Array(32).fill(n)), LABEL, `usr_${n}`, { kind: 'payee', address: addressOf(paidAt), payslipKey: newWrappingKeypair().publicKey });
  const made = await invitePayeeHere(ACME, ADA, pay(n), ORIGIN, fromAda);
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
const recordsOn = (s: Seat): CompanyRecordsHere & { proposals: () => Promise<ReturnType<typeof store.listProposals>> } => ({
  directory: () => acmeDirectory(),
  people: () => readPeopleHere(peopleOn(s)),
  state: (id) => records.get(CO, 'state', id),
  runs: async () => store.listRuns(CO),
  proposals: async () => store.listProposals(CO),
});
const drawingOn = (s: Seat): RunDrawDoors => ({
  api: api(s), accountId: CO, viewingKey: KEY, keyEpoch: 0, signingSecret: s.signingSecret as Hex, company: { account: ADDRESS, label: LABEL },
  records: recordsOn(s), by: s.person,
});

/** The account as the chain holds it now, as the worker reads it. */
const theChainNow = (): AccountLedgerView => ({
  openProposals: {
    member: (id) => open.has(toHex(id)),
    [Symbol.iterator]: () => [...open.keys()].map((k): [Uint8Array, unknown] => [fromHex(k), 0n])[Symbol.iterator](),
  },
  movements: { member: (e) => movements.has(toHex(e)), size: () => BigInt(movements.size) },
  signerRoles: {
    member: (k) => toHex(k) === PAY_KEY_AT || marks.has(toHex(k)),
    lookup: (k) => (toHex(k) === PAY_KEY_AT ? fromHex(COMMITMENT) : new Uint8Array(32)),
  },
});
const P = pureCircuits as unknown as Parameters<typeof refuseWhatThisDeviceDidNotOpen>[0]['accountPure'];
const proved: Array<{ order: GovernedCallOrder; opened: OpenedRound }> = [];
/** What the worker runs before it builds a call, over the chain as the test holds it; the "proof" names the call. */
const builder = {
  governedCall: async (input: { order: GovernedCallOrder; opened: OpenedRound }) => {
    refuseWhatThisDeviceDidNotOpen({ accountPure: P }, input.order, input.opened);
    refuseWhatThisDeviceDidNotMake({
      runPayload: pureCircuits.runPayload, vaultDetails, payKeyCommitmentOf: pureCircuits.payKeyCommitmentOf,
      payKeyCommitmentKey: pureCircuits.payKeyCommitmentKey, policyOnKeyOf: pureCircuits.policyOnKeyOf,
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
  policy: async () => policy as never,
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
  open.clear(); movements.clear(); marks.clear(); publicAsks.length = 0; publicRefuses = null; proved.length = 0; dropTheSend = false;
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
    const made = await runRebuiltHere(recordsOn(BO), CO, round.id, KEY);
    expect(() => refuseWhatThisDeviceDidNotMake({
      runPayload: pureCircuits.runPayload, vaultDetails, payKeyCommitmentOf: pureCircuits.payKeyCommitmentOf,
      payKeyCommitmentKey: pureCircuits.payKeyCommitmentKey,
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

  it('A VAULT THAT PAYS ONLY RUNS CLEARED AGAINST A POLICY, AND A CHAIN HOLDING WHAT THE RECORDS CANNOT ACCOUNT FOR, ARE REFUSED WHERE THE RAISE IS PROVED', async () => {
    const proposalsBefore = store.listProposals(CO).length;
    marks.add(toHex(pureCircuits.policyOnKeyOf(fromHex(VAULT))));
    /* RED WHEN: a raise is proved for a vault whose window rule no device can check. */
    await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE })).rejects.toThrow(/spending policy/);
    marks.clear();
    open.set('ee'.repeat(32), 0);
    /* RED WHEN: a raise is proved while the chain holds a round the company's records do not, and the refusal does not say why a device cannot confirm over it. */
    await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE })).rejects.toThrow(/1 open round .* cannot be confirmed as repeating these/);
    open.clear();
    movements.add('ab'.repeat(32));
    movements.add('cd'.repeat(32));
    /* RED WHEN: payments the chain counts and the records cannot name are not counted. */
    await expect(raiseRunOnDevice(raisingOn(ADA), { runId, ...RAISE })).rejects.toThrow(/2 unexplained payment entries/);
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
const legOf = (id: string) => {
  const run = openSealedRun(store.getRun(id)!, KEY);
  return run.payout![Object.keys(run.payout!)[0] as never]!;
};

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
    const made = await runRebuiltHere(recordsOn(BO), CO, round.id, KEY);
    expect(made.retry).toEqual([1]);
    const proposal = store.getProposal(round.id)!;
    expect(() => refuseWhatThisDeviceDidNotMake({
      runPayload: pureCircuits.runPayload, vaultDetails, payKeyCommitmentOf: pureCircuits.payKeyCommitmentOf,
      payKeyCommitmentKey: pureCircuits.payKeyCommitmentKey,
    }, { chainId: proposal.chainId, digest: proposal.digest, made }, theChainNow())).not.toThrow();
    /* RED WHEN: the vault's public money is asked about the leg's people rather than the retry's one. */
    expect((JSON.parse(publicAsks.at(-1)!) as { payments: Array<{ amount: string }> }).payments.map((p) => p.amount)).toEqual([String(leg.facts![1]!.amount)]);
    /* RED WHEN: an approver holds a retry's commitment to the leg's whole list of payments rather than the people it names. */
    await expect(openTheRoundHere(storedFor(BO), CO, round.id, KEY, false, recordsOn(BO))).resolves.toMatchObject({ vault: VAULT });
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
