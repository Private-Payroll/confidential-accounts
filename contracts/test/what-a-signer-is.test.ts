/**
 * **THE LEAF THIS PRODUCT WRITES IS THE LEAF `requireSigner` COMPUTES.**
 * `C328`, board `2y3`, `S34`.
 *
 * ── THE DEFECT THIS FILE IS THE ALARM FOR ────────────────────────────────
 *
 * `signerPublicKey(sk)` in `contracts/src/ConfidentialAccount.compact` is
 * `persistentHash([pad(32, "midnight-accounts:signer:pk:"), sk])` — a
 * domain-separated hash of the SECRET — and `requireSigner()` builds the leaf
 * it looks for in the tree from that. Until `S34` both product writers
 * (`src/core/account.ts` at creation, `src/web/App.tsx` on the invite path)
 * passed `ed25519.getPublicKey(sk)` instead. **Different, uncorrelated 32
 * bytes.** Every seat this product had ever created was a seat whose own device
 * could never prove membership: it counts towards N, it can never approve, and
 * on an M-of-N account enough of them means nobody can move the money.
 *
 * It never bit because only `SimulatedCommitments` has ever been wired, and it
 * agreed with itself. The stagenet scripts work for the opposite reason —
 * `scripts/run-preview.ts` and `scripts/governance-steps.ts` derive live from
 * each device's own `AccountPrivateState`, through the circuit. **The product
 * path had never been tried.**
 *
 * ── WHY THIS IS NOT A MIRROR ─────────────────────────────────────────────
 *
 * `contracts/test/one-definition.test.ts` says it in its own header, and `C306`
 * is the standing row: a mirror whose two sides both end in `pureCircuits`
 * pins the ADAPTER and cannot see what the circuit computes. Two mutations of
 * these very circuits scored `SURVIVED` against a green mirror.
 *
 * So this file does not compare two derivations. **It seats the value the
 * product writes and then ACTS with it**, through the real compiled circuits.
 * `requireSigner()` derives its own leaf from the device's witnesses and
 * asserts a Merkle path to it; if the two derivations part, there is no path,
 * and the call fails. **That is the failure mode that actually happened**, and
 * it is measured rather than asserted: `mutate-authority.mjs` row 22 makes the
 * adapter hand back the secret instead of the circuit's hash of it, and this
 * file dies.
 *
 * **WHAT IT STILL CANNOT SEE, SAID HERE RATHER THAN CLAIMED AWAY** (rule 14,
 * and `S34`'s `test-auditor` corrected an earlier sentence in this header that
 * claimed otherwise): the circuit BODY. `requireSigner` calls the same
 * `signerLeaf` and `signerPublicKey` that `pureCircuits` exports and that
 * `MidnightCommitments` wraps, so a change to either body moves both sides and
 * this file stays green — which is exactly what happened when `S32` moved the
 * contract's `signerLeaf` and nothing anywhere went red. What the circuit
 * computes is pinned by hand in `contracts/test/commitments.test.ts`. What THIS
 * file holds is the adapter's arguments and encoding, and that a value the
 * product wrote is findable from the device's own witnesses.
 *
 * ── WHAT IT DOES NOT SHOW, SAID HERE RATHER THAN LEFT TO BE FOUND ────────
 *
 * That the device's `AccountPrivateState.secretKey` is the signer's own
 * `signingSecret`. **No product path writes it there.** When `S34` wrote this
 * paragraph the one writer of that field was `src/midnight/ledger.ts`, from an
 * injected `deployer()` whose only implementation in the tree was a script's
 * deterministic seed. **`C334` removed that writer entirely** — the deploy
 * layer holds no signing material at all now — so the field has NO product
 * writer rather than a wrong one, and the gap `S34` raised is still open and is
 * still `C330`'s and board `4a`'s. This file hands the same 32 bytes to both
 * sides on purpose, which is what the wiring has to do and does not yet.
 *
 * ── AND WHAT `C334` ADDED BELOW ──────────────────────────────────────────
 *
 * The `C334` block at the end of this file is here rather than in
 * `account.test.ts` for the reason this whole file exists: it is about WHICH
 * LEAF A SEAT IS, and it proves it by ACTING through the real circuits rather
 * than by comparing two derivations.
 */
