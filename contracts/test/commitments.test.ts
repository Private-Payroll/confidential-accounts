import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { AccountSimulator, privateStateFor, change, GBP } from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import { MidnightCommitments } from '../../src/midnight/commitments.js';
import { SimulatedCommitments } from '../../src/core/ledger.js';
import { toHex } from '../../src/core/crypto.js';

/**
 * The seam.
 *
 * The client computes commitments in TypeScript. The contract checks them in a
 * circuit. If those two ever disagree, nothing fails loudly: attestations stop
 * verifying and signers stop being recognised, which reads like a key problem
 * rather than a scheme problem and is miserable to debug.
 *
 * These tests are the only thing standing between us and that.
 */
/*
 * READING THE CONTRACT'S OWN SOURCE, FOR THE TESTS THAT PIN A DOMAIN SEPARATOR.
 *
 * Comments stripped before reading, for `vault-scoping.test.ts:303-307`'s
 * reason: this file's own explanation of the rule must not be able to satisfy
 * the check on the rule.
 *
 * AT MODULE SCOPE BECAUSE TWO BLOCKS NEED THEM. They were local to the block
 * below until a third derivation gained a separator and its test sits in the
 * fixed-vector block instead, beside the value assertions it replaces.
 */
const codeOf = (): string =>
  readFileSync(new URL('../src/ConfidentialAccount.compact', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

/*
 * The body between a circuit's `export circuit <name>` and the first `}` at
 * column 0 after it. Narrow on purpose: an assertion over the whole file would
 * pass on a tag padded anywhere, including in another circuit.
 */
const bodyOf = (code: string, name: string): string => {
  const from = code.indexOf(`export circuit ${name}`);
  expect(from, `${name} is not exported from ConfidentialAccount.compact any more`)
    .toBeGreaterThan(-1);
  const to = code.indexOf('\n}', from);
  expect(to, `${name}'s body has no closing brace at column 0`).toBeGreaterThan(from);
  return code.slice(from, to);
};

describe('commitment schemes agree with the contract', () => {
  const ada = privateStateFor(1);
  const blake = privateStateFor(2);
  let sim: AccountSimulator;

  /*
   * `AccountSimulator.create`, not `new AccountSimulator`.
   *
   * This file called the constructor directly — which has been PRIVATE since
   * the compact-runtime 0.18 migration, because `initialState` became async and
   * a constructor cannot await. It "worked" only because nothing ever
   * typechecked `contracts/test/`.
   */
  beforeAll(async () => {
    /* One founding signer at a threshold of one, which is the only shape a
     * constructor produces. Blake is seated below by an approved round — the
     * bootstrap window this used to rely on is shut. */
    sim = await AccountSimulator.create(ada);
  });

  it('produces the same signer leaf as the contract', () => {
    const fromContract = sim.leafOf(blake);
    const fromClient = MidnightCommitments.signerLeaf(
      toHex(sim.publicKeyOf(blake)), toHex(blake.blinding),
    );
    expect(fromClient).toBe(toHex(fromContract));
  });

  /*
   * `produces the same balance commitment as the contract` STOOD HERE. It
   * pinned `MidnightCommitments.balanceCommitment` against the contract's
   * `balanceCommitmentOf`; both are gone with the balance.
   *
   * DELETED RATHER THAN REWRITTEN, because the scheme it compared no longer
   * exists on either side. The rule it enforced — decision 0004, one definition
   * of a commitment scheme, checked against the contract's own circuit — is
   * still enforced by the three tests around it.
   */

  it('produces the same asset key as the contract', () => {
    /*
     * Both sides must derive the SAME asset key, or the change
     * commitment one signer approves is not the one another recomputes, and an
     * approval of a run is an approval of nothing.
     *
     * The client encodes the asset code and the contract never sees the string,
     * so this is the only place the two encodings meet.
     */
    const fromContract = sim.assetKeyOf(ada, GBP);
    const fromClient = MidnightCommitments.assetKey('GBP', toHex(ada.assetBlinding));
    expect(fromClient).toBe(toHex(fromContract));
  });

  it('produces a leaf the contract accepts for a real approval', async () => {
    /*
     * The end-to-end claim: a signer added using a CLIENT-computed leaf can
     * actually approve. This is the assertion that would have caught the
     * client/circuit mismatch.
     *
     * It was vacuous for months. Every call here is async since the 0.18
     * migration, and the last line read
     *
     *     expect(() => sim.as(blake).approve()).not.toThrow();
     *
     * `approve()` returns a rejected promise rather than throwing, so
     * `.not.toThrow()` passed no matter what the contract did — and the two
     * calls above it were unawaited promises that rejected into the void. The
     * one test standing between us and a client/circuit scheme mismatch was
     * asserting nothing at all.
     */
    const leaf = MidnightCommitments.signerLeaf(
      toHex(sim.publicKeyOf(blake)), toHex(blake.blinding),
    );
    /*
     * SEATED THROUGH AN APPROVED ROUND, AND THE LEAF IS STILL THE CLIENT'S.
     * The bootstrap window is shut, so this is `propose` → `approve` →
     * `amendSigner` where it was one call. **What this test is about is
     * unchanged**: the leaf handed to the chain is the one
     * `MidnightCommitments.signerLeaf` computed, not one derived here, and the
     * assertion below is still that Blake can prove membership against it.
     */
    const seating = change(0n, 76);
    const clientLeaf = Uint8Array.from(Buffer.from(leaf, 'hex'));
    const addPayload = pureCircuits.signerAddPayload(clientLeaf);
    await sim.as(sim.applying(ada, seating)).propose(addPayload);
    const seatId = sim.proposalId(addPayload, seating.salt);
    await sim.as(ada).approve(seatId);
    await sim.as(sim.applying(ada, seating)).addSigner(clientLeaf, seatId);

    const c = change(0n, 77);
    const payload = new Uint8Array(32);
    await sim.as(sim.applying(ada, c)).propose(payload);
    const id = sim.proposalId(payload, c.salt);

    // The real assertion: Blake, holding only his own secret and blinding,
    // proves membership against a leaf the CLIENT computed.
    await expect(sim.as(sim.applying(blake, c)).approve(id)).resolves.not.toThrow();
    expect(sim.approvalsFor(id)).toBe(1n);
  });

  it('refuses an amount too wide for the contract, in both directions', () => {
    /*
     * `Uint<128>` in the circuit, and neither refusal is theoretical.
     *
     * A negative balance cannot be represented at all. An over-wide one is the
     * interesting case: `BigInt` has no width, so without this check the value
     * reaches the circuit intact and fails there with a range error that names
     * nothing useful — on the caller's own device, after proving.
     */
    /*
     * DRIVEN THROUGH `changeCommitment` RATHER THAN `balanceCommitment`.
     *
     *
     * `checkAmount` is one guard with two callers; `balanceCommitment` was the
     * other and went with the account's balance. The rule is unchanged — an
     * amount is an integer in the asset's smallest unit and must fit `Uint<128>`
     * — and `changeCommitment` carries exactly such an amount into every
     * proposal, so it is the surviving door to the same line.
     */
    const key = 'aa'.repeat(32), batch = 'cc'.repeat(32), salt = 'bb'.repeat(32);
    expect(() => MidnightCommitments.changeCommitment(key, -1n, batch, salt))
      .toThrow(/negative/);
    expect(() => MidnightCommitments.changeCommitment(key, 1n << 128n, batch, salt))
      .toThrow(/Uint<128>/);
    // The largest value that DOES fit is accepted, so the boundary is tested
    // from both sides rather than only from the failing one.
    expect(() => MidnightCommitments.changeCommitment(key, (1n << 128n) - 1n, batch, salt))
      .not.toThrow();
  });

  it('is a different scheme from the simulated one, and says so', () => {
    // If these ever coincided it would mean someone had pointed the Midnight
    // adapter at the simulated scheme, which would work in tests and fail on
    // chain.
    const pk = toHex(sim.publicKeyOf(blake));
    const b = toHex(blake.blinding);
    expect(MidnightCommitments.signerLeaf(pk, b)).not.toBe(SimulatedCommitments.signerLeaf(pk, b));
    expect(MidnightCommitments.describe()).toMatch(/provable/);
    expect(SimulatedCommitments.describe()).toMatch(/not provable/);
  });
});

/**
 * WHAT A COMMITMENT NAMES — the half a mirror cannot check.
 *
 * The describe above asks whether the client and the contract AGREE. It cannot
 * ask whether either of them is right, and the reason is mechanical rather than
 * a matter of care: `src/midnight/commitments.ts:112` and `:186` call
 * `pureCircuits.assetKeyOf` and `pureCircuits.changeCommitmentOf`, and
 * `contracts/test/simulator.ts:330` calls the first one too. Both sides of every
 * such comparison are the same generated function, so breaking the circuit's
 * BODY moves both sides together and the comparison stays green.
 *
 * A test that compares a thing to itself passes for every possible value of
 * that thing. Two mutations lived behind that for as long as this file has
 * existed — `the approved change does not name the asset` and `the asset key
 * ignores the account blinding`, both scored `SURVIVED` on 31 Aug with all 232
 * tests green.
 *
 * SO THE SECOND SIDE HERE IS NOT A SECOND IMPLEMENTATION. It is a property the
 * rule implies, written out by hand: which inputs a commitment must be able to
 * tell apart. The circuit supplies one side; the requirement that two different
 * inputs produce two different outputs is the other, and it is stated here and
 * nowhere else. A circuit that has stopped reading one of its arguments cannot
 * satisfy it, whatever the client does.
 *
 * These are the tests those two mutations are pointed at. If one of them is
 * ever weakened, the money rule is reported as uncertified.
 *
 * **AND THERE ARE FOUR MUTATIONS, NOT TWO.** The two above replace an
 * argument; the two beside them SWAP two same-typed arguments, which no
 * property in this describe can catch — see the fixed vectors at the foot of
 * this file, which are what those two are pointed at.
 *
 * **AND WHAT THEY PIN IS THE CIRCUIT, NOT A SETTLEMENT** — said before anybody
 * reads a `CAUGHT` here as more than it is. The only circuit that opened a
 * change commitment is gone, so nothing on chain compares the asset inside one
 * to anything; the comment above `changeCommitmentOf` in
 * `ConfidentialAccount.compact` says so itself and names what DOES refuse a
 * dollar run presented as ether — the separator inside `payoutDetails`, which
 * is inside the leaf, inside the approved root, inside the proposal's id.
 * These four tests hold the commitment schemes to naming what they claim to
 * name. They do not hold a settlement, and a comment here that said they did
 * would be the next stale guarantee.
 */
describe('what a commitment names, which no mirror can check', () => {
  /*
   * Read off the contract's own exports rather than the adapter, so this
   * describe does not inherit the adapter's argument order or encoding. Those
   * are what the mirror above is for, and they are worth having; they are not
   * this.
   */
  const b = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i + n) & 0xff);
  const asset = (code: string): Uint8Array =>
    Uint8Array.from({ length: 32 }, (_, i) => code.charCodeAt(i) || 0);

  it('the asset key BINDS THE ACCOUNT BLINDING, so two companies holding one asset do not share a key', () => {
    /*
     * THE RULE: an asset key is the account's, not the asset's.
     *
     * The contract's own reason, above `assetKeyOf` in
     * `ConfidentialAccount.compact`: keying
     * by the plain code would give EVERY ACCOUNT HOLDING EUROS THE SAME KEY, so
     * accounts could be grouped by the currencies they share — in the
     * contract's words, *"without breaking a single commitment"*. Blinded per
     * account, an observer holding the list of every asset code in the world can
     * test none of them. The contract adds that this is *"still true of a
     * change commitment even though there is no map any more"*.
     *
     * The blinding is the ACCOUNT's rather than a signer's, and every signer
     * derives the same key from it, which is what lets one signer recompute a
     * commitment another proposed — `contracts/src/witnesses.ts:74-84`.
     *
     * The property, and it is not a second call to the same function under
     * another name: DIFFERENT BLINDINGS OVER ONE ASSET MUST NOT COLLIDE. A
     * circuit that has stopped reading its blinding argument produces one value
     * for all of them and fails on the very first pair.
     */
    const POUNDS = asset('GBP');
    const keys = [b(10), b(60), b(110), b(160)].map(
      blinding => toHex(pureCircuits.assetKeyOf(POUNDS, blinding)),
    );
    expect(new Set(keys).size).toBe(keys.length);

    // Named singly as well as by the set, so a failure says which rule broke
    // rather than only that a count was wrong.
    expect(toHex(pureCircuits.assetKeyOf(POUNDS, b(10))))
      .not.toBe(toHex(pureCircuits.assetKeyOf(POUNDS, b(60))));
  });

  it('the asset key names the ASSET, so one account\'s two currencies do not share a key', () => {
    /*
     * The other half of the same rule. One blinding, four assets, four keys —
     * without which an account's pounds and its dollars would key the same and a
     * change commitment could not tell them apart.
     *
     * NOT a claim that this is what refuses a dollar payment against a pound
     * approval. Nothing opens the commitment any more; the separator inside
     * `payoutDetails` is the enforcer.
     */
    const blinding = b(10);
    const keys = ['GBP', 'USD', 'EUR', 'JPY'].map(
      code => toHex(pureCircuits.assetKeyOf(asset(code), blinding)),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the approved change NAMES ITS ASSET, so two changes alike but for the currency are two commitments', () => {
    /*
     * THE RULE: what the signers approved includes WHICH asset moves.
     *
     * The asset is the first field of `changeCommitmentOf`, and the contract
     * states both halves of its own position in that circuit's own comment in
     * `ConfidentialAccount.compact`: the field is there so that *"a run
     * approved to pay a month of dollar salaries"* cannot authorise *"the same
     * integer of ether"* — **and that is NOT what enforces it today.** The
     * only circuit that opened this commitment is gone, so the asset in it is
     * written and never compared, and the separator inside `payoutDetails`
     * refuses the substitution instead.
     *
     * So this test does not claim the settlement rule. It claims the narrower
     * thing that is actually true and that nothing else checked: two changes
     * alike in every other field and differing only in WHICH asset they name
     * are two different commitments. A circuit that has stopped reading its
     * asset key produces one value for both — four witnesses and two
     * `persistentCommit`s paid for a field that names nothing.
     *
     * NAMED RATHER THAN ASSUMED: this held until now because nobody had
     * written the code that would break it.
     */
    const amount = 20_000n, batch = b(6), salt = b(7);
    const commitments = [b(20), b(70), b(120), b(170)].map(
      key => toHex(pureCircuits.changeCommitmentOf(key, amount, batch, salt)),
    );
    expect(new Set(commitments).size).toBe(commitments.length);

    expect(toHex(pureCircuits.changeCommitmentOf(b(20), amount, batch, salt)))
      .not.toBe(toHex(pureCircuits.changeCommitmentOf(b(70), amount, batch, salt)));
  });

  it('a change commitment tells apart every field it carries, not only the asset', () => {
    /*
     * The asset is the field with a mutation behind it; it is not the only
     * field a signer is trusting. Amount, batch and salt each get the same
     * treatment, so that a later change which drops one of THEM is caught here
     * rather than becoming the next silent second copy.
     */
    const KEY = b(20), AMOUNT = 20_000n, BATCH = b(6), SALT = b(7);
    const base = toHex(pureCircuits.changeCommitmentOf(KEY, AMOUNT, BATCH, SALT));

    expect(toHex(pureCircuits.changeCommitmentOf(KEY, AMOUNT + 1n, BATCH, SALT))).not.toBe(base);
    expect(toHex(pureCircuits.changeCommitmentOf(KEY, AMOUNT, b(66), SALT))).not.toBe(base);
    expect(toHex(pureCircuits.changeCommitmentOf(KEY, AMOUNT, BATCH, b(77)))).not.toBe(base);

    // And it is a function: the same four inputs give the same answer twice,
    // or none of the inequalities above would mean anything.
    expect(toHex(pureCircuits.changeCommitmentOf(KEY, AMOUNT, BATCH, SALT))).toBe(base);
  });

  /*
   * ───────────────────────────────────────────────────────────────────────────
   * **THE FOUR ABOVE ARE INJECTIVITY TESTS, AND A SWAP STAYS INJECTIVE.**
   *
   *
   * Every assertion above is one of three shapes: *n distinct inputs give n
   * distinct outputs*, *these two specific inputs differ*, and *the same inputs
   * give the same answer twice*. **All three are invariant under a permutation
   * of the preimage.** A circuit that bound the blinding where it means to bind
   * the asset — or the batch where it means to bind the asset key — is still an
   * injective function of its argument tuple, so it passes all four without
   * reading a single argument correctly. The mutation set had no mutation of
   * that shape either: its ninety-four rows replace a value or duplicate one,
   * and both of those COLLAPSE two inputs to one output, which is exactly what
   * injectivity does catch.
   *
   * **THE ONLY THING THAT CATCHES A SWAP IS A VALUE.** So: hand-written inputs
   * in which every same-typed argument holds a DIFFERENT value, and the exact
   * output each must produce, pinned as a literal. Any permutation of the
   * preimage changes the answer, so one literal per circuit closes the whole
   * family at once.
   *
   * **THE PRECEDENT AND THE REASON IT EXISTS ARE ALREADY IN THIS REPOSITORY**:
   * `contracts/test/run-keys.test.ts:171-206` pins `runKeyOf` and
   * `payeeSecretsOf` for the identical reason, in its own words — *"swapping the
   * `info` strings of the nonce and the blinding survived every other test in
   * this file. The values stayed deterministic, stayed distinct… Vectors are
   * what catch that; properties are not."*
   *
   * **WHERE THESE NUMBERS CAME FROM.** Read off `pureCircuits` in
   * `contracts/managed/contract/index.js` once, and written down. They are not
   * derived, predicted or copied from anywhere. **A change to either circuit
   * changes them**, and that is the point: a recompile that moves one of these
   * is a recompile that changed what a signer's approval names, and it has to
   * be read and re-pinned deliberately rather than re-derived by the test
   * itself.
   *
   * **WHAT IS STILL UNPINNED, SO NOBODY READS THIS AS MORE THAN IT IS.**
   * `signerLeaf(pk, blinding, scope)`, `proposalIdOf(payloadHash, vault, salt)`,
   * `runPayload(root, payees, opensAt, closesAt)` and `payoutLeaf(details,
   * nonce)` each carry same-typed arguments and have no vector.
   *
   * **AND `changeCommitmentOf` HAS JOINED THEM, WHICH IS A LOSS AND IS WRITTEN
   * HERE RATHER THAN ONLY WHERE IT HAPPENED.** It had a vector; the derivation
   * gained a domain separator, so the value it pinned is a value the circuit no
   * longer produces. Only ONE of the two literals below is still live. What
   * replaced it is an assertion over the body's own source text, which catches
   * a transposition and cannot catch a change in the primitive underneath.
   *
   * **AND THE FIRST TWO USED TO COLLIDE EXACTLY.** Both were
   * `persistentCommit<Vector<2, Bytes<32>>>` over a two-vector with the third
   * argument as the opening, and NEITHER carried a domain separator, where
   * `runPayload` and `payoutLeaf` both pad a `"midnight-accounts:…"` tag.
   * Measured off the live circuit: `signerLeaf(X, Y, Z)` and `proposalIdOf(X,
   * Z, Y)` returned THE SAME 32 BYTES, so a signer leaf and a proposal id were
   * one value under a relabelling of three arguments. **The `.compact` edit
   * that fixed it** makes each pad its own tag into a three-vector.
   *
   * **THEY ARE STILL UNPINNED AND THAT IS A DEBT, NOT A CLOSURE.** The
   * separators are asserted below by their SOURCE TEXT and by the property
   * they buy; neither is a fixed vector, because a vector for the new bodies
   * cannot be read without a recompile. What is owed, and where it goes, is at
   * the foot of this file.
   * ───────────────────────────────────────────────────────────────────────────
   */
  describe('AND IT READS THEM IN THE RIGHT ORDER — the fixed vectors', () => {
    /*
     * Distinct on purpose, and that is the whole design of the input. `GBP`
     * pads with zero bytes and `b(1)` does not, so asset and blinding cannot
     * collide; `b(2)`, `b(3)` and `b(4)` are three different 32-byte runs, so
     * no two of the change commitment's `Bytes<32>` arguments are equal. **An
     * input in which two same-typed arguments happen to be equal is an input a
     * swap survives**, which is how a vector test can be written and prove
     * nothing.
     */
    const ASSET = asset('GBP');
    const BLINDING = b(1);
    const KEY = b(2), BATCH = b(3), SALT = b(4);
    /*
     * **THE TOP BIT OF THE `Uint<128>` IS SET, AND THAT IS THE WHOLE REASON FOR
     * THE SHAPE OF THIS NUMBER.**
     *
     * It was `12345678901234567890n`, under a comment claiming it used the
     * whole field. **That value is 64 bits wide**, and what that costs was
     * measured: masking the amount to its low 64 bits left the commitment
     * BYTE-IDENTICAL, so a narrowing of `amount` from `Uint<128>` to
     * `Uint<64>` round-tripped the vector unchanged. **A vector that a real
     * narrowing survives pins less than its comment says.**
     *
     * `(1n << 127n) + 12345678901234567890n` is 128 bits and well below
     * `MAX_AMOUNT` (`src/midnight/commitments.ts:42`), so it exercises the top
     * of the field without sitting on the boundary the adapter's own width
     * check is about.
     */
    const AMOUNT = (1n << 127n) + 12345678901234567890n;

    it('assetKeyOf(asset, blinding) — the asset is the value and the blinding is the opening', () => {
      expect(toHex(pureCircuits.assetKeyOf(ASSET, BLINDING)))
        .toBe('32c0adc78a1f7b371bb49bea21c80b3c09f4f253320e87a9dfa74e8ad3a448ef');
      /*
       * And the swap really does move it. Without this line the literal above
       * would be satisfied by a circuit that happened to be symmetric, and the
       * test would pin a number without pinning an order.
       */
      expect(toHex(pureCircuits.assetKeyOf(BLINDING, ASSET)))
        .not.toBe(toHex(pureCircuits.assetKeyOf(ASSET, BLINDING)));
    });

    it('changeCommitmentOf(assetKey, amount, batch, salt) — three same-typed arguments, one order', () => {
      const base = toHex(pureCircuits.changeCommitmentOf(KEY, AMOUNT, BATCH, SALT));

      /*
       * **THIS TEST HAS LOST ITS PINNED VECTOR AND GAINED A SOURCE ASSERTION,
       * AND THE SWAP IS A DOWNGRADE THAT IS STATED RATHER THAN HIDDEN.**
       *
       * The literal that stood here was read off the live circuit and was
       * correct for a body that no longer exists: this derivation now pads a
       * domain separator and commits over four elements, so every value it
       * produces is different. A number for the NEW body cannot be read
       * without a recompile, and no session may run one — writing one anyway
       * is the exact failure the rule against unmeasured numbers names. So the
       * vector is refused rather than guessed, and it is OWED at the foot of
       * this file beside the two that have been owed since the separators
       * landed.
       *
       * **WHAT IS LOST IN THE MEANTIME, MEASURED RATHER THAN WAVED AT.** A
       * value is the only instrument that catches a TRANSPOSITION: a circuit
       * that reads its arguments in a different order is still injective, so
       * every relative assertion below passes against it unchanged. The three
       * `.not.toBe(base)` lines that follow do NOT catch the mutation they look
       * like they catch.
       *
       * **WHAT STANDS IN ITS PLACE.** The body's own text, pinned element by
       * element. A transposition rewrites it; replacing an element with a
       * default rewrites it; dropping the separator rewrites it. That is
       * weaker than a value — it cannot see a change in what `persistentCommit`
       * DOES, only in what this file asks it to do — and it is the strongest
       * thing available until the recompile.
       */
      const body = bodyOf(codeOf(), 'changeCommitmentOf');

      expect(body, 'changeCommitmentOf has lost its domain separator. Without it this '
        + 'derivation sits in the same commitment family as signerLeaf and proposalIdOf with '
        + 'nothing in the circuit keeping it out of their outputs — what kept it out was that '
        + 'callers happen to pass an asset key, which is an assumption about call sites and '
        + 'not a property of the function.')
        .toContain('pad(32, "midnight-accounts:change:")');

      expect(body, 'changeCommitmentOf commits over three elements again, which is the family '
        + 'the untagged body shared with the two tagged derivations and with the vault\'s '
        + 'payout details.')
        .toContain('persistentCommit<Vector<4, Bytes<32>>>');

      /*
       * THE ORDER, AS ONE STRING. Whitespace-normalised so re-wrapping the
       * source does not redden it, and every element named so a transposition
       * of any two cannot satisfy it.
       */
      expect(body.replace(/\s+/g, ' '),
        'changeCommitmentOf reads its elements in a different order. Nothing else in this '
        + 'suite goes red for that: every behavioural test takes both sides from the contract, '
        + 'so a relabelling returns silently, and this test has no pinned value while the '
        + 'vector is owed.')
        .toContain('[pad(32, "midnight-accounts:change:"), assetKey, '
          + 'amount as Field as Bytes<32>, batch], salt');

      /*
       * **AND THE AMOUNT REALLY IS 128 BITS, WATCHED RATHER THAN ASSERTED IN A
       * COMMENT.** Masking it to its low 64 bits must move the answer. When
       * this vector's amount was 64 bits wide it did not, and only running the
       * mask showed it.
       */
      expect(toHex(pureCircuits.changeCommitmentOf(
        KEY, AMOUNT & ((1n << 64n) - 1n), BATCH, SALT))).not.toBe(base);

      /*
       * Each of the three transpositions of `assetKey`, `batch` and `salt`,
       * named one at a time so a failure says WHICH pair moved. Every one of
       * these passes the four injectivity tests above.
       */
      expect(toHex(pureCircuits.changeCommitmentOf(BATCH, AMOUNT, KEY, SALT))).not.toBe(base);
      expect(toHex(pureCircuits.changeCommitmentOf(SALT, AMOUNT, BATCH, KEY))).not.toBe(base);
      expect(toHex(pureCircuits.changeCommitmentOf(KEY, AMOUNT, SALT, BATCH))).not.toBe(base);
    });
  });

  /*
   * ───────────────────────────────────────────────────────────────────────────
   * THE SIGNER LEAF AND THE PROPOSAL ID WERE ONE FUNCTION.
   *
   * `signerLeaf(pk, blinding, scope)` and `proposalIdOf(payloadHash, vault,
   * salt)` used to be both `persistentCommit<Vector<2, Bytes<32>>>([first,
   * second], third)` and neither padded a tag, so they were THE SAME FUNCTION
   * up to a permutation of their arguments: `signerLeaf(X, Y, Z)` and
   * `proposalIdOf(X, Z, Y)` were the same 32 bytes. A signer's leaf and a
   * proposal's id are the two values that decide WHO MAY APPROVE A PAYMENT and
   * WHAT THEY APPROVED, and nothing in the contract kept them apart. What kept
   * them apart was that a caller would have had to hold a signer's blinding
   * and a proposal's salt at once, and the witnesses that supply them are
   * per-device — a property held by who holds what, not by a check.
   *
   * **WHY THREE TESTS AND NOT ONE PINNED VECTOR.**
   *
   * A vector is what the block above uses and it is the stronger instrument.
   * It cannot be written here yet: the separators change both bodies, so the
   * numbers are whatever the NEXT compile produces, and nothing here may run
   * the compiler. Writing a value no instrument read would be exactly the
   * failure this repository refuses. So the vectors are OWED, named at the
   * foot of this file, and what stands in the meantime is:
   *
   *   1. and 2. THE SOURCE TEXT of each body, one test each. These are what
   *      the mutations are scored against, and the reason is measured rather
   *      than argued. A mutation that strips ONE separator moves only that
   *      circuit's value, and every mirror and every behavioural test in this
   *      repository takes BOTH sides of the comparison from the contract — so
   *      both sides move together and the suite stays green while the
   *      protection is gone. `one-definition.test.ts:30-37` records exactly
   *      that happening to `assetKeyOf` and `changeCommitmentOf`: two
   *      mutations broke the contract and the whole suite stayed green, twice.
   *      `assetKeyOf` still has its vector and `changeCommitmentOf` no longer
   *      does — its separator moved the value the same way these two moved —
   *      so three of the four have no vector now, and a source
   *      assertion is the only thing that goes red for one stripped separator
   *      and nothing else. It is the shape `vault-scoping.test.ts:299` already
   *      uses on this same file.
   *
   *   3. THE PROPERTY the separators buy, from the circuits themselves. This one
   *      does NOT carry a mutation and must not be given one: it goes red only
   *      when BOTH separators are gone, so either single-separator mutation
   *      would be scored SURVIVED against it — an expectation naming a test
   *      that cannot fail for that line.
   * ───────────────────────────────────────────────────────────────────────────
   */
  describe('a signer leaf and a proposal id are different families', () => {
    it('signerLeaf pads its own domain tag into the commitment', () => {
      const body = bodyOf(codeOf(), 'signerLeaf');
      expect(body, 'signerLeaf has lost its domain separator. Without it signerLeaf(X, Y, Z) '
        + 'and proposalIdOf(X, Z, Y) are the same 32 bytes, so a signer leaf and a proposal id '
        + 'are one value under a relabelling. Nothing else in this suite goes red for '
        + 'this: every behavioural test takes both sides from the contract, so the collision '
        + 'returns silently.')
        .toContain('pad(32, "midnight-accounts:signer-leaf:")');
      expect(body, 'signerLeaf commits over a two-vector again, which is the shape that '
        + 'collided with proposalIdOf.')
        .toContain('persistentCommit<Vector<3, Bytes<32>>>');
    });

    it('proposalIdOf pads its own domain tag into the commitment', () => {
      const body = bodyOf(codeOf(), 'proposalIdOf');
      expect(body, 'proposalIdOf has lost its domain separator. Without it proposalIdOf(X, Z, Y) '
        + 'and signerLeaf(X, Y, Z) are the same 32 bytes, so a proposal id and a signer leaf are '
        + 'one value under a relabelling. Nothing else in this suite goes red for this.')
        .toContain('pad(32, "midnight-accounts:proposal-id:")');
      expect(body, 'proposalIdOf commits over a two-vector again, which is the shape that '
        + 'collided with signerLeaf.')
        .toContain('persistentCommit<Vector<3, Bytes<32>>>');
    });

    /*
     * THE TAGS MUST ALSO DIFFER FROM EACH OTHER AND FROM EVERY OTHER TAG IN THE
     * FILE. Two circuits that pad the SAME string are separated from everything
     * except each other, which is the failure this row is about wearing a fix's
     * clothes.
     *
     * THE ACCOUNT CONTRACT ONLY, and the title says so rather than saying "the
     * contract" in a two-contract repository. `Vault.compact` pads two tags of
     * its own and they are not read here; they carry a different prefix
     * (`midnight-vault:`) so they cannot collide with these, but that is an
     * argument and not a check.
     *
     * The adopt/retire mutation reddens this test as well as its own,
     * deliberately — it replaces one tag with another. Noted so a result naming
     * this test beside that mutation is not read as a mis-scored catch.
     */
    it('no two domain tags in the account contract are the same string', () => {
      const tags = [...codeOf().matchAll(/pad\(32, "([^"]+)"\)/g)].map(m => m[1]);
      expect(tags.length, 'the contract pads no domain tags at all, which cannot be right')
        .toBeGreaterThan(1);
      expect(new Set(tags).size,
        `two derivations pad the same domain string: ${tags.join(', ')}`).toBe(tags.length);
    });

    /*
     * AND THE PROPERTY ITSELF, from the circuits rather than from the source.
     * Every permutation of three distinct arguments, not just the one that was
     * measured to collide — "cannot collide under ANY permutation" is the claim,
     * so every permutation is the test.
     */
    it('a signer leaf is not a proposal id under any permutation of three arguments', () => {
      const X = b(11), Y = b(12), Z = b(13);
      const leaf = toHex(pureCircuits.signerLeaf(X, Y, Z));

      const permutations: ReadonlyArray<readonly [Uint8Array, Uint8Array, Uint8Array]> = [
        [X, Y, Z], [X, Z, Y], [Y, X, Z], [Y, Z, X], [Z, X, Y], [Z, Y, X],
      ];
      for (const [p, v, s] of permutations) {
        expect(toHex(pureCircuits.proposalIdOf(p, v, s)),
          'a proposal id equals a signer leaf under a permutation of the same three '
          + 'arguments. The two circuits decide who may approve a payment and '
          + 'what was approved, and a value that is both is a value neither check can rely on.')
          .not.toBe(leaf);
      }

      /*
       * And the leaf really does read its own three arguments in one order, so
       * the assertions above cannot be satisfied by a circuit that ignores them.
       */
      expect(toHex(pureCircuits.signerLeaf(X, Z, Y))).not.toBe(leaf);
      expect(toHex(pureCircuits.signerLeaf(Y, X, Z))).not.toBe(leaf);
    });
  });
});

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * OWED, AND NAMED HERE RATHER THAN LEFT TO BE NOTICED.
 *
 * `signerLeaf`, `proposalIdOf` AND NOW `changeCommitmentOf` HAVE NO PINNED
 * VECTOR. Everything above asserts each separator's TEXT and, for the first
 * two, the property it buys; neither is the instrument the fixed-vector block
 * uses on `assetKeyOf`. A source assertion sees what this file asks the
 * primitive to do and not what the primitive does, so it would not catch a
 * change underneath a body that still reads correctly.
 *
 * `changeCommitmentOf` IS THE ONE THAT LOST A VECTOR IT ALREADY HAD, and the
 * loss is worth naming separately: for the other two the vector was never
 * written, and for this one a live literal was deleted because the separator
 * moved the value. Until it is re-pinned, the transposition mutation aimed at
 * this circuit is scored by a source assertion rather than by a value.
 *
 * WHY IT IS NOT HERE: the vector is whatever the recompiled circuit returns,
 * and nothing here may run the compiler. A number written without an
 * instrument reading it is refused rather than guessed.
 *
 * WHO CLOSES IT AND HOW. After the next recompile, read off
 * `contracts/managed/contract/index.js` — the same source and the same method
 * as the two vectors above, whose provenance is recorded at the head of that
 * block — with three distinct 32-byte inputs in which no two arguments are
 * equal, and pin:
 *
 *     pureCircuits.signerLeaf(b(11), b(12), b(13))       → owed
 *     pureCircuits.proposalIdOf(b(11), b(12), b(13))     → owed
 *
 * and, with the fixed-vector block's own inputs so the restored line sits
 * where the deleted one stood — `KEY = b(2)`, `BATCH = b(3)`, `SALT = b(4)`
 * and the 128-bit `AMOUNT` defined there, none of them equal to another:
 *
 *     pureCircuits.changeCommitmentOf(KEY, AMOUNT, BATCH, SALT)  → owed
 *
 * then add each as an `it` beside the two in *"AND IT READS THEM IN THE RIGHT
 * ORDER"*, and point the two domain-separator mutations at those titles
 * instead of at the source-text ones.
 * ─────────────────────────────────────────────────────────────────────────────
 */
