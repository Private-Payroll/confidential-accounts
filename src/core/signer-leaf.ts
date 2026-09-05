/**
 * **THE STORED LEAF, CHECKED AGAINST THE DEVICE THAT HAS TO REPRODUCE IT.**
 * `C325`.
 *
 * `Signer.leafCommitment` is written once — at creation (`account.ts:666`) or
 * handed over by an invitee's device (`src/web/App.tsx:2202`) — and the blinding
 * that made it never arrives (decision 0003; `AccountService.acceptSignerInvite`
 * has no parameter for one and `PendingSignerPayload` has the matching hole).
 * Seating publishes the STORED value: `grantAccess` passes
 * `signer.leafCommitment` to `Ledger.addSigner` (`account.ts:988`), and on
 * Midnight that becomes `amendSigner`'s first argument
 * (`src/midnight/ledger.ts:1077`). The circuits that gate acting then recompute
 * the leaf IN-CIRCUIT from the caller's own witnesses and assert a path to it —
 * `requireSigner()`, `contracts/src/ConfidentialAccount.compact:1026-1042`,
 * called by `amendSigner`, `setThreshold`, `propose`, `approve`, `cancel`,
 * `setVaultThreshold` and `adopt`. **Not by every circuit**: `recordPayment`,
 * `closeExpiredRun` and `retireVault` deliberately do not, and each says why in
 * its own comment.
 *
 * **SO THERE ARE TWO COPIES OF ONE VALUE, THEY MUST BE EQUAL, AND UNTIL THIS
 * FILE NOTHING COMPARED THEM.** A signer whose stored leaf disagrees with the
 * one their device computes is seated as a leaf nobody holds a blinding for:
 * they cannot approve, the seat still counts towards N, and on an M-of-N
 * account enough of them means nobody can move the money.
 *
 * ---
 *
 * **WHY THE CHECK IS HERE AND NOT AT THE SEAT, WHICH IS WHERE `C325` AND BOARD
 * `2y` BOTH PUT IT.** `docs/corrections.md`, 31 Aug.
 *
 * Both of the register's *Done when* options need the owning device's blinding
 * at the moment of seating, and it is not there and must not be:
 *
 *   · **Re-derive at the seat.** `grantAccess` runs on an EXISTING signer's
 *     device — it takes the viewing key as an argument precisely because the
 *     caller already holds one (`account.ts:928-938`) — and the invitee's
 *     blinding never left the invitee's machine. Nothing at that call site can
 *     derive anything.
 *   · **Drop the stored copy and derive on demand.** The same wall, harder:
 *     with no stored leaf there is nothing to seat at all, and the invitee
 *     would have to be online for their own seating. That is exactly the
 *     requirement M-106 removed when it took `blinding` back out of the roster
 *     and out of the API, so that "the server can no longer receive one at all"
 *     (decision 0003).
 *
 * The two copies can only meet on one machine: **the owning signer's own
 * device**, which holds the blinding and, once it opens the account, the roster
 * that records the leaf. That is where this runs.
 *
 * ---
 *
 * **WHAT THIS CHECKS, EXACTLY, AND WHAT IT DOES NOT.** Rule 27 / `C286`: a
 * property is worth no more than what enforces it, and the sentence below is
 * the whole of it.
 *
 * It reproduces **the derivation the WRITERS use** — `signerLeaf(
 * signerPublicKey(signingSecret), blinding, scope)`, every argument from the
 * scheme this device was handed and the key material this device holds. So it
 * answers: *does this device still compute the value that was written down for
 * it?* That is `C325`'s question and this file answers it.
 *
 * **AND SINCE `S34` IT ALSO ANSWERS THE BIGGER ONE, BECAUSE THE WRITERS MOVED.**
 * `C328`: until `S34` both product writers passed an ed25519 public key where
 * the contract reads `persistentHash([pad(32, "midnight-accounts:signer:pk:"),
 * sk])` — different, uncorrelated 32 bytes, so every seat this product had ever
 * written was one no device could prove on a chain. The public half now comes
 * from `CommitmentScheme.signerPublicKey`, which under the Midnight wiring IS
 * `pureCircuits.signerPublicKey` and under the simulated wiring is deliberately
 * unrelated to it. **So on a Midnight wiring the value derived here is the value
 * `requireSigner()` builds in circuit, and `contracts/test/one-definition.test.ts`
 * is the test that fails if the two ever part again.**
 *
 * **WHAT STILL DOES NOT AGREE, SAID HERE RATHER THAN LEFT TO BE FOUND.** The
 * circuit reads the secret from `AccountPrivateState.secretKey`
 * (`contracts/src/witnesses.ts:180`), and **no product path writes a signer's
 * own `signingSecret` there.** The only writer of that field is
 * `src/midnight/ledger.ts:415-416`, from an injected `deployer()` whose one
 * implementation in the tree is a script's deterministic seed. So the
 * DERIVATION now agrees and the WIRING of the secret into the device's private
 * state does not yet exist — raised by `S34` for the register, and it is the
 * next thing between this product and a seat that can approve.
 *
 * **AND IT IS A DERIVATION, NOT A COMPARISON OF TWO CLAIMS.** `C323` is the row
 * for a check that agreed with a record because it compared two records; the
 * public key here comes from the device's own SECRET and never from
 * `Signer.signingPublicKey`, so a roster that had been substituted whole still
 * fails.
 */
