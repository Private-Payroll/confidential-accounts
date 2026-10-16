/**
 * **A SIGNER IS REMOVED FROM THE SIGNERS' OWN DEVICES**: one proposal at the
 * approvals a change of who is seated needs, the retirement of the leaving
 * seat signed with each approval, filed and anchored before the chain is asked
 * to take the leaf off, and finished from any staying device when the chain
 * took it off first. The page's own module, `removeSignerOnDevice`, over:
 *   - a chain double: the seats it holds and the approvals each proposal has,
 *     taking a leaf off when the removal is carried out;
 *   - a records double: the company's directory, judged by the real directory
 *     judge (`applyFiling`) as each retirement is filed, every version anchored
 *     at once, and the versions each seat filed of each record;
 *   - a service that keeps proposals and the retirement signatures handed in
 *     beside them, and nothing else.
 * The chain double holds the account's own rules a removal rests on, in the
 * order its `amendSigner` checks them: the proposal is open, no signer was
 * removed since it was raised (its count of removals), its approvals reach the
 * seat bar, and the leaf is seated. What a proposal opens as is read from what
 * its raise sealed; opening real records is the subject of
 * `the-device-proves-what-it-opened.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { newSigningKeypair, newSymmetricKey, parseCanonical, unseal, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { openRecord } from '../../../src/core/sealed-records.js';
import { approverRosterFrom } from '../../../src/core/vault-approvers.js';
import type { RetirementSignature, SealedProposal } from '../../../src/core/types.js';
import { applyFiling, asAMember, emptyDirectory, type Directory, type DirectorySeat, type SignedChange } from '../../../src/midnight/seat-directory.js';
import { recordKeyOf, type ManifestEntry } from '../../../src/midnight/record-manifest.js';
import { kindKeyOf } from '../../../src/midnight/records-held.js';
import { COMPANY_RECORD_KINDS, WIRE_RECORDS } from '../../../src/midnight/sealed-record-wire.js';
import type { RetirementTerms } from '../../../src/core/proposal-filing.js';
import type { KeptDirectoryChange } from './tree-kept-here.js';
import type { GovernedCallOrder, OpenedRound, RoundOnChain } from './governed-call-builder.js';
import {
  governOnDevice, leavingBoundariesHere, ownRemovalRaisedHere, RemovalRaisedAgain, removeSignerOnDevice, RetirementNotYetSigned, seatsLeavingHere,
  type RemovalDoors, type RemovalOutcome, type RetirementSignaturesKept, type RoundOnThePage,
} from './governed-call-on-device.js';
import { setPolicyBarOnDevice } from './spending-policy-here.js';
import { boundaryKeyOfEntry } from '../../../src/midnight/record-manifest.js';
import { judgeIn, pastTheRaisedBoundary, type DirectoryHere } from './vault-page-doors.js';
import { FiledNotEntered, recordsEnteredFor } from './record-entered-here.js';

/* What each proposal opens as on this device: what its raise sealed, read back with the viewing key. */
const seams = vi.hoisted(() => ({ opens: undefined as unknown as (proposalId: string) => Promise<OpenedRound> }));
vi.mock('./round-opened-here.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./round-opened-here.js')>()),
  openTheRoundHere: (_s: unknown, _a: string, proposalId: string) => seams.opens(proposalId),
}));
/* The account's asset blinding a raise commits with, from the state its founding seat signed: not this file's subject. */
vi.mock('./run-rebuilt-here.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./run-rebuilt-here.js')>()),
  signedStateHere: async () => ({ seeds: [], payKey: 'ab'.repeat(32), assetBlinding: '55'.repeat(32) }),
}));
/* Every proposal the service lists is one the company's records name: a withheld proposal is `listedHere`'s own subject. */
vi.mock('./vault-page-doors.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./vault-page-doors.js')>()),
  listedHere: (_h: unknown, _s: unknown, served: unknown) => served,
}));

const ACC = 'acc_removal';
const KEY = newSymmetricKey();
const LABEL = `co_${'c3'.repeat(32)}` as never;
const ACCOUNT = 'ac'.repeat(32) as never;
const SALT = 'cd'.repeat(32);

interface Person { readonly name: string; readonly seat: string; readonly signing: { secret: Hex; publicKey: Hex }; readonly n: number }
const person = (name: string, n: number): Person => ({ name, seat: n.toString(16).padStart(2, '0').repeat(32), signing: newSigningKeypair(), n });
const ADA = person('ada', 0xa1);
const BO = person('bo', 0xb2);
const CY = person('cy', 0xc3);
/** A leaf the chain holds that nobody ever filed a directory entry for. */
const DEE = person('dee', 0xd4);

const seatOf = (p: Person): DirectorySeat => ({
  seat: p.seat, person: p.name, signingKey: p.signing.publicKey, wrappingKey: p.n.toString(16).repeat(32).slice(0, 64),
  committeeKey: { tag: 'schnorr', value: (p.n + 1).toString(16).repeat(32).slice(0, 64) }, role: 'admin', retired: null,
});
const STATEMENT = { recordsKey: 'b2'.repeat(32), seat: BO.seat, signature: '9b'.repeat(64) };
const POLICY = recordKeyOf({ store: 'company', kind: 'spending-policy', id: 'pol_1' });

/**
 * One company, its chain and its service, shared by every device opened on it. `seated` are the people the directory
 * and the chain hold, `bar` the approvals a change of who is seated needs; `onlyOnTheChain` are leaves the chain holds
 * with no directory entry.
 */
