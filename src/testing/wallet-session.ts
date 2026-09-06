import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { signatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import { identityFromWords } from 'midnight-identity';
import { addressOfVerifyingKey, mint } from 'midnight-identity/profile/disclosure';

/**
 * **A REAL SIGN-IN OVER REAL HTTP, FOR TESTS THAT ONLY NEED A SESSION.**
 *
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────
 *
 * Five suites got a session by calling `POST /api/auth/register` with an
 * `authKey` of `'aa'.repeat(32)` — none of them were about passwords, they
 * just needed somebody signed in, and registering was the cheapest door.
 * **`PI4b` deleted that door**, so each of them needed the same twenty-five
 * lines of wallet sign-in instead.
 *
 * This project's most expensive habit is one rule written twice: `M-101`'s
 * redaction lived as a private helper in one test file and the next test that
 * needed it did not have it, and flaked for two afternoons. `T-12` moved it
 * here. **A wallet sign-in copied into five files is the same defect waiting**,
 * so it lives here instead, once.
 *
 * ── AND NOTHING HERE IS A FIXTURE SHAPED LIKE A SIGNATURE ─────────────────
 *
 * `mint` and `identityFromWords` ship from `midnight-identity` — the wallet's
 * own code — so what the server checks is bytes the wallet actually produces.
 * A hand-rolled envelope would pass whatever the server's parser happened to
 * accept, which is the opposite of the property these suites want.
 */

/** The wallet every suite signs in from. One seed, many slots. */
export const testWallet = identityFromWords(TEST_MNEMONIC);

/**
 * The unshielded address of one slot, as the sign-in verifies it.
 *
 * **THE NETWORK IS REQUIRED AND NOT DEFAULTED**, for `payeeFor`'s reason: an
 * address is only meaningful on one network, and a fixture that quietly picks
 * one teaches the opposite of what `C151` cost.
 */
export const addressOfSlot = (slot: number, network: Parameters<typeof addressOfVerifyingKey>[1]) =>
  addressOfVerifyingKey(
    signatureVerifyingKey({
      tag: 'schnorr',
      value: Buffer.from(testWallet.moneyAt(slot).night).toString('hex'),
    }).value,
    network);

type Res = { status: number; body: any };
type Call = (
  method: string, path: string, opts?: { token?: string; body?: unknown },
) => Promise<Res>;

/**
 * Signs in as one subwallet slot and returns the session token and its address.
 *
 * **A SLOT IS A PERSON HERE.** Two suites that want two people ask for two
 * slots; asking twice for the same slot signs the SAME person in twice, which
 * is a different and equally useful thing (`two-companies.test.ts` relies on
 * it). Neither is a default, so a caller has to mean one of them.
 *
 * **IT ASSERTS ITS OWN TWO STATUSES.** A helper that returns `undefined`
 * because the challenge answered `503` produces a failure fifteen lines later
 * in the test that borrowed it, naming something unrelated — and `APP_ORIGIN`
 * being unset is exactly how that happens, because the wallet routes answer
 * `503` with a reason rather than throwing.
 */
export const signInWithAWallet = async (
  call: Call,
  opts: {
    slot: number;
    /** The origin the signature names. Must equal the server's `APP_ORIGIN`. */
    origin: string;
    network: Parameters<typeof addressOfVerifyingKey>[1];
    /** Carried into the sign-in when this is an invitee arriving by a link. */
    inviteToken?: string;
  },
): Promise<{ token: string; address: string; userId: string | null; created: boolean }> => {
  const asked = await call('POST', '/api/auth/wallet/challenge');
  if (asked.status !== 200) {
    throw new Error(
      `the wallet challenge answered ${asked.status}: ${JSON.stringify(asked.body)}. `
      + 'A 503 here means APP_ORIGIN is not set for this suite.');
  }

  const address = addressOfSlot(opts.slot, opts.network);
  const response = mint(testWallet, opts.slot, {
    origin: opts.origin,
    nonce: asked.body.nonce,
    address,
    at: Date.now(),
    disclosed: [],
    declined: [],
    requesterSaidItWas: { name: 'Payroll', rdns: 'example.payroll' },
  }).response;

  const inHere = await call('POST', '/api/auth/wallet', {
    body: {
      handle: asked.body.handle,
      nonce: asked.body.nonce,
      response,
      ...(opts.inviteToken ? { inviteToken: opts.inviteToken } : {}),
    },
  });
  if (inHere.status !== 200) {
    throw new Error(
      `the wallet sign-in answered ${inHere.status}: ${JSON.stringify(inHere.body)}`);
  }

  return {
    token: inHere.body.session.token as string,
    address: inHere.body.address as string,
    userId: (inHere.body.user?.id as string) ?? null,
    created: Boolean(inHere.body.created),
  };
};
