/**
 * **THE ADD-SIGNER KIND OF THE ONE APPROVAL, IN THE WALLET**: a proposal to seat a person, invited by address or joined
 * by a link or a code, approved from this seat through the one approve step (`approveStep`). The proposal is read from
 * the company's records with the company's keys and the person waiting from its inbox, never as the page or the service
 * describe them; a proposal that invites or seats anybody other than the window shows, or that names an address the
 * person's own wallet did not sign for their seat, is refused before anything is sent.
 */
import type { ActIntent } from 'midnight-identity/profile/request';
import type { Hex } from '../../../../src/core/crypto.js';
import type { SealedProposal } from '../../../../src/core/types.js';
import { isSignerRole, type SignerRole } from '../../../../src/core/roles.js';
import { invitationThresholdRefusal } from '../../../../src/core/invitation.js';
import { addSignerByAddressIn } from '../../../../src/core/proposal-filing.js';
import { SeatKeyNotFromTheInvitee } from '../../../../src/core/seat-invite-proof.js';
import {
  approveSeatInvitationOnDevice, governedCallServiceFor, InvitationNotBound, InvitationOutrun, NothingToApprove, withCompanyKeys,
} from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { NotOpenedOnThisDevice } from '../../../../packages/web-shared/src/round-opened-here.js';
import { WaitingIdTaken } from '../../../../packages/web-shared/src/roster-here.js';
import { approveSeatByLeafOnDevice, seatByLeafToConfirmHere } from '../../../../packages/web-shared/src/signer-by-link.js';
import { chainTimeOf } from './chain-time.js';
import { governanceDoorsFor, type CompanyReach, type Handed } from './company-reach.js';
import { codeOfError, StepRefused, type ShownLine, type StepContext, type Words } from './definition.js';
import { said, type ApprovalStop, type OpenedRound, type ProposalKind } from './proposal-kinds.js';
import { anchorDirectoryDoorIn } from './upkeep.js';

/** What the add-signer kind reads beside the company. */
export interface AddSignerReach {
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The account's own functions: the address an invitation's coin key and salt make, and the rights of every vault. */
  readonly commitments: () => Promise<{ inviteAddressOf(coinPublicKey: Hex, salt: Hex): Hex; allVaults(): Hex }>;
  readonly waitMs?: number;
  readonly everyMs?: number;
}

/** The signer role an add-signer proposal names, or null: a seat it adds holds a leaf, so it is never a reader's. */
export const roleOf = (x: string | undefined): SignerRole | null => (isSignerRole(x) ? x : null);
/** The threshold an invitation sets once its seat is taken, as the page showed it: none, '' and '0' all keep the one in force. */
const shownThresholdOf = (x: string | undefined): string | null => (x === undefined || x === '' || x === '0' ? null : x);
const addSignerWhy = (stop: ApprovalStop | string, values?: Readonly<Record<string, string | number>>): Words => {
  const key = ({ closed: 'carried-out', counted: 'already-counted', 'not-raised': 'not-approved' } as Record<string, string>)[stop] ?? stop;
  return {
    key: `act.approve-proposal.why.${key}`,
    ...(values === undefined ? (key === 'not-approved' ? { values: { says: 'The company holds no proposal raised on the chain for this change. Nothing was sent.' } } : {}) : { values }),
  };
};

/** Whether the page names a seat by its leaf: a person who joined by a link or a code, whose proposal names the leaf they sent. */
const byLeaf = (intent: ActIntent): boolean => (intent.fields['leaf'] ?? '') !== '';

/** The fields a seat added by address needs beside the person's name and role; a seat named by its leaf needs only `leaf`. */
const BY_ADDRESS_FIELDS = ['address', 'scope', 'coinKey'] as const;

/** The doors this seat approves a seat through, its sends marked in `handed`, at the pace this kind's reach sets. */
const doorsOf = (reach: AddSignerReach, r: CompanyReach, ctx: StepContext, handed: Handed) => ({
  ...governanceDoorsFor(r, (ms) => reach.pause(ms, ctx.signal), handed, {
    ...(reach.waitMs === undefined ? {} : { waitMs: reach.waitMs }), ...(reach.everyMs === undefined ? {} : { everyMs: reach.everyMs }),
  }),
  anchorDirectory: anchorDirectoryDoorIn(r, handed),
});