import type { Hex } from './crypto.js';
import type { CommitmentScheme } from './ledger.js';

/**
 * The three methods this file needs from whichever scheme is wired. Named
 * rather than taking the whole interface so a caller cannot quietly hand this
 * a scheme assembled from two others.
 */
export type LeafScheme = Pick<CommitmentScheme, 'signerLeaf' | 'signerPublicKey' | 'allVaults'>;

/**
 * **WHAT A DEVICE HOLDS FOR ONE SEAT.** The scope joined it in `S34`, `T-116`.
 *
 * `scope` is the leaf's third argument. It is OPTIONAL and absent means
 * `allVaults()`, which is what every bundle written before `S34` means — those
 * seats were made by writers that passed two arguments and took the scheme's
 * default. It is here, on the DEVICE's material, and not on the roster,
 * because that is where the circuit reads it from: `signerScope()` is a witness
 * over `AccountPrivateState.scope` (`contracts/src/witnesses.ts:187-188`), and
 * a scope on the seat would additionally publish to the server which vault a
 * signer is scoped to, which is the partition of the signer set that the leaf's
 * blinding exists to hide.
 */
export interface DeviceLeafMaterial {
  signingSecret: Hex;
  blinding: Hex;
  scope?: Hex;
}

/**
 * **SIX VERDICTS, BECAUSE THEY HAVE SIX DIFFERENT REMEDIES.** `C320`'s shape,
 * and its rule: a refusal that could be mistaken for its neighbour is the
 * defect, because the two have opposite next steps.
 *
 *   agrees               this device reproduces the leaf the roster records.
 *   disagrees            there is a leaf here and a leaf there and they are not
 *                        the same value.
 *   no-seat              the roster holds no signer with this id at all. Not a
 *                        leaf problem: `refFor` calls this "not a signer on
 *                        this account" and it is a different sentence.
 *   no-stored-leaf       the seat exists and has no leaf — `leafCommitment` is
 *                        nullable for signers created before M-13. They are not
 *                        in the on-chain tree and `refFor` already refuses by
 *                        name when they try to act.
 *   no-device-key        no key material was offered for this seat. A member on
 *                        a machine they have not enrolled is a real state.
 *   device-key-unusable  key material IS here and it is not a signing secret
 *                        and a blinding this side can use. **That is not the
 *                        same state**: it is a device holding a seat it cannot
 *                        prove, which is the failure `disagrees` exists for,
 *                        arriving by the other door.
 */
export type OwnLeafVerdict =
  | 'agrees'
  | 'disagrees'
  | 'no-seat'
  | 'no-stored-leaf'
  | 'no-device-key'
  | 'device-key-unusable';