import { describe, it, expect } from 'vitest';
import { AccountSimulator, leafOfDevice, privateStateFor, change } from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import { MidnightCommitments } from '../../src/midnight/commitments.js';
import { SimulatedCommitments } from '../../src/core/ledger.js';
import { toHex, fromHex } from '../../src/core/crypto.js';
import { storedSignerLeaf, type LeafScheme } from '../../src/core/signer-leaf.js';
import { AccountService } from '../../src/core/account.js';
import { SimulatedLedger } from '../../src/core/ledger.js';
import { FileStore } from '../../src/core/store-file.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FOUNDER = privateStateFor(1);
const INVITEE = privateStateFor(2);

const payload = (n: number) => new Uint8Array(32).fill(n);

/**
 * **THE PRODUCT'S WRITER ITSELF, IMPORTED — NOT A RE-SPELLING OF IT.**
 *
 * `storedSignerLeaf` is the one function `AccountService.create` and the invite
 * path in `src/web/App.tsx` both call. Spelling the three arguments out here
 * instead would make this file green for a derivation the product had stopped
 * using — the test would hold its own copy of the rule, which is the shape
 * `C306` exists for and `M-104` was.
 *
 * So what is seated below is what the product writes, and the assertion is the
 * CONTRACT accepting or refusing it. Only one side of that is a derivation.
 */
const asTheProductWrites = (
  scheme: LeafScheme, signingSecret: string, blinding: string, scope: string,
) => storedSignerLeaf({ signingSecret, blinding, scope }, scheme);

