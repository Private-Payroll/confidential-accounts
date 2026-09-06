/**
 * **THE ROUND THAT LETS SOMEBODY BE HIRED, TESTED AT THE DOORS IT OPENS.**
 * `docs/NEXT.md` `X11` §1, §6 and §7,
 * `docs/how-money-can-be-lost.md` `C160`.
 *
 * ── WHY OVER REAL HTTP ───────────────────────────────────────────────────
 *
 * Everything here is about what arrives in a REQUEST and what leaves in a
 * RESPONSE — a field refused by name, a token that must not come back, a status
 * code with a header on it. `server.test.ts` has the argument in full and it is
 * this project's own history: **the two leaks that actually shipped were both
 * in a route**, and a mock request object gets middleware order, body parsing
 * and status codes right by definition.
 *
 * `scripts/mutate-invitations.mjs` breaks each of these on purpose and names
 * the test that has to die.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { newWrappingKeypair } from '../core/crypto.js';
import { sealHandover } from '../core/invite-handover.js';
import { addressFingerprint } from 'midnight-identity/profile/fingerprint';
import { payeeFor } from '../testing/payees.js';
import { acceptedCodes } from '../web/accepted-address.js';
import { emptyShape, walletKeyOf } from '../core/store.js';
import { canonical } from '../core/crypto.js';
import { addressOfSlot, signInWithAWallet } from '../testing/wallet-session.js';
import type { User } from '../core/types.js';

process.env.ALLOW_SIMULATED_COMPANY_ADDRESS = '1';
process.env.ALLOW_MEMORY_SESSIONS = '1';
process.env.DATABASE_URL = '';
process.env.SERVE = '0';
process.env.APP_ORIGIN = 'https://payroll.example';
const DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-invitations-')), 'db.json');
process.env.DATA_PATH = DATA_PATH;

const ORIGIN = 'https://payroll.example';
const { networkOfThePair } = await import('../midnight/network.js');
const NETWORK = networkOfThePair(process.env.MIDNIGHT_NETWORK_ID);

/**
 * **WHY THESE PEOPLE ARE SEEDED WITH AN EMAIL, AND WHY IT NO LONGER DECIDES
 * ANYTHING.**
 *
 * ── WHAT THIS BLOCK USED TO BE FOR ───────────────────────────────────────
 *
 * `admit`'s positive check was *is the redeemer the person the company said it
 * was hiring*, asked by comparing the redeemer's own sign-in email against the
 * one on the roster entry. So every test below needed an invitee whose SIGN-IN
 * carried an email — and `PI4b` had deleted `POST /api/auth/register`, the only
 * door in this product that ever put one on a person. A wallet sign-in creates
 * a row with `email: null`, deliberately (`docs/scope-payroll-identity.md` §10
 * step 1), and nothing else writes one. **So the flow had no reachable client
 * at all**, and the last block in this file pinned the refusal a real invitee
 * got.
 *
 * ── AND WHAT CHANGED IN `PI4c` ───────────────────────────────────────────
 *
 * **The comparison is gone**, because `C21` says it closes by deletion: the
 * operator types the email the invitation is addressed to and the check
 * compared against that same string, so an operator hiring somebody held both
 * sides of it. `X12`'s confirmation code replaced it — the invitee's wallet
 * shows a code for the address it discloses, and `admit` computes the same code
 * from the address that arrived. The last block in this file is now the
 * opposite claim: **a real invitee signing in with a wallet CAN be admitted.**
 *
 * ── SO WHY IS THE SEEDING STILL HERE ─────────────────────────────────────
 *
 * **`PI4c` removed a CHECK, not a FIELD.** An invitation is still ADDRESSED to
 * an email — the hire form takes one, the roster carries one, `raise` refuses a
 * spec without one, and the delivery port is keyed on it. That is `C21`'s other
 * half and it reaches the hire form, the roster and `C24`; it is not this
 * round's. These rows also give each test a distinct person, which the one
 * payable entry per person cap needs.
 *
 * ── HOW THE SEEDING WORKS, AND WHY IT IS NOT A FAKE SIGN-IN ──────────────
 *
 * The rows are written into the STORE FILE before the server is imported, and
 * each carries the `walletKey` of the slot that will sign in as it. **The
 * sign-in itself is completely real** — real wallet bytes, real nonce, real
 * origin — and resolves to the seeded row because that is what
 * `getUserByWalletKey` is for. Nothing here fabricates a session or a
 * credential; one field on one row is ahead of the product.
 */
