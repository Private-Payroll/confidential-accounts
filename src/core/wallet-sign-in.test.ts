import { describe, expect, it, vi } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { signatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import { identityFromWords } from 'midnight-identity';
import { addressOfVerifyingKey, mint } from 'midnight-identity/profile/disclosure';
import type { DisclosureResponse } from 'midnight-identity/profile/disclosure';
import type { Sent } from 'midnight-identity/profile/model';
import { MemoryStore, walletKeyOf } from './store.js';
import { MemorySessionStore } from './sessions.js';
import { MemoryRateLimiter } from './rate-limit.js';
import { MemoryChallengeStore } from './challenges.js';
import { TooManyAttempts } from './identity.js';
import { SimulatedLedger, SimulatedCommitments } from './ledger.js';
import { AccountService } from './account.js';
import {
  WalletIdentityService, WalletSignInError, signInAsk, walletSignInOrigin,
} from './wallet-identity.js';
import { PAIR_NETWORK, theNetwork } from '../midnight/network.js';
import type { NetworkName } from '../midnight/network.js';
import { NETWORK as WALLET_NETWORK } from 'midnight-identity/network';

/**
 * **SIGNING IN WITH THE WALLET, AND THE FOUR BINDINGS THAT MAKE IT ONE.**
 * `docs/scope-payroll-identity.md` §4 and §10 step 1, `docs/NEXT.md` PI1.
 *
 * ── EVERY SIGN-IN IN THIS FILE IS REAL ────────────────────────────────────
 *
 * `mint` and `identityFromWords` are imported from `midnight-identity` — the
 * wallet's own package, resolved through its `exports` — so what is handed to
 * the payroll side is bytes the wallet actually produced, signed by a key it
 * actually derived, and checked by the wallet's own `verify`. **Nothing here is
 * a fixture shaped like a signature.** That is the point of depending on the
 * package rather than copying it: if the two sides ever disagreed about a byte,
 * these tests would be the thing that noticed.
 *
 * ── AND THE ORIGINS ARE REAL ORIGINS ──────────────────────────────────────
 *
 * `docs/NEXT.md` §2 asks for the replay to be proved *the way the wallet proved
 * them: with real origins, and by checking the bytes on the receiving side.*
 * `THEM` below is a second, complete origin; a sign-in minted for it is offered
 * to a deployment that calls itself `US`, and refused.
 */

const US = 'https://payroll.example';
const THEM = 'https://other-payroll.example';
const NETWORK = 'undeployed' as const;
const SLOT = 3;
const OTHER_SLOT = 4;

const identity = identityFromWords(TEST_MNEMONIC);

const addressOf = (slot: number): string => addressOfVerifyingKey(
  signatureVerifyingKey({
    tag: 'schnorr',
    value: Buffer.from(identity.moneyAt(slot).night).toString('hex'),
  }).value, NETWORK);

interface World {
  store: MemoryStore;
  sessions: MemorySessionStore;
  wallet: WalletIdentityService;
}

const world = (origin = US): World => {
  const store = new MemoryStore();
  const sessions = new MemorySessionStore();
  const wallet = new WalletIdentityService(
    store, sessions, new MemoryRateLimiter(), new MemoryChallengeStore(),
    { origin, network: NETWORK });
  return { store, sessions, wallet };
};

/** The wallet's side, done properly. `at` is the wallet's clock, not ours. */
const signedBy = (slot: number, parts: {
  origin?: string; nonce: string; address?: string; at?: number;
  disclosed?: readonly Sent[]; declined?: readonly string[];
}): DisclosureResponse => mint(identity, slot, {
  origin: parts.origin ?? US,
  nonce: parts.nonce,
  address: parts.address ?? addressOf(slot),
  at: parts.at ?? Date.now(),
  disclosed: parts.disclosed ?? [],
  declined: parts.declined ?? [],
  requesterSaidItWas: { name: 'Payroll', rdns: 'example.payroll' },
}).response;

const HERE = { ip: '198.51.100.7', userAgent: 'a browser' };

const refusalOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (e) {
    expect(e).toBeInstanceOf(WalletSignInError);
    return (e as WalletSignInError).code;
  }
  throw new Error('should have refused');
};

/* ------------------------------------------------------------------------ */