const aCompany = (o: { seated?: readonly Person[]; bar?: number; onlyOnTheChain?: readonly Person[]; waiting?: boolean } = {}) => {
  const seated = o.seated ?? [ADA, BO, CY];
  const bar = o.bar ?? 2;
  const log: string[] = [];
  const chain = new Set([...seated, ...(o.onlyOnTheChain ?? [])].map((p) => p.seat));
  let dir: Directory = { ...emptyDirectory(ACC), version: seated.length, seats: seated.map(seatOf) };
  /* The newest directory version the anchor holds: every one filed, unless a case leaves the last waiting. */
  let anchored = o.waiting ? dir.version - 1 : dir.version;
  /* Each version of each record, and who filed it: the leaving seat filed version 1 of a spending policy. */
  const history = new Map<string, Array<{ version: number; digest: Hex; filedBy: Hex; batch: number; dirVersion: number }>>([
    [POLICY, [{ version: 1, digest: '01'.repeat(32) as Hex, filedBy: BO.signing.publicKey, batch: 1, dirVersion: 1 }]],
  ]);
  const pending: ManifestEntry[] = [];
  /*
   * The account's history as a clock: each block that takes an anchor or a raise is one tick later. Each batch leaves
   * its own head, which every device here checked: what a removal's raise names its boundary at.
   */
  let clock = 1;
  let batches = 1;
  const headOf = (seq: number): string => seq.toString(16).padStart(64, 'e');
  /* Run while the raise is proved and sent, after the raiser read the records: what another device does meanwhile. */
  let whileTheRaiseIsSent: (() => void) | null = null;
  const rounds = new Map<string, RoundOnThePage & { opened: OpenedRound; signatures: RetirementSignature[]; removals: number; onChainAt: number }>();
  /* The account's count of signers removed, and whether the next carrying out fails as a fee paid for nothing. */
  let removals = 0;
  let failsOnce = false;
  /* Whether every proposal the service keeps was filed and never raised on the chain. */
  let neverRaised = false;
  let withholds = false;
  const holders = () => ({
    committee: [], seats: [...chain], approvals: 1, vaultThresholds: [], policyBar: bar > 1 ? bar : null, seatBar: bar,
    adoptedVaults: [], account: ACCOUNT,
  });
  const here = () => ({
    dir, holders: holders(), another: new Set<string>(), refusedAt: new Set<number>(), leafOf: () => null, at: () => null,
    records: {
      head: headOf(batches), stopped: null, reached: { seq: batches, head: headOf(batches) }, history, notYetAnchored: [...pending],
      seqOfHead: (h: string) => Array.from({ length: batches + 1 }, (_, n) => n).find((n) => headOf(n) === h) ?? null,
      directory: new Map(Array.from({ length: anchored }, (_, i) => [i + 1, {}] as const)),
      asked: {
        records: new Set<string>(),
        kinds: new Set([...COMPANY_RECORD_KINDS.map((kind) => kindKeyOf({ store: 'company', kind })),
          ...WIRE_RECORDS.map((kind) => kindKeyOf({ store: 'vault', kind })), kindKeyOf({ store: 'run', kind: 'run' }),
          kindKeyOf({ store: 'proposal', kind: 'proposal' })]),
      },
    },
  });
  seams.opens = async (id) => rounds.get(id)!.opened;
  /* A retirement filed is judged by the directory's own judge against the chain now, then anchored at once. */
  const fileTheRetirement = async (change: SignedChange, signedFor: number): Promise<void> => {
    log.push(`file retirement ${signedFor}`);
    dir = applyFiling(dir, { company: ACC, version: signedFor, change }, {
      label: LABEL, account: ACCOUNT, chain: null, judge: asAMember(() => null, () => null, ADA.seat),
      now: { approvals: 1, seats: [...chain], seatBar: bar },
    });
    anchored = dir.version;
    log.push('anchor the records');
  };
  let lastOrder: GovernedCallOrder | null = null;
  const signaturesKeptBy = new Map<string, Map<string, RetirementSignature[]>>();
  /* Who approved each proposal on the chain: the chain refuses a second approval from one signer. */
  const approvedBy = new Set<string>();
  const page = (id: string): RoundOnThePage => {
    const { opened: _o, signatures: _s, removals: _n, onChainAt: _t, ...r } = rounds.get(id)!;
    return r;
  };
  const deviceOf = (p: Person, d: { statement?: typeof STATEMENT | null; kept?: KeptDirectoryChange[]; files?: boolean; keepsSignatures?: boolean; anchors?: boolean } = {}) => {
    const kept = d.kept ?? [];
    /* The retirement signatures this device made or read, by proposal: kept on its own person's device across opens. */
    const signaturesKept = signaturesKeptBy.get(p.name) ?? signaturesKeptBy.set(p.name, new Map()).get(p.name)!;
    const doors: RemovalDoors = {
      service: {
        callState: async () => ({ account: ACCOUNT, blockHash: 'b', accountState: 'AS', parameters: 'PP' }) as never,
        sealedProposals: async () => [...rounds.values()].map((r) => ({
          id: r.id, accountId: ACC, status: r.status, chainId: r.chainId, approvalCount: r.approvalCount ?? 0, createdAt: '2026-10-16',
          ...(r.raisedAt ? { raisedAt: r.raisedAt } : {}), ...(withholds ? {} : { retirementSignatures: [...r.signatures] }),
        }) as unknown as SealedProposal),
        file: async (_acc, body) => {
          /* What the raise sealed, read back with the viewing key: the proposal this company now holds. */
          const envelope = openRecord<{ sealedPayload: Sealed; summary: string }>('proposals', ACC, body.proposal.sealed, KEY);
          const sealed = parseCanonical(unseal(envelope.sealedPayload, KEY)) as { leaf: string; retirement?: RetirementTerms };
          log.push(`raise remove ${sealed.leaf === BO.seat ? 'bo' : sealed.leaf === DEE.seat ? 'dee' : sealed.leaf}`);
          const meanwhile = whileTheRaiseIsSent;
          whileTheRaiseIsSent = null;
          meanwhile?.();
          clock += 1;
          rounds.set(body.proposal.id, {
            id: body.proposal.id, chainId: body.proposal.chainId, status: 'open', approvalCount: 0, raisedAt: 'now', signatures: [], removals, onChainAt: clock,
            opened: {
              chainId: body.proposal.chainId, digest: 'dd'.repeat(32), vault: '00'.repeat(32), salt: SALT, summary: envelope.summary,
              governance: { kind: 'remove-signer', leaf: sealed.leaf }, ...(sealed.retirement === undefined ? {} : { retirement: sealed.retirement }),
            },
          });
          return page(body.proposal.id);
        },
        send: async (id) => page(id),
        approve: async (id, body) => {
          const r = rounds.get(id)!;
          log.push(`approve by ${p.name}${body.retirement === undefined ? '' : ` signing the retirement for ${body.retirement.signedFor}`}`);
          if (body.retirement !== undefined && !withholds) r.signatures.push(body.retirement);
          rounds.set(id, { ...r, approvalCount: (r.approvalCount ?? 0) + 1 });
          return page(id);
        },
        retire: async (id, body) => {
          log.push(`${p.name} signs the retirement again for ${body.signature.signedFor}`);
          if (!withholds) rounds.get(id)!.signatures.push(body.signature);
          return page(id);
        },
        standing: async (id) => page(id),
        carry: async (id, body) => {
          const order = lastOrder as Extract<GovernedCallOrder, { circuit: 'amendSigner' }>;
          const r = rounds.get(id)!;
          /* The account's own checks, in its own order. */
          if (r.status !== 'open') throw new Error('there is no open proposal with that id');
          if (r.removals !== removals) throw new Error('a signer has been removed or replaced since this was raised; raise it again');
          if (order.circuit === 'amendSigner' && (r.approvalCount ?? 0) < bar) throw new Error('not enough approvals');
          if (order.circuit === 'amendSigner' && !chain.has(order.leaf)) throw new Error('that signer is not seated on this account');
          if (failsOnce) { failsOnce = false; log.push('carry failed'); throw new Error('the fee was paid and nothing was written'); }
          log.push(`carry ${body.circuit}${order.removing ? ' removing' : ''}`);
          if (order.circuit === 'amendSigner') { chain.delete(order.leaf); removals += 1; }
          rounds.set(id, { ...r, status: 'executed' });
          return page(id);
        },
      },
      builder: {
        governedCall: async ({ order, material }) => {
          if (order.circuit === 'approve' && approvedBy.has(`${order.proposal}:${material.signingSecret}`)) {
            throw Object.assign(new Error('you have already approved this proposal'), { name: 'CallNotBuilt' });
          }
          if (order.circuit === 'approve') approvedBy.add(`${order.proposal}:${material.signingSecret}`);
          lastOrder = order;
          return { tx: `TX-${order.circuit}` };
        },
        proposalIdentity: async () => ({ digest: 'dd'.repeat(32), chainId: `${(rounds.size + 1).toString(16).padStart(2, '0')}`.repeat(32), noVault: '00'.repeat(32) }),
      },
      material: { signingSecret: p.signing.secret, blinding: '22'.repeat(32), scope: '33'.repeat(32) },
      accountId: ACC,
      records: {
        directory: async () => here() as never,
        roundsOnChain: async (ids: readonly string[]) => Object.fromEntries(ids.map((id) => {
          const r = [...rounds.values()].find((x) => x.chainId.toLowerCase() === id.toLowerCase());
          const round: RoundOnChain = r === undefined || neverRaised ? { held: 'never', approvals: 0 }
            : r.status === 'executed' ? { held: 'closed', approvals: 0, raisedAt: r.onChainAt, txRef: id, closedBy: ['amendSigner'] }
              : { held: 'open', approvals: r.approvalCount ?? 0, raisedAt: r.onChainAt, txRef: id, ...(r.removals !== removals ? { outrun: true as const } : {}) };
          return [id.toLowerCase(), round];
        })),
      } as never,
      filing: {
        seat: p.seat, keyEpoch: 0, salt: () => SALT, newId: () => `prp_removal${rounds.size + 1}`,
        entered: { enter: async () => {} },
      },
      approvers: async () => approverRosterFrom({ threshold: 1, vaultThresholds: [], seated: [...chain].map((leaf) => ({ leaf })), adoptedVaults: [], companyWide: 'cc'.repeat(32) }),
      vaultName: () => 'company-wide runs',
      sleep: async () => {}, waitMs: 3, everyMs: 1,
      ...(d.anchors === false ? {} : { anchorDirectory: async () => {
        log.push('anchor the records');
        anchored = dir.version;
        /*
         * Every entry not yet anchored joins the history the anchor holds, in a batch landing one tick later - but none a
         * seat under a raised removal filed past the boundary the raise signed, read as this device reads the removals.
         */
        const leaving = await leavingBoundariesHere(doors, KEY);
        const batch = (batches += 1);
        clock += 1;
        for (const e of pending.splice(0)) {
          if (pastTheRaisedBoundary(leaving, e.filedBy.publicKey, boundaryKeyOfEntry(e), e.version)) { pending.push(e); continue; }
          const key = recordKeyOf(e);
          history.set(key, [...(history.get(key) ?? []), { version: e.version, digest: e.digest, filedBy: e.filedBy.publicKey, batch, dirVersion: dir.version }]);
        }
      } }),
      leaversStatement: async (seat) => (seat.seat === BO.seat && d.statement !== undefined && d.statement !== null ? d.statement as never : null),
      ...(d.files === false ? {} : { directoryChange: fileTheRetirement }),
      kept: {
        keep: async (_c, k) => { const i = kept.findIndex((x) => x.signedAt === k.signedAt); if (i >= 0) kept.splice(i, 1); kept.push(k); },
        all: async () => [...kept],
        letGo: async (_c, at) => { const i = kept.findIndex((x) => x.signedAt === at); if (i >= 0) kept.splice(i, 1); },
      },
      ...(d.keepsSignatures === false ? {} : {
        signatures: {
          keep: async (_c: string, id: string, s: readonly RetirementSignature[]) => {
            const was = signaturesKept.get(id) ?? [];
            signaturesKept.set(id, [...was.filter((x) => !s.some((y) => y.publicKey === x.publicKey && y.signedFor === x.signedFor)), ...s]);
          },
          all: async (_c: string, id: string) => signaturesKept.get(id) ?? [],
        } satisfies RetirementSignaturesKept,
      }),
    };
    return { doors, kept, remove: (who: Person) => removeSignerOnDevice(doors, { viewingKey: KEY, leaf: who.seat, name: who.name }) };
  };
  return {
    log, chain, deviceOf, rounds,
    get dir() { return dir; },
    set dir(d: Directory) { dir = d; },
    /** Another change filed to the directory, taking the version a signature was made for. */
    anotherVersion: () => { dir = { ...dir, version: dir.version + 1 }; anchored = dir.version; },
    /** The leaving seat files a version of the spending policy after the removal is raised. */
    leaverFilesPool: (version: number) => { pending.push({ store: 'vault', kind: 'pool', id: 'ff'.repeat(32), version, digest: '03'.repeat(32), filedBy: { publicKey: BO.signing.publicKey, signature: 'aa'.repeat(64) } } as ManifestEntry); },
    /** Another signer's removal carried out on the chain: the account's count of removals moves. */
    anotherRemovalCarried: () => { removals += 1; },
    failsOnce: () => { failsOnce = true; },
    leaverFilesAgain: (version = 2) => { pending.push({ store: 'company', kind: 'spending-policy', id: 'pol_1', version, digest: version.toString(16).padStart(2, '0').repeat(32), filedBy: { publicKey: BO.signing.publicKey, signature: 'aa'.repeat(64) } } as ManifestEntry); },
    /** The leaving seat's own device anchors what it filed, in a batch of its own landing one tick later: no staying device does. */
    leaverAnchorsItsOwn: () => {
      const batch = (batches += 1);
      clock += 1;
      for (const e of pending.splice(0)) {
        const key = recordKeyOf(e);
        history.set(key, [...(history.get(key) ?? []), { version: e.version, digest: e.digest, filedBy: e.filedBy.publicKey, batch, dirVersion: dir.version }]);
      }
    },
    /** The company's records and directory as every device here reads them now. */
    here: () => here() as unknown as DirectoryHere,
    history,
    pending,
    withhold: () => { withholds = true; },
    /** What another device does after the raiser read the records and before the raise lands. */
    whileTheRaiseIsSent: (f: () => void) => { whileTheRaiseIsSent = f; },
    headOf,
    /** The proposals the service keeps were filed there and never raised on the chain. */
    neverRaisedOnTheChain: () => { neverRaised = true; },
  };
};

