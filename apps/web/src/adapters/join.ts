import { typedAddressIsShielded } from 'midnight-identity/profile/address-claim';
import {
  EMPLOYEE_CLASSIFICATIONS, InvitationNotOpened, INVITATION_KINDS, invitationIdOf, invitationLink, offerExpiredRefusal, openOffer, type SignedOffer,
} from '../../../../src/core/invitation.js';
import type { Sealed } from '../../../../src/core/crypto.js';
import type { Role } from '../../../../src/core/types.js';
import type { StepAt } from 'midnight-identity/profile/channel';
import { pageWireSend } from 'vaults-web-shared/http-sealed-pool-store.js';
import { claimIntentOf, InvitationRefused, openInvitationHere, type InvitationSend } from 'vaults-web-shared/invitation-on-device.js';
import { joinByCodeInTheWallet } from 'vaults-web-shared/join-in-the-wallet.js';
import { actOnACompanyInTheWallet } from 'vaults-web-shared/keyring.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { keyringFor } from './keyring-person.js';
import { ACT_REFUSAL, ACTED, refusalOf, type ActRefusal } from './refusals.js';

/*
 * THE JOIN PAGE'S READS AND ACTS. The page holds the invitation's id and token in memory (`useHeldLink`). This opens the
 * offer with the device's own check (`openInvitationHere`), says which kind and which way it is, and runs the one wallet
 * act that kind and way need. The page is told nothing secret: the payee's fingerprint is shown in the wallet's window only.
 */

/** The three ways a person takes an invitation, each its own wallet act. */
export const WAY = { seat: 'seat', code: 'code', claim: 'claim' } as const;
type Way = (typeof WAY)[keyof typeof WAY];

/** What opening an invitation came to. */
const OPENED = { offered: 'offered', closed: 'closed' } as const;

/** The kind of invitation that is a seat, and the first working time an employee is offered. */
const SEAT_KIND = 'signer';
export const FULL_TIME: NonNullable<Offered['classification']> = EMPLOYEE_CLASSIFICATIONS[0];

/** The wallet's name for the act that takes a seat, and what a stop of an act is called. */
const ACT = { seatInvited: 'seat-invited' } as const;
const AFTER = { stopped: 'stopped' } as const;

/** Why an invitation is not offered. The first five are the service's own refusals of a closed invitation. */
export const CLOSED = {
  notFound: 'not-found', withdrawn: 'withdrawn', expired: 'expired', used: 'used', notAccepted: 'not-accepted',
  notOpened: 'not-opened', superAdmin: 'super-admin', reissue: 'reissue', seatByAddressOnly: 'seat-by-address-only', unreachable: 'unreachable',
} as const;
export type ClosedWhy = (typeof CLOSED)[keyof typeof CLOSED];

const SERVICE_CLOSED: ReadonlySet<string> = new Set([CLOSED.notFound, CLOSED.withdrawn, CLOSED.expired, CLOSED.used, CLOSED.notAccepted]);

type Opened = Awaited<ReturnType<typeof openInvitationHere>>;

/** What the offer says, for the page to show, and the opened offer the act is run from. */
export interface Offered {
  readonly id: string;
  readonly token: string;
  readonly kind: 'employee' | 'vendor' | 'signer';
  readonly way: Way;
  readonly record: string;
  readonly label: string;
  readonly account: string;
  readonly companyName: string;
  readonly name: string;
  readonly title: string | null;
  readonly role: Role | null;
  readonly classification: 'full-time' | 'part-time' | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  /** The address the invitation was made at, when it was made at one. */
  readonly address: string | null;
  /** Whether that address is a private (shielded) one. */  readonly expiresAt: string;
  readonly opened: Opened;
}

type Opening = { readonly of: typeof OPENED.offered; readonly offer: Offered } | { readonly of: typeof OPENED.closed; readonly why: ClosedWhy; readonly expiresAt: string | null };

const closed = (why: ClosedWhy, expiresAt: string | null = null): Opening => ({ of: OPENED.closed, why, expiresAt });

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** What kind and way an opened offer is, or the reason this page does not take it. */
function offeredFrom(id: string, opened: Opened): Opening {
  const o = (opened.signed as SignedOffer).offer;
  const f = o.for;
  if (f.kind === 'super-admin') return closed(CLOSED.superAdmin);
  if (f.kind === 'reissue') return closed(CLOSED.reissue);
  const base = {
    id, token: opened.token, record: o.company, label: o.label as string, account: o.account as string, companyName: o.companyName, name: f.name,
    expiresAt: opened.expiresAt, opened,
  };
  if (f.kind === SEAT_KIND) {
    const terms = f.invited.terms;
    if (f.byAddress === undefined || terms.invite === undefined || terms.proposal === undefined) return closed(CLOSED.seatByAddressOnly);
    return {
      of: OPENED.offered,
      offer: {
        ...base, kind: SEAT_KIND, way: WAY.seat, title: null, role: f.role, classification: null, startDate: null, endDate: null,
        address: null,
      },
    };
  }
  if (!(INVITATION_KINDS as readonly string[]).includes(f.kind)) return closed(CLOSED.notOpened);
  const address = text(f.address);
  const priv = address === null || typedAddressIsShielded(address);
  return {
    of: OPENED.offered,
    offer: {
      ...base, kind: f.kind, way: priv ? WAY.code : WAY.claim, title: f.kind === 'employee' ? text(f.title) : null, role: null,
      classification: f.kind === 'employee' ? f.classification ?? null : null, startDate: text(f.startDate), endDate: text(f.endDate),
      address,
    },
  };
}

