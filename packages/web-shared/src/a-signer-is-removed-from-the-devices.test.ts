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
 *     at once, the versions each seat filed of each record, and the time of
 *     the block each batch's anchor and each raise landed in;
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
import { fromHex, newSigningKeypair, newSymmetricKey, parseCanonical, unseal, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { openRecord } from '../../../src/core/sealed-records.js';
import { approverRosterFrom } from '../../../src/core/vault-approvers.js';
import type { RetirementSignature, SealedProposal } from '../../../src/core/types.js';
import {
  applyFiling, asAMember, emptyDirectory, type Directory, type DirectoryFiling, type DirectorySeat, type RotateChange, type SignedChange,
} from '../../../src/midnight/seat-directory.js';
import { directoryEntry, proposalEntry, recordKeyOf, type ManifestEntry } from '../../../src/midnight/record-manifest.js';
import { kindKeyOf } from '../../../src/midnight/records-held.js';
import { COMPANY_RECORD_KINDS, WIRE_RECORDS } from '../../../src/midnight/sealed-record-wire.js';
import type { RetirementTerms } from '../../../src/core/proposal-filing.js';
import type { KeptDirectoryChange } from './tree-kept-here.js';
import type { GovernedCallOrder, OpenedRound, RoundOnChain } from './governed-call-builder.js';
import {
  approveOnDevice, governOnDevice, leavingBoundariesHere, LeavingNotRead, RemovalRaisedAgain, removeSignerOnDevice, RetirementNotYetSigned, seatsLeavingHere,
  type RemovalDoors, type RemovalOutcome, type RetirementSignaturesKept, type RoundOnThePage,
} from './governed-call-on-device.js';
import * as onDevice from './governed-call-on-device.js';
import { signProposalFiling } from '../../../src/core/proposal-filing.js';
import { setPolicyBarOnDevice } from './spending-policy-here.js';
import { chargeTheRunHere } from './run-charged-here.js';
import { boundaryKeyOfEntry } from '../../../src/midnight/record-manifest.js';
import { judgeIn, pastTheRaisedBoundary, type DirectoryHere } from './vault-page-doors.js';
import { FiledNotEntered, recordsEnteredFor } from './record-entered-here.js';
import { believedFilerHere, NotOpenedOnThisDevice } from './round-opened-here.js';

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

interface Person { readonly name: string; readonly seat: string; readonly signing: { secret: Hex; publicKey: Hex }; readonly n: number; readonly released: Hex }
/** A signer, with the key their wallet releases for the company, from which their seat's records key comes. */
const person = (name: string, n: number): Person => ({ name, seat: n.toString(16).padStart(2, '0').repeat(32), signing: newSigningKeypair(), n, released: newSymmetricKey() });
const ADA = person('ada', 0xa1);
const BO = person('bo', 0xb2);
const CY = person('cy', 0xc3);
/** A leaf the chain holds that nobody ever filed a directory entry for. */
const DEE = person('dee', 0xd4);

const seatOf = (p: Person): DirectorySeat => ({
  seat: p.seat, person: p.name, signingKey: p.signing.publicKey, wrappingKey: recordsKeypairFrom(fromHex(p.released)).publicKey,
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
  let bar = o.bar ?? 2;
  const log: string[] = [];
  const chain = new Set([...seated, ...(o.onlyOnTheChain ?? [])].map((p) => p.seat));
  let dir: Directory = { ...emptyDirectory(ACC), version: seated.length, seats: seated.map(seatOf) };
  /* Each change filed to the directory here, by its version: what the anchor holds the digest of. */
  const filedAt = new Map<number, DirectoryFiling>();
  /* The directory's filings as the service serves them: each change filed here, and an entry at every other version. */
  const filings = (): DirectoryFiling[] => Array.from({ length: dir.version }, (_, i) => filedAt.get(i + 1)
    ?? { company: ACC, version: i + 1, change: { kind: 'claim', entry: { person: `entry ${i + 1}` } } as never });
  /* The newest directory version the anchor holds: every one filed, unless a case leaves the last waiting. */
  let anchored = o.waiting ? dir.version - 1 : dir.version;
  /* Each version of each record, and who filed it: the leaving seat filed version 1 of a spending policy. */
  const history = new Map<string, Array<{ version: number; digest: Hex; filedBy: Hex; batch: number; dirVersion: number }>>([
    [POLICY, [{ version: 1, digest: '01'.repeat(32) as Hex, filedBy: BO.signing.publicKey, batch: 1, dirVersion: 1 }]],
  ]);
  const pending: ManifestEntry[] = [];
  /*
   * The account's history as a clock: each block that takes an anchor or a raise is one tick later (a case may let
   * more time pass, `later`). Each batch leaves its own head, which every device here checked: what a removal's raise
   * names its boundary at. `landedAt` is the time of the block each batch's anchor landed in.
   */
  let clock = 1;
  let batches = 1;
  const landedAt = new Map<number, number>([[1, 1]]);
  /* Whether this device's check of the company's records stops short of every head that landed, from batch 2 on. */
  let checksShort = false;
  /* Whether the wallet's indexer holds each proposal raised without the time of the block it was raised in. */
  let raiseTimeUnread = false;
  /*
   * Every read of the account's history at the wallet's indexer counted, the count when an approval was last sent, and
   * the one read (by that count) answered without the proposal raised: an indexer that lost the raise between reads.
   */
  let reads = 0;
  let readsAtApproval = 0;
  let losesTheRaiseAt: number | null = null;
  const headOf = (seq: number): string => seq.toString(16).padStart(64, 'e');
  /* Run while the raise is proved and sent, after the raiser read the records: what another device does meanwhile. */
  let whileTheRaiseIsSent: (() => void) | null = null;
  /*
   * Each proposal: where it stands, what it opens as, the retirement signatures handed in beside it, the account's count
   * of removals and the time when it was raised, the approvals the chain's hold says it needed then (`needs`, where a
   * case sets it), and the signed filing the service serves for it (`filing`).
   */
  const rounds = new Map<string, RoundOnThePage & {
    opened: OpenedRound; signatures: RetirementSignature[]; removals: number; onChainAt: number; needs?: number; filing?: object;
  }>();
  /* The account's count of signers removed, and whether the next carrying out fails as a fee paid for nothing. */
  let removals = 0;
  let failsOnce = false;
  /* Whether every proposal the service keeps was filed and never raised on the chain. */
  let neverRaised = false;
  let withholds = false;
  /* Whether the service serves each proposal without the filing its raising seat signed. */
  let noFilings = false;
  /* Whether the person's wallet answered without the approvals a change of who is seated needs. */
  let barUnread = false;
  const holders = () => ({
    committee: [], seats: [...chain], approvals: 1, vaultThresholds: [], policyBar: bar > 1 ? bar : null, ...(barUnread ? {} : { seatBar: bar }),
    adoptedVaults: [], account: ACCOUNT,
  });
  const here = () => ({
    dir, holders: holders(), another: new Set<string>(), refusedAt: new Set<number>(), leafOf: () => null, at: () => null,
    records: {
      head: headOf(batches), stopped: null, reached: { seq: batches, head: headOf(batches) }, history, notYetAnchored: [...pending],
      seqOfHead: (h: string) => Array.from({ length: batches + 1 }, (_, n) => n).find((n) => headOf(n) === h) ?? null,
      newestLandedBy: (cutoff: number) => {
        const seq = [...landedAt].filter(([, t]) => t > 0 && t <= cutoff).map(([n]) => n).sort((a, b) => b - a)[0];
        return seq === undefined ? 'none' : checksShort && seq > 1 ? 'unread' : { seq };
      },
      directory: new Map(Array.from({ length: anchored }, (_, i) => [i + 1, { digest: directoryEntry(filings()[i]!).digest }] as const)),
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
    log.push(`file ${change.kind === 'rotate' ? 'rotation' : 'retirement'} ${signedFor}`);
    filedAt.set(signedFor, { company: ACC, version: signedFor, change });
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
  const deviceOf = (p: Person, d: {
    statement?: typeof STATEMENT | null; kept?: KeptDirectoryChange[]; files?: boolean; keepsSignatures?: boolean; anchors?: boolean;
    changesTheKey?: boolean; keyFiling?: (change: RotateChange, signedFor: number) => Promise<{ version: number; anchor: object }>;
  } = {}) => {
    const kept = d.kept ?? [];
    /* The retirement signatures this device made or read, by proposal: kept on its own person's device across opens. */
    const signaturesKept = signaturesKeptBy.get(p.name) ?? signaturesKeptBy.set(p.name, new Map()).get(p.name)!;
    const doors: RemovalDoors = {
      service: {
        callState: async () => ({ account: ACCOUNT, blockHash: 'b', accountState: 'AS', parameters: 'PP' }) as never,
        sealedProposals: async () => [...rounds.values()].map((r) => ({
          id: r.id, accountId: ACC, status: r.status, chainId: r.chainId, approvalCount: r.approvalCount ?? 0, createdAt: '2026-10-16',
          ...(r.raisedAt ? { raisedAt: r.raisedAt } : {}), ...(withholds ? {} : { retirementSignatures: [...r.signatures] }),
          ...(noFilings ? {} : r.filing ?? {}),
        }) as unknown as SealedProposal),
        file: async (_acc, body) => {
          /* What the raise sealed, read back with the viewing key: the proposal this company now holds. */
          const envelope = openRecord<{ sealedPayload: Sealed; summary: string; kind: string }>('proposals', ACC, body.proposal.sealed, KEY);
          const sealed = parseCanonical(unseal(envelope.sealedPayload, KEY)) as { leaf: string; retirement?: RetirementTerms };
          log.push(`raise remove ${sealed.leaf === BO.seat ? 'bo' : sealed.leaf === DEE.seat ? 'dee' : sealed.leaf}`);
          const meanwhile = whileTheRaiseIsSent;
          whileTheRaiseIsSent = null;
          meanwhile?.();
          clock += 1;
          rounds.set(body.proposal.id, {
            /* The raise counts as its raiser's approval, as the account's `propose` counts it. */
            id: body.proposal.id, chainId: body.proposal.chainId, status: 'open', approvalCount: 1, raisedAt: 'now', signatures: [], removals, onChainAt: clock,
            filing: body.proposal,
            opened: {
              chainId: body.proposal.chainId, digest: 'dd'.repeat(32), vault: '00'.repeat(32), salt: SALT, summary: envelope.summary,
              filedBy: body.proposal.filedBy.publicKey,
              /* A change other than a removal is opened as no change this file follows. */
              ...(envelope.kind !== 'remove-signer' ? {} : { governance: { kind: 'remove-signer' as const, leaf: sealed.leaf } }),
              ...(sealed.retirement === undefined ? {} : { retirement: sealed.retirement }),
            },
          });
          return page(body.proposal.id);
        },
        send: async (id) => page(id),
        approve: async (id, body) => {
          const r = rounds.get(id)!;
          readsAtApproval = reads;
          log.push(`approve by ${p.name}${body.retirement === undefined ? '' : ` signing the retirement for ${body.retirement.signedFor}`}`);
          if (body.retirement !== undefined && !withholds) r.signatures.push(body.retirement);
          rounds.set(id, { ...r, approvalCount: (r.approvalCount ?? 0) + 1 });
          return page(id);
        },
        retire: async (id, body) => {
          log.push(`${p.name} signs the retirement for ${body.signature.signedFor}`);
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
          if (order.circuit === 'approve' || order.circuit === 'propose') approvedBy.add(`${order.proposal}:${material.signingSecret}`);
          lastOrder = order;
          return { tx: `TX-${order.circuit}` };
        },
        proposalIdentity: async () => ({ digest: 'dd'.repeat(32), chainId: `${(rounds.size + 1).toString(16).padStart(2, '0')}`.repeat(32), noVault: '00'.repeat(32) }),
      },
      material: { signingSecret: p.signing.secret, blinding: '22'.repeat(32), scope: '33'.repeat(32) },
      accountId: ACC,
      records: {
        directory: async () => here() as never,
        roundsOnChain: async (ids: readonly string[]) => Object.fromEntries(ids.map((id, i) => {
          if (i === 0) reads += 1;
          const r = [...rounds.values()].find((x) => x.chainId.toLowerCase() === id.toLowerCase());
          const round: RoundOnChain = r === undefined || neverRaised || reads === losesTheRaiseAt ? { held: 'never', approvals: 0 }
            : r.status === 'executed' ? { held: 'closed', approvals: 0, raisedAt: r.onChainAt, txRef: id, closedBy: ['amendSigner'] }
              : {
                held: 'open', approvals: r.approvalCount ?? 0, ...(raiseTimeUnread ? {} : { raisedAt: r.onChainAt }), txRef: id, ...(r.needs === undefined ? {} : { needed: r.needs }),
                ...(r.removals !== removals ? { outrun: true as const } : {}),
              };
          return [id.toLowerCase(), round];
        })),
      } as never,
      filing: {
        seat: p.seat, keyEpoch: 0, salt: () => SALT, newId: () => `prp_removal${String(rounds.size + 1).padStart(5, '0')}`,
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
        landedAt.set(batch, clock);
        for (const e of pending.splice(0)) {
          if (pastTheRaisedBoundary(leaving, e.filedBy.publicKey, boundaryKeyOfEntry(e), e.version)) { pending.push(e); continue; }
          const key = recordKeyOf(e);
          history.set(key, [...(history.get(key) ?? []), { version: e.version, digest: e.digest, filedBy: e.filedBy.publicKey, batch, dirVersion: dir.version }]);
        }
      } }),
      leaversStatement: async (seat) => (seat.seat === BO.seat && d.statement !== undefined && d.statement !== null ? d.statement as never : null),
      ...(d.files === false ? {} : { directoryChange: fileTheRetirement }),
      /* With `changesTheKey`, this tab holds the key the person's wallet released, and a removal it finishes changes the company's key. */
      ...(d.changesTheKey !== true ? {} : {
        companyKey: {
          filings: async () => filings(),
          served: async () => KEY,
          released: () => p.released,
          askTheWallet: async () => p.released,
          file: d.keyFiling ?? (async (change: RotateChange, signedFor: number) => { await fileTheRetirement(change, signedFor); return { version: signedFor, anchor: { anchored: 1 } }; }),
        },
      }),
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
      landedAt.set(batch, clock);
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
    /** `ms` of block time pass before the next block. */
    later: (ms: number) => { clock += ms; },
    /** The wallet's indexer gives no time for the block the newest batch's anchor landed in. */
    landsWithNoTime: () => { landedAt.set(batches, 0); },
    /** The wallet's indexer gives no time for the block the newest proposal was raised in. */
    raiseLandsWithNoTime: () => { const [id, r] = [...rounds.entries()].at(-1)!; rounds.set(id, { ...r, onChainAt: 0 }); },
    /** The wallet's indexer holds each proposal raised without the time of its block. */
    raiseTimeUnread: () => { raiseTimeUnread = true; },
    /** The reads of the account's history made so far, and the count when an approval was last sent. */
    reads: () => ({ reads, readsAtApproval }),
    /** The wallet's indexer answers the `n`-th read of the account's history, counted from the first, without the raise. */
    losesTheRaiseAt: (n: number) => { losesTheRaiseAt = n; },
    /** Every device's check of the company's records stops short of every head after the first batch's. */
    checksShort: () => { checksShort = true; },
    /** The service serves every proposal without the filing its raising seat signed. */
    servesNoFilings: () => { noFilings = true; },
    /** The person's wallet answers without the approvals a change of who is seated needs. */
    seatBarUnread: () => { barUnread = true; },
    /** The newest proposal raised has `approvals` on the chain (by default the seat bar), however they were given. */
    approvedOnTheChain: (approvals = bar) => { const [id, r] = [...rounds.entries()].at(-1)!; rounds.set(id, { ...r, approvalCount: approvals }); },
    /** The chain's hold for the newest proposal raised says it needed `n` approvals when it was raised. */
    raisedNeeding: (n: number) => { const [id, r] = [...rounds.entries()].at(-1)!; rounds.set(id, { ...r, needs: n }); },
    /** The approvals a change of who is seated needs rise on the chain (a threshold or policy bar carried out elsewhere). */
    barRisesTo: (n: number) => { bar = n; },
    /**
     * `by` raises a proposal on the chain: a run when `governance` is not given, else that change. Its filing is signed by
     * `by`'s filing key, as the service serves it.
     */
    raisedBy: (by: Person, governance?: OpenedRound['governance'], o: { anchored?: boolean; believedFiler?: boolean } = {}) => {
      clock += 1;
      const n = rounds.size + 1;
      const id = `prp_raisedby${String(n).padStart(4, '0')}`;
      const chainId = (0x70 + n).toString(16).repeat(32);
      const filing = signProposalFiling(ACC, {
        id, digest: 'dd'.repeat(32), chainId, keyEpoch: 0, createdAt: '2026-10-17T00:00:00.000Z', sealed: { iv: '00', tag: '00', body: '00' } as never,
      }, by.signing.secret);
      approvedBy.add(`${chainId}:${by.signing.secret}`);
      rounds.set(id, {
        /* Raised by `by`, whose raise counts as their approval. */
        id, chainId, status: 'open', approvalCount: 1, raisedAt: 'now', signatures: [], removals, onChainAt: clock, filing,
        opened: {
          chainId, digest: 'dd'.repeat(32), vault: (governance === undefined ? 'fa' : '00').repeat(32), salt: SALT, summary: 'theirs',
          ...(o.believedFiler === false ? {} : { filedBy: by.signing.publicKey }), ...(governance === undefined ? {} : { governance }),
        },
      });
      /* With `anchored`, its record is anchored in the batch the company's records reached now. */
      if (o.anchored === true) {
        const key = recordKeyOf({ store: 'proposal', kind: 'proposal', id });
        history.set(key, [{ version: 1, digest: proposalEntry(ACC, filing).digest as Hex, filedBy: by.signing.publicKey, batch: batches, dirVersion: dir.version }]);
      }
      return page(id);
    },
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
      'ada signs the retirement for 4',
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
    expect(co.log).toEqual(['raise remove bo', 'bo signs the retirement for 4']);
    expect(co.chain.has(BO.seat)).toBe(true);
    /* RED WHEN: the leaving seat's own approval and signature are not counted toward its removal, or its own raise of it is refused as a proposal a leaver filed. */
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
    expect(co.log).toEqual(['raise remove bo', 'ada signs the retirement for 4']);
    /* The control: raised with the statement, the same device approves it. */
    const again = aCompany({ bar: 3 });
    await again.deviceOf(ADA, { statement: STATEMENT }).remove(BO);
    expect((await again.deviceOf(CY, { statement: STATEMENT }).remove(BO)).state).toBe('waiting-for-approvals');
    expect(again.log).toContain('approve by cy signing the retirement for 4');
  });

  it('THE BOUNDARY SIGNED AT THE RAISE IS FINAL: THE LEAVER FILING BEFORE EACH APPROVAL AND BEFORE THE CARRYING OUT VOIDS NOTHING; WHAT THEY FILE BEFORE THE APPROVAL IS ANCHORED, AND NOTHING FROM THE APPROVAL ON; NONE OF IT IS BELIEVED ONCE THEY LEAVE', async () => {
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
    /* RED WHEN: a removal waiting for its approvals stops a staying device anchoring what the leaver files, or an approved one does not. */
    expect(co.history.get(POLICY)!.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(co.pending.map((e) => e.version)).toEqual([4]);
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

  it('A VERSION THE LEAVER\'S OWN DEVICE ANCHORS AFTER THE RAISE IS NOT BELIEVED ONCE THE REMOVAL IS APPROVED, AND VOIDS NO APPROVAL', async () => {
    const co = aCompany();
    co.leaverFilesPool(6);
    /* The raise anchors the leaver's pool version 6 first, so its boundary keeps it. */
    await co.deviceOf(ADA).remove(BO);
    co.approvedOnTheChain();
    expect([...co.rounds.values()][0]!.opened.retirement!.filedUpTo).toEqual({ 'spending-policy:pol_1': 1, [`vault:${'ff'.repeat(32)}:pool`]: 6 });
    co.leaverFilesPool(7);
    co.leaverAnchorsItsOwn();
    const cy = co.deviceOf(CY);
    const leaving = await leavingBoundariesHere(cy.doors, KEY);
    const here = co.here();
    const read = { store: 'vault' as const, kind: 'pool' as const, id: 'ff'.repeat(32), version: 7, digest: '03'.repeat(32) as Hex };
    /* RED WHEN: a device that knows the removal is approved believes a version the leaver filed past the boundary the raise signed. */
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
    expect(co.log).toEqual(['raise remove bo', 'ada signs the retirement for 4']);
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
    expect(co.log).toContain('ada signs the retirement for 5');
    /* Ada's raise was her approval, signed for 4 beside it: she never approves it on top. */
    expect(co.log.filter((x) => x.startsWith('approve by ada'))).toHaveLength(0);
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
    expect(co.log).toEqual(['raise remove bo', 'ada signs the retirement for 5']);
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

  it('NO BAR ON CHANGING WHO IS SEATED RISES WHILE A REMOVAL IS APPROVED AND NOT YET CARRIED OUT', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    co.approvedOnTheChain();
    const { changeThresholdOnDevice } = await import('./governed-call-on-device.js');
    /* RED WHEN: the account's threshold is raised past the bar while a removal is approved, taking back the approvals it has. */
    await expect(changeThresholdOnDevice(co.deviceOf(CY).doors, { viewingKey: KEY, newThreshold: 3, seated: 3 })).rejects.toThrow(/while a removal of a signer is approved/u);
    /* The control: a threshold at the bar waits for nothing. */
    await expect(changeThresholdOnDevice(co.deviceOf(CY).doors, { viewingKey: KEY, newThreshold: 2, seated: 3 })).resolves.toBeDefined();
  });

  it('EVERY CHANGE THAT RAISES THE BAR WAITS FOR AN APPROVED REMOVAL: A VAULT\'S THRESHOLD, THE POLICY BAR, AND A POLICY WHOSE HIGHEST BAND WAS NOT GIVEN', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    co.approvedOnTheChain();
    const doors = co.deviceOf(CY).doors;
    const vault = 'fa'.repeat(32);
    /* RED WHEN: a vault's own approvals above the seat bar are raised while a removal is approved, raising the bar with them. */
    await expect(governOnDevice(doors, { viewingKey: KEY, change: { kind: 'vault-threshold', vault, threshold: '3' }, summary: 'vault', body: { vault: vault as Hex, newThreshold: 3 } }))
      .rejects.toThrow(/while a removal of a signer is approved/u);
    /* RED WHEN: the approvals a policy change needs are raised past the seat bar while a removal is approved. */
    await expect(setPolicyBarOnDevice(doors as never, { viewingKey: KEY, newBar: 3, seated: 3 })).rejects.toThrow(/while a removal of a signer is approved/u);
    /* RED WHEN: a spending policy whose highest band this device was not given is taken as raising no bar. */
    await expect(governOnDevice(doors, { viewingKey: KEY, change: { kind: 'spending-policy', vault, assetKey: '0b'.repeat(32), commitment: '0c'.repeat(32) }, summary: 'policy', body: {} as never }))
      .rejects.toThrow(/while a removal of a signer is approved/u);
    expect(co.log).toEqual(['raise remove bo', 'ada signs the retirement for 4']);
    /* The control: a policy whose highest band is at the seat bar waits for nothing here, and is raised, which is Cy's approval (carrying it out is the policy page's). */
    const before = co.log.length;
    await governOnDevice(doors, { viewingKey: KEY, change: { kind: 'spending-policy', vault, assetKey: '0b'.repeat(32), commitment: '0c'.repeat(32) }, summary: 'policy', body: {} as never, highestBand: 2 })
      .catch(() => undefined);
    expect(co.log.slice(before)).toHaveLength(1);
    expect(co.log.at(-1)).toMatch(/^raise /u);
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
    co.approvedOnTheChain();
    const cy = co.deviceOf(CY).doors;
    /* The control: raised and approved on the chain, the removal sets its boundary. */
    expect([...(await leavingBoundariesHere(cy, KEY)).keys()]).toEqual([BO.signing.publicKey]);
    co.neverRaisedOnTheChain();
    /* RED WHEN: a removal the chain never held sets a boundary every device passes the seat's versions over by. */
    expect([...(await leavingBoundariesHere(cy, KEY)).keys()]).toEqual([]);
    /* RED WHEN: a policy filed by a seat a removal the chain never held is about is refused as a leaving seat's. */
    expect([...(await seatsLeavingHere(cy, KEY))]).toEqual([]);
    const { changeThresholdOnDevice } = await import('./governed-call-on-device.js');
    /* RED WHEN: a removal the chain never held holds a rise of the bar up (here the rise is raised, and the test's chain shows nothing more). */
    const rise = await changeThresholdOnDevice(cy, { viewingKey: KEY, newThreshold: 3, seated: 3 }).catch((e: unknown) => e);
    expect(rise instanceof Error ? rise.message : '').not.toMatch(/while a removal of a signer is (raised|approved)/u);
    expect(co.log.filter((x) => x.startsWith('raise'))).toHaveLength(2);
  });

  it('A LEAF THE DIRECTORY HOLDS NO ENTRY FOR IS REMOVED WITH NO RETIREMENT', async () => {
    const co = aCompany({ onlyOnTheChain: [DEE] });
    await co.deviceOf(ADA).remove(DEE);
    expect((await co.deviceOf(CY).remove(DEE)).state).toBe('done');
    /* RED WHEN: a leaf with no directory entry can never be removed, or is removed with a retirement nothing can believe. */
    expect(co.log).toEqual(['raise remove dee', 'approve by cy', 'carry amendSigner removing']);
    expect(co.chain.has(DEE.seat)).toBe(false);
  });
});

describe('A REMOVAL FREEZES NOTHING UNTIL IT IS APPROVED', () => {
  const policyRead = (version: number) => ({
    store: 'company' as const, kind: 'spending-policy' as const, id: 'pol_1', version, digest: version.toString(16).padStart(2, '0').repeat(32) as Hex,
  });

  it('A REMOVAL RAISED AND NOT YET APPROVED FREEZES NOTHING: WHAT THE LEAVER FILES IS ANCHORED AND BELIEVED, AND THE BAR MAY RISE', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    const cy = co.deviceOf(CY);
    /* RED WHEN: a raised, unapproved removal counts as leaving. */
    expect([...(await leavingBoundariesHere(cy.doors, KEY)).keys()]).toEqual([]);
    expect([...await seatsLeavingHere(cy.doors, KEY, true)]).toEqual([]);
    co.leaverFilesAgain(2);
    await cy.doors.anchorDirectory!();
    /* RED WHEN: a staying device leaves what the leaver files unanchored while their removal waits for its approvals. */
    expect(co.history.get(POLICY)!.map((v) => v.version)).toEqual([1, 2]);
    const here = co.here();
    /* RED WHEN: a staying device does not believe what the leaver filed while their removal waits for its approvals. */
    expect(judgeIn({ ...here, records: { ...here.records, leaving: await leavingBoundariesHere(cy.doors, KEY) } })(
      BO.signing.publicKey, 'spending-policy', 'spending-policy:pol_1', policyRead(2))).toBeNull();
    const { changeThresholdOnDevice } = await import('./governed-call-on-device.js');
    /* RED WHEN: a removal waiting for its approvals holds a rise of the bar up. */
    const rise = await changeThresholdOnDevice(cy.doors, { viewingKey: KEY, newThreshold: 3, seated: 3 }).catch((e: unknown) => e);
    expect(rise instanceof Error ? rise.message : '').not.toMatch(/while a removal of a signer/u);
    expect(co.log.filter((x) => x.startsWith('raise'))).toHaveLength(2);
  });

  it('A BAR THAT RISES BEFORE A REMOVAL IS APPROVED SENDS IT BACK TO BE RAISED AGAIN: NO DEVICE APPROVES IT AT THE OLD BAR', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    co.barRisesTo(3);
    /* RED WHEN: a removal whose retirement was signed at the old bar is approved once the bar has risen past it. */
    await expect(co.deviceOf(CY).remove(BO)).rejects.toThrow(/signed at 2 approvals, below the 3 a change of who is seated needs now/u);
    expect(co.log).toEqual(['raise remove bo', 'ada signs the retirement for 4']);
    expect(co.chain.has(BO.seat)).toBe(true);
  });

  it('A REMOVAL IS LEAVING ONCE THE CHAIN COUNTS THE HIGHER OF THE SEAT BAR NOW AND THE APPROVALS IT WAS RAISED NEEDING', async () => {
    const co = aCompany({ bar: 2 });
    await co.deviceOf(ADA).remove(BO);
    const cy = co.deviceOf(CY).doors;
    co.approvedOnTheChain(2);
    expect([...await seatsLeavingHere(cy, KEY)]).toEqual([BO.signing.publicKey]);
    co.raisedNeeding(3);
    /* RED WHEN: the approvals the chain's hold says the removal needed when it was raised are not counted, so a threshold lowered since makes it leaving early. */
    expect([...await seatsLeavingHere(cy, KEY)]).toEqual([]);
    co.approvedOnTheChain(3);
    expect([...await seatsLeavingHere(cy, KEY)]).toEqual([BO.signing.publicKey]);
    co.raisedNeeding(1);
    co.approvedOnTheChain(1);
    /* RED WHEN: a removal below the seat bar now counts as leaving because it was raised needing fewer. */
    expect([...await seatsLeavingHere(cy, KEY)]).toEqual([]);
  });

  it('AN APPROVED REMOVAL A LATER REMOVAL OUTRAN IS NOT LEAVING', async () => {
    const co = aCompany({ seated: [ADA, BO, CY, DEE] });
    await co.deviceOf(ADA).remove(BO);
    co.approvedOnTheChain();
    const cy = co.deviceOf(CY).doors;
    expect([...await seatsLeavingHere(cy, KEY)]).toEqual([BO.signing.publicKey]);
    co.anotherRemovalCarried();
    /* RED WHEN: a removal the account will never carry out, since a signer left after it was raised, counts as leaving. */
    expect([...await seatsLeavingHere(cy, KEY)]).toEqual([]);
  });

  it('AN APPROVED REMOVAL IS CARRIED OUT BY ANY STAYING DEVICE, ONE THAT NEITHER RAISED NOR APPROVED IT INCLUDED', async () => {
    const co = aCompany({ seated: [ADA, BO, CY, DEE] });
    await co.deviceOf(ADA).remove(BO);
    co.approvedOnTheChain(2);
    /* RED WHEN: an approved removal waits for the device that raised or approved it to carry it out. */
    expect((await co.deviceOf(DEE).remove(BO)).state).toBe('done');
    expect(co.chain.has(BO.seat)).toBe(false);
    /* Ada's raise was her approval; her signature went with it. */
    expect(co.log.filter((x) => x.startsWith('approve'))).toEqual([]);
    expect(co.log).toContain('ada signs the retirement for 5');
    expect(co.log.slice(-1)).toEqual(['carry amendSigner removing']);
  });

  it('A SEAT WHOSE REMOVAL WAITS FOR ITS APPROVALS STILL CHANGES THE COMPANY\'S KEY; ONE WHOSE REMOVAL IS APPROVED DOES NOT', async () => {
    const after = async (approved: boolean) => {
      const co = aCompany({ seated: [ADA, BO, CY, DEE] });
      await co.deviceOf(ADA).remove(BO);
      expect((await co.deviceOf(CY).remove(BO)).state).toBe('done');
      await co.deviceOf(ADA).remove(CY);
      if (approved) co.approvedOnTheChain();
      return (await co.deviceOf(CY, { changesTheKey: true }).remove(BO)).rotation;
    };
    /* RED WHEN: a seat under a removal still waiting for its approvals is kept from changing the company's key. */
    expect(await after(false)).toMatchObject({ state: 'rotated', epoch: 1 });
    /* RED WHEN: a seat under an approved removal changes the company's key. */
    expect(await after(true)).toMatchObject({ state: 'not-this-seat', why: expect.stringMatching(/removal of this seat is approved/u) });
  });

  it('A PROPOSAL OR RUN RAISED BY A SEAT WHOSE REMOVAL IS RAISED IS NOT APPROVED OR CARRIED OUT FROM A STAYING DEVICE', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    const cy = co.deviceOf(CY).doors;
    const run = co.raisedBy(BO);
    /* RED WHEN: a staying device approves a run raised by a seat whose removal is raised. */
    await expect(approveOnDevice(cy, { round: run, viewingKey: KEY })).rejects.toThrow(/raised by a signer whose removal is raised/u);
    const change = { kind: 'threshold', threshold: '2' } as const;
    co.raisedBy(BO, change);
    const govern = () => governOnDevice(cy, { viewingKey: KEY, change, summary: 'theirs', body: { newThreshold: 2 } as never });
    /* RED WHEN: a staying device approves a change raised by a seat whose removal is raised. */
    await expect(govern()).rejects.toThrow(/raised by a signer whose removal is raised/u);
    co.approvedOnTheChain(1);
    /* RED WHEN: a staying device carries out a change raised by a seat whose removal is raised. */
    await expect(govern()).rejects.toThrow(/raised by a signer whose removal is raised/u);
    expect(co.log.filter((x) => x.startsWith('approve by cy') || x.startsWith('carry'))).toEqual([]);
    /* The control: a run a staying seat raised is approved. */
    const ours = co.raisedBy(ADA);
    await approveOnDevice(cy, { round: ours, viewingKey: KEY });
    expect(co.log.at(-1)).toBe('approve by cy');
  });

  it('A REMOVAL FILED BY A SEAT UNDER A RAISED REMOVAL IS APPROVED AND CARRIED OUT FROM A STAYING DEVICE, AND A RUN THE SAME SEAT FILES STAYS REFUSED', async () => {
    const co = aCompany({ seated: [ADA, BO, CY, DEE], bar: 3 });
    await co.deviceOf(ADA).remove(BO);
    const cy = co.deviceOf(CY);
    /* Bo, whose removal Ada raised, files the removal of Ada, the seat that raised it. */
    await co.deviceOf(BO).remove(ADA);
    /* RED WHEN: a removal filed by a seat under a raised removal is refused for who filed it, so that seat can hold every other signer's removal off. */
    expect((await cy.remove(ADA)).state).toBe('waiting-for-approvals');
    expect(co.log).toContain('approve by cy signing the retirement for 5');
    /* RED WHEN: runs are exempted with the removals: a run the same seat files is approved. */
    const run = co.raisedBy(BO);
    await expect(approveOnDevice(cy.doors, { round: run, viewingKey: KEY })).rejects.toThrow(/raised by a signer whose removal is raised/u);
    /* RED WHEN: a removal filed by a seat under a raised removal is approved but not carried out. */
    expect((await co.deviceOf(DEE).remove(ADA)).state).toBe('done');
    expect(co.chain.has(ADA.seat)).toBe(false);
  });

  it('A REMOVAL THE LEAVER FILED AND LEFT OPEN, PAST ITS RETIREMENT, HOLDS NOTHING UP ONCE THE CHAIN NO LONGER SEATS THE LEAVER: A STAYER\'S RUN IS APPROVED', async () => {
    const co = aCompany({ bar: 2 });
    await co.deviceOf(ADA).remove(BO);
    expect((await co.deviceOf(CY).remove(BO)).state).toBe('done');
    expect(co.chain.has(BO.seat)).toBe(false);
    /* Bo's removal of Ada, who raised his removal, is open on the chain and anchored after his retirement. */
    const counter = co.raisedBy(BO, { kind: 'remove-signer', leaf: ADA.seat }, { anchored: true });
    const cy = co.deviceOf(CY).doors;
    /* From here a proposal opens as the real check of its filer says, over the directory and the chain as they stand now. */
    const opens = seams.opens;
    seams.opens = async (id) => {
      const r = co.rounds.get(id)!;
      await believedFilerHere(cy.records!, ACC, r.filing as never);
      return r.opened;
    };
    try {
      await expect(seams.opens(counter.id)).rejects.toMatchObject({ passedOver: true });
      const run = co.raisedBy(ADA, undefined, { anchored: true });
      /* RED WHEN: a removal its leaver filed past their retirement, once the chain no longer seats them, still makes every staying device refuse to know who is leaving. */
      expect(await approveOnDevice(cy, { round: run, viewingKey: KEY })).toMatchObject({ id: run.id });
    } finally {
      seams.opens = opens;
    }
  });

  it('A PROPOSAL THAT DOES NOT OPEN FOR ANY OTHER REASON STILL STOPS A STAYER\'S RUN: ONE NOBODY ENTERED, OR ONE FILED PAST ITS RETIREMENT BY A SEAT THE CHAIN STILL HOLDS', async () => {
    const opens = seams.opens;
    try {
      const co = aCompany({ bar: 2 });
      await co.deviceOf(ADA).remove(BO);
      const cy = co.deviceOf(CY).doors;
      seams.opens = async (id) => {
        const r = co.rounds.get(id)!;
        await believedFilerHere(cy.records!, ACC, r.filing as never);
        return r.opened;
      };
      /* Ada's own seat filed a proposal the company's records never entered. */
      co.raisedBy(ADA, { kind: 'remove-signer', leaf: CY.seat });
      const run = co.raisedBy(ADA, undefined, { anchored: true });
      /* RED WHEN: a proposal that does not open for a reason other than its leaver filing it past their retirement is read as naming nobody leaving. */
      await expect(approveOnDevice(cy, { round: run, viewingKey: KEY })).rejects.toThrow(/could not be read in full/u);

      const again = aCompany({ bar: 2 });
      const cyAgain = again.deviceOf(CY).doors;
      seams.opens = async (id) => {
        const r = again.rounds.get(id)!;
        await believedFilerHere(cyAgain.records!, ACC, r.filing as never);
        return r.opened;
      };
      /* Bo's seat is retired in the directory, and the chain still holds it: his removal has not been carried out. */
      again.raisedBy(BO, { kind: 'remove-signer', leaf: ADA.seat }, { anchored: true });
      again.dir = { ...again.dir, seats: again.dir.seats.map((x) => (x.seat === BO.seat ? { ...x, retired: {} } : x)) };
      const second = again.raisedBy(ADA, undefined, { anchored: true });
      /* RED WHEN: a proposal past its filer's retirement is read as naming nobody leaving while the chain still seats that filer. */
      await expect(approveOnDevice(cyAgain, { round: second, viewingKey: KEY })).rejects.toThrow(/could not be read in full/u);
    } finally {
      seams.opens = opens;
    }
  });

  it('A PROPOSAL A LEAVER FILED WITHIN THEIR RETIREMENT THAT DOES NOT OPEN FOR ANOTHER REASON STILL STOPS A STAYER\'S RUN, ONCE THE CHAIN NO LONGER SEATS THEM', async () => {
    const co = aCompany({ bar: 2 });
    await co.deviceOf(ADA).remove(BO);
    expect((await co.deviceOf(CY).remove(BO)).state).toBe('done');
    expect(co.chain.has(BO.seat)).toBe(false);
    const cy = co.deviceOf(CY).doors;
    const opens = seams.opens;
    seams.opens = async (id) => {
      const r = co.rounds.get(id)!;
      await believedFilerHere(cy.records!, ACC, r.filing as never);
      return r.opened;
    };
    try {
      /* Bo's proposal was filed within what his retirement kept, but the company's records never entered it. */
      const withheld = co.raisedBy(BO, { kind: 'remove-signer', leaf: ADA.seat });
      const key = `proposal:${withheld.id}`;
      co.dir = { ...co.dir, seats: co.dir.seats.map((x) => (x.seat === BO.seat ? { ...x, retired: { ...(x.retired ?? {}), [key]: 1 } } : x)) };
      const refusal = await seams.opens(withheld.id).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(NotOpenedOnThisDevice);
      expect((refusal as NotOpenedOnThisDevice).passedOver).toBeUndefined();
      expect((refusal as Error).message).not.toMatch(/later than the last version that seat filed before it left/u);
      const run = co.raisedBy(ADA, undefined, { anchored: true });
      /* RED WHEN: any refusal of a retired seat's proposal the chain no longer seats is read as passed over, so a proposal the service withheld or changed no longer stops who is leaving being known. */
      await expect(approveOnDevice(cy, { round: run, viewingKey: KEY })).rejects.toThrow(/could not be read in full/u);
    } finally {
      seams.opens = opens;
    }
  });

  it('A RUN THE LEAVER RAISED, APPROVED WITHOUT A STAYING DEVICE, IS NOT CHARGED TO ITS PERIOD FROM A STAYING DEVICE', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    const run = co.raisedBy(BO, undefined, { anchored: true });
    co.approvedOnTheChain(2);
    const cy = co.deviceOf(CY).doors;
    const records = { ...cy.records!, proposals: () => cy.service.sealedProposals!(ACC) };
    const charge = (proposalId: string) => chargeTheRunHere({ records, accountId: ACC, viewingKey: KEY } as never,
      { order: { vault: 'fa'.repeat(32), asset: '0b'.repeat(32) } as never, proposalId });
    /* RED WHEN: a staying device charges a run raised by a seat whose removal is raised. */
    await expect(charge(run.id)).rejects.toThrow(/raised by a signer whose removal is raised/u);
    /* The control: a run a staying seat raised goes past who raised it (and stops here at the policy this test gives none of). */
    const ours = co.raisedBy(ADA, undefined, { anchored: true });
    co.approvedOnTheChain(2);
    const other = await charge(ours.id).catch((e: unknown) => e);
    expect(other instanceof Error ? other.message : '').not.toMatch(/raised by a signer whose removal is raised/u);
  });

  it('A RUN A SEAT RAISED BEFORE ITS OWN REMOVAL WAS RAISED IS STILL APPROVED, CHARGED AND PAID FROM A STAYING DEVICE', async () => {
    const co = aCompany();
    /* Ada raises this month's run; it is approved and charged, and some of its people are paid. */
    const run = co.raisedBy(ADA, undefined, { anchored: true });
    co.approvedOnTheChain(2);
    /* Bo then raises Ada's removal. */
    await co.deviceOf(BO).remove(ADA);
    const cy = co.deviceOf(CY).doors;
    const records = { ...cy.records!, proposals: () => cy.service.sealedProposals!(ACC) };
    /* RED WHEN: a staying device refuses to approve a run raised before its raiser's removal was raised, which is within the boundary that removal signed. */
    expect(await approveOnDevice(cy, { round: run, viewingKey: KEY })).toMatchObject({ id: run.id });
    /* RED WHEN: such a run is refused at the charge, or before a payment of the people not yet paid. */
    const charged = await chargeTheRunHere({ records, accountId: ACC, viewingKey: KEY } as never,
      { order: { vault: 'fa'.repeat(32), asset: '0b'.repeat(32) } as never, proposalId: run.id }).catch((e: unknown) => e);
    expect(charged instanceof Error ? charged.message : '').not.toMatch(/raised by a signer whose removal is raised/u);
    await expect(onDevice.refuseARunALeaverRaisedHere(records as never, ACC, KEY, run.id)).resolves.toBeUndefined();
    /* The control: a run Ada raises after her removal was raised is past its boundary, and refused. */
    const after = co.raisedBy(ADA, undefined, { anchored: true });
    await expect(onDevice.refuseARunALeaverRaisedHere(records as never, ACC, KEY, after.id)).rejects.toThrow(/raised by a signer whose removal is raised/u);
    await expect(approveOnDevice(cy, { round: after, viewingKey: KEY })).rejects.toThrow(/raised by a signer whose removal is raised/u);
  });

  it('A REMOVAL A LATER REMOVAL OUTRAN HOLDS NOTHING THE SEAT IT IS ABOUT RAISED', async () => {
    const co = aCompany({ seated: [ADA, BO, CY, DEE] });
    await co.deviceOf(ADA).remove(BO);
    co.anotherRemovalCarried();
    const run = co.raisedBy(BO);
    /* RED WHEN: a removal the account will never carry out still holds the runs of the seat it is about. */
    expect(await approveOnDevice(co.deviceOf(CY).doors, { round: run, viewingKey: KEY })).toMatchObject({ id: run.id });
  });

  it('WHO RAISED A PROPOSAL IS READ FROM THE RECORD THIS DEVICE BELIEVED, AND ONE WITH NO SIGNED FILER, OR WHERE WHO IS LEAVING CANNOT BE READ, IS REFUSED', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    const cy = co.deviceOf(CY).doors;
    const run = co.raisedBy(BO);
    co.servesNoFilings();
    /* RED WHEN: a service that leaves the filing out of a second read gets a leaver's run approved. */
    await expect(approveOnDevice(cy, { round: run, viewingKey: KEY })).rejects.toThrow(/raised by a signer whose removal is raised/u);
    /* RED WHEN: a proposal whose believed record names no signed filer is approved. */
    const unnamed = co.raisedBy(ADA, undefined, { believedFiler: false });
    await expect(approveOnDevice(cy, { round: unnamed, viewingKey: KEY })).rejects.toThrow(/who raised it cannot be said/u);
    /* RED WHEN: a device that cannot read where the proposals stand on the chain reads nobody as leaving, and approves. */
    const ours = co.raisedBy(ADA);
    await expect(approveOnDevice({ ...cy, records: { ...cy.records!, roundsOnChain: undefined } } as never, { round: ours, viewingKey: KEY }))
      .rejects.toThrow(/Read the chain again/u);
  });

  it('AN OPEN PROPOSAL OF A KIND THIS DEVICE DOES NOT ACT ON HOLDS NO APPROVAL UP; ONE THAT DOES NOT OPEN AT ALL DOES', async () => {
    const co = aCompany();
    const cy = co.deviceOf(CY).doors;
    const other = co.raisedBy(BO);
    const ours = co.raisedBy(ADA, undefined, { anchored: true });
    const opens = seams.opens;
    try {
      seams.opens = async (id) => {
        if (id === other.id) throw new NotOpenedOnThisDevice('This proposal pays nothing: it sets up one of the company\'s vaults.', { kind: 'payroll' });
        return opens(id);
      };
      /* RED WHEN: an open proposal whose sealed record names another kind than a removal stops every approval, read as one that might be. */
      expect(await approveOnDevice(cy, { round: ours, viewingKey: KEY })).toMatchObject({ id: ours.id });
      seams.opens = async (id) => {
        if (id === other.id) throw new Error('this proposal does not open on this device');
        return opens(id);
      };
      /* RED WHEN: an open proposal this device cannot open at all is read as no removal where who is leaving must be known. */
      await expect(approveOnDevice(cy, { round: ours, viewingKey: KEY })).rejects.toThrow(/Read the chain again/u);
    } finally {
      seams.opens = opens;
    }
  });

  it('A RUN IS NOT CHARGED OR PAID WHERE THE PAGE GIVES NO PROPOSALS, OR THE COMPANY\'S RECORDS HOLD NO BELIEVED FILING OF IT', async () => {
    const co = aCompany();
    const cy = co.deviceOf(CY).doors;
    const run = co.raisedBy(ADA, undefined, { anchored: true });
    /* RED WHEN: a page with no proposals door charges or pays a run without knowing who raised it. */
    await expect(onDevice.refuseARunALeaverRaisedHere(cy.records as never, ACC, KEY, run.id)).rejects.toThrow(/cannot read the company's proposals/u);
    const records = { ...cy.records!, proposals: () => cy.service.sealedProposals!(ACC) };
    const unanchored = co.raisedBy(ADA);
    /* RED WHEN: a run whose proposal the company's records do not believe as its seat filed it is charged or paid. */
    await expect(onDevice.refuseARunALeaverRaisedHere(records as never, ACC, KEY, unanchored.id)).rejects.toThrow(/does not believe/u);
    /* RED WHEN: a run the company's records do not list is charged or paid. */
    await expect(onDevice.refuseARunALeaverRaisedHere(records as never, ACC, KEY, 'prp_notlisted0000')).rejects.toThrow(/hold no proposal by that name/u);
    /* The control: a run whose record is anchored as its seat filed it goes ahead. */
    await expect(onDevice.refuseARunALeaverRaisedHere(records as never, ACC, KEY, run.id)).resolves.toBeUndefined();
  });

  it('AN UNREAD SEAT BAR REFUSES WHO IS LEAVING WHERE IT MUST BE KNOWN IN FULL, AND OTHERWISE COUNTS EVERY RAISED REMOVAL AS APPROVED', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    co.seatBarUnread();
    const cy = co.deviceOf(CY).doors;
    /* RED WHEN: a read of who is leaving that must be whole answers without the seat bar. */
    await expect(seatsLeavingHere(cy, KEY, true)).rejects.toThrow(LeavingNotRead);
    /* RED WHEN: an unread seat bar reads a raised removal as nobody leaving. */
    expect([...await seatsLeavingHere(cy, KEY)]).toEqual([BO.signing.publicKey]);
  });
});

