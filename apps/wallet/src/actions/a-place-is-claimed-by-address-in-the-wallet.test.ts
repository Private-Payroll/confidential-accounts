import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { readClaimedHandover } from 'midnight-identity/profile/address-claim';
import { unshieldedClaimRefusal } from 'midnight-identity/profile/address-claim-signed';
import { readJoinCode, writeJoinCode, type JoinCode } from 'midnight-identity/profile/join-code';
import { signDirectoryEntry } from 'midnight-identity/profile/records-key';
import type { ActIntent } from 'midnight-identity/profile/request';
import { signingPublicKeyOf, toHex, type Hex } from '../../../../src/core/crypto.js';
import {
  acceptanceProofOf, invitationIdOf, newInvitationToken, sealOffer, signOffer, utcMomentOf, type InvitationOffer,
} from '../../../../src/core/invitation.js';
import { inboxPublicKey, openFromInbox } from '../../../../src/core/sealed-records.js';
import { addressFor } from 'midnight-identity';
import { signatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import { addressOfVerifyingKey } from 'midnight-identity/profile/disclosure';
import { claimByAddressAction, heldAt } from './claim-by-address.js';
import type { StepContext } from './definition.js';

/* A person added by an unshielded address claims their place from their own wallet: the wallet opens the offer the
 * inviter signed with the link's token, takes the record and the company's inbox key from it, goes on only for an
 * address it holds, signs a claim of it with that address's key and its payee's code, and hands the company nothing
 * but the two sealed to the inbox key the offer names. A shielded address has no claim. */

const NET = 'undeployed' as const;
const secret = newSecret();
const identity = identityFromSecret(secret);
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const COMPANY_KEY = '11'.repeat(32) as Hex;
const COMPANY_ID = 'acc_1';
const INBOX = inboxPublicKey(COMPANY_KEY, COMPANY_ID);
const PERSON = 'emp_0123456789abcdef0123';
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;

const unshieldedAddressFor = (who: typeof identity, account: number): string => addressOfVerifyingKey(
  signatureVerifyingKey({ tag: 'schnorr', value: Buffer.from(who.moneyAt(account).night).toString('hex') }).value, NET);
const OURS = unshieldedAddressFor(identity, 0);

/* The inviting seat: a wallet's signed entry for the company and its filing key. */
const inviterWallet = identityFromSecret(new Uint8Array(32).fill(9));
const INVITER_SECRET = toHex(new Uint8Array(randomBytes(32))) as Hex;
const inviter = {
  committeeKey: committeeKeyFor(inviterWallet, LABEL) as never,
  statement: signDirectoryEntry(inviterWallet, LABEL, ACCOUNT as never, new Uint8Array(32).fill(3), signingPublicKeyOf(INVITER_SECRET), 'ab'.repeat(32)),
  opening: { publicKey: '01'.repeat(32), scope: '02'.repeat(32), blinding: '03'.repeat(32), salt: '04'.repeat(32), walletKey: { tag: 'schnorr', value: '05'.repeat(32) } },
};

const anOffer = (over: { address?: string; inbox?: Hex } = {}) => {
  const token = newInvitationToken();
  const forWhom = {
    kind: 'employee', person: PERSON, name: 'Payee', title: 'Engineer', email: null, asset: 'night', baseAmount: 500000n,
    startDate: '2026-10-01', classification: 'full-time', address: over.address ?? OURS,
  };
  const offer = {
    company: COMPANY_ID, companyName: 'Acme', label: LABEL, account: ACCOUNT as never, inboxPublicKey: over.inbox ?? INBOX,
    expiresAt: Date.now() + 3_600_000, madeAt: utcMomentOf(Date.now()), inviter: inviter as never, for: forWhom,
  } as unknown as InvitationOffer;
  const signed = signOffer(offer, INVITER_SECRET);
  return { token, signed, sealed: sealOffer(signed, token) };
};

const intent = (o: ReturnType<typeof anOffer>, fields: Record<string, string> = {}): ActIntent => ({
  name: 'claim-by-address',
  fields: { company: LABEL, account: ACCOUNT, record: COMPANY_ID, token: o.token, address: OURS, ...fields },
}) as ActIntent;

const run = async (o: ReturnType<typeof anOffer>, i: ActIntent = intent(o), status = 201) => {
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
  const asked: string[] = [];
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, secret, account: 0 }, at: { step: 1, steps: 1 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a claim sends no transaction'); },
    call: async (method: string, path: string, body?: string) => {
      asked.push(`${method} ${path}`);
      if (method === 'GET') return { status: 200, body: { offer: o.sealed, kind: 'employee', expiresAt: new Date(Date.now() + 1e6).toISOString() } };
      posted.push({ path, body: JSON.parse(body ?? '{}') });
      return { status, body: { error: 'taken already' } };
    },
    tell: () => {}, keyring: null,
  } as unknown as StepContext;
  const action = claimByAddressAction({ network: NET });
  for (const s of action.steps(i)) await s.run(ctx);
  return { posted, asked, action };
};