/** Open the invitation the page holds. Nothing is sent but the read of the offer, which asks for no sign-in. */
function notOpenedAs(token: string, sealed: Sealed | null): Opening {
  if (sealed === null) return closed(CLOSED.notOpened);
  try {
    const offer = openOffer(sealed, token as never).offer;
    return offerExpiredRefusal(offer, Date.now()) === null ? closed(CLOSED.notOpened) : closed(CLOSED.expired, new Date(offer.expiresAt).toISOString());
  } catch {
    return closed(CLOSED.notOpened);
  }
}


export async function openTheInvitation(id: string, token: string, personId: string | null): Promise<Opening> {
  let sealed: Sealed | null = null;
  try {
    const link = invitationLink(window.location.origin, token as never);
    if (invitationIdOf(token as never) !== id) return closed(CLOSED.notOpened);
    const wire = pageWireSend(() => personId);
    const send: typeof wire = async (path, init) => {
      const answer = await wire(path, init);
      const b = answer.body as { offer?: Sealed } | null;
      if (b !== null && typeof b === 'object' && b.offer !== undefined) sealed = b.offer;
      return answer;
    };
    const opened = await openInvitationHere(link, send as InvitationSend);
    return offeredFrom(id, opened);
  } catch (e) {
    if (e instanceof InvitationRefused) {
      return e.refused !== null && SERVICE_CLOSED.has(e.refused) ? closed(e.refused as ClosedWhy) : closed(CLOSED.unreachable);
    }
    if (e instanceof InvitationNotOpened) return notOpenedAs(token, sealed);
    return closed(CLOSED.unreachable);
  }
}

/** The refusals of a wallet act a person can act on, each with words of its own on the page. */
export const STOPPED = {
  used: 'used', expired: 'expired', alreadySeated: 'already-seated', usedByThisWallet: 'used-by-this-wallet', notHeld: 'not-held',
  noSavedKeys: 'no-saved-keys', noSlots: 'no-slots', notByAddress: 'not-by-address', noOffer: 'no-offer', anotherCompany: 'another-company',
  byPublicAddress: 'by-public-address', notTaken: 'not-taken', notSent: 'not-sent', notAsked: 'not-asked', takenByAnother: 'taken-by-another',
  noFreeSeat: 'no-free-seat', other: 'other',
} as const;
export type StoppedWhy = (typeof STOPPED)[keyof typeof STOPPED];

/** The reason a wallet act stopped, from the refusal key it ended with (`act.<action>.why.<reason>`), else `other`. */
export function stoppedAs(refused: string | undefined): StoppedWhy {
  const m = refused === undefined ? null : /^act\.[a-z-]+\.why\.([a-z-]+)$/u.exec(refused);
  const why = m === null ? undefined : Object.values(STOPPED).find((s) => s === m[1]);
  return why ?? STOPPED.other;
}

/** The stops whose own words say nothing was sent or taken, which a stop that handed transactions over contradicts. */
export const SAYS_NOTHING_SENT: ReadonlySet<StoppedWhy> = new Set<StoppedWhy>([
  STOPPED.notSent, STOPPED.notTaken, STOPPED.notAsked, STOPPED.noSlots, STOPPED.anotherCompany,
]);

/** `handedOver` on a stop: the wallet handed the page transactions before it stopped (sent or not confirmed), whatever the reason. */
export type Joined =
  | { readonly of: typeof ACTED.done }
  | { readonly of: typeof AFTER.stopped; readonly why: StoppedWhy; readonly step: number; readonly steps: number; readonly handedOver: boolean }
  | { readonly of: typeof ACTED.refused; readonly why: ActRefusal };

/** Run the wallet act this offer needs. The wallet shows what it will do and asks; a payee's fingerprint stays in its window. */
export async function joinTheCompany(personId: string, offer: Offered, onStep: (at: StepAt) => void = () => {}): Promise<Joined> {
  try {
    if (ACCOUNT_ORIGIN === '') return { of: ACTED.refused, why: ACT_REFUSAL.notSetUp };
    if (!(await keyringFor(personId))) return { of: ACTED.refused, why: ACT_REFUSAL.notSignedIn };
    const ask = { record: offer.record, company: offer.label, account: offer.account, token: offer.token };
    const watch = { onStep };
    const ended = offer.way === WAY.code
      ? await joinByCodeInTheWallet(ask as never, ACCOUNT_ORIGIN, watch)
      : await actOnACompanyInTheWallet(
        offer.way === WAY.claim ? { ...claimIntentOf(offer.opened) } : { name: ACT.seatInvited, ...ask }, ACCOUNT_ORIGIN, watch,
      );
    if (ended.of === 'done') return { of: ACTED.done };
    return { of: AFTER.stopped, why: stoppedAs(ended.refused), step: ended.step, steps: ended.steps, handedOver: ended.relayed > 0 || ended.unconfirmed > 0 };
  } catch (e) {
    return { of: ACTED.refused, why: refusalOf(e) };
  }
}