export interface OwnLeafReading {
  signerId: string;
  verdict: OwnLeafVerdict;
  /** What the roster records. Null when there is no seat or no leaf on it. */
  stored: Hex | null;
  /** What this device computes. Null when there is no usable key material. */
  derived: Hex | null;
}

const HEX64 = /^[0-9a-f]{64}$/i;
const half = (k: Hex): string => `${k.slice(0, 16)}…`;

/**
 * **THE LEAF THIS PRODUCT WRITES. ONE DEFINITION, AND EVERY WRITER CALLS IT.**
 * `C328`, `S34`, decision 0004.
 *
 * There were two writers — `AccountService.create` and the invite path in
 * `src/web/App.tsx` — each spelling the derivation out, and a third spelling in
 * this file to check them with. Three copies of the rule that decides who may
 * approve a payment. `C328` is what the first two disagreeing with the contract
 * cost; **M-104 is what two copies of a signer rule cost the last time**, and
 * the answer both times is one definition rather than more care.
 *
 * So: the writers call this, `ownLeafReading` calls this, and
 * `contracts/test/what-a-signer-is.test.ts` seats what this returns and then
 * ACTS with it through the real circuits. A round that moves this line moves
 * every writer with it and is answered by the contract rather than by a mirror.
 *
 * **THE PUBLIC HALF IS THE SCHEME'S AND THE SECRET NEVER LEAVES.** Under the
 * Midnight wiring `signerPublicKey` IS `pureCircuits.signerPublicKey`; under
 * the simulated one it is deliberately something else. Neither is restated here.
 */
export function storedSignerLeaf(
  material: { signingSecret: Hex; blinding: Hex; scope?: Hex },
  commitments: LeafScheme,
): Hex {
  return commitments.signerLeaf(
    commitments.signerPublicKey(material.signingSecret),
    material.blinding,
    material.scope ?? commitments.allVaults(),
  );
}

/**
 * The reading, as a value rather than a branch inside a throw.
 *
 * Pure and exported for `mintedSignerIds`' reason (`C275`): a rule about money
 * that lives only inside its caller is a rule no test can reach.
 *
 * **THE SCOPE TRAVELS WITH THE DEVICE'S MATERIAL, AND `S33` LEFT A NOTE HERE
 * SAYING THIS DAY WOULD COME.** `T-116`, closed by `S34`.
 *
 * It said: both writers pass two arguments, so the scheme's `allVaults()`
 * default made every stored value, and **the day a writer passes a scope
 * explicitly, this function has to take it from wherever that writer took it,
 * and nothing here goes red when that day comes.** Both writers now pass one,
 * and this takes it from the same place they do — the device's own key material
 * — so the day arrived by construction rather than by accident.
 *
 * `undefined` still means `allVaults()`, which is what every seat written
 * before `S34` was made under. That fallback is the scheme's own sentinel and
 * not a constant written out here, for the reason the sentinels are on the
 * scheme at all (decision 0004).
 */
export function ownLeafReading(
  seat: { id: string; leafCommitment: Hex | null } | null | undefined,
  device: DeviceLeafMaterial | null | undefined,
  commitments: LeafScheme,
): OwnLeafReading {
  const signerId = seat?.id ?? '(no seat)';
  const stored = seat?.leafCommitment ?? null;

  if (!device) return { signerId, verdict: 'no-device-key', stored, derived: null };

  if (!HEX64.test(device.signingSecret ?? '') || !HEX64.test(device.blinding ?? '')) {
    return { signerId, verdict: 'device-key-unusable', stored, derived: null };
  }

  /* The writers' own function, not a reproduction of it. `C328`. */
  const derived = storedSignerLeaf(device, commitments);

  if (!seat) return { signerId, verdict: 'no-seat', stored: null, derived };
  if (!stored) return { signerId, verdict: 'no-stored-leaf', stored: null, derived };

  return {
    signerId,
    verdict: stored.toLowerCase() === derived.toLowerCase() ? 'agrees' : 'disagrees',
    stored,
    derived,
  };
}

