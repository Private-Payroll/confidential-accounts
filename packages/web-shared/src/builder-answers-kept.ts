/**
 * **WHAT THE BUILDER WORKS OUT FROM WHAT IT IS ASKED ALONE, ASKED ONCE ON THIS DEVICE.** The leaf and tag a seat's
 * opening makes on an account, the proposal a change makes with a salt, the head a head step makes and the seats
 * holders name depend on nothing but what is asked and the build that answers, so each is asked of a builder once
 * for as long as this device keeps that builder. Openings and proposals not yet held are asked together, in parts of
 * at most 256; heads and holders (`anchorHeadsKept`) in one call. An ask that fails, or that answers with an entry
 * missing, keeps nothing, so the next read asks again.
 */
import { canonical } from '../../../src/core/crypto.js';
import type { ProposalIdentityOf, SeatByAddressChange } from '../../../src/core/invitation.js';
import { JoinedAsks } from './company-view-batch.js';
import type { SeatOpeningsAnswer } from './vault-worker-wire.js';
import type { VaultBuilderClient } from './vault-worker-client.js';

/** The three parts of a seat's opening the builder reads. */
export interface OpeningAsked {
  readonly publicKey: string;
  readonly scope: string;
  readonly blinding: string;
}
type OpeningAnswered = SeatOpeningsAnswer['openings'][number];
type Answering = Pick<VaultBuilderClient, 'seatOpenings' | 'proposalIdentity'>;
type IdentityAsked = { readonly change: SeatByAddressChange; readonly salt: string };

/** The answers kept for one builder: the openings by account, and the proposals by change and salt. */
interface Kept {
  readonly openings: Map<string, JoinedAsks<OpeningAsked, OpeningAnswered>>;
  readonly identities: JoinedAsks<IdentityAsked, { readonly chainId: string }>;
}

const keptFor = new WeakMap<object, Kept>();

const keptOf = (builder: Answering): Kept => {
  let kept = keptFor.get(builder);
  if (kept === undefined) {
    kept = {
      openings: new Map(),
      identities: new JoinedAsks<IdentityAsked, { readonly chainId: string }>(
        (i) => canonical([i.change, i.salt]),
        (part) => Promise.all(part.map((i) => builder.proposalIdentity(i.change, i.salt)))
      )
    };
    keptFor.set(builder, kept);
  }
  return kept;
};

const openingKeyOf = (o: OpeningAsked): string =>
  `${String(o.publicKey).toLowerCase()}:${String(o.blinding).toLowerCase()}:${String(o.scope).toLowerCase()}`;

/** The builder's answers that depend only on what is asked, each asked once while this device keeps `builder`. */
interface BuilderAnswers {
  /** What each opening makes on `account`, in the order asked: its leaf and tag, null where the builder found none. */
  openings(account: string, openings: readonly OpeningAsked[]): Promise<readonly OpeningAnswered[]>;
  /** The proposal a change makes with a salt. */
  readonly proposalIdentity: ProposalIdentityOf;
}

export const builderAnswersOf = (builder: Answering): BuilderAnswers => {
  const kept = keptOf(builder);
  return Object.freeze<BuilderAnswers>({
    openings: (account, openings) => {
      const on = String(account).toLowerCase();
      let joined = kept.openings.get(on);
      if (joined === undefined) {
        joined = new JoinedAsks<OpeningAsked, OpeningAnswered>(
          openingKeyOf,
          async (part) =>
            (
              await builder.seatOpenings({
                account,
                openings: part.map((o) => ({ publicKey: o.publicKey, scope: o.scope, blinding: o.blinding }))
              })
            ).openings
        );
        kept.openings.set(on, joined);
      }
      return joined.many(openings);
    },
    proposalIdentity: (change, salt) => kept.identities.get({ change, salt })
  });
};

type HeadsAnswering = Pick<VaultBuilderClient, 'anchorHeads'>;
type HeadsAsked = Parameters<VaultBuilderClient['anchorHeads']>[0];
type HeadsAnswer = Awaited<ReturnType<VaultBuilderClient['anchorHeads']>>;
/** What a head step makes, and what holders name: each kept by what was asked. */
interface HeadsKept {
  readonly after: Map<string, { readonly head: string; readonly seats: string[] | null }>;
  readonly holders: Map<string, string[] | null>;
}

const headsKeptFor = new WeakMap<object, HeadsKept>();

/**
 * The heads a builder makes from head steps, and the seats holders name, each asked of `builder` once for as long as
 * this device keeps it: only what is not yet held is asked, in one call. An answer that does not hold a string head
 * and a seats entry for each step asked, and a seats entry for each holders asked, keeps nothing and is refused: it
 * answers only the part not held yet, in its own order, so no caller can match it to what it asked.
 */
export const anchorHeadsKept = (builder: HeadsAnswering): HeadsAnswering['anchorHeads'] => {
  let kept = headsKeptFor.get(builder);
  if (kept === undefined) {
    kept = { after: new Map(), holders: new Map() };
    headsKeptFor.set(builder, kept);
  }
  const k = kept;
  return async (ask: HeadsAsked): Promise<HeadsAnswer> => {
    const steps = ask.after.map((s) => canonical(s));
    const holders = (ask.holders ?? []).map((h) => canonical(h));
    const after = [
      ...new Map(ask.after.map((s, i) => [steps[i]!, s] as const).filter(([key]) => !k.after.has(key))).values()
    ];
    const more = [
      ...new Map(
        (ask.holders ?? []).map((h, i) => [holders[i]!, h] as const).filter(([key]) => !k.holders.has(key))
      ).values()
    ];
    if (after.length > 0 || more.length > 0) {
      const a = await builder.anchorHeads(more.length === 0 ? { after } : { after, holders: more });
      const whole =
        Array.isArray(a?.after) &&
        a.after.length === after.length &&
        a.after.every((h) => typeof h === 'string') &&
        Array.isArray(a.seats) &&
        a.seats.length === after.length &&
        Array.isArray(a.holderSeats) &&
        a.holderSeats.length === more.length;
      if (!whole)
        throw new Error(
          'the builder did not answer one head and one list of seats for each step asked, and one list of seats for each holder asked, so nothing of its answer is believed.'
        );
      after.forEach((s, i) => k.after.set(canonical(s), { head: a.after[i]!, seats: a.seats[i] ?? null }));
      more.forEach((h, i) => k.holders.set(canonical(h), a.holderSeats[i] ?? null));
    }
    return {
      after: steps.map((key) => k.after.get(key)!.head),
      seats: steps.map((key) => k.after.get(key)!.seats),
      holderSeats: holders.map((key) => k.holders.get(key)!)
    };
  };
};
