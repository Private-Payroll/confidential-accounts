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
import { signingPublicKeyOf, toHex, type Hex } from '../../../../src/core/crypto.js';
import {
  invitationIdOf, newInvitationToken, sealOffer, signOffer, signSeatInvitation, utcMomentOf, type InvitationOffer,
} from '../../../../src/core/invitation.js';
import { inboxPublicKey, openFromInbox } from '../../../../src/core/sealed-records.js';
import { MidnightCommitments } from '../../../../src/midnight/commitments.js';
import type { PendingSignerPayload } from '../../../../src/core/types.js';
import type { InvitedSeatOnTheWire } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { seatInvitedAction } from './seat-invited.js';
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
const inviter = {
  committeeKey: committeeKeyFor(inviterWallet, LABEL) as never,
  statement: signDirectoryEntry(inviterWallet, LABEL, ACCOUNT as never, new Uint8Array(32).fill(3), signingPublicKeyOf(INVITER_SECRET), 'ab'.repeat(32)),
  opening: { publicKey: '01'.repeat(32), scope: '02'.repeat(32), blinding: '03'.repeat(32), salt: '04'.repeat(32), walletKey: { tag: 'schnorr', value: '05'.repeat(32) } },
};

const anOffer = (address = DEES_ADDRESS) => {
  const token = newInvitationToken();
  const coinKey = String(ZswapSecretKeys.fromSeed(dee.moneyAt(0).zswap).coinPublicKey).toLowerCase() as Hex;
  const salt = toHex(new Uint8Array(randomBytes(32))) as Hex;
  const scope = MidnightCommitments.allVaults().toLowerCase() as Hex;
  const invite = { address: MidnightCommitments.inviteAddressOf(coinKey, salt).toLowerCase() as Hex, salt, scope };
  const proposal = '77'.repeat(32) as Hex;
  const proposalSalt = '88'.repeat(32) as Hex;
  const invited = signSeatInvitation({ company: COMPANY, invitation: invitationIdOf(token), person: 'adr_00000000000000000000', name: 'dee', role: 'approver', invite, proposal }, INVITER_SECRET);
  const offer: InvitationOffer = {
    company: COMPANY, companyName: 'Acme', label: LABEL, account: ACCOUNT as never, inboxPublicKey: inboxPublicKey(KEY, COMPANY),
    expiresAt: Date.now() + 3_600_000, madeAt: utcMomentOf(Date.now()), inviter: inviter as never,
    for: { kind: 'signer', name: 'dee', role: 'approver', seat: { nonce: '9a'.repeat(32) as Hex, secret: '9b'.repeat(32) as Hex }, invited, byAddress: { address, proposalSalt } },
  } as InvitationOffer;
  return { token, sealed: sealOffer(signOffer(offer, INVITER_SECRET), token), invite, proposal, proposalSalt, coinKey };
};

