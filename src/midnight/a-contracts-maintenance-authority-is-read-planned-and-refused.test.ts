/*
 * A contract's maintenance authority: read back off the chain, compared with the one chosen
 * on disk, refused when malformed, and planned into a change, none of it through a harness.
 */
import { keysOnDisk, ACCOUNT_KEYS } from '../../contracts/test/keys-on-disk.js';
import { describe, it, expect } from 'vitest';

/**
 * The two committee refusals of `requireMaintenanceAuthority`, an empty or non-array committee and a threshold
 * outside 1 to the committee size, pinned at the account's validator, the one place a committee is a real answer.
 *
 * The vault's validator, `requireVaultMaintenanceAuthority`, narrows to `single-key` and refuses every other
 * kind by name, and `deployVaultContract` calls it first, so no vault deployment can carry a committee at all.
 * A committee case written there would assert a branch with no product meaning for a vault, and
 * `vault-contract.test.ts`'s own committee case passes a well-formed committee so that it reaches the narrowing
 * refusal it is actually about.
 */
describe('a committee the SDK could never sign with is refused at the account\'s validator', () => {
  const KEY = { tag: 'schnorr', value: 'ff'.repeat(32) } as const;

  it('refuses an EMPTY committee by name, rather than deploying an unmaintainable contract quietly',
    async () => {
    /*
     * An empty committee is the `unmaintainable` state arrived at by omission.
     * The refusal exists so that the two are never the same keystroke: saying
     * *no maintenance, ever* has to be said, and `[]` is not saying it.
     */
    /* At the validator: on a chain `open` deploys nothing, so the account door no longer reaches it. */
    const { requireMaintenanceAuthority } = await import('./partial-contract.js');
    expect(() => requireMaintenanceAuthority({ kind: 'committee', committee: [], threshold: 1 }))
      .toThrow(/needs at least one verifying key/);
  });

  it('refuses a threshold ABOVE the committee size, which is unmaintainable wearing a committee\'s clothes',
    async () => {
    const { requireMaintenanceAuthority } = await import('./partial-contract.js');
    expect(() => requireMaintenanceAuthority({ kind: 'committee', committee: [KEY], threshold: 2 }))
      .toThrow(/cannot have threshold/);
  });

  it('refuses a threshold BELOW one, which is the same refusal reached from the other side',
    async () => {
    /*
     * The guard is one expression with three clauses: non-integer, `< 1`, and `> size`. A case for only the
     * upper bound would stay green if the lower one were dropped.
     */
    const { requireMaintenanceAuthority } = await import('./partial-contract.js');
    expect(() => requireMaintenanceAuthority({ kind: 'committee', committee: [KEY], threshold: 0 }))
      .toThrow(/cannot have threshold/);
  });

  /*
   * The positive control, without which the three refusals above pass on a validator that refuses every
   * committee: a well-formed committee must be accepted and handed back unchanged.
   *
   * It is taken at the validator and not through `open`, because a well-formed committee passes the authority
   * gate and carries on into `submitPartialDeployTx`, against a harness that has no chain, and times out. The
   * three refusals above are taken at the validator too: on a chain `open` deploys nothing, so it does not reach
   * the authority at all. The import resolves through this file's own `vi.doMock`, which spreads the real
   * module, so the validator under test is the shipped one.
   */
  it('and a well-formed committee is accepted, unchanged', async () => {
    const { requireMaintenanceAuthority } = await import('./partial-contract.js');
    const choice = { kind: 'committee' as const, committee: [KEY], threshold: 1 };
    expect(requireMaintenanceAuthority(choice)).toEqual(choice);
  });
});

/**
 * Every committee key below is a fixed public constant, not a generated one. `AUTH_KEY_1`, `_2` and `_3` are the
 * verifying keys of the signing values 1, 2 and 3, the secp256k1 generator and its first two multiples, published
 * everywhere. They are literals so that no key is generated and nothing is deployed every time the suite runs.
 *
 * `LIVE_*` are what the chain actually answered on 5 Sep for the contracts deployed on stagenet, read with one
 * query each. They are here so the shape this file asserts is the shape the chain really produced, rather than
 * one invented to match the code.
 */