describe('C328 — what a signer’s public identity is', () => {
  it('SEATS THE LEAF THE PRODUCT WRITES AND THEN ACTS WITH IT, in circuit', async () => {
    /* One seat at a threshold of one, which is the only shape a constructor
     * makes since `S35d`. The invitee is seated below through an approved round
     * — there is no bootstrap window left, so that is how a real account's
     * signers arrive after the founder's. */
    const sim = await AccountSimulator.create(FOUNDER);

    /*
     * The invitee's seat, written exactly as the product writes one — from hex
     * key material, through `MidnightCommitments`, three arguments.
     */
    const leaf = asTheProductWrites(
      MidnightCommitments,
      toHex(INVITEE.secretKey), toHex(INVITEE.blinding), toHex(INVITEE.scope));

    await sim.seatLeaf(fromHex(leaf), [FOUNDER], 11);

    /*
     * **AND NOW THAT DEVICE ACTS.** `propose` runs `requireSigner()` at its
     * head, which derives the leaf from THIS device's own witnesses and asserts
     * a path to it in the tree. A derivation that has parted from the writer's
     * has no path, and this line throws.
     */
    sim.as(sim.applying(INVITEE, change(0n, 11)));
    await expect(sim.propose(payload(7))).resolves.toBeDefined();
  });

  it('REFUSES the leaf the writers made before S34 — the ed25519 public key', async () => {
    /*
     * The negative control, and it is the defect itself played back. Without
     * it, the test above passes for any writer the contract happens to accept
     * as well as for the right one — and the old writer is the one value that
     * must not work.
     *
     * `ed25519.getPublicKey` is not imported here: the OLD public half is taken
     * from the roster field it still fills, `Signer.signingPublicKey`, via the
     * same helper the product uses. That keeps this test pointed at the value
     * the writers actually used rather than at a reimplementation of it.
     */
    const { signingPublicKeyOf } = await import('../../src/core/crypto.js');
    const oldWay = MidnightCommitments.signerLeaf(
      signingPublicKeyOf(toHex(INVITEE.secretKey)),
      toHex(INVITEE.blinding), toHex(INVITEE.scope));

    const rightWay = asTheProductWrites(
      MidnightCommitments,
      toHex(INVITEE.secretKey), toHex(INVITEE.blinding), toHex(INVITEE.scope));
    expect(oldWay).not.toBe(rightWay);

    const sim = await AccountSimulator.create(FOUNDER);
    /* The tree accepts any 32 bytes — seating publishes whatever it is given,
     * which is the whole reason a wrong derivation is silent until a proof.
     * **AN APPROVED ROUND SEATS IT AND THAT CHANGES NOTHING ABOUT THIS TEST**:
     * `amendSigner` never looks at what a leaf means, and since `S35d` there is
     * no path that seats one without a proposal behind it. */
    await sim.seatLeaf(fromHex(oldWay), [FOUNDER], 12);

    sim.as(sim.applying(INVITEE, change(0n, 12)));
    /* **THE MESSAGE IS READ, NOT THE FACT OF A THROW.** `S34`'s `test-auditor`:
     * `rejects.toThrow()` passes for a `TypeError` from a renamed helper, and a
     * broad pattern passes for any refusal mentioning a path. The witness that
     * refuses is `contracts/src/witnesses.ts`, by name. */
    await expect(sim.propose(payload(8)))
      .rejects.toThrow(/not a signer on this account/i);
  });

  it('SEATS WHAT `AccountService.create` WROTE, THROUGH THE WRITER AND NOT THE HELPER', async () => {
    /*
     * **THE WRITER ITSELF, BECAUSE THE HELPER IS NOT WHAT SHIPS.** `S34`'s
     * `test-auditor`, and this is the finding that mattered most.
     *
     * The test above enters through `storedSignerLeaf`. That proved the helper
     * agrees with the contract and proved nothing about `AccountService.create`
     * calling it: restoring `C328`'s ed25519 line at `src/core/account.ts` left
     * **261 tests green**, including this file. `core.test.ts` cannot see it,
     * because it uses `leafCommitment` as an opaque value on both sides of every
     * approval — the writer and the checker move together, which is `C306`'s
     * shape arriving at the roster.
     *
     * So the founding leaf is taken off the account this service actually
     * created, seated, and ACTED with. Nothing in this test recomputes it.
     */
    const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-s34-')), 'db.json'));
    /* The MIDNIGHT scheme, against a simulated ledger: the ledger is not what
     * is under test here — the derivation the writer chose is. */
    const accounts = new AccountService(
      store, new SimulatedLedger(MidnightCommitments), MidnightCommitments);
    const created = await accounts.create('Northwind', [{ name: 'Ada', role: 'admin' }], 1);

    const founder = created.account.signers[0];
    expect(founder.leafCommitment).toBeTruthy();

    /* The device that seat belongs to, as the product hands it back. */
    const mine = created.secrets[0];
    const device = {
      ...FOUNDER,
      secretKey: fromHex(mine.signingSecret),
      blinding: fromHex(mine.blinding),
      scope: fromHex(mine.scope),
    };

    const sim = await AccountSimulator.create(privateStateFor(9));
    await sim.seatLeaf(fromHex(founder.leafCommitment!), [privateStateFor(9)], 13);

    sim.as(sim.applying(device, change(0n, 13)));
    await expect(sim.propose(payload(9))).resolves.toBeDefined();
  });

  it('the adapter passes the SCOPE it is given, not the one it defaults to', () => {
    /*
     * **`T-116`, ONE LAYER BELOW WHERE THIS ROUND CLOSED IT.** `S34`'s
     * `test-auditor`: forcing `src/midnight/commitments.ts` to ignore its
     * `scope` argument and always use `allVaults()` SURVIVED every test, because
     * every caller in the suite passes the default — so the coverage was of the
     * default value and not of the parameter.
     *
     * That is the scheme that reaches a chain. The first per-vault-scoped seat
     * written under it would be one its own device cannot reproduce, which is
     * the lockout `T-116` exists to prevent.
     */
    const PER_VAULT = 'a1'.repeat(32);
    const defaulted = MidnightCommitments.signerLeaf(
      toHex(pureCircuits.signerPublicKey(INVITEE.secretKey)), toHex(INVITEE.blinding));
    const scoped = MidnightCommitments.signerLeaf(
      toHex(pureCircuits.signerPublicKey(INVITEE.secretKey)), toHex(INVITEE.blinding), PER_VAULT);

    expect(scoped).not.toBe(defaulted);
    /* And it is the CONTRACT's value for that scope, not merely a different
     * one — an adapter that hashed the scope itself would also differ. */
    expect(scoped).toBe(toHex(pureCircuits.signerLeaf(
      pureCircuits.signerPublicKey(INVITEE.secretKey), INVITEE.blinding, fromHex(PER_VAULT))));
    /* The absent case is the sentinel and not some other value. */
    expect(defaulted).toBe(MidnightCommitments.signerLeaf(
      toHex(pureCircuits.signerPublicKey(INVITEE.secretKey)), toHex(INVITEE.blinding),
      MidnightCommitments.allVaults()));
  });

  it('the adapter is the circuit, so nothing restates the hash in TypeScript', () => {
    /*
     * `M-104` is what a second implementation of a money rule costs, and `C306`
     * is what a test that then compares it to itself is worth. There is no
     * second implementation: this asserts the wrapper's ARGUMENTS and ENCODING,
     * which is the only thing a mirror can honestly hold.
     */
    expect(MidnightCommitments.signerPublicKey(toHex(INVITEE.secretKey)))
      .toBe(toHex(pureCircuits.signerPublicKey(INVITEE.secretKey)));
  });

  it('the SIMULATED scheme still does not agree with the contract, and must not', () => {
    /*
     * `S32`'s rule, one argument further in. `SimulatedCommitments` is a
     * deliberately different HMAC scheme; a round that "unified" the two would
     * make the simulation emit values it cannot prove, and the leaf is the one
     * place that would look like progress.
     */
    const sk = toHex(INVITEE.secretKey);
    expect(SimulatedCommitments.signerPublicKey(sk))
      .not.toBe(MidnightCommitments.signerPublicKey(sk));
    expect(
      asTheProductWrites(
        SimulatedCommitments, sk, toHex(INVITEE.blinding), SimulatedCommitments.allVaults()),
    ).not.toBe(
      asTheProductWrites(
        MidnightCommitments, sk, toHex(INVITEE.blinding), MidnightCommitments.allVaults()),
    );
  });
});