describe('§10 step 1 — THE WALLET IS THE ACCOUNT', () => {
  it('a wallet that signs OUR nonce for OUR origin becomes a person here', async () => {
    const { wallet, sessions } = world();
    const { nonce, handle } = await wallet.challenge(HERE);
    const r = await wallet.signIn(
      { handle, nonce, response: signedBy(SLOT, { nonce }) }, HERE);

    expect(r.created).toBe(true);
    expect(r.address).toBe(addressOf(SLOT));
    expect(await sessions.resolve(r.session.token)).toBe(r.user.id);
  });

  it('NO EMAIL, NO PASSWORD AND NO NAME — nothing asked for any of them', async () => {
    const { wallet, store } = world();
    const { nonce, handle } = await wallet.challenge(HERE);
    const r = await wallet.signIn(
      { handle, nonce, response: signedBy(SLOT, { nonce }) }, HERE);

    const u = store.getUser(r.user.id)!;
    expect(u.email).toBeNull();
    /*
     * **THE TWO PASSWORD ASSERTIONS ARE STRONGER NOW, NOT WEAKER.**
     *
     * They read `expect(u.authHash).toBeNull()` and the same for `authSalt` —
     * *a wallet account has no password*, checked field by field. **Both fields
     * are deleted from `User`**, so there is nothing left to be null, and the
     * claim this file makes about a password is now made against the whole row
     * rather than two names in it: nothing on it is a credential, and the two
     * that were are not there under any spelling.
     */
    expect(Object.keys(u).sort()).toEqual(
      ['createdAt', 'email', 'id', 'keyBundle', 'keyBundleVersion', 'name', 'walletKey']);
    expect(JSON.stringify(u)).not.toMatch(/authHash|authSalt|password|argon/i);
    /* The address itself is not on the row, only its hash. */
    expect(u.walletKey).toBe(walletKeyOf(addressOf(SLOT)));
    expect(JSON.stringify(u)).not.toContain(addressOf(SLOT));
  });

  it('the same subwallet signing in twice is ONE person, not two', async () => {
    const { wallet } = world();
    const first = await wallet.challenge(HERE);
    const a = await wallet.signIn(
      { ...first, response: signedBy(SLOT, { nonce: first.nonce }) }, HERE);
    const second = await wallet.challenge(HERE);
    const b = await wallet.signIn(
      { ...second, response: signedBy(SLOT, { nonce: second.nonce }) }, HERE);

    expect(b.user.id).toBe(a.user.id);
    expect(b.created).toBe(false);
  });

  it('A DIFFERENT SUBWALLET IS A DIFFERENT PERSON HERE, and that is the design', async () => {
    /*
     * §2: the eleven slots come from one secret, so these two ARE one human —
     * and this platform must not be able to tell. Two rows, never merged.
     */
    const { wallet } = world();
    const one = await wallet.challenge(HERE);
    const a = await wallet.signIn(
      { ...one, response: signedBy(SLOT, { nonce: one.nonce }) }, HERE);
    const two = await wallet.challenge(HERE);
    const b = await wallet.signIn(
      { ...two, response: signedBy(OTHER_SLOT, { nonce: two.nonce }) }, HERE);

    expect(b.user.id).not.toBe(a.user.id);
  });
});

/* ------------------------- binding one: the origin ----------------------- */

