/**
 * **THE SIGNING KEY STOPS LEAVING THE DEVICE, HELD OVER REAL HTTP.**
 *
 * A green suite proves nothing about this change on its own. `approve` used to
 * take a `signingSecret`, and every existing test that calls it now passes a
 * signature instead — which they would also do if this file did not exist and
 * the service quietly accepted anything. Two properties are worth a test, and
 * the second is the one that is usually skipped:
 *
 *   1. **A body that still carries a `signingSecret` is REFUSED, by reason.**
 *      Not ignored, not dropped by a schema that happens to be strict. A field
 *      that is merely unused comes back, and while it comes back the key is
 *      still arriving.
 *   2. **A signature over a DIFFERENT digest is refused.** Verification that
 *      does not bind to *this* proposal reads exactly like verification that
 *      does, passes every happy-path test, and turns an approval into a token
 *      of membership: sign once, approve anything. The signature spent below is
 *      a real one, made by a real signer's real key, over a real proposal — the
 *      wrong one.
 *
 * Both go over the wire against a listening server, because the refusal in (1)
 * is a status and a body, and neither has a type.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { sign } from '../core/crypto.js';
import { approvalMessage, REFUSED_APPROVALS_KEPT } from '../core/account.js';
import { signInWithAWallet } from '../testing/wallet-session.js';

/* The same boot as `server.test.ts`, and for the same reasons — the notes at
 * the top of that file carry the argument for each of these four lines. */
process.env.ALLOW_MEMORY_SESSIONS = '1';
process.env.DATABASE_URL = '';
process.env.SERVE = '0';
process.env.APP_ORIGIN = 'https://payroll.example';
process.env.DATA_PATH = join(mkdtempSync(join(tmpdir(), 'mn-approve-')), 'db.json');

const ORIGIN = 'https://payroll.example';
/**
 * **THESE ROUTES ARE DRIVEN OVER A TEST DOUBLE, NOT OVER THE DEPLOYMENT, AND
 * THAT IS SAID HERE SO NOBODY READS THESE CASES AS EVIDENCE ABOUT A CHAIN.**
 *
 * This file is about whether a signature on an approval is verified - who signed, for which round, and what is recorded when the answer is no. Every one of those cases has to APPROVE something, and the deployment this product runs on cannot: it reads a chain and has no wallet to pay a transaction with, so every write refuses above the ledger.
 *
 * **SO THIS FILE BUILDS ITS OWN BOUNDARY IMPLEMENTATION AND HANDS IT OVER
 * BEFORE THE ENTRY POINT IS IMPORTED.** The services, the routes, the sign-in state
 * handling and the checks below are the real ones - the LEDGER is a double, and
 * it is named here, out loud, which is the difference between a test saying
 * which implementation it exercises and a second decision hidden in the
 * product. Nothing outside a test may do this: the walk beside the selector
 * refuses `handInWiring` in every non-test module.
 *
 * **WHAT THESE CASES PROVE AND WHAT THEY DO NOT.** They prove exactly what they
 * proved before the product selected a chain, and nothing more. **They are not
 * evidence that this server works against a chain.** `server-starts.test.ts` is
 * the file that exercises the real chain wiring, and it is deliberately the one
 * file here that takes no double.
 *
 * The three come from one object because they may never be chosen apart: a leaf
 * computed under one commitment scheme is meaningless to a ledger running under
 * another.
 */
const { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } = await import('../core/ledger.js');
const { handInWiring } = await import('../wiring/handed-in.js');
handInWiring({
  name: 'simulated',
  commitments: SimulatedCommitments,
  createLedger: () => new SimulatedLedger(SimulatedCommitments),
  createProofSystem: () => new SimulatedProofSystem(),
});

const { app } = await import('./index.js');
const { theNetwork } = await import('../midnight/network.js');
const NETWORK = theNetwork();

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

type Res = { status: number; body: any };

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
  return { status: r.status, body: await r.json().catch(() => null) };
};