const run = async (o: ReturnType<typeof anOffer>, chain: { seats?: string[]; took?: string | null } = {}) => {
  const relayed: Array<Record<string, unknown>> = [];
  const asked: Array<Record<string, unknown>> = [];
  const built: InvitedSeatOnTheWire[] = [];
  let kept: any = null;
  const reach = {
    network: NET,
    commitments: async () => MidnightCommitments as never,
    chain: () => ({
      holders: async () => ({ seats: chain.seats ?? [] }) as never,
      callState: async () => ({ blockHash: '00', accountState: 'AA==', parameters: 'BB==' }),
      indexer: { indexerUri: 'https://i.example', indexerWsUri: 'wss://i.example' },
    }),
    builder: () => ({
      invitedSeats: async () => ({ [o.proposal]: chain.took ?? null }),
      seatInvited: async (input: InvitedSeatOnTheWire) => { built.push(input); return 'VFg='; },
    }) as never,
  };
  const ctx = {
    intent: { name: 'seat-invited', fields: { company: LABEL, account: ACCOUNT, record: COMPANY, token: o.token } } as unknown as ActIntent,
    asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'dee',
    held: { identity: dee, secret: newSecret(), account: 0 }, at: { step: 1, steps: 2 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a seat is relayed through its invitation'); },
    call: async (method: string, path: string, body?: string) => {
      if (method === 'GET') return { status: 200, body: { offer: o.sealed, kind: 'signer', expiresAt: new Date(Date.now() + 1e6).toISOString() } };
      if (path.endsWith('/seat')) { relayed.push(JSON.parse(body!)); return { status: 200, body: { sent: true } }; }
      asked.push(JSON.parse(body!));
      return { status: 201, body: { id: 'sgn_dee' } };
    },
    tell: () => {},
    keyring: { open: () => ({ read: () => ({ accounts: {} }) }), keep: async (f: (k: any) => any) => { kept = f({ accounts: {} }); } },
  } as unknown as StepContext;
  const action = seatInvitedAction(reach as never);
  for (const s of action.steps(ctx.intent)) await s.run(ctx);
  return { relayed, asked, built, kept };
};

describe('a seat invited by address is taken in the wallet, by the wallet that holds the address', () => {
  it('the wallet hands the seat builder its own seat\'s keys and the address\'s coin key, relays what the builder returns through the invitation, and asks to be admitted', async () => {
    const o = anOffer();
    const { relayed, asked, built, kept } = await run(o);
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
    expect(kept.accounts[COMPANY]).toMatchObject({ signerId: 'sgn_dee', signingSecret: toHex(own.signingSecret), scope: o.invite.scope });
  });

  it('RED WHEN: the wallet takes a seat offered to an address it does not hold', async () => {
    const other = addressFor(identityFromSecret(newSecret()).moneyAt(0).zswap, NET).bech32;
    await expect(run(anOffer(other))).rejects.toMatchObject({ words: { key: 'act.seat-invited.why.not-held' } });
  });

  it('a step taken up again does not take the seat twice, and refuses a seat the history shows another took', async () => {
    const o = anOffer();
    const scope = o.invite.scope;
    const keys = seatKeysFor(dee, LABEL, 0);
    const walletKey = { tag: 'schnorr' as const, value: String(committeeKeyFor(dee, LABEL).value).toLowerCase() };
    const { seatBlinding } = await import('../../../../src/core/seat-opening.js');
    const { storedSignerLeaf } = await import('../../../../src/core/signer-leaf.js');
    const leaf = storedSignerLeaf({ signingSecret: toHex(keys.signingSecret) as Hex, blinding: seatBlinding(walletKey, toHex(keys.salt)) as Hex, scope }, MidnightCommitments).toLowerCase();
    const again = await run(o, { seats: [leaf], took: leaf });
    expect(again.built).toEqual([]);
    expect(again.relayed).toEqual([]);
    const err = await run(anOffer(), { took: '5a'.repeat(32) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepRefused);
  });

  it('RED WHEN: a seat already held on the account is taken again instead of the next free one', async () => {
    const o = anOffer();
    const keys0 = seatKeysFor(dee, LABEL, 0);
    const walletKey = { tag: 'schnorr' as const, value: String(committeeKeyFor(dee, LABEL).value).toLowerCase() };
    const { seatBlinding } = await import('../../../../src/core/seat-opening.js');
    const { storedSignerLeaf } = await import('../../../../src/core/signer-leaf.js');
    const leaf0 = storedSignerLeaf({ signingSecret: toHex(keys0.signingSecret) as Hex, blinding: seatBlinding(walletKey, toHex(keys0.salt)) as Hex, scope: o.invite.scope }, MidnightCommitments).toLowerCase();
    const { built } = await run(o, { seats: [leaf0] });
    expect(built[0]!.material.signingSecret).toBe(toHex(seatKeysFor(dee, LABEL, 1).signingSecret));
  });
});