describe('BINDING 1 — THE ORIGIN IS OURS, AND IT IS OBSERVED RATHER THAN CLAIMED', () => {
  it('A SIGN-IN MINTED FOR ANOTHER PAYROLL IS REFUSED HERE', async () => {
    const { wallet } = world(US);
    const { nonce, handle } = await wallet.challenge(HERE);
    expect(await refusalOf(() => wallet.signIn(
      { handle, nonce, response: signedBy(SLOT, { nonce, origin: THEM }) }, HERE)))
      .toBe('origin-mismatch');
  });

  it('and the SAME sign-in is accepted by the deployment it was made for', async () => {
    /* The other half of the same fact: it is refused for being somebody
     * else's, not for being malformed. */
    const theirs = world(THEM);
    const { nonce, handle } = await theirs.wallet.challenge(HERE);
    const r = await theirs.wallet.signIn(
      { handle, nonce, response: signedBy(SLOT, { nonce, origin: THEM }) }, HERE);
    expect(r.address).toBe(addressOf(SLOT));
  });

  it('REWRITING THE PAYLOAD TO SAY OUR ORIGIN DOES NOT HELP', async () => {
    /*
     * The tampering replay, checked on the receiving side by the bytes: the
     * signature is over the ORIGINAL preimage, `verify` rebuilds the preimage
     * from the payload it was handed, and the two stop matching.
     */
    const { wallet } = world(US);
    const { nonce, handle } = await wallet.challenge(HERE);
    const theirs = signedBy(SLOT, { nonce, origin: THEM });
    const rewritten = { ...theirs, payload: { ...theirs.payload, origin: US } };
    expect(await refusalOf(() => wallet.signIn(
      { handle, nonce, response: rewritten }, HERE))).toBe('signature-invalid');
  });

  it('the origin this deployment answers to is CONFIGURATION, and it is checked', () => {
    expect(walletSignInOrigin('https://payroll.example/')).toBe('https://payroll.example');
    expect(() => walletSignInOrigin(undefined)).toThrow(/APP_ORIGIN/);
    /* The wallet refuses any observed origin that is not https, so a
     * plain-HTTP deployment cannot be signed in to even locally. */
    expect(() => walletSignInOrigin('http://localhost:5173')).toThrow(/https/);
    expect(() => walletSignInOrigin('https://payroll.example/app')).toThrow(/path/);
  });

  it('AND A LOCAL DEVELOPMENT ORIGIN IS ACCEPTED IN A DEVELOPMENT BUILD, AND ONLY THERE',
    () => {
      /*
       * `http://localhost:5173` was refused for the same reason the wallet
       * refused it, and for the first time a person can click the
       * wallet-to-payroll flow through end to end. **The exception is exact and
       * it is gated**: `usableOrigin` is the wallet's own check, imported, so
       * this deployment enforces the rule the wallet enforces rather than a
       * second copy of it.
       *
       * The refusal above is unchanged and is asserted first, in the posture a
       * real deployment runs in.
       */
      expect(() => walletSignInOrigin('http://localhost:5173')).toThrow(/APP_ORIGIN/);

      vi.stubEnv('VITE_ALLOW_LOCALHOST_ORIGIN', '1');
      expect(walletSignInOrigin('http://localhost:5173')).toBe('http://localhost:5173');
      expect(walletSignInOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');

      /*
       * **AND THE ATTACK IS REFUSED IN BOTH POSTURES.** The `.com` is the whole
       * of it: anything that asks whether a host merely CONTAINS `localhost`
       * hands this deployment's sign-in to whoever registers that name.
       */
      expect(() => walletSignInOrigin('http://localhost.evil.com')).toThrow(/APP_ORIGIN/);
      expect(() => walletSignInOrigin('http://localhost.evil.com:3000')).toThrow(/APP_ORIGIN/);
      expect(() => walletSignInOrigin('http://notlocalhost')).toThrow(/APP_ORIGIN/);

      vi.unstubAllEnvs();
      expect(() => walletSignInOrigin('http://localhost:5173')).toThrow(/APP_ORIGIN/);
    });
});

/* ------------------------- binding two: the nonce ------------------------ */

describe('BINDING 2 — THE NONCE IS OURS, USED ONCE, AND EXPIRES', () => {
  it('A NONCE THIS DEPLOYMENT NEVER ISSUED IS REFUSED', async () => {
    const { wallet } = world();
    const { handle } = await wallet.challenge(HERE);
    expect(await refusalOf(() => wallet.signIn(
      { handle, nonce: 'not-ours', response: signedBy(SLOT, { nonce: 'not-ours' }) }, HERE)))
      .toBe('stale-challenge');
  });

  it('A REPLAYED SIGN-IN IS NOT A SIGN-IN — the second use of a nonce is refused', async () => {
    const { wallet } = world();
    const { nonce, handle } = await wallet.challenge(HERE);
    const response = signedBy(SLOT, { nonce });
    await wallet.signIn({ handle, nonce, response }, HERE);
    expect(await refusalOf(() => wallet.signIn({ handle, nonce, response }, HERE)))
      .toBe('stale-challenge');
  });

  it('a sign-in answering an EARLIER request is refused against the open one', async () => {
    const { wallet } = world();
    const old = await wallet.challenge(HERE);
    const open = await wallet.challenge(HERE);
    expect(await refusalOf(() => wallet.signIn(
      { handle: open.handle, nonce: open.nonce, response: signedBy(SLOT, { nonce: old.nonce }) },
      HERE))).toBe('nonce-mismatch');
  });

  it('A NONCE WITHOUT ITS HANDLE IS NOT A SIGN-IN — the fixation half', async () => {
    /*
     * Somebody who asks this deployment for a nonce, and gets an honest
     * person's wallet to sign it, holds a valid signature. The handle is what
     * they do not hold, and it never leaves the page that asked.
     */
    const { wallet } = world();
    const mine = await wallet.challenge(HERE);
    const theirs = await wallet.challenge(HERE);
    expect(await refusalOf(() => wallet.signIn(
      { handle: theirs.handle, nonce: mine.nonce, response: signedBy(SLOT, { nonce: mine.nonce }) },
      HERE))).toBe('stale-challenge');
  });

  it('a challenge presented ONCE is spent, even when what came with it was rubbish', async () => {
    const { wallet } = world();
    const { nonce, handle } = await wallet.challenge(HERE);
    await refusalOf(() => wallet.signIn({ handle, nonce, response: { nope: true } }, HERE));
    /* The good one now finds nothing: a one-use proof is not a two-minute window. */
    expect(await refusalOf(() => wallet.signIn(
      { handle, nonce, response: signedBy(SLOT, { nonce }) }, HERE))).toBe('stale-challenge');
  });
});

/* ------------------------ binding three: the address --------------------- */

describe('BINDING 3 — THE ADDRESS IS RECOMPUTED FROM THE KEY THAT SIGNED', () => {
  it('A PAYLOAD NAMING AN ADDRESS ITS OWN KEY DOES NOT PRODUCE IS REFUSED', async () => {
    /*
     * Validly signed, by slot 3, saying it is slot 4. Every byte checks out and
     * it is still a lie, so the refusal has to be a comparison rather than a
     * signature check.
     */
    const { wallet } = world();
    const { nonce, handle } = await wallet.challenge(HERE);
    expect(await refusalOf(() => wallet.signIn(
      { handle, nonce, response: signedBy(SLOT, { nonce, address: addressOf(OTHER_SLOT) }) },
      HERE))).toBe('address-not-the-signers');
  });

  it('a key no address can be read from is refused before anything else is', async () => {
    const { wallet } = world();
    const { nonce, handle } = await wallet.challenge(HERE);
    const good = signedBy(SLOT, { nonce });
    expect(await refusalOf(() => wallet.signIn(
      { handle, nonce, response: { ...good, verifyingKey: 'not a key' } }, HERE)))
      .toBe('unusable-key');
  });
});

/* --------------- the one network the two applications share -------------- */

/**
 * **TWO CONSTANTS IN TWO REPOSITORIES THAT MUST BE EQUAL, AND UNTIL THIS FILE
 * NOTHING COMPARED THEM.** `docs/how-money-can-be-lost.md` `C151`.
 *
 * The wallet signed, the person approved, the wallet said so — and payroll
 * refused, telling them the key was wrong. **The key was fine.** Both sides
 * derive the address from the same bytes; a Midnight address is bech32 and the
 * network name is a segment of the string, so one key writes two different
 * addresses on two networks and the comparison in `signIn` was holding one of
 * each up against the other.
 *
 * Every other test in this file runs both halves on `undeployed`, which is what
 * let this through: **a suite that hands the same constant to both sides cannot
 * see them disagree.** So these do the opposite. The address is minted on the
 * value the WALLET is compiled for, imported from the wallet's own package, and
 * offered to a deployment holding the value THIS repository resolved. The
 * literal below is the third party: move either side and it dies here, by name.
 */
describe('ONE NETWORK, AND SOMETHING FAILS IF THE TWO EVER DISAGREE', () => {
  const onNetwork = (slot: number, network: NetworkName): string => addressOfVerifyingKey(
    signatureVerifyingKey({
      tag: 'schnorr',
      value: Buffer.from(identity.moneyAt(slot).night).toString('hex'),
    }).value, network);

  it('WATCHED FAILING: the wallet and payroll name the same Midnight network', () => {
    /*
     * The value is written out rather than compared to itself. `PAIR_NETWORK`
     * IS `WALLET_NETWORK` — that is the repair, and an assertion that says so
     * is a tautology. What this pins is which network the pair agreed on, so
     * that changing it in either repository is a decision somebody has to come
     * here and make on purpose.
     */
    expect(WALLET_NETWORK).toBe('stagenet');
    expect(PAIR_NETWORK).toBe('stagenet');
  });

  it('A SIGN-IN MINTED ON THE WALLET’S NETWORK IS ACCEPTED ON PAYROLL’S', async () => {
    const store = new MemoryStore();
    const wallet = new WalletIdentityService(
      store, new MemorySessionStore(), new MemoryRateLimiter(), new MemoryChallengeStore(),
      { origin: US, network: PAIR_NETWORK });
    const { nonce, handle } = await wallet.challenge(HERE);

    const r = await wallet.signIn({
      handle,
      nonce,
      response: signedBy(SLOT, { nonce, address: onNetwork(SLOT, WALLET_NETWORK) }),
    }, HERE);

    expect(r.address).toBe(onNetwork(SLOT, WALLET_NETWORK));
  });

  it('WATCHED FAILING: THE WALK-THROUGH ITSELF — a payroll on another network refuses '
    + 'a sign-in that is perfectly good', async () => {
    /*
     * The network mismatch reproduced, with no browser and nobody pressing
     * anything: the same key, the same signature, one deployment configured for
     * `preview` and a wallet compiled for `stagenet`.
     */
    const wallet = new WalletIdentityService(
      new MemoryStore(), new MemorySessionStore(), new MemoryRateLimiter(),
      new MemoryChallengeStore(), { origin: US, network: 'preview' });
    const { nonce, handle } = await wallet.challenge(HERE);

    expect(await refusalOf(() => wallet.signIn({
      handle,
      nonce,
      response: signedBy(SLOT, { nonce, address: onNetwork(SLOT, 'stagenet') }),
    }, HERE))).toBe('address-not-the-signers');
  });

  it('WATCHED FAILING: a deployment that names a DIFFERENT network is refused at boot,'
    + ' and the sentence carries both values', () => {
    let said = '';
    try { theNetwork({ MIDNIGHT_NETWORK_ID: 'preview' }); } catch (e) { said = (e as Error).message; }

    /* RED WHEN the refusal stops naming what was asked for, what this pair is
     * compiled for, or where the second value lives - each of which is the
     * thing a person needs to act on it. */
    expect(said).toContain('preview');
    expect(said).toContain(PAIR_NETWORK);
    expect(said).toContain('MIDNIGHT_NETWORK_ID');
    expect(said).toContain('midnight-identity/network');
  });

  it('and naming the pair’s own network, or naming nothing, is the ordinary case', () => {
    /* RED WHEN the environment stops being able to agree, which would make
     * every door that exports the variable refuse. */
    expect(theNetwork({ MIDNIGHT_NETWORK_ID: PAIR_NETWORK })).toBe(PAIR_NETWORK);
    expect(theNetwork({})).toBe(PAIR_NETWORK);
    expect(theNetwork({ MIDNIGHT_NETWORK_ID: '' })).toBe(PAIR_NETWORK);
  });
});

/* ------------------- what the refusal tells the person ------------------- */

/**
 * **THE MESSAGE THAT SENT A PERSON TO THE WRONG PLACE.**
 *
 * *"the key is what says who you are, and the two do not agree"* — accurate
 * about what the code saw, wrong about what had happened, and it points at a
 * wallet when the fault is a setting. **The same key under two network prefixes
 * is a different sentence from two different keys**, and the code can tell them
 * apart: it holds the verifying key, so it can ask whether any network makes
 * this key write exactly the string that arrived.
 *
 * **BOTH ARE STILL REFUSED, WITH THE SAME CODE.** These check words, never a
 * verdict.
 */
describe('THE REFUSAL SAYS WHETHER THE TWO DIFFER ONLY BY NETWORK', () => {
  const onNetwork = (slot: number, network: NetworkName): string => addressOfVerifyingKey(
    signatureVerifyingKey({
      tag: 'schnorr',
      value: Buffer.from(identity.moneyAt(slot).night).toString('hex'),
    }).value, network);

  const refusedBy = async (
    ours: NetworkName, claimed: string,
  ): Promise<WalletSignInError> => {
    const wallet = new WalletIdentityService(
      new MemoryStore(), new MemorySessionStore(), new MemoryRateLimiter(),
      new MemoryChallengeStore(), { origin: US, network: ours });
    const { nonce, handle } = await wallet.challenge(HERE);
    try {
      await wallet.signIn(
        { handle, nonce, response: signedBy(SLOT, { nonce, address: claimed }) }, HERE);
    } catch (e) {
      expect(e).toBeInstanceOf(WalletSignInError);
      return e as WalletSignInError;
    }
    throw new Error('should have refused');
  };

  it('WATCHED FAILING: ONE KEY, TWO NETWORKS — the refusal names both networks and '
    + 'clears the wallet', async () => {
    const e = await refusedBy('preview', onNetwork(SLOT, 'stagenet'));

    expect(e.code).toBe('address-not-the-signers');
    expect(e.message).toContain('stagenet');
    expect(e.message).toContain('preview');
    /* The thing the old sentence got wrong, and the reason the row exists. */
    expect(e.message).toContain('Nothing is wrong with the wallet or the key');
    expect(e.message).not.toContain('the two do not agree');
  });

  it('WATCHED FAILING: TWO KEYS IS STILL THE OLD SENTENCE, and it says nothing about '
    + 'networks', async () => {
    /* Slot 3 signing, claiming slot 4, both written on this deployment’s own
     * network. No network on earth makes this key produce that string. */
    const e = await refusedBy(PAIR_NETWORK, onNetwork(OTHER_SLOT, PAIR_NETWORK));

    expect(e.code).toBe('address-not-the-signers');
    expect(e.message).toContain('the key is what says who you are');
    expect(e.message).not.toContain('network');
  });
});

/* ---------------------- binding four: the signature ---------------------- */

describe('BINDING 4 — A SIGNATURE THAT DOES NOT VERIFY IS A REFUSAL', () => {
  it('ONE FLIPPED CHARACTER IN THE SIGNATURE AND NOBODY IS SIGNED IN', async () => {
    const { wallet, store } = world();
    const { nonce, handle } = await wallet.challenge(HERE);
    const good = signedBy(SLOT, { nonce });
    const flipped = good.signature[0] === 'a' ? 'b' : 'a';
    expect(await refusalOf(() => wallet.signIn(
      { handle, nonce, response: { ...good, signature: flipped + good.signature.slice(1) } },
      HERE))).toBe('signature-invalid');
    /* And nothing was written on the way past. */
    expect(Object.keys(store.snapshot().users)).toHaveLength(0);
  });

  it('something that is not a response at all is refused by name', async () => {
    const { wallet } = world();
    for (const junk of [null, 'a string', 42, [], { payload: null }, { payload: {} }]) {
      /* A CHALLENGE EACH, because presenting one spends it — see `signIn`. */
      const { nonce, handle } = await wallet.challenge(HERE);
      expect(await refusalOf(() => wallet.signIn({ handle, nonce, response: junk }, HERE)))
        .toBe('not-a-response');
    }
  });
});

/* --------------------------- and nothing else ---------------------------- */

describe('A SIGN-IN CARRIES NOTHING ABOUT A PERSON', () => {
  const said: Sent = {
    id: 'v1', about: 'given-name',
    says: { of: 'value', value: 'Sarah' },
    asserted: { by: 'self', formerly: null },
  };

  it('a response carrying details is REFUSED rather than quietly kept', async () => {
    const { wallet } = world();
    const { nonce, handle } = await wallet.challenge(HERE);
    expect(await refusalOf(() => wallet.signIn(
      { handle, nonce, response: signedBy(SLOT, { nonce, disclosed: [said] }) }, HERE)))
      .toBe('discloses-something');
  });

  it('and a list of what was DECLINED is refused too — nothing was asked', async () => {
    const { wallet } = world();
    const { nonce, handle } = await wallet.challenge(HERE);
    expect(await refusalOf(() => wallet.signIn(
      { handle, nonce, response: signedBy(SLOT, { nonce, declined: ['email'] }) }, HERE)))
      .toBe('discloses-something');
  });

  it('the ask this platform sends has no `wants` KEY and no `origin` KEY', () => {
    /*
     * The wallet refuses both BY NAME rather than ignoring them, so an ask that
     * carried either would be refused with nothing shown to the person. The
     * builder has nowhere to put one, which is the strongest form of the rule.
     */
    const ask = signInAsk({
      name: 'Payroll', rdns: 'example.payroll', purpose: 'So we know it is you.',
      nonce: 'n1', expiresAt: 1,
    }) as unknown as Record<string, unknown>;
    expect('wants' in ask).toBe(false);
    expect('origin' in ask).toBe(false);
    expect('origin' in (ask['requester'] as object)).toBe(false);
    expect(ask['kind']).toBe('sign-in');
  });
});

/* -------- §3 — one subwallet, as many companies as the person likes ------- */

/**
 * **THIS BLOCK USED TO PROVE THE OPPOSITE, AND THE DECISION WENT THE OTHER
 * WAY.** `docs/scope-v1-data-model.md` D4.
 *
 * It held `refuseReusedSubwallet` up against two companies and required a
 * throw. The rule it was written for — *one subwallet, one employer* — was
 * decided against on 22 Aug and the platform-side half of it survived the
 * removal, which is how a founder came to be unable to create a second
 * company: `null` is a company that does not exist yet, so nothing filtered
 * the list and any wallet user already on any account was refused.
 *
 * **THE DATA MODEL SAYS *ALREADY TRUE*, AND FOR A WALLET SIGN-IN IT NEVER HAD
 * BEEN.** So these say the fact it records, from the side that can see both
 * memberships: one wallet, two companies, both real, neither refused. The
 * concern the old rule existed for lives in the wallet now, which is the only
 * side that can see every use of a slot rather than only the ones that come
 * with a seat.
 */
describe('§3 — ONE WALLET MAY CREATE AND BELONG TO AS MANY COMPANIES AS IT LIKES', () => {
  const aWalletPerson = async () => {
    const w = world();
    const accounts = new AccountService(
      w.store, new SimulatedLedger(SimulatedCommitments), SimulatedCommitments);
    const { nonce, handle } = await w.wallet.challenge(HERE);
    const person = await w.wallet.signIn(
      { handle, nonce, response: signedBy(SLOT, { nonce }) }, HERE);
    return { ...w, accounts, person };
  };

  it('WATCHED FAILING: the same wallet creates a SECOND company, and it is a real one',
    async () => {
      const { store, accounts, person } = await aWalletPerson();
      const first = await accounts.create(
        'Northwind', [{ name: 'Ada', role: 'admin', userId: person.user.id }], 1);
      const second = await accounts.create(
        'Eastgate', [{ name: 'Ada', role: 'admin', userId: person.user.id }], 1);

      expect(second.account.id).not.toBe(first.account.id);
      /* Both, on the same person, seen from the side that holds both. */
      expect(store.accountsForUser(person.user.id).map(a => a.id).sort())
        .toEqual([first.account.id, second.account.id].sort());
    });

  it('and a THIRD is not a special case either', async () => {
    const { store, accounts, person } = await aWalletPerson();
    for (const name of ['Northwind', 'Eastgate', 'Southgate']) {
      // eslint-disable-next-line no-await-in-loop
      await accounts.create(name, [{ name: 'Ada', role: 'admin', userId: person.user.id }], 1);
    }
    expect(store.accountsForUser(person.user.id)).toHaveLength(3);
  });

  it('THE SAME WALLET TAKING A SEAT ON A COMPANY SOMEBODY ELSE MADE IS NOT REFUSED EITHER',
    async () => {
      /*
       * The other shape of the same fact, and the one the old rule was actually
       * written for: a person joining a second employer with the address the
       * first one already pays. It is their choice — a contractor paid by
       * several companies may want one address so their accountant sees one
       * stream — and the wallet is where they are told, once, in their own
       * wallet, about their own information.
       */
      const { store, accounts, person } = await aWalletPerson();
      const mine = await accounts.create(
        'Northwind', [{ name: 'Ada', role: 'admin', userId: person.user.id }], 1);
      const theirs = await accounts.create(
        'Eastgate', [{ name: 'Rae', role: 'admin', userId: null }], 1);

      const invite = accounts.inviteSigner(
        theirs.account.id, 'Ada', 'ada@northwind.co', 'approver');
      expect(() => accounts.acceptSignerInvite(
        invite.token, person.user.id, 'aa'.repeat(32), 'bb'.repeat(32), 'cc'.repeat(32),
      )).not.toThrow();
      expect(store.accountsForUser(person.user.id).map(a => a.id).sort())
        .toEqual([mine.account.id, theirs.account.id].sort());
    });

  it('NOTHING IN THIS REPOSITORY REFUSES A REUSED SUBWALLET ANY MORE', async () => {
    /*
     * **THE ABSENCE, ASSERTED.** A deletion leaves no code to fail when
     * somebody writes it again, and this is the second time this exact refusal
     * has been removed — the first removal took the warning out and left this
     * check standing, silently, refusing the one case nobody meant to refuse.
     *
     * So the file is gone and this is what notices it coming back. It reads
     * the tree rather than an import, because an import of a file that does
     * not exist is a typecheck error and not a test.
     */
    const { readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const here = fileURLToPath(new URL('.', import.meta.url));
    expect(readdirSync(here)).not.toContain('subwallet-binding.ts');
  });
});

/* ------------------------------------------------------------------------ */

describe('THE DOOR THAT COUNTS IS THIS ONE NOW', () => {
  /**
   * **WHAT MOVED HERE, AND WHY IT HAD TO MOVE RATHER THAN BE DELETED.**
   *
   * `core.test.ts` held *"login itself counts, so no route can forget to"*. The
   * lesson behind it is this project's, not a general one: **the limiter sat
   * finished and uncalled for a day**, which is the same as not having one, so
   * the count was put INSIDE the only function that checks a credential and the
   * argument was made a required constructor parameter.
   *
   * `login` is deleted and those tests went with it. **The lesson did not go
   * anywhere.** This is the door that answers strangers now, and it is where
   * the count has to be — so it is asserted here, at the same level, rather
   * than left as a property nothing watches. Deleting a system and not checking
   * what replaced it is how a hole is left where a feature was.
   *
   * `server.test.ts`'s HTTP half — *429 with `Retry-After`, not 400* — is
   * carried by `invitations.test.ts` §6, over the same limiter and the same
   * class, on a bucket these tests do not touch.
   */
  const metered = (max: number): World => {
    const store = new MemoryStore();
    const sessions = new MemorySessionStore();
    const wallet = new WalletIdentityService(
      store, sessions,
      new MemoryRateLimiter({ ip: { max, windowSeconds: 900 } }),
      new MemoryChallengeStore(),
      { origin: US, network: NETWORK });
    return { store, sessions, wallet };
  };

  it('ASKING FOR A CHALLENGE COUNTS, so nobody can mint nonces for free', async () => {
    const { wallet } = metered(3);
    for (let i = 0; i < 3; i++) await wallet.challenge(HERE);
    await expect(wallet.challenge(HERE)).rejects.toThrow(TooManyAttempts);
  });

  it('AND THE SIGN-IN ITSELF COUNTS — a correct one is refused once the address is over',
    async () => {
      /*
       * The half that matters and the one that is easy to miss: a limit on the
       * challenge alone would leave the expensive check reachable by anybody
       * holding a nonce they were already given. **The RIGHT signature is
       * refused here**, which is the point — the server cannot know an attempt
       * is honest until it has done the work the limit exists to bound.
       */
      const { wallet } = metered(3);
      const first = await wallet.challenge(HERE);
      const second = await wallet.challenge(HERE);

      const ok = await wallet.signIn(
        { ...first, response: signedBy(SLOT, { nonce: first.nonce }) }, HERE);
      expect(ok.created).toBe(true);

      /* Four attempts against a ceiling of three: two challenges, the sign-in
       * that worked, and this one. */
      await expect(wallet.signIn(
        { ...second, response: signedBy(SLOT, { nonce: second.nonce }) }, HERE))
        .rejects.toThrow(TooManyAttempts);
    });

  it('the refusal says how long to wait and nothing about who was asking', async () => {
    const { wallet } = metered(1);
    await wallet.challenge(HERE);
    const e = await wallet.challenge(HERE).catch(x => x);
    expect(e).toBeInstanceOf(TooManyAttempts);
    expect(e.retryAfterSeconds).toBeGreaterThan(0);
    expect(e.message).not.toMatch(/registered|unknown|exists|no such|address|wallet/i);
  });
});
