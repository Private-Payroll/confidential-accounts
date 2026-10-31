import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ZswapSecretKeys } from '@midnightntwrk/ledger-v9';
import { addressFor } from 'midnight-identity';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { signDirectoryEntry } from 'midnight-identity/profile/records-key';
import { seatKeysFor } from 'midnight-identity/profile/seat-keys';
import type { ActIntent } from 'midnight-identity/profile/request';
import { fromHex, signingPublicKeyOf, toHex, type Hex } from '../../../../src/core/crypto.js';
import {
  acceptanceProofOf, invitationIdOf, newInvitationToken, sealOffer, signOffer, signSeatInvitation, utcMomentOf, type InvitationOffer,
} from '../../../../src/core/invitation.js';
import { inboxPublicKey, openFromInbox } from '../../../../src/core/sealed-records.js';
import { MidnightCommitments } from '../../../../src/midnight/commitments.js';
import { seatBlinding } from '../../../../src/core/seat-opening.js';
import { storedSignerLeaf } from '../../../../src/core/signer-leaf.js';
import type { PendingSignerPayload } from '../../../../src/core/types.js';
import type { InvitedSeatOnTheWire } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { seatInvitedAction } from './seat-invited.js';
import { carriesASecret, forgetWatched } from '../keyring/nothing-secret-crosses.js';
import { pureCircuits } from '../../../../contracts/managed/contract/index.js';
import { StepRefused, type StepContext } from './definition.js';

/* A signer invited by address takes the seat from their own wallet: it opens the offer with the link's token, checks
 * the address is its own, proves the seat with its own seat and the address's coin key, and asks to be admitted. The
 * page hands nothing but the token. The builder and the chain are stood in: the proof itself is made against the
 * compiled account in apps/wallet/src/chain/a-signer-invited-by-address-is-seated-from-the-wallet.test.ts. */

const NET = 'undeployed' as const;
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const COMPANY = 'acc_1';
const KEY = '11'.repeat(32) as Hex;
const dee = identityFromSecret(newSecret());
const DEES_ADDRESS = addressFor(dee.moneyAt(0).zswap, NET).bech32;

/* The inviting seat: a wallet's signed entry for the company, its filing key and its opening. */
const inviterWallet = identityFromSecret(new Uint8Array(32).fill(9));
const INVITER_SECRET = toHex(new Uint8Array(randomBytes(32))) as Hex;
/* The same seat's entry signed for the company `label` and `account` name, so an offer made for another company still opens as signed. */
const inviterFor = (label: string, account: string) => ({
  committeeKey: committeeKeyFor(inviterWallet, label as never) as never,
  statement: signDirectoryEntry(inviterWallet, label as never, account as never, new Uint8Array(32).fill(3), signingPublicKeyOf(INVITER_SECRET), 'ab'.repeat(32)),
  opening: { publicKey: '01'.repeat(32), scope: '02'.repeat(32), blinding: '03'.repeat(32), salt: '04'.repeat(32), walletKey: { tag: 'schnorr', value: '05'.repeat(32) } },
});

/* `made` varies what the offer says about the company it is for, which the link the person pressed must agree with. */
const anOffer = (
  address = DEES_ADDRESS, scope = MidnightCommitments.allVaults().toLowerCase() as Hex, proposal = '77'.repeat(32) as Hex,
  made: { label?: string; account?: string; company?: string; expiresAt?: number } = {},
) => {
  const token = newInvitationToken();
  const coinKey = String(ZswapSecretKeys.fromSeed(dee.moneyAt(0).zswap).coinPublicKey).toLowerCase() as Hex;
  const salt = toHex(new Uint8Array(randomBytes(32))) as Hex;
  const invite = { address: MidnightCommitments.inviteAddressOf(coinKey, salt).toLowerCase() as Hex, salt, scope };
  const proposalSalt = '88'.repeat(32) as Hex;
  const invited = signSeatInvitation({ company: made.company ?? COMPANY, invitation: invitationIdOf(token), person: 'adr_00000000000000000000', name: 'dee', role: 'approver', invite, proposal }, INVITER_SECRET);
  const offer: InvitationOffer = {
    company: made.company ?? COMPANY, companyName: 'Acme', label: (made.label ?? LABEL) as never, account: (made.account ?? ACCOUNT) as never, inboxPublicKey: inboxPublicKey(KEY, COMPANY),
    expiresAt: made.expiresAt ?? Date.now() + 3_600_000, madeAt: utcMomentOf(Date.now()), inviter: inviterFor(made.label ?? LABEL, made.account ?? ACCOUNT) as never,
    for: { kind: 'signer', name: 'dee', role: 'approver', seat: { nonce: '9a'.repeat(32) as Hex, secret: '9b'.repeat(32) as Hex }, invited, byAddress: { address, proposalSalt } },
  } as InvitationOffer;
  return { token, sealed: sealOffer(signOffer(offer, INVITER_SECRET), token), invite, proposal, proposalSalt, coinKey };
};