describe('A SIGNER REMOVED, FROM EACH SIGNER\'S OWN DEVICE', () => {
  it('ONE PRESS EACH: THE RAISE AND EACH APPROVAL SIGN THE RETIREMENT; THE WAITING DIRECTORY IS ANCHORED, THE RETIREMENT FILED AND ANCHORED, AND ONLY THEN THE CHAIN TAKES THE LEAF OFF', async () => {
    const co = aCompany({ waiting: true });
    expect((await co.deviceOf(ADA).remove(BO)).state).toBe('waiting-for-approvals');
    const out = await co.deviceOf(CY).remove(BO);
    expect(out.state).toBe('done');
    /* RED WHEN: the chain is asked before a waiting directory version is anchored, or before the retirement is filed and anchored. */
    expect(co.log).toEqual([
      'raise remove bo',
      'approve by ada signing the retirement for 4',
      'approve by cy signing the retirement for 4',
      'anchor the records',
      'file retirement 4',
      'anchor the records',
      'carry amendSigner removing',
    ]);
    /* RED WHEN: the leaf the chain holds is left, or the directory does not hold the seat retired at its boundary. */
    expect(co.chain.has(BO.seat)).toBe(false);
    expect(co.dir.seats.find((x) => x.seat === BO.seat)!.retired).toEqual({ [POLICY.replace(/^company:spending-policy:/u, 'spending-policy:')]: 1 });
  });

  it('THE LEAVING SEAT\'S OWN APPROVAL COUNTS, AND A REMOVAL SHORT OF THE SEAT BAR IS NOT CARRIED OUT', async () => {
    const co = aCompany({ bar: 2 });
    await co.deviceOf(BO).remove(BO);
    /* RED WHEN: a removal is carried out at the account's threshold of one, below the seat bar of two. */
    expect(co.log).toEqual(['raise remove bo', 'approve by bo signing the retirement for 4']);
    expect(co.chain.has(BO.seat)).toBe(true);
    /* RED WHEN: the leaving seat's own approval and signature are not counted toward its removal. */
    expect((await co.deviceOf(ADA).remove(BO)).state).toBe('done');
    expect(co.chain.has(BO.seat)).toBe(false);
  });

  it('A SECOND REMOVAL IS REFUSED WHILE ONE IS IN FLIGHT: A SEAT RETIRED IN THE DIRECTORY THAT THE CHAIN STILL HOLDS', async () => {
    const co = aCompany();
    co.dir = { ...co.dir, seats: co.dir.seats.map((x) => (x.seat === CY.seat ? { ...x, retired: {} } : x)) };
    /* RED WHEN: a second removal is raised while another seat is retired and still seated. */
    await expect(co.deviceOf(ADA).remove(BO)).rejects.toThrow(/another signer's removal is under way/u);
    expect(co.log).toEqual([]);
  });

  it('AN APPROVER WHOSE ROSTER HOLDS THE LEAVER\'S STATEMENT REFUSES A RETIREMENT THAT LEAVES IT OUT OR CHANGES IT', async () => {
    const co = aCompany();
    /* Ada's device holds no statement for Bo, so her raise carries none. */
    await co.deviceOf(ADA).remove(BO);
    /* RED WHEN: a device whose roster holds the leaver's statement approves a retirement without it. */
    await expect(co.deviceOf(CY, { statement: STATEMENT }).remove(BO)).rejects.toThrow(/records-key statement/u);
    await expect(co.deviceOf(CY, { statement: { ...STATEMENT, signature: '8c'.repeat(64) } }).remove(BO)).rejects.toThrow(/records-key statement/u);
    expect(co.log).toEqual(['raise remove bo', 'approve by ada signing the retirement for 4']);
    /* The control: raised with the statement, the same device approves it. */
    const again = aCompany({ bar: 3 });
    await again.deviceOf(ADA, { statement: STATEMENT }).remove(BO);
    expect((await again.deviceOf(CY, { statement: STATEMENT }).remove(BO)).state).toBe('waiting-for-approvals');
    expect(again.log).toContain('approve by cy signing the retirement for 4');
  });

  it('THE BOUNDARY SIGNED AT THE RAISE IS FINAL: THE LEAVER FILING BEFORE EACH APPROVAL AND BEFORE THE CARRYING OUT VOIDS NOTHING, AND NO STAYING DEVICE ANCHORS OR BELIEVES IT', async () => {
    const co = aCompany({ seated: [ADA, BO, CY, DEE], bar: 3 });
    const cy = co.deviceOf(CY);
    /* What Bo files is anchored by a staying device on its way in, as every device that may anchor does. */
    const leaverFiles = async (version: number) => { co.leaverFilesAgain(version); await cy.doors.anchorDirectory!(); };
    await co.deviceOf(ADA).remove(BO);
    const raised = [...co.rounds.values()][0]!.opened.retirement!.filedUpTo;
    expect(raised).toEqual({ 'spending-policy:pol_1': 1 });
    await leaverFiles(2);
    /* RED WHEN: a version the leaver filed after the raise voids the next approval, so the leaver can hold their own removal off. */
    expect((await cy.remove(BO)).state).toBe('waiting-for-approvals');
    await leaverFiles(3);
    /* Dee approves; her page cannot file the retirement, so nothing is carried out from it. */
    await expect(co.deviceOf(DEE, { files: false }).remove(BO)).rejects.toThrow(/cannot file a retirement/u);
    await leaverFiles(4);
    /* RED WHEN: a version the leaver filed between the last approval and the carrying out stops the carrying out. */
    expect((await co.deviceOf(ADA).remove(BO)).state).toBe('done');
    expect(co.chain.has(BO.seat)).toBe(false);
    expect(co.dir.seats.find((x) => x.seat === BO.seat)!.retired).toEqual(raised);
    /* RED WHEN: a staying device anchors a version a seat under a raised removal filed past the boundary the raise signed. */
    expect(co.history.get(POLICY)!.map((v) => v.version)).toEqual([1]);
    expect(co.pending.map((e) => e.version)).toEqual([2, 3, 4]);
    /* RED WHEN: a press after the raise asks its page to anchor what the leaver filed, where that page's anchor is not told the removal is raised. */
    expect(co.log.filter((x) => x === 'anchor the records')).toHaveLength(4);
    /* RED WHEN: a version the leaver filed after the raise is believed by a device once they are retired. */
    const judge = judgeIn(co.here());
    for (const version of [2, 3, 4]) {
      expect(judge(BO.signing.publicKey, 'spending-policy', 'spending-policy:pol_1',
        { store: 'company', kind: 'spending-policy', id: 'pol_1', version, digest: version.toString(16).padStart(2, '0').repeat(32) as Hex })).toEqual(expect.stringMatching(/later than the last version that seat filed before it left/u));
    }
    /* The control: the version the boundary keeps is believed. */
    expect(judge(BO.signing.publicKey, 'spending-policy', 'spending-policy:pol_1',
      { store: 'company', kind: 'spending-policy', id: 'pol_1', version: 1, digest: '01'.repeat(32) as Hex })).toBeNull();
  });

  it('A VERSION THE LEAVER\'S OWN DEVICE ANCHORS AFTER THE RAISE IS NOT BELIEVED, AND VOIDS NO APPROVAL', async () => {
    const co = aCompany();
    co.leaverFilesPool(6);
    /* The raise anchors the leaver's pool version 6 first, so its boundary keeps it. */
    await co.deviceOf(ADA).remove(BO);
    expect([...co.rounds.values()][0]!.opened.retirement!.filedUpTo).toEqual({ 'spending-policy:pol_1': 1, [`vault:${'ff'.repeat(32)}:pool`]: 6 });
    co.leaverFilesPool(7);
    co.leaverAnchorsItsOwn();
    const cy = co.deviceOf(CY);
    const leaving = await leavingBoundariesHere(cy.doors, KEY);
    const here = co.here();
    const read = { store: 'vault' as const, kind: 'pool' as const, id: 'ff'.repeat(32), version: 7, digest: '03'.repeat(32) as Hex };
    /* RED WHEN: a device that knows the removal is raised believes a version the leaver filed past the boundary the raise signed. */
    expect(judgeIn({ ...here, records: { ...here.records, leaving } })(BO.signing.publicKey, 'pool', `vault:${'ff'.repeat(32)}:pool`, read))
      .toEqual(expect.stringMatching(/later than the last version that seat filed before it left/u));
    /* RED WHEN: a pool or journal version the leaver anchored after the raise voids an approval. */
    expect((await cy.remove(BO)).state).toBe('done');
    expect(co.dir.seats.find((x) => x.seat === BO.seat)!.retired).toEqual({ 'spending-policy:pol_1': 1, [`vault:${'ff'.repeat(32)}:pool`]: 6 });
    /* RED WHEN: once the leaver is retired, a device that reads no removal believes the version they anchored after the raise. */
    expect(judgeIn(co.here())(BO.signing.publicKey, 'pool', `vault:${'ff'.repeat(32)}:pool`, read))
      .toEqual(expect.stringMatching(/later than the last version that seat filed before it left/u));
    /* The control: the version the boundary keeps is believed. */
    expect(judgeIn(co.here())(BO.signing.publicKey, 'pool', `vault:${'ff'.repeat(32)}:pool`, { ...read, version: 6 })).toBeNull();
    /* RED WHEN: the version the boundary keeps is refused as the record's newest because of a version above it no device believes. */
    expect(judgeIn(co.here())(BO.signing.publicKey, 'pool', `vault:${'ff'.repeat(32)}:pool`, { ...read, version: 6 }, true)).toBeNull();
    expect(judgeIn(co.here()).pastItsBoundary!(BO.signing.publicKey, `vault:${'ff'.repeat(32)}:pool`, 7)).toBe(true);
    /* The control: a seat whose boundary is not final has no version passed over. */
    expect(judgeIn(co.here()).pastItsBoundary!(CY.signing.publicKey, `vault:${'ff'.repeat(32)}:pool`, 7)).toBe(false);
  });

  it('A BOUNDARY SHORT OF A VERSION THE LEAVER HAD ANCHORED AT THE RAISE IS STILL REFUSED', async () => {
    const co = aCompany();
    co.leaverFilesPool(6);
    await co.deviceOf(ADA).remove(BO);
    const round = [...co.rounds.values()][0]!;
    /* A raiser left out the pool version the leaver had anchored before the raise. */
    round.opened = { ...round.opened, retirement: { ...round.opened.retirement!, filedUpTo: { 'spending-policy:pol_1': 1 } } };
    /* RED WHEN: a boundary below a version anchored before the raise passes, so that version is never read again. */
    await expect(co.deviceOf(CY).remove(BO)).rejects.toThrow(/as the anchored records held them at the head the removal was raised over/u);
    expect(co.chain.has(BO.seat)).toBe(true);
  });

  it('WHAT THE LEAVER ANCHORS AFTER THE RAISER READ THE RECORDS AND BEFORE THE RAISE LANDS VOIDS NOTHING: THE BOUNDARY IS JUDGED AT THE HEAD THE RAISE NAMES', async () => {
    const co = aCompany();
    /* Bo's own device files and anchors a policy version while Ada's raise is proved and sent. */
    co.whileTheRaiseIsSent(() => { co.leaverFilesAgain(2); co.leaverAnchorsItsOwn(); });
    await co.deviceOf(ADA).remove(BO);
    const terms = [...co.rounds.values()][0]!.opened.retirement!;
    /* RED WHEN: a raise does not name the anchored head its boundary was taken at. */
    expect([terms.filedUpTo, terms.atHead]).toEqual([{ 'spending-policy:pol_1': 1 }, co.headOf(1)]);
    expect(co.history.get(POLICY)!.map((v) => v.version)).toEqual([1, 2]);
    /* RED WHEN: a version the leaver anchored between the raiser's read and the raise's block voids the approval and the carrying out. */
    expect((await co.deviceOf(CY).remove(BO)).state).toBe('done');
    expect(co.dir.seats.find((x) => x.seat === BO.seat)!.retired).toEqual({ 'spending-policy:pol_1': 1 });
  });

  it('A RAISE NAMING NO ANCHORED HEAD, OR ONE THE COMPANY\'S RECORDS NEVER HELD, IS REFUSED, SAYING WHAT RESOLVES IT', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    const round = [...co.rounds.values()][0]!;
    const raised = round.opened.retirement!;
    round.opened = { ...round.opened, retirement: { ...raised, atHead: 'ab'.repeat(32) } };
    /* RED WHEN: a boundary is judged at a head this device cannot read back from the anchored history. */
    await expect(co.deviceOf(CY).remove(BO)).rejects.toThrow(/names an anchored head this device has not checked.*Check the company's records on this device from its first header/u);
    const { atHead: _h, ...withoutAHead } = raised;
    round.opened = { ...round.opened, retirement: withoutAHead };
    /* RED WHEN: a raise that names no head is approved, its boundary judged against whatever is anchored now. */
    await expect(co.deviceOf(CY).remove(BO)).rejects.toThrow(/does not name the anchored head its boundary was taken at/u);
    expect(co.chain.has(BO.seat)).toBe(true);
  });

  it('A RAISE NAMING AN OLDER HEAD THAN ITS RAISER READ, WITH A BOUNDARY SHORTER THAN THAT HEAD HOLDS, IS REFUSED', async () => {
    const co = aCompany();
    co.leaverFilesPool(6);
    /* The raise anchors the leaver's pool version 6 first (batch 2) and names that head. */
    await co.deviceOf(ADA).remove(BO);
    const round = [...co.rounds.values()][0]!;
    expect(round.opened.retirement!.atHead).toBe(co.headOf(2));
    /* The terms instead name the company's first head, where the leaver had filed policy version 1, and keep nothing. */
    round.opened = { ...round.opened, retirement: { ...round.opened.retirement!, atHead: co.headOf(1), filedUpTo: {} } };
    /* RED WHEN: a boundary short of what the leaver had anchored at the head the raise names is approved. */
    await expect(co.deviceOf(CY).remove(BO)).rejects.toThrow(/as the anchored records held them at the head the removal was raised over/u);
    expect(co.chain.has(BO.seat)).toBe(true);
  });

  it('A BOUNDARY ABOVE WHAT THE LEAVER FILED IS REFUSED: NO RETIRED SEAT IS SIGNED A FUTURE', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    const round = [...co.rounds.values()][0]!;
    /* A raiser wrote a boundary past the last pool version the leaver filed, and one for a record it never filed. */
    round.opened = { ...round.opened, retirement: { ...round.opened.retirement!, filedUpTo: { 'spending-policy:pol_1': 1, [`vault:${'ff'.repeat(32)}:pool`]: 999 } } };
    /* RED WHEN: a retirement's boundary is checked only from below, so a retired seat keeps filing up to a number someone wrote. */
    await expect(co.deviceOf(CY).remove(BO)).rejects.toThrow(/does not keep exactly the last version of each record/u);
    round.opened = { ...round.opened, retirement: { ...round.opened.retirement!, filedUpTo: { 'spending-policy:pol_1': 2 } } };
    await expect(co.deviceOf(CY).remove(BO)).rejects.toThrow(/does not keep exactly the last version of each record/u);
    expect(co.log).toEqual(['raise remove bo', 'approve by ada signing the retirement for 4']);
  });

  it('A SERVICE THAT WITHHOLDS THE RETIREMENT SIGNATURES HOLDS THE REMOVAL UP: THE CHAIN IS NEVER ASKED WITHOUT THE RETIREMENT', async () => {
    const co = aCompany();
    co.withhold();
    await co.deviceOf(ADA).remove(BO);
    const out: RemovalOutcome = await co.deviceOf(CY).remove(BO);
    /* RED WHEN: the chain takes the leaf off while the retirement could not be filed. */
    expect(out).toMatchObject({ state: 'waiting-for-the-retirement', signed: 1, needed: 2 });
    /* RED WHEN: a removal held up for its retirement is not said with how many seats signed it and how many it needs. */
    expect(out.state === 'waiting-for-the-retirement' ? [out.signed, out.needed] : null).toEqual([1, 2]);
    /* RED WHEN: what a removal still short of its retirement says does not name what resolves it, or claims something was sent. */
    expect(new RetirementNotYetSigned(1, 2).message).toMatch(/signed by 1 of the 2 seats.*Nothing was sent\. Each signer who approved it opens the removal again/u);
    expect(co.log.some((x) => x.startsWith('carry'))).toBe(false);
    expect(co.chain.has(BO.seat)).toBe(true);
  });

  it('WHEN ANOTHER CHANGE TAKES THE VERSION A SIGNATURE NAMED, A SEAT THAT APPROVED SIGNS AGAIN FOR THE NEXT ONE, AND NOBODY APPROVES TWICE', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    co.anotherVersion();
    await co.deviceOf(ADA).remove(BO);
    /* RED WHEN: a signature for a version another change took is left as the only one, so the retirement can never be filed. */
    expect(co.log).toContain('ada signs the retirement again for 5');
    expect(co.log.filter((x) => x.startsWith('approve by ada'))).toHaveLength(1);
    expect((await co.deviceOf(CY).remove(BO)).state).toBe('done');
    expect(co.log).toContain('file retirement 5');
  });

  it('A REMOVAL THE CHAIN CARRIED OUT FIRST IS FINISHED FROM A STAYING DEVICE WITH THE SIGNATURES IT KEPT, THOUGH THE SERVICE NO LONGER SERVES THEM', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    /* Cy approves and signs; her page cannot file the retirement, so it carries nothing out. */
    await expect(co.deviceOf(CY, { files: false }).remove(BO)).rejects.toThrow(/cannot file a retirement/u);
    /* Ada's device opens the removal again, reads the quorum's signatures, and keeps them. */
    const adaKept: KeptDirectoryChange[] = [];
    await expect(co.deviceOf(ADA, { files: false, kept: adaKept }).remove(BO)).rejects.toThrow(/cannot file a retirement/u);
    expect(adaKept.map((k) => [k.signedAt, k.change.signatures.length])).toEqual([[4, 2]]);
    /* A signer carries the removal out on the chain with no retirement filed, and the service then serves no signature. */
    co.chain.delete(BO.seat);
    co.withhold();
    /* RED WHEN: a device holding no copy files a retirement nobody signed enough of, or one is signed again by anybody. */
    expect(await co.deviceOf(CY, { keepsSignatures: false }).remove(BO)).toMatchObject({ state: 'waiting-for-the-retirement', signed: 1, needed: 2 });
    expect(co.dir.seats.find((x) => x.seat === BO.seat)!.retired).toBeNull();
    /* RED WHEN: the staying device that kept the signed retirement does not file it once the chain has taken the leaf off. */
    expect((await co.deviceOf(ADA, { kept: adaKept, keepsSignatures: false }).remove(BO)).state).toBe('done');
    expect(co.dir.seats.find((x) => x.seat === BO.seat)!.retired).not.toBeNull();
    expect(co.log.filter((x) => x.startsWith('raise'))).toEqual(['raise remove bo']);
  });

  it('EACH APPROVING DEVICE KEEPS ITS OWN SIGNATURE AND EVERY ONE IT READ, SO A SERVICE THAT STOPS SERVING THEM HOLDS NOTHING UP', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    /* Cy reads Ada's signature as she opens the removal, approves and signs; her page cannot file, so nothing is carried out. */
    await expect(co.deviceOf(CY, { files: false }).remove(BO)).rejects.toThrow(/cannot file a retirement/u);
    co.withhold();
    co.chain.delete(BO.seat);
    co.anotherRemovalCarried();
    /* RED WHEN: a device keeps neither its own signature nor those it read, so the service can withhold the retirement for good. */
    expect((await co.deviceOf(CY).remove(BO)).state).toBe('done');
    expect(co.dir.seats.find((x) => x.seat === BO.seat)!.retired).not.toBeNull();
  });

  it('A REMOVAL RAISED BEFORE ANOTHER SIGNER WAS REMOVED IS NEVER APPROVED OR CARRIED, AND NOTHING IS FILED', async () => {
    const co = aCompany({ seated: [ADA, BO, CY, DEE] });
    await co.deviceOf(ADA).remove(BO);
    co.anotherRemovalCarried();
    /* RED WHEN: a device approves, or files the retirement for, a removal the chain will refuse because a signer left since. */
    const refused = await co.deviceOf(CY).remove(BO).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RemovalRaisedAgain);
    expect((refused as Error).message).toMatch(/raise the removal again/u);
    expect(co.log).toEqual(['raise remove bo', 'approve by ada signing the retirement for 5']);
    expect(co.dir.seats.find((x) => x.seat === BO.seat)!.retired).toBeNull();
  });

  it('A CARRYING OUT THAT LOSES TO ANOTHER DEVICE\'S IS READ BACK FROM THE CHAIN AS DONE', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    const cy = co.deviceOf(CY);
    /* Another device carries the removal out while Cy's is building its call. */
    const build = cy.doors.builder.governedCall;
    (cy.doors.builder as { governedCall: typeof build }).governedCall = async (a) => {
      if (a.order.circuit === 'amendSigner') { co.chain.delete(BO.seat); const [id, round] = [...co.rounds.entries()][0]!; co.rounds.set(id, { ...round, status: 'executed' }); }
      return build(a);
    };
    /* RED WHEN: a removal the chain carried out is answered as a failure because another device carried it first. */
    expect((await cy.remove(BO)).state).toBe('done');
  });

  it('A CARRYING OUT THAT FAILS AFTER THE RETIREMENT IS ANCHORED IS SENT AGAIN BY ANOTHER DEVICE, WITH NOTHING SIGNED AGAIN', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    co.failsOnce();
    await expect(co.deviceOf(CY).remove(BO)).rejects.toThrow(/nothing was written/u);
    expect(co.dir.seats.find((x) => x.seat === BO.seat)!.retired).not.toBeNull();
    /* RED WHEN: a retired seat still on the chain holds its own removal up, or is filed again. */
    expect((await co.deviceOf(ADA).remove(BO)).state).toBe('done');
    expect(co.chain.has(BO.seat)).toBe(false);
    expect(co.log.filter((x) => x.startsWith('file retirement'))).toHaveLength(1);
  });

  it('NO BAR ON CHANGING WHO IS SEATED RISES WHILE A REMOVAL IS UNDER WAY', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    const { changeThresholdOnDevice } = await import('./governed-call-on-device.js');
    /* RED WHEN: the account's threshold is raised past the bar while a removal is raised, so it could never be carried out. */
    await expect(changeThresholdOnDevice(co.deviceOf(CY).doors, { viewingKey: KEY, newThreshold: 3, seated: 3 })).rejects.toThrow(/while a removal of a signer is raised/u);
    /* The control: a threshold at the bar waits for nothing. */
    await expect(changeThresholdOnDevice(co.deviceOf(CY).doors, { viewingKey: KEY, newThreshold: 2, seated: 3 })).resolves.toBeDefined();
  });

  it('EVERY CHANGE THAT RAISES THE BAR WAITS FOR A REMOVAL UNDER WAY: A VAULT\'S THRESHOLD, THE POLICY BAR, AND A POLICY WHOSE HIGHEST BAND WAS NOT GIVEN', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    const doors = co.deviceOf(CY).doors;
    const vault = 'fa'.repeat(32);
    /* RED WHEN: a vault's own approvals above the seat bar are raised while a removal is raised, raising the bar with them. */
    await expect(governOnDevice(doors, { viewingKey: KEY, change: { kind: 'vault-threshold', vault, threshold: '3' }, summary: 'vault', body: { vault: vault as Hex, newThreshold: 3 } }))
      .rejects.toThrow(/while a removal of a signer is raised/u);
    /* RED WHEN: the approvals a policy change needs are raised past the seat bar while a removal is raised. */
    await expect(setPolicyBarOnDevice(doors as never, { viewingKey: KEY, newBar: 3, seated: 3 })).rejects.toThrow(/while a removal of a signer is raised/u);
    /* RED WHEN: a spending policy whose highest band this device was not given is taken as raising no bar. */
    await expect(governOnDevice(doors, { viewingKey: KEY, change: { kind: 'spending-policy', vault, assetKey: '0b'.repeat(32), commitment: '0c'.repeat(32) }, summary: 'policy', body: {} as never }))
      .rejects.toThrow(/while a removal of a signer is raised/u);
    expect(co.log).toEqual(['raise remove bo', 'approve by ada signing the retirement for 4']);
    /* The control: a policy whose highest band is at the seat bar waits for nothing here, and is raised and approved (carrying it out is the policy page's). */
    await governOnDevice(doors, { viewingKey: KEY, change: { kind: 'spending-policy', vault, assetKey: '0b'.repeat(32), commitment: '0c'.repeat(32) }, summary: 'policy', body: {} as never, highestBand: 2 })
      .catch(() => undefined);
    expect(co.log.at(-1)).toBe('approve by cy');
  });

  it('A SEAT RETIRED IN THE DIRECTORY THAT THE CHAIN STILL HOLDS IS A REMOVAL UNDER WAY, WITH NO REMOVAL RAISED', async () => {
    const co = aCompany();
    co.dir = { ...co.dir, seats: co.dir.seats.map((x) => (x.seat === BO.seat ? { ...x, retired: { 'spending-policy:pol_1': 1 } } : x)) };
    const { changeThresholdOnDevice } = await import('./governed-call-on-device.js');
    /* RED WHEN: a retired seat the chain still holds is not read as a removal under way once its proposal is gone. */
    await expect(changeThresholdOnDevice(co.deviceOf(CY).doors, { viewingKey: KEY, newThreshold: 3, seated: 3 }))
      .rejects.toThrow(/while a signer's seat is retired in the company's directory and the chain still holds it/u);
    expect(co.log).toEqual([]);
  });

  it('A REMOVAL FILED WITH THE SERVICE AND NEVER RAISED ON THE CHAIN SETS NO BOUNDARY: NOTHING IS PASSED OVER, NO POLICY IS REFUSED, NO BAR RISE WAITS', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    const cy = co.deviceOf(CY).doors;
    /* The control: raised on the chain, the removal sets its boundary. */
    expect([...(await leavingBoundariesHere(cy, KEY)).keys()]).toEqual([BO.signing.publicKey]);
    co.neverRaisedOnTheChain();
    /* RED WHEN: a removal the chain never held sets a boundary every device passes the seat's versions over by. */
    expect([...(await leavingBoundariesHere(cy, KEY)).keys()]).toEqual([]);
    /* RED WHEN: a policy filed by a seat a removal the chain never held is about is refused as a leaving seat's. */
    expect([...(await seatsLeavingHere(cy, KEY))]).toEqual([]);
    const { changeThresholdOnDevice } = await import('./governed-call-on-device.js');
    /* RED WHEN: a removal the chain never held holds a rise of the bar up (here the rise is raised, and the test's chain shows nothing more). */
    const rise = await changeThresholdOnDevice(cy, { viewingKey: KEY, newThreshold: 3, seated: 3 }).catch((e: unknown) => e);
    expect(rise instanceof Error ? rise.message : '').not.toMatch(/while a removal of a signer is raised/u);
    expect(co.log.filter((x) => x.startsWith('raise'))).toHaveLength(2);
  });

  it('A LEAF THE DIRECTORY HOLDS NO ENTRY FOR IS REMOVED WITH NO RETIREMENT', async () => {
    const co = aCompany({ onlyOnTheChain: [DEE] });
    await co.deviceOf(ADA).remove(DEE);
    expect((await co.deviceOf(CY).remove(DEE)).state).toBe('done');
    /* RED WHEN: a leaf with no directory entry can never be removed, or is removed with a retirement nothing can believe. */
    expect(co.log).toEqual(['raise remove dee', 'approve by ada', 'approve by cy', 'carry amendSigner removing']);
    expect(co.chain.has(DEE.seat)).toBe(false);
  });
});