describe('reading a deployed contract\'s maintenance authority back off the chain', () => {
  const authKey = (value: string) => ({ tag: 'schnorr', value });
  const AUTH_KEY_1 = authKey('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  const AUTH_KEY_2 = authKey('c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5');
  const AUTH_KEY_3 = authKey('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9');
  const LIVE_ACCOUNT_KEY = authKey('50101e92e4679df5c9ddac69c5acb491d24ee42467e972d97ff99960a94ae8b1');

  const stateWith = (committee: unknown[], threshold: number, counter: unknown = 0n) =>
    ({ data: {}, maintenanceAuthority: { committee, threshold, counter } });

  it('reads the committee, the threshold and the counter off a queried contract state', async () => {
    const { readContractAuthority } = await import('./ledger.js');
    const r = await readContractAuthority(
      async () => stateWith([AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], 2, 4n), 'addr',
    );
    expect(r.state).toBe('read');
    if (r.state !== 'read') return;
    expect(r.authority.committee).toEqual([AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3]);
    expect(r.authority.threshold).toBe(2);
    expect(r.authority.counter).toBe(4n);
    expect(r.authority.shape).toBe('committee');
  });

  it('reads a committee the same way it reads one key, because it consults no signing key', async () => {
    /*
     * A committee switches the SDK's whole maintenance interface off for that contract, permanently: every SDK
     * entry point opens by asserting a stored signing key, and under a committee none is stored. This read is a
     * ledger property and touches no key, so the two cost the same, and that is pinned here.
     */
    const { readContractAuthority } = await import('./ledger.js');
    const one = await readContractAuthority(async () => stateWith([AUTH_KEY_1], 1), 'a');
    const many = await readContractAuthority(
      async () => stateWith([AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], 3), 'b');
    expect(one.state).toBe('read');
    expect(many.state).toBe('read');
    if (one.state !== 'read' || many.state !== 'read') return;
    /*
     * The contents, not only the state: asserting only `state === 'read'` would pass against any implementation
     * that returned a `read` with a garbage authority, or one that silently truncated the committee to one key.
     */
    expect(one.authority.committee).toEqual([AUTH_KEY_1]);
    expect(one.authority.threshold).toBe(1);
    expect(many.authority.committee).toEqual([AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3]);
    expect(many.authority.threshold).toBe(3);
    expect(many.authority.shape).toBe('committee');
  });

  it('calls a threshold of zero `anyone` and never `no-one`, at any committee size', async () => {
    /*
     * The most dangerous value on chain must not be reported with the name of the safest. The ledger's only read
     * of `threshold` is `if self.signatures.len() < authority.threshold`, so at zero an update with no signatures
     * is well formed and the committee is never consulted. `no-one` is this codebase's word for `unmaintainable`,
     * which is the exact opposite state.
     */
    const { authorityShapeOf } = await import('./ledger.js');
    expect(authorityShapeOf([], 0)).toBe('anyone');
    expect(authorityShapeOf([AUTH_KEY_1], 0)).toBe('anyone');
    expect(authorityShapeOf([AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], 0)).toBe('anyone');
    expect(authorityShapeOf([], 0)).not.toBe('no-one');
    expect(authorityShapeOf([AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], 0)).not.toBe('committee');
  });

  it('reports a committee that lists one key more than once, because its threshold is not what it looks like', async () => {
    /*
     * The data a signer signs does not cover the signer index, so one signature is valid at every index whose
     * committee slot holds that key, and `[K,K,K]` at threshold 3 is satisfied by one holder of `K`.
     * `requireMaintenanceAuthority` checks size and range and not distinctness.
     */
    const { readContractAuthority } = await import('./ledger.js');
    const dup = await readContractAuthority(
      async () => stateWith([AUTH_KEY_1, AUTH_KEY_1, AUTH_KEY_2], 3), 'a');
    const clean = await readContractAuthority(
      async () => stateWith([AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], 3), 'b');
    expect(dup.state).toBe('read');
    expect(clean.state).toBe('read');
    if (dup.state !== 'read' || clean.state !== 'read') return;
    expect(dup.authority.hasDuplicateMembers).toBe(true);
    expect(clean.authority.hasDuplicateMembers).toBe(false);
  });

  it('reports the SHAPE of the value and never claims to know which kind was chosen', async () => {
    /*
     * Measured, byte-identical: a `single-key` authority over one key and a `committee` of that one key at
     * threshold one serialize to the same bytes. The chain carries no kind, so anything reading `one-key` as
     * "the choice was `single-key`" is reading something that is not there.
     */
    const { authorityShapeOf } = await import('./ledger.js');
    expect(authorityShapeOf([AUTH_KEY_1], 1)).toBe('one-key');
    expect(authorityShapeOf([AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], 2)).toBe('committee');
    expect(authorityShapeOf([AUTH_KEY_1], 2)).toBe('no-one');
    expect(authorityShapeOf([], 1)).toBe('no-one');
  });

  it('answers `absent` and not `unreachable` when the provider holds no state', async () => {
    const { readContractAuthority } = await import('./ledger.js');
    expect((await readContractAuthority(async () => null, 'addr')).state).toBe('absent');
  });

  it('answers `unreachable` and not `absent` when the provider throws', async () => {
    /* An unreachable chain is not an empty one. */
    const { readContractAuthority } = await import('./ledger.js');
    const r = await readContractAuthority(async () => { throw new Error('ECONNREFUSED'); }, 'addr');
    expect(r.state).toBe('unreachable');
    if (r.state !== 'unreachable') return;
    expect(r.why).toContain('ECONNREFUSED');
  });

  it('refuses state whose authority field is missing or the wrong shape rather than guessing', async () => {
    const { readContractAuthority } = await import('./ledger.js');
    expect((await readContractAuthority(async () => ({ data: {} }), 'a')).state).toBe('unreadable');
    /* A `counter` that arrived as a number rather than a bigint is a changed
     * runtime, not a readable authority. It refuses instead of comparing. */
    const wrong = await readContractAuthority(
      async () => stateWith([AUTH_KEY_1], 1, 0), 'a');
    expect(wrong.state).toBe('unreadable');
    if (wrong.state !== 'unreadable') return;
    expect(wrong.why).toContain('counter');
  });

  it('reads the shape the stagenet account contract actually answered on 5 Sep', async () => {
    const { authorityFromContractState } = await import('./ledger.js');
    const a = authorityFromContractState(stateWith([LIVE_ACCOUNT_KEY], 1, 0n));
    expect('why' in a).toBe(false);
    if ('why' in a) return;
    expect(a.committee).toEqual([LIVE_ACCOUNT_KEY]);
    expect(a.threshold).toBe(1);
    expect(a.shape).toBe('one-key');
  });

  it('reads every committee key in lower case, whatever case the chain\'s state carries it in', async () => {
    /* RED WHEN: the authority is read by anything but `authorityIn`, so a key's digits are kept as the state wrote them. */
    const { authorityFromContractState } = await import('./ledger.js');
    const a = authorityFromContractState(stateWith([authKey(LIVE_ACCOUNT_KEY.value.toUpperCase())], 1, 0n));
    expect('why' in a).toBe(false);
    if ('why' in a) return;
    expect(a.committee).toEqual([LIVE_ACCOUNT_KEY]);
  });

  it.each([
    ['a committee key that is not hex digits', [authKey('not-a-key')], 1, 0n],
    ['a committee key written with a 0x prefix', [authKey('0x' + LIVE_ACCOUNT_KEY.value)], 1, 0n],
    ['a threshold below zero', [LIVE_ACCOUNT_KEY], -1, 0n],
    ['a threshold too large to be a whole number the chain could hold', [LIVE_ACCOUNT_KEY], 2 ** 60, 0n],
    ['a counter below zero', [LIVE_ACCOUNT_KEY], 1, -1n],
  ])('refuses %s instead of reading it as an authority', async (_name, committee, threshold, counter) => {
    /* RED WHEN: the authority is read by anything but `authorityIn`, so a key, a threshold or a counter it refuses is accepted. */
    const { authorityFromContractState, readContractAuthority } = await import('./ledger.js');
    expect('why' in authorityFromContractState(stateWith(committee, threshold, counter))).toBe(true);
    expect((await readContractAuthority(async () => stateWith(committee, threshold, counter), 'a')).state).toBe('unreadable');
  });

  it('still counts a key listed twice when only the case of its kind differs', async () => {
    /* RED WHEN: the duplicate check stops folding the kind of key, so a committee listing one key twice reads as two members. */
    const { authorityFromContractState } = await import('./ledger.js');
    const a = authorityFromContractState(stateWith([
      { tag: 'Schnorr', value: LIVE_ACCOUNT_KEY.value }, LIVE_ACCOUNT_KEY,
    ], 2, 0n));
    expect('why' in a).toBe(false);
    if ('why' in a) return;
    expect(a.hasDuplicateMembers).toBe(true);
  });

  it('keeps two members with the same digits and a different kind of key apart', async () => {
    /* RED WHEN: the duplicate check ignores the kind of key, so two kinds of key sharing digits read as one member listed twice. */
    const { authorityFromContractState } = await import('./ledger.js');
    const a = authorityFromContractState(stateWith([
      { tag: 'schnorr', value: LIVE_ACCOUNT_KEY.value }, { tag: 'other', value: LIVE_ACCOUNT_KEY.value },
    ], 2, 0n));
    expect('why' in a).toBe(false);
    if ('why' in a) return;
    expect(a.hasDuplicateMembers).toBe(false);
  });
});

describe('comparing the chain against the maintenance authority chosen on disk', () => {
  const authKey = (value: string) => ({ tag: 'schnorr', value });
  const AUTH_KEY_1 = authKey('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  const AUTH_KEY_2 = authKey('c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5');
  const AUTH_KEY_3 = authKey('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9');

  /**
   * A placeholder address, for the same reason the signing key below is one. The address is only ever carried
   * through `readOf` into `compareAuthority`, which copies it onto its result and never compares it: every branch
   * decides on `threshold`, `committee` and order. So a placeholder exercises exactly the same paths. A literal
   * address would also go stale the day the account contract is redeployed, leaving a public repository whose
   * tests name a dead address, and a test that read it from a fixture would fail in any clone that has no such
   * deployment to reach.
   */
  const PLACEHOLDER_ACCOUNT_ADDRESS = 'an-account-address-that-is-not-a-real-one';

  /**
   * The account's real on-chain VERIFYING key, and it stays. It is on a public
   * chain, it is the value this comparison is actually about, and it is not a
   * value any secret root carries.
   */
  const LIVE_ACCOUNT_KEY = authKey('50101e92e4679df5c9ddac69c5acb491d24ee42467e972d97ff99960a94ae8b1');

  /**
   * A placeholder signing key; the real one is deliberately not here. A real signing key for a maintenance
   * authority lets whoever holds it swap `recordPayment`'s verifier key and every vault's unshielded money
   * leaves, and this file is tracked in a public repository. A placeholder buys the same coverage, because the
   * constant is only ever compared against itself through `derive` below. A test cannot establish that two real
   * keys correspond; only the chain can, and that is checked against the live chain at run time.
   *
   * The verifying key above is the account's real on-chain one and stays: it is on a public chain and is the
   * value this comparison is about.
   */
  const PLACEHOLDER_SIGNING_KEY = authKey('a-signing-key-that-is-not-a-real-one');

  /** The runtime's derivation, stubbed. Never the runtime's own on this path. */
  const derive = (sk: { tag: string; value: string }) =>
    sk.value === PLACEHOLDER_SIGNING_KEY.value ? LIVE_ACCOUNT_KEY : authKey(`vk-of-${sk.value}`);

  const readOf = (committee: unknown[], threshold: number, counter: bigint, shape: string,
                  address = 'addr') =>
    ({ state: 'read' as const, address, authority: { committee, threshold, counter, shape } });

  it('says AGREE when the chain carries the key the single-key file on disk derives to', async () => {
    /* The pair a single-key choice produces: its signing key derives to the verifying key the stagenet account
     * carries. */
    const { compareAuthority, intendedAuthorityValue } = await import('./ledger.js');
    const intended = intendedAuthorityValue(
      { kind: 'single-key', signingKey: PLACEHOLDER_SIGNING_KEY,
        temporary: { fixedBy: 'a later replacement' } } as never, derive as never);
    const r = compareAuthority(
      readOf([LIVE_ACCOUNT_KEY], 1, 0n, 'one-key', PLACEHOLDER_ACCOUNT_ADDRESS) as never, intended);
    expect(r.verdict).toBe('agree');
  });

  it('says AGREE when only the replay counter differs, because the end state is what is compared', async () => {
    /* The live authority is compared against the intended end state, not against a counter. A settled contract
     * whose counter has moved is settled. */
    const { compareAuthority } = await import('./ledger.js');
    const r = compareAuthority(
      readOf([AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], 2, 9n, 'committee') as never,
      { committee: [AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], threshold: 2 });
    expect(r.verdict).toBe('agree');
  });

  it('says DISAGREE when the chain carries a different key set at the same threshold', async () => {
    const { compareAuthority } = await import('./ledger.js');
    const r = compareAuthority(
      readOf([AUTH_KEY_1, AUTH_KEY_2], 2, 0n, 'committee') as never,
      { committee: [AUTH_KEY_1, AUTH_KEY_3], threshold: 2 });
    expect(r.verdict).toBe('disagree');
  });

  it('says DISAGREE when the chain still carries one key and a committee was intended', async () => {
    /* The half-applied change: the account took the update and a vault did not, or the reverse. Either way this
     * is what it looks like. */
    const { compareAuthority } = await import('./ledger.js');
    const r = compareAuthority(
      readOf([AUTH_KEY_1], 1, 0n, 'one-key') as never,
      { committee: [AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], threshold: 2 });
    expect(r.verdict).toBe('disagree');
  });

  it('says DISAGREE and names the reason when the members match but the order does not', async () => {
    /* Measured: the same three keys in a different order serialize to different bytes, so the on-chain value
     * differs while the signers do not. Said out loud so nobody spends a real update replacing a value with an
     * equivalent one. */
    const { compareAuthority } = await import('./ledger.js');
    const r = compareAuthority(
      readOf([AUTH_KEY_3, AUTH_KEY_2, AUTH_KEY_1], 2, 0n, 'committee') as never,
      { committee: [AUTH_KEY_1, AUTH_KEY_2, AUTH_KEY_3], threshold: 2 });
    expect(r.verdict).toBe('disagree');
    expect(r.why).toContain('SAME MEMBERS, DIFFERENT ORDER');
  });

  it('says UNKNOWN and never DISAGREE when the chain could not be asked', async () => {
    /*
     * "The ledger cannot answer" is not "the answer is no". A comparison returning `disagree` here would send a
     * caller to re-sign and resubmit a maintenance update against a chain it never read.
     */
    const { compareAuthority } = await import('./ledger.js');
    const r = compareAuthority(
      { state: 'unreachable', address: 'addr', why: 'the indexer did not answer' },
      { committee: [AUTH_KEY_1], threshold: 1 });
    expect(r.verdict).toBe('unknown');
    expect(r.verdict).not.toBe('disagree');
  });

  it('says UNKNOWN and not DISAGREE when the provider holds no state for the address', async () => {
    /*
     * `queryContractState` answers `null` both for an address with no contract and for an indexer that has not
     * caught up, and cannot tell them apart. Reading it as "your change did not land" would be a definite
     * negative from an ambiguous answer.
     */
    const { compareAuthority } = await import('./ledger.js');
    const r = compareAuthority(
      { state: 'absent', address: 'addr', why: 'no contract state at this address' },
      { committee: [AUTH_KEY_1], threshold: 1 });
    expect(r.verdict).toBe('unknown');
  });

  it('REFUSES to compare a chosen threshold of zero rather than agreeing about it', async () => {
    /*
     * A 0 typed into a committee choice would otherwise make `intendedAuthorityValue` return `threshold: 0`, the
     * chain carry 0, and `compareAuthority` answer `agree` over a contract anybody in the world can maintain. A
     * comparator that agrees about a value neither side should ever hold is worse than one that refuses.
     */
    const { intendedAuthorityValue } = await import('./ledger.js');
    expect(() => intendedAuthorityValue(
      { kind: 'committee', committee: [AUTH_KEY_1, AUTH_KEY_2], threshold: 0 } as never,
      derive as never)).toThrow(/threshold below one|NO SIGNATURES AT ALL/);
  });

  it('projects all three choices to the on-chain value each one installs', async () => {
    /* A committee installs as given, a single key as a committee of its verifying key at threshold one, and the
     * unmaintainable choice as an empty committee at threshold one. This restates that so a comparison is
     * possible without deploying, and goes red if the mapping changes. */
    const { intendedAuthorityValue } = await import('./ledger.js');
    const chosen = (c: unknown) => intendedAuthorityValue(c as never, derive as never);
    expect(chosen({ kind: 'unmaintainable' })).toEqual({ committee: [], threshold: 1 });
    expect(chosen({ kind: 'committee', committee: [AUTH_KEY_1, AUTH_KEY_2], threshold: 2 }))
      .toEqual({ committee: [AUTH_KEY_1, AUTH_KEY_2], threshold: 2 });
    expect(chosen({ kind: 'single-key', signingKey: PLACEHOLDER_SIGNING_KEY,
      temporary: { fixedBy: 'x' } }))
      .toEqual({ committee: [LIVE_ACCOUNT_KEY], threshold: 1 });
  });
});

/**
 * No signing key in this file is secret, and that is structural rather than careful. The keys below are derived
 * at run time from the integers 1, 2 and 3: their verifying keys are the secp256k1 generator and its first two
 * multiples, printed in every textbook and already pinned in this file above as `AUTH_KEY_1`, `AUTH_KEY_2`,
 * `AUTH_KEY_3`. There is no value here that is worth anything to anybody, and no literal signing key at all.
 */
/** One instant for every ledger-9 harness below. */
const NOW = new Date();
const NOW_SECONDS = BigInt(Math.floor(NOW.getTime() / 1000));
const ttl = () => new Date(NOW.getTime() + 1_800_000);

describe('what a maintenance authority may not be, refused before anything is built', () => {
  const key = (v: string) => ({ tag: 'schnorr', value: v });
  const K1 = key('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  const K2 = key('c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5');
  const K3 = key('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9');
  const strict = { emptyCommitteeIsDeliberate: false };

  it('refuses a threshold of zero and calls it WORLD-WRITABLE, never unmaintainable', async () => {
    /* The naming matters: this state must not be reported with the word for its opposite. Measured on ledger 9:
     * an update with no signatures at all is well formed against it. */
    const { authorityValueRefusals } = await import('./ledger.js');
    const r = authorityValueRefusals([K1, K2, K3], 0, strict);
    expect(r.map((x) => x.code)).toContain('threshold-below-one');
    expect(r.find((x) => x.code === 'threshold-below-one')!.why)
      .toMatch(/at zero anybody could change the contract's rules with no signature at all/);
    expect(authorityValueRefusals([K1], -1, strict).map((x) => x.code))
      .toContain('threshold-below-one');
    expect(authorityValueRefusals([K1, K2], 1.5, strict).map((x) => x.code))
      .toContain('threshold-below-one');
  });

  it('refuses a threshold above the committee size, and a REMOVAL reaches it without touching the threshold', async () => {
    /* There is no "remove a member" instruction. Removing four of seven and leaving the threshold at five
     * arrives as `(committee=[3], threshold=5)`, indistinguishable from typing 5-of-3, which is why the check is
     * on the pair. A check that fired only on a changed threshold field would miss this entire path. */
    const { authorityValueRefusals } = await import('./ledger.js');
    expect(authorityValueRefusals([K1, K2, K3], 5, strict).map((x) => x.code))
      .toContain('threshold-above-committee');
    expect(authorityValueRefusals([K1], 2, strict).map((x) => x.code))
      .toContain('threshold-above-committee');
    expect(authorityValueRefusals([K1, K2, K3], 3, strict)).toEqual([]);
  });

  it('refuses a committee that lists one key more than once, and says the threshold is not what it looks like', async () => {
    /* Measured on ledger 9: one holder of `K` signs once and attaches that signature at seats 0, 1 and 2 of
     * `[K,K,K]` at threshold 3, and the transaction is well formed. `requireMaintenanceAuthority` does not
     * check this: it checks size and range. */
    const { authorityValueRefusals } = await import('./ledger.js');
    const r = authorityValueRefusals([K1, K2, K1], 3, strict);
    expect(r.map((x) => x.code)).toContain('repeated-committee-member');
    expect(r.find((x) => x.code === 'repeated-committee-member')!.why)
      .toMatch(/keys 1 and 3 are the same key/);
    /* Case-folded, because a committee is compared case-insensitively everywhere
     * else in this module and a duplicate that differs only in case is a
     * duplicate. */
    expect(authorityValueRefusals(
      [K1, { tag: 'SCHNORR', value: K1.value.toUpperCase() }], 2, strict,
    ).map((x) => x.code)).toContain('repeated-committee-member');
  });

  it('refuses an emptied committee unless emptying it is a NAMED choice', async () => {
    /* An empty committee arrived at by removal is byte-identical to the
     * deliberate `unmaintainable` choice, and nothing afterwards can tell them
     * apart — so only a named choice may produce it. The flag has no default,
     * because a default is how the accident happens. */
    const { authorityValueRefusals } = await import('./ledger.js');
    expect(authorityValueRefusals([], 1, strict).map((x) => x.code))
      .toContain('committee-emptied');
    expect(authorityValueRefusals([], 1, { emptyCommitteeIsDeliberate: true }))
      .toEqual([]);
  });

  it('refuses a malformed committee key rather than seating one nobody can sign for', async () => {
    const { authorityValueRefusals } = await import('./ledger.js');
    expect(authorityValueRefusals([K1, { tag: 'schnorr', value: '' }], 2, strict)
      .map((x) => x.code)).toContain('malformed-committee-key');
    expect(authorityValueRefusals([K1, { tag: '  ', value: K2.value }], 2, strict)
      .map((x) => x.code)).toContain('malformed-committee-key');
  });

  it('requireBuildableAuthority throws with EVERY reason, not the first one', async () => {
    /* A caller that fixes one refusal and resubmits should not discover the next
     * one on the next round trip. */
    const { requireBuildableAuthority } = await import('./ledger.js');
    let message = '';
    try { requireBuildableAuthority([K1, K1], 0, strict); } catch (e) { message = String(e); }
    expect(message).toMatch(/threshold-below-one/);
    expect(message).toMatch(/repeated-committee-member/);
    expect(requireBuildableAuthority([K1, K2, K3], 2, strict))
      .toEqual({ committee: [K1, K2, K3], threshold: 2 });
  });
});

describe('planning one contract\'s authority change, where UNKNOWN refuses', () => {
  const key = (v: string) => ({ tag: 'schnorr', value: v });
  const K1 = key('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  const K2 = key('c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5');
  const K3 = key('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9');
  const strict = { emptyCommitteeIsDeliberate: false };
  const readOf = (
    committee: { tag: string; value: string }[], threshold: number, counter: bigint,
  ) => ({
    state: 'read' as const, address: 'addr',
    authority: {
      committee, threshold, counter,
      shape: 'committee' as const, hasDuplicateMembers: false,
    },
  });

  it('the deliberate unmaintainable state is buildable and the 2-of-1 accident is not', async () => {
    /* The chosen unmaintainable authority is `([], 1)`, so it is itself an over-threshold state, and the
     * accident this refusal exists for is the same pair of numbers. The named flag is the only thing that
     * separates them. */
    const { authorityValueRefusals } = await import('./ledger.js');
    expect(authorityValueRefusals([], 1, { emptyCommitteeIsDeliberate: true })).toEqual([]);
    expect(authorityValueRefusals([K1], 2, { emptyCommitteeIsDeliberate: true })
      .map((x) => x.code)).toContain('threshold-above-committee');
  });

  it('REFUSES when the chain could not be asked, and never calls that a disagreement', async () => {
    /* A plan that read "the chain could not be asked" as "build it again" would re-sign against a chain it
     * never read and spend a real update on a contract that may already be correct. */
    const { planAuthorityReplacement } = await import('./ledger.js');
    for (const read of [
      { state: 'unreachable' as const, address: 'a', why: 'the indexer did not answer' },
      { state: 'absent' as const, address: 'a', why: 'nothing is deployed there' },
      { state: 'unreadable' as const, address: 'a', why: 'no maintenanceAuthority field' },
    ]) {
      const p = planAuthorityReplacement(read, { committee: [K1, K2, K3], threshold: 2 }, strict);
      expect(p.action).toBe('refuse');
      expect(p.why).toMatch(/NOTHING MAY BE BUILT/);
      expect(p.action === 'refuse' && p.comparison?.verdict).toBe('unknown');
    }
  });

  it('says SETTLED and builds nothing when the chain already carries the end state', async () => {
    /* Re-running a maintenance change on a contract already at that state does nothing. It is not a retry: a
     * byte-identical resubmission hits `ReplayCounterMismatch`, an error that carries only the address and
     * cannot say whose update landed. */
    const { planAuthorityReplacement } = await import('./ledger.js');
    const p = planAuthorityReplacement(
      readOf([K1, K2, K3], 2, 7n), { committee: [K1, K2, K3], threshold: 2 }, strict);
    expect(p.action).toBe('settled');
    expect(p.why).toMatch(/no-op/);
  });

  it('builds against the counter JUST READ and expects exactly one more', async () => {
    /* The counter is inside the signed data, so every signature collected against an older one is dead. The
     * expected counter is derived here rather than taken from a caller. */
    const { planAuthorityReplacement } = await import('./ledger.js');
    const p = planAuthorityReplacement(
      readOf([K1], 1, 4n), { committee: [K1, K2, K3], threshold: 2 }, strict);
    expect(p.action).toBe('build');
    if (p.action !== 'build') throw new Error('unreachable');
    expect(p.updateCounter).toBe(4n);
    expect(p.expectedCounter).toBe(5n);
    expect(p.intended).toEqual({ committee: [K1, K2, K3], threshold: 2 });
  });

  it('refuses an unbuildable intended value without asking the chain for a verdict on it', async () => {
    /* The refusal set runs before the comparison, so a `0` typed into a choice can never reach a comparison that
     * would agree about it. */
    const { planAuthorityReplacement } = await import('./ledger.js');
    const p = planAuthorityReplacement(readOf([K1], 0, 0n), { committee: [K1], threshold: 0 }, strict);
    expect(p.action).toBe('refuse');
    expect(p.action === 'refuse' && p.comparison).toBeUndefined();
    expect(p.action === 'refuse' && p.refusals.map((r) => r.code)).toContain('threshold-below-one');
  });
});

describe('the end-state record, and the counter that says something else happened here', () => {
  const key = (v: string) => ({ tag: 'schnorr', value: v });
  const K1 = key('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  const K2 = key('c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5');
  const record = {
    address: 'addr', label: 'ACCOUNT', committee: [K1, K2], threshold: 2,
    builtAgainstCounter: 3n, expectedCounter: 4n, verifierKeyInserts: [], builtAt: 'x',
  };
  const readOf = (
    committee: { tag: string; value: string }[], threshold: number, counter: bigint,
  ) => ({
    state: 'read' as const, address: 'addr',
    authority: {
      committee, threshold, counter, shape: 'committee' as const, hasDuplicateMembers: false,
    },
  });

  it('SETTLED only when the value AND the counter are what the record expected', async () => {
    const { checkEndState } = await import('./ledger.js');
    expect(checkEndState(record, readOf([K1, K2], 2, 4n)).verdict).toBe('settled');
  });

  it('UNEXPLAINED when the value matches and the counter has moved past it', async () => {
    /* The counter can never be rolled back or reset below `u32::MAX`, so it is the one monotonic witness the
     * chain offers. Without it, `agree` cannot tell "we installed this" from "somebody replaced it, did
     * something else in the same update, and put an identical authority back": one `MaintenanceUpdate` carries a
     * `ReplaceAuthority` and a `VerifierKeyInsert` in the same array, which is how a verifier-key swap would be
     * packaged. It is neither a pass nor a failure and must not be printed as either. */
    const { checkEndState } = await import('./ledger.js');
    const c = checkEndState(record, readOf([K1, K2], 2, 9n));
    expect(c.verdict).toBe('unexplained');
    expect(c.comparison.verdict).toBe('agree');
    expect(c.why).toMatch(/THE VALUE MATCHES AND THE COUNTER DOES NOT/);
    expect(c.why).toMatch(/verifier keys back/);
  });

  it('NOT-YET when the value differs, and UNKNOWN when the chain could not be asked', async () => {
    const { checkEndState } = await import('./ledger.js');
    expect(checkEndState(record, readOf([K1], 1, 4n)).verdict).toBe('not-yet');
    expect(checkEndState(record, {
      state: 'unreachable', address: 'addr', why: 'the indexer did not answer',
    }).verdict).toBe('unknown');
  });

  it('carries no field a signing key fits, checked rather than promised', async () => {
    /* A record is a plaintext home for whatever is put in it, and this one is meant to be durable and readable
     * by a second device. The keys in it are verifying keys, which are already on a public chain. */
    const keys = Object.keys(record);
    expect(keys.some((k) => /signing|secret|private|seed/i.test(k))).toBe(false);
  });
});

/**
 * The measurements, against the build the node pins.
 *
 * Everything below runs on `@midnightntwrk/ledger-v9@1.0.0-rc.3`, the build the node pins, and nothing in it
 * proves, deploys, submits, spends, or contacts a chain: a `LedgerState.blank` in memory, a contract deployed
 * into that object, and `Transaction.wellFormed` with proofs disabled and signature verification on. These run
 * against the shipped artefact, which is the measurement; the ledger's Rust source (`ledger-9.1.0.0-rc.3`) is
 * the reading.
 *
 * The signing keys are the integers 1, 2 and 3. Their verifying keys are the secp256k1 generator and its first
 * two multiples, the values already pinned above as `AUTH_KEY_1`/`_2`/`_3`. Nothing secret exists in this file.
 */
describe('what ledger 9 actually accepts, measured', () => {
  const NET = 'undeployed';
  const be = (n: number) => { const b = new Uint8Array(32); b[31] = n; return b; };

  const load = async () => {
    const L: any = await import('@midnightntwrk/ledger-v9');
    const sks = [1, 2, 3].map((n) => L.signingKeyFromBip340(be(n)));
    const vks = sks.map((sk: unknown) => L.signatureVerifyingKey(sk));
    const strictness = () => {
      const s = new L.WellFormedStrictness();
      s.enforceBalancing = false; s.verifyNativeProofs = false;
      s.verifyContractProofs = false; s.enforceLimits = false; s.verifySignatures = true;
      return s;
    };
    /*
     * One instant for the block context, the TTL and `tblock`, and a TTL well inside the window. Measured: the
     * ledger refuses an intent whose TTL is more than 3600 seconds past the block context's `secondsSinceEpoch`
     * (`+3600` applies, `+3601` throws `IntentTtlTooFarInFuture`). A harness that froze the block context and
     * then took `Date.now() + 3600_000` per call would put every later intent over the edge as seconds elapsed,
     * and fail part-way through on code that was correct. `ttl()` is half the window, from the same instant.
     */
    const blockContext = {
      secondsSinceEpoch: NOW_SECONDS, secondsSinceEpochErr: 30,
      parentBlockHash: '00'.repeat(32), lastBlockTime: NOW_SECONDS - 6n,
    };
    /* A contract really deployed into an in-memory state, because `LedgerState.updateIndex` takes a
     * ChargedState and carries no authority: a harness built on it silently tests the blank default instead of
     * the committee it thinks it installed, and answers "not a committee member" to everything. */
    const deployWith = (committee: unknown[], threshold: number) => {
      const cs = new L.ContractState();
      cs.maintenanceAuthority = new L.ContractMaintenanceAuthority(committee, threshold, 0n);
      const dep = new L.ContractDeploy(cs);
      const intent = L.Intent.new(ttl()).addDeploy(dep);
      const tx = L.Transaction.fromParts(NET, undefined, undefined, intent);
      let ls = L.LedgerState.blank(NET);
      const verified = tx.wellFormed(ls, strictness(), NOW);
      [ls] = ls.apply(verified, new L.TransactionContext(ls, blockContext));
      return { ls, address: dep.address };
    };
    const wellFormed = (ls: unknown, update: unknown) => {
      const intent = L.Intent.new(ttl()).addMaintenanceUpdate(update);
      const tx = L.Transaction.fromParts(NET, undefined, undefined, intent);
      try { tx.wellFormed(ls, strictness(), NOW); return 'WELL-FORMED'; }
      catch (e) { return String((e as Error).message ?? e); }
    };
    return { L, sks, vks, strictness, blockContext, deployWith, wellFormed };
  };

  const chainAuthority = (committee: unknown[], threshold: number, counter: bigint) => ({
    committee, threshold, counter,
    shape: 'committee' as const, hasDuplicateMembers: false,
  });

  it('builds a committee update the chain accepts, signed by the OLD committee at the OLD threshold', async () => {
    /* The mistake that reads backwards: a 2-of-3 being replaced is signed by two of the old three. The ledger
     * verifies each signature against the current committee and counts against the current threshold.
     * RED WHEN: `buildCommitteeChange` counts against the threshold being installed. */
    const { L, sks, vks, deployWith, wellFormed } = await load();
    const { committeeUpdateOf } = await import('midnight-identity/profile/committee-sign');
    const { buildCommitteeChange } = await import('./company-authority.js');
    const { ls, address } = deployWith([vks[0], vks[1], vks[2]], 2);
    const read = { state: 'read' as const, address, authority: chainAuthority([vks[0], vks[1], vks[2]], 2, 0n) as never };
    const to = { committee: [vks[0]], threshold: 1 };
    const update = committeeUpdateOf(L, { address, counter: 0n, to });
    expect(wellFormed(ls, update)).toMatch(/does not meet required threshold \(0\/2/);
    const one = update.addSignature(0n, L.signData(sks[0], update.dataToSign));
    expect(wellFormed(ls, one)).toMatch(/does not meet required threshold \(1\/2/);
    expect(wellFormed(ls, one.addSignature(2n, L.signData(sks[2], update.dataToSign)))).toBe('WELL-FORMED');
    const counted = (signatures: { index: number; signature: unknown }[]) => buildCommitteeChange(L, {
      read, to, signatures: signatures as never, network: NET, ttl: ttl(), label: 'ACCOUNT',
    });
    expect(counted([{ index: 0, signature: L.signData(sks[0], update.dataToSign) }])).toMatchObject({ have: 1, required: 2, unproven: null });
    const both = counted([
      { index: 2, signature: L.signData(sks[2], update.dataToSign) }, { index: 0, signature: L.signData(sks[0], update.dataToSign) },
    ]);
    expect(both).toMatchObject({ have: 2, required: 2, indexesSigned: [0, 2] });
    expect(both.unproven).not.toBeNull();
  });

  it('gives the new authority exactly `updateCounter + 1`, which is the only value the chain accepts', async () => {
    /* Measured: any other value, including the obvious `0`, is refused as "transaction is not in normal form".
     * There is one correct answer, so the builder derives it and takes no parameter for it. This goes red if
     * that derivation is ever made a caller's business. */
    const { L, sks, vks, deployWith, wellFormed } = await load();
    const { committeeUpdateOf } = await import('midnight-identity/profile/committee-sign');
    const { ls, address } = deployWith([vks[0]], 1);
    const update = committeeUpdateOf(L, { address, counter: 0n, to: { committee: [vks[0], vks[1]], threshold: 2 } });
    expect(wellFormed(ls, update.addSignature(0n, L.signData(sks[0], update.dataToSign)))).toBe('WELL-FORMED');

    /* The same update with a hand-built authority at the wrong counter, to show the value is load-bearing. */
    const wrong = new L.MaintenanceUpdate(address,
      [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority([vks[0], vks[1]], 2, 0n))], 0n);
    const signedWrong = wrong.addSignature(0n, L.signData(sks[0], wrong.dataToSign));
    expect(wellFormed(ls, signedWrong)).toMatch(/not in normal form/);
  });

  it('counts nothing at a place outside the committee, nothing twice at one place, and no signature that does not verify', async () => {
    /* Each of the three is a refusal the chain would also make, after the fee: a
     * refused maintenance update lands as `partialSuccess` with the fee already taken.
     * RED WHEN: `signaturesThatCount` keeps any of the three. */
    const { L, sks, vks } = await load();
    const { signaturesThatCount } = await import('./company-authority.js');
    const data = new Uint8Array([7, 7, 7]);
    const holders = [vks[0], vks[1]];
    const by0 = L.signData(sks[0], data);
    expect(signaturesThatCount(L, data, holders, [
      { index: 5, signature: by0 }, { index: -1, signature: by0 }, { index: 1, signature: by0 },
    ])).toEqual([]);
    expect(signaturesThatCount(L, data, holders, [{ index: 0, signature: by0 }, { index: 0, signature: by0 }]))
      .toEqual([{ index: 0, signature: by0 }]);
  });

  it('a committee holding one key at three seats is NOT satisfied by that one holder: ledger 9.1 counts each signature once', async () => {
    /* Measured on ledger 9.1.0.1: one signature value attached at seats 0, 1 and 2 of a committee [K,K,K] at
     * threshold 3 is refused, because the ledger now counts a signature once however many seats hold its key.
     * Before 9.1 it was well formed, so one holder could pass an M-of-N with a repeated key.
     * RED WHEN the ledger accepts one signature at several seats again. */
    const { L, sks, vks, deployWith, wellFormed } = await load();
    const { ls, address } = deployWith([vks[0], vks[0], vks[0]], 3);
    let u = new L.MaintenanceUpdate(address,
      [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority([vks[1]], 1, 1n))], 0n);
    const one = L.signData(sks[0], u.dataToSign);
    u = u.addSignature(0n, one).addSignature(1n, one).addSignature(2n, one);
    expect(wellFormed(ls, u)).toMatch(/committee signature used more than once/);
  });

  it('a contract at threshold ZERO accepts an update with NO signatures, measured on ledger 9', async () => {
    /* This is not the unmaintainable state; it is its opposite, and anybody in the world can rewrite that
     * contract's verifier keys for the price of a fee. */
    const { L, vks, deployWith, wellFormed } = await load();
    const { ls, address } = deployWith([vks[0], vks[1], vks[2]], 0);
    const u = new L.MaintenanceUpdate(address,
      [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority([vks[0]], 1, 1n))], 0n);
    expect(u.signatures).toHaveLength(0);
    expect(wellFormed(ls, u)).toBe('WELL-FORMED');
  });

  it('the SAME signature index twice is refused, so the bypass is in the committee list and not the signature list', async () => {
    /* The ascending-index guard does reach ledger 9. The repeated-key bypass is the same bypass relocated to the
     * committee list, where no guard reaches. */
    const { L, sks, vks, deployWith, wellFormed } = await load();
    const { ls, address } = deployWith([vks[0], vks[1]], 2);
    const base = new L.MaintenanceUpdate(address,
      [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority([vks[0]], 1, 1n))], 0n);
    const sig = L.signData(sks[0], base.dataToSign);
    /* Ledger 9.1 refuses it as a signature counted twice, before its normal-form check would. */
    expect(wellFormed(ls, base.addSignature(0n, sig).addSignature(0n, sig)))
      .toMatch(/committee signature used more than once|not in normal form/);
  });

  it('well-formed is NOT `this will land`: a stale counter passes here and fails on chain', async () => {
    /* Measured: an update built against counter 1 for a contract sitting at counter 0 is well formed. The
     * counter is checked at apply, and maintenance runs in the fallible segment only, so the failure lands as
     * `partialSuccess` with the fee already spent. No screen may read a well-formed verdict as a prediction that
     * the update will apply, which is why `planAuthorityReplacement` reads the counter off the chain immediately
     * before building and never takes one. */
    const { L, sks, vks, deployWith, wellFormed } = await load();
    const { ls, address } = deployWith([vks[0]], 1);
    const stale = new L.MaintenanceUpdate(address,
      [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority([vks[1]], 1, 2n))], 1n);
    expect(wellFormed(ls, stale.addSignature(0n, L.signData(sks[0], stale.dataToSign))))
      .toBe('WELL-FORMED');
  });
});

/*
 * These assertions read the verifier keys, and many copies of this repository have none.
 *
 * The keys are made by a build that runs the proving backend. It takes about a minute and produces a hundred
 * megabytes, and the ordinary compile skips it entirely, so `contracts/managed/keys` is absent wherever nobody
 * has asked for it. A file that read them at load time took the whole suite down with it.
 *
 * So they are skipped where the keys are not, and the skip says so out loud. A measurement that was not taken is
 * a refusal rather than a pass, and the line below is that refusal: it names what did not run and the command
 * that makes it run. They are not skipped in the checks every change passes through, where a job builds the keys
 * and runs exactly these.
 */
// Derived from this file's own location, not from the working directory. Read relatively, a run started from
// anywhere but the root answers "no keys" and skips the block below in silence.
const KEYS = keysOnDisk([ACCOUNT_KEYS]);
const KEYS_ON_DISK = KEYS.ok;
if (!KEYS_ON_DISK) {
  // Printed where the runner is attached to a terminal, and not where it is not: a reporter writing to a file
  // drops console output entirely. So this line is a convenience and the reason a reader can always see is in
  // the name of the block below. What guarantees the assertions are still made is a job in the checks that
  // builds the keys and runs this file.
  console.log(
    '  NOT CHECKED HERE: the verifier keys a deployed entry point is read back against are not on\n' +
    `  disk as this build compiled them, so the four assertions that compare them did not run: ${KEYS.why}`,
  );
}

describe.skipIf(!KEYS_ON_DISK)('reading the verifier keys back, which is what a maintenance authority could swap [needs contracts/managed/keys; `npm run compact` builds them]', () => {
  const NET = 'undeployed';
  const be = (n: number) => { const b = new Uint8Array(32); b[31] = n; return b; };
  const ARTEFACT = 'contracts/managed/keys/adopt.verifier';

  const load = async () => {
    const L: any = await import('@midnightntwrk/ledger-v9');
    const { readFileSync } = await import('node:fs');
    const sk = L.signingKeyFromBip340(be(1));
    const vk = L.signatureVerifyingKey(sk);
    const strictness = () => {
      const s = new L.WellFormedStrictness();
      s.enforceBalancing = false; s.verifyNativeProofs = false;
      s.verifyContractProofs = false; s.enforceLimits = false; s.verifySignatures = true;
      return s;
    };
    /*
     * One instant for the block context, the TTL and `tblock`, and a TTL well inside the window. Measured: the
     * ledger refuses an intent whose TTL is more than 3600 seconds past the block context's `secondsSinceEpoch`
     * (`+3600` applies, `+3601` throws `IntentTtlTooFarInFuture`). A harness that froze the block context and
     * then took `Date.now() + 3600_000` per call would put every later intent over the edge as seconds elapsed,
     * and fail part-way through on code that was correct. `ttl()` is half the window, from the same instant.
     */
    const blockContext = {
      secondsSinceEpoch: NOW_SECONDS, secondsSinceEpochErr: 30,
      parentBlockHash: '00'.repeat(32), lastBlockTime: NOW_SECONDS - 6n,
    };
    const file = new Uint8Array(readFileSync(ARTEFACT));
    const cs = new L.ContractState();
    cs.maintenanceAuthority = new L.ContractMaintenanceAuthority([vk], 1, 0n);
    const dep = new L.ContractDeploy(cs);
    let ls = L.LedgerState.blank(NET);
    let tx = L.Transaction.fromParts(NET, undefined, undefined,
      L.Intent.new(ttl()).addDeploy(dep));
    [ls] = ls.apply(tx.wellFormed(ls, strictness(), NOW),
      new L.TransactionContext(ls, blockContext));
    // Inserted under the version its own header names, as the product inserts it: a version that does not match
    // the header is refused by the runtime before anything reaches the chain.
    const { operationVersionOfKeyFile } = await import('./partial-contract.js');
    const version = operationVersionOfKeyFile(file);
    if (version === null) throw new Error(`${ARTEFACT} carries no verifier-key header the runtime knows`);
    const versioned = new L.ContractOperationVersionedVerifierKey(version, file);
    let u = new L.MaintenanceUpdate(dep.address,
      [new L.VerifierKeyInsert('adopt', versioned)], 0n);
    u = u.addSignature(0n, L.signData(sk, u.dataToSign));
    tx = L.Transaction.fromParts(NET, undefined, undefined,
      L.Intent.new(ttl()).addMaintenanceUpdate(u));
    const [after] = ls.apply(tx.wellFormed(ls, strictness(), NOW),
      new L.TransactionContext(ls, blockContext));
    return { L, file, versioned, address: dep.address, state: after.index(dep.address) };
  };

  it('a real inserted verifier key comes back byte-identical to the FILE, header and all — and NOT as `rawVk`', async () => {
    /* **THE TRAP, MEASURED, AND IT IS THE OBVIOUS THING TO GET WRONG.**
     * `ContractOperationVersionedVerifierKey` STRIPS the 26-byte
     * `midnight:verifier-key[vN]:` header on the way in — the file's bytes less
     * 26 become `rawVk` — **and what the chain hands back is the FILE.**
     * A comparison written against `rawVk`, which is what the caller passed the
     * constructor, calls a perfectly correct contract WRONG on every entry point.
     * This assertion is what keeps that from being rediscovered. */
    const { file, versioned, state } = await load();
    const onChain: Uint8Array = state.operation('adopt').verifierKey;
    expect(Array.from(onChain)).toEqual(Array.from(file));
    expect(onChain.length).toBe(file.length);
    expect(versioned.rawVk.length).toBe(file.length - 26);
    expect(Array.from(onChain)).not.toEqual(Array.from(versioned.rawVk as Uint8Array));
  });

  it('AGREES when every deployed entry point carries the key this build produces', async () => {
    const { file, address, state } = await load();
    const { operationsFromContractState, compareVerifierKeys } = await import('./ledger.js');
    const read = operationsFromContractState(state, address);
    expect(read.state).toBe('read');
    const c = compareVerifierKeys(read, new Map([['adopt', file]]));
    expect(c.verdict).toBe('agree');
    expect(c.matched).toEqual(['adopt']);
    expect(c.mismatched).toEqual([]);
  });

  it('DISAGREES and names the entry point when the key on chain is not the one this build produces', async () => {
    /* A contract whose `recordPayment` verifier key has been swapped answers the authority check with AGREE, and
     * that check reports "Every contract carries the authority recorded for it". True, and it reads as more than
     * it says. */
    const { file, address, state } = await load();
    const { operationsFromContractState, compareVerifierKeys } = await import('./ledger.js');
    const swapped = new Uint8Array(file); swapped[swapped.length - 1]! ^= 0xff;
    const c = compareVerifierKeys(operationsFromContractState(state, address),
      new Map([['adopt', swapped]]));
    expect(c.verdict).toBe('disagree');
    expect(c.mismatched).toEqual(['adopt']);
    expect(c.why).toMatch(/THIS IS WHAT A SWAPPED KEY LOOKS LIKE FROM OUTSIDE/);
    expect(c.fingerprints[0]!.name).toBe('adopt');
  });

  it('DISAGREES when the entry-point SETS differ, because a key it cannot name is a key it cannot check', async () => {
    /* The operations map is the wrong thing to check on its own: a silently weakened key is 32 bytes on chain
     * with the map listing exactly the same names. */
    const { file, address, state } = await load();
    const { operationsFromContractState, compareVerifierKeys } = await import('./ledger.js');
    const read = operationsFromContractState(state, address);
    const extra = compareVerifierKeys(read, new Map([['adopt', file], ['recordPayment', file]]));
    expect(extra.verdict).toBe('disagree');
    expect(extra.missingOnChain).toEqual(['recordPayment']);
    expect(extra.mismatched).toEqual([]);
    const none = compareVerifierKeys(read, new Map());
    expect(none.verdict).toBe('disagree');
    expect(none.onChainOnly).toEqual(['adopt']);
  });

});

/*
 * This case sits outside the block above, which is skipped where the keys are not. It reads no key: it drives
 * the comparison against a state that cannot be read, and holds the property that keeps a swapped key from
 * hiding behind an unreadable one, an answer that is not `agree` and not a guess.
 */
describe('reading a state that cannot be read: never `agree`, and never a partial answer', () => {
  it('answers UNKNOWN and never `agree` when the state cannot be read, and refuses a partial answer', async () => {
    /* A partial answer is worse than none here: it would let a swapped key hide
     * behind an unreadable one. */
    const { operationsFromContractState, compareVerifierKeys } = await import('./ledger.js');
    expect(operationsFromContractState(null, 'a').state).toBe('unreadable');
    expect(operationsFromContractState({}, 'a').state).toBe('unreadable');
    const halfRead = operationsFromContractState({
      operations: () => ['a', 'b'],
      operation: (n: unknown) => (n === 'a' ? { verifierKey: new Uint8Array([1]) } : {}),
    }, 'addr');
    expect(halfRead.state).toBe('unreadable');
    expect(halfRead.state === 'unreadable' && halfRead.why).toMatch(/"b" carries no readable/);
    const c = compareVerifierKeys(halfRead, new Map());
    expect(c.verdict).toBe('unknown');
    expect(c.why).toMatch(/NOTHING may be concluded/);
  });
});

/**
 * The verifier-key half of the builder. A builder that refused five things about the authority and nothing about
 * the keys had it the wrong way round, so these cases pin that it refuses what the keys themselves can carry,
 * that a current authority is taken from the plan and not passed alongside it, and that nothing promises to
 * report a state that nothing carries.
 */
describe('the verifier-key half of the builder refuses what the keys themselves can carry', () => {
  it('refuses an unnamed entry point, empty key bytes, and a version the runtime does not have', async () => {
    /* The drain a maintenance authority allows is a verifier-key swap performed using the authority, so a builder
     * that refuses five things about who may change a contract and nothing about the change itself has it
     * exactly the wrong way round. */
    const { verifierKeyRefusals } = await import('./ledger.js');
    const good = { operation: 'adopt', version: 'v3' as const, verifierKey: new Uint8Array([1]) };
    expect(verifierKeyRefusals([good])).toEqual([]);
    expect(verifierKeyRefusals([{ ...good, operation: '  ' }]).map((r) => r.code))
      .toContain('unnamed-verifier-key-operation');
    expect(verifierKeyRefusals([{ ...good, verifierKey: new Uint8Array() }]).map((r) => r.code))
      .toContain('empty-verifier-key');
    expect(verifierKeyRefusals([{ ...good, version: 'v9' as never }]).map((r) => r.code))
      .toContain('unknown-verifier-key-version');
    /* Measured: the runtime's version is a VERSION-KEYED HEADER PARSE — `v3` wants a
     * `midnight:verifier-key[v6]:` header and `v4` wants `[v7]` — and it throws on a
     * mismatch. It is not a label, so a free-form string is not an option. */
    expect(verifierKeyRefusals([{ ...good, version: 'v4' as const }])).toEqual([]);
  });

  it('compareVerifierKeys answers UNKNOWN over an empty comparison rather than agreeing about nothing', async () => {
    /* The failure is not a red check, it is an absence where evidence should be: both sides empty must not
     * answer `agree` over zero entry points. */
    const { compareVerifierKeys } = await import('./ledger.js');
    const c = compareVerifierKeys(
      { state: 'read', address: 'a', operations: [] }, new Map());
    expect(c.verdict).toBe('unknown');
    expect(c.why).toMatch(/NOTHING may be concluded/);
  });

  it('says in AGREE\'s own words that it saw only the latest version of each key', async () => {
    /* In the ledger's own types, a ContractOperation holds keys "potentially for
     * different versions of the proving system" and "Only the latest available
     * version is exposed to this API". A sentence wider than what was looked at is
     * the silent-success shape. */
    const { compareVerifierKeys } = await import('./ledger.js');
    const bytes = new Uint8Array([1, 2, 3]);
    const c = compareVerifierKeys(
      { state: 'read', address: 'a', operations: [{ name: 'adopt', verifierKey: bytes }] },
      new Map([['adopt', bytes]]));
    expect(c.verdict).toBe('agree');
    expect(c.why).toMatch(/LATEST VERSION OF EACH/);
    /* The message names the reason: the only version the ledger exposes.
     * RED WHEN: the sentence stops saying it is the ledger that exposes only the latest. */
    expect(c.why).toMatch(/the only version the ledger exposes/);
  });
});

describe('the chosen half: the validator every deploy path goes through refuses a repeated committee key too', () => {
  const key = (v: string) => ({ tag: 'schnorr', value: v });
  const K1 = key('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
  const K2 = key('c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5');

  it('refuses a committee that lists one key twice, at the door every deploy path goes through', async () => {
    /* A repeated key is refused where an authority is chosen and where one is built. `requireMaintenanceAuthority`
     * is the chosen half: the account's deploy, the vault's deploy and the check of a choice against the chain all
     * reach it, so one check covers every deploy path. */
    const { requireMaintenanceAuthority } = await import('./partial-contract.js');
    expect(() => requireMaintenanceAuthority(
      { kind: 'committee', committee: [K1, K2, K1], threshold: 3 } as never,
    )).toThrow(/lists at least one key more than once/);
    /* Case-folded, exactly as the chain compares them. */
    expect(() => requireMaintenanceAuthority({
      kind: 'committee', threshold: 2,
      committee: [K1, { tag: 'SCHNORR', value: K1.value.toUpperCase() }],
    } as never)).toThrow(/more than once/);
    /* And a real M-of-N still passes, with every check it already made intact. */
    expect(requireMaintenanceAuthority(
      { kind: 'committee', committee: [K1, K2], threshold: 2 } as never,
    )).toEqual({ kind: 'committee', committee: [K1, K2], threshold: 2 });
    expect(() => requireMaintenanceAuthority(
      { kind: 'committee', committee: [K1, K2], threshold: 3 } as never,
    )).toThrow(/cannot have threshold 3/);
    expect(() => requireMaintenanceAuthority(
      { kind: 'committee', committee: [], threshold: 1 } as never,
    )).toThrow(/at least one verifying key/);
  });
});

describe('the modules that must load without the ledger read a contract\'s authority through the reader that imports nothing', () => {
  const importsOf = async (path: string): Promise<string[]> => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL(path, import.meta.url), 'utf8');
    const found: string[] = [];
    for (const m of text.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*['"]([^'"]+)['"]/gmu)) found.push(m[1]!);
    for (const m of text.matchAll(/^import\s*['"]([^'"]+)['"]/gmu)) found.push(m[1]!);
    return found;
  };
  const LEDGER_PACKAGES = /^@midnight-?ntwrk\//u;
  const READER = 'midnight-identity/profile/contract-authority';

  it.each(['./contract-authority-read.ts', './account-deploy.ts'])('%s reads a contract\'s authority from the reader that imports nothing', async (file) => {
    /* RED WHEN: the authority reader loads the ledger, or either module stops reading a contract's authority through `authorityIn`. */
    const own = await importsOf(file);
    expect(own.filter((s) => LEDGER_PACKAGES.test(s)), `${file} loads a ledger package`).toEqual([]);
    expect(own, `${file} reads the authority through authorityIn`).toContain(READER);
    expect(await importsOf('../../packages/identity/src/profile/contract-authority.ts'),
      'the reader loads something, so it can load the ledger').toEqual([]);
  });
});
