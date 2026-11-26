/* A SIGNER INVITED BY ADDRESS TAKES THE SEAT FROM THEIR OWN WALLET. The page names the company and hands the
 * invitation link's token, nothing else: this wallet opens the offer with it, checks the offer is for this company
 * and offers a seat by an address this wallet holds, and refuses when this wallet already holds a seat on the company
 * that the company's account still holds, or when this wallet pinned the company's label to another account. A seat the
 * account no longer holds, whose retirement the company's directory also holds, is set aside in the saved keys, never
 * written over, before the new one is kept.
 * It derives its own seat for the company (the first whose leaf the company's account does not hold and whose pay-key
 * wrap slot no seat has filled), asks the person to compare the company's fingerprint with the one their inviter gave
 * them, keeps the seat in the saved keys as confirmed, proves `seatInvited` with the address's coin key as the
 * proof's witness, and hands the transaction to the invitation's relay. The account refuses it unless the
 * invitation's proposal names this address, these rights and the threshold the seat sets (the signed invitation's,
 * or 0, which keeps the threshold in force), and is approved at the seat bar; a threshold above the seats the account
 * holds once this one is taken is refused here before anything is proved. It then asks to be
 * admitted with its seat's public halves sealed to the company's inbox key, with a proof made with the offer's secret
 * over those halves, the sign-in the page names and the invitation's id (`proveSeatKeys`). With no sign-in named it
 * takes no seat and asks nothing. It keeps the seat again under the id the company gave the request. When the service has already taken the request or fails, it ends waiting for admission:
 * the seat is kept with what asking again needs, and the next act on the company keeps it under the id the company's
 * roster gives it. Wherever it ends with the seat on the chain, the company is pinned to the account the person
 * confirmed. The coin key and the seat's secrets never leave this wallet. */