/* Dee's own seat `n` for the company at `scope`: its signing secret, its leaf and the key of its pay-key wrap slot 0. */
const deesSeat = (n: number, scope: Hex) => {
  const keys = seatKeysFor(dee, LABEL, n);
  const walletKey = { tag: 'schnorr' as const, value: String(committeeKeyFor(dee, LABEL).value).toLowerCase() };
  const signingSecret = toHex(keys.signingSecret).toLowerCase() as Hex;
  const leaf = storedSignerLeaf({ signingSecret, blinding: seatBlinding(walletKey, toHex(keys.salt)) as Hex, scope }, MidnightCommitments).toLowerCase();
  const slot = toHex(pureCircuits.payKeyWrapKeyOf(fromHex(ACCOUNT as Hex), fromHex(signingSecret), 0n)).toLowerCase();
  return { signingSecret, leaf, slot, walletKey };
};

interface ChainNow {
  seats?: string[]; took?: string | null; slots?: string[]; tookFromSecondRead?: string; reads?: number; noRoles?: boolean; rolesUnread?: boolean;
  founding?: string; foundingCommittee?: Array<{ tag: string; value: string }>;
}

interface Seen {
  relayed: Array<Record<string, unknown>>; asked: Array<Record<string, unknown>>; built: InvitedSeatOnTheWire[];
  order: string[]; rolesAsked: string[][]; kept: any;
}
const newSeen = (): Seen => ({ relayed: [], asked: [], built: [], order: [], rolesAsked: [], kept: { accounts: {} } });
interface Opts {
  held?: any; keyring?: false; acceptAnswers?: Array<{ status: number; body: unknown }>; into?: Seen;
  /* The service has closed the offer (accepted or expired) and answers 410. */
  offerGone?: boolean;
  /* The action made once for the wallet's lifetime, as the registry makes it, shared by the runs given it. */
  action?: ReturnType<typeof seatInvitedAction>;
}

/* What the stood-in chain, builder and service answer for the run going on now. */
let live: { o: ReturnType<typeof anOffer>; chain: ChainNow; seen: Seen } | null = null;
const now = () => live!;

/* The action's reach: a stood-in chain and builder that answer for the run going on now, so one action made for a
 * wallet's lifetime can be run more than once. */
const reachNow = () => ({
  network: NET,
  commitments: async () => MidnightCommitments as never,
  payKeyWrapKeyOf: async () => pureCircuits.payKeyWrapKeyOf,
  chain: () => ({
    holders: async () => ({ seats: now().chain.seats ?? [], founding: now().chain.founding ?? 'f0'.repeat(32), foundingCommittee: now().chain.foundingCommittee ?? [] }) as never,
    ...(now().chain.noRoles === true ? {} : {
      roles: async (_a: unknown, _l: unknown, keys: readonly string[]) => {
        now().seen.rolesAsked.push([...keys]);
        if (now().chain.rolesUnread === true) return { key: 'act.company.why.unreadable' };
        return keys.map((key) => ({ key, value: (now().chain.slots ?? []).includes(key) ? '01'.repeat(32) : null }));
      },
    }),
    callState: async () => ({ blockHash: '00', accountState: 'AA==', parameters: 'BB==' }),
    indexer: { indexerUri: 'https://i.example', indexerWsUri: 'wss://i.example' },
  }),
  builder: () => ({
    invitedSeats: async () => {
      const c = now().chain;
      c.reads = (c.reads ?? 0) + 1;
      /* `tookFromSecondRead` is a seat the history shows only after the first read: another took the invitation while this wallet kept its own seat. */
      return { [now().o.proposal]: c.tookFromSecondRead !== undefined && c.reads >= 2 ? c.tookFromSecondRead : c.took ?? null };
    },
    seatInvited: async (input: InvitedSeatOnTheWire) => { now().seen.order.push('prove'); now().seen.built.push(input); return 'VFg='; },
  }) as never,
});