/**
 * A COMPANY WITH TWO PROPOSALS ON IT, ONE OF WHICH IS THE OPEN ROUND.
 *
 * **THIS BUILT ITSELF THROUGH `POST /api/demo/seed` UNTIL `S28`. `C303`,
 * `T-63`.** `C292` deleted the account balance; `S26` made `seedDemo` throw
 * because the demo funded the company by depositing into it. Nothing in this
 * file was about the demo — all four tests below died at
 * `expect(seeded.status).toBe(200)`, before their first assertion, and the only
 * tests of approval-signature verification in this repository stopped running.
 *
 * **NOT ONE ASSERTION IN THE FOUR TESTS CHANGED.** What changed is where the
 * company comes from. The setup expectations inside this helper necessarily
 * did, because they check different calls.
 *
 * WHY THE PLAIN DOORS ARE ENOUGH, and the note that stood here said they were
 * not. It claimed the seeded company *"is the one place this server hands back
 * more than one signer's secrets"*. **That is false and was false when it was
 * written**: `POST /api/accounts` returns `AccountService.create`'s result
 * unfiltered (`src/server/index.ts:767`), and that carries a `signingSecret`
 * for every signer named in the body (`src/core/account.ts:676`). The demo was
 * never load-bearing for this file.
 *
 * THREE THINGS THE REPLACEMENT HAS TO KEEP, each of which an assertion below
 * depends on:
 *
 *   1. **The caller is seated.** `POST /api/accounts` puts the creator in seat
 *      0 (`src/server/index.ts:766`), which is what `ownsProposal` checks.
 *   2. **Seats 1 and 2 are approvers, not viewers.** The last test signs with
 *      seat 2's key in seat 1's name and expects the SIGNATURE refusal; a
 *      viewer in seat 1 is refused earlier, by role, and the test would pass
 *      for the wrong reason (`src/core/account.ts:2330`).
 *   3. **Two proposals with different digests.** The wrong-digest signature is
 *      made over a real one belonging to this same account.
 *
 * The runs are AD HOC — `POST /api/accounts/:id/payroll` — rather than
 * roster-driven, so no hiring, no invitations, and nothing that ever touched
 * the deleted balance. The two proposals are both open; the old helper's
 * "settled" one was decorative even then, because nothing here reads a status
 * and `execute` no longer exists.
 */