/**
 * **`C334` — THE DEPLOYING DEVICE IS NOT A SIGNER.** `P0`, board `2y6`, `S35`.
 *
 * ── THE DEFECT THIS BLOCK IS THE ALARM FOR ───────────────────────────────
 *
 * The constructor used to read `localSecretKey()`, `signerBlinding()` and
 * `signerScope()` and seat the leaf it committed from them — so the account's
 * first seat belonged to whatever process ran the deploy. On the only deploy
 * path in the tree that process's secret was `seededBytes(1)` and its blinding
 * `seededBytes(401)`, a formula published in a repository that is going public.
 * **Every account this project deployed would have carried a signer that any
 * reader could be, from any machine, for ever** — one permanent approval toward
 * every threshold, including every `recordPayment` that moves a vault's money.
 *
 * ── WHY THIS COULD NOT HAVE BEEN TESTED BEFORE ───────────────────────────
 *
 * `AccountSimulator.create(x, n)` handed `x` to the constructor and the
 * constructor derived the seat from `x`, so the deploying device and the seated
 * signer were **the same value by construction** and no assertion could tell
 * them apart. The factory takes the founding leaf as its own argument now — its
 * only other one, since `S35d` deleted the threshold — so this block can hand
 * it two DIFFERENT devices — which is the only arrangement in which
 * "the deployer has no seat" is a claim that can be false.
 *
 * ── WHAT IT DOES NOT SHOW ────────────────────────────────────────────────
 *
 * That no secret exists in the real deploying PROCESS. That is a property of
 * `src/midnight/ledger.ts` — it has no `deployer()` injection point any more —
 * and of `scripts/deploy-preview.ts`, and neither is reachable from a circuit
 * test. What this block holds is the CONTRACT's half: that the seat is the
 * argument and never a witness.
 */