/** The lines the window shows for a seat added by address: who, the role, the address, its coin key, the rights and the threshold once seated. */
const shownByAddress = async (reach: AddSignerReach, intent: ActIntent): Promise<readonly ShownLine[]> => {
  const f = intent.fields;
  const all = await reach.commitments().then((c) => c.allVaults().toLowerCase(), () => {
    /* Without the account's own functions the rights are shown as the page named them, never as every vault. */
    return null;
  });
  return [
    { key: 'act.approve-proposal.shown.name', values: { name: f['personName'] ?? '' }, from: 'page' },
    ...(roleOf(f['role']) === null ? [] : [{ key: `act.approve-proposal.shown.role.${roleOf(f['role'])!}`, from: 'page' as const }]),
    { key: 'act.approve-proposal.shown.address', values: { address: f['address'] ?? '' }, from: 'page' },
    { key: 'act.approve-proposal.shown.coin-key', values: { coinKey: f['coinKey'] ?? '' }, from: 'page' },
    all !== null && (f['scope'] ?? '').toLowerCase() === all
      ? { key: 'act.approve-proposal.shown.every-vault', from: 'action' }
      : { key: 'act.approve-proposal.shown.scope', values: { scope: f['scope'] ?? '' }, from: 'page' },
    ...(shownThresholdOf(f['threshold']) === null ? [] : [{
      key: 'act.approve-proposal.shown.new-threshold', values: { threshold: shownThresholdOf(f['threshold'])! }, from: 'page' as const,
    }]),
    { key: 'act.approve-proposal.shown.checks', from: 'action' },
    { key: 'act.approve-proposal.shown.approve', from: 'action' },
  ];
};

/** The lines the window shows for a seat named by its leaf: who and the role; the fingerprint follows, read, for the person to confirm. */
const shownByLeaf = (intent: ActIntent): readonly ShownLine[] => [
  { key: 'act.approve-proposal.shown.name', values: { name: intent.fields['personName'] ?? '' }, from: 'page' },
  ...(roleOf(intent.fields['role']) === null ? [] : [{ key: `act.approve-proposal.shown.role.${roleOf(intent.fields['role'])!}`, from: 'page' as const }]),
  { key: 'act.approve-proposal.shown.approve', from: 'action' },
];

/** What a seat named by its leaf is approved with: the fingerprint the person confirmed, which the person waiting read out. */
interface ReadOutHere { readonly readOut: string }

/**
 * Opens a proposal to seat a leaf, held to the person waiting for it (`seatByLeafToConfirmHere`) and to the person,
 * role and leaf the page showed, and gives the lines the person confirms: the rights the seat would carry, as the
 * proposal's invitation names them, and the fingerprint of the keys in the request of the person waiting, whose
 * own wallet signed the address the proposal seats.
 */
const openedByLeaf = async (reach: AddSignerReach, ctx: StepContext, r: CompanyReach, intent: ActIntent): Promise<OpenedRound> => {
  const f = intent.fields;
  const id = f['proposal']!;
  const commitments = await reach.commitments();
  let read: Awaited<ReturnType<typeof seatByLeafToConfirmHere>>;
  try {
    read = await seatByLeafToConfirmHere(doorsOf(reach, r, ctx, { over: false }), withCompanyKeys({
      proposal: id, inviteAddressOf: (c: Hex, salt: Hex) => commitments.inviteAddressOf(c, salt),
    }, r.companyKeys));
  } catch (e) {
    if (e instanceof InvitationNotBound || e instanceof NotOpenedOnThisDevice || e instanceof SeatKeyNotFromTheInvitee || e instanceof WaitingIdTaken) {
      throw new StepRefused(addSignerWhy('not-approved', { says: said(e) }), codeOfError(e));
    }
    throw e;
  }
  const t = read.proposal.invited.terms;
  if (t.name !== f['personName'] || t.role !== roleOf(f['role']) || String(t.leaf).toLowerCase() !== f['leaf']!.toLowerCase()) {
    throw new StepRefused(addSignerWhy('not-approved', { says: SEATS_ANOTHER_THAN_SHOWN }), 'invitation-not-bound');
  }
  return {
    id, chainId: read.proposal.chainId, read: { readOut: read.fingerprint } satisfies ReadOutHere,
    confirm: [await rightsFiled(reach, t.invite!.scope), { key: 'act.approve-proposal.confirm.fingerprint', values: { name: t.name, fingerprint: read.fingerprint } }],
  };
};

/**
 * The rights the seat would carry, as the proposal's own invitation names them and never as the page does: every
 * vault, or the rights it names. Without the account's own functions the rights are shown as named.
 */
const rightsFiled = async (reach: AddSignerReach, scope: string): Promise<Words> => {
  const all = await reach.commitments().then((c) => c.allVaults().toLowerCase(), () => {
    /* Without the account's own functions the rights cannot be read as every vault: they are shown as the proposal names them. */
    return null;
  });
  return all !== null && scope.toLowerCase() === all
    ? { key: 'act.approve-proposal.shown.every-vault' }
    : { key: 'act.approve-proposal.shown.scope', values: { scope: scope.toLowerCase() } };
};

/** Why a proposal to seat a leaf is refused when it seats another person, role or leaf than the page showed, and what clears it. */
const SEATS_ANOTHER_THAN_SHOWN = 'The proposal the company holds under that name seats another person, role or leaf than the ones '
  + 'shown, so nothing was approved. Nothing was sent. Do not approve it: reload the page and check it again.';

