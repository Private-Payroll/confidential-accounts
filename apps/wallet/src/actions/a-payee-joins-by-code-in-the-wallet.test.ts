import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { payeeCodeFingerprint } from 'midnight-identity/profile/fingerprint';
import { readJoinCode, writeJoinCode, type JoinCode } from 'midnight-identity/profile/join-code';
import { signDirectoryEntry } from 'midnight-identity/profile/records-key';
import type { ActIntent, JoinCodeRequest } from 'midnight-identity/profile/request';
import { addressOfVerifyingKey } from 'midnight-identity/profile/disclosure';
import { addressFor } from 'midnight-identity';
import { signatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import { signingPublicKeyOf, toHex, type Hex } from '../../../../src/core/crypto.js';
import {
  acceptanceProofOf, invitationIdOf, newInvitationToken, sealOffer, signOffer, utcMomentOf, type InvitationOffer,
} from '../../../../src/core/invitation.js';
import { inboxPublicKey, openFromInbox } from '../../../../src/core/sealed-records.js';
import type { Keyring } from '../../../../packages/web-shared/src/keyring-blob.js';
import { payslipKeyOfThisWallet } from '../screens/join-code-payslip-key.js';
import { joinByCodeAction } from './join-by-code.js';
import type { StepContext, Words } from './definition.js';

/* A person or vendor invited by link, or by a private address, joins from their own wallet: the wallet opens the offer
 * the inviter signed with the link's token, is paid at the private address the inviter typed only if it holds it, or
 * else at its own, signs its payee's code, lists the company among those that pay the person before it hands anything
 * over, and hands the company only the code sealed to the inbox key the offer names. The fingerprint is for the
 * wallet's window alone. */

const NET = 'undeployed' as const;
const secret = newSecret();
const identity = identityFromSecret(secret);
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const COMPANY_KEY = '11'.repeat(32) as Hex;
const COMPANY_ID = 'acc_1';
const INBOX = inboxPublicKey(COMPANY_KEY, COMPANY_ID);
const EMPLOYEE = 'emp_0123456789abcdef0123';
const VENDOR = 'ven_0123456789abcdef0123';
const ASKER = { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' };
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;

const shieldedOf = (who: typeof identity, account: number): string => addressFor(who.moneyAt(account).zswap, NET).bech32;
const OWN = shieldedOf(identity, 0);
const PAYSLIP_KEY = payslipKeyOfThisWallet(identity, { company: LABEL, requester: ASKER } as unknown as JoinCodeRequest);

const inviterWallet = identityFromSecret(new Uint8Array(32).fill(9));
const INVITER_SECRET = toHex(new Uint8Array(randomBytes(32))) as Hex;
/* The same seat's entry signed for the company `label` and `account` name, so an offer made for another company still opens as signed. */
const inviterFor = (label: string, account: string) => ({
  committeeKey: committeeKeyFor(inviterWallet, label as never) as never,
  statement: signDirectoryEntry(inviterWallet, label as never, account as never, new Uint8Array(32).fill(3), signingPublicKeyOf(INVITER_SECRET), 'ab'.repeat(32)),
  opening: { publicKey: '01'.repeat(32), scope: '02'.repeat(32), blinding: '03'.repeat(32), salt: '04'.repeat(32), walletKey: { tag: 'schnorr', value: '05'.repeat(32) } },
});

/* `label`, `account` and `expiresAt` vary what the offer says about the company it is for, which the link the person pressed must agree with. */
const anOffer = (over: { kind?: 'employee' | 'vendor' | 'super-admin'; address?: string; label?: string; account?: string; expiresAt?: number } = {}) => {
  const token = newInvitationToken();
  const kind = over.kind ?? 'employee';
  const at = over.address === undefined ? {} : { address: over.address };
  const forWhom = kind === 'vendor'
    ? { kind, person: VENDOR, name: 'Acme Supplies', email: null, startDate: '2026-10-01', ...at }
    : kind === 'super-admin'
      ? { kind, name: 'Root' }
      : {
        kind, person: EMPLOYEE, name: 'Payee', title: 'Engineer', email: null, asset: 'night', baseAmount: 500000n,
        startDate: '2026-10-01', classification: 'full-time', ...at,
      };
  const offer = {
    company: COMPANY_ID, companyName: 'Acme', label: over.label ?? LABEL, account: (over.account ?? ACCOUNT) as never, inboxPublicKey: INBOX,
    expiresAt: over.expiresAt ?? Date.now() + 3_600_000, madeAt: utcMomentOf(Date.now()), inviter: inviterFor(over.label ?? LABEL, over.account ?? ACCOUNT) as never, for: forWhom,
  } as unknown as InvitationOffer;
  return { token, sealed: sealOffer(signOffer(offer, INVITER_SECRET), token), kind };
};

const intent = (o: ReturnType<typeof anOffer>, fields: Record<string, string> = {}): ActIntent => ({
  name: 'join-by-code', fields: { company: LABEL, account: ACCOUNT, record: COMPANY_ID, token: o.token, ...fields },
}) as ActIntent;

interface Ran {
  readonly order: string[];
  readonly posted: Array<Record<string, unknown>>;
  readonly shown: Words[];
  readonly told: unknown[];
  readonly saved: () => Keyring;
}

const run = async (
  o: ReturnType<typeof anOffer>,
  opts: { intent?: ActIntent; post?: number | 'lost'; offer?: { status: number; body: unknown }; keyring?: Keyring | null; account?: number } = {},
): Promise<Ran> => {
  const order: string[] = [];
  const posted: Array<Record<string, unknown>> = [];
  const shown: Words[] = [];
  const told: unknown[] = [];
  let held: Keyring = opts.keyring ?? { accounts: {} };
  const i = opts.intent ?? intent(o);
  const ctx = {
    intent: i, asker: ASKER, person: 'usr_a',
    held: { identity, secret, ...(opts.account === undefined ? {} : { account: opts.account }) }, at: { step: 1, steps: 1 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a join sends no transaction'); },
    call: async (method: string, path: string, body?: string) => {
      order.push(`${method} ${path}`);
      if (method === 'GET') return opts.offer ?? { status: 200, body: { offer: o.sealed, kind: o.kind, expiresAt: new Date(Date.now() + 1e6).toISOString() } };
      posted.push(JSON.parse(body ?? '{}') as Record<string, unknown>);
      if (opts.post === 'lost') throw new Error('the page did not answer, and the call may have landed');
      return { status: opts.post ?? 201, body: { error: 'taken already' } };
    },
    tell: (x: unknown) => { told.push(x); },
    show: (w: Words) => { shown.push(w); order.push('shown'); },
    keyring: opts.keyring === null ? null : {
      open: () => ({ read: () => structuredClone(held) }),
      keep: async (change: (k: Keyring) => Keyring) => { held = change(held); order.push('kept'); },
    },
  } as unknown as StepContext;
  const action = joinByCodeAction({ network: NET });
  try {
    for (const s of action.steps(i)) await s.run(ctx);
  } catch (e) {
    throw Object.assign(e as object, { ran: { order, posted, shown, told, saved: () => held } });
  }
  return { order, posted, shown, told, saved: () => held };
};
const refusedWith = async (p: Promise<unknown>, key: string): Promise<Ran & { readonly said: Words['values'] }> => {
  try { await p; } catch (e) {
    expect((e as { words?: Words }).words?.key).toBe(`act.join-by-code.why.${key}`);
    return { ...(e as { ran: Ran }).ran, said: (e as { words: Words }).words.values };
  }
  throw new Error(`expected the join to be refused with ${key}`);
};

const USED = { status: 410, body: { refused: 'used', error: 'this invitation has already been accepted' } };

const codeIn = (body: Record<string, unknown>): JoinCode => {
  const opened = openFromInbox(body['handover'] as never, COMPANY_ID, COMPANY_KEY) as unknown as JoinCode;
  const read = readJoinCode(writeJoinCode(opened), LABEL);
  if (typeof read !== 'object') throw new Error(`the handed-over code does not read as one: ${read}`);
  return read;
};

describe('a payee joins by link or by a private address in the wallet, listed before the hand-over and read out from the wallet', () => {
  it('by link: the wallet is paid at its own private address, and the signed code reaches only the inbox the offer names', async () => {
    const o = anOffer();
    const ran = await run(o);
    const id = invitationIdOf(o.token);
    /* RED WHEN: the company is listed after the code is handed over, or the fingerprint is shown before it is taken. */
    expect(ran.order).toEqual([`GET /api/invites/${id}/offer`, 'kept', `POST /api/invites/${id}/accept-payee`, 'shown']);
    expect(ran.posted[0]).toMatchObject({ acceptance: acceptanceProofOf(o.token), kind: 'employee' });
    const code = codeIn(ran.posted[0]!);
    expect(code.person).toBe(EMPLOYEE);
    /* RED WHEN: the code names an address this wallet does not hold, or a payslip key other than its own for this company. */
    expect(code.parts).toEqual({ kind: 'payee', address: OWN, payslipKey: PAYSLIP_KEY });
    /* RED WHEN: the code is not signed by this wallet's key for the company, which the inviter's fingerprint is made from. */
    expect(code.committeeKey.value).toBe(committeeKeyFor(identity, LABEL).value);
    /* RED WHEN: the company is not listed among those that pay this person, or the join is not kept with the address
     * its code names, so a join whose answer was lost could not show its fingerprint again. */
    expect(ran.saved().paidBy).toEqual([LABEL]);
    expect(ran.saved().payeeJoinsKept).toEqual({ [id]: { company: LABEL, address: OWN } });
    /* RED WHEN: the fingerprint shown in the window is not the one the inviter works out from the code handed over, or
     * the window does not say the address the person is paid at. */
    expect(ran.shown).toEqual([{ key: 'act.join-by-code.over.fingerprint', values: { fingerprint: payeeCodeFingerprint(code as never), address: OWN } }]);
    /* RED WHEN: the fingerprint, the address or the payslip key reaches the page outside the sealed hand-over. */
    expect(ran.told).toEqual([]);
    const sent = JSON.stringify(ran.posted);
    for (const clear of [OWN, PAYSLIP_KEY, EMPLOYEE, payeeCodeFingerprint(code as never)]) expect(sent).not.toContain(clear);
  });

  it('by link from another account chosen in the window, the wallet is paid at that account\'s private address', async () => {
    const ran = await run(anOffer(), { account: 2 });
    /* RED WHEN: the account the person chose in the window is not the one they are paid at. */
    expect((codeIn(ran.posted[0]!).parts as { address: string }).address).toBe(shieldedOf(identity, 2));
  });

  it('by a private address typed for an employee or a vendor: the wallet is paid there only when it holds it', async () => {
    const typed = shieldedOf(identity, 3);
    for (const kind of ['employee', 'vendor'] as const) {
      const ran = await run(anOffer({ kind, address: typed }));
      /* RED WHEN: a typed private address the wallet holds is not the one the code names, for an employee or a vendor. */
      expect((codeIn(ran.posted[0]!).parts as { address: string }).address).toBe(typed);
      expect(ran.posted[0]).toMatchObject({ kind });
      const other = shieldedOf(identityFromSecret(newSecret()), 0);
      const refused = await refusedWith(run(anOffer({ kind, address: other })), 'not-held');
      /* RED WHEN: a vendor or employee invited at a private address this wallet does not hold is joined at another one,
       * or anything is listed or handed over for it. */
      expect(refused.order).not.toContain('kept');
      expect(refused.posted).toEqual([]);
      expect(refused.saved().paidBy).toBeUndefined();
    }
  });

  it('refuses an invitation made by a public address, which is claimed with that address\'s own signature', async () => {
    const pub = addressOfVerifyingKey(
      signatureVerifyingKey({ tag: 'schnorr', value: Buffer.from(identity.moneyAt(0).night).toString('hex') }).value, NET);
    const ran = await refusedWith(run(anOffer({ address: pub })), 'by-public-address');
    /* RED WHEN: an invitation by a public address is joined with a code and a fingerprint instead of a signed claim. */
    expect(ran.posted).toEqual([]);
  });

  it('refuses before anything is opened when the page handed no saved keys to list the company in', async () => {
    const ran = await refusedWith(run(anOffer(), { keyring: null }), 'no-saved-keys');
    /* RED WHEN: a join runs on, and could be handed over, with nowhere to list the company that pays the person. */
    expect(ran.order).toEqual([]);
  });

  it('taken up again after the hand-over, it hands nothing over twice and the company stays listed', async () => {
    const before: Keyring = { accounts: {}, paidBy: [LABEL] };
    const ran = await refusedWith(run(anOffer(), { keyring: before, offer: USED }), 'used');
    /* RED WHEN: a join taken up again hands its code over a second time, or takes the company off the list. */
    expect(ran.posted).toEqual([]);
    expect(ran.saved().paidBy).toEqual([LABEL]);
    /* RED WHEN: a used invitation this wallet kept no join of is given a fingerprint, for a code it may not have made. */
    expect(ran.said).toBeUndefined();
    const o = anOffer();
    const listed: Keyring = { accounts: {}, paidBy: [LABEL], payeeJoinsKept: { [invitationIdOf(o.token)]: { company: LABEL, address: OWN } } };
    const again = await run(o, { keyring: listed });
    /* RED WHEN: a company already listed, with this join kept, is kept again, or listed twice. */
    expect(again.order).not.toContain('kept');
    expect(again.saved().paidBy).toEqual([LABEL]);
  });

  it('a join whose answer was lost shows the same fingerprint when taken up again, whichever account is chosen', async () => {
    const o = anOffer();
    const first = await run(o, { post: 'lost' }).then(() => null, (e: { ran: Ran }) => e.ran);
    expect(first).not.toBeNull();
    const code = codeIn(first!.posted[0]!);
    const kept = first!.saved();
    /* RED WHEN: a join that may have been handed over is retried and refused as used with no fingerprint to read out,
     * or with one that is not the fingerprint of the code handed over, or with another address after another account
     * is chosen in the window. */
    for (const account of [undefined, 2]) {
      const again = await refusedWith(run(o, { keyring: kept, offer: USED, ...(account === undefined ? {} : { account }) }), 'used-by-this-wallet');
      expect(again.said).toEqual({ fingerprint: payeeCodeFingerprint(code as never), address: OWN });
      expect(again.posted).toEqual([]);
    }
    /* RED WHEN: a join retried before its code landed makes a code for another address than the one kept. */
    const retried = await run(o, { keyring: kept, account: 2 });
    expect((codeIn(retried.posted[0]!).parts as { address: string }).address).toBe(OWN);
    expect(retried.order).not.toContain('kept');
    /* RED WHEN: a join kept for one invitation lends its fingerprint to another invitation that is used. */
    expect((await refusedWith(run(anOffer(), { keyring: kept, offer: USED }), 'used')).said).toBeUndefined();
  });

  it('a code the company did not take is not reported as joined, and the company listed stays listed', async () => {
    const ran = await refusedWith(run(anOffer(), { post: 409 }), 'not-taken');
    /* RED WHEN: a refused hand-over is shown as joined, with the fingerprint given as the one to read out. */
    expect(ran.shown).toEqual([]);
    expect(ran.saved().paidBy).toEqual([LABEL]);
    /* RED WHEN: a hand-over the service may have kept while refusing it says no fingerprint, or another code's. */
    expect(ran.said).toMatchObject({ fingerprint: payeeCodeFingerprint(codeIn(ran.posted[0]!) as never), address: OWN });
  });

  it('refuses an offer for another company or record, one offering no pay, and one that does not open with the token', async () => {
    const o = anOffer();
    /* RED WHEN: the page can point the join at another record than the inviter's signed offer names. */
    expect((await refusedWith(run(o, { intent: intent(o, { record: 'acc_2' }) }), 'another-company')).posted).toEqual([]);
    expect((await refusedWith(run(anOffer({ kind: 'super-admin' })), 'not-a-payee')).posted).toEqual([]);
    const other = anOffer();
    expect((await refusedWith(run(o, { offer: { status: 200, body: { offer: other.sealed } } }), 'no-offer')).posted).toEqual([]);
  });

  it('refuses an offer made under another label or account than the link names, or one that has expired, and hands nothing over', async () => {
    /* RED WHEN: the wallet signs a code for a company whose label or account is not the one the person was shown. */
    for (const made of [{ label: drawCompanyLabel() }, { account: 'd0'.repeat(32) }]) {
      const ran = await refusedWith(run(anOffer(made)), 'another-company');
      expect(ran.posted).toEqual([]);
      expect(ran.saved().paidBy).toBeUndefined();
    }
    /* RED WHEN: an offer past its time is joined, and the person is paid by a company that stopped waiting for them. */
    const expired = await refusedWith(run(anOffer({ expiresAt: Date.now() - 1_000 })), 'expired');
    expect(expired.posted).toEqual([]);
    expect(expired.saved().paidBy).toBeUndefined();
  });

  it('a join kept for another company under the same invitation is not taken for this company\'s', async () => {
    const o = anOffer();
    const id = invitationIdOf(o.token);
    const elsewhere: Keyring = { accounts: {}, payeeJoinsKept: { [id]: { company: drawCompanyLabel(), address: shieldedOf(identity, 3) } } };
    /* RED WHEN: another company's kept join lends its address and its fingerprint to this company's used invitation. */
    expect((await refusedWith(run(o, { keyring: elsewhere, offer: USED }), 'used')).said).toBeUndefined();
  });

  it('refuses a page that names no invitation, and every word it says is written', async () => {
    const o = anOffer();
    const action = joinByCodeAction({ network: NET });
    expect((await action.check(intent(o, { token: 'x' }), { identity, secret } as never))?.key).toBe('act.join-by-code.why.not-an-invitation');
    expect((await action.check(intent(o), { identity, secret } as never))).toBeNull();
    const keys = [action.headline, ...action.checks.map((c) => c.key), ...(await action.shown(intent(o))).map((l) => l.key),
      ...action.steps(intent(o)).map((s) => s.title.key), 'act.join-by-code.over.fingerprint',
      ...['not-a-company', 'not-an-invitation', 'no-saved-keys', 'no-offer', 'used', 'expired', 'another-company', 'not-a-payee',
        'by-public-address', 'not-held', 'no-address', 'no-payslip-key', 'not-signed', 'not-taken', 'used-by-this-wallet'].map((k) => `act.join-by-code.why.${k}`)];
    for (const k of keys) expect(WORDS[k], k).toBeTypeOf('string');
    /* RED WHEN: the window says the invitation is the company's, which nothing the wallet reads proves, rather than
     * that the person who invited them checks the fingerprint. */
    expect(WORDS['act.join-by-code.check.offer']).not.toMatch(/is this company's/u);
    expect(WORDS['act.join-by-code.check.offer']).toMatch(/fingerprint/u);
  });
});