let slot = 70;
let period = 0;
const aCompanyWithAnOpenRound = async () => {
  const who = await signInWithAWallet(call, { slot: ++slot, origin: ORIGIN, network: NETWORK });
  const token = who.token;

  const made = await call('POST', '/api/accounts', {
    token,
    body: {
      name: 'Acme',
      signers: [
        { name: 'Ada', role: 'admin' },
        { name: 'Blake', role: 'approver' },
        { name: 'Cleo', role: 'approver' },
      ],
      threshold: 2,
    },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const accountId: string = made.body.account.id;
  const viewingKey: string = made.body.viewingKey;
  const secrets: { signerId: string; signingSecret: string }[] = made.body.secrets;
  expect(secrets.length).toBe(3);

  /**
   * One ad hoc governance round, proposed over HTTP. Returns what the chain
   * will call it.
   *
   * **THIS RAISED A PAYROLL RUN UNTIL `S47`, AND THAT DOOR NOW REFUSES.**
   * `C375`: `POST /api/runs/:id/propose` used to answer 200 with a proposal id
   * for a round no vault could ever be presented with, and it is the refusal
   * that is the fix. **This fixture never cared which KIND of round it got** —
   * every test below is about whether an approval's signature is verified
   * against the round's digest — so it takes the one governance door this
   * server exposes instead. A different vault each call gives two rounds with
   * different digests, which is all `other` and `open` need.
   *
   * `proposeVaultThresholdChange` names `noVault()` on the round itself
   * (`account.ts:1410`); the vault below is the SUBJECT of the round, not its
   * scope, which is the distinction `R5` draws and the reason a governance
   * round about a vault is still measured at the account's threshold.
   */
  const aProposal = async (reuseVault?: string): Promise<{ id: string; digest: string; chainId: string }> => {
    const nth = ++period;
    const proposed = await call('POST', `/api/accounts/${accountId}/vault-threshold/propose`, {
      token,
      body: {
        viewingKey,
        vault: reuseVault ?? nth.toString(16).padStart(2, '0').repeat(32),
        newThreshold: 2,
        proposedBy: secrets[0].signerId,
      },
    });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    return proposed.body;
  };

  /* `other` first, so `open` is the later of the two and the account's most
   * recent round is the one being approved — the same order the seeded company
   * produced. */
  const other = await aProposal();
  const open = await aProposal();
  expect(other.digest).not.toBe(open.digest);

  return { token, accountId, viewingKey, secrets, open, other, aProposal };
};

const approvalsOn = async (token: string, accountId: string, proposalId: string) => {
  const listed = await call('GET', `/api/accounts/${accountId}/proposals`, { token });
  const found = listed.body.find((p: any) => p.id === proposalId);
  expect(found).toBeTruthy();
  return found.approvalCount as number;
};

describe('approving a proposal', () => {
  it('REFUSES a body carrying a signing secret, by reason, and changes nothing', async () => {
    const c = await aCompanyWithAnOpenRound();
    const before = await approvalsOn(c.token, c.accountId, c.open.id);

    /*
     * The signature is CORRECT here. The only thing wrong with this request is
     * that it also carries the key — which is what the old client sent, so this
     * is the shape a client that has not been updated actually produces. It
     * must not be accepted "because the signature was fine anyway".
     */
    const sent = await call('POST', `/api/proposals/${c.open.id}/approve`, {
      token: c.token,
      body: {
        signerId: c.secrets[0].signerId,
        signature: sign(approvalMessage(c.open), c.secrets[0].signingSecret),
        signingSecret: c.secrets[0].signingSecret,
        viewingKey: c.viewingKey,
      },
    });

    expect(sent.status).toBe(400);
    /*
     * **BY REASON, NOT BY SCHEMA ACCIDENT.** A named code and a sentence that
     * says what to do — including that a key sent this way is disclosed and has
     * to be replaced, which is the part a caller cannot work out from a 400.
     */
    expect(sent.body.code).toBe('signing-secret-refused');
    expect(sent.body.error).toMatch(/does not accept a signing secret/i);
    expect(sent.body.error).toMatch(/signature/i);

    expect(await approvalsOn(c.token, c.accountId, c.open.id)).toBe(before);
  });

  it('the named refusal is not just strictness: an unknown field fails differently', async () => {
    const c = await aCompanyWithAnOpenRound();

    const sent = await call('POST', `/api/proposals/${c.open.id}/approve`, {
      token: c.token,
      body: {
        signerId: c.secrets[0].signerId,
        signature: sign(approvalMessage(c.open), c.secrets[0].signingSecret),
        somethingElse: 'x',
        viewingKey: c.viewingKey,
      },
    });

    expect(sent.status).toBe(400);
    /* Refused too — but as an unrecognised key, with no `code`. If the secret
     * were being caught by `.strict()` alone these two would be identical, and
     * the first test would be asserting the schema rather than the rule. */
    expect(sent.body.code).toBeUndefined();
  });

  it('THE ONE THAT DIES IF VERIFICATION GOES: a signature for another digest is refused', async () => {
    const c = await aCompanyWithAnOpenRound();
    const before = await approvalsOn(c.token, c.accountId, c.open.id);

    /*
     * A real signature, by the right signer, with the right key — over ANOTHER
     * proposal on this same account. Everything about it is valid except what
     * it is a signature OF.
     *
     * Remove the `verify` in `approve` and this request succeeds, so this
     * expectation fails. That is the whole purpose of the test: a check that
     * merely confirms "this signer signed something" would let one signature,
     * captured once, approve every round that signer is ever asked about.
     */
    expect(c.other.digest).not.toBe(c.open.digest);
    const wrong = await call('POST', `/api/proposals/${c.open.id}/approve`, {
      token: c.token,
      body: {
        signerId: c.secrets[0].signerId,
        signature: sign(approvalMessage(c.other), c.secrets[0].signingSecret),
        viewingKey: c.viewingKey,
      },
    });

    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/does not match the registered signing key/i);
    expect(await approvalsOn(c.token, c.accountId, c.open.id)).toBe(before);

    /*
     * And the same request with the RIGHT digest is accepted — otherwise the
     * refusal above could be any old failure and this file would be asserting
     * that approving is broken.
     */
    const right = await call('POST', `/api/proposals/${c.open.id}/approve`, {
      token: c.token,
      body: {
        signerId: c.secrets[0].signerId,
        signature: sign(approvalMessage(c.open), c.secrets[0].signingSecret),
        viewingKey: c.viewingKey,
      },
    });
    expect(right.status).toBe(200);
    expect(await approvalsOn(c.token, c.accountId, c.open.id)).toBe(before + 1);
  });

  it('a signature by a key this account does not know is refused', async () => {
    const c = await aCompanyWithAnOpenRound();

    /* Cleo's key, Blake's seat. The digest is right; the hand is not. */
    const sent = await call('POST', `/api/proposals/${c.open.id}/approve`, {
      token: c.token,
      body: {
        signerId: c.secrets[1].signerId,
        signature: sign(approvalMessage(c.open), c.secrets[2].signingSecret),
        viewingKey: c.viewingKey,
      },
    });

    expect(sent.status).toBe(400);
    expect(sent.body.error).toMatch(/does not match the registered signing key/i);
  });

  it('REFUSES a signature made for a DIFFERENT ROUND WITH THE SAME DIGEST — `C382`, `C397`, `T-236`', async () => {
    /*
     * **THE CASE THIS FILE DID NOT HAVE, AND COULD NOT HAVE HAD.**
     *
     * Every other case here spends a signature over a DIFFERENT digest, and the
     * fixture guarantees the difference by naming a different vault each call
     * (`:165`) — so the property actually pinned was *the digest is checked*,
     * which `C382` and `C397` are not about. **Both are about two rounds whose
     * digests are EQUAL and whose identities are not.**
     *
     * `vaultThresholdPayload(vault, newThreshold)` is a pure function of its two
     * arguments, so raising the same round twice rebuilds the same digest byte
     * for byte. `chainId` is `proposalIdOf(digest, salt, vault)` and the salt is
     * 32 fresh random bytes per call (`src/core/crypto.ts:160-171`), so the two
     * ids differ. **That is `C382`'s mechanism exactly — a withdrawn round
     * re-raised — reached through a governance door because `T-238` means no
     * payroll run can be raised at all, and `C397`'s vault limb rides the same
     * `chainId` because the vault is folded into it (`compact:874-881`).**
     *
     * Revert `approve` to `verify(proposal.digest, …)` and this request
     * succeeds. That is the whole point of the case.
     */
    const c = await aCompanyWithAnOpenRound();
    const vault = 'ab'.repeat(32);
    const first = await c.aProposal(vault);
    const second = await c.aProposal(vault);

    expect(second.digest).toBe(first.digest);
    expect(second.chainId).not.toBe(first.chainId);
    expect(second.id).not.toBe(first.id);

    const before = await approvalsOn(c.token, c.accountId, second.id);
    const replayed = await call('POST', `/api/proposals/${second.id}/approve`, {
      token: c.token,
      body: {
        signerId: c.secrets[0].signerId,
        signature: sign(approvalMessage(first), c.secrets[0].signingSecret),
        viewingKey: c.viewingKey,
      },
    });

    expect(replayed.status).toBe(400);
    expect(replayed.body.error).toMatch(/does not match the registered signing key/i);
    expect(await approvalsOn(c.token, c.accountId, second.id)).toBe(before);

    /*
     * THE POSITIVE CONTROL. Without it the refusal above could be the two rounds
     * being indistinguishable to the service, or approving being broken outright.
     */
    const proper = await call('POST', `/api/proposals/${second.id}/approve`, {
      token: c.token,
      body: {
        signerId: c.secrets[0].signerId,
        signature: sign(approvalMessage(second), c.secrets[0].signingSecret),
        viewingKey: c.viewingKey,
      },
    });
    expect(proper.status, JSON.stringify(proper.body)).toBe(200);
    expect(await approvalsOn(c.token, c.accountId, second.id)).toBe(before + 1);
  });

  it('RECORDS a replay against the round it was spent at, and names the round it came from — `C398`, `T-310`, `S55`', async () => {
    /*
     * **`S45` MADE A REPLAY FAIL. THIS IS THE HALF THAT MAKES A PAST ONE
     * VISIBLE.** The case above spends a signature that was never
     * accepted anywhere, so nothing in the record could match it and the
     * refusal is all there is. **This one spends a signature that is STANDING
     * on another round of the same account**, which is the shape the register
     * calls proof: ed25519 is deterministic, so one signature on two rounds of
     * one account is a replay and not evidence of one.
     *
     * Before this round the refusal left nothing behind — the bytes are read in
     * exactly one place (`src/core/account.ts`'s `verify` in `approve`) and
     * every other read of `.approvals` takes `signerId` or `.length` — so an
     * investigator had a `400` in a log file and no way to tell a replay from a
     * typo.
     *
     * **THE RECORD IS READ BACK THROUGH THE PRODUCT'S OWN DOOR AND NOT OUT OF
     * THE STORE**, which is the difference between a value that exists and a
     * value somebody can see: the last call is an ordinary approval by another
     * seat, and the proposal it answers with carries the attempt.
     */
    const c = await aCompanyWithAnOpenRound();
    const vault = 'cd'.repeat(32);
    const first = await c.aProposal(vault);
    const second = await c.aProposal(vault);
    expect(second.digest).toBe(first.digest);
    expect(second.chainId).not.toBe(first.chainId);

    /* The consent, genuinely given, to the FIRST round. Now it is on the record. */
    const bytes = sign(approvalMessage(first), c.secrets[0].signingSecret);
    const given = await call('POST', `/api/proposals/${first.id}/approve`, {
      token: c.token,
      body: { signerId: c.secrets[0].signerId, signature: bytes, viewingKey: c.viewingKey },
    });
    expect(given.status, JSON.stringify(given.body)).toBe(200);

    /* The same bytes, at the other round. Refused — and now SAID to be a replay. */
    const replayed = await call('POST', `/api/proposals/${second.id}/approve`, {
      token: c.token,
      body: { signerId: c.secrets[0].signerId, signature: bytes, viewingKey: c.viewingKey },
    });
    expect(replayed.status).toBe(400);
    expect(replayed.body.error).toMatch(/does not match the registered signing key/i);
    expect(replayed.body.error).toMatch(/it is a replay/i);
    expect(replayed.body.error).toContain(first.chainId);
    expect(await approvalsOn(c.token, c.accountId, second.id)).toBe(0);

    /*
     * **AND IT IS THERE AFTERWARDS, WHICH IS THE WHOLE ROW.** A second seat
     * approves `second` for real; the proposal that comes back carries the
     * attempt, the seat that was named, and the `chainId` of the round the
     * bytes actually belong to.
     */
    const later = await call('POST', `/api/proposals/${second.id}/approve`, {
      token: c.token,
      body: {
        signerId: c.secrets[1].signerId,
        signature: sign(approvalMessage(second), c.secrets[1].signingSecret),
        viewingKey: c.viewingKey,
      },
    });
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    expect(later.body.refusedApprovals.count).toBe(1);
    expect(later.body.refusedApprovals.recent).toHaveLength(1);
    expect(later.body.refusedApprovals.recent[0].signerId).toBe(c.secrets[0].signerId);
    expect(later.body.refusedApprovals.recent[0].replayOf).toBe(first.chainId);

    /*
     * **THE NEGATIVE CONTROL, AND IT IS THE ONE THAT STOPS THIS BEING A ROUND
     * COUNTER.** `first` was approved and never attacked. If `refusedApprovals`
     * appeared on every round, or `replayOf` were set whenever a signature
     * failed, this would still be green above and wrong.
     */
    const firstAgain = await call('POST', `/api/proposals/${first.id}/approve`, {
      token: c.token,
      body: {
        signerId: c.secrets[1].signerId,
        signature: sign(approvalMessage(first), c.secrets[1].signingSecret),
        viewingKey: c.viewingKey,
      },
    });
    expect(firstAgain.status, JSON.stringify(firstAgain.body)).toBe(200);
    expect(firstAgain.body.refusedApprovals).toBeUndefined();
  });

  it('an ORDINARY bad signature is recorded as an attempt and NOT as a replay — `C398`', async () => {
    /*
     * **`replayOf` ABSENT IS NOT AN ACQUITTAL AND MUST NOT BE A FALSE ONE
     * EITHER.** A signature by a key this account does not know is refused for
     * a different reason, and the record must say an attempt happened while
     * naming no round — otherwise the field would accuse whoever's bytes
     * happened to be nearest.
     */
    const c = await aCompanyWithAnOpenRound();
    const stranger = await call('POST', `/api/proposals/${c.open.id}/approve`, {
      token: c.token,
      body: {
        /* Cleo's key in Blake's seat: the digest is right, the hand is not. */
        signerId: c.secrets[1].signerId,
        signature: sign(approvalMessage(c.open), c.secrets[2].signingSecret),
        viewingKey: c.viewingKey,
      },
    });
    expect(stranger.status).toBe(400);
    expect(stranger.body.error).not.toMatch(/it is a replay/i);

    const after = await call('POST', `/api/proposals/${c.open.id}/approve`, {
      token: c.token,
      body: {
        signerId: c.secrets[0].signerId,
        signature: sign(approvalMessage(c.open), c.secrets[0].signingSecret),
        viewingKey: c.viewingKey,
      },
    });
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(after.body.refusedApprovals.count).toBe(1);
    expect(after.body.refusedApprovals.recent[0].signerId).toBe(c.secrets[1].signerId);
    expect(after.body.refusedApprovals.recent[0].replayOf).toBeUndefined();
  });


  it('KEEPS DETECTING A REPLAY AFTER THE CAP, AND SAYS THE ATTEMPT WAS NOT RECORDED — `C398`, `T-335`, `S58`', async () => {
    /*
     * **THE CAP USED TO RETURN BEFORE THE DETECTOR, WHICH PUT A SWITCH ON
     * `C398` IN THE HAND OF THE PARTY IT DETECTS.** `T-335`(2). Twenty invalid
     * signatures against a round are free to make — the route is `authed` and
     * `ownsProposal`, membership and nothing more — and once they were spent
     * every later attempt got the bare mismatch sentence. **So a member who
     * wanted a replay to go unrecorded AND unreported spent twenty first, and
     * the detector was silent for exactly the round it was built for.**
     *
     * **THIS CASE IS THE TWENTY-FIRST ATTEMPT.** It goes red on the shipped
     * order at the `it is a replay` assertion, and it goes red a second way if
     * a later round makes the cap write again, because the record must still
     * hold twenty.
     */
    const c = await aCompanyWithAnOpenRound();
    const vault = 'ef'.repeat(32);
    const first = await c.aProposal(vault);
    const second = await c.aProposal(vault);
    expect(second.digest).toBe(first.digest);
    expect(second.chainId).not.toBe(first.chainId);

    /* Seat 0's genuine consent to `first`. These bytes are now standing on the record. */
    const bytes = sign(approvalMessage(first), c.secrets[0].signingSecret);
    const given = await call('POST', `/api/proposals/${first.id}/approve`, {
      token: c.token,
      body: { signerId: c.secrets[0].signerId, signature: bytes, viewingKey: c.viewingKey },
    });
    expect(given.status, JSON.stringify(given.body)).toBe(200);

    /*
     * **THE TWENTY, AND THEY ARE ORDINARY RUBBISH RATHER THAN REPLAYS.** Seat
     * 2 signs `first`'s message and sends it at `second`: a wrong-round
     * signature by a seat that has approved nothing, so it is refused, it is
     * recorded, and `replayOf` is correctly absent on every one of them.
     */
    const junk = sign(approvalMessage(first), c.secrets[2].signingSecret);
    for (let i = 0; i < REFUSED_APPROVALS_KEPT; i++) {
      const burnt = await call('POST', `/api/proposals/${second.id}/approve`, {
        token: c.token,
        body: { signerId: c.secrets[2].signerId, signature: junk, viewingKey: c.viewingKey },
      });
      expect(burnt.status, `attempt ${i}: ${JSON.stringify(burnt.body)}`).toBe(400);
      expect(burnt.body.error).not.toMatch(/it is a replay/i);
    }

    /*
     * **THE TWENTY-FIRST, AND IT IS THE REPLAY.** The record is full, so
     * nothing is written — and the sentence still names the round these bytes
     * belong to, and says in words that this attempt did not join the record.
     */
    const replayed = await call('POST', `/api/proposals/${second.id}/approve`, {
      token: c.token,
      body: { signerId: c.secrets[0].signerId, signature: bytes, viewingKey: c.viewingKey },
    });
    expect(replayed.status).toBe(400);
    expect(replayed.body.error).toMatch(/it is a replay/i);
    expect(replayed.body.error).toContain(first.chainId);
    expect(replayed.body.error).toMatch(/NOT added to that record/);

    /*
     * **AND THE WRITE BOUND IS STILL A WRITE BOUND, WHICH IS THE OTHER HALF.**
     * `S55` added the cap because a refused approval costs a whole-store
     * flush. Moving the READ above it must not move the WRITE above it:
     * twenty recorded, `count` frozen at twenty and not twenty-one, and the
     * replay is in the sentence rather than in the list.
     */
    const later = await call('POST', `/api/proposals/${second.id}/approve`, {
      token: c.token,
      body: {
        signerId: c.secrets[1].signerId,
        signature: sign(approvalMessage(second), c.secrets[1].signingSecret),
        viewingKey: c.viewingKey,
      },
    });
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    expect(later.body.refusedApprovals.recent).toHaveLength(REFUSED_APPROVALS_KEPT);
    expect(later.body.refusedApprovals.count).toBe(REFUSED_APPROVALS_KEPT);
    expect(later.body.refusedApprovals.recent.some((r: any) => r.replayOf)).toBe(false);
  });

});