describe('THE LEAVING SEAT\'S OWN DEVICE STOPS FILING ONCE ITS REMOVAL IS RAISED', () => {
  it('THE LEAVER\'S DEVICE ENTERS NOTHING MORE, AND A STAYING SEAT\'S DEVICE GOES ON', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    const bo = co.deviceOf(BO).doors;
    /* RED WHEN: the leaving seat's device is not told that its removal is raised. */
    expect(await ownRemovalRaisedHere(bo, KEY)).toMatch(/removal of this signer's seat is raised/u);
    expect(await ownRemovalRaisedHere(co.deviceOf(CY).doors, KEY)).toBeNull();
    /* RED WHEN: a spending policy's approval is not told which seat a raised removal is about (its `leaving` door). */
    expect([...await seatsLeavingHere(co.deviceOf(CY).doors, KEY)]).toEqual([BO.signing.publicKey]);
    const entered: string[] = [];
    const manifest = { newest: async () => [], enter: async (_a: string, e: readonly ManifestEntry[]) => { entered.push(...e.map((x) => x.id)); } };
    const leaver = recordsEnteredFor(manifest, ACC, BO.signing.secret, () => ownRemovalRaisedHere(bo, KEY));
    /* RED WHEN: an entry is entered from the leaving seat's device after its removal is raised. */
    await expect(leaver.enter([{ store: 'company', kind: 'spending-policy', id: 'pol_1', version: 2, digest: '02'.repeat(32) }])).rejects.toThrow(FiledNotEntered);
    expect(entered).toEqual([]);
    const stayer = recordsEnteredFor(manifest, ACC, CY.signing.secret, () => ownRemovalRaisedHere(co.deviceOf(CY).doors, KEY));
    await stayer.enter([{ store: 'company', kind: 'spending-policy', id: 'pol_1', version: 2, digest: '02'.repeat(32) }]);
    expect(entered).toEqual(['pol_1']);
  });
});

describe('NOTHING IN THE REMOVAL READS THE SUPER ADMINS', () => {
  it('THE REMOVAL\'S CODE NAMES NO COMMITTEE AND NO SUPER ADMIN', () => {
    const source = readFileSync(new URL('./governed-call-on-device.ts', import.meta.url), 'utf8');
    const removal = source.slice(source.indexOf('/* ── A SIGNER REMOVED, FROM THIS DEVICE'));
    expect(removal.length).toBeGreaterThan(1000);
    /* RED WHEN: a check, rule or refusal of a signer's removal reads the account's committee or the super admin role. */
    expect(removal.match(/committee|super.?admin/giu) ?? []).toEqual([]);
  });
});
