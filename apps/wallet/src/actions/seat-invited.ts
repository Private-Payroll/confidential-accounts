/* A SIGNER INVITED BY ADDRESS TAKES THE SEAT FROM THEIR OWN WALLET. The page names the company and hands the
 * invitation link's token, nothing else: this wallet opens the offer with it, checks the offer is for this company
 * and offers a seat by an address this wallet holds, and refuses when this wallet already holds a seat on the company.
 * It derives its own seat for the company (the first whose leaf the company's account does not hold and whose pay-key
 * wrap slot no seat has filled), keeps it in the saved keys, proves `seatInvited` with the address's coin key as the
 * proof's witness, and hands the transaction to the invitation's relay. The account refuses it unless the
 * invitation's proposal names this address and these rights and is approved at the seat bar. It then asks to be
 * admitted with its seat's public halves sealed to the company's inbox key, and keeps the seat again under the id the
 * company gave the request. When the service has already taken the request or fails, it ends waiting for admission:
 * the seat is kept with what asking again needs, and the next act on the company keeps it under the id the company's
 * roster gives it. The coin key and the seat's secrets never leave this wallet. */
import { x25519 } from '@noble/curves/ed25519.js';
import { ZswapSecretKeys } from '@midnightntwrk/ledger-v9';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import { seatKeysFor } from 'midnight-identity/profile/seat-keys';
import { withNewSeat, withPendingSeat, type Keyring, type PendingSeat } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { acceptanceProofOf, invitationIdOf, offerExpiredRefusal, openOffer, type SignerOffer } from '../../../../src/core/invitation.js';
import { fromHex, signingPublicKeyOf, toHex, type Hex, type Sealed } from '../../../../src/core/crypto.js';
import { sealToInbox } from '../../../../src/core/sealed-records.js';
import { proveSeatKeys } from '../../../../src/core/seat-invite-proof.js';
import { seatBlinding, type SeatOpening } from '../../../../src/core/seat-opening.js';
import { storedSignerLeaf } from '../../../../src/core/signer-leaf.js';
import type { PendingSignerPayload } from '../../../../src/core/types.js';
import { watchFor } from '../keyring/nothing-secret-crosses.js';
import { heldAt } from './claim-by-address.js';
import type { CompanyChain } from './company-reach.js';
import { StepRefused, type ActionDefinition, type ActionStep, type StepContext, type Words } from './definition.js';

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
}

/** The offer as this wallet opened it, from the service with the link's token or from the seat it kept, and the invitation's id and acceptance. */
interface Opened {
  readonly offer: SignerOffer & { readonly byAddress: NonNullable<SignerOffer['byAddress']> };
  readonly inbox: Hex;
  readonly inviter: unknown;
  readonly label: string;
  readonly account: string;
  readonly invitation: string;
  readonly acceptance: Hex;
}

/** The seat this wallet takes for the company: which of its seats it is, its keys, its opening and its leaf. */
interface Seat {
  readonly n: number;
  readonly signingSecret: Hex;
  readonly wrappingSecret: Hex;
  readonly blinding: Hex;
  readonly scope: Hex;
  readonly opening: SeatOpening;
  readonly leaf: Hex;
}

/** A kept seat's leaf, made again from what was kept. */
const leafOfKept = (p: PendingSeat, C: Parameters<typeof storedSignerLeaf>[1]): string =>
  storedSignerLeaf({ signingSecret: p.signingSecret, blinding: p.blinding, scope: p.scope }, C).toLowerCase();

/**
 * The action. Each step works out what is done from the network, the invitation and the saved keys, never from a
 * count: a seat the account's history shows this invitation took is not taken again, a seat kept for this invitation
 * is the one taken, and an admission already kept is not asked for again. What one run opens and chooses is that
 * run's alone: `steps` makes it afresh for the intent it is given.
 */