describe('C334 — the deployer has no seat', () => {
  /* Two different devices. `DEPLOYING` runs the deploy; `FOUNDING` is the
   * person whose device made the leaf. They share nothing. */
  const DEPLOYING = privateStateFor(77);
  const FOUNDING = privateStateFor(78);

  it('seats the founding leaf it is given and never one derived from the deploying device', async () => {
    const sim = await AccountSimulator.create(DEPLOYING, leafOfDevice(FOUNDING));

    /* One seat, and it is the founder's. Read off the TREE, which is what a
     * membership proof reads, rather than off a count that says nothing about
     * whose seat it is. */
    expect(sim.ledger.signerLeaves.size()).toBe(1n);
    expect(sim.ledger.signers.findPathForLeaf(leafOfDevice(FOUNDING))).toBeTruthy();
    expect(sim.ledger.signers.findPathForLeaf(leafOfDevice(DEPLOYING))).toBeFalsy();

    /* **AND THE FOUNDER ACTS**, which is the half a tree lookup cannot show:
     * `propose` runs `requireSigner()`, which derives the leaf from THIS
     * device's own witnesses and asserts a path to it. A seat that is in the
     * tree but does not answer to the founder's witnesses fails here. */
    sim.as(sim.applying(FOUNDING, change(0n, 21)));
    await expect(sim.propose(payload(21))).resolves.toBeDefined();
  });

  it('leaves the deploying device unable to propose or to seat anybody', async () => {
    /*
     * THE NEGATIVE CONTROL, AND IT IS THE DEFECT ITSELF PLAYED BACK. Without
     * it the test above passes on a contract that seats BOTH — which is
     * precisely what a half-done version of this change would produce.
     *
     * `addSigner` is the one that mattered: `amendSigner` opens with
     * `requireSigner()`, and the seat the deployer used to hold is what let it
     * walk the bootstrap window seating whoever it liked.
     *
     * **THE WINDOW IS SHUT FOR EVERYBODY NOW (`S35d`), AND THAT DOES NOT MAKE
     * THIS LINE REDUNDANT.** `requireSigner()` is still the first thing
     * `amendSigner` does, so a deploying device that held a seat would still
     * pass it and could still propose, approve and seat through the ordinary
     * path — three transactions instead of one, and the same account. What
     * changed is the cost to the attacker, not whether they are one.
     */
    const sim = await AccountSimulator.create(DEPLOYING, leafOfDevice(FOUNDING));

    sim.as(sim.applying(DEPLOYING, change(0n, 22)));
    await expect(sim.propose(payload(22)))
      .rejects.toThrow(/not a signer on this account/i);

    await expect(sim.as(DEPLOYING).addSigner(leafOfDevice(privateStateFor(79))))
      .rejects.toThrow(/not a signer on this account/i);
  });

  it('refuses to found an account on a leaf that may never be seated', async () => {
    /*
     * BOTH GUARDS, AND A PUBLIC ARGUMENT IS WHY THEY ARE HERE AT ALL. Nothing
     * checked these in the constructor before, because nothing could supply
     * them: the leaf was derived in-circuit and a `persistentCommit` output is
     * neither zero nor a padded ASCII string. An argument is attacker-chosen.
     *
     * Zero is what an uninitialised caller sends. `vacantSlot()` is the marker
     * a removal writes, and an account FOUNDED on it would have its only
     * signer's position read as free — the next seating takes slot 0 and the
     * founder is gone, with nobody having voted for it.
     *
     * The same loop and the same reasoning as `signer-governance.test.ts`'s
     * "refuses a leaf of all zeros", one circuit earlier.
     */
    for (const bad of [new Uint8Array(32), pureCircuits.vacantSlot()]) {
      await expect(AccountSimulator.create(DEPLOYING, bad))
        .rejects.toThrow(/not a usable signer leaf/);
    }
  });

  it('SEATS A LEAF THE PRODUCT WRITER PRODUCED, not one this test derived', async () => {
    /*
     * **THE COMPOSITION `C334` ACTUALLY INTRODUCES, AND NOTHING ELSE COVERED
     * IT.** `S35`'s `test-auditor`.
     *
     * The three tests above hand the constructor `leafOfDevice(...)`, which is
     * `pureCircuits` directly — so they prove the CONTRACT seats its argument
     * and prove nothing about the value the product hands it. On the real path
     * the founding leaf is `storedSignerLeaf(material, MidnightCommitments)`
     * (`scripts/deploy-preview.ts`), and a mismatch between that writer's scope
     * defaulting (`signer-leaf.ts`: `material.scope ?? commitments.allVaults()`)
     * and the device's own `scope` would be invisible to every test in this
     * block — while `:105-129` proves exactly that composition one circuit
     * later, for `addSigner`.
     *
     * So: the WRITER makes the leaf, the CONSTRUCTOR seats it, and the device
     * it belongs to then ACTS through `requireSigner()`. Nothing here
     * recomputes the leaf.
     */
    const writersLeaf = asTheProductWrites(
      MidnightCommitments,
      toHex(FOUNDING.secretKey), toHex(FOUNDING.blinding), toHex(FOUNDING.scope));

    const sim = await AccountSimulator.create(DEPLOYING, fromHex(writersLeaf));

    sim.as(sim.applying(FOUNDING, change(0n, 23)));
    await expect(sim.propose(payload(23))).resolves.toBeDefined();

    /* And the deploying device still has nothing, on this path too. */
    sim.as(sim.applying(DEPLOYING, change(0n, 24)));
    await expect(sim.propose(payload(24)))
      .rejects.toThrow(/not a signer on this account/i);
  });

  it('still seats one signer, at a threshold of one, when founder and deployer are the same device', async () => {
    /*
     * The ordinary case, kept explicit: a founder deploying for themselves is
     * not a special path in the contract, and the factory's default is exactly
     * that. This is also what every other test in `contracts/test/` relies on,
     * so it is asserted once here rather than assumed 32 times.
     *
     * **THE TITLE SAID *"and the threshold it was given"* AND THERE IS NOTHING
     * TO GIVE ANY MORE.** `S35d`, `C340` + `C343`. The constructor takes one
     * argument and sets `threshold = 1`, so the pair below is the only state a
     * constructor can produce.
     */
    const sim = await AccountSimulator.create(FOUNDING);
    expect(sim.ledger.signerLeaves.size()).toBe(1n);
    expect(sim.ledger.threshold).toBe(1n);
    expect(sim.ledger.signers.findPathForLeaf(leafOfDevice(FOUNDING))).toBeTruthy();
  });
});

