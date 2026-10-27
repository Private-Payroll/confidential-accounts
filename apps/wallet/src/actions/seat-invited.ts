/* A SIGNER INVITED BY ADDRESS TAKES THE SEAT FROM THEIR OWN WALLET. The page names the company and hands the
 * invitation link's token, nothing else: this wallet opens the offer with it, checks the offer is for this company
 * and offers a seat by an address this wallet holds, derives its own seat for the company (the first whose leaf the
 * company's account does not hold), proves `seatInvited` with the address's coin key as the proof's witness, and
 * hands the transaction to the invitation's relay. The account refuses it unless the invitation's proposal names
 * this address and these rights and is approved at the seat bar. It then asks to be admitted with its seat's public
 * halves sealed to the company's inbox key, and keeps the seat in the saved keys. The coin key and the seat's secrets
 * never leave this wallet. */
import { x25519 } from '@noble/curves/ed25519.js';
import { ZswapSecretKeys } from '@midnightntwrk/ledger-v9';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import { seatKeysFor } from 'midnight-identity/profile/seat-keys';
import { withNewSeat } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { acceptanceProofOf, invitationIdOf, offerExpiredRefusal, openOffer, type SignerOffer } from '../../../../src/core/invitation.js';
import { signingPublicKeyOf, toHex, type Hex, type Sealed } from '../../../../src/core/crypto.js';
import { sealToInbox } from '../../../../src/core/sealed-records.js';
import { proveSeatKeys } from '../../../../src/core/seat-invite-proof.js';
import { seatBlinding, type SeatOpening } from '../../../../src/core/seat-opening.js';
import { storedSignerLeaf } from '../../../../src/core/signer-leaf.js';
import type { PendingSignerPayload } from '../../../../src/core/types.js';
import { heldAt } from './claim-by-address.js';
import type { CompanyChain } from './company-reach.js';
import { StepRefused, type ActionDefinition, type StepContext, type Words } from './definition.js';

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.seat-invited.why.${key}`, ...(values === undefined ? {} : { values }),
});
const refuse = (key: string, values?: Readonly<Record<string, string | number>>): never => { throw new StepRefused(why(key, values)); };

/** The most seats one wallet looks through for one company before it gives up finding a free one. */
const MOST_SEATS = 64;

/** What the action reaches beyond the wallet: the company's account as this wallet reads it, its builder, the network and the commitments. */
export interface SeatInvitedReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  readonly network: string;
  readonly commitments: () => Promise<{
    signerLeaf(publicKey: Hex, blinding: Hex, scope: Hex): Hex; signerPublicKey(secret: Hex): Hex; allVaults(): Hex;
  }>;
}

/** The offer as this wallet opened it with the link's token, and what it derived from it. */
interface Opened {
  readonly offer: SignerOffer & { readonly byAddress: NonNullable<SignerOffer['byAddress']> };
  readonly inbox: Hex;
  readonly inviter: unknown;
  readonly token: Hex;
}

/** The seat this wallet takes for the company: its keys, its opening and its leaf. */
interface Seat {
  readonly signingSecret: Hex;
  readonly wrappingSecret: Hex;
  readonly blinding: Hex;
  readonly scope: Hex;
  readonly opening: SeatOpening;
  readonly leaf: Hex;
}

/**
 * The action. Each step works out what is done from the network and the invitation, never from a count: a seat the
 * account's history shows this invitation took is not taken again, and an admission already asked for is not asked
 * again.
 */
export function seatInvitedAction(reach: SeatInvitedReach): ActionDefinition {
  let opened: Opened | null = null;
  let seat: Seat | null = null;

  const open = async (ctx: StepContext): Promise<Opened> => {
    if (opened !== null) return opened;
    const f = ctx.intent.fields;
    const label = readCompanyLabel(f['company']);
    const account = readAccountAddress(f['account']);
    const token = f['token'] as Hex | undefined;
    if (label === null || account === null || token === undefined || !/^[0-9a-f]{64}$/u.test(token)) return refuse('not-a-company');
    const got = await ctx.call('GET', `/api/invites/${invitationIdOf(token)}/offer`);
    const sealed = (got.body as { offer?: Sealed } | null)?.offer;
    if (got.status !== 200 || sealed === undefined) return refuse('no-offer');
    let signed: ReturnType<typeof openOffer>;
    try { signed = openOffer(sealed, token); } catch { return refuse('no-offer'); }
    const o = signed.offer;
    if (offerExpiredRefusal(o, Date.now()) !== null) return refuse('expired');
    if (o.company !== f['record'] || o.label !== label || String(o.account).toLowerCase() !== String(account).toLowerCase()) return refuse('another-company');
    const offer = o.for as SignerOffer;
    if (offer.kind !== 'signer' || offer.byAddress === undefined || offer.invited.terms.invite === undefined || offer.invited.terms.proposal === undefined) {
      return refuse('not-by-address');
    }
    opened = { offer: offer as Opened['offer'], inbox: o.inboxPublicKey as Hex, inviter: o.inviter, token };
    return opened;
  };

  const seatOf = async (ctx: StepContext, o: Opened): Promise<Seat> => {
    if (seat !== null) return seat;
    const label = readCompanyLabel(ctx.intent.fields['company'])!;
    const account = readAccountAddress(ctx.intent.fields['account'])!;
    const C = await reach.commitments();
    const walletKey = { tag: 'schnorr' as const, value: String(committeeKeyFor(ctx.held.identity, label).value).toLowerCase() };
    const scope = o.offer.invited.terms.invite!.scope.toLowerCase() as Hex;
    const proposal = o.offer.invited.terms.proposal!.toLowerCase();
    const holders = await reach.chain().holders(account, label);
    if (!('seats' in holders)) throw new StepRefused(holders);
    const onChain = new Set(holders.seats.map((x) => x.toLowerCase()));
    const took = (await reach.builder().invitedSeats({ account, indexer: reach.chain().indexer, proposals: [proposal] }))[proposal] ?? null;
    for (let n = 0; n < MOST_SEATS; n += 1) {
      const keys = seatKeysFor(ctx.held.identity, label, n);
      const signingSecret = toHex(keys.signingSecret).toLowerCase() as Hex;
      const salt = toHex(keys.salt).toLowerCase() as Hex;
      const blinding = String(seatBlinding(walletKey, salt)).toLowerCase() as Hex;
      const leaf = storedSignerLeaf({ signingSecret, blinding, scope }, C as never).toLowerCase() as Hex;
      /* The seat this invitation already took, when it did; otherwise the first this account does not hold. */
      if (took !== null ? leaf === took.toLowerCase() : !onChain.has(leaf)) {
        seat = {
          signingSecret, wrappingSecret: toHex(keys.wrappingSecret).toLowerCase() as Hex, blinding, scope, leaf,
          opening: { publicKey: String(C.signerPublicKey(signingSecret)).toLowerCase(), scope, blinding, walletKey, salt },
        };
        return seat;
      }
    }
    return refuse('no-free-seat');
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
    steps: () => [
      {
        title: { key: 'act.seat-invited.step.seat' },
        run: async (ctx) => {
          const o = await open(ctx);
          const at = heldAt(ctx.held.identity, reach.network, o.offer.byAddress.address);
          if (at === null || at.kind !== 'shielded') refuse('not-held');
          const s = await seatOf(ctx, o);
          const account = readAccountAddress(ctx.intent.fields['account'])!;
          const proposal = o.offer.invited.terms.proposal!.toLowerCase();
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
          const sent = await ctx.call('POST', `/api/invites/${invitationIdOf(o.token)}/seat`,
            JSON.stringify({ acceptance: acceptanceProofOf(o.token), tx }));
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
          const s = await seatOf(ctx, o);
          const company = ctx.intent.fields['record']!;
          if (ctx.keyring === null) refuse('no-saved-keys');
          if (ctx.keyring!.open().read().accounts[company] !== undefined) return;
          const signingPublicKey = signingPublicKeyOf(s.signingSecret).toLowerCase() as Hex;
          const wrappingPublicKey = toHex(x25519.getPublicKey(Uint8Array.from(s.wrappingSecret.match(/../gu)!.map((x) => Number.parseInt(x, 16))))) as Hex;
          const published = { signingPublicKey, wrappingPublicKey, leafCommitment: s.leaf };
          const waiting: PendingSignerPayload = {
            name: o.offer.name, role: o.offer.role, ...published, opening: s.opening, person: ctx.person ?? undefined, invited: o.offer.invited,
            seatProof: proveSeatKeys({ accountId: company, nonce: o.offer.seat.nonce, secret: o.offer.seat.secret }, published),
          } as PendingSignerPayload;
          const asked = await ctx.call('POST', `/api/invites/${invitationIdOf(o.token)}/accept-signer`,
            JSON.stringify({ acceptance: acceptanceProofOf(o.token), waiting: sealToInbox(waiting, o.inbox) }));
          const id = (asked.body as { id?: unknown } | null)?.id;
          if (asked.status !== 201 || typeof id !== 'string') {
            const said = (asked.body as { error?: unknown } | null)?.error;
            refuse('not-asked', { says: typeof said === 'string' ? said : `the service answered ${asked.status}` });
          }
          await ctx.keyring!.keep((k) => withNewSeat(k, company, {
            signerId: id as string, signingSecret: s.signingSecret, wrappingSecret: s.wrappingSecret, blinding: s.blinding, scope: s.scope,
            opening: s.opening, invited: o.offer.invited, invitedBy: o.inviter as never,
          }));
        },
      },
    ],
  } satisfies ActionDefinition);
}