export function seatInvitedAction(reach: SeatInvitedReach): ActionDefinition {
  const stepsFor = (): readonly ActionStep[] => {
    let opened: Opened | null = null;
    let seat: Seat | null = null;

    /* The offer, from the service with the link's token. Once the service has closed it (accepted or expired), or
     * cannot be read, from the seat this wallet kept for the same invitation (its id is the link's) on this company. */
    const open = async (ctx: StepContext): Promise<Opened> => {
      if (opened !== null) return opened;
      const f = ctx.intent.fields;
      const label = readCompanyLabel(f['company']);
      const account = readAccountAddress(f['account']);
      const token = f['token'] as Hex | undefined;
      if (label === null || account === null || token === undefined || !/^[0-9a-f]{64}$/u.test(token)) return refuse('not-a-company');
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
      const got = await ctx.call('GET', `/api/invites/${invitation}/offer`);
      const sealed = (got.body as { offer?: Sealed } | null)?.offer;
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
      const walletKey = { tag: 'schnorr' as const, value: String(committeeKeyFor(ctx.held.identity, label).value).toLowerCase() };
      const scope = o.offer.invited.terms.invite!.scope.toLowerCase() as Hex;
      const all = String(C.allVaults()).toLowerCase() as Hex;
      const proposal = o.offer.invited.terms.proposal!.toLowerCase();
      const holders = await reach.chain().holders(account, label);
      if (!('seats' in holders)) throw new StepRefused(holders);
      const onChain = new Set(holders.seats.map((x) => x.toLowerCase()));
      const took = (await reach.builder().invitedSeats({ account, indexer: reach.chain().indexer, proposals: [proposal] }))[proposal] ?? null;
      const held: Keyring = ctx.keyring?.open().read() ?? { accounts: {} };
      const keptHere = Object.values(held.pendingSeats ?? {}).filter((p) => p.accountId === company);
      const keptForThis = keptHere.find((p) => String(p.invited?.terms.proposal ?? '').toLowerCase() === proposal) ?? null;

      const derive = (n: number) => {
        const keys = seatKeysFor(ctx.held.identity, label, n);
        const signingSecret = toHex(keys.signingSecret).toLowerCase() as Hex;
        const salt = toHex(keys.salt).toLowerCase() as Hex;
        const blinding = String(seatBlinding(walletKey, salt)).toLowerCase() as Hex;
        const leafAt = (s: Hex) => storedSignerLeaf({ signingSecret, blinding, scope: s }, C as never).toLowerCase() as Hex;
        const leaf = leafAt(scope);
        return {
          n, signingSecret, wrappingSecret: toHex(keys.wrappingSecret).toLowerCase() as Hex, blinding, scope, leaf,
          leafAtAll: scope === all ? leaf : leafAt(all),
          opening: { publicKey: String(C.signerPublicKey(signingSecret)).toLowerCase(), scope, blinding, walletKey, salt },
        };
      };
      const asSeat = (d: ReturnType<typeof derive>): Seat => {
        const { leafAtAll: _all, ...s } = d;
        return s;
      };
      const fromKept = (p: PendingSeat): Seat | null => {
        if (typeof p.seat !== 'number' || p.opening === undefined) return null;
        return {
          n: p.seat, signingSecret: p.signingSecret, wrappingSecret: p.wrappingSecret, blinding: p.blinding, scope: p.scope,
          opening: p.opening, leaf: leafOfKept(p, C as never) as Hex,
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
      if (held.accounts[company] !== undefined) return refuse('already-seated');
      if (keptHere.some((p) => p !== keptForThis && onChain.has(leafOfKept(p, C as never)))) return refuse('already-seated');
      const founder = holders.foundingCommittee.some((k) => k.tag === walletKey.tag && String(k.value).toLowerCase() === walletKey.value);
      if (founder && onChain.has(String(holders.founding).toLowerCase())) return refuse('already-seated');
      const mine = Array.from({ length: MOST_SEATS }, (_, n) => derive(n));
      if (mine.some((d) => onChain.has(d.leaf) || onChain.has(d.leafAtAll))) return refuse('already-seated');
      /* A seat number another invitation's kept seat holds is not chosen: its keys are the same, and a kept seat is never written over. */
      const keptByAnother = new Set(Object.values(held.pendingSeats ?? {}).filter((p) => p !== keptForThis).map((p) => p.signingPublicKey.toLowerCase()));

      const chain = reach.chain();
      if (chain.roles === undefined) return refuse('no-slots');
      const slotKeyOf = await reach.payKeyWrapKeyOf();
      const accountBytes = fromHex(String(account).toLowerCase() as Hex);
      const slots = mine.map((d) => toHex(slotKeyOf(accountBytes, fromHex(d.signingSecret), 0n)).toLowerCase());
      const read = await chain.roles(account, label, slots);
      if (!Array.isArray(read)) throw new StepRefused(read as Words);
      const filled = new Set((read as ReadonlyArray<{ key: string; value: string | null }>).filter((r) => r.value !== null).map((r) => r.key.toLowerCase()));
      const free = mine.find((d, n) => !filled.has(slots[n]!) && !keptByAnother.has(signingPublicKeyOf(d.signingSecret).toLowerCase()));
      if (free === undefined) return refuse('no-free-seat');
      seat = asSeat(free);
      return seat;
    };

    /* The seat as kept before its leaf is published: under its signing public key, with what the admission needs. */
    const pendingOf = (company: string, s: Seat, o: Opened): PendingSeat => ({
      accountId: company, signingPublicKey: signingPublicKeyOf(s.signingSecret).toLowerCase() as Hex,
      signingSecret: s.signingSecret, wrappingSecret: s.wrappingSecret, blinding: s.blinding, scope: s.scope,
      invitedBy: o.inviter as never, opening: s.opening, invited: o.offer.invited, seat: s.n,
      joining: { invitation: o.invitation, acceptance: o.acceptance, inbox: o.inbox, label: o.label, account: o.account, offer: o.offer },
    });

    return [
        {
          title: { key: 'act.seat-invited.step.seat' },
          run: async (ctx) => {
            const o = await open(ctx);
            const at = heldAt(ctx.held.identity, reach.network, o.offer.byAddress.address);
            if (at === null || at.kind !== 'shielded') refuse('not-held');
            if (ctx.keyring === null) refuse('no-keys-to-keep');
            const s = await seatOf(ctx, o);
            const account = readAccountAddress(ctx.intent.fields['account'])!;
            const company = ctx.intent.fields['record']!;
            const proposal = o.offer.invited.terms.proposal!.toLowerCase();
            /* Kept before anything is proved or relayed: the saved keys hold the seat whatever happens after. */
            const keptNow = ctx.keyring!.open().read();
            const pending = pendingOf(company, s, o);
            if (keptNow.accounts[company] === undefined && keptNow.pendingSeats?.[pending.signingPublicKey] === undefined) {
              await ctx.keyring!.keep((k) => withPendingSeat(k, pending));
            }
            const took = (await reach.builder().invitedSeats({ account, indexer: reach.chain().indexer, proposals: [proposal] }))[proposal] ?? null;
            if (took !== null) {
              if (took.toLowerCase() !== s.leaf) refuse('taken-by-another');
              return;
            }
            const state = await reach.chain().callState(account);
            if (state === null) refuse('not-on-chain');
            const keys = ZswapSecretKeys.fromSeed(ctx.held.identity.moneyAt(at!.account).zswap);
            const raw = keys.coinSecretKey.yesIKnowTheSecurityImplicationsOfThis_serialize();
            const coinSecretKey = toHex(raw.slice(raw.length - 32)) as Hex;
            watchFor(coinSecretKey);
            raw.fill(0);
            try { keys.clear(); } catch { /* the keys are dropped either way */ }
            let tx: string;
            try {
              tx = await reach.builder().seatInvited({
                account, proposal, intoVacatedSlot: false, proposalSalt: o.offer.byAddress.proposalSalt,
                material: { signingSecret: s.signingSecret, blinding: s.blinding, scope: s.scope },
                invite: { coinSecretKey, addressSalt: o.offer.invited.terms.invite!.salt },
                chain: { accountState: state!.accountState, parameters: state!.parameters },
              });
            } catch (e) {
              return refuse('not-built', { says: String((e as Error)?.message ?? e) });
            }
            const sent = await ctx.call('POST', `/api/invites/${o.invitation}/seat`,
              JSON.stringify({ acceptance: o.acceptance, tx }));
            if (sent.status !== 200) {
              const said = (sent.body as { error?: unknown } | null)?.error;
              refuse('not-sent', { says: typeof said === 'string' ? said : `the service answered ${sent.status}` });
            }
          },
        },
        {
          title: { key: 'act.seat-invited.step.admission' },
          run: async (ctx) => {
            const o = await open(ctx);
            const company = ctx.intent.fields['record']!;
            if (ctx.keyring === null) refuse('no-saved-keys');
            if (ctx.keyring!.open().read().accounts[company] !== undefined) return;
            const s = await seatOf(ctx, o);
            const signingPublicKey = signingPublicKeyOf(s.signingSecret).toLowerCase() as Hex;
            const wrappingPublicKey = toHex(x25519.getPublicKey(Uint8Array.from(s.wrappingSecret.match(/../gu)!.map((x) => Number.parseInt(x, 16))))) as Hex;
            const published = { signingPublicKey, wrappingPublicKey, leafCommitment: s.leaf };
            const waiting: PendingSignerPayload = {
              name: o.offer.name, role: o.offer.role, ...published, opening: s.opening, person: ctx.person ?? undefined, invited: o.offer.invited,
              seatProof: proveSeatKeys({ accountId: company, nonce: o.offer.seat.nonce, secret: o.offer.seat.secret }, published),
            } as PendingSignerPayload;
            /* Asked again after an answer that never came back, the service gives back the id it gave the first time. */
            const asked = await ctx.call('POST', `/api/invites/${o.invitation}/accept-signer`,
              JSON.stringify({ acceptance: o.acceptance, waiting: sealToInbox(waiting, o.inbox) }));
            const id = (asked.body as { id?: unknown } | null)?.id;
            if (asked.status !== 201 || typeof id !== 'string') {
              /* Already asked (the invitation reads used: the request was filed, and may already be admitted) or the
               * service failed after it may have filed it: the seat is on the network and kept, so this ends waiting for
               * the company to admit it. The next act on the company keeps it under the id the roster gives it, and a
               * step taken up again asks again. */
              const refused = (asked.body as { refused?: unknown } | null)?.refused;
              if ((asked.status === 410 && refused === 'used') || asked.status >= 500) return;
              const said = (asked.body as { error?: unknown } | null)?.error;
              refuse('not-asked', { says: typeof said === 'string' ? said : `the service answered ${asked.status}` });
            }
            await ctx.keyring!.keep((k) => withNewSeat(k, company, {
              signerId: id as string, signingSecret: s.signingSecret, wrappingSecret: s.wrappingSecret, blinding: s.blinding, scope: s.scope,
              opening: s.opening, invited: o.offer.invited, invitedBy: o.inviter as never, seat: s.n,
            }));
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