describe('THE COMPANY\'S KEY CHANGED ONCE A REMOVAL IS DONE', () => {
  it('THE LEAVING SEAT\'S DEVICE NEVER CHANGES THE KEY, EVEN WHEN IT CARRIES ITS OWN REMOVAL; A STAYING DEVICE FINISHING THE REMOVAL THE CHAIN CARRIED OUT CHANGES IT', async () => {
    const co = aCompany();
    expect(await co.deviceOf(ADA, { changesTheKey: true }).remove(BO)).toMatchObject({ state: 'waiting-for-approvals' });
    expect((await co.deviceOf(ADA, { changesTheKey: true }).remove(BO)).rotation).toBeUndefined();
    const carried = await co.deviceOf(BO, { changesTheKey: true }).remove(BO);
    /* RED WHEN: the leaving seat's device files a change of the company's key after carrying out its own removal. */
    expect(carried).toMatchObject({ state: 'done', rotation: { state: 'not-this-seat' } });
    expect(co.chain.has(BO.seat)).toBe(false);
    expect(co.log.filter((x) => x.startsWith('file rotation'))).toEqual([]);
    /* Ada's device opens the removal again: the chain no longer holds the leaf, and its retirement is anchored. */
    const finished = await co.deviceOf(ADA, { changesTheKey: true }).remove(BO);
    /* RED WHEN: a staying device finishing a removal the chain carried out does not change the key. */
    expect(finished).toMatchObject({ state: 'done', rotation: { state: 'rotated', epoch: 1, version: 5 } });
    expect(co.log.slice(-2)).toEqual(['file rotation 5', 'anchor the records']);
    /* RED WHEN: the change of the key does not follow the leaver's retirement, or opens another epoch than the first. */
    expect(co.dir.rotations?.map((r) => [r.epoch, r.after])).toEqual([[1, 4]]);
    /* RED WHEN: a change of the key is filed again once one follows the retirement. */
    expect((await co.deviceOf(CY, { changesTheKey: true }).remove(BO)).rotation).toEqual({ state: 'not-needed' });
  });

  it('WHO IS UNDER AN APPROVED REMOVAL IS READ IN FULL BEFORE THE KEY IS CHANGED, OR THE CHANGE WAITS', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    co.approvedOnTheChain();
    const cy = co.deviceOf(CY).doors;
    expect([...await seatsLeavingHere(cy, KEY, true)]).toEqual([BO.signing.publicKey]);
    const opens = seams.opens;
    seams.opens = async () => { throw new Error('this proposal does not open on this device'); };
    try {
      /* The control: read for anything else, a removal this device cannot open is passed over. */
      expect([...await seatsLeavingHere(cy, KEY)]).toEqual([]);
      /* RED WHEN: a removal this device cannot open is passed over when who is leaving must be known in full. */
      await expect(seatsLeavingHere(cy, KEY, true)).rejects.toThrow(LeavingNotRead);
    } finally {
      seams.opens = opens;
    }
    /* RED WHEN: a page that reads no proposals is read as no one leaving. */
    await expect(seatsLeavingHere({ ...cy, service: { ...cy.service, sealedProposals: undefined } }, KEY, true)).rejects.toThrow(LeavingNotRead);
    /* RED WHEN: a page that cannot read where the proposals stand on the chain is read as no one leaving. */
    await expect(seatsLeavingHere({ ...cy, records: { ...cy.records!, roundsOnChain: undefined } }, KEY, true)).rejects.toThrow(LeavingNotRead);
    await co.deviceOf(ADA).remove(BO);
    expect((await co.deviceOf(BO).remove(BO)).state).toBe('done');
    const stays = co.deviceOf(CY, { changesTheKey: true }).doors;
    const out = await removeSignerOnDevice({ ...stays, service: { ...stays.service, sealedProposals: undefined } }, { viewingKey: KEY, leaf: BO.seat, name: 'bo' });
    /* RED WHEN: a staying device that cannot read who is leaving changes the key once the removal is done. */
    expect(out).toMatchObject({ state: 'done', rotation: { state: 'waits', why: expect.stringMatching(/could not be read in full/u) } });
    expect(co.log.filter((x) => x.startsWith('file rotation'))).toEqual([]);
  });

  it('A CHANGE OF THE KEY THAT FAILS LEAVES THE REMOVAL DONE', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    const out = await co.deviceOf(CY, { changesTheKey: true, keyFiling: async () => { throw new Error('the service is down'); } }).remove(BO);
    /* RED WHEN: a failed change of the key undoes, or throws over, the removal the chain carried out. */
    expect(out).toMatchObject({ state: 'done', rotation: { state: 'not-rotated', why: 'the service is down' } });
    expect(co.chain.has(BO.seat)).toBe(false);
    expect(co.dir.seats.find((x) => x.seat === BO.seat)!.retired).not.toBeNull();
  });
});