/**
 * **THE REFUSAL, AND IT REFUSES THE TWO CASES WHERE THIS MACHINE HOLDS A SEAT
 * IT CANNOT PROVE.**
 *
 * `disagrees` and `device-key-unusable` stop. The other four are states a
 * person is allowed to be in:
 *
 *   · `no-seat` and `no-stored-leaf` — the refusal that matters is `refFor`'s,
 *     at the moment they try to ACT, and it already exists and already names
 *     them. Locking them out of READING their own company would be a new
 *     lockout in a round whose whole subject is lockouts.
 *   · `no-device-key` — already the screen's own case, in its own words.
 *   · `agrees` — nothing to say.
 *
 * **WHY THESE TWO FAIL CLOSED.** M-69's lesson, in this same product: a signer
 * shown as active whose every approval fails inside a proof is the defect, not
 * the safe state. **AND THE POSITION AGAINST, WRITTEN HERE BECAUSE `S33`'s
 * `money-safety-auditor` HELD IT AND IT WAS NOT MARKED WRONG (rule 20):** the
 * leaf is never rewritten, so a derivation that moves puts EVERY signer on an
 * account into `disagrees` at once, and refusing the read refuses the app the
 * remedy is performed in. The end state is a screen that opens and disables the
 * controls that cannot work, with their reason — rule 22b's shape — and it is a
 * `BACKLOG.md` row rather than this round.
 *
 * **NO DOOR REPAIRS THIS IN PLACE AND THE REFUSAL SAYS SO** rather than
 * implying a retry will help.
 */
export function requireOwnLeaf(reading: OwnLeafReading): void {
  if (reading.verdict === 'device-key-unusable') {
    throw new Error(
      'THE KEY MATERIAL THIS DEVICE HOLDS FOR THIS SEAT IS NOT A SIGNING SECRET AND A ' +
        'BLINDING.\n' +
        'This is NOT \x27your keys for this account are not on this device\x27 — there is an ' +
        'entry here for this seat — and it is not a mismatch either, because nothing can be ' +
        'derived from what is here to mismatch with.\n' +
        `  ${reading.signerId}\n` +
        'WHAT IT MEANS. A leaf is computed from the signing secret and the blinding, and the ' +
        'blinding is as precious as the key: without it this device cannot reproduce its own ' +
        'leaf and cannot prove membership on the contract, holding a valid signing key ' +
        '(decision 0003). Carrying on would show an active seat whose every approval fails ' +
        'inside a proof.\n' +
        'WHAT RESOLVES IT. Enrolling this device again from a machine that has the whole ' +
        'entry, or restoring it from a backup of the key bundle. If no machine has it, the ' +
        'seat has to be replaced by an approved round from another signer\x27s device.\n' +
        'NOTHING WAS PROVED, NOTHING WAS SUBMITTED AND NOTHING WAS WRITTEN.',
    );
  }

  if (reading.verdict !== 'disagrees') return;

  throw new Error(
    'THIS DEVICE COMPUTES A DIFFERENT LEAF THAN THE ONE RECORDED FOR THIS SEAT.\n' +
      'This is NOT \x27your keys for this account are not on this device\x27 and it is NOT ' +
      '\x27this seat has no leaf\x27. There is key material here, there is a leaf on the ' +
      'record, and they are two different values. The three have different remedies, which is ' +
      'why they are three sentences.\n' +
      `  ${reading.signerId}\n` +
      `    the account\x27s roster records   ${half(reading.stored!)}\n` +
      `    this device computes             ${half(reading.derived!)}\n` +
      'WHAT IT MEANS. Seating publishes the RECORDED value into the on-chain signer tree, and ' +
      'the circuits that gate acting recompute the leaf from this device\x27s own witnesses. ' +
      'Those two are the values above. A proof built here would look for a path to the second ' +
      'while the tree holds the first, so every approval from this device would be refused ' +
      'inside the proof — and the seat would still count towards the threshold. On an M of N ' +
      'account, enough seats like this one and nobody can move the money.\n' +
      'WHAT RESOLVES IT, AND THERE IS NO DOOR THAT REPAIRS A RECORDED LEAF IN PLACE. If this ' +
      'device\x27s original blinding still exists somewhere, restoring the key bundle from a ' +
      'machine or a backup that has it resolves it and nothing else needs to happen. ' +
      'Otherwise the seat is replaced: another signer, on a device this is not happening on, ' +
      'proposes and the account approves a new leaf computed here. IF EVERY DEVICE ON THIS ' +
      'ACCOUNT REPORTS THIS, neither remedy applies — the derivation itself has moved, which ' +
      'is a defect in the software and not something any door on this account can undo.\n' +
      'NOTHING WAS PROVED, NOTHING WAS SUBMITTED AND NOTHING WAS WRITTEN.',
  );
}

