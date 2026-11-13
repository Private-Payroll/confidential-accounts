/**
 * **A SUPER ADMIN WITH NO SEAT IS LET IN BY A REQUEST ITS COMMITTEE KEY SIGNED, AND BY NOTHING ELSE.**
 * The gate of the routes of a change of the committee, over real HTTP, with the ledger's own signatures: a request with
 * no super admin header is the member gate's; one with it passes only when its key signed this company and this person,
 * and that key holds the company's account on the chain or joins it in a change kept here. The chain read is a stand-in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import * as L from '@midnightntwrk/ledger-v9';
import type { AuthorityRead } from '../midnight/ledger.js';
import { SUPER_ADMIN_HEADER, superAdminHeaderFor, superAdminRequestBytes } from '../midnight/super-admin-request.js';
import { superAdminOrMember } from './super-admin-guard.js';

const CO = 'acc_super';
const ACCOUNT = 'c0'.repeat(32);
const holder = () => {
  const secret = L.sampleSigningKey();
  return { secret, key: L.signatureVerifyingKey(secret) };
};
const ADMIN = holder();
const JOINING = holder();
const STRANGER = holder();
/* The chain holds the company's account by ADMIN's key alone, at counter 4; a change kept at that counter adds JOINING. */
let chain: AuthorityRead = { state: 'read', address: ACCOUNT, authority: { committee: [ADMIN.key], threshold: 1, counter: 4n, shape: 'one-key', hasDuplicateMembers: false } };
const kept = new Map<string, { to: { committee: { tag: string; value: string }[] } }[]>([
  [`${ACCOUNT}:4`, [{ to: { committee: [ADMIN.key, JOINING.key] } }]],
]);
const headerOf = (who: ReturnType<typeof holder>, company = CO, user = 'sam', account = ACCOUNT) =>
  superAdminHeaderFor({ key: who.key, signature: L.signData(who.secret, superAdminRequestBytes(company, user, account)).value });

let base = '';
let server: ReturnType<express.Express['listen']>;
beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => { const p = req.headers['x-test-person']; if (typeof p === 'string') req.userId = p; next(); });
  const member: express.RequestHandler = (req, res, next) => (req.userId === 'ada' ? next() : res.status(404).json({ error: 'account not found' }));
  const gate = superAdminOrMember({
    member, accountExists: (id) => id === CO, companyAddress: async () => ACCOUNT, authorityOf: async () => chain,
    changesKept: (_id, address, counter) => kept.get(`${address}:${counter}`) ?? [],
  });
  app.get('/api/accounts/:id/committee-change', gate, (_req, res) => { res.json({ in: true }); });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
const asks = (person: string, header?: string, company = CO) => fetch(`${base}/api/accounts/${company}/committee-change`, {
  headers: { 'x-test-person': person, ...(header === undefined ? {} : { [SUPER_ADMIN_HEADER]: header }) },
}).then(async (r) => ({ status: r.status, body: await r.json() as Record<string, unknown> }));

describe('THE ROUTES OF A CHANGE OF THE COMMITTEE, FOR A SUPER ADMIN WITH NO SEAT', () => {
  it('a request with no super admin header is judged as a member\'s', async () => {
    expect((await asks('ada')).status).toBe(200);
    /* RED WHEN: a person who is neither a member nor a signed super admin is let in. */
    expect((await asks('sam')).status).toBe(404);
  });

  it('a key on the committee holding the account on the chain is let in, for the person and company it signed', async () => {
    /* RED WHEN: a super admin with no seat is refused, so the committee cannot change who holds the contracts from the page. */
    expect(await asks('sam', headerOf(ADMIN))).toEqual({ status: 200, body: { in: true } });
    /* RED WHEN: a signed request is let in for a person it was not signed for, so a request seen once lets anyone in. */
    expect(await asks('eve', headerOf(ADMIN))).toMatchObject({ status: 403, body: { refused: 'not-signed' } });
    expect(await asks('sam', headerOf(ADMIN, 'acc_other'))).toMatchObject({ status: 403, body: { refused: 'not-signed' } });
    /* RED WHEN: a request signed for another account, whose label the wallet checked, is let in for this company's. */
    expect(await asks('sam', headerOf(ADMIN, CO, 'sam', 'c1'.repeat(32)))).toMatchObject({ status: 403, body: { refused: 'not-signed' } });
  });

  it('a key off the committee is refused, unless a change kept at the account\'s counter names it joining', async () => {
    /* RED WHEN: any key that signs its own request is let in, whatever the chain shows holding the account. */
    expect(await asks('sam', headerOf(STRANGER))).toMatchObject({ status: 403, body: { refused: 'not-a-super-admin', nothingWasSent: true } });
    /* RED WHEN: a key joining in a kept change cannot read or send the change it must sign. */
    expect((await asks('sam', headerOf(JOINING))).status).toBe(200);
    /* RED WHEN: a change kept at a counter the chain has moved past still lets its joining keys in. */
    chain = { state: 'read', address: ACCOUNT, authority: { committee: [ADMIN.key], threshold: 1, counter: 5n, shape: 'one-key', hasDuplicateMembers: false } };
    expect((await asks('sam', headerOf(JOINING))).status).toBe(403);
    expect((await asks('sam', headerOf(ADMIN))).status).toBe(200);
  });

  it('a header in no shape the service reads, or a chain it cannot read, lets nobody in', async () => {
    expect(await asks('sam', '{"key":1}')).toMatchObject({ status: 400, body: { refused: 'not-a-request' } });
    expect((await asks('sam', headerOf(ADMIN), 'acc_none')).status).toBe(404);
    chain = { state: 'unreachable', address: ACCOUNT, why: 'the indexer did not answer' };
    /* RED WHEN: a chain read that failed is taken as the committee, and a key is let in on it. */
    expect(await asks('sam', headerOf(ADMIN))).toMatchObject({ status: 503, body: { refused: 'chain-unread' } });
  });
});
