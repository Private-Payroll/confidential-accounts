/**
 * **THE FIRST TIME THIS PRODUCT'S SERVICE LAYER MEETS A REAL BINDING.**
 * `S43`, board row `2y7e`.
 *
 * ── WHY THIS FILE EXISTS, AND IT IS NOT THE SIXTEEN BYTES ────────────────────
 *
 * `C371` was that `StateChange.salt` came off `newNonce()` at sixteen bytes
 * while `proposalIdOf` argument 3 and `changeCommitmentOf` argument 4 are both
 * `Bytes<32>` and refuse anything else. That is one word to fix. **What it cost
 * was the belief that `AccountService` had ever been exercised against the
 * contract, and it cost the whole of that belief**: `scripts/deploy-preview.ts`
 * never calls `AccountService`, and every test that reaches a real binding
 * hand-builds its own 32-byte constant, so the defect was green everywhere for
 * as long as it existed.
 *
 * **THE DISTINCTION THIS FILE IS BUILT ON: NOT ONE VALUE UNDER TEST HERE IS
 * WRITTEN BY THIS FILE.** A test that constructs its own salt proves nothing —
 * that is what every existing test does and it is why `C371` lived. Every
 * `Bytes<32>` below is read off an object `AccountService` produced on the code
 * path a customer's request takes, and then handed to a generated circuit.
 * **TWO VALUES ARE THIS FILE'S OWN, AND BOTH ARE NAMED WHERE THEY ARE USED:**
 * the account-level asset blinding (`ACCOUNT_BLINDING` below — not part of a
 * `StateChange`, and unreachable from outside the Midnight private-state
 * provider), and the deliberately WRONG sixteen bytes in the last test, which
 * is a statement about the boundary rather than about the service. The entry
 * amount in `aRoundTheProductRaised` is also this file's, and it is not a
 * `Bytes<32>` — it is `changeCommitmentOf` argument 2, a `Uint<128>`, whose
 * range this file does NOT pin. `S43`'s test-coverage pass found that sentence
 * overclaiming with two exceptions where there are three, and it is corrected
 * here rather than argued with.
 *
 * ── WHAT WAS DELIBERATELY NOT HERE, AND IS NOW THE LAST TEST ─────────────────
 *
 * `S43` wrote, under this heading: *"the governance payload hash is a SEPARATE
 * defect and this file does not cover it"*. That defect is `C373` and `S44`
 * closed it, so the paragraph is replaced rather than left standing as a
 * warning about something that no longer holds.
 *
 * **`AccountService` computed `signerAddPayload` and its three siblings with
 * `src/core/ledger.ts`'s `sha256` and handed the result across the Midnight
 * boundary, where the executing circuits recompute the same four with
 * `persistentHash`.** They could never agree. The four are `CommitmentScheme`
 * methods now, and the Midnight implementations call the circuits
 * (`src/midnight/commitments.ts:262`, `:266`, `:295`, `:299`).
 *
 * **AND THE REASON IT LIVED FOR MONTHS IS THE REASON THE LAST TEST IN THIS FILE
 * IS SHAPED THE WAY IT IS:** `propose` takes the payload hash as an OPAQUE
 * argument and asserts nothing about it, so every check that stopped at
 * `propose` — including the first three tests here — was green throughout.
 * Only the circuit that CONSUMES the payload recomputes it, and that is
 * `setThreshold`, `amendSigner` and `setVaultThreshold`, at the END of the
 * round, after the approvals and the fees.
 *
 * The first three tests below use a TRANSFER, which is the path that carries no
 * such mismatch: since `C292` removed `execute`, no circuit reopens a transfer
 * proposal's payload.
 *
 * ── WHAT IT RUNS ON ──────────────────────────────────────────────────────────
 *
 * `MidnightCommitments` for the scheme, so `AccountService` computes its own
 * `chainId` through `pureCircuits.proposalIdOf` rather than through an HMAC
 * that takes a key of any length. `SimulatedLedger` underneath it, because the
 * ledger is not what is under test — the values the service builds are — and
 * `AccountSimulator` for the second test, where the same values are driven into
 * the real impure `propose` circuit against real ledger state.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountSimulator, privateStateFor } from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import { AccountService } from '../../src/core/account.js';
import {
  SimulatedLedger, type StateChange, type SignerRef, type TxRef,
} from '../../src/core/ledger.js';
import { MidnightCommitments } from '../../src/midnight/commitments.js';
import { FileStore } from '../../src/core/store-file.js';
import { assetIdBytes, MAX_CHANGE_AMOUNT, sumChangeAmount } from '../../src/core/assets.js';
import {
  fromHex, toHex, unseal, parseCanonical, newBlinding, randomBytes,
  PROPOSAL_SALT_BYTES, type Hex,
} from '../../src/core/crypto.js';

/** The MIDNIGHT scheme, against a simulated ledger. `what-a-signer-is.test.ts:188-191`. */
const service = () => new AccountService(
  new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-s43-')), 'db.json')),
  new SimulatedLedger(MidnightCommitments),
  MidnightCommitments,
);

