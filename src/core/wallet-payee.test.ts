import { describe, expect, it, beforeEach } from 'vitest';
import { privatePayee } from '../testing/payees.js';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { signatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import { addressFor, identityFromWords } from 'midnight-identity';
import { addressOfVerifyingKey, mint } from 'midnight-identity/profile/disclosure';
import { RECEIVING_ADDRESS } from 'midnight-identity/profile/attributes';
import { parseAsk } from 'midnight-identity/profile/request';
import type { Sent } from 'midnight-identity/profile/model';
import { MemoryChallengeStore } from './challenges.js';
import { WalletPayeeError, payeeFromWallet } from './wallet-payee.js';
import { PAYEE_PURPOSE, payeeAsk } from './wallet-payee-ask.js';

/**
 * **TAKING A RECEIVING ADDRESS FROM A WALLET.** `docs/NEXT.md` X8 §2,
 * `docs/how-money-can-be-lost.md` `C153`.
 *
 * `X7`'s screen took the address as pasted text. **Replacing the box with a
 * button that forwards whatever the wallet said would be the same door with the
 * box hidden**, so every assertion below is about what this side refuses to
 * believe — and the disclosures it is handed are minted by the WALLET'S OWN
 * `mint`, from the wallet's own package, so what is being checked is the real
 * message and not a fixture shaped like one.
 */

const ORIGIN = 'https://payroll.example';
const NETWORK = 'undeployed' as const;
const NOW = 1_755_000_000_000;
const identity = identityFromWords(TEST_MNEMONIC);
const SLOT = 2;

/** The subwallet's own unshielded address — what `mint` binds the payload to,
 * and what the verifying key recomputes to on this side. */
const signingAddress = (slot: number): string => addressOfVerifyingKey(
  signatureVerifyingKey({
    tag: 'schnorr',
    value: Buffer.from(identity.moneyAt(slot).night).toString('hex'),
  }).value,
  NETWORK);

/** The subwallet's SHIELDED address — the thing a company actually pays. */
const shielded = (slot: number): string =>
  addressFor(identity.moneyAt(slot).zswap, NETWORK).bech32;

const derivedSend = (value: string): Sent => ({
  id: RECEIVING_ADDRESS,
  about: RECEIVING_ADDRESS,
  says: { of: 'value', value },
  asserted: { by: 'wallet' },
});

const disclose = (
  sent: readonly Sent[], over: { origin?: string; nonce: string; slot?: number },
) => mint(identity, over.slot ?? SLOT, {
  origin: over.origin ?? ORIGIN,
  nonce: over.nonce,
  address: signingAddress(over.slot ?? SLOT),
  at: NOW,
  disclosed: sent,
  declined: [],
  requesterSaidItWas: { name: 'Payroll', rdns: 'example.payroll' },
}).response;

let challenges: MemoryChallengeStore;
beforeEach(() => { challenges = new MemoryChallengeStore(); });

const issued = async (): Promise<{ handle: string; nonce: string }> => {
  const handle = 'handle-' + Math.random().toString(16).slice(2);
  const { challenge } = await challenges.issue(handle);
  return { handle, nonce: challenge };
};

const take = async (
  response: unknown, given: { handle: string; nonce: string },
) => payeeFromWallet({ ...given, response }, {
  origin: ORIGIN, network: NETWORK, challenges, now: () => NOW,
});

const refusedWith = async (
  response: unknown, given: { handle: string; nonce: string },
): Promise<string> => {
  try {
    await take(response, given);
  } catch (e) {
    if (e instanceof WalletPayeeError) return e.code;
    throw e;
  }
  throw new Error('it was not refused');
};

describe('X8 §2 — the address comes from the wallet, and this side judges it', () => {
  it('THE ASK NAMES A THING AND NEVER AN ANSWER, and the wallet parses it', () => {
    /*
     * **THE CROSS-REPOSITORY EDGE, WALKED RATHER THAN ASSUMED.** The ask is
     * built here and parsed by the WALLET'S OWN parser, so a shape this side
     * gets wrong is a red test here rather than a refusal a person meets in a
     * window they cannot debug.
     */
    const ask = payeeAsk({
      name: 'Payroll', rdns: 'example.payroll', nonce: 'n1', expiresAt: NOW + 60_000,
    });
    const parsed = parseAsk(ask, ORIGIN, NOW);
    expect(parsed.kind).toBe('disclosure');
    expect(parsed.purpose).toBe(PAYEE_PURPOSE);
    if (parsed.kind !== 'disclosure') throw new Error('unreachable');
    expect(parsed.wants.map((w) => w.attribute)).toEqual([RECEIVING_ADDRESS]);
    expect(parsed.wants[0]!.required).toBe(true);
    /* NOWHERE TO PUT AN ADDRESS. Not a check — a shape. The wallet refuses one
     * by name, and this side has no parameter that could supply it. */
    expect(JSON.stringify(ask)).not.toContain('mn_shield-addr_');
    expect(Object.keys(parsed.wants[0]!).sort())
      .toEqual(['attribute', 'reason', 'required']);
  });

  it('A DISCLOSURE FROM A WALLET IS ACCEPTED, AND REBUILT FROM ITS OWN STRING', async () => {
    const given = await issued();
    const got = await take(disclose([derivedSend(shielded(SLOT))], given), given);
    expect(got.address.bech32).toBe(shielded(SLOT));
    /* `A-1`, `C7` — one decode, both halves, and neither can be supplied. */
    const address = privatePayee(got.address);
    expect(address.coinPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(address.encryptionPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(address.coinPublicKey).not.toBe(address.encryptionPublicKey);
    /* And the subwallet that signed is reported, derived from the key. */
    expect(got.signedBy).toBe(signingAddress(SLOT));
  });

  it('AN ADDRESS SOMEBODY TYPED IS NOT ONE THE WALLET WORKED OUT', async () => {
    /*
     * **THIS IS `C153`'s PASTED BOX, ARRIVING WITH A SIGNATURE ROUND IT.**
     *
     * The value is a perfectly good shielded address of the very subwallet that
     * signed — everything else about the message is correct — and it is marked
     * `self`, which means a person typed it. Accepting it would keep `X7`'s
     * precedent alive with wallet chrome around it, and harder to argue with
     * for being signed.
     */
    const given = await issued();
    const typed: Sent = {
      id: 'held-id',
      about: RECEIVING_ADDRESS,
      says: { of: 'value', value: shielded(SLOT) },
      asserted: { by: 'self', formerly: null },
    };
    expect(await refusedWith(disclose([typed], given), given))
      .toBe('not-worked-out-by-the-wallet');
  });

  it('AND A PUBLIC ADDRESS IS ADMITTED, WITH ITS KIND READ OFF THE STRING', async () => {
    /*
     * **THIS TEST USED TO ASSERT THE OPPOSITE, AND THE REVERSAL IS `S12`.**
     * `C250`, `V-105`.
     *
     * It read *AND AN UNSHIELDED ADDRESS IS NOT A PAYEE ADDRESS* and expected
     * `not-a-payee-address`, because until this round the only thing anybody
     * could be paid was a private address. **A company paying its own public
     * address is a real movement** and a vendor may want public
     * settlement, so this door takes either.
     *
     * **NOBODY IS ASKED WHICH KIND IT IS.** The type segment the platform put
     * in the string decides, so a screen cannot offer the question and an
     * operator cannot answer it wrongly.
     *
     * **AND ADMITTING IT IS NOT PAYING AN EMPLOYEE PUBLICLY.**
     * `a-payroll-run-is-always-private.test.ts` is where that refusal lives.
     */
    const given = await issued();
    const got = await take(disclose([derivedSend(signingAddress(SLOT))], given), given);
    expect(got.address.kind).toBe('unshielded');
    expect(got.address.bech32).toBe(signingAddress(SLOT));
    /* Both addresses belong to the same subwallet and they are different
     * values in different key spaces. */
    expect(got.address.bech32).not.toBe(shielded(SLOT));
  });

  it('AND A THIRD KIND OF MIDNIGHT ADDRESS IS STILL REFUSED, NAMING BOTH PAYEES', async () => {
    /*
     * The widening above is two types rather than all of them. A `mn_dust_`
     * address is a Midnight address and is not somebody who can be paid, and
     * the refusal says what a payee is instead of only what this is not.
     */
    const given = await issued();
    const dust = shielded(SLOT).replace('mn_shield-addr_', 'mn_dust_');
    expect(await refusedWith(disclose([derivedSend(dust)], given), given))
      .toBe('not-a-payee-address');
  });

  it('ONE MINTED FOR ANOTHER PAYROLL IS REFUSED HERE', async () => {
    const given = await issued();
    expect(await refusedWith(
      disclose([derivedSend(shielded(SLOT))], { ...given, origin: 'https://elsewhere.example' }),
      given)).toBe('origin-mismatch');
  });

  it('AND A CHALLENGE IS SPENT WHETHER OR NOT WHAT CAME WITH IT WAS ANY GOOD', async () => {
    /*
     * `challenges.ts`'s own rule, and the order was decided by this test rather
     * than by taste: a nonce that survives being presented is a nonce that can
     * be tried against until it expires, which turns a one-use proof into a
     * two-minute window.
     */
    const given = await issued();
    expect(await refusedWith('not a response at all', given)).toBe('not-a-response');
    expect(await refusedWith(disclose([derivedSend(shielded(SLOT))], given), given))
      .toBe('stale-challenge');
  });

  it('AND A NONCE WITHOUT ITS HANDLE IS NOT AN ADDRESS', async () => {
    /* The fixation defence: the handle never leaves this origin. */
    const given = await issued();
    expect(await refusedWith(
      disclose([derivedSend(shielded(SLOT))], given), { ...given, handle: 'somebody else' }))
      .toBe('stale-challenge');
  });

  it('NOTHING SENT IS NOT AN ADDRESS, AND SAYS SO', async () => {
    const given = await issued();
    expect(await refusedWith(disclose([], given), given)).toBe('nothing-disclosed');
  });

  it('AND ANYTHING ELSE IT CARRIES IS REFUSED RATHER THAN KEPT', async () => {
    /* Nothing else was asked for, so keeping it would mean holding data with no
     * record of having requested it — the sign-in's `discloses-something`, one
     * kind of ask over. */
    const given = await issued();
    const extra: Sent = {
      id: 'held-id',
      about: 'email',
      says: { of: 'value', value: 'someone@example.com' },
      asserted: { by: 'self', formerly: null },
    };
    expect(await refusedWith(
      disclose([derivedSend(shielded(SLOT)), extra], given), given))
      .toBe('discloses-something-else');
  });
});
