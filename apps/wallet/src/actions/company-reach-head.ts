/*
 * THE HEAD OF EVERY REACH OF A COMPANY: the company the page names, the person's saved keys, and the account its label
 * is pinned to. Every reach of a company runs it before it reads anything (`companyReachFor`, `chainOnlyReachFor`, and
 * `keptReach` before any reach a step is handed), so a page naming a second account under a label this wallet pinned
 * is refused before a read is made for it. With no pin for the label, a pending seat the person confirmed for this
 * company and the chain seats is pinned (`pinTheJoiner`); else the person's own registry entries are asked once, over
 * the chain the reach gives (`pinRestoredFor`), and the one account they name for the label is pinned; else it is
 * refused, as a clash when they name two accounts, as unread when a registry could not be read, or as no pin. Once the
 * seat is chosen, it must be the one this wallet's words make for the pinned label, so the seat an action signs with is
 * tied to the pinned account.
 */
import {
  readAccountAddress,
  readCompanyLabel,
  type AccountAddress,
  type CompanyLabel
} from 'midnight-identity/profile/company-label';
import type { Identity } from 'midnight-identity/keys/derivation';
import type { PendingSeat, SavedAccountKeys } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { Hex } from '../../../../src/core/crypto.js';
import type { AccountBuilding } from '../chain/account-builder-client.js';
import { FOUNDING_SEAT } from '../keyring/founding-seat.js';
import { seatAt } from '../keyring/seat-at.js';
import { pinHeldFor, pinnedFor, pinTheJoiner, type PinHeld } from './company-pin.js';
import type { ActKeyring, StepContext } from './definition.js';
import type { CompanyChain } from './company-reach.js';
import { registryEntryOwed, registryWriteThrough, type SeatToEnter } from './registry-entry.js';
import { pinRestoredFor, restoreFinderOf } from './pin-restored.js';

/**
 * Every refusal the head raises, under the action's own words (`act.<action>.why.<key>`): the page names no company;
 * no saved keys are open to read a pin from; the label is pinned to another account; no account is pinned for it; the
 * saved seat is not one this wallet's words make for the pinned company.
 */
export const HEAD_REFUSALS = [
  'not-a-company',
  'no-saved-keys',
  'pinned-elsewhere',
  'no-pin',
  'label-clash',
  'registry-unread',
  'seat-not-yours'
] as const;
export type HeadRefusal = (typeof HEAD_REFUSALS)[number];

/** The company the page names and the saved keys it is reached with, and that its label is pinned to that account. */
export interface ReachHead {
  readonly accountId: string;
  readonly label: CompanyLabel;
  readonly account: AccountAddress;
  readonly keyring: ActKeyring;
  readonly pin: PinHeld;
}

/**
 * What the head reads only when the label has no pin: the account's seats now, the leaf a pending seat makes, and the
 * chain the person's registry entries are read on.
 */
export interface HeadReads {
  readonly seats: (label: CompanyLabel, account: AccountAddress) => Promise<readonly string[]>;
  readonly leafOf: (pending: PendingSeat) => Promise<string>;
  readonly chain: Pick<CompanyChain, 'indexer' | 'registryEntry'>;
}

/**
 * **THE PIN CHECK BEFORE ANY READ**: the refusal for the page's label, or null. Refused when no saved keys are open
 * to read a pin from, or when the label is pinned to another account than the page's. No pin is left to the reach.
 */
export function pinRefusal(ctx: Pick<StepContext, 'intent' | 'keyring'>): HeadRefusal | null {
  const label = readCompanyLabel(ctx.intent.fields['company']);
  const account = readAccountAddress(String(ctx.intent.fields['account'] ?? '').toLowerCase());
  if (label === null || account === null) return null;
  const read = pinnedFor(ctx, label);
  if (read.of === 'not-open') return 'no-saved-keys';
  return read.of === 'pinned' && read.account !== account ? 'pinned-elsewhere' : null;
}

/** A pending seat kept for this company that the person confirmed for the page's label and account. */
const confirmedFor = (
  pending: Readonly<Record<string, PendingSeat>> | undefined,
  accountId: string,
  label: string,
  account: string
): readonly PendingSeat[] =>
  Object.values(pending ?? {}).filter(
    (p) =>
      p.accountId === accountId &&
      p.joining?.confirmed === true &&
      p.joining.label === label &&
      String(p.joining.account).toLowerCase() === account
  );

/**
 * **THE HEAD**: the page's company, the saved keys, and the pin for its label naming the page's account, before any
 * read. Only with no pin does it read: a confirmed pending seat whose leaf the account seats is pinned, else the
 * person's own registry entries are asked once, else the reach is refused (a clash and an unread registry each by
 * their own refusal).
 */
