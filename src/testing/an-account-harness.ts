import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../core/store-file.js';
import { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } from '../core/ledger.js';
import { AccountService, openAccount, sealAccount } from '../core/account.js';
import { PayrollService, RecordingInviteDelivery } from '../core/payroll.js';
import { IdentityService } from '../core/identity.js';
import { MemorySessionStore } from '../core/sessions.js';
import { MemoryChallengeStore } from '../core/challenges.js';
import { redactHex } from './redact.js';
import { registryWithTestPrivateForms, aVaultHolding } from './assets.js';
import { sealHandover, type SealedHandover } from '../core/invite-handover.js';
import type { DataStore } from '../core/store.js';
import type { Hex } from '../core/crypto.js';
import type { PayeeAddress } from '../midnight/payee-address.js';

/** The value, or a failure that says one was missing: an index that finds nothing is a broken test, not a value to carry on with. */
export function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value here, and there was none');
  return value;
}


/**
 * **THE INVITEE'S OWN DEVICE SEALS, SO A TEST HAS TO SEAL TOO.**
 *
 * `acceptInvite` has nowhere to put a plain address any more: it takes a blob
 * the service cannot open, sealed to the account's inbox public key. That key
 * reaches a real invitee inside the sealed offer; here it is looked up from the
 * invite the token belongs to, which is the same account by construction.
 */
export const handedOver = (
  h: { store: DataStore },
  token: string,
  parts: { wrappingPublicKey: Hex; address: PayeeAddress; confirmation?: string | null },
): SealedHandover => {
  const invite = h.store.getInvite(token);
  if (!invite) throw new Error(`no invite for ${token} — the test is wrong, not the code`);
  const account = h.store.getAccount(invite.accountId);
  if (!account) throw new Error('no account for that invite');
  return sealHandover(
    {
      wrappingPublicKey: parts.wrappingPublicKey,
      address: parts.address.bech32,
      /* The code the invitee read off their own wallet. Null here:
       * these tests are about what the SERVICE does with a handover, and the
       * comparison the code exists for is made on an admin's screen. */
      confirmation: parts.confirmation ?? null,
    },
    account.inboxPublicKey);
};

/**
 * **`limits` IS GONE FROM HERE.**
 *
 * It existed so a test about the SHAPE of the limiter did not have to spend
 * sixty round trips reaching the production ceiling — and every test that used
 * it was a test against `login`. `login` is deleted; the door that counts is
 * the wallet sign-in, and the same trick is done at its own harness in
 * `wallet-sign-in.test.ts`, where the limiter now lives.
 */
export function harness() {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-')), 'db.json'));
  const ledger = new SimulatedLedger(SimulatedCommitments);
  const proofs = new SimulatedProofSystem();
  const registry = registryWithTestPrivateForms();
  const accounts = new AccountService(store, ledger, SimulatedCommitments, registry, aVaultHolding());
  /*
   * The invite delivery, read by tests the way an employee reads their email.
   * `invite()` now hands the token back to whoever raised it, once, because the
   * admin is the one who sends the link and there is no mailer. The assertion
   * that states the new rule is below, at the exhaustive key check on
   * `invite()`'s return, and what the reversal costs is set out there with it.
   */
  const invites = new RecordingInviteDelivery();
  const payroll = new PayrollService(store, accounts, registry, 'undeployed', invites);
  // In-memory sessions: the same class development uses, so these
  // tests exercise a real implementation rather than a stub. The Postgres one
  // is held to the identical contract in sessions.test.ts.
  const sessionStore = new MemorySessionStore();
  const challenges = new MemoryChallengeStore();
  /* No limiter. `IdentityService` counts nothing now — it holds the
   * session and the sealed bundle, and the door that counts is the wallet
   * sign-in, which takes its own. */
  const identity = new IdentityService(store, sessionStore);
  return {
    store, ledger, proofs, accounts, payroll, identity, sessionStore, invites, challenges,
  };
}

/**
 * Gives somebody a sign-in, so they can redeem their own invite.
 *
 * `admit` checks that whoever redeemed the invite is signed in as the
 * person the company said it was hiring. A test that skipped that would be
 * asserting against a roster state the product cannot produce.
 */
export const signIn = (h: { store: { putUser: (u: any) => void } }, email: string, name = email) => {
  const id = 'usr_' + email.replace(/[^a-z0-9]/gi, '_');
  h.store.putUser({
    /* `authHash: ''` and `authSalt: ''` were here and the empty strings
     * were the tell — this fixture never had a password to hash. Both fields
     * are deleted from `User`. */
    id, email, name, keyBundle: null,
    createdAt: '2026-08-17T00:00:00.000Z',
  });
  return id;
};

/**
 * The store as text, with every ciphertext and key blanked.
 *
 * Searching raw ciphertext for a salary is a false-positive generator, and it
 * was firing about one run in twenty. The sealed bodies are hex, `"6200"` and
 * `"1337"` are valid hex, and AES emits those four characters often enough that
 * `not.toContain('6200')` fails at random on correct code. **A test that cries
 * wolf is worse than one that always fails**, because the failure gets waved
 * through as flakiness — and these are the tests that stand between us and the
 * two leaks this project has already shipped.
 *
 * Blanking every long hex run keeps exactly the property under test. If a name,
 * a salary or a role is readable, it is sitting in a PLAINTEXT field, and a
 * plaintext field is not 32 characters of hex. Nothing that could hide a real
 * leak is removed.
 *
 * Long values that must be searched for literally — a `leafCommitment` is 64
 * hex characters — are searched in the RAW text instead. At that length a
 * chance collision is not a thing that happens.
 *
 * BIGINTS ARE RENDERED AS THEIR DIGITS. Every amount is a bigint now and
 * `JSON.stringify` throws on one, which would turn this helper into a crash
 * rather than a check. Their decimal digits are exactly what a leaked salary
 * would look like in the file the store writes, so rendering them is the
 * property under test rather than a concession to it.
 */
/*
 * MOVED OUT, 16 Aug. This was a private helper here, and `sealed-records.test.ts`
 * wrote the same check without it — because there was no way to reach it — and
 * flaked at random for two afternoons. One rule held somewhere nobody else can
 * get to is the same defect as one rule written twice.
 */
export const readableStore = redactHex;

/** A leaf commitment as an invitee's device would compute it. */
export const LEAF = 'ab'.repeat(32);
/*
 * There is deliberately no BLINDING constant any more. The invitee used to have
 * to hand over the blinding behind their leaf, because a removal re-seated
 * every survivor and could not compute their new leaves without it. Nothing
 * re-seats anybody now, so the blinding never leaves the invitee's device and
 * the API that accepted it is gone — see `Signer` in core/types.ts.
 */

/**
 * Edits an account the way a signer holding the key would.
 *
 * Since the account is sealed, a test that wants to change a spending limit or
 * shove a ghost signer into the roster can no longer reach into the store and
 * write a field — which is the entire point of the change, and is why these
 * tests had to be touched at all. Open, edit, re-seal.
 */
export function editAccount(
  h: ReturnType<typeof harness>,
  accountId: string,
  viewingKey: string,
  edit: (a: import('../core/types.js').Account) => void,
) {
  const rec = h.accounts.require(accountId);
  const account = openAccount(rec, viewingKey);
  edit(account);
  h.store.putAccount(sealAccount(account, viewingKey, rec.pendingSigners, rec.keyEpoch));
  return account;
}

export const THREE_SIGNERS = [
  { name: 'Ada', role: 'admin' as const },
  { name: 'Blake', role: 'approver' as const },
  { name: 'Cleo', role: 'approver' as const },
];