/* Runs both steps against a stood-in chain, builder and service, with saved keys that keep what the action keeps. */
const run = async (o: ReturnType<typeof anOffer>, chain: ChainNow = {}, opts: Opts = {}) => {
  const seen = opts.into ?? newSeen();
  const { relayed, asked, order } = seen;
  if (opts.held !== undefined) seen.kept = opts.held;
  live = { o, chain, seen };
  const answers = [...(opts.acceptAnswers ?? [])];
  const ctx = {
    intent: { name: 'seat-invited', fields: { company: LABEL, account: ACCOUNT, record: COMPANY, token: o.token } } as unknown as ActIntent,
    asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'dee',
    held: { identity: dee, secret: newSecret(), account: 0 }, at: { step: 1, steps: 2 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a seat is relayed through its invitation'); },
    call: async (method: string, path: string, body?: string) => {
      if (method === 'GET') {
        if (opts.offerGone === true) return { status: 410, body: { refused: 'used', error: 'this invitation has already been accepted' } };
        return { status: 200, body: { offer: o.sealed, kind: 'signer', expiresAt: new Date(Date.now() + 1e6).toISOString() } };
      }
      if (path.endsWith('/seat')) { order.push('relay'); relayed.push(JSON.parse(body!)); return { status: 200, body: { sent: true } }; }
      order.push('accept-signer');
      asked.push(JSON.parse(body!));
      return answers.shift() ?? { status: 201, body: { id: 'sgn_dee' } };
    },
    tell: () => {},
    keyring: opts.keyring === false ? null : {
      open: () => ({ read: () => seen.kept }),
      keep: async (f: (k: any) => any) => { order.push('keep'); seen.kept = f(seen.kept); },
    },
  } as unknown as StepContext;
  const action = opts.action ?? seatInvitedAction(reachNow() as never);
  for (const s of action.steps(ctx.intent)) await s.run(ctx);
  return seen;
};

describe('a seat invited by address is taken in the wallet, by the wallet that holds the address', () => {
  it('the wallet hands the seat builder its own seat\'s keys and the address\'s coin key, relays what the builder returns through the invitation, and asks to be admitted', async () => {
    const o = anOffer();
    const { relayed, asked, built, kept, order } = await run(o);
    expect(built).toHaveLength(1);
    const b = built[0]!;
    /* RED WHEN: the seat builder is handed another proposal or salt than the offer's, or a coin key not the typed address's. */
    expect(b).toMatchObject({ account: ACCOUNT, proposal: o.proposal, proposalSalt: o.proposalSalt, invite: { addressSalt: o.invite.salt } });
    expect(MidnightCommitments.coinPublicKeyOf(b.invite.coinSecretKey as Hex).toLowerCase()).toBe(o.coinKey);
    /* RED WHEN: the seat builder is handed a seat other than the wallet's own seat 0 for this company, or rights other than the invitation's. */
    const own = seatKeysFor(dee, LABEL, 0);
    expect(b.material.signingSecret).toBe(toHex(own.signingSecret));
    expect(b.material.scope).toBe(o.invite.scope);
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ tx: 'VFg=' });
    /* The request to be admitted opens with the company's key and carries the seat's public halves, not its secrets. */
    const waiting = openFromInbox<PendingSignerPayload>(asked[0]!.waiting as never, COMPANY, KEY);
    expect(waiting).toMatchObject({ name: 'dee', role: 'approver', person: 'dee', signingPublicKey: signingPublicKeyOf(toHex(own.signingSecret) as Hex).toLowerCase() });
    expect(JSON.stringify(asked)).not.toContain(toHex(own.signingSecret));
    expect(JSON.stringify(asked)).not.toContain(b.invite.coinSecretKey);
    /* RED WHEN: the seat taken is not kept in the saved keys, under the request the company filed. */
    expect(kept.accounts[COMPANY]).toMatchObject({ signerId: 'sgn_dee', signingSecret: toHex(own.signingSecret), scope: o.invite.scope, seat: 0 });
    /* RED WHEN: the seat is kept only after its proof is relayed, or only after the one-shot request to be admitted. */
    expect(order).toEqual(['keep', 'prove', 'relay', 'accept-signer', 'keep']);
    const pending = Object.values(kept.pendingSeats ?? {}) as any[];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ accountId: COMPANY, signingSecret: toHex(own.signingSecret), scope: o.invite.scope, seat: 0, invited: { terms: { proposal: o.proposal } } });
    expect(pending[0].opening).toEqual(kept.accounts[COMPANY].opening);
  });

  it('RED WHEN: the wallet takes a seat offered to an address it does not hold', async () => {
    const other = addressFor(identityFromSecret(newSecret()).moneyAt(0).zswap, NET).bech32;
    await expect(run(anOffer(other))).rejects.toMatchObject({ words: { key: 'act.seat-invited.why.not-held' } });
  });

  it('a step taken up again does not take the seat twice, and refuses a seat the history shows another took', async () => {
    const o = anOffer();
    const { leaf } = deesSeat(0, o.invite.scope);
    const again = await run(o, { seats: [leaf], took: leaf });
    expect(again.built).toEqual([]);
    expect(again.relayed).toEqual([]);
    const err = await run(anOffer(), { took: '5a'.repeat(32) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepRefused);
    expect(err).toMatchObject({ words: { key: 'act.seat-invited.why.taken-by-another' } });
  });

  it('RED WHEN: the history shows the invitation taken at another leaf once this wallet has kept its seat, and the seat is still proved and relayed', async () => {
    const into = newSeen();
    const err = await run(anOffer(), { tookFromSecondRead: '5a'.repeat(32) }, { into }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepRefused);
    expect(err).toMatchObject({ words: { key: 'act.seat-invited.why.taken-by-another' } });
    /* The seat was kept before the second look at the history; nothing was proved, relayed or asked for after it. */
    expect(into.order).toEqual(['keep']);
  });

  it('RED WHEN: an offer for another company, label or account than the link names, or one that has expired, is opened, and a seat is kept for it', async () => {
    const refusedBefore = async (o: ReturnType<typeof anOffer>, key: string) => {
      const into = newSeen();
      const err = await run(o, {}, { into }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StepRefused);
      expect(err).toMatchObject({ words: { key: `act.seat-invited.why.${key}` } });
      expect(into.order).toEqual([]);
    };
    const same = [DEES_ADDRESS, MidnightCommitments.allVaults().toLowerCase() as Hex, '77'.repeat(32) as Hex] as const;
    await refusedBefore(anOffer(...same, { company: 'acc_other' }), 'another-company');
    await refusedBefore(anOffer(...same, { label: drawCompanyLabel() }), 'another-company');
    await refusedBefore(anOffer(...same, { account: 'd0'.repeat(32) }), 'another-company');
    await refusedBefore(anOffer(...same, { expiresAt: Date.now() - 1_000 }), 'expired');
  });

  it('RED WHEN: a wallet already seated on this company takes a second seat, by its saved keys, by a leaf at the offer\'s rights or at all vaults, or as the founding seat', async () => {
    const all = MidnightCommitments.allVaults().toLowerCase() as Hex;
    const narrow = '3c'.repeat(32) as Hex;
    const refusedWith = async (o: ReturnType<typeof anOffer>, chain: ChainNow, opts: Opts = {}) => {
      const err = await run(o, chain, opts).catch((e: unknown) => e);
      expect(err).toMatchObject({ words: { key: 'act.seat-invited.why.already-seated' } });
    };
    /* A leaf of its own seat 0 at the offer's rights, which are all vaults. */
    await refusedWith(anOffer(), { seats: [deesSeat(0, all).leaf] });
    /* A leaf of its own seat 2 at the narrower rights it is offered now. */
    await refusedWith(anOffer(DEES_ADDRESS, narrow), { seats: [deesSeat(2, narrow).leaf] });
    /* A leaf of its own seat 3 at all vaults, offered narrower rights now. */
    await refusedWith(anOffer(DEES_ADDRESS, narrow), { seats: [deesSeat(3, all).leaf] });
    /* The founding seat, held by this wallet's committee key. */
    const founding = '6f'.repeat(32);
    await refusedWith(anOffer(), { seats: [founding], founding, foundingCommittee: [deesSeat(0, all).walletKey] });
    /* A seat its saved keys already hold for this company. */
    await refusedWith(anOffer(), {}, { held: { accounts: { [COMPANY]: { signerId: 'sgn_old', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: all } } } });
    /* Nothing is kept, proved, relayed or asked for. */
    const into = newSeen();
    await run(anOffer(), { seats: [deesSeat(0, all).leaf] }, { into }).catch(() => {});
    expect([into.order, into.kept]).toEqual([[], { accounts: {} }]);
  });

  it('RED WHEN: a seat number whose pay-key wrap slot is occupied is taken, or the seat number is not kept', async () => {
    const o = anOffer();
    const { built, kept, rolesAsked } = await run(o, { slots: [deesSeat(0, o.invite.scope).slot] });
    /* One read of the 64 slot keys, made with the compiled account's own key. */
    expect(rolesAsked).toHaveLength(1);
    expect(rolesAsked[0]).toHaveLength(64);
    expect(rolesAsked[0]![5]).toBe(deesSeat(5, o.invite.scope).slot);
    expect(built[0]!.material.signingSecret).toBe(toHex(seatKeysFor(dee, LABEL, 1).signingSecret));
    expect(kept.accounts[COMPANY]).toMatchObject({ seat: 1 });
    expect(Object.values(kept.pendingSeats)[0]).toMatchObject({ seat: 1 });
  });

  it('RED WHEN: a seat taken up again skips its own seat because its wrap slot is occupied', async () => {
    const o = anOffer();
    const own = deesSeat(0, o.invite.scope);
    const { asked, kept } = await run(o, { seats: [own.leaf], took: own.leaf, slots: [own.slot] });
    const waiting = openFromInbox<PendingSignerPayload>(asked[0]!.waiting as never, COMPANY, KEY);
    expect(waiting.signingPublicKey).toBe(signingPublicKeyOf(own.signingSecret).toLowerCase());
    expect(kept.accounts[COMPANY]).toMatchObject({ signingSecret: own.signingSecret, seat: 0 });
  });

  it('RED WHEN: a seat is taken without the wrap slots read from the chain', async () => {
    const without = await run(anOffer(), { noRoles: true }).catch((e: unknown) => e);
    expect(without).toMatchObject({ words: { key: 'act.seat-invited.why.no-slots' } });
    const unread = await run(anOffer(), { rolesUnread: true }).catch((e: unknown) => e);
    expect(unread).toMatchObject({ words: { key: 'act.company.why.unreadable' } });
  });

  it('RED WHEN: a seat is proved when the page handed no saved keys to keep it in', async () => {
    const err = await run(anOffer(), {}, { keyring: false }).catch((e: unknown) => e);
    expect(err).toMatchObject({ words: { key: 'act.seat-invited.why.no-keys-to-keep' } });
  });

  it('RED WHEN: a request to be admitted the service already took, or failed on, refuses the act or loses the seat, or the step taken up again cannot finish', async () => {
    const o = anOffer();
    const own = deesSeat(0, o.invite.scope);
    /* The service filed the request and then failed: the act ends waiting for admission, with the seat kept. */
    const failed = await run(o, {}, { acceptAnswers: [{ status: 500, body: { error: 'the service failed' } }] });
    expect(failed.order).toEqual(['keep', 'prove', 'relay', 'accept-signer']);
    expect(failed.kept.accounts[COMPANY]).toBeUndefined();
    expect(Object.values(failed.kept.pendingSeats)).toEqual([expect.objectContaining({ accountId: COMPANY, signingSecret: own.signingSecret, seat: 0 })]);
    /* The invitation reads used: the request was taken. The act ends waiting too, and keeps nothing else. */
    const used = await run(o, { seats: [own.leaf], took: own.leaf }, { held: failed.kept, acceptAnswers: [{ status: 410, body: { refused: 'used', error: 'already accepted' } }] });
    expect(used.kept).toEqual(failed.kept);
    /* A refusal that is not either still refuses, with its words. */
    const refused = await run(o, { seats: [own.leaf], took: own.leaf }, { held: failed.kept, acceptAnswers: [{ status: 403, body: { refused: 'not-accepted', error: 'not this link' } }] }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ words: { key: 'act.seat-invited.why.not-asked' } });
    /* Taken up again after a reload, with the offer closed at the service: it asks from the seat it kept, the service
     * gives back the id it gave, and the seat is kept under it. */
    const again = await run(o, { seats: [own.leaf], took: own.leaf }, { offerGone: true, held: failed.kept, acceptAnswers: [{ status: 201, body: { id: 'sgn_dee' } }] });
    expect(again.built).toEqual([]);
    expect(again.order).toEqual(['accept-signer', 'keep']);
    const waiting = openFromInbox<PendingSignerPayload>(again.asked[0]!.waiting as never, COMPANY, KEY);
    expect(waiting).toMatchObject({ name: 'dee', role: 'approver', signingPublicKey: signingPublicKeyOf(own.signingSecret).toLowerCase() });
    expect(again.asked[0]!.acceptance).toBe(acceptanceProofOf(o.token));
    expect(again.kept.accounts[COMPANY]).toMatchObject({ signerId: 'sgn_dee', signingSecret: own.signingSecret, seat: 0 });
    expect(again.kept.pendingSeats).toEqual(failed.kept.pendingSeats);
    /* RED WHEN: a closed offer is opened when this wallet kept no seat for it, or kept it for another company's account. */
    const unkept = await run(o, { seats: [own.leaf], took: own.leaf }, { offerGone: true }).catch((e: unknown) => e);
    expect(unkept).toMatchObject({ words: { key: 'act.seat-invited.why.no-offer' } });
    const elsewhere = structuredClone(failed.kept);
    for (const p of Object.values(elsewhere.pendingSeats) as any[]) p.joining.account = 'd0'.repeat(32);
    const another = await run(o, { seats: [own.leaf], took: own.leaf }, { offerGone: true, held: elsewhere }).catch((e: unknown) => e);
    expect(another).toMatchObject({ words: { key: 'act.seat-invited.why.no-offer' } });
  });

  it('RED WHEN: a seat kept for an invitation that never landed takes its number, so the next invitation at other rights cannot be taken', async () => {
    const narrow = '3c'.repeat(32) as Hex;
    const one = anOffer(DEES_ADDRESS, narrow, '71'.repeat(32) as Hex);
    /* Invitation one is proved and relayed at a narrower scope, and the network never shows it. */
    const into = newSeen();
    await run(one, {}, { into, acceptAnswers: [{ status: 410, body: { refused: 'expired', error: 'expired' } }] }).catch(() => {});
    expect(Object.values(into.kept.pendingSeats)).toEqual([expect.objectContaining({ seat: 0, scope: narrow })]);
    /* Invitation two, another proposal at all vaults, with the same saved keys: it takes the next number. */
    const two = anOffer(DEES_ADDRESS, MidnightCommitments.allVaults().toLowerCase() as Hex, '72'.repeat(32) as Hex);
    const taken = await run(two, {}, { held: into.kept });
    expect(taken.built[0]!.material.signingSecret).toBe(deesSeat(1, two.invite.scope).signingSecret);
    expect(taken.kept.accounts[COMPANY]).toMatchObject({ seat: 1 });
    expect(Object.keys(taken.kept.pendingSeats)).toHaveLength(2);
  });

  it('RED WHEN: one wallet lifetime takes a second invitation with what it opened and chose for the first', async () => {
    const action = seatInvitedAction(reachNow() as never);
    const a = anOffer();
    const first = await run(a, {}, { action });
    const b = anOffer(DEES_ADDRESS, '3c'.repeat(32) as Hex, '72'.repeat(32) as Hex);
    /* The second invitation, on a wallet whose saved keys hold no seat here (another device's, say), with the same action. */
    const second = await run(b, {}, { action });
    expect(first.built[0]!.proposal).toBe(a.proposal);
    expect(second.built[0]!.proposal).toBe(b.proposal);
    expect(second.built[0]!.material.scope).toBe('3c'.repeat(32));
    expect(second.relayed[0]!.acceptance).toBe(acceptanceProofOf(b.token));
  });

  it('RED WHEN: a step taken up again before the chain shows its seat proves another seat than the one it kept', async () => {
    const o = anOffer();
    const into = newSeen();
    await run(o, {}, { into });
    const kept = into.kept;
    /* Taken up again with seat 0's wrap slot read as filled: the seat kept is still the one proved. */
    const again = await run(o, { slots: [deesSeat(0, o.invite.scope).slot] }, { held: { accounts: {}, pendingSeats: kept.pendingSeats } });
    expect(again.built[0]!.material.signingSecret).toBe(toHex(seatKeysFor(dee, LABEL, 0).signingSecret));
    expect(again.kept.pendingSeats).toEqual(kept.pendingSeats);
  });

  it('RED WHEN: the coin key\'s hex is not watched, so a message carrying it could cross to the page', async () => {
    forgetWatched();
    const { built } = await run(anOffer());
    expect(carriesASecret({ any: built[0]!.invite.coinSecretKey })).toBe(true);
    forgetWatched();
  });
});