/**
 * **ADDING A SIGNER INVITED BY ADDRESS, OR ONE WHO JOINED BY A LINK OR A CODE.** A seat invited by address is opened
 * and checked exactly as `approveSeatInvitationOnDevice` does before anything is signed (the person, role, address,
 * rights, threshold once seated and coin key shown, the coin key making that address, the address not already seated
 * or invited, no second believed record under the same identity on the chain, and then the change's own checks, a new
 * threshold among them, counted with the seat on the vaults its rights reach). A seat the page names by its leaf is
 * opened first, before anything is sent, as `seatByLeafToConfirmHere` does, and the fingerprint of the keys it would
 * seat is shown for the person to confirm against the one the person waiting reads out to them; it is then approved as
 * `approveSeatByLeafOnDevice` does, held to that fingerprint. The account needs the higher of the hold's approvals, the
 * threshold and the seat bar, and no signer removed since the raise. The invitee carries it out by taking the seat, and
 * the account sets the new threshold then.
 */
export function addSignerKind(reach: AddSignerReach): ProposalKind {
  return {
    fields: ['personName', 'role'],
    changesTheCompany: true,
    readsFirst: byLeaf,
    shown: async (intent): Promise<readonly ShownLine[]> => (byLeaf(intent) ? shownByLeaf(intent) : shownByAddress(reach, intent)),
    check: (intent) => {
      if (roleOf(intent.fields['role']) === null) return addSignerWhy('not-a-proposal');
      if (byLeaf(intent)) return null;
      if (BY_ADDRESS_FIELDS.some((k) => (intent.fields[k] ?? '') === '')) return addSignerWhy('not-a-proposal');
      const t = shownThresholdOf(intent.fields['threshold']);
      return t !== null && invitationThresholdRefusal(t) !== null ? addSignerWhy('not-a-threshold') : null;
    },
    opened: async (ctx, r, intent) => {
      if (byLeaf(intent)) return openedByLeaf(reach, ctx, r, intent);
      const id = intent.fields['proposal']!;
      const rec = ((await governedCallServiceFor(r.api).sealedProposals!(r.accountId)) as readonly SealedProposal[]).find((p) => p.id === id);
      /* The identity is the one the signed filing and the signed invitation both name, checked here (`addSignerByAddressIn`). */
      const body = rec === undefined ? null : addSignerByAddressIn(rec, r.accountId, r.companyKeys);
      if (body === null) {
        throw new StepRefused(addSignerWhy('not-approved', {
          says: 'The company holds no proposal to add a seat by address under that name that this device can open, so nothing was approved. Nothing was sent. Reload the page.',
        }), 'invitation-not-bound');
      }
      return { id, chainId: body.chainId };
    },
    /* The hold's approvals where the chain shows one (every raise writes it), and never fewer than the threshold and the seat bar now. */
    needed: (round, held) => Math.max(round.needed ?? 0, held.approvals, held.seatBar),
    approve: async (ctx, r, intent, round, handed) => {
      const f = intent.fields;
      const doors = doorsOf(reach, r, ctx, handed);
      try {
        const commitments = await reach.commitments();
        if (byLeaf(intent)) {
          await approveSeatByLeafOnDevice(doors, withCompanyKeys({
            proposal: f['proposal']!, readOut: (round.read as ReadOutHere).readOut, inviteAddressOf: (c: Hex, salt: Hex) => commitments.inviteAddressOf(c, salt),
          }, r.companyKeys));
          return;
        }
        const threshold = shownThresholdOf(f['threshold']);
        await approveSeatInvitationOnDevice(doors, withCompanyKeys({
          shown: {
            proposal: f['proposal']!, name: f['personName']!, role: roleOf(f['role'])!, address: f['address']!, scope: f['scope']!, coinPublicKey: f['coinKey']!,
            ...(threshold === null ? {} : { threshold }),
          },
          chainTime: chainTimeOf(r),
        }, r.companyKeys), (c, salt) => commitments.inviteAddressOf(c, salt));
      } catch (e) {
        if (e instanceof InvitationOutrun) throw new StepRefused(addSignerWhy('outrun'), codeOfError(e));
        if (e instanceof NothingToApprove || e instanceof InvitationNotBound || e instanceof NotOpenedOnThisDevice) {
          throw new StepRefused(addSignerWhy(handed.over ? 'may-be-sent' : 'not-approved', { says: said(e) }), codeOfError(e));
        }
        throw e;
      }
    },
    stateAt: (atItsBar, _approvedNow, outrun) => (outrun ? 'outrun' : atItsBar ? 'waiting-for-the-invitee' : 'waiting-for-approvals'),
    why: addSignerWhy,
  };
}