export async function companyReachHead(
  ctx: StepContext,
  refuse: (key: HeadRefusal) => never,
  reads: HeadReads
): Promise<ReachHead> {
  const accountId = ctx.intent.fields['record'] ?? refuse('not-a-company');
  const label = readCompanyLabel(ctx.intent.fields['company']) ?? refuse('not-a-company');
  const account =
    readAccountAddress(String(ctx.intent.fields['account'] ?? '').toLowerCase()) ?? refuse('not-a-company');
  if (ctx.keyring === null) return refuse('no-saved-keys');
  const keyring = ctx.keyring;
  const before = pinRefusal(ctx);
  if (before !== null) return refuse(before);
  const held = (): PinHeld | null => pinHeldFor(ctx, label, account);
  if (held() === null) {
    for (const p of confirmedFor(keyring.open().read().pendingSeats, accountId, label, account)) {
      const pinned = await pinTheJoiner(ctx, p, await reads.leafOf(p), await reads.seats(label, account), account);
      if (pinned.of === 'another') refuse('pinned-elsewhere');
      if (pinned.of === 'pinned') break;
    }
  }
  const find = restoreFinderOf(reads.chain);
  if (held() === null && find !== null) {
    const restored = await pinRestoredFor(ctx, label, find);
    if (restored.of === 'clash') refuse('label-clash');
    if (restored.of === 'unread') refuse('registry-unread');
    if (pinRefusal(ctx) !== null) refuse('pinned-elsewhere');
  }
  const pin = held() ?? refuse('no-pin');
  return Object.freeze({ accountId, label, account, keyring, pin });
}

/**
 * **THE SEAT PART, AFTER THE FIRST READ**: the saved seat must be seat `seat.seat` (the founding seat when it names
 * none) of this wallet's words for the pinned label, by its signing secret. With the leaf check on the pinned account,
 * this ties the seat an action signs with to the pinned company.
 */
export async function seatOfThePin(
  identity: Identity,
  head: Pick<ReachHead, 'label'>,
  seat: SavedAccountKeys & { readonly scope: Hex },
  refuse: (key: HeadRefusal) => never
): Promise<void> {
  const { MidnightCommitments } = await import('../../../../src/midnight/commitments.js');
  const n = seat.seat ?? FOUNDING_SEAT;
  if (!Number.isSafeInteger(n) || n < 0) refuse('seat-not-yours');
  const made = seatAt(identity, head.label, n, seat.scope, MidnightCommitments);
  if (made.signingSecret !== String(seat.signingSecret).toLowerCase()) refuse('seat-not-yours');
}

/** What the person's entry in the network's private registry is written with: the network, and the account builder. */
export interface RegistryEntryDoors {
  readonly network: string;
  readonly build: () => AccountBuilding;
}

/**
 * **THE ENTRY OWED FOR THE SEAT A REACH HOLDS**, named on the step for the run to write after the action's steps,
 * when the chain offers a way to write it, the seat's leaf is seated now and no entry was found written for it. It
 * stands on the head's pin and never reads the pin again.
 */
export function entryOwedThroughTheReach(
  ctx: StepContext,
  chain: CompanyChain,
  head: Pick<ReachHead, 'accountId' | 'label' | 'account' | 'pin'>,
  seat: SavedAccountKeys & { readonly scope: Hex; readonly leaf: Hex },
  seats: readonly string[]
): void {
  const doors = chain.registryEntry;
  if (doors === undefined || ctx.registryEntryOwed === undefined) return;
  const entry: SeatToEnter = {
    accountId: head.accountId,
    label: head.label,
    account: head.account,
    n: seat.seat ?? FOUNDING_SEAT,
    scope: seat.scope,
    leaf: seat.leaf,
    ...(seat.rights === undefined ? {} : { rights: seat.rights }),
    ...(seat.registry === undefined ? {} : { mark: seat.registry })
  };
  if (!registryEntryOwed(entry, { pinned: head.pin.account, page: head.account }, seats)) return;
  ctx.registryEntryOwed(async (c) => {
    await registryWriteThrough(
      c,
      {
        accountId: head.accountId,
        network: doors.network,
        build: doors.build(),
        now: Date.now,
        ...(chain.ownWallet === undefined ? {} : { ownWallet: chain.ownWallet }),
        read: async (registry) => {
          const at = await chain.callState(registry as AccountAddress);
          return at === null ? null : { registryState: at.accountState, parameters: at.parameters };
        }
      },
      entry
    );
  });
}