describe('a place is claimed by address in the wallet, from the offer it opens, and only for an unshielded address it holds', () => {
  it('an unshielded address the wallet holds is claimed: the code and the signed claim reach the inbox the offer names, for the record it names', async () => {
    const o = anOffer();
    const { posted, asked } = await run(o);
    const id = invitationIdOf(o.token);
    expect(asked).toEqual([`GET /api/invites/${id}/offer`, `POST /api/invites/${id}/accept-payee`]);
    const body = posted[0]!.body;
    expect(body).toMatchObject({ acceptance: acceptanceProofOf(o.token), kind: 'employee' });
    const opened = readClaimedHandover(openFromInbox(body.handover as never, COMPANY_ID, COMPANY_KEY));
    expect(opened).not.toBeNull();
    const code = readJoinCode(writeJoinCode(opened!.code as JoinCode), LABEL);
    expect(typeof code === 'object' ? code.person : null).toBe(PERSON);
    expect(typeof code === 'object' && code.parts.kind === 'payee' ? code.parts.address : null).toBe(OURS);
    const payslipKey = typeof code === 'object' && code.parts.kind === 'payee' ? code.parts.payslipKey : '';
    expect(unshieldedClaimRefusal(opened!.claim, { company: LABEL, person: PERSON, payslipKey, address: OURS, network: NET }, NET)).toBeNull();
    /* RED WHEN: anything of the address's key reaches the page beside the sealed hand-over. */
    expect(JSON.stringify(body)).not.toContain(Buffer.from(identity.moneyAt(0).night).toString('hex'));
  });

  it('RED WHEN: the hand-over is sealed to an inbox key or made for a record the inviter\'s signed offer does not name', async () => {
    /* The page names nothing it could redirect: the intent has no inbox and no person, and an offer whose inbox key was
     * changed after the seat signed it is not believed. */
    const o = anOffer();
    const forged = { ...o, sealed: sealOffer({ ...o.signed, offer: { ...o.signed.offer, inboxPublicKey: inboxPublicKey('22'.repeat(32) as Hex, COMPANY_ID) } }, o.token) };
    await expect(run(forged, intent(o))).rejects.toMatchObject({ words: { key: 'act.claim-by-address.why.no-offer' } });
    await expect(run(o, intent(o, { record: 'acc_2' }))).rejects.toMatchObject({ words: { key: 'act.claim-by-address.why.another-company' } });
    const another = anOffer({ address: unshieldedAddressFor(identity, 2) });
    await expect(run(another, intent(another))).rejects.toMatchObject({ words: { key: 'act.claim-by-address.why.not-by-address' } });
  });

  it('RED WHEN: the wallet signs for an address it does not hold', async () => {
    const other = unshieldedAddressFor(identityFromSecret(newSecret()), 0);
    const o = anOffer({ address: other });
    const action = claimByAddressAction({ network: NET });
    expect((await action.check(intent(o, { address: other }), { identity, secret } as never))?.key).toBe('act.claim-by-address.why.not-held');
    await expect(run(o, intent(o, { address: other }))).rejects.toMatchObject({ words: { key: 'act.claim-by-address.why.not-held' } });
  });

  it('RED WHEN: a shielded address is claimed in the wallet instead of accepted with the fingerprint read out', async () => {
    const shielded = addressFor(identity.moneyAt(0).zswap, NET).bech32;
    expect(heldAt(identity, NET, shielded)).toEqual({ account: 0, kind: 'shielded' });
    const o = anOffer({ address: shielded });
    const action = claimByAddressAction({ network: NET });
    expect((await action.check(intent(o, { address: shielded }), { identity, secret } as never))?.key).toBe('act.claim-by-address.why.private');
    await expect(run(o, intent(o, { address: shielded }))).rejects.toMatchObject({ words: { key: 'act.claim-by-address.why.private' } });
  });

  it('RED WHEN: a claim the company did not take is reported as made', async () => {
    const o = anOffer();
    await expect(run(o, intent(o), 409)).rejects.toMatchObject({ words: { key: 'act.claim-by-address.why.not-taken', values: { says: 'taken already' } } });
  });

  it('refuses a page that names no invitation, and every word it says is written', async () => {
    const o = anOffer();
    const action = claimByAddressAction({ network: NET });
    expect((await action.check(intent(o, { token: 'x' }), { identity, secret } as never))?.key).toBe('act.claim-by-address.why.not-an-invitation');
    const keys = [action.headline, ...action.checks.map((c) => c.key), ...(await action.shown(intent(o))).map((l) => l.key),
      ...action.steps(intent(o)).map((s) => s.title.key),
      ...['not-a-company', 'not-a-payee', 'not-an-invitation', 'not-held', 'no-payslip-key', 'no-offer', 'expired', 'another-company',
        'not-by-address', 'private', 'not-signed', 'not-taken'].map((k) => `act.claim-by-address.why.${k}`)];
    for (const k of keys) expect(WORDS[k], k).toBeTypeOf('string');
  });
});