/**
 * **`C340` + `C343` — AN ACCOUNT CANNOT BE FOUNDED WITH NO RULE, AND CANNOT BE
 * FOUNDED WITH A RULE NOBODY CAN MEET.** Both `P0`, board `2y6b`, closed by
 * `S35d` on the founder's ruling of 2 Sep.
 *
 * ── THE TWO DEFECTS THIS BLOCK IS THE ALARM FOR ──────────────────────────
 *
 * `requireApproved` asserts `!(approvalCounts.lookup(proposal) < threshold)`.
 * At a threshold of zero that is `!(0 < 0)`, which PASSES with nobody having
 * approved — and `thresholdFor` hands the account's threshold to any vault
 * with no entry of its own, so `recordPayment` would move a vault's money on a
 * proposal no signer voted for. That is `C340`. And nothing bounded the value
 * from ABOVE either: an account founded needing fifty approvals with one seat
 * is frozen for ever, because `setThreshold` is the only way down and it is
 * itself behind `requireApproved`. That is `C343`.
 *
 * ── WHAT CHANGED, AND WHY THIS BLOCK LOOKS DIFFERENT NOW ─────────────────
 *
 * `S35b` built a FLOOR — `assert(disclose(requiredApprovals) > 0, …)` — and
 * this block was written against it: hand the constructor a zero, watch it
 * refuse. **The founder ruled on 2 Sep that the argument goes instead of being
 * guarded**, after `SC5` §4.3 found that *"takes no threshold"* was the
 * controller's paraphrase of his words rather than his words.
 * `docs/company-accounts.md` §10.
 *
 * **SO THERE IS NO REFUSAL LEFT TO TEST, AND THAT IS THE POINT OF THE
 * DELETION.** The constructor takes one argument and assigns a literal. A
 * founding threshold of zero, and a founding threshold above the seat count,
 * are UNREPRESENTABLE rather than REFUSED — which is a stronger property and a
 * harder one to assert, because there is no bad input to hand in.
 *
 * ── SO WHAT THIS BLOCK HOLDS INSTEAD, AND IT IS THE SAME HARM ────────────
 *
 * The line that could still break is `threshold = 1;`. Break it to
 * `threshold = 0;` and `C340` is back, in full, with no argument anywhere near
 * it. **That is the mutation `MUTATE.command` now scores here**, and the test
 * below is what goes red for it: at a threshold of zero the approval gate
 * passes with nobody having approved, and the assertion is on a governed
 * circuit REFUSING rather than on any number read off the ledger.
 *
 * ── WHY IT IS HERE AND NOT IN `signer-governance.test.ts` ────────────────
 *
 * That file holds the two SETTERS' floors, and both are about an account that
 * already exists changing its own rule by an approved round. This is the
 * FOUNDING moment and it sits beside the two leaf guards `C334` added, which
 * are the constructor's other arguments-are-attacker-chosen block.
 *
 * ── WHAT IT DOES NOT SHOW ────────────────────────────────────────────────
 *
 * That no client asks for a threshold it will not get. `AccountService.create`
 * and `SimulatedLedger.open` still take one and still refuse zero, and
 * `MidnightLedger.open` still refuses one it no longer forwards — three
 * refusals guarding OUR OWN RECORD of the account rather than the chain. Their
 * changed job is written where they are.
 */