/**
 * The account-level asset blinding, supplied HERE and said so.
 *
 * It is not part of a `StateChange` and never crosses the service's proposal
 * boundary: `MidnightLedger` reads it off the device's own private state
 * (`src/midnight/ledger.ts:1532-1550`). Any 32 bytes serve, because what
 * `changeCommitmentOf` needs of it is a width, and every signer on an account
 * derives the same key from the same one.
 */
const ACCOUNT_BLINDING: Hex = newBlinding();

/**
 * A round raised through the product's own front door, and the change it built.
 *
 * `AccountService.propose` seals `__change` into the proposal's payload
 * (`src/core/account.ts:2248-2251`), so a holder of the account's viewing key
 * reads back the EXACT `StateChange` the service constructed at `:2241-2246` —
 * salt included. That is the only reason this file can name the salt at all,
 * and it is why the transfer path is the one used: a governance round does not
 * seal its change, so its salt is unreadable from outside the service.
 */
async function aRoundTheProductRaised() {
  const accounts = service();
  const created = await accounts.create(
    'Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
  const viewingKey = created.viewingKey;

  const proposal = await accounts.propose({
    accountId: created.account.id,
    viewingKey,
    kind: 'transfer',
    summary: 'one salary',
    payload: {
      entries: [{
        id: 'e1', kind: 'transfer', asset: 'GBP', amount: 10_00n,
        counterparty: 'a supplier', memo: '', at: '',
      }],
    },
    proposedBy: created.secrets[0]!.signerId,
  });

  /*
   * A blocked proposal never reaches the ledger (`src/core/account.ts:2323`).
   *
   * **IT DOES NOT MAKE THE ASSERTIONS BELOW VACUOUS, WHICH IS WHAT THIS COMMENT
   * SAID UNTIL `S43`'S test-coverage pass CHECKED IT** — every value they read is
   * built at `:2241-2272`, above the `if (!verdict.blocked)` branch, and no
   * test in this file reads the ledger. The guard is kept because a round the
   * product refused to relay is not the round these tests claim to be about,
   * and a reader would take a green file as saying it raised one.
   */
  expect(proposal.status).toBe('open');

  const opened = parseCanonical<{ __change: StateChange }>(
    unseal(proposal.sealedPayload, viewingKey));

  return { accounts, created, viewingKey, proposal, change: opened.__change };
}

/**
 * **A LEDGER THAT RECORDS WHAT THE SERVICE HANDED IT, AND CHANGES NOTHING.**
 *
 *
 * `AccountService.propose` seals `__change` into a TRANSFER proposal, which is
 * how the three tests above name a salt without writing one. **A governance
 * round does not seal its change** (`src/core/account.ts:1221`, `:1122`,
 * `:1582`) — it seals `{ newThreshold, entries: [] }` or `{ signerId, … }` — so the salt the
 * service built is unreadable from outside the service, and the round below
 * needs it: `setThreshold` recomputes the proposal's id from `proposalSalt()`
 * and the proposing device must have carried the proposer's.
 *
 * So it is read off the ONE argument list the service passes outward. This
 * subclass overrides nothing but the recording — `super.propose` does the work
 * — and it writes no value of its own, which is this file's whole rule.
 * Constructing a change here instead would prove what `C371` proved nothing
 * about: that a test can build a legal one.
 */
class RecordingLedger extends SimulatedLedger {
  readonly raised: Array<{ payloadHash: Hex; change: StateChange; vault: Hex }> = [];

  override async propose(
    accountId: string, payloadHash: Hex, change: StateChange, by: SignerRef, vault: Hex,
  ): Promise<TxRef> {
    this.raised.push({ payloadHash, change, vault });
    return super.propose(accountId, payloadHash, change, by, vault);
  }
}

describe('the service layer meets the chain', () => {
  it('the salt on a change the SERVICE built is thirty-two bytes, and both bindings take it', async () => {
    /*
     * **`C371`'S GUARD.** Before `S43` this test failed at
     * `AccountService.propose` itself — `:2272` calls
     * `MidnightCommitments.proposalId`, which is `pureCircuits.proposalIdOf`,
     * and the binding threw a `typeError` naming argument 3 and `Bytes<32>`
     * before `aRoundTheProductRaised` could return anything to assert on.
     *
     * Note what is NOT written here: no salt. It is read off the service's own
     * object, and the two calls below are the generated circuits, unwrapped.
     */
    const { proposal, change } = await aRoundTheProductRaised();

    /*
     * **THE LITERAL, NOT `PROPOSAL_SALT_BYTES`, AND THE DIFFERENCE IS THE WHOLE
     * VALUE OF THIS LINE.** Against the constant this is the same number on
     * both sides of an equals — an edit to `PROPOSAL_SALT_BYTES` moves the
     * salt and the assertion together and the line stays green. `S43`'s
     * money-safety pass and its test-coverage pass found this independently,
     * and it matters beyond this file: `2y7g` will mutate that constant, and
     * against a self-referential assertion the catch belongs to the generated
     * binding rather than to anything this round wrote. Thirty-two is the
     * contract's number and is written as the contract's number.
     */
    expect(fromHex(change.salt)).toHaveLength(32);

    /*
     * Both calls below assert by NOT THROWING: `persistentCommit` allocates 32
     * and the wrapper length-checks its own return, so a width assertion on
     * the OUTPUT would be a tautology dressed as a measurement. What is under
     * test is whether the arguments are accepted.
     */
    const id = pureCircuits.proposalIdOf(
      fromHex(proposal.digest), fromHex(proposal.vault), fromHex(change.salt));

    /* And the service's own answer is the circuit's, not a second derivation
     * of it — `M-128`'s rule, asked of a value the service produced. This one
     * is not a tautology: `MidnightCommitments.proposalId` REORDERS its
     * arguments into the circuit's positional order
     * (`src/midnight/commitments.ts:198-201`), and a swap lands here. */
    expect(toHex(id)).toBe(proposal.chainId);

    pureCircuits.changeCommitmentOf(
      fromHex(MidnightCommitments.assetKey(change.asset, ACCOUNT_BLINDING)),
      change.amount,
      fromHex(change.batchDigest),
      fromHex(change.salt),
    );
  });

  it('and the CONTRACT writes the round under the id the service computed', async () => {
    /*
     * **THE STRONGER HALF, AND THE ONE THAT WOULD HAVE CAUGHT `C371` EVEN IF
     * THE WIDTH HAD BEEN LEGAL.** Above, the service's values go into two PURE
     * circuits. Here the same four values — asset, amount, batch digest, salt —
     * are loaded into a proposer's device state and driven through the real
     * impure `propose` circuit against real ledger state, and the question
     * asked of the contract is the one that matters: **is the round open under
     * the id the service told its user it would be?**
     *
     * `MidnightLedger.propose` asks exactly this on chain
     * (`src/midnight/ledger.ts:769-807`) and its failure message says why — a
     * derivation that disagrees with the chain's produces a round whose
     * approvals are unusable, discovered after they are collected. Nothing has
     * ever asked it of a service-built change before this file.
     */
    const { created, proposal, change } = await aRoundTheProductRaised();
    const mine = created.secrets[0]!;

    const sim = await AccountSimulator.create(privateStateFor(9));
    await sim.seatLeaf(
      fromHex(created.account.signers[0]!.leafCommitment!), [privateStateFor(9)], 43);

    /*
     * The device, with the SERVICE's material and the SERVICE's change.
     *
     * `assetBlinding` is the one field taken from `privateStateFor` rather than
     * from the service, and it is not a dodge: it is account-level device
     * secret, it is not part of a `StateChange`, and it is unreachable from
     * outside the Midnight private-state provider (`src/midnight/ledger.ts:1532-1550`).
     * Both sides of this test use the same one, which is the condition the
     * circuit actually needs.
     */
    const device = {
      ...privateStateFor(9),
      /* **THE SAME BLINDING BOTH HALVES OF THIS FILE USE.** It was
       * `privateStateFor(9)`'s until `S43`'s test-coverage pass pointed out that
       * the file then held two different account blindings and never compared
       * them — so the change commitment the circuit stores could not be checked
       * against the one the service's own material produces. */
      assetBlinding: fromHex(ACCOUNT_BLINDING),
      secretKey: fromHex(mine.signingSecret),
      blinding: fromHex(mine.blinding),
      scope: fromHex(mine.scope),
      assetId: assetIdBytes(change.asset),
      changeAmount: change.amount,
      changeBatchDigest: fromHex(change.batchDigest),
      proposalSalt: fromHex(change.salt),
    };

    /* The SERVICE's vault, not `sim.propose`'s default. The two are the same
     * value today — both are the contract's `noVault()` — so taking the default
     * worked by a coincidence rather than by the test using what the service
     * chose. `S43`'s test-coverage pass: it was the one argument of four that did
     * not come from the service. */
    await sim.as(device).propose(fromHex(proposal.digest), fromHex(proposal.vault));

    expect(sim.isOpen(fromHex(proposal.chainId))).toBe(true);

    /*
     * **AND THE CHANGE IT STORED IS THE ONE THE SERVICE'S MATERIAL PRODUCES,
     * NOT MERELY A ROUND UNDER THE RIGHT NAME.**
     *
     * `isOpen` above answers about the KEY. The value beside it is the change
     * commitment the circuit computed from the four staged witnesses, and
     * production compares exactly that — `src/midnight/ledger.ts:765` builds
     * `expected` and `:808` throws when the chain recorded a different change,
     * because every approval gathered against a disagreeing round is unusable.
     * Without this line a mismatch between the service's asset key, amount or
     * batch digest and the chain's would throw in production and leave this
     * file green. `S43`'s test-coverage pass found that gap.
     */
    expect(toHex(sim.ledger.openProposals.lookup(fromHex(proposal.chainId)))).toBe(
      MidnightCommitments.changeCommitment(
        MidnightCommitments.assetKey(change.asset, ACCOUNT_BLINDING),
        change.amount,
        change.batchDigest,
        change.salt,
      ),
    );
  });

  it('everything else that change carries into a binding, measured', async () => {
    /*
     * **THE MEASUREMENT `2y7e` WAS RUN FOR, WRITTEN AS ASSERTIONS SO IT CANNOT
     * GO STALE.** The brief asked what ELSE this path carries into a binding
     * and whether each survives, because a second `C371` found after row `3` is
     * a second redeploy. Every value below is read off the service's change or
     * its proposal; every width is the one the generated argument check demands
     * at `contracts/managed/contract/index.js:4207`, `:4221`, `:4228`, `:4247`,
     * `:4254`, `:4261`.
     *
     * The answer this round got: **the salt was the only one.**
     */
    const { proposal, change } = await aRoundTheProductRaised();

    /*
     * **A FRESH SALT PER ROUND, WHICH NOTHING ELSE IN THE REPOSITORY ASSERTS.**
     * `ConfidentialAccount.compact:2285-2288` is where the uniqueness of a
     * proposal's id rests on it: two rounds over the same payload under the
     * same salt are one id, and the second is refused as already open or
     * silently answers for the first. A generator that returned a constant of
     * the right width would satisfy every other line in this file.
     */
    const second = await aRoundTheProductRaised();
    expect(second.change.salt).not.toBe(change.salt);

    /* `changeCommitmentOf` argument 3 — `commit(canonical(entries), '')`,
     * sha256, so 32 bytes for any input (`src/core/account.ts:1993-1995`). */
    expect(fromHex(change.batchDigest)).toHaveLength(32);

    /* `assetKeyOf` argument 1 — zero-padded to `ASSET_ID_BYTES`
     * (`src/core/assets.ts`), which is what the change's asset code becomes. */
    expect(assetIdBytes(change.asset)).toHaveLength(32);

    /* `proposalIdOf` argument 1 — `commit(canonical({...}), '')`, sha256. */
    expect(fromHex(proposal.digest)).toHaveLength(32);

    /*
     * `proposalIdOf` argument 2 — the contract's own sentinel, read from it.
     *
     * **AND THIS ROW IS THE WEAK ONE, SAID HERE RATHER THAN LEFT TO BE READ AS
     * GENERAL.** `expect(proposal.vault).toBe(MidnightCommitments.noVault())`
     * stood here and was a tautology: the service computed that field by
     * calling the same function on the same object. What is measured is the
     * sentinel, which is 32 bytes by construction because the contract
     * produces it. **A REAL vault address is measured by nothing, here or
     * anywhere** — `src/core/account.ts:2209-2210` says no product caller
     * passes one, and there is no deploy path that produces one. The day there
     * is, argument 2 is the next candidate for `C371`'s shape, and this file
     * did not cover it.
     */
    expect(fromHex(proposal.vault)).toHaveLength(32);

    /*
     * **`changeCommitmentOf` ARGUMENT 2 IS A RANGE, NOT A WIDTH.** `S43` wrote
     * the gap here rather than covering it, because whether an out-of-range
     * entry amount is REACHABLE is a question about the entry writers and not
     * about this boundary. **`S46` had that traced and it is answered below.**
     */
    expect(typeof change.amount).toBe('bigint');
  });

  it('the range is refused where the change is BUILT, not left to the binding', () => {
    /*
     * **`T-205`, SETTLED. `S46`, and the trace is its money-safety pass's.**
     *
     * **THE ANSWER TO `S43`'s QUESTION: over-ceiling was REACHABLE, negative was
     * not.** The live door is the plug-in one — `POST /api/accounts/:id/plugins`
     * takes `perProposal` as a string through `parseAmount`
     * (`src/server/index.ts:1482`), **which imposes no maximum**
     * (`src/core/assets.ts:253-269`), so the only ceiling on the path was a
     * number the same caller set; `POST /api/plugin/propose`
     * (`src/server/index.ts:1533`) then passes all four of
     * `src/core/plugins.ts`'s checks (`:308-326`) and writes `entries` at
     * `:333`. A negative is refused twice before that — `parseAmount`'s regex
     * (`src/core/assets.ts:255`) and `src/core/plugins.ts:311` — **and neither
     * refusal is pinned by any test in this repository.**
     *
     * **AND THE FAILURE WAS SILENT ON THE WIRING THE PRODUCT RUNS.**
     * `src/wiring/selection.ts:144` selects the simulated scheme, which HMACs
     * the decimal string (`src/core/ledger.ts:2106-2110`) and takes a bigint of
     * any magnitude — so the round opens, collects approvals, and names a change
     * no contract can reproduce. That is `C375`'s state reached through a second
     * door. On the Midnight wiring it is loud instead, at the `changeAmount`
     * witness range check (`contracts/managed/contract/index.js:1380`), before
     * anything is submitted.
     *
     * **THE GUARD IS AT THE BUILD SITE, WHICH IS `newProposalSalt`'s SHAPE**
     * (`src/core/crypto.ts:141-146`) — not at either consumer, because by the
     * time the value reaches one it is already travelling and there are three
     * call sites to remember (`src/core/account.ts:2244`, `:2407`, `:2670`).
     *
     * **THE CEILING IS READ OFF THE BINDING'S OWN NUMBER, NOT RESTATED.**
     * `MAX_CHANGE_AMOUNT` is `(1n << 128n) - 1n`, which is what
     * `contracts/managed/contract/index.js:4220` refuses outside — asserted
     * here against the binding rather than against another constant, so a
     * contract that widened or narrowed the argument reddens this line.
     */
    expect(MAX_CHANGE_AMOUNT).toBe(340282366920938463463374607431768211455n);
    expect(() => pureCircuits.changeCommitmentOf(
      new Uint8Array(32), MAX_CHANGE_AMOUNT, new Uint8Array(32), new Uint8Array(32),
    )).not.toThrow();
    expect(() => pureCircuits.changeCommitmentOf(
      new Uint8Array(32), MAX_CHANGE_AMOUNT + 1n, new Uint8Array(32), new Uint8Array(32),
    )).toThrow(/argument 2/);

    /* And the client refuses the same two before anything is built. */
    expect(sumChangeAmount([MAX_CHANGE_AMOUNT], 'a change')).toBe(MAX_CHANGE_AMOUNT);
    expect(() => sumChangeAmount([MAX_CHANGE_AMOUNT, 1n], 'a change'))
      .toThrow(/does not fit the contract's Uint<128>/);
    expect(() => sumChangeAmount([-1n], 'a change')).toThrow(/negative/);
    /* The SUM is the point: every line is in range and the total is not. */
    expect(() => sumChangeAmount([MAX_CHANGE_AMOUNT, MAX_CHANGE_AMOUNT], 'a change'))
      .toThrow(/does not fit/);
  });

  it('a sixteen-byte salt is refused by the binding, loudly, naming the argument', async () => {
    /*
     * **`C371` ITSELF, PINNED — the refusal the product would have met the
     * first time it raised any round on a real chain.**
     *
     * This is the one place in the file that writes its own value, and it
     * writes the WRONG one deliberately: sixteen bytes, the width `newNonce()`
     * produced. It is a statement about the boundary rather than about the
     * service, which is why the service is not in it.
     */
    const { proposal, change } = await aRoundTheProductRaised();

    /*
     * **THE MATCHERS NAME THE ARGUMENT, BECAUSE THIS TEST'S TITLE DOES.**
     * `/Bytes<32>/` alone matches arguments 1, 2 and 3 of `proposalIdOf`
     * identically — measured by `S43`'s test-coverage pass — so a regression that
     * narrowed `commit()` instead of the salt would leave this test green
     * under a name claiming it pinned the salt's refusal.
     */
    expect(() => pureCircuits.proposalIdOf(
      fromHex(proposal.digest), fromHex(proposal.vault), randomBytes(16),
    )).toThrow(/proposalIdOf[\s\S]*argument 3[\s\S]*Bytes<32>/);

    expect(() => pureCircuits.changeCommitmentOf(
      fromHex(MidnightCommitments.assetKey(change.asset, ACCOUNT_BLINDING)),
      change.amount,
      fromHex(change.batchDigest),
      randomBytes(16),
    )).toThrow(/changeCommitmentOf[\s\S]*argument 4[\s\S]*Bytes<32>/);
  });

  /**
   * A GOVERNANCE ROUND, DRIVEN FROM `AccountService` TO THE CIRCUIT
   * THAT CONSUMES ITS PAYLOAD — WHICH IS THE ONLY PLACE THE DEFECT WAS
   * VISIBLE.** `S44`, board row `2y7f`.
   *
   * **THE SHAPE OF THIS TEST IS THE FINDING.** The client named what was being
   * approved with `sha256` over a colon-joined string; the contract re-derives
   * it with `persistentHash` over a padded tag. They can never agree — and
   * nothing noticed for months, because `propose` takes the payload hash as an
   * OPAQUE argument and asserts nothing whatever about it. **A test that
   * stopped at `propose` would have passed the entire time the defect
   * existed**, and the three tests above this one are exactly such tests for
   * the transfer path.
   *
   * So this one goes all the way to the end of the round, and it asserts the
   * two halves SEPARATELY and in order, because the order is the cost:
   *
   * 1. `isOpen(chainId)` — **the round is raised under the id the service told
   *    its user it would be.** This held under the defect too. Both sides of it
   *    are `proposalIdOf` over whatever hash the service produced, so a client
   *    that named the round with the wrong function still agrees with itself
   *    here. This line is in the test to be read as *the half that was always
   *    green*, not as reassurance.
   * 2. `setThreshold` — **the circuit recomputes
   *    `proposalIdOf(setThresholdPayload(newThreshold), noVault(),
   *    proposalSalt())` and compares** (`ConfidentialAccount.compact:2016`),
   *    after `requireApproved` has already passed. Under the defect this is
   *    where the round died: approvals collected, fees spent, and
   *    *"that proposal is not for this threshold"*.
   *
   * **`setThreshold` RATHER THAN `amendSigner`, AND THE BRIEF ALLOWED EITHER.**
   * Both consume a payload the same way; this one needs no invitation flow to
   * reach, so the test is about the boundary rather than about a fixture.
   * `removeSigner` and `setThreshold` are also the two rounds an account uses
   * to recover from a lost or compromised signer, which is what makes `C373`
   * a `P0` on an account holding no money.
   *
   * **WHICH VALUES COME FROM `AccountService`, NAMED SO NOBODY HAS TO TRACE
   * THEM:** the payload hash (`proposal.digest`), the proposal's id
   * (`proposal.chainId`), the vault sentinel (`proposal.vault`), the change's
   * salt, asset, amount and batch digest — every one read off the service's own
   * objects or off the argument list it passed its ledger.
   *
   * **WHAT THE TEST WRITES ITSELF IS FIVE THINGS, NOT THREE — COUNTED AFTER
   * `S44`'s test-coverage pass COUNTED IT, WHICH IS THE SAME CORRECTION `S43` HAD
   * TO MAKE TO THIS FILE'S HEADER.** (1) `NEW_THRESHOLD`, the number the round
   * is about and the number the circuit is asked for — taking it from the
   * service would compare the service to itself. (2) The FOUNDING threshold
   * `1` passed to `create`: if it equalled `NEW_THRESHOLD`,
   * `account.ts:1200` refuses *"the threshold is already 2"* and the case dies
   * in its fixture. (3) The two-signer roster, which is what gets past
   * `account.ts:1192` — the SERVICE-side guard, read off `SimulatedLedger`.
   * (4) The founding device `privateStateFor(9)`, whose seat plus the one
   * `seatLeaf` below is what gets past the CONTRACT's guard,
   * `ConfidentialAccount.compact:2029` — two seats on two different ledgers
   * for two different reasons, and only one of them is the service's. (5) The
   * seed `44`.
   */
  it('a governance round the SERVICE raised is executed by the circuit that consumes its payload',
    async () => {
      const ledger = new RecordingLedger(MidnightCommitments);
      const accounts = new AccountService(
        new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-s44-')), 'db.json')),
        ledger,
        MidnightCommitments,
      );

      /* Two signers so the ledger holds two seats: `proposeThresholdChange`
       * refuses a threshold above the seated count (`account.ts:1192`), which
       * is the M-37 guard read off the chain rather than off our roster. */
      const created = await accounts.create(
        'Northwind Ltd',
        [{ name: 'Ada', role: 'admin' }, { name: 'Blake', role: 'approver' }],
        1,
      );
      const mine = created.secrets[0]!;

      const NEW_THRESHOLD = 2;
      const proposal = await accounts.proposeThresholdChange(
        created.account.id, created.viewingKey, NEW_THRESHOLD, mine.signerId);

      /* The service's own change, off the argument list it handed its ledger. */
      const raised = ledger.raised.at(-1)!;
      /* **THE WEAKEST LINE HERE, SAID SO RATHER THAN LEFT TO BE READ AS
       * GENERAL.** Both sides are the one `const digest` at
       * `src/core/account.ts:1206`, read back through `:1222` and `:1239`, so
       * this catches a divergence between those two lines and no derivation
       * defect can reach it. It is kept because the recorded change is used
       * below and a reader should know it is the service's round. */
      expect(raised.payloadHash).toBe(proposal.digest);

      /*
       * **AND THE PAYLOAD IS THE CIRCUIT'S, NOT A SECOND DERIVATION OF IT.**
       * Written as the circuit call rather than as
       * `MidnightCommitments.signerThresholdPayload(...)`, which would compare
       * the adapter to itself. This is the one line that would have failed on
       * the day `C373` was written, and it is the cheapest of the three checks
       * here — kept because the two below it need a whole chain to say it.
       */
      expect(proposal.digest)
        .toBe(toHex(pureCircuits.setThresholdPayload(BigInt(NEW_THRESHOLD))));

      const sim = await AccountSimulator.create(privateStateFor(9));
      await sim.seatLeaf(
        fromHex(created.account.signers[0]!.leafCommitment!), [privateStateFor(9)], 44);

      /* The proposer's device, carrying the SERVICE's material and the
       * SERVICE's change. `proposalSalt` is the field `setThreshold` reads to
       * recompute the id, and it is the service's. */
      const device = {
        ...privateStateFor(9),
        secretKey: fromHex(mine.signingSecret),
        blinding: fromHex(mine.blinding),
        scope: fromHex(mine.scope),
        assetId: assetIdBytes(raised.change.asset),
        changeAmount: raised.change.amount,
        changeBatchDigest: fromHex(raised.change.batchDigest),
        proposalSalt: fromHex(raised.change.salt),
      };

      await sim.as(device).propose(fromHex(proposal.digest), fromHex(proposal.vault));

      /* HALF ONE, AND IT WAS GREEN THROUGHOUT THE DEFECT. See the header. */
      expect(sim.isOpen(fromHex(proposal.chainId))).toBe(true);

      await sim.as(device).approve(fromHex(proposal.chainId));
      expect(sim.approvalsFor(fromHex(proposal.chainId))).toBe(1n);

      /*
       * **HALF TWO: THE CIRCUIT THAT CONSUMES THE PAYLOAD.** `requireApproved`
       * passes first, so a refusal here is about what is being approved and
       * nothing else. Under `C373` this threw *"that proposal is not for this
       * threshold"* — with the round open, approved and paid for.
       */
      await sim.as(device).setThreshold(BigInt(NEW_THRESHOLD), fromHex(proposal.chainId));

      /* The chain moved, so the round SETTLED rather than merely not throwing. */
      expect(sim.ledger.threshold).toBe(BigInt(NEW_THRESHOLD));
      expect(sim.isOpen(fromHex(proposal.chainId))).toBe(false);
    });
});