/* ------------------------------------------------------------------ *
 * THE ONE WAY TO GET A SEAT PAST THIS FILE
 * ------------------------------------------------------------------ */

declare const seatedHere: unique symbol;

/**
 * **PROOF, IN THE TYPE, THAT THE LEAF CHECK RAN ON THIS DEVICE FOR THIS SEAT.**
 * `T-118`, `S34`.
 *
 * ── WHY A TYPE AND NOT A TEST ────────────────────────────────────────────
 *
 * `S33` put a money-safety refusal in `src/web/App.tsx`, no test file in this
 * repository imports that file, and what stood in for rule 11 was a
 * comment-stripped source pin over its text. **A source pin cannot see
 * semantics**: `S33`'s own `test-auditor` defeated the first version three ways
 * with the text intact — kept verbatim inside an arrow nothing calls, wrapped
 * in a condition never true, and shadowed by a local no-op one line above — and
 * the pin's own last line says *"a fourth will be found."*
 *
 * **AND `S34` FOUND THE FOURTH WITHOUT LOOKING FOR IT.** The pin asserts that
 * `openAccount` calls the check exactly once. `loadDemo`
 * (`src/web/App.tsx`) built a `Session` straight from `/api/demo/seed` and
 * never went near `openAccount`, so a second door to a session existed with the
 * pin green. Counting call sites in one function cannot see a second function.
 *
 * So the check is not pinned. **It is the only way to construct a value that
 * `Session` requires**, and the brand below is not exported, so no other file
 * can write one. A screen that skips the check does not render wrong — it does
 * not compile. That is what rule 27 asks for: the property is enforced by the
 * type of `Session.seat` and by this constructor being its only source.
 *
 * ── WHAT IT IS NOT ───────────────────────────────────────────────────────
 *
 * It is not a claim that the seat can act. `no-seat`, `no-stored-leaf` and
 * `no-device-key` all pass, because `requireOwnLeaf` deliberately lets them —
 * the refusals that matter for those arrive at the moment a person ACTS, and
 * locking them out of reading their own company would be the new lockout
 * `C325`'s round existed to avoid. What this value carries is that the two
 * copies of the leaf were compared here, and that they did not disagree.
 */
export interface SeatOnThisDevice {
  readonly [seatedHere]: true;
  readonly signerId: string;
  readonly verdict: OwnLeafVerdict;
}

/**
 * Reads the two copies, refuses if they disagree, and hands back the token
 * `Session` cannot be built without.
 *
 * Pure, total in its inputs, and in `src/core/` so a real test drives it —
 * `src/core/signer-leaf.test.ts` is that test, and it renders nothing.
 */
export function seatOnThisDevice(
  seat: { id: string; leafCommitment: Hex | null } | null | undefined,
  device: DeviceLeafMaterial | null | undefined,
  commitments: LeafScheme,
): SeatOnThisDevice {
  const reading = ownLeafReading(seat, device, commitments);
  requireOwnLeaf(reading);
  return { signerId: reading.signerId, verdict: reading.verdict } as SeatOnThisDevice;
}