import { x25519 } from '@noble/curves/ed25519.js';
import { ZswapSecretKeys } from '@midnightntwrk/ledger-v9';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { readAccountAddress, readCompanyLabel, type AccountAddress, type CompanyLabel } from 'midnight-identity/profile/company-label';
import { withNewSeat, withPendingSeat, withSeatSetAside, type Keyring, type PendingSeat, type SavedAccountKeys } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { acceptanceProofOf, invitationIdOf, offerExpiredRefusal, openOffer, thresholdTheInvitationSets, type SignerOffer } from '../../../../src/core/invitation.js';
import { fromHex, signingPublicKeyOf, toHex, type Hex, type Sealed } from '../../../../src/core/crypto.js';
import { sealToInbox } from '../../../../src/core/sealed-records.js';
import { proveSeatKeys } from '../../../../src/core/seat-invite-proof.js';
import type { SeatOpening } from '../../../../src/core/seat-opening.js';
import { storedSignerLeaf } from '../../../../src/core/signer-leaf.js';
import type { PendingSignerPayload } from '../../../../src/core/types.js';
import { watchFor } from '../keyring/nothing-secret-crosses.js';
import { seatAt } from '../keyring/seat-at.js';
import type { AccountBuilding } from '../chain/account-builder-client.js';
import { registryEntryOwed, registryWriteThrough, type SeatToEnter } from './registry-entry.js';
import { pinHeldFor, pinnedFor, pinTheJoiner } from './company-pin.js';
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import { heldAt } from './claim-by-address.js';
import { handOverFor, handOverMarked } from './hand-over-in-the-wallet.js';
import { seated } from './holders-moved-here.js';
import { type CompanyChain } from './company-reach.js';
import { handedOver } from '../../../../packages/web-shared/src/hand-over.js';
import type { Answered } from '../../../../packages/web-shared/src/records-source.js';
import { ActionStopped } from './run.js';
import { StepRefused, type ActionDefinition, type ActionStep, type StepContext, type Words } from './definition.js';
import { signerMaterialOf } from '../../../../packages/web-shared/src/private-state.js';
import { rightsRecordFor, type RightsRecord } from '../../../../src/core/seat-rights.js';
import { retiredInTheDirectory } from '../../../../packages/web-shared/src/role-change-on-device.js';

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.seat-invited.why.${key}`, ...(values === undefined ? {} : { values }),
});
const refuse = (key: string, values?: Readonly<Record<string, string | number>>): never => { throw new StepRefused(why(key, values)); };

/** The most seats one wallet looks through for one company before it gives up finding a free one. */
const MOST_SEATS = 64;

/**
 * What the action reaches beyond the wallet: the company's account as this wallet reads it, its builder, the network,
 * the commitments, and the compiled account's own key of a seat's pay-key wrap slot.
 */
export interface SeatInvitedReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  readonly network: string;
  readonly commitments: () => Promise<{
    signerLeaf(publicKey: Hex, blinding: Hex, scope: Hex): Hex; signerPublicKey(secret: Hex): Hex; allVaults(): Hex;
  }>;
  /** The compiled account's `payKeyWrapKeyOf(account, sk, part)`: where a seat's sealed pay-record key sits in its roles. */
  readonly payKeyWrapKeyOf: () => Promise<(account: Uint8Array, sk: Uint8Array, part: bigint) => Uint8Array>;
  /** The wallet's account builder, which builds the seat's entry in the private registry; absent, no entry is written here. */
  readonly accountBuilder?: () => AccountBuilding;
}

/**
 * **THE JOINER'S PIN, AND ITS ENTRY IN THE PRIVATE REGISTRY**, wherever the admission step ends: once the chain seats
 * the seat's leaf, the company is pinned to the account the person confirmed (`pinTheJoiner`); once the seat is also
 * saved, its entry is named owed for the run to write after the action's steps, through the one fee path. A read of
 * who holds the account that fails leaves both for the next reach of the company, whose head pins a confirmed seat.
 */
async function pinnedAndOwedHere(reach: SeatInvitedReach, ctx: StepContext, company: string, s: Seat): Promise<void> {
  const label = readCompanyLabel(ctx.intent.fields['company']);
  const account = readAccountAddress(ctx.intent.fields['account']);
  if (label === null || account === null || ctx.keyring === null) return;
  let leaves: readonly string[];
  try {
    const holders = await reach.chain().holders(account, label);
    leaves = 'seats' in holders ? holders.seats : [];
  } catch {
    return; /* who holds the account could not be read: the pin and the entry wait for the next reach of the company */
  }
  const pending = ctx.keyring.open().read().pendingSeats?.[signingPublicKeyOf(s.signingSecret).toLowerCase()];
  if (pending !== undefined) await pinTheJoiner(ctx, pending, s.leaf, leaves, account);
  const held = pinHeldFor(ctx, label, account);
  const kept = ctx.keyring.open().read().accounts[company];
  const builder = reach.accountBuilder;
  if (held === null || kept === undefined || builder === undefined) return;
  const seat: SeatToEnter = {
    accountId: company, label, account, n: s.n, scope: s.scope, leaf: s.leaf,
    ...(s.rights === undefined ? {} : { rights: s.rights }), ...(kept.registry === undefined ? {} : { mark: kept.registry }),
  };
  if (!registryEntryOwed(seat, { pinned: held.account, page: account }, leaves)) return;
  ctx.registryEntryOwed?.(async (c) => {
    await registryWriteThrough(c, {
      accountId: company, network: reach.network, build: builder(), now: Date.now,
      ...(reach.chain().ownWallet === undefined ? {} : { ownWallet: reach.chain().ownWallet }),
      read: async (registry) => {
        const at = await reach.chain().callState(registry as AccountAddress);
        return at === null ? null : { registryState: at.accountState, parameters: at.parameters };
      },
    }, seat);
  });
}

/** The offer as this wallet opened it, from the service with the link's token or from the seat it kept, and the invitation's id and acceptance. */
interface Opened {
  readonly offer: SignerOffer & { readonly byAddress: NonNullable<SignerOffer['byAddress']> };
  readonly inbox: Hex;
  readonly inviter: unknown;
  readonly label: string;
  readonly account: string;
  readonly invitation: Hex;
  readonly acceptance: Hex;
}

/** The seat this wallet takes for the company: which of its seats it is, its keys, its opening and its leaf. */
interface Seat {
  readonly n: number;
  readonly signingSecret: Hex;
  readonly wrappingSecret: Hex;
  readonly blinding: Hex;
  readonly scope: Hex;
  /** The rights record `scope` commits to, from the invitation's role and vaults; absent for an admin on every vault. */
  readonly rights?: RightsRecord;
  readonly opening: SeatOpening;
  readonly leaf: Hex;
}

/** A kept seat's leaf, made again from what was kept. */
const leafOfKept = (p: PendingSeat, C: Parameters<typeof storedSignerLeaf>[1]): string =>
  storedSignerLeaf({ signingSecret: p.signingSecret, blinding: p.blinding, scope: p.scope }, C).toLowerCase();

/**
 * The leaf of the seat these saved keys hold on the company when the chain no longer seats it, or null: a seat the chain
 * still holds, or one saved with no scope whose leaf cannot be worked out, is still this wallet's seat there.
 */
const leafTheChainLeft = (held: SavedAccountKeys | undefined, onChain: ReadonlySet<string>, C: Parameters<typeof storedSignerLeaf>[1]): string | null => {
  if (held === undefined || typeof held.scope !== 'string') return null;
  const leaf = storedSignerLeaf({ signingSecret: held.signingSecret, blinding: held.blinding, scope: held.scope as Hex }, C).toLowerCase();
  return onChain.has(leaf) ? null : leaf;
};

/**
 * The company's directory as the service serves it, for a seat this wallet held there; refused, never read as empty,
 * when it cannot be read. Read through the invitee door, not a view: the reader is a wallet whose seat the chain no
 * longer holds, so it holds no seat that opens a view of the company. The chain is read first, and the served directory
 * decides only for a seat the chain has already removed (`left`), so it can only make this wallet set aside, and keep,
 * saved keys that sign for nothing on the chain, or refuse. The signature check on a served retirement
 * (`retiredInTheDirectory`) stops a careless service, not a dishonest one: what limits a served directory is the chain read.
 */
const directoryServed = async (ctx: StepContext, company: string): Promise<readonly unknown[]> => {
  try {
    return await ctx.invitations.filings(company);
  } catch (e) {
    if (e instanceof ActionStopped) throw e;
    return refuse('directory-not-read');
  }
};

/** The words for an invitation the service says is closed, by the reason it gives: none of them is cured by trying again. */
const CLOSED_INVITATION: Readonly<Record<string, string>> = { withdrawn: 'withdrawn', expired: 'expired', used: 'used' };

/** A seat number tried for this company: the secret it signs with and the leaf it makes at the invitation's rights and at all vaults. */
interface Tried { readonly signingSecret: Hex; readonly leaf: Hex; readonly leafAtAll: Hex }

/**
 * Which of the leaves and signing keys the numbers tried would make that an entry of the company's directory already
 * names, retired seats included, as the service answers for exactly those asked. An answer that is an error or a
 * refusal refuses the seat: a number is never picked without knowing.
 */
const namedByTheCompany = async (ctx: StepContext, o: Opened, tried: readonly Tried[]): Promise<ReadonlySet<string>> => {
  const leaves = [...new Set(tried.flatMap((d) => [d.leaf, d.leafAtAll]))];
  const keys = tried.map((d) => signingPublicKeyOf(d.signingSecret).toLowerCase());
  let answer: Answered;
  try {
    answer = await ctx.invitations.seatsNamed(o.invitation, { acceptance: o.acceptance, leaves, keys });
  } catch {
    return refuse('no-slots');
  }
  const body = answer.body as { leaves?: unknown; keys?: unknown; refused?: unknown } | null;
  const closed = answer.status === 410 ? CLOSED_INVITATION[String(body?.refused)] : undefined;
  if (closed !== undefined) return refuse(closed);
  if (answer.status !== 200 || !Array.isArray(body?.leaves) || !Array.isArray(body?.keys)) return refuse('no-slots');
  return new Set([...body.leaves, ...body.keys].map((x) => String(x).toLowerCase()));
};

/**
 * The action. Each step works out what is done from the network, the invitation and the saved keys, never from a
 * count: a seat the account's history shows this invitation took is not taken again, a seat kept for this invitation
 * is the one taken, and an admission already kept is not asked for again. What one run opens and chooses is that
 * run's alone: `steps` makes it afresh for the intent it is given.
 */
export function seatInvitedAction(reach: SeatInvitedReach): ActionDefinition {
  /*
   * The first seat number whose pay-key slot is empty, that no other kept seat holds, and whose leaf (at the invitation's
   * rights or at all vaults) and signing key no entry of the company's directory names, retired seats included.
   */
  const freeSeatOf = async <T extends Tried>(ctx: StepContext, o: Opened, mine: readonly T[], keptByAnother: ReadonlySet<string>): Promise<T | undefined> => {
    const account = readAccountAddress(ctx.intent.fields['account'])!;
    const label = readCompanyLabel(ctx.intent.fields['company'])!;
    const chain = reach.chain();
    if (chain.roles === undefined) return refuse('no-slots');
    const slotKeyOf = await reach.payKeyWrapKeyOf();
    const accountBytes = fromHex(String(account).toLowerCase() as Hex);
    const slots = mine.map((d) => toHex(slotKeyOf(accountBytes, fromHex(d.signingSecret), 0n)).toLowerCase());
    const read = await chain.roles(account, label, slots);
    if (!Array.isArray(read)) throw new StepRefused(read as Words);
    const filled = new Set((read as ReadonlyArray<{ key: string; value: string | null }>).filter((r) => r.value !== null).map((r) => r.key.toLowerCase()));
    const named = await namedByTheCompany(ctx, o, mine);
    return mine.find((d, n) => !filled.has(slots[n]!) && !keptByAnother.has(signingPublicKeyOf(d.signingSecret).toLowerCase())
      && !named.has(d.leaf) && !named.has(d.leafAtAll) && !named.has(signingPublicKeyOf(d.signingSecret).toLowerCase()));
  };

  const stepsFor = (): readonly ActionStep[] => {
    let opened: Opened | null = null;
    let seat: Seat | null = null;
    /* Whether the seat the saved keys hold on the company is one the chain removed, to be set aside before the new one is kept. */
    let setAside = false;

    /* The offer, from the service with the link's token. Once the service has closed it (accepted or expired), or
     * cannot be read, from the seat this wallet kept for the same invitation (its id is the link's) on this company. */
    const open = async (ctx: StepContext): Promise<Opened> => {
      if (opened !== null) return opened;
      const f = ctx.intent.fields;
      const label = readCompanyLabel(f['company']);
      const account = readAccountAddress(f['account']);
      const token = f['token'] as Hex | undefined;
      if (label === null || account === null || token === undefined || !/^[0-9a-f]{64}$/u.test(token)) return refuse('not-a-company');
      /* A label this wallet pinned to another account is refused before anything is read or derived for this one. */
      const pin = pinnedFor(ctx, label);
      if (pin.of === 'pinned' && pin.account !== String(account).toLowerCase()) return refuse('pinned-elsewhere');
      const invitation = invitationIdOf(token);
      const acceptance = acceptanceProofOf(token) as Hex;
      const fromKept = (): Opened | null => {
        const held = ctx.keyring?.open().read();
        const p = Object.values(held?.pendingSeats ?? {}).find((x) => x.accountId === f['record'] && x.joining?.invitation === invitation);
        const j = p?.joining;
        if (j === undefined || j.label !== label || j.account.toLowerCase() !== String(account).toLowerCase()) return null;
        opened = { offer: j.offer as Opened['offer'], inbox: j.inbox, inviter: p!.invitedBy, label: j.label, account: j.account, invitation, acceptance };
        return opened;
      };
      const got = await ctx.invitations.offer(invitation);
      const sealed = (got.body as { offer?: Sealed } | null)?.offer;
      // A company that took the invitation back is believed even when a seat for it is kept (and then the words say that seat may be taken); any other closed or unreadable answer resumes from the kept offer.
      if (got.status === 410 && (got.body as { refused?: unknown } | null)?.refused === 'withdrawn') return refuse(fromKept() === null ? 'withdrawn' : 'withdrawn-kept');
      if (got.status !== 200 || sealed === undefined) return fromKept() ?? refuse('no-offer');
      let signed: ReturnType<typeof openOffer>;
      try { signed = openOffer(sealed, token); } catch { return fromKept() ?? refuse('no-offer'); }
      const o = signed.offer;
      if (offerExpiredRefusal(o, Date.now()) !== null) return fromKept() ?? refuse('expired');
      if (o.company !== f['record'] || o.label !== label || String(o.account).toLowerCase() !== String(account).toLowerCase()) return refuse('another-company');
      const offer = o.for as SignerOffer;
      if (offer.kind !== 'signer' || offer.byAddress === undefined || offer.invited.terms.invite === undefined || offer.invited.terms.proposal === undefined) {
        return refuse('not-by-address');
      }
      opened = { offer: offer as Opened['offer'], inbox: o.inboxPublicKey as Hex, inviter: o.inviter, label, account: String(account), invitation, acceptance };
      return opened;
    };

    /* The seat this invitation takes. Once the chain shows the invitation's seat, it is that one of this wallet's own
     * seats, whatever its wrap slot holds. Before, it is the seat kept for this invitation when one is kept, so a step
     * taken up again proves the seat it kept; otherwise, refusing a wallet that already holds a seat on this company, the
     * first of this wallet's own seats whose leaf the account does not hold and whose pay-key wrap slot is empty. */
    const seatOf = async (ctx: StepContext, o: Opened): Promise<Seat> => {
      if (seat !== null) return seat;
      const label = readCompanyLabel(ctx.intent.fields['company'])!;
      const account = readAccountAddress(ctx.intent.fields['account'])!;
      const company = ctx.intent.fields['record']!;
      const C = await reach.commitments();
      /* The compiled account's leaf scheme, as the reach hands it, read through one name for every leaf worked out below. */
      const scheme: Parameters<typeof storedSignerLeaf>[1] = C as never;
      const walletKey = { tag: 'schnorr' as const, value: String(committeeKeyFor(ctx.held.identity, label).value).toLowerCase() };
      const scope = o.offer.invited.terms.invite!.scope.toLowerCase() as Hex;
      const rights = rightsRecordFor(o.offer.invited.terms, scope);
      const proposal = o.offer.invited.terms.proposal!.toLowerCase();
      const holders = await reach.chain().holders(account, label);
      if (!('seats' in holders)) throw new StepRefused(holders);
      const onChain = new Set(holders.seats.map((x) => x.toLowerCase()));
      const held: Keyring = ctx.keyring?.open().read() ?? { accounts: {} };
      const left = leafTheChainLeft(held.accounts[company], onChain, scheme);
      setAside = left !== null && retiredInTheDirectory(company, await directoryServed(ctx, company), left);
      if (left !== null && !setAside) return refuse('removal-not-filed');
      const took = (await reach.builder().invitedSeats({ account, indexer: reach.chain().indexer, proposals: [proposal] }))[proposal] ?? null;
      const keptHere = Object.values(held.pendingSeats ?? {}).filter((p) => p.accountId === company);
      const keptForThis = keptHere.find((p) => String(p.invited?.terms.proposal ?? '').toLowerCase() === proposal) ?? null;

      const derive = (n: number) => {
        const s = seatAt(ctx.held.identity, label, n, scope, scheme);
        return {
          n, signingSecret: s.signingSecret, wrappingSecret: s.wrappingSecret, blinding: s.blinding, scope, leaf: s.leaf, ...(rights === null ? {} : { rights }),
          leafAtAll: s.leafAtAll,
          opening: { publicKey: s.publicKey as string, scope, blinding: s.blinding, walletKey, salt: s.salt },
        };
      };
      const asSeat = (d: ReturnType<typeof derive>): Seat => {
        const { leafAtAll: _all, ...s } = d;
        return s;
      };
      const fromKept = (p: PendingSeat): Seat | null => {
        if (typeof p.seat !== 'number' || p.opening === undefined) return null;
        return {
          n: p.seat, signingSecret: p.signingSecret, wrappingSecret: p.wrappingSecret, blinding: p.blinding, scope: p.scope, ...(p.rights === undefined ? {} : { rights: p.rights }),
          opening: p.opening, leaf: leafOfKept(p, scheme) as Hex,
        };
      };

      if (took !== null) {
        const t = took.toLowerCase();
        for (let n = 0; n < MOST_SEATS; n += 1) {
          const d = derive(n);
          if (d.leaf === t) { seat = asSeat(d); return seat; }
        }
        return refuse('taken-by-another');
      }

      if (keptForThis !== null) {
        const kept = fromKept(keptForThis);
        if (kept !== null && kept.scope === scope) { seat = kept; return seat; }
      }
      if (held.accounts[company] !== undefined && !setAside) return refuse('already-seated');
      if (keptHere.some((p) => p !== keptForThis && onChain.has(leafOfKept(p, scheme)))) return refuse('already-seated');
      const founder = holders.foundingCommittee.some((k) => k.tag === walletKey.tag && String(k.value).toLowerCase() === walletKey.value);
      if (founder && onChain.has(String(holders.founding).toLowerCase())) return refuse('already-seated');
      const mine = Array.from({ length: MOST_SEATS }, (_, n) => derive(n));
      if (mine.some((d) => onChain.has(d.leaf) || onChain.has(d.leafAtAll))) return refuse('already-seated');
      /* A seat number another invitation's kept seat holds is not chosen: its keys are the same, and a kept seat is never written over. */
      const keptByAnother = new Set(Object.values(held.pendingSeats ?? {}).filter((p) => p !== keptForThis).map((p) => p.signingPublicKey.toLowerCase()));

      const free = await freeSeatOf(ctx, o, mine, keptByAnother);
      if (free === undefined) return refuse('no-free-seat');
      seat = asSeat(free);
      return seat;
    };

    /*
     * The question the seating asks before it keeps a new seat: the company's fingerprint, read from the label and the
     * account the invitation names, which the person compares with the one their inviter gave them themselves.
     */
    const fingerprintAsked = (label: CompanyLabel, account: AccountAddress): readonly Words[] => [
      { key: 'act.seat-invited.confirm.fingerprint', values: { fingerprint: companyFingerprint(label, account) } },
      { key: 'act.seat-invited.confirm.differs' },
    ];

    /* The seat as kept before its leaf is published: under its signing public key, with what the admission needs. */
    const pendingOf = (company: string, s: Seat, o: Opened): PendingSeat => ({
      accountId: company, signingPublicKey: signingPublicKeyOf(s.signingSecret).toLowerCase() as Hex,
      signingSecret: s.signingSecret, wrappingSecret: s.wrappingSecret, blinding: s.blinding, scope: s.scope, ...(s.rights === undefined ? {} : { rights: s.rights }),
      invitedBy: o.inviter as never, opening: s.opening, invited: o.offer.invited, seat: s.n,
      joining: { invitation: o.invitation, acceptance: o.acceptance, inbox: o.inbox, label: o.label, account: o.account, offer: o.offer },
    });

    return [
        {
          title: { key: 'act.seat-invited.step.seat' },
          run: async (ctx) => {
            /* The request to be admitted names the sign-in, so with none named no seat is taken that could never be admitted. */
            if (ctx.person === null || ctx.person === '') return refuse('no-sign-in');
            const o = await open(ctx);
            const at = heldAt(ctx.held.identity, reach.network, o.offer.byAddress.address);
            if (at === null || at.kind !== 'shielded') return refuse('not-held');
            if (ctx.keyring === null) return refuse('no-keys-to-keep');
            const s = await seatOf(ctx, o);
            const account = readAccountAddress(ctx.intent.fields['account'])!;
            const company = ctx.intent.fields['record']!;
            const proposal = o.offer.invited.terms.proposal!.toLowerCase();
            /* Kept before anything is proved or relayed: the saved keys hold the seat whatever happens after. A seat
             * kept new is kept only once the person confirmed the company's fingerprint, and kept as confirmed. */
            const pending = pendingOf(company, s, o);
            const before = ctx.keyring.open().read();
            /* A seat kept under the same key, confirmed for another account under this label, is asked about again. */
            const keptAs = before.pendingSeats?.[pending.signingPublicKey];
            const keepsNew = (setAside || before.accounts[company] === undefined)
              && (keptAs === undefined || String(keptAs.joining?.account ?? '').toLowerCase() !== String(account).toLowerCase());
            if (keepsNew) await ctx.confirm(fingerprintAsked(readCompanyLabel(ctx.intent.fields['company'])!, account));
            if (setAside) await ctx.keyring.keep((k) => withSeatSetAside(k, company));
            const keptNow = ctx.keyring.open().read();
            if (keptNow.accounts[company] === undefined && keptNow.pendingSeats?.[pending.signingPublicKey] === undefined) {
              await ctx.keyring.keep((k) => withPendingSeat(k, { ...pending, joining: { ...pending.joining!, confirmed: true } }));
            }
            const took = (await reach.builder().invitedSeats({ account, indexer: reach.chain().indexer, proposals: [proposal] }))[proposal] ?? null;
            if (took !== null) {
              if (took.toLowerCase() !== s.leaf) refuse('taken-by-another');
              return;
            }
            /*
             * The threshold the signed invitation sets once the seat is taken, which the proposal binds: refused here,
             * before anything is proved, when it is above the seats the chain holds now and this one, as the chain
             * would refuse it. This wallet holds no list of the company's signers, so it counts seats, never vaults.
             */
            const threshold = thresholdTheInvitationSets(o.offer.invited.terms.invite);
            if (threshold !== '0') {
              const holders = await reach.chain().holders(account, readCompanyLabel(ctx.intent.fields['company'])!);
              if (!('seats' in holders)) throw new StepRefused(holders);
              const seated = holders.seats.length + 1;
              if (BigInt(threshold) > BigInt(seated)) refuse('threshold-above-the-seats', { threshold, seats: seated });
            }
            const state = await reach.chain().callState(account);
            if (state === null) refuse('not-on-chain');
            const keys = ZswapSecretKeys.fromSeed(ctx.held.identity.moneyAt(at.account).zswap);
            const raw = keys.coinSecretKey.yesIKnowTheSecurityImplicationsOfThis_serialize();
            const coinSecretKey = toHex(raw.slice(raw.length - 32)) as Hex;
            watchFor(coinSecretKey);
            raw.fill(0);
            try { keys.clear(); } catch { /* the keys are dropped either way */ }
            let tx: string;
            try {
              tx = await reach.builder().seatInvited({
                account, proposal, intoVacatedSlot: false, newThreshold: threshold, proposalSalt: o.offer.byAddress.proposalSalt,
                material: signerMaterialOf(s),
                invite: { coinSecretKey, addressSalt: o.offer.invited.terms.invite!.salt },
                chain: { accountState: state!.accountState, parameters: state!.parameters },
              });
            } catch (e) {
              return refuse('not-built', { says: String((e as Error)?.message ?? e) });
            }
            const viaService = async (): Promise<void> => {
              const sent = await ctx.invitations.seat(o.invitation, { acceptance: o.acceptance, tx });
              if (sent.status !== 200) {
                const said = (sent.body as { error?: unknown } | null)?.error;
                refuse('not-sent', { says: typeof said === 'string' ? said : `the service answered ${sent.status}` });
              }
            };
            const handed = { over: false };
            ctx.movesWhoHolds([ctx.invitations.seatCall(o.invitation), { circuit: 'seatInvited', contract: String(account) }], seated(s.leaf, Number(threshold)));
            const over = handOverMarked(handOverFor(ctx, reach.chain()), handed);
            try {
              await handedOver(over, {
                tx, call: { kind: 'account-call', contract: account, circuit: 'seatInvited' }, viaService, after: async () => undefined,
              });
            } catch (e) {
              /*
               * Once this wallet handed the seat to the chain itself, on any path, the seat may be taken, and the step
               * says so. Otherwise, on the chain path, the person's own wallet's refusal, in this step's words.
               */
              if (e instanceof StepRefused) throw e;
              if (handed.over) refuse('may-be-sent', { says: String((e as Error)?.message ?? e) });
              if (over.path === 'service') throw e;
              refuse('not-sent', { says: String((e as Error)?.message ?? e) });
            }
          },
        },
        {
          title: { key: 'act.seat-invited.step.admission' },
          run: async (ctx) => {
            const o = await open(ctx);
            const company = ctx.intent.fields['record']!;
            if (ctx.keyring === null) return refuse('no-saved-keys');
            const s = await seatOf(ctx, o);
            if (ctx.keyring.open().read().accounts[company] !== undefined) return await pinnedAndOwedHere(reach, ctx, company, s);
            const signingPublicKey = signingPublicKeyOf(s.signingSecret).toLowerCase() as Hex;
            const wrappingPublicKey = toHex(x25519.getPublicKey(Uint8Array.from(s.wrappingSecret.match(/../gu)!.map((x) => Number.parseInt(x, 16))))) as Hex;
            const published = { signingPublicKey, wrappingPublicKey, leafCommitment: s.leaf };
            /* The proof names the sign-in the request is for, so with none named no request is made that every device would refuse. */
            const person = ctx.person;
            if (person === null || person === '') return refuse('no-sign-in-after');
            const waiting: PendingSignerPayload = {
              name: o.offer.name, role: o.offer.role, ...published, opening: s.opening, person, invited: o.offer.invited,
              seatProof: proveSeatKeys({ accountId: company, nonce: o.offer.seat.nonce, secret: o.offer.seat.secret }, published,
                { person, invitationId: o.invitation }),
            };
            /* Asked again after an answer that never came back, the service gives back the id it gave the first time. */
            const asked = await ctx.invitations.acceptSigner(o.invitation,
              { acceptance: o.acceptance, waiting: sealToInbox(waiting, o.inbox), leaf: s.leaf });
            const id = (asked.body as { id?: unknown } | null)?.id;
            if (asked.status !== 201 || typeof id !== 'string') {
              /* Already asked (the invitation reads used: the request was filed, and may already be admitted) or the
               * service failed after it may have filed it: the seat is on the network and kept, so this ends waiting for
               * the company to admit it. The next act on the company keeps it under the id the roster gives it, and a
               * step taken up again asks again. */
              const refused = (asked.body as { refused?: unknown } | null)?.refused;
              if ((asked.status === 410 && refused === 'used') || asked.status >= 500) return await pinnedAndOwedHere(reach, ctx, company, s);
              const said = (asked.body as { error?: unknown } | null)?.error;
              refuse('not-asked', { says: typeof said === 'string' ? said : `the service answered ${asked.status}` });
            }
            await ctx.keyring.keep((k) => withNewSeat(k, company, {
              signerId: id as string, signingSecret: s.signingSecret, wrappingSecret: s.wrappingSecret, blinding: s.blinding, scope: s.scope,
              ...(s.rights === undefined ? {} : { rights: s.rights }),
              opening: s.opening, invited: o.offer.invited, invitedBy: o.inviter as never, seat: s.n,
            }));
            await pinnedAndOwedHere(reach, ctx, company, s);
          },
        },
      ];
  };

  return Object.freeze({
    headline: 'act.seat-invited.headline',
    shown: async (intent) => [
      { key: 'act.seat-invited.shown.company', values: { label: String(intent.fields['company'] ?? '') }, from: 'page' as const },
      { key: 'act.seat-invited.shown.address', from: 'action' as const },
      { key: 'act.seat-invited.shown.nothing-else', from: 'action' as const },
    ],
    checks: [
      { key: 'act.seat-invited.check.offer' },
      { key: 'act.seat-invited.check.address' },
      { key: 'act.seat-invited.check.chain' },
    ],
    check: async (intent) => (readCompanyLabel(intent.fields['company']) === null || readAccountAddress(intent.fields['account']) === null
      ? why('not-a-company') : null),
    steps: () => stepsFor(),
  } satisfies ActionDefinition);
}