describe('THE LEAVING SEAT\'S OWN DEVICE STOPS FILING ONCE ITS REMOVAL IS APPROVED', () => {
  it('THE LEAVER\'S DEVICE FILES WHILE ITS REMOVAL WAITS FOR APPROVALS, THEN ENTERS NOTHING MORE, AND A STAYING SEAT\'S DEVICE GOES ON', async () => {
    const co = aCompany();
    await co.deviceOf(ADA).remove(BO);
    const bo = co.deviceOf(BO).doors;
    /* RED WHEN: a removal raised and not yet approved stops the leaving seat's device filing. */
    expect(await onDevice.ownRemovalApprovedHere(bo, KEY)).toBeNull();
    co.approvedOnTheChain();
    /* RED WHEN: the leaving seat's device is not told that its removal is approved. */
    expect(await onDevice.ownRemovalApprovedHere(bo, KEY)).toMatch(/removal of this signer's seat is approved/u);
    expect(await onDevice.ownRemovalApprovedHere(co.deviceOf(CY).doors, KEY)).toBeNull();
    expect([...await seatsLeavingHere(co.deviceOf(CY).doors, KEY)]).toEqual([BO.signing.publicKey]);
    const entered: string[] = [];
    const manifest = { newest: async () => [], enter: async (_a: string, e: readonly ManifestEntry[]) => { entered.push(...e.map((x) => x.id)); } };
    const leaver = recordsEnteredFor(manifest, ACC, BO.signing.secret, () => onDevice.ownRemovalApprovedHere(bo, KEY));
    /* RED WHEN: an entry is entered from the leaving seat's device after its removal is approved. */
    await expect(leaver.enter([{ store: 'company', kind: 'spending-policy', id: 'pol_1', version: 2, digest: '02'.repeat(32) }])).rejects.toThrow(FiledNotEntered);
    expect(entered).toEqual([]);
    const stayer = recordsEnteredFor(manifest, ACC, CY.signing.secret, () => onDevice.ownRemovalApprovedHere(co.deviceOf(CY).doors, KEY));
    await stayer.enter([{ store: 'company', kind: 'spending-policy', id: 'pol_1', version: 2, digest: '02'.repeat(32) }]);
    expect(entered).toEqual(['pol_1']);
  });
});

describe('A REMOVAL IS RAISED OVER A RECENT HEAD', () => {
  /* Ten minutes of block time, in milliseconds. */
  const WINDOW = 10 * 60 * 1000;
  const STALE = /older than one the company's records held 10 minutes or more before the raise landed.*raises this removal again/u;
  /* While the raise is proved and sent, the leaver anchors a version of its own, and `ms` of block time pass. */
  const aSlowRaise = (co: ReturnType<typeof aCompany>, ms: number, o: { noTime?: boolean } = {}) => co.whileTheRaiseIsSent(() => {
    co.leaverFilesAgain(2);
    co.leaverAnchorsItsOwn();
    if (o.noTime === true) co.landsWithNoTime();
    co.later(ms);
  });

  it('THE WINDOW IS TEN MINUTES OF BLOCK TIME', () => {
    /* RED WHEN: the window a raise's head is held to is not ten minutes of block time in milliseconds. */
    expect(onDevice.RECENT_HEAD_WINDOW).toBe(WINDOW);
  });

  it('A RAISE NAMING A HEAD OLDER THAN ONE THAT LANDED TEN MINUTES BEFORE IT IS NEITHER APPROVED NOR CARRIED OUT, ON THE RAISER\'S DEVICE OR ANY OTHER', async () => {
    const co = aCompany();
    aSlowRaise(co, WINDOW);
    /* RED WHEN: an approval names a head older than one that landed ten minutes before the raise. */
    const raisers = await co.deviceOf(ADA).remove(BO).catch((e: Error) => e.message);
    expect(raisers).toMatch(STALE);
    /* RED WHEN: a refusal on the raiser's own device, after its raise landed, says nothing was sent or that it was not raised. */
    expect(raisers).toMatch(/^This removal is raised, and this device does not approve it or carry it out: .*Nothing more is sent for it from here\.$/u);
    await expect(co.deviceOf(CY).remove(BO)).rejects.toThrow(STALE);
    expect(co.log.filter((x) => x.startsWith('approve') || x.startsWith('carry'))).toEqual([]);
    expect(co.chain.has(BO.seat)).toBe(true);
  });

  it('A RAISE THAT LANDS WITHIN TEN MINUTES OF A NEWER HEAD IS APPROVED AND CARRIED OUT', async () => {
    const co = aCompany();
    aSlowRaise(co, WINDOW - 2);
    expect((await co.deviceOf(ADA).remove(BO)).state).toBe('waiting-for-approvals');
    /* RED WHEN: an honest raise, whose head is newer than every head that landed ten minutes before it, is refused. */
    expect((await co.deviceOf(CY).remove(BO)).state).toBe('done');
    expect(co.chain.has(BO.seat)).toBe(false);
  });

  it('A HEAD WHOSE BLOCK THE WALLET\'S INDEXER GIVES NO TIME FOR IS NEVER THE NEWEST HEAD A RAISE IS HELD TO', async () => {
    const co = aCompany();
    aSlowRaise(co, WINDOW, { noTime: true });
    expect((await co.deviceOf(ADA).remove(BO)).state).toBe('waiting-for-approvals');
    /* RED WHEN: a head whose block the indexer gives no time for counts as landed before the raise, so an honest raise is refused. */
    expect((await co.deviceOf(CY).remove(BO)).state).toBe('done');
  });

  it('A RAISE WHOSE BLOCK THE WALLET\'S INDEXER GIVES NO TIME FOR IS REFUSED, AND RAISED AGAIN BY THE SEAT THAT RAISED IT', async () => {
    const co = aCompany();
    expect((await co.deviceOf(ADA).remove(BO)).state).toBe('waiting-for-approvals');
    co.raiseLandsWithNoTime();
    /* RED WHEN: a raise whose block time is 0 is approved, so how recent its head is goes unjudged. */
    await expect(co.deviceOf(CY).remove(BO)).rejects.toThrow(/the indexer your wallet names gave no time for the block its raise landed in.*raises this removal again/u);
    expect(co.log.filter((x) => x.startsWith('approve by cy'))).toEqual([]);
  });

  it('A RAISE THE WALLET\'S INDEXER DOES NOT YET HOLD IS NOT APPROVED, ON THE RAISER\'S DEVICE OR ANY OTHER: THE CHAIN IS READ AGAIN', async () => {
    const lags = aCompany();
    lags.raiseTimeUnread();
    /* RED WHEN: the raiser's own approval goes ahead while the wallet's indexer has not read the raise's block. */
    await expect(lags.deviceOf(ADA).remove(BO)).rejects.toThrow(/has not shown it yet/u);
    expect(lags.log).toEqual(['raise remove bo']);
    /* How many reads of the account's history an approval makes before it is sent, measured on an honest twin. */
    const twin = aCompany();
    await twin.deviceOf(ADA).remove(BO);
    const before = twin.reads().reads;
    await twin.deviceOf(CY).remove(BO);
    const last = twin.reads().readsAtApproval;
    expect(last).toBeGreaterThan(before);
    const co = aCompany();
    expect((await co.deviceOf(ADA).remove(BO)).state).toBe('waiting-for-approvals');
    /*
     * The indexer loses the raise at the read the check of the removal makes, the one its head is judged by: the read
     * before the approval's own last look at where the proposal stands.
     */
    co.losesTheRaiseAt(last - 1);
    /* RED WHEN: an approval goes ahead for a raise the wallet's indexer no longer holds, so how recent its head is goes unjudged. */
    await expect(co.deviceOf(CY).remove(BO)).rejects.toThrow(/Read the chain again/u);
    expect(co.log.filter((x) => x.startsWith('approve by cy'))).toEqual([]);
  });

  /* `p`'s device, over a service that also lists a signature under `p`'s own key that `p` never made. */
  const primed = (co: ReturnType<typeof aCompany>, p: Person) => {
    const d = co.deviceOf(p);
    const served = d.doors.service.sealedProposals!;
    const doors = { ...d.doors, service: { ...d.doors.service, sealedProposals: async (a: string) => (await served(a)).map((x) => ({
      ...x, retirementSignatures: [...(x.retirementSignatures ?? []), { signedFor: 999, publicKey: p.signing.publicKey, signature: 'aa'.repeat(64) }],
    })) } } as RemovalDoors;
    return { kept: d.kept, remove: () => removeSignerOnDevice(doors, { viewingKey: KEY, leaf: BO.seat, name: 'bo' }) };
  };

  it('A REMOVAL A DEVICE REFUSES GETS NO SIGNATURE OF ITS RETIREMENT AND NO KEPT CHANGE FROM IT, WHATEVER THE SERVICE LISTS UNDER ITS KEY', async () => {
    const co = aCompany();
    aSlowRaise(co, WINDOW);
    await expect(co.deviceOf(ADA).remove(BO)).rejects.toThrow(STALE);
    const ada = primed(co, ADA);
    const cy = primed(co, CY);
    await expect(ada.remove()).rejects.toThrow(STALE);
    await expect(cy.remove()).rejects.toThrow(STALE);
    await expect(cy.remove()).rejects.toThrow(STALE);
    /* RED WHEN: a device signs or hands in the retirement of a removal it refuses, so the service can gather a quorum for terms nobody approved. */
    expect(co.log.filter((x) => x.includes('signs the retirement') || x.startsWith('approve') || x.startsWith('file'))).toEqual([]);
    expect([ada.kept, cy.kept]).toEqual([[], []]);
    expect(co.dir.seats.find((x) => x.seat === BO.seat)!.retired).toBeNull();
  });

  it('A SEAT THAT SIGNED A RETIREMENT SIGNS IT AGAIN ONLY FOR A REMOVAL IT STILL APPROVES', async () => {
    const co = aCompany();
    expect((await co.deviceOf(ADA).remove(BO)).state).toBe('waiting-for-approvals');
    const raised = co.log.length;
    /* The version Ada's signature named is taken, and the approvals a change of who is seated needs rise past the terms. */
    co.anotherVersion();
    co.barRisesTo(3);
    await expect(co.deviceOf(ADA).remove(BO)).rejects.toThrow(/below the 3 a change of who is seated needs now/u);
    /* RED WHEN: a seat signs the retirement again for terms its own device now refuses. */
    expect(co.log.slice(raised).filter((x) => x.includes('signs the retirement'))).toEqual([]);
  });

  it('A SIGNATURE THE SERVICE LISTS UNDER A SEAT\'S KEY THAT THE SEAT NEVER MADE MAKES IT SIGN NOTHING AGAIN; AN HONEST REMOVAL GOES ON', async () => {
    const co = aCompany();
    expect((await co.deviceOf(ADA).remove(BO)).state).toBe('waiting-for-approvals');
    /* RED WHEN: an entry under a seat's key that does not check over the terms makes that seat sign the retirement again. */
    expect((await primed(co, CY).remove()).state).toBe('done');
    /* Only Ada's own signature, given with her raise. */
    expect(co.log.filter((x) => x.includes('signs the retirement'))).toEqual(['ada signs the retirement for 4']);
    expect(co.log).toContain('approve by cy signing the retirement for 4');
    expect(co.chain.has(BO.seat)).toBe(false);
  });

  it('A REMOVAL THE SERVICE KEEPS THAT THE WALLET\'S INDEXER NEVER SHOWED RAISED IS SENT AGAIN, NOT JUDGED AS RAISED', async () => {
    const co = aCompany();
    expect((await co.deviceOf(ADA).remove(BO)).state).toBe('waiting-for-approvals');
    const raised = co.log.length;
    co.neverRaisedOnTheChain();
    /* RED WHEN: a staying device judges as raised a removal the chain never showed, and refuses where it should send the raise again. */
    await expect(co.deviceOf(CY).remove(BO)).rejects.toThrow(/has not shown it yet/u);
    expect(co.log.slice(raised).filter((x) => x.includes('signs the retirement') || x.startsWith('approve by cy'))).toEqual([]);
  });

  it('A DEVICE WHOSE CHECK OF THE RECORDS STOPPED SHORT OF THE HEAD A RAISE IS HELD TO DOES NOT APPROVE IT, AND SAYS TO CHECK THEM FURTHER', async () => {
    const co = aCompany();
    aSlowRaise(co, WINDOW);
    co.checksShort();
    /* RED WHEN: a device that did not check the newest head landed ten minutes before the raise approves it unjudged, or is told the indexer is at fault. */
    await expect(co.deviceOf(ADA).remove(BO)).rejects.toThrow(/has not checked the company's records as far as the newest head.*or approve from a device that has/u);
    expect(co.log.filter((x) => x.startsWith('approve'))).toEqual([]);
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