describe('C340 + C343 — an account is founded at one, and one is a rule', () => {
  const DEPLOYING = privateStateFor(81);
  const FOUNDING = privateStateFor(82);

  it('founds every account at a threshold that is not met before anybody approves', async () => {
    /*
     * **ONE: THE NUMBER, READ OFF THE LEDGER RATHER THAN ASSUMED.** There is no
     * argument, so there is no call that could ask for anything else — and a
     * constructor that assigned zero would satisfy every other test in this
     * directory that never looks at `threshold`.
     */
    const sim = await AccountSimulator.create(DEPLOYING, leafOfDevice(FOUNDING));
    expect(sim.ledger.threshold).toBe(1n);

    /*
     * **TWO: THE HARM ITSELF, EXERCISED AND NOT DESCRIBED.** This is what the
     * old block could not do. `S35b`'s floor made a zero unreachable through
     * the constructor, so `!(0 < 0)` PASSING was unexercisable by any test and
     * this file said so plainly rather than claiming coverage it did not have.
     *
     * **The deletion gives it back.** `threshold` is now assigned from a
     * literal in the constructor, so a mutation writes the harmful value
     * directly and `!(0 < 0)` is reached with an approval count of nought.
     *
     * **WHAT HAPPENS THEN, SAID EXACTLY, BECAUSE AN EARLIER DRAFT OF THIS
     * PARAGRAPH OVERSTATED IT** — found by this round's `test-auditor` against
     * this round's own words. `setThreshold` runs `requireApproved` FIRST and
     * its payload check SECOND. `id` below was raised over `payload(31)`, which
     * is not a `setThresholdPayload`, so at a threshold of zero the approval bar
     * PASSES and the payload check then refuses with *"that proposal is not for
     * this threshold"*. The rule does not move. **What the assertion reads is
     * WHICH refusal came back**, and that is the discrimination: at one it is
     * *"not enough approvals yet"* and the gate is what answered; at zero the
     * gate waved it through and a different line stopped it. Either way this
     * test goes red for the mutation and for nothing else in the file.
     */
    const c = change(0n, 31);
    await sim.as(sim.applying(FOUNDING, c)).propose(payload(31));
    const id = sim.proposalId(payload(31), c.salt);
    expect(sim.approvalsFor(id)).toBe(0n);
    await expect(sim.as(sim.applying(FOUNDING, c)).setThreshold(2n, id))
      .rejects.toThrow(/not enough approvals yet/);
  });

  it('founds every account with its threshold no higher than its seats, which is C343', async () => {
    /*
     * **`C343`'s HALF, AND IT IS AN ASSERTION ABOUT A RELATIONSHIP RATHER THAN
     * A NUMBER.** An account whose threshold exceeds its seat count can never
     * approve anything, so it can never lower the threshold either — frozen,
     * with every vault that named it. The constructor's floor could not have
     * refused that: a floor bounds one end.
     *
     * One seat and a bar of one is the only state a constructor makes now, so
     * the relationship holds at birth. **The pair below is what `setThreshold`'s
     * ceiling then preserves for the rest of the account's life** — the two
     * together are why `signerLeaves.size() < threshold` is unreachable, which
     * is `docs/company-accounts.md` §10a and the reason `amendSigner`'s free
     * branch is dead code.
     */
    const sim = await AccountSimulator.create(DEPLOYING, leafOfDevice(FOUNDING));
    expect(sim.ledger.threshold).toBe(1n);
    expect(sim.ledger.signerLeaves.size()).toBe(1n);
    expect(sim.ledger.threshold).toBeLessThanOrEqual(sim.ledger.signerLeaves.size());
  });
});
