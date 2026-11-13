import { readFileSync } from 'node:fs';
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
import { fromHex, newSigningKeypair, sign, signingPublicKeyOf, toHex, type Hex } from '../../../../src/core/crypto.js';
import { directoryChangeMessage, type DirectoryChange } from '../../../../src/midnight/seat-directory.js';
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
import { proveSeatKeys } from '../../../../src/core/seat-invite-proof.js';
import { carriesASecret, forgetWatched } from '../keyring/nothing-secret-crosses.js';
import { pureCircuits } from '../../../../contracts/managed/contract/index.js';
import { StepRefused, type StepContext } from './definition.js';
import { ServiceNotReached } from '../../../../packages/web-shared/src/hand-over.js';
import { rightsOfRole, scopeOfRole } from '../../../../src/core/seat-rights.js';

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
  address = DEES_ADDRESS, scope = scopeOfRole('approver'), proposal = '77'.repeat(32) as Hex,
  made: { label?: string; account?: string; company?: string; expiresAt?: number; threshold?: string } = {},
) => {
  const token = newInvitationToken();
  const coinKey = String(ZswapSecretKeys.fromSeed(dee.moneyAt(0).zswap).coinPublicKey).toLowerCase() as Hex;
  const salt = toHex(new Uint8Array(randomBytes(32))) as Hex;
  const invite = {
    address: MidnightCommitments.inviteAddressOf(coinKey, salt).toLowerCase() as Hex, salt, scope, ...(made.threshold === undefined ? {} : { threshold: made.threshold }),
  };
  const proposalSalt = '88'.repeat(32) as Hex;
  /* Offered every right on every vault, Dee is invited as an admin; offered an approver's rights, as an approver. */
  const role = scope === MidnightCommitments.allVaults().toLowerCase() ? 'admin' as const : 'approver' as const;
  const invited = signSeatInvitation({ company: made.company ?? COMPANY, invitation: invitationIdOf(token), person: 'adr_00000000000000000000', name: 'dee', role, invite, proposal }, INVITER_SECRET);
  const offer: InvitationOffer = {
    company: made.company ?? COMPANY, companyName: 'Acme', label: (made.label ?? LABEL) as never, account: (made.account ?? ACCOUNT) as never, inboxPublicKey: inboxPublicKey(KEY, COMPANY),
    expiresAt: made.expiresAt ?? Date.now() + 3_600_000, madeAt: utcMomentOf(Date.now()), inviter: inviterFor(made.label ?? LABEL, made.account ?? ACCOUNT) as never,
    for: { kind: 'signer', name: 'dee', role, seat: { nonce: '9a'.repeat(32) as Hex, secret: '9b'.repeat(32) as Hex }, invited, byAddress: { address, proposalSalt } },
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
  /* The approvals a change of who is seated needs, as the chain holds it now: 1 unless a case gives another. */
  seatBar?: number;
  /* Our service cannot be reached for the seat, and the person's own wallet sends it instead and then loses its answer. */
  goneAround?: boolean;
}

interface Seen {
  relayed: Array<Record<string, unknown>>; asked: Array<Record<string, unknown>>; built: InvitedSeatOnTheWire[];
  order: string[]; rolesAsked: string[][]; kept: any; namedAsked: Array<Record<string, unknown>>;
}
const newSeen = (): Seen => ({ relayed: [], asked: [], built: [], order: [], rolesAsked: [], kept: { accounts: {} }, namedAsked: [] });
interface Opts {
  held?: any; keyring?: false; acceptAnswers?: Array<{ status: number; body: unknown }>; into?: Seen;
  /* The service has closed the offer and answers 410: as used (true), or as the reason named. */
  offerGone?: boolean | 'used' | 'expired' | 'withdrawn';
  /* What the service says the company's directory already names among the leaves and keys asked about; an error or a refusal instead. */
  named?: { leaves?: readonly string[]; keys?: readonly string[] } | 'error' | 'refused' | 'used' | 'expired' | 'unreadable';
  /* The company's directory as the service serves it: none unless a case gives one; 'unread' when the service does not serve it. */
  directory?: readonly unknown[] | 'unread';
  /* The action made once for the wallet's lifetime, as the registry makes it, shared by the runs given it. */
  action?: ReturnType<typeof seatInvitedAction>;
  /* The sign-in the page names: Dee's unless a case gives another, or none. */
  person?: string | null;
}

/* The person's own wallet: reads the proven seat as the one call to `seatInvited`, pays its fee in DUST, hands it to the network and loses the answer. */
const anIntent = (actions: readonly unknown[], dust?: unknown) => ({ actions, guaranteedUnshieldedOffer: undefined, fallibleUnshieldedOffer: undefined, dustActions: dust });
const ownWalletLosingItsAnswer = () => ({
  ledger: async () => ({ Transaction: { deserialize: () => ({
    guaranteedOffer: undefined, fallibleOffer: undefined, intents: new Map([[1, anIntent([{ address: ACCOUNT, entryPoint: 'seatInvited' }])]]), imbalances: () => new Map(),
  }) } }),
  keys: () => ({}), signSegment: () => ({}),
  facade: async () => ({
    dust: { state: { subscribe: (w: { next: (s: unknown) => void }) => { w.next({ progress: { isConnected: true, isStrictlyComplete: () => true } }); return { unsubscribe: () => {} }; } } },
    balanceUnboundTransaction: async (call: unknown) => ({
      baseTransaction: call, balancingTransaction: { guaranteedOffer: undefined, fallibleOffer: undefined, intents: new Map([[2, anIntent([], { spends: [1], registrations: [] })]]) },
    }),
    signRecipe: async (r: unknown) => r, finalizeRecipe: async (r: unknown) => r,
    submitTransaction: async () => { now().seen.order.push('own wallet sent'); throw new Error('the node dropped the connection'); },
    revert: async () => undefined,
  }),
});

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
    holders: async () => ({ seats: now().chain.seats ?? [], founding: now().chain.founding ?? 'f0'.repeat(32), foundingCommittee: now().chain.foundingCommittee ?? [], seatBar: now().chain.seatBar ?? 1 }) as never,
    ...(now().chain.noRoles === true ? {} : {
      roles: async (_a: unknown, _l: unknown, keys: readonly string[]) => {
        now().seen.rolesAsked.push([...keys]);
        if (now().chain.rolesUnread === true) return { key: 'act.company.why.unreadable' };
        return keys.map((key) => ({ key, value: (now().chain.slots ?? []).includes(key) ? '01'.repeat(32) : null }));
      },
    }),
    callState: async () => ({ blockHash: '00', accountState: 'AA==', parameters: 'BB==' }),
    indexer: { indexerUri: 'https://i.example', indexerWsUri: 'wss://i.example' },
    ...(now().chain.goneAround === true ? { ownWallet: ownWalletLosingItsAnswer } : {}),
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
    asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: opts.person === undefined ? 'dee' : opts.person,
    held: { identity: dee, secret: newSecret(), account: 0 }, at: { step: 1, steps: 2 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a seat is relayed through its invitation'); },
    call: async (method: string, path: string, body?: string) => {
      if (method === 'GET' && path === `/api/accounts/${COMPANY}/directory`) {
        return opts.directory === 'unread' ? { status: 503, body: { error: 'not now' } } : { status: 200, body: { filings: opts.directory ?? [] } };
      }
      if (method === 'GET') {
        if (opts.offerGone !== undefined && opts.offerGone !== false) {
          return { status: 410, body: { refused: opts.offerGone === true ? 'used' : opts.offerGone, error: 'this invitation is closed' } };
        }
        return { status: 200, body: { offer: o.sealed, kind: 'signer', expiresAt: new Date(Date.now() + 1e6).toISOString() } };
      }
      if (path.endsWith('/seats-named')) {
        seen.namedAsked.push(JSON.parse(body!));
        if (opts.named === 'error') throw new Error('the service could not be reached');
        if (opts.named === 'refused') return { status: 410, body: { refused: 'withdrawn', error: 'taken back' } };
        if (opts.named === 'used' || opts.named === 'expired') return { status: 410, body: { refused: opts.named, error: 'closed' } };
        if (opts.named === 'unreadable') return { status: 503, body: { error: 'the chain could not be read' } };
        return { status: 200, body: { leaves: opts.named?.leaves ?? [], keys: opts.named?.keys ?? [] } };
      }
      if (path.endsWith('/seat') && chain.goneAround === true) throw new ServiceNotReached('the company\'s service could not be reached', true);
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

/** The company's directory holding `leaf`'s retirement, signed by the one seat whose entry it names. */
const retiredIn = (leaf: string): unknown[] => {
  const signer = newSigningKeypair();
  const unsigned = { kind: 'retire', seat: leaf, filedUpTo: {}, threshold: 1, signatures: [] } as unknown as DirectoryChange;
  const signature = sign(directoryChangeMessage(COMPANY, 2, unsigned), signer.secret);
  return [
    { company: COMPANY, version: 1, change: { kind: 'claim', entry: { person: 'ada', statement: { signingKey: signer.publicKey } } } },
    { company: COMPANY, version: 2, change: { ...unsigned, signatures: [{ publicKey: signer.publicKey, signature }] } },
  ];
};

describe('a seat invited by address is taken in the wallet, by the wallet that holds the address', () => {
  it('with no sign-in named by the page, nothing is kept, proved or sent, and no seat is taken', async () => {
    const seen = newSeen();
    /* RED WHEN: the seat is taken on the network, and the threshold maybe raised, for a request every device would refuse. */
    await expect(run(anOffer(), {}, { person: null, into: seen })).rejects.toMatchObject({ words: { key: 'act.seat-invited.why.no-sign-in' } });
    expect(seen.asked).toEqual([]);
    expect(seen.order).toEqual([]);
    expect(seen.built).toEqual([]);
  });

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
    /* RED WHEN: the rights an approver is seated with are not kept with the seat, so no run it approves proves. */
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ tx: 'VFg=' });
    /* The request to be admitted opens with the company's key and carries the seat's public halves, not its secrets. */
    const waiting = openFromInbox<PendingSignerPayload>(asked[0]!.waiting as never, COMPANY, KEY);
    expect(waiting).toMatchObject({ name: 'dee', role: 'approver', person: 'dee', signingPublicKey: signingPublicKeyOf(toHex(own.signingSecret) as Hex).toLowerCase() });
    /* RED WHEN: the request's proof does not cover the sign-in it is sealed for and the invitation it answers. */
    const published = { signingPublicKey: waiting.signingPublicKey, wrappingPublicKey: waiting.wrappingPublicKey, leafCommitment: waiting.leafCommitment };
    const seatOffered = { accountId: COMPANY, nonce: '9a'.repeat(32) as Hex, secret: '9b'.repeat(32) as Hex };
    expect(waiting.seatProof).toEqual(proveSeatKeys(seatOffered, published, { person: 'dee', invitationId: invitationIdOf(o.token) }));
    expect(waiting.seatProof).not.toEqual(proveSeatKeys(seatOffered, published, { person: 'mallory', invitationId: invitationIdOf(o.token) }));
    expect(JSON.stringify(asked)).not.toContain(toHex(own.signingSecret));
    expect(JSON.stringify(asked)).not.toContain(b.invite.coinSecretKey);
    /* RED WHEN: the seat taken is not kept in the saved keys, under the request the company filed. */
    expect(kept.accounts[COMPANY]).toMatchObject({ signerId: 'sgn_dee', signingSecret: toHex(own.signingSecret), scope: o.invite.scope, seat: 0, rights: rightsOfRole('approver') });
    /* RED WHEN: the seat is kept only after its proof is relayed, or only after the one-shot request to be admitted. */
    expect(order).toEqual(['keep', 'prove', 'relay', 'accept-signer', 'keep']);
    const pending = Object.values(kept.pendingSeats ?? {}) as any[];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ accountId: COMPANY, signingSecret: toHex(own.signingSecret), scope: o.invite.scope, rights: rightsOfRole('approver'), seat: 0, invited: { terms: { proposal: o.proposal } } });
    expect(pending[0].opening).toEqual(kept.accounts[COMPANY].opening);
  });

  it('the seat is proved with the threshold the signed invitation sets once it is taken, and 0 where it sets none', async () => {
    const one = 'a1'.repeat(32);
    /* RED WHEN: the wallet proves the seat with another threshold than the one the signers approved, which the chain refuses. */
    expect((await run(anOffer(undefined, undefined, undefined, { threshold: '2' }), { seats: [one] })).built[0]!.newThreshold).toBe('2');
    /* RED WHEN: an invitation that sets no threshold is proved with one. */
    expect((await run(anOffer(), { seats: [one] })).built[0]!.newThreshold).toBe('0');
  });

  it('RED WHEN: a threshold above the seats held once this one is taken is proved and relayed, which the chain refuses', async () => {
    const seen = newSeen();
    await expect(run(anOffer(undefined, undefined, undefined, { threshold: '3' }), { seats: ['a1'.repeat(32)] }, { into: seen }))
      .rejects.toMatchObject({ words: { key: 'act.seat-invited.why.threshold-above-the-seats', values: { threshold: '3', seats: 2 } } });
    expect(seen.built).toEqual([]);
    expect(seen.relayed).toEqual([]);
  });

  it('a seat the wallet sent to the chain itself, whose answer was then lost, is said as perhaps taken, never as not taken', async () => {
    const seen = newSeen();
    await expect(run(anOffer(), { goneAround: true }, { into: seen }))
      .rejects.toMatchObject({ words: { key: 'act.seat-invited.why.may-be-sent' } });
    /* RED WHEN: after the person's own wallet handed the seat to the network, the step says it was not taken, so it is taken again. */
    expect(seen.order).toContain('own wallet sent');
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
    const narrow = scopeOfRole('approver');
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
    /* A seat its saved keys already hold for this company, which the chain still holds. */
    const held = { signerId: 'sgn_old', signingSecret: '01'.repeat(32) as Hex, wrappingSecret: '02'.repeat(32) as Hex, blinding: '03'.repeat(32) as Hex, scope: all };
    const heldLeaf = storedSignerLeaf({ signingSecret: held.signingSecret, blinding: held.blinding, scope: held.scope }, MidnightCommitments as never).toLowerCase();
    await refusedWith(anOffer(), { seats: [heldLeaf] }, { held: { accounts: { [COMPANY]: held } } });
    /* A seat its saved keys hold with no scope, whose leaf this wallet cannot work out. */
    const { scope: _noScope, ...unscoped } = held;
    await refusedWith(anOffer(), {}, { held: { accounts: { [COMPANY]: unscoped } } });
    /* Nothing is kept, proved, relayed or asked for. */
    const into = newSeen();
    const stopped = await run(anOffer(), { seats: [deesSeat(0, all).leaf] }, { into }).catch((e: unknown) => e);
    /* RED WHEN: a setup error that stops the run before the seat is read passes as the refusal this checks. */
    expect(stopped).toMatchObject({ words: { key: 'act.seat-invited.why.already-seated' } });
    expect([into.order, into.kept]).toEqual([[], { accounts: {} }]);
  });

  it('a wallet whose seat on this company the chain no longer holds takes the new seat, and keeps the removed seat\'s keys set aside, never written over', async () => {
    const all = MidnightCommitments.allVaults().toLowerCase() as Hex;
    const removed = { signerId: 'sgn_old', signingSecret: '01'.repeat(32) as Hex, wrappingSecret: '02'.repeat(32) as Hex, blinding: '03'.repeat(32) as Hex, scope: all };
    const leaf = storedSignerLeaf(removed, MidnightCommitments as never).toLowerCase();
    /* RED WHEN: a seat one read of the chain leaves out is set aside though the company's directory holds no retirement for it. */
    const unretired = await run(anOffer(), {}, { held: { accounts: { [COMPANY]: removed } } }).catch((e: unknown) => e);
    expect(unretired).toMatchObject({ words: { key: 'act.seat-invited.why.removal-not-filed' } });
    /* RED WHEN: a directory the service did not serve is read as one holding no retirement, and the person told their removal was not recorded. */
    const unread = await run(anOffer(), {}, { held: { accounts: { [COMPANY]: removed } }, directory: 'unread' }).catch((e: unknown) => e);
    expect(unread).toMatchObject({ words: { key: 'act.seat-invited.why.directory-not-read' } });
    /*
     * The directory holds the seat's retirement, signed by a seat it names: two sources agree the seat was removed.
     * RED WHEN: a bar for a change of who is seated raised after the removal (1 when it was filed, 3 now) refuses the rejoin.
     */
    const { kept, order } = await run(anOffer(), { seatBar: 3 }, { held: { accounts: { [COMPANY]: removed } }, directory: retiredIn(leaf) });
    /* RED WHEN: a wallet whose seat was removed can never take a seat on the company again, so a signer whose role changes is never seated again. */
    expect(kept.accounts[COMPANY]).toMatchObject({ signerId: 'sgn_dee', signingSecret: toHex(seatKeysFor(dee, LABEL, 0).signingSecret), seat: 0 });
    /* RED WHEN: the removed seat's keys are written over or dropped. */
    expect(kept.formerSeats).toEqual({ [signingPublicKeyOf(removed.signingSecret).toLowerCase()]: { ...removed, accountId: COMPANY } });
    /* The removed seat is set aside before anything of the new seat is kept or proved. */
    expect(order).toEqual(['keep', 'keep', 'prove', 'relay', 'accept-signer', 'keep']);
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

  it('RED WHEN: an invitation the company withdrew is taken on the wallet\'s own path from the kept offer, though the service says it is withdrawn', async () => {
    const o = anOffer();
    const kept = await run(o, {}, { acceptAnswers: [{ status: 500, body: { error: 'the service failed' } }] });
    const resumed = newSeen();
    resumed.kept = kept.kept;
    await expect(run(o, { goneAround: true }, { into: resumed, offerGone: 'withdrawn' }))
      .rejects.toMatchObject({ words: { key: 'act.seat-invited.why.withdrawn-kept' } });
    /* Nothing was proved, sent by the wallet or relayed. */
    expect(resumed.order).toEqual([]);
    expect(resumed.built).toEqual([]);
  });

  it('RED WHEN: an invitation taken back before this wallet kept any seat for it says nothing was sent', async () => {
    await expect(run(anOffer(), {}, { offerGone: 'withdrawn' })).rejects.toMatchObject({ words: { key: 'act.seat-invited.why.withdrawn' } });
  });

  it('RED WHEN: an invitation closed by expiry or by use no longer resumes from the offer the wallet kept', async () => {
    const o = anOffer();
    const { leaf } = deesSeat(0, o.invite.scope);
    const kept = await run(o, {}, { acceptAnswers: [{ status: 500, body: { error: 'the service failed' } }] });
    for (const gone of ['expired', 'used'] as const) {
      const again = await run(o, { seats: [leaf], took: leaf }, { offerGone: gone, held: structuredClone(kept.kept), acceptAnswers: [{ status: 201, body: { id: 'sgn_dee' } }] });
      expect(again.built).toEqual([]);
      expect(again.kept.accounts[COMPANY]).toMatchObject({ signerId: 'sgn_dee', seat: 0 });
    }
  });

  it('RED WHEN: a seat number whose leaf or key the company\'s directory already names is chosen again, or a directory that cannot be asked is picked past', async () => {
    const o = anOffer();
    const zero = deesSeat(0, o.invite.scope);
    const atAll = deesSeat(0, MidnightCommitments.allVaults().toLowerCase() as Hex);
    const keyOf = (n: number) => signingPublicKeyOf(deesSeat(n, o.invite.scope).signingSecret).toLowerCase();
    const seatTaken = async (named: Opts['named']) => (await run(o, {}, { named })).built[0]!.material.signingSecret;
    expect(await seatTaken(undefined)).toBe(zero.signingSecret);
    /* RED WHEN: a retired or claimed seat's leaf, at the invitation's rights or at all vaults, or its key, does not move the wallet to the next number. */
    expect(await seatTaken({ leaves: [zero.leaf] })).toBe(deesSeat(1, o.invite.scope).signingSecret);
    expect(await seatTaken({ leaves: [atAll.leaf] })).toBe(deesSeat(1, o.invite.scope).signingSecret);
    expect(await seatTaken({ keys: [keyOf(0)] })).toBe(deesSeat(1, o.invite.scope).signingSecret);
    expect(await seatTaken({ leaves: [zero.leaf], keys: [keyOf(1)] })).toBe(deesSeat(2, o.invite.scope).signingSecret);
    /* The question carries the proof and at most the seat numbers the wallet tries, and no secret. */
    const seen = newSeen();
    await run(o, {}, { into: seen });
    expect(seen.namedAsked).toHaveLength(1);
    const asked = seen.namedAsked[0] as { acceptance: string; leaves: string[]; keys: string[] };
    expect(asked.acceptance).toBe(acceptanceProofOf(o.token));
    expect(asked.leaves.length).toBeLessThanOrEqual(128);
    expect(asked.keys).toHaveLength(64);
    expect(asked.leaves).toContain(zero.leaf);
    expect(JSON.stringify(asked)).not.toContain(zero.signingSecret);
    /* RED WHEN: an answer that is an error, a refusal or no answer is taken as nothing named, and a seat is picked blind; or a closed invitation is told to try again. */
    const refusals = { error: 'no-slots', unreadable: 'no-slots', refused: 'withdrawn', used: 'used', expired: 'expired' } as const;
    for (const [named, key] of Object.entries(refusals) as Array<[keyof typeof refusals, string]>) {
      const blind = newSeen();
      await expect(run(o, {}, { into: blind, named })).rejects.toMatchObject({ words: { key: `act.seat-invited.why.${key}` } });
      expect(blind.built).toEqual([]);
    }
  });

  it('RED WHEN: the screen says nothing else reaches the page though the public keys of the seats this wallet could take, and the seat taken, do', async () => {
    const words = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
    expect(words['act.seat-invited.shown.nothing-else']).toMatch(/in the clear, the public keys/u);
    expect(words['act.seat-invited.shown.nothing-else']).toMatch(/the seat it takes/u);
  });

  it('RED WHEN: the request to be admitted does not name the seat the wallet took, so it cannot be filed after the invitation expires', async () => {
    const o = anOffer();
    const { asked } = await run(o);
    expect(asked[0]!.leaf).toBe(deesSeat(0, o.invite.scope).leaf);
  });

  it('RED WHEN: a seat kept for an invitation that never landed takes its number, so the next invitation at other rights cannot be taken', async () => {
    const narrow = scopeOfRole('approver');
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
    const b = anOffer(DEES_ADDRESS, MidnightCommitments.allVaults().toLowerCase() as Hex, '72'.repeat(32) as Hex);
    /* The second invitation, on a wallet whose saved keys hold no seat here (another device's, say), with the same action. */
    const second = await run(b, {}, { action });
    expect(first.built[0]!.proposal).toBe(a.proposal);
    expect(second.built[0]!.proposal).toBe(b.proposal);
    expect(second.built[0]!.material.scope).toBe(b.invite.scope);
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