const FIRST_SLOT = 60;
const PEOPLE = 24;
const seeded: Array<{ slot: number; email: string }> = [];
{
  const users: Record<string, User> = {};
  for (let i = 0; i < PEOPLE; i++) {
    const slot = FIRST_SLOT + i;
    const email = `invitee${i}@acme.co`;
    seeded.push({ slot, email });
    users['usr_seeded_' + i] = {
      id: 'usr_seeded_' + i,
      email,
      name: 'Seeded ' + i,
      keyBundle: null,
      keyBundleVersion: 0,
      walletKey: walletKeyOf(addressOfSlot(slot, NETWORK)),
      createdAt: '2026-08-25T00:00:00.000Z',
    };
  }
  const { writeFileSync } = await import('node:fs');
  writeFileSync(DATA_PATH, canonical({ ...emptyShape(), users }));
}

const { app } = await import('./index.js');

let server: Server;
let base: string;

beforeAll(async () => {
  server = await new Promise<Server>(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${a.port}`;
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

type Res = { status: number; body: any; headers: Headers };

const call = async (
  method: string, path: string, opts: { token?: string; body?: unknown } = {},
): Promise<Res> => {
  const r = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};

let n = -1;
/**
 * Signs somebody in, as one of the seeded people above.
 *
 * **THIS WAS `register` AND THE NAME WAS ALREADY WRONG BEFORE `PI4b`** — no
 * test here is about registering. What every one of them wants is *a person
 * with a session and an email*, and this is what still produces one.
 */
const register = async (_who: string) => {
  const person = seeded[++n];
  if (!person) throw new Error('the seeded pool is exhausted — raise PEOPLE');
  const { token } = await signInWithAWallet(call,
    { slot: person.slot, origin: ORIGIN, network: NETWORK });
  return { email: person.email, token };
};

const withACompany = async () => {
  const admin = await register('Ada');
  const made = await call('POST', '/api/accounts', {
    token: admin.token,
    body: { name: 'Acme', signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return {
    admin,
    accountId: made.body.account.id as string,
    viewingKey: made.body.viewingKey as string,
  };
};

/** Raises an employee invitation and hands back everything the round needs. */
const invite = async (
  c: { admin: { token: string }; accountId: string; viewingKey: string },
  email: string,
) => {
  const raised = await call('POST', `/api/accounts/${c.accountId}/people`, {
    token: c.admin.token,
    body: {
      name: 'Dana Ellis', email, title: 'Engineer',
      asset: 'GBP', salary: '5500.00', viewingKey: c.viewingKey,
    },
  });
  expect(raised.status, JSON.stringify(raised.body)).toBe(200);
  return { raw: raised.body.raw as string, employeeId: raised.body.employee.id as string };
};

describe('§1 — the link is produced once and is unreachable afterwards', () => {
  it('AN OPERATOR CANNOT REACH AN EMPLOYEE\'S TOKEN AFTER THE INVITATION IS MADE', async () => {
    /*
     * **THE WHOLE OF `X11`'s FIRST RULE, AS A NEGATIVE.** The operator-side
     * "open it as them" button was deleted on 17 Aug and must not come back —
     * **whoever opens an invitation sets the address the salary is paid to.**
     * The link comes back once, on the response to raising it, and after that
     * there is no route in this product that serves it to anybody.
     *
     * Every account-scoped listing an admin can reach is checked, not one, and
     * the raw token is searched for in the WHOLE serialised body rather than in
     * a field — a token that came back under a different name would pass a
     * field check and fail this one.
     */
    const c = await withACompany();
    const { raw, employeeId } = await invite(c, 'dana@example.com');
    expect(raw).toMatch(/^inv_/u);

    const everywhereAnAdminCanLook = [
      `/api/accounts/${c.accountId}/invites`,
      `/api/accounts/${c.accountId}/people?viewingKey=${c.viewingKey}`,
      `/api/accounts/${c.accountId}`,
      '/api/me',
      '/api/me/sessions',
    ];
    for (const path of everywhereAnAdminCanLook) {
      const seen = await call('GET', path, { token: c.admin.token });
      expect(seen.status, path).toBe(200);
      expect(JSON.stringify(seen.body), path).not.toContain(raw);
    }

    /*
     * And the listing does not serve the STORED value either, which is the
     * hash — useless for redeeming, and still the lookup key for every invite
     * on the account.
     */
    const invites = await call('GET', `/api/accounts/${c.accountId}/invites`,
      { token: c.admin.token });
    expect(JSON.stringify(invites.body)).not.toContain('"token"');
    expect(invites.body.some((i: any) => i.subjectId === employeeId)).toBe(true);
  });

  it('AND THE OFFER IS READABLE WITH THE LINK AND WITH NOTHING ELSE', async () => {
    const c = await withACompany();
    const { raw } = await invite(c, 'dana@example.com');

    /* No session at all: the person has no account yet, and seeing the offer
     * before accepting it is the whole reason this route exists. */
    const offer = await call('GET', `/api/invites/${raw}/offer`);
    expect(offer.status, JSON.stringify(offer.body)).toBe(200);
    expect(offer.body.company).toBe('Acme');
    expect(offer.body.title).toBe('Engineer');

    /* §0 — and it names the company by its address on the chain and carries the
     * inbox key, because without those an invitee cannot derive a payslip key
     * or seal anything. */
    expect(offer.body.companyAddress).toMatch(/^[0-9a-f]{64}$/u);
    expect(offer.body.inboxPublicKey).toMatch(/^[0-9a-f]{64}$/u);

    const guessed = await call('GET', '/api/invites/inv_not-a-real-token/offer');
    expect(guessed.status).toBe(400);
  });
});

describe('§7 — the browser seals and the route takes a blob it cannot open', () => {
  it('AN ADDRESS THAT ARRIVES IN THE CLEAR IS REFUSED BY NAME', async () => {
    /*
     * **THE ROUTE MUST LOSE THE ABILITY, NOT JUST THE HABIT.** `C160`,
     * `docs/scope-invitations.md` §5. This door took the receiving address as a
     * bech32 string and sealed it on our side, so the plaintext existed in our
     * process and in anything that ever logged a body.
     *
     * **REFUSED BY NAME AND NOT IGNORED**, because `zod` strips unknown keys —
     * so a client that still posts an address would otherwise be told
     * *"handover is required"* and whoever wrote it would be entitled to
     * believe the address had been read.
     *
     * `scripts/mutate-invitations.mjs` puts the plain address back at this
     * route and this is the test that dies.
     */
    const c = await withACompany();
    const dana = await register('Dana');
    const { raw } = await invite(c, dana.email);
    const wk = newWrappingKeypair();
    const address = payeeFor('d1'.repeat(32), NETWORK).bech32;

    /*
     * **EACH FIELD IS SENT ON ITS OWN, AND THE REFUSAL HAS TO NAME IT.**
     *
     * The first version of this sent both at once and **the mutation that takes
     * the address refusal out survived it**: the key refusal beside it answered
     * with the same code, so the test could not tell which field had been
     * refused or whether either had. A test that passes for the wrong reason is
     * the thing the harness exists to find, and it found this one.
     */
    const inTheClear = await call('POST', `/api/invites/${raw}/accept-employee`, {
      token: dana.token,
      body: { address },
    });
    expect(inTheClear.status, JSON.stringify(inTheClear.body)).toBe(400);
    expect(inTheClear.body.code).toBe('handover-in-the-clear');
    expect(inTheClear.body.error).toMatch(/receiving address/u);
    expect(inTheClear.body.error).toMatch(/sealed/u);

    /* And the payslip key is refused the same way and says so in its own
     * words, because a refusal that named the wrong field would be this route
     * telling a client something untrue about its own message. */
    const keyInTheClear = await call('POST', `/api/invites/${raw}/accept-employee`, {
      token: dana.token,
      body: { wrappingPublicKey: wk.publicKey },
    });
    expect(keyInTheClear.status).toBe(400);
    expect(keyInTheClear.body.code).toBe('handover-in-the-clear');
    expect(keyInTheClear.body.error).toMatch(/payslip key/u);

    /* The invitation is not spent by the refusal, so the honest attempt works. */
    const offer = await call('GET', `/api/invites/${raw}/offer`);
    expect(offer.status).toBe(200);
  });

  it('A SEALED HANDOVER IS ACCEPTED, AND NOTHING READABLE CROSSES THE WIRE', async () => {
    const c = await withACompany();
    const dana = await register('Dana');
    const { raw, employeeId } = await invite(c, dana.email);
    const offer = await call('GET', `/api/invites/${raw}/offer`);
    const wk = newWrappingKeypair();
    const address = payeeFor('d2'.repeat(32), NETWORK).bech32;

    /* Exactly what `Join.tsx` does: seal to the inbox key that came out of the
     * sealed offer, then post the blob. */
    const handover = sealHandover(
      { wrappingPublicKey: wk.publicKey, address, confirmation: addressFingerprint(address) },
      offer.body.inboxPublicKey);
    expect(JSON.stringify(handover)).not.toContain(address);

    const accepted = await call('POST', `/api/invites/${raw}/accept-employee`, {
      token: dana.token, body: { handover },
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    /* The response says a handover is waiting and says nothing about where. */
    expect(JSON.stringify(accepted.body)).not.toContain(address);
    expect(JSON.stringify(accepted.body)).not.toContain(wk.publicKey);

    /*
     * §4 — **AND ADMIT IS WHAT MAKES THEM PAYABLE, AND IT RECORDS WHAT IT
     * ADMITTED.** The address on the roster is the one that accepted, rebuilt
     * through the real `payeeAddress()` from the string inside the envelope.
     */
    const roster = await call('GET',
      `/api/accounts/${c.accountId}/people?viewingKey=${c.viewingKey}`,
      { token: c.admin.token });
    const waiting = roster.body.find((p: any) => p.id === employeeId);
    expect(waiting.status).toBe('pending');
    expect(waiting.handedOver).toBe(true);

    const admitted = await call('POST', `/api/employees/${employeeId}/admit`, {
      token: c.admin.token, body: { viewingKey: c.viewingKey },
    });
    expect(admitted.status, JSON.stringify(admitted.body)).toBe(200);
    expect(admitted.body.status).toBe('active');
    expect(admitted.body.address.bech32).toBe(address);
    expect(admitted.body.wrappingPublicKey).toBe(wk.publicKey);
    /* What the later confirmation layer will compare against, already written. */
    expect(admitted.body.admittedAt).toBeTruthy();
    expect(admitted.body.handedOverBy).toBeTruthy();
  });

  it('A HANDOVER SEALED TO SOMEBODY ELSE\'S INBOX IS REFUSED AT ADMIT, RECOVERABLY',
    async () => {
      /*
       * The blob is opaque at the accept door by construction, so a wrong or
       * corrupt one can only be found where the key is. What matters is that
       * finding it there does not strand the person: **a refusal that spends
       * the invitation freezes the whole account's payroll behind one hire**
       *, and no route re-opens an invitation.
       */
      const c = await withACompany();
      const other = await withACompany();
      const dana = await register('Dana');
      const { raw, employeeId } = await invite(c, dana.email);
      const otherOffer = await call('GET',
        `/api/invites/${(await invite(other, 'someone@example.com')).raw}/offer`);

      const accepted = await call('POST', `/api/invites/${raw}/accept-employee`, {
        token: dana.token,
        body: {
          handover: sealHandover(
            {
              wrappingPublicKey: newWrappingKeypair().publicKey,
              address: payeeFor('d3'.repeat(32), NETWORK).bech32,
              confirmation: null,
            },
            otherOffer.body.inboxPublicKey),
        },
      });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

      const refused = await call('POST', `/api/employees/${employeeId}/admit`, {
        token: c.admin.token, body: { viewingKey: c.viewingKey },
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/will not open/u);
    });
});

describe('§4 — `active` is not a status somebody can just be given', () => {
  it('THE ROSTER CANNOT MARK A PERSON WITH NO ADDRESS ACTIVE — C156', async () => {
    /*
     * `admit` is the only step that makes somebody payable, and `setStatus`
     * assigned the status with no check at all — so a `pending` person with no
     * address and no key could be made active from a roster row. **Nothing was
     * ever paid that way**, because a run refuses by name for a person with no
     * address, which is why `C156` is not a money hole. It is still a door
     * answering a question only `admit` may answer.
     */
    const c = await withACompany();
    const { employeeId } = await invite(c, 'dana@example.com');

    const forced = await call('POST', `/api/people/${employeeId}/status`, {
      token: c.admin.token, body: { status: 'active', viewingKey: c.viewingKey },
    });
    expect(forced.status).toBe(400);
    expect(forced.body.error).toMatch(/no address on file/u);

    /* And withdrawing still works, because it is the only exit from an
     * invitation that can never be admitted. */
    const withdrawn = await call('POST', `/api/people/${employeeId}/status`, {
      token: c.admin.token, body: { status: 'leaver', viewingKey: c.viewingKey },
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body.status).toBe('leaver');
  });
});

/*
 * **§6 IS LAST IN THIS FILE ON PURPOSE, AND THE REASON IS THE THING IT TESTS.**
 *
 * The limiter is keyed on the CALLER, and every test here calls from the same
 * loopback address. A test that deliberately exhausts the allowance therefore
 * starves every test that runs after it — which is not flakiness, it is the
 * limit working. Vitest runs a file's `describe` blocks in source order, so it
 * goes at the end rather than being papered over with a reset nothing in
 * production has.
 */
/**
 * **X12 §2 — THE CODE THAT SAYS IT WAS REALLY THEM.** `C21`,
 * `docs/scope-invitations.md` §5.
 *
 * `X11` reversed `A-10` deliberately: the admin holds the raw token, because
 * the admin sends the link and there is no mailer. **The consequence is that an
 * admin can accept an invitation themselves, with their own address** — and
 * §5's confirmation is what a person can act on when they suspect it.
 *
 * The three properties below are the whole of it: the code travels SEALED, the
 * receiving side computes the same one from the address that actually arrived,
 * and a substituted address renders a different one.
 */
describe('§2 — the code the invitee pasted, and the one this machine works out', () => {
  it('TRAVELS SEALED WITH THE ADDRESS, AND THE ADMIN\'S OWN MACHINE COMPUTES THE MATCH',
    async () => {
      const c = await withACompany();
      const dana = await register('Dana');
      const { raw, employeeId } = await invite(c, dana.email);
      const offer = await call('GET', `/api/invites/${raw}/offer`);
      expect(offer.status, JSON.stringify(offer.body)).toBe(200);

      const address = payeeFor('e1'.repeat(32), NETWORK).bech32;
      const theCode = addressFingerprint(address);
      const wk = newWrappingKeypair();
      /* Exactly what `Join.tsx` seals: the address, the payslip key, and the
       * code the person read off their own wallet screen. */
      const handover = sealHandover(
        { wrappingPublicKey: wk.publicKey, address, confirmation: theCode },
        offer.body.inboxPublicKey);

      /* **NEITHER VALUE CROSSES THE WIRE.** The address was already sealed —
       * And the code is a hundred bits that identify one address, so
       * it goes INSIDE the envelope rather than beside it. */
      const onTheWire = JSON.stringify(handover);
      expect(onTheWire).not.toContain(address);
      expect(onTheWire).not.toContain(theCode);

      const accepted = await call('POST', `/api/invites/${raw}/accept-employee`, {
        token: dana.token, body: { handover },
      });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

      /*
       * **THE ROUTE SERVES CIPHERTEXT AND HAS NOWHERE TO PUT A KEY.** §5: the
       * fingerprint is computed on the ADMIN'S machine, because computing it on
       * ours would mean holding the address. This is that route, and the
       * comparison below runs the same function the admin's browser runs.
       */
      const box = await call('GET', `/api/employees/${employeeId}/handover`, {
        token: c.admin.token,
      });
      expect(box.status, JSON.stringify(box.body)).toBe(200);
      expect(JSON.stringify(box.body)).not.toContain(address);
      expect(JSON.stringify(box.body)).not.toContain(theCode);

      const seen = acceptedCodes(box.body.inbox, c.accountId, c.viewingKey);
      expect(seen).not.toBeNull();
      if (seen?.of !== 'opened') throw new Error('the drop box did not open');
      expect(seen.theirs).toBe(theCode);
      expect(seen.ours).toBe(theCode);
      expect(seen.agree).toBe(true);
    });

  it('AND AN ADDRESS THAT IS NOT THE ONE THE WALLET SHOWED DOES NOT MATCH', async () => {
    /*
     * **THE FAILING CASE IS THE ONLY REASON THE PASSING ONE IS WORTH
     * ANYTHING.** This is a page that took the person's approval and sealed
     * somebody else's address: every other check in the flow passes, the
     * envelope is well formed, the roster entry is correct in every field —
     * and the two codes disagree, which is the one place it shows.
     */
    const c = await withACompany();
    const dana = await register('Dana');
    const { raw, employeeId } = await invite(c, dana.email);
    const offer = await call('GET', `/api/invites/${raw}/offer`);

    const shown = payeeFor('e2'.repeat(32), NETWORK).bech32;
    const substituted = payeeFor('e3'.repeat(32), NETWORK).bech32;
    const accepted = await call('POST', `/api/invites/${raw}/accept-employee`, {
      token: dana.token,
      body: {
        handover: sealHandover(
          {
            wrappingPublicKey: newWrappingKeypair().publicKey,
            address: substituted,
            /* The code is of the address the WALLET showed. It is the half a
             * substituting page cannot recompute without the wallet. */
            confirmation: addressFingerprint(shown),
          },
          offer.body.inboxPublicKey),
      },
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    const box = await call('GET', `/api/employees/${employeeId}/handover`, {
      token: c.admin.token,
    });
    const seen = acceptedCodes(box.body.inbox, c.accountId, c.viewingKey);
    if (seen?.of !== 'opened') throw new Error('the drop box did not open');
    expect(seen.agree).toBe(false);
    expect(seen.ours).toBe(addressFingerprint(substituted));
    expect(seen.theirs).toBe(addressFingerprint(shown));
  });
});

/**
 * **X12 §3 — AN INVITATION EXPIRES, AND CAN BE TAKEN BACK.**
 * `docs/scope-invitations.md` §8.
 *
 * §8's sentence is the whole subject of this block: *"Expiry and revocation
 * must be enforced where the offer is READ, not only where it is shown, or a
 * stale link still opens an offer."* **So every assertion here is against a
 * DOOR, never against a screen** — the screen is not what a person holding a
 * link talks to.
 */
describe('§3 — expiry and revocation, enforced where the offer is read', () => {
  /** The deadline is fourteen days; this is comfortably past it. */
  const AFTER = 20 * 24 * 60 * 60 * 1000;

  it('AN EXPIRED INVITATION CAN NEITHER BE OPENED NOR ACCEPTED', async () => {
    const c = await withACompany();
    const dana = await register('Dana');
    const { raw } = await invite(c, dana.email);

    const before = await call('GET', `/api/invites/${raw}/offer`);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    /* The person it is about can see the deadline, so it is something they can
     * act on rather than something that happens to them. */
    expect(Date.parse(before.body.expiresAt)).toBeGreaterThan(Date.now());

    /*
     * **ONLY `Date` IS FAKED.** The suite drives real HTTP over a real socket,
     * so faking the timers would stop the server answering at all. And a
     * session lasts twelve hours, which is why the acceptance below is made by
     * somebody who registers AFTER the jump: an expired session would answer
     * 401 and this test would pass without ever reaching the guard it is about.
     */
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + AFTER);
      const stale = await call('GET', `/api/invites/${raw}/offer`);
      expect(stale.status).toBe(400);
      expect(String(stale.body.error)).toMatch(/expired/iu);

      const late = await register('Mallory');
      const accepted = await call('POST', `/api/invites/${raw}/accept-employee`, {
        token: late.token,
        body: {
          handover: sealHandover(
            {
              wrappingPublicKey: newWrappingKeypair().publicKey,
              address: payeeFor('e4'.repeat(32), NETWORK).bech32,
              confirmation: null,
            },
            before.body.inboxPublicKey),
        },
      });
      /* **THE ONE THAT MATTERS.** A link that can still be SPENT after it has
       * stopped being SHOWN is a link that still works. */
      expect(accepted.status).toBe(400);
      expect(String(accepted.body.error)).toMatch(/expired/iu);
    } finally {
      vi.useRealTimers();
    }
  });

  it('A REVOKED INVITATION CAN NEITHER BE OPENED NOR ACCEPTED', async () => {
    const c = await withACompany();
    const dana = await register('Dana');
    const { raw, employeeId } = await invite(c, dana.email);
    const offer = await call('GET', `/api/invites/${raw}/offer`);
    expect(offer.status, JSON.stringify(offer.body)).toBe(200);

    /* **ADDRESSED BY THE PERSON, NOT BY THE TOKEN** — the admin does not hold
     * the token and no route gives it back to them (§1's own test). */
    const took = await call('POST', `/api/employees/${employeeId}/invite/revoke`, {
      token: c.admin.token,
    });
    expect(took.status, JSON.stringify(took.body)).toBe(200);
    expect(typeof took.body.revokedAt).toBe('string');

    const gone = await call('GET', `/api/invites/${raw}/offer`);
    expect(gone.status).toBe(400);
    expect(String(gone.body.error)).toMatch(/withdrawn/iu);

    const accepted = await call('POST', `/api/invites/${raw}/accept-employee`, {
      token: dana.token,
      body: {
        handover: sealHandover(
          {
            wrappingPublicKey: newWrappingKeypair().publicKey,
            address: payeeFor('e5'.repeat(32), NETWORK).bech32,
            confirmation: null,
          },
          offer.body.inboxPublicKey),
      },
    });
    expect(accepted.status).toBe(400);
    expect(String(accepted.body.error)).toMatch(/withdrawn/iu);
  });

  it('AND ONE TAKEN BACK AFTER IT WAS ACCEPTED CANNOT BE ADMITTED, RECOVERABLY', async () => {
    /*
     * **THE CASE THAT IS ACTUALLY ABOUT MONEY.** A hire falls through minutes
     * after the person accepted: the drop box is full, the admin takes the link
     * back, and `admit` is the step that would make them payable. Admitting
     * there is putting somebody on the payroll whose hire was called off.
     *
     * And it refuses the way every other refusal in `admit` does — the box
     * emptied, nobody stranded `pending` behind a run.
     */
    const c = await withACompany();
    const dana = await register('Dana');
    const { raw, employeeId } = await invite(c, dana.email);
    const offer = await call('GET', `/api/invites/${raw}/offer`);
    const accepted = await call('POST', `/api/invites/${raw}/accept-employee`, {
      token: dana.token,
      body: {
        handover: sealHandover(
          {
            wrappingPublicKey: newWrappingKeypair().publicKey,
            address: payeeFor('e6'.repeat(32), NETWORK).bech32,
            confirmation: null,
          },
          offer.body.inboxPublicKey),
      },
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    await call('POST', `/api/employees/${employeeId}/invite/revoke`, { token: c.admin.token });

    const admitted = await call('POST', `/api/employees/${employeeId}/admit`, {
      token: c.admin.token, body: { viewingKey: c.viewingKey },
    });
    expect(admitted.status).toBe(400);
    expect(String(admitted.body.error)).toMatch(/taken back/iu);

    /* The drop box was emptied, so nothing is left half-applied and the row
     * has the one exit it has always had: withdraw the person. */
    const after = await call('GET', `/api/employees/${employeeId}/handover`, {
      token: c.admin.token,
    });
    expect(after.body.inbox).toBeNull();
  });
});

describe('PI4c — AND WHAT A REAL INVITEE GETS TODAY, WHICH IS HIRED', () => {
  it('AN INVITEE WHO SIGNS IN WITH A WALLET CAN BE ADMITTED — C21',
    async () => {
      /*
       * **THIS TEST WAS THE OPPOSITE CLAIM UNTIL `PI4c`, AND IT WAS RIGHT
       * WHEN IT WAS WRITTEN.**
       *
       * It asserted that a real invitee — somebody who signs in with a wallet,
       * which is everybody, because `PI4b` deleted the password — **is refused
       * at admit, by name**, with *"this invitation is addressed to an email
       * address, and whoever redeemed it signed in with a wallet, which has
       * none"*. That was the product's honest state and pinning it was the
       * right thing to do: **nobody could be hired.**
       *
       * ── WHAT CHANGED, AND IT IS NOT THAT THE CHECK GOT BETTER ──────────
       *
       * The check is gone. `C21`'s sentence is the whole reason: **the
       * operator names the mailbox the check compares against.** The email on
       * the sealed roster entry is typed into a form at hire time, the
       * invitation is addressed to that string, and the comparison ran the
       * redeemer against that same string — so an operator hiring somebody
       * held BOTH SIDES of the only positive evidence in the flow. It never
       * cost an attacker more than a mailbox they already owned, and after
       * `PI4b` it cost every honest employee the job. **A check that refuses
       * every real person and passes the person attacking them is not weak; it
       * points the wrong way**, and `C21` says it closes by deletion rather
       * than by a better version of itself.
       *
       * ── AND IT WAS DELETED BECAUSE ITS REPLACEMENT HAD ALREADY SHIPPED ──
       *
       * `X12`'s confirmation code: the invitee's wallet shows a code for the
       * address it is about to disclose, they paste it into the join screen,
       * it travels sealed, and `admit` computes the same code from the address
       * that actually arrived. **Two codes, both derived from an address and
       * from nothing an operator can type.** The test below this one is the
       * refusal that proves it bites; `scripts/mutate-invitations.mjs` §9 and
       * §10 are what say both halves are load-bearing rather than decorative.
       *
       * **WHAT IS STILL NOT PROVEN, and the screens say so:** somebody
       * accepting their own invitation pastes their own matching code. That is
       * `C21`'s remainder and it is not what this round claimed to close.
       */
      const c = await withACompany();
      const noEmail = await signInWithAWallet(call,
        { slot: 200, origin: ORIGIN, network: NETWORK });

      const { raw, employeeId } = await invite(c, 'someone-with-an-email@acme.co');
      const offer = await call('GET', `/api/invites/${raw}/offer`);
      expect(offer.status, JSON.stringify(offer.body)).toBe(200);

      const wk = newWrappingKeypair();
      const address = payeeFor('e4'.repeat(32), NETWORK).bech32;
      const handover = sealHandover(
        { wrappingPublicKey: wk.publicKey, address, confirmation: addressFingerprint(address) },
        offer.body.inboxPublicKey);

      const accepted = await call('POST', `/api/invites/${raw}/accept-employee`, {
        token: noEmail.token, body: { handover },
      });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

      /* **THE LINE THIS ROUND EXISTS FOR.** It was a 400 and a named refusal. */
      const admitted = await call('POST', `/api/employees/${employeeId}/admit`, {
        token: c.admin.token, body: { viewingKey: c.viewingKey },
      });
      expect(admitted.status, JSON.stringify(admitted.body)).toBe(200);
      expect(admitted.body.status).toBe('active');
      /* The address on the roster is the one their own wallet disclosed. */
      expect(admitted.body.address.bech32).toBe(address);
      expect(admitted.body.wrappingPublicKey).toBe(wk.publicKey);

      /* And they are payable, on the roster, which is what being hired means. */
      const roster = await call('GET',
        `/api/accounts/${c.accountId}/people?viewingKey=${c.viewingKey}`,
        { token: c.admin.token });
      expect(roster.body.find((p: any) => p.id === employeeId).status).toBe('active');
    });

  it('AND ONE WHOSE TWO CODES DISAGREE IS REFUSED AT ADMIT, RECOVERABLY — C21',
    async () => {
      /*
       * **THE POINT OF THE ROUND. REMOVING A CHECK IS ONLY SAFE IF THE THING
       * THAT REPLACED IT ACTUALLY BITES.**
       *
       * The scenario is a join page that took the person's approval and sealed
       * SOMEBODY ELSE'S address. Every other check in `admit` passes: the
       * invitation exists, is unexpired, unrevoked, belongs to this company,
       * records who raised and who redeemed it, and nobody is already payable
       * as this person. The envelope is well formed and the roster entry would
       * be right in every field. **The one thing that does not line up is the
       * code**, because it is of the address the WALLET showed and a
       * substituting page cannot recompute it without the wallet.
       *
       * `src/web/accepted-address.ts` already showed the admin that
       * disagreement — and an admin who pressed admit anyway was obeyed. This
       * asserts the service now refuses it, so the code is enforcement rather
       * than advice.
       *
       * **AND IT REFUSES THE WAY EVERY OTHER REFUSAL IN `admit` DOES** —
       * The box emptied, the invitation put back, nobody stranded
       * `pending` behind a run that will not build while anybody is.
       */
      const c = await withACompany();
      const noEmail = await signInWithAWallet(call,
        { slot: 201, origin: ORIGIN, network: NETWORK });

      const { raw, employeeId } = await invite(c, 'dana@acme.co');
      const offer = await call('GET', `/api/invites/${raw}/offer`);
      expect(offer.status, JSON.stringify(offer.body)).toBe(200);

      const shown = payeeFor('e7'.repeat(32), NETWORK).bech32;
      const substituted = payeeFor('e8'.repeat(32), NETWORK).bech32;
      const accepted = await call('POST', `/api/invites/${raw}/accept-employee`, {
        token: noEmail.token,
        body: {
          handover: sealHandover(
            {
              wrappingPublicKey: newWrappingKeypair().publicKey,
              address: substituted,
              confirmation: addressFingerprint(shown),
            },
            offer.body.inboxPublicKey),
        },
      });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

      const admitted = await call('POST', `/api/employees/${employeeId}/admit`, {
        token: c.admin.token, body: { viewingKey: c.viewingKey },
      });
      expect(admitted.status, JSON.stringify(admitted.body)).toBe(400);
      expect(String(admitted.body.error)).toMatch(/read off their own wallet/iu);
      expect(String(admitted.body.error)).toMatch(/not the one their wallet showed them/iu);

      /* Nobody became payable, and the substituted address is on no roster. */
      const roster = await call('GET',
        `/api/accounts/${c.accountId}/people?viewingKey=${c.viewingKey}`,
        { token: c.admin.token });
      const row = roster.body.find((p: any) => p.id === employeeId);
      expect(row.status).not.toBe('active');
      expect(JSON.stringify(roster.body)).not.toContain(substituted);

      /* `C28` — emptied and put back, so the honest retry is simply possible. */
      const after = await call('GET', `/api/employees/${employeeId}/handover`, {
        token: c.admin.token,
      });
      expect(after.body.inbox).toBeNull();
      const reopened = await call('GET', `/api/invites/${raw}/offer`);
      expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    });
});

/*
 * **THIS SITS ABOVE §6 ON PURPOSE, AND THE ORDER IS LOAD-BEARING.**
 *
 * §6 exhausts the `invite-offer` bucket deliberately — that is its whole
 * assertion — and the limit is keyed on the CALLER, which every test in this
 * file shares. Anything below it that reads an offer gets a `429` instead of
 * the offer, which is a failure naming the wrong thing entirely.
 */
describe('§6 — the offer endpoint is metered', () => {
  it('REFUSES A CALLER WHO ASKS TOO MANY TIMES, WITH A `Retry-After`', async () => {
    /*
     * **DEPTH RATHER THAN URGENCY, AND THE ENTRY SAYS SO.** A hundred and eight
     * bits of token is not guessable and a limit does not change that. What it
     * buys is that the attempt is bounded and therefore visible.
     *
     * **KEYED ON THE CALLER AND NOT ON THE TOKEN**, which is what this test is
     * really about: every request below asks for a DIFFERENT token, so a limit
     * keyed on the token would give each one a fresh allowance and none of them
     * would ever be refused. The refusal only happens because the bucket is the
     * thing that does not change between guesses.
     */
    let refused: Res | null = null;
    for (let i = 0; i < 60 && !refused; i += 1) {
      const r = await call('GET', `/api/invites/inv_guess-number-${i}/offer`);
      if (r.status === 429) refused = r;
    }
    expect(refused, 'a guesser walking the token space was never refused').not.toBeNull();
    expect(refused!.headers.get('retry-after')).toMatch(/^\d+$/u);
    expect(refused!.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused!.body.error).toMatch(/metered/u);
  });
});
