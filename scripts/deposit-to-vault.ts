/**
 * **THE FIRST PRIVATE MONEY EVER TO ENTER A VAULT.** `V-94`, `C242`, `C199`,
 * `V-111`.
 *
 * Run it with `DEPOSIT-TO-VAULT.command`. What that door must pass and must
 * refuse is at the bottom of this file; the order the doors go in, and what
 * each one needs first, is `docs/command-order.md`.
 *
 * ------------------------------------------------------------------------
 * **WHAT A SHIELDED DEPOSIT ACTUALLY IS, BECAUSE IT IS NOT A TRANSFER**
 *
 * `deposit` compiles to `receiveShielded`, which is `createZswapOutput`: it
 * **creates** a shielded coin addressed to the vault, and the wallet balancing
 * the transaction funds it out of a shielded balance of that colour. So the
 * coin this door sends is not the coin `MINT-TEST-TOKEN.command` put in the
 * wallet — that one is spent to pay for this one. **The nonce is therefore this
 * side's choice, made before the transaction exists**, which is exactly why
 * `C240` is closable on this route: the sender chose the nonce, so the sender
 * can record the note in the same breath.
 *
 * **AN OUTPUT ADDRESSED TO A CONTRACT CARRIES NO CIPHERTEXT** — `newContractOwned`
 * passes `None` where a user-addressed output passes a coin ciphertext
 * (`midnight-src/midnight-ledger/zswap/src/construct.rs:297-304`), which is
 * `V-111`'s true half; it is a `receiveShielded` output rather than a mint, and
 * naming the wrong mechanism for the right consequence is how a paraphrase
 * starts. So nothing on chain says what the vault now holds beyond one
 * commitment. **The note pool is the record of the money**, and that is why
 * this door refuses without one and why `OPEN-VAULT-POOL.command` has to have
 * run.
 *
 * ------------------------------------------------------------------------
 * **THE WINDOW THIS DOOR OPENS FOR THE FIRST TIME, AND WHY IT NEEDED MORE THAN
 * A SENTENCE.**
 *
 * The pool is written AFTER the transaction, deliberately: the alternative
 * leaves a pool holding a note the chain does not have, which refuses every
 * later payment with nothing on chain to recover from. `C199` calls the chosen
 * order the recoverable one because `replayVault` rebuilds a pool from the
 * chain and the history.
 *
 * **THAT WAS NOT TRUE FOR THIS ROUTE WHEN THIS DOOR WAS FIRST WRITTEN, AND THE
 * money-safety pass PASS IS WHAT SAID SO.** `replayVault` rebuilds from a
 * `history` of vault events whose deposit events carry the whole coin —
 * `src/midnight/vault-recovery.ts` — and **nothing in this repository produces
 * a history.** The deposit's nonce is chosen here, a few statements before the
 * call, and until `VaultLedger.deposit` writes the pool it exists in one
 * process's memory and nowhere else. A commitment cannot be inverted. **So a
 * crash in that window left a note nobody could ever spend**, which is rule 23
 * and not downtime.
 *
 * **CLOSED FOR THIS ROUTE IN THE SAME TURN IT WAS FOUND, by the sealed
 * ATTEMPT JOURNAL below** — one durable, sealed record of vault, nonce, colour
 * and value, written BEFORE the call. That is exactly what `C240` means by the
 * sender capturing the coin at the moment it is sent, and this is the one route
 * where the sender chooses the nonce and therefore can.
 *
 * **IT IS NOT THE POOL AND MUST NEVER BE READ AS ONE.** The pool is a claim
 * about what the vault HOLDS; the journal is a record of what was ATTEMPTED. A
 * journal entry for a call that never landed is correct and harmless; a pool
 * entry for one is `C199`'s unrecoverable direction. **It is sealed to the same
 * signers as the pool** because it carries exactly what the pool seals — a
 * nonce, a colour and an amount — and a plaintext journal beside a sealed pool
 * would publish what the pool exists to protect.
 *
 * **`replayVault` STILL HAS NO DOOR** (`V-96`, `docs/command-order.md` §8), and
 * the journal does not give it one. It makes the recovery possible; performing
 * it is still a session's job.
 *
 * ------------------------------------------------------------------------
 * **WHAT IS CHECKED BEFORE ANYTHING IS SPENT, IN THE ORDER IT IS CHEAPEST**
 *
 *   · the vault carries all seven circuits **in its record** — a drifted
 *     deployment reads as an EMPTY vault rather than refusing, which
 *     is the one failure this door cannot detect afterwards;
 *   · the vault is married to the account deployed now — the same
 *     check `fund-vault.ts` makes, IMPORTED from it rather than written
 *     again;
 *   · a colour recorded by `MINT-TEST-TOKEN.command`, and a wallet that holds
 *     enough of it;
 *   · **a pool this machine can open, and one whose signer set this run can
 *     write back WITHOUT dropping anybody.** See `assertNoSignerIsDropped`.
 *
 * ------------------------------------------------------------------------
 * **WHAT IS EXPECTED TO REFUSE THIS, AND THE ROUND'S BRIEF EXPECTED
 * OTHERWISE.** `C272`, `V-176`, `V-177`.
 *
 * `ROUND-S16.md` reasons that `C272` closes for a shielded deposit: no NIGHT
 * change output, and Zswap offers present, so both halves of `V-176`'s gap go
 * away. **The platform fact-check pass reads the ledger's own source
 * differently, and the difference is the whole shape of the gap.**
 *
 * `per_tx_cost_reserve` counts Zswap items off the **contract's effects** —
 * `claimed_nullifiers` and `claimed_shielded_receives`,
 * `midnight-src/midnight-ledger/ledger/src/construct.rs:898-905`. The enforcing
 * `validation_cost` counts them off the **balanced offer**,
 * `structure.rs:1879-1888`. `deposit` claims a receive, so the Pedersen term
 * `V-176` measured does get charged here — **but the coin the WALLET spends to
 * fund the created output is claimed by no circuit, so the reserve cannot see
 * it, and neither can it see a shielded change output if the deposit is smaller
 * than the coin.** Each is a `proof_verify` term of the same order as the
 * 1.886 ms NIGHT change output `V-176` names.
 *
 * **So going shielded does not leave `V-176`'s blind spot; it substitutes a
 * shielded balancer contribution for an unshielded one inside it.** Depositing
 * EXACTLY the value of one held coin leaves no change output and is the smaller
 * of the two shapes, which is worth knowing at the prompt.
 *
 * **AND THE CHECK THAT WOULD SAY SO BEFORE THE FEE RUNS IN THIS PROCESS
 * ALREADY.** `scripts/tx-size.ts`'s `measureCost` calls
 * `Transaction.cost(params, true)` — the node's own call — on the BALANCED
 * transaction, before `submitTx`; when the time-to-dismiss check throws, the
 * reading is dropped and only a `problem` string survives (`V-177`). This door
 * prints that string loudly and cannot act on it: the submission happens inside
 * `VaultLedger.deposit`, so turning the reading into a refusal is a change to
 * the client and not to an instrument.
 *
 * ------------------------------------------------------------------------
 * **ONE ATTEMPT.** No retry, no fallback. Running this door twice deposits
 * twice.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { randomBytes } from '@noble/hashes/utils.js';

import * as CompiledContract from '@midnight-ntwrk/compact-js/effect/CompiledContract';
import { StaticProofServerContainer, createDefaultTestLogger } from '@midnight-ntwrk/testkit-js';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

import { Contract as VaultContract } from '../contracts/managed-vault/contract/index.js';
import {
  VaultLedger, VaultChainUnreadable, VaultPoolDisagreesWithChain,
} from '../src/midnight/vault-ledger.js';
import { VAULT_CIRCUITS } from '../src/midnight/vault-contract.js';
import {
  SealedNotePool, VaultPoolUnreadable, sealPool, openPool, type PoolSigner,
} from '../src/midnight/vault-pool.js';
import {
  assertVaultName, vaultRegistryFile, parseVaultRegistry, type VaultEntry, theVault,} from '../src/midnight/vault-record.js';
import { applyNetworkId, theNetwork } from '../src/midnight/network.js';
import { indexerNoteEvents } from '../src/midnight/note-index.js';
import type { Hex } from '../src/core/crypto.js';
import type { SignerRef } from '../src/core/ledger.js';
import { FileSealedPoolStore, vaultPoolFile } from './vault-pool-file.js';
import { testTokenFile, parseTestTokenRecord } from './mint-test-token.js';
import { assertVaultIsMarriedToTheDeployedAccount } from './fund-vault.js';
import { explainNodeError, NODE_ERROR_CODES } from './node-errors.js';
import { testEnvironmentFor, startEnvironment } from './test-environment.js';
import { bringUpWallet } from './wallet-bringup.js';
import { saveDustState } from './dust-wallet.js';
import {
  shieldedHeldOf, whyNoCoin, SHIELDED_DEADLINE_IS_NOT_MEASURED, type ShieldedWaitOutcome,
} from './shielded-wallet.js';
import { collapseRepeatedLines, describeDropped, serialiseWholeDetailed } from './error-report.js';
import {
  compareAgainstLimits, compareCost, limitsFromLedger, measuringProviders,
  type BlockLimits, type TxMeasurement,
} from './tx-size.js';
import {
  createScreen, phaseClock, withTimeout, describeError, captureNodeLines,
} from './deploy-report.js';

/* ------------------------------------------------------------------ */

const ROOT = process.cwd();
const STATE_DIR = join(ROOT, '.midnight');
const SEED_FILE = join(STATE_DIR, 'wallet.seed');
const SIGNER_SECRETS = join(STATE_DIR, 'test-signer-keys.json');
const NETWORK = theNetwork();
const VAULT_ARTEFACTS = join(ROOT, 'contracts', 'managed-vault');

/* 6301, NOT 6300 — `M-144`. */
const PROVER_PORT = Number(process.env.MIDNIGHT_PROVER_PORT || 6301);

const PRIVATE_STATE_ID = `confidential-accounts-${NETWORK}`;
const PRIVATE_STATE_PASSWORD =
  process.env.MIDNIGHT_PRIVATE_STATE_PASSWORD || 'ConfidentialAccounts-Dev-2026';

const VAULT_NAME = (process.env.VAULT_NAME ?? '').trim();
const DEPOSIT_AMOUNT = (process.env.DEPOSIT_AMOUNT ?? '').trim();

/* ------------------------------------------------------------------ *
 * the screen
 * ------------------------------------------------------------------ */

let vaultAddress: string | null = null;

const say = createScreen(() => (vaultAddress
  ? [{ what: "the vault's address", value: vaultAddress }]
  : []));

const clock = phaseClock(say);
const note = (s: string) => say(`  ${s}`);
const good = (s: string) => say(`  \x1b[32m✓\x1b[0m ${s}`);

const rawNodeLines = captureNodeLines(explainNodeError);

const txMeasurements: TxMeasurement[] = [];
let blockLimits: BlockLimits | null = null;
let ledgerParameters: any = null;
let proofServerImage = '(not established)';
let proofServerVersion = '(not asked)';
let provingSeconds: number | null = null;

/* ------------------------------------------------------------------ *
 * what is decided before anything is spent
 * ------------------------------------------------------------------ */

/**
 * **THE REFUSAL WHEN THE WALLET HOLDS NONE OF THE COLOUR, AND WHICH OF TWO
 * THINGS IT SAYS.**
 *
 * Exported so a test can pin both sentences without a chain. The states have
 * opposite remedies — waiting fixes one and nothing fixes the other — so a door
 * that prints the wrong one either sends a person away to wait for a coin that
 * will never arrive, or tells them their money is gone while it is arriving.
 *
 * `scan` is null when this run never waited, which is a THIRD thing and is said
 * as such rather than folded into either.
 */
export function noColourRefusal(
  colour: string,
  scan: ShieldedWaitOutcome | null,
  held: bigint | null,
): string {
  const why = whyNoCoin(colour, scan, held);
  const opening = held === null
    ? 'this door cannot tell whether the wallet holds a coin of that colour, and will not fund a '
      + 'deposit on a reading it could not take.'
    : 'the wallet holds no coin of that colour, so there is nothing for this deposit\x27s '
      + 'output to be funded from.';
  return `${opening}\n${why.message}`;
}

/**
 * The amount, as a whole number of the token's smallest unit.
 *
 * The token is the test asset `MINT-TEST-TOKEN.command` created and nothing
 * declares a scale for it, so this door converts nothing — `fund-vault.ts`'s
 * rule, and here there is not even an unmeasured belief to convert by.
 */
export function amountFromText(text: string): bigint {
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    throw new Error(
      'no amount was given. DEPOSIT-TO-VAULT.command asks how much and passes the answer here; ' +
      'reaching this means the question went unanswered.\n' +
      'There is deliberately no default: a default would move an amount nobody chose into a ' +
      'vault it cannot come back out of yet.');
  }
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(
      `"${trimmed}" is not an amount this door will take. Digits and nothing else: no point, ` +
      'no separators, no sign, no exponent. This token has no declared decimal places and ' +
      'this door invents none.');
  }
  const amount = BigInt(trimmed);
  if (amount <= 0n) {
    throw new Error(
      'a note of nothing is not a deposit. The client refuses it before a transaction exists ' +
      '(`VaultLedger.deposit`), and this refuses it before a proof server.');
  }
  return amount;
}

/**
 * **REFUSES A VAULT WHOSE RECORD IS NOT THE SEVEN-CIRCUIT ONE, AND IT IS A
 * STRICTER TEST THAN THE PUBLIC PATH'S.**
 *
 * `fund-vault.ts` asks only for `depositUnshielded`, because a public balance
 * is the ledger's own figure and a drifted reader cannot make it wrong. **The
 * private path reads a NOTE SET through a generated reader that decodes field
 * by field**, and against a deployment it does not match `.notes` can come back
 * as a well-formed EMPTY set with a working `member()` while `.payments`
 * throws. Measured on `payroll-test-1`.
 *
 * **AND THE REASON THIS GUARD FIRST CARRIED WAS FALSE, WHICH IS WORTH KEEPING
 * WRITTEN DOWN.** It said the deposit would land and *"every check this door
 * makes would agree that nothing happened"*. It would not: `balance` recomputes
 * each pool note's commitment and asks the chain's set for it, so against an
 * empty set the reconciliation REFUSES — `VaultPoolDisagreesWithChain` — and
 * this door exits 3 saying it could not confirm. **A guard defended by a false
 * reason is a guard the next person deletes after testing the reason.**
 *
 * **WHAT IT IS ACTUALLY FOR:** refusing in a second, at no cost, a deposit that
 * would otherwise be proved, submitted, paid for and then reported as
 * unconfirmable — and leaving the operator with a vault whose state cannot be
 * read rather than a question about the indexer.
 *
 * **WHAT IT DOES NOT HOLD, SAID PLAINLY:** it counts circuit NAMES in a local
 * file, and what decides whether a state decodes is the ledger LAYOUT. A
 * contract that gains a ledger field without gaining a circuit passes this and
 * reproduces `C268` exactly. **The real check is the decode**, which
 * `balance`'s pre-read performs before anything is built.
 *
 * Exported so `deposit-to-vault.test.ts` can drive it without a chain.
 */
export function assertVaultTakesPrivateMoney(entry: VaultEntry): void {
  const circuits = new Set(Array.isArray(entry.circuits) ? entry.circuits : []);
  const missing = [...VAULT_CIRCUITS].filter((c) => !circuits.has(c));
  if (missing.length === 0) return;
  throw new Error(
    `the record for the vault "${entry.name}" is missing ${missing.length} of the vault's ` +
    `circuits: ${missing.join(', ')}.\n` +
    'A PRIVATE DEPOSIT IS REFUSED FOR A DEPLOYMENT THE COMPILED READER DOES NOT MATCH, and ' +
    'not because the deposit would fail. A generated reader decodes field by field, and ' +
    'against a four-circuit deployment the note set comes back well-formed and EMPTY (C268). ' +
    'The deposit would land, the pool would record it, and the reconciliation afterwards would ' +
    'refuse — so the money would have moved, the fee would have been paid, and what the ' +
    'operator would be left with is a vault whose state cannot be read.\n' +
    'THIS GUARD COUNTS CIRCUIT NAMES IN A LOCAL RECORD AND WHAT DRIFTS IS THE STATE LAYOUT, ' +
    'so it is early rather than strong. What actually decides is the decode, and this door ' +
    'performs one before it builds anything.\n' +
    'DEPLOY-VAULT.command deploys a vault carrying all of them. Choosing a different vault at ' +
    'this door\x27s prompt is the other answer.');
}

/**
 * **NOBODY LOSES THEIR COPY OF THE KEY BECAUSE A DEPOSIT WAS MADE.**
 *
 * `SealedNotePool.save` re-seals the whole pool under a fresh key and wraps it
 * to **whatever signer list it is handed** — `vault-pool.ts`, `sealPool`. It
 * does not compare that list against the copies already in the record. So a
 * caller holding a shorter signer file than the pool was created with silently
 * writes a pool that some of the vault's signers can no longer open, and the
 * money it describes becomes unreadable to them **at the moment a deposit
 * succeeds**.
 *
 * Nothing on chain would say so, and the person who lost access finds out at
 * the next payment. **That is the shape the register calls a failure that looks
 * like success**, so this door refuses first.
 *
 * **IT IS A CLIENT GAP AND THE GUARD BELONGS THERE**, not only here — `V-187`,
 * filed this round, which also names `VaultLedger.payout`'s `pool.save` as the
 * same shape with no guard at all, on the path that moves money OUT. This copy
 * exists because this door is the first caller that ever writes a pool after it
 * was created.
 *
 * **AND IT CANNOT SEE THE WORSE VERSION OF ITSELF.** It compares signer IDS,
 * and `MAKE-TEST-SIGNERS.command` mints the same three ids into one shared
 * secrets file every time it runs — so a later run for a DIFFERENT vault
 * replaces the secrets under those ids and leaves this pool wrapped to keys
 * nobody holds. `V-190`, measured on this machine: `payroll-test-1`'s pool is
 * already in that state. The sealed record keeps no public key, so no guard at
 * this layer could compare them; the refusal belongs where the secret is
 * written.
 *
 * Exported and pure so every outcome can be driven without a chain.
 */
export function assertNoSignerIsDropped(
  wrappedFor: readonly string[], willWrapFor: readonly string[],
): void {
  const next = new Set(willWrapFor);
  const dropped = [...new Set(wrappedFor)].filter((id) => !next.has(id));
  if (dropped.length === 0) return;
  throw new Error(
    `this run would re-seal the note pool to ${willWrapFor.length} signer(s) and the pool is ` +
    `currently wrapped for ${new Set(wrappedFor).size}. These would lose their copy of the ` +
    `key: ${dropped.join(', ')}.\n` +
    'A DEPOSIT REWRITES THE WHOLE POOL — it is sealed afresh under a new key and wrapped to ' +
    'the signers this run is told about. A signer who is not in that list cannot open the ' +
    'record of the vault\x27s money again, and nothing on chain would say so: the deposit ' +
    'would succeed, the note would be recorded, and the loss would surface at somebody ' +
    'else\x27s next payment.\n' +
    'The signer list comes from .midnight/vault-pool-signers-<vault>.json, which ' +
    'MAKE-TEST-SIGNERS.command writes. Nothing was deposited and nothing was written.');
}

/**
 * **WHICH SIGNER THIS RUN OPENS THE POOL AS, CHOSEN BY THE KEY AND NOT BY THE
 * NAME.**
 *
 * This used to be one `.find()` over `wrapped[].signerId` keeping the first id
 * whose `wrappingSecret` on this machine was 64 hex. **It never asked whether
 * that secret was the one the pool was sealed to**, and the two files needed to
 * ask already carried the answer: `test-signer-keys.json` writes
 * `wrappingPublicKey` beside every secret, and
 * `vault-pool-signers-<vault>.json` carries one per id.
 *
 * **WHAT THAT COST.** `C275` overwrote one vault's secrets with another's,
 * twice, under identical ids. The refusal a person would have met is the one
 * below marked *never given* — *"this machine holds no secret for any signer
 * the pool is wrapped for … THAT IS THE MECHANISM WORKING"*. **True about the
 * design, false about that case**: the machine held a secret under exactly that
 * id and it was the wrong one. A sentence telling somebody the system is
 * working correctly, while the key to their money is gone, is the worst output
 * in this file.
 *
 * **SO FOUR OUTCOMES, AND THEY SEND A PERSON TO FOUR DIFFERENT PLACES.**
 *
 *   USABLE        the secret's public half is the one the signers file
 *                 publishes for that id. A successful `openPool` afterwards is
 *                 then also proof the file told the truth for that id.
 *   NEVER GIVEN   no secret here for that id at all. The mechanism working.
 *   MISMATCH      a secret here under that id, and its public half is NOT the
 *                 published one. Somebody's key material has been replaced.
 *   UNCHECKABLE   a secret here, and nothing to compare it against — either the
 *                 signers file does not name the id, or the secrets file records
 *                 no public half beside it.
 *
 * **A MISMATCH REFUSES EVEN WHEN ANOTHER ID WOULD OPEN THE POOL, AND THAT IS
 * DELIBERATE.** A deposit RE-SEALS the whole pool to the public keys in the
 * signers file (`assertNoSignerIsDropped` guards who is in that list, not which
 * key each one means). Carrying on would re-seal a company's money to a set
 * this machine's own key material contradicts. **The cost of refusing wrongly
 * is a stopped deposit. The cost of carrying on wrongly is a pool nobody can
 * open, which is `C284` — money on chain describable by nobody.** Rule 28.
 *
 * **AND NO DOOR REPAIRS THIS ONE IN PLACE, WHICH THE REFUSAL SAYS RATHER THAN
 * PRETENDING OTHERWISE.** `BACKUP-KEYS.command` copies both files; a copy is
 * what resolves a mismatch. Restoring one is a session's job — `BACKLOG.md`.
 *
 * Exported and pure so every outcome can be driven without a chain, a pool or a
 * key: `mintedSignerIds`' lesson is that a rule about money living
 * only inside a caller is a rule no test can reach.
 */
export type OpenerVerdict = 'usable' | 'never-given' | 'mismatch' | 'uncheckable';

const HEX64 = /^[0-9a-f]{64}$/;
const half = (k: string): string => `${k.slice(0, 16)}…`;

export function openerVerdicts(
  wrappedFor: readonly string[],
  signers: readonly { id: string; wrappingPublicKey: string }[],
  secrets: Readonly<Record<string, { wrappingPublicKey?: unknown; wrappingSecret?: unknown } | undefined>>,
): { id: string; verdict: OpenerVerdict; held: string | null; published: string | null }[] {
  const published = new Map(signers.map((s) => [s.id, String(s.wrappingPublicKey ?? '').toLowerCase()]));
  return [...new Set(wrappedFor)].map((id) => {
    const rec = secrets?.[id];
    const secret = String(rec?.wrappingSecret ?? '').toLowerCase();
    const held = String(rec?.wrappingPublicKey ?? '').toLowerCase();
    const pub = published.get(id) ?? '';
    if (!HEX64.test(secret)) return { id, verdict: 'never-given' as const, held: null, published: pub || null };
    if (!HEX64.test(held) || !HEX64.test(pub)) {
      return { id, verdict: 'uncheckable' as const, held: HEX64.test(held) ? held : null, published: HEX64.test(pub) ? pub : null };
    }
    if (held !== pub) return { id, verdict: 'mismatch' as const, held, published: pub };
    return { id, verdict: 'usable' as const, held, published: pub };
  });
}

export function chooseOpener(
  wrappedFor: readonly string[],
  signers: readonly { id: string; wrappingPublicKey: string }[],
  secrets: Readonly<Record<string, { wrappingPublicKey?: unknown; wrappingSecret?: unknown } | undefined>>,
): { id: string; wrappingSecret: Hex } {
  const verdicts = openerVerdicts(wrappedFor, signers, secrets);
  const mismatched = verdicts.filter((v) => v.verdict === 'mismatch');

  if (mismatched.length > 0) {
    throw new Error(
      'THE SECRET ON THIS MACHINE IS NOT THE ONE THIS POOL WAS SEALED TO.\n' +
      'This is NOT "no secret was ever given to this machine" — there is one here under that ' +
      'id, and it is a different key. The two have opposite remedies, which is why they are ' +
      'two refusals.\n' +
      mismatched.map((v) =>
        `  ${v.id}\n` +
        `    the pool's signer file publishes  ${half(v.published!)}\n` +
        `    this machine holds the secret for ${half(v.held!)}`).join('\n') + '\n' +
      'A DEPOSIT RE-SEALS THE WHOLE POOL to the public keys in ' +
      '.midnight/vault-pool-signers-<vault>.json. Doing that while this machine\x27s own key ' +
      'material contradicts that file would re-seal the record of a company\x27s money to a ' +
      'set nobody here can vouch for — and the pool is the ONLY record of a note\x27s nonce, ' +
      'colour and value, because a commitment cannot be inverted (C284). ' +
      'NOTHING WAS PROVED, NOTHING WAS SPENT AND NOTHING WAS WRITTEN.\n' +
      'THIS IS WHAT C275 LOOKED LIKE FROM THE INSIDE. MAKE-TEST-SIGNERS.command wrote one ' +
      'vault\x27s secrets over another\x27s, under identical ids, twice, and nothing compared ' +
      'the halves. BACKUP-KEYS.command copies both of these files; a copy of the pair that ' +
      'agree is what resolves this. There is no door that repairs one in place, and this ' +
      'refusal is not going to pretend otherwise.');
  }

  const usable = verdicts.find((v) => v.verdict === 'usable');
  if (usable) return { id: usable.id, wrappingSecret: String(secrets[usable.id]!.wrappingSecret).toLowerCase() as Hex };

  const unchecked = verdicts.filter((v) => v.verdict === 'uncheckable');
  if (unchecked.length > 0) {
    throw new Error(
      'A SECRET IS HERE FOR THIS POOL AND NOTHING CAN CHECK IT, SO IT IS NOT USED.\n' +
      unchecked.map((v) =>
        `  ${v.id} — ` + (v.published === null
          ? '.midnight/vault-pool-signers-<vault>.json does not publish a key for this id, so ' +
            'nothing here says WHICH key that id ever meant'
          : 'the secrets file records no public half beside this secret, so it cannot be ' +
            'compared with the one the pool was sealed to')).join('\n') + '\n' +
      'The sealed pool names its signers by ID and never by key (C275), so an id is not ' +
      'evidence. Opening a pool with a secret nothing corroborates is how a wrong key came to ' +
      'be reported as the mechanism working, and this door will not do it again. ' +
      'Nothing was proved and nothing was spent.\n' +
      'MAKE-TEST-SIGNERS.command writes both halves of both files, and refuses to overwrite ' +
      'either. BACKUP-KEYS.command copies them.');
  }

  throw new Error(
    'this machine holds no secret for any signer the pool is wrapped for, so the pool cannot ' +
    'be opened.\nTHAT IS THE MECHANISM WORKING. The key exists only inside the wrapped ' +
    'copies, and a machine that could open a pool without a signer\x27s secret would be a ' +
    'machine that could read every vault it stores.\n' +
    'THIS SENTENCE IS ABOUT AN ABSENT SECRET AND NOTHING ELSE. A secret that is HERE and is ' +
    'the WRONG ONE refuses above, by name, because telling somebody the system is working ' +
    'while the key to their money is gone is the one thing this door must never say (C320).\n' +
    `The pool is wrapped for: ${[...new Set(wrappedFor)].join(', ')}.`);
}

/**
 * **WHERE THE ATTEMPT JOURNAL LIVES.** `C240`, and `V-188` is the row that made
 * it necessary.
 *
 * Named after the vault rather than addressed by it, for `vault-pool-file.ts`'s
 * reason: a filename is a screen, and it is in every listing, every error and
 * every backup log.
 *
 * **IT IS A SEPARATE FILE FROM THE POOL AND THAT IS THE WHOLE DESIGN.** One
 * says what the vault HOLDS and the other says what was ATTEMPTED. Merging them
 * would put an unlanded note in the pool, which is the direction `C199`
 * rejected for being unrecoverable.
 *
 * Exported so the test can pin the name.
 */
export const depositJournalFile = (stateDir: string, network: string, name: string): string =>
  join(stateDir, `${network}-vault-deposit-journal-${assertVaultName(name)}.json`);

/**
 * **WHAT THE TWO READS SAY, AS A VALUE RATHER THAN A BRANCH INSIDE A PRINT.**
 * `V-172`'s shape on the private path.
 *
 * Exported and pure so the test can drive every outcome.
 */
export type DepositVerdict = 'confirmed-by-the-chain' | 'not-confirmed';

/* ------------------------------------------------------------------ *
 * WHAT THE DEPOSIT LEFT BEHIND, AS LINES - pure, so it can be pinned
 * ------------------------------------------------------------------ */

/** What a finished deposit says about itself. The shape `VaultLedger.deposit` returns. */
export interface WhatADepositReported {
  readonly ref: string;
  readonly createdIn?: string;
  readonly recordedFrom: 'the call' | 'the chain' | 'nowhere';
  readonly stranded?: string;
  /** True when reading again cannot answer. Absent means it can, which is the safe default. */
  readonly permanent?: boolean;
}

/**
 * **THE TWO NAMES, AND WHETHER THE NOTE CAN BE SPENT.**
 *
 * **ONE TRANSACTION HAS TWO NAMES OF TWO DIFFERENT LENGTHS**, off two different
 * fields of the same result: a 33-byte identifier and a 32-byte hash. This door
 * used to print the identifier alone, so the number an operator wrote down was
 * the one the pool does not hold - and every later question about the note was
 * then asked with a value nothing was filed under. Both are printed, labelled,
 * with their lengths and with which one the note records.
 *
 * **AND WHETHER THE NOTE CAN BE SPENT AT ALL.** A note is spent by proving
 * where the chain filed it, and that is read from the transaction that created
 * it. A note recording none is money the vault owns and cannot pay out. The
 * success line used to be printed either way, so a deposit that had just
 * stranded its own note looked exactly like one that had not.
 *
 * Pure and exported because the door itself is not run here: the lines are the
 * part that can be wrong, so they are the part that is pinned.
 */
export function whatTheDepositLeftBehind(tx: WhatADepositReported): string[] {
  /*
   * **A CALL CAN REPORT NO IDENTIFIER AT ALL**, and this used to print the
   * heading with nothing after it, call it zero bytes, and close by saying the
   * identifier above was enough to find the transaction by.
   */
  const named = tx.ref.length > 0;
  const lines: string[] = named
    ? [
      `  transaction identifier  ${tx.ref}`,
      `    ${tx.ref.length / 2} bytes. This is the name an explorer takes, and it is NOT the name`,
      '    the note records.',
    ]
    : ['  transaction identifier  none. The call reported no name for its own transaction.'];
  if (tx.createdIn !== undefined) {
    lines.push(
      `  transaction hash        ${tx.createdIn}`,
      `    ${tx.createdIn.length / 2} bytes, read from ${tx.recordedFrom}. THIS is the one recorded`,
      '    against the note, and the one a payment reads its place in the chain with.',
      '',
      '  \x1b[32m✓\x1b[0m the note is in the pool with the transaction that created it, sealed and',
      '    wrapped to every signer above. It can be spent.');
    return lines;
  }
  /*
   * **TWO REASONS A NOTE IS STRANDED, AND THEY NEED TWO DIFFERENT ACTS.**
   *
   * An indexer a moment behind the node answers in a minute, and the note is
   * repaired by asking again. An indexer this client can no longer ask - a
   * schema that has moved, a question it will not take - never answers, and
   * asking again is what somebody does for ever instead of bringing the two
   * back into step. **Both used to print this frame**, whose word is YET and
   * whose advice is that the identifier is enough to find it by.
   */
  lines.push(
    '',
    tx.permanent === true
      ? '  \x1b[31m!\x1b[0m THE NOTE IS IN THE POOL AND IT CANNOT BE SPENT. READING AGAIN WILL NOT ANSWER.'
      : '  \x1b[31m!\x1b[0m THE NOTE IS IN THE POOL AND IT CANNOT BE SPENT YET.',
    `    ${tx.stranded ?? 'no reason was given'}.`,
    '    The money is on chain and it is this vault\x27s. Nothing is lost and nothing has to be',
    '    guessed: a note is spent at the place the chain filed it, that place is read from the',
    '    transaction that created it, and a note recording no transaction is refused before any',
    '    fee rather than after one.');
  if (tx.permanent === true) {
    lines.push(
      '    This client and the indexer are not in step, so reading again will not repair it. Bring',
      '    them back into step first, then record the transaction against this note. Nothing pays',
      '    out of this vault until it is recorded.');
  } else {
    lines.push(
      '    Record that transaction against this note before anything pays out of this vault.');
  }
  /*
   * The identifier is what finds the transaction, and it is only advice when
   * there is one. On the path where the call named its transaction neither
   * way, saying it is enough to find it by points at an empty line.
   */
  lines.push(named
    ? '    The identifier above is enough to find it by.'
    : '    The transaction has to be found another way: this run was not told its name.');
  return lines;
}

export function depositVerdict(
  before: bigint | null, after: bigint, deposited: bigint,
): DepositVerdict {
  if (before === null) return 'not-confirmed';
  return after - before === deposited ? 'confirmed-by-the-chain' : 'not-confirmed';
}

/** The company's vaults on this network, or a refusal — never a guess. */
function vaultFromRegistry(name: string): VaultEntry {
  const file = vaultRegistryFile(STATE_DIR, NETWORK);
  if (!existsSync(file)) {
    throw new Error(
      `no vault has ever been deployed on ${NETWORK}: ${file.replace(ROOT + '/', '')} does not ` +
      'exist. DEPLOY-VAULT.command is what creates one.');
  }
  const registry = parseVaultRegistry(JSON.parse(readFileSync(file, 'utf8')), NETWORK);
  /*
   * **THE NAME BECOMES A VAULT IN ONE PLACE, AND A RETIRED VAULT IS REFUSED
   * THERE.** Every door needs an address and the record is the only place an
   * address is, so the lookup is the thing every path has in common -- which is
   * why the refusal lives inside it rather than being remembered here.
   */
  return theVault(registry, name);
}

/**
 * **WHO IS MAKING THIS DEPOSIT, AND WHAT THAT DOES AND DOES NOT MEAN.**
 *
 * `VaultLedger.deposit` takes a `SignerRef` so no caller can submit without
 * having decided who is acting. **A deposit needs no approval** — nobody needs
 * permission to be paid — so the actor is whoever holds the funded wallet, and
 * they are not a signer of anything. `txRef` discards it and nothing derives
 * from it. **It is deliberately NOT the pool signer below**: that identity
 * unwraps a key, which is a different act by a different party, and giving one
 * value two meanings is how a record starts reading as membership.
 */
const DEPOSITOR: SignerRef = {
  signerId: 'whoever holds the funded wallet on this machine',
  leaf: '',
};

/* ------------------------------------------------------------------ *
 * the size block
 * ------------------------------------------------------------------ */

function printTxSize() {
  say();
  say('  \x1b[1mHow big the transaction is, against what the chain will carry\x1b[0m');
  if (!txMeasurements.length) {
    say('    NO TRANSACTION WAS BUILT IN THIS RUN, so there is no size to report and none is');
    say('    estimated. The stage named above says how far it got.');
    return;
  }
  for (const m of txMeasurements) {
    say(`    ${m.stage.padEnd(10)} ${m.bytes === null ? `(not measured: ${m.problem ?? 'unknown'})` : `${m.bytes.toLocaleString()} bytes`}`);
  }
  const last = txMeasurements[txMeasurements.length - 1]!;
  const limits = blockLimits ?? {
    readTime: null, computeTime: null, blockUsage: null, bytesWritten: null, bytesChurned: null,
    source: '(not derived — the ledger parameters were never read in this run)',
  };
  say();
  for (const line of compareAgainstLimits(last, limits)) say(`    ${line}`);
  if (last.cost) {
    say();
    say('    THE FIVE DIMENSIONS THE NODE NORMALISES AGAINST:');
    for (const line of compareCost(last.cost, limits)) say(`    ${line}`);
  } else {
    say();
    say('    THE COST COULD NOT BE READ. scripts/tx-size.ts asks Transaction.cost(params, true)');
    say('    — the same call the node makes — and when the time-to-dismiss check throws, all');
    say('    five dimensions are lost with it (V-177). On THIS door that branch is worth');
    say('    reading twice: it is the check C272 is about.');
  }
  say();
  say('    NOTHING ABOVE IS COMPARED TO AN EXPECTED FIGURE. No shielded vault call has ever');
  say('    been built by this project. Compare it against the next run of this door.');
}

function printProving() {
  say();
  say('  \x1b[1mWhat proved, and what it took\x1b[0m');
  say('    circuit           deposit  (one call, one transaction)');
  say(`    proof server      ${proofServerImage}`);
  say(`    /version          ${proofServerVersion}`);
  if (provingSeconds === null) {
    say('    time              NOT MEASURED — the call did not complete, so there is no');
    say('                      duration to report and none is estimated.');
    return;
  }
  say(`    prove and submit  ${provingSeconds.toFixed(1)}s wall clock`);
  say('    THAT NUMBER COVERS THE WHOLE CALL, not the proof alone.');
}

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

async function main(): Promise<DepositVerdict> {
  say('────────────────────────────────────────────────────────────');
  say(`  Putting private money into a vault on ${NETWORK}`);
  say('────────────────────────────────────────────────────────────');
  say();
  say('  ONE ATTEMPT. A real transaction, a real fee, and a real note.');
  say('  No shielded vault circuit has ever been proved by this project. This is the first.');

  /* -------------------------------------------------- 1 */
  clock.begin(1, 7, 'Which vault, how much, and which colour');

  if (!VAULT_NAME) {
    throw new Error(
      'no vault name was given. DEPOSIT-TO-VAULT.command asks which vault and passes the ' +
      'answer here.\nThere is deliberately no default: a default would deposit into whichever ' +
      'vault the registry happened to list first.');
  }
  assertVaultName(VAULT_NAME);
  const entry = vaultFromRegistry(VAULT_NAME);
  vaultAddress = entry.contractAddress;
  good(`vault "${VAULT_NAME}", deployed ${entry.deployedAt}`);
  note('  its address is NOT printed, here or anywhere — C236');

  assertVaultTakesPrivateMoney(entry);
  good(`the record says this vault carries all ${VAULT_CIRCUITS.length} circuits`);
  note('  that is a LOCAL record. What decides is the operations map the client reads off the');
  note('  chain before it builds anything; this check is only earlier, not stronger.');

  assertVaultIsMarriedToTheDeployedAccount(entry);
  good('this vault is married to the account that is deployed on this network — C266');

  const amount = amountFromText(DEPOSIT_AMOUNT);

  const tokenRecord = testTokenFile(STATE_DIR, NETWORK);
  if (!existsSync(tokenRecord)) {
    throw new Error(
      `no shielded token has been minted on ${NETWORK}: ${tokenRecord.replace(ROOT + '/', '')} ` +
      'does not exist.\n' +
      'A DEPOSIT DOES NOT SPEND A COIN THE CALLER HOLDS — it CREATES one addressed to the ' +
      'vault, and the wallet has to fund it from a shielded balance of that colour. The funded ' +
      'wallet has never held a shielded coin of any colour (V-94).\n' +
      'MINT-TEST-TOKEN.command is what creates one, and it records the colour here.');
  }
  const record = parseTestTokenRecord(JSON.parse(readFileSync(tokenRecord, 'utf8')), NETWORK);
  if (!record.colour) {
    throw new Error(
      `${tokenRecord.replace(ROOT + '/', '')} records a minter and no COLOUR, which is what ` +
      'MINT-TEST-TOKEN.command writes when its mint was submitted and the coin could not be ' +
      'identified in the wallet afterwards.\n' +
      'That door deliberately writes no colour it could not read off an arriving coin, because ' +
      'a guessed colour here is a deposit aimed at the wrong money. Run it again only if you ' +
      'mean to mint again; INDEXER-CHECK.command is what says whether the first one landed.');
  }
  const colour = record.colour as Hex;
  good(`depositing ${amount.toLocaleString()} of colour ${colour}`);
  note('  that colour was read off the coin that arrived in the wallet, not derived here.');

  /*
   * **WHAT THIS MONEY CANNOT DO ONCE IT IS IN, SAID BEFORE IT GOES IN.**
   *
   * **FIRST: NO PAYMENT CAN NAME THIS MONEY.** A transfer's token comes from
   * `ledgerTokenOf`, which gives a token only for NIGHT paid publicly, and a
   * payroll run's token is an asset code. A probe-minted colour is neither, so
   * no run this client can build pays it out, and `payout` compares the colour
   * of the note it spends against the token in the approved leaf.
   *
   * **SECOND: ITS PLACE IN THE TREE IS READ, NOT KNOWN.** A note is spent at
   * the index the chain filed its commitment at, which no deposit can know. The
   * pool records the transaction this deposit was finalised in, and a private
   * payment reads the note's index from that transaction's events just before
   * it spends. A note that records no transaction has that transaction
   * recorded by naming it to `recordCreatingTransaction`; no door does that yet.
   *
   * **SO THE HONEST SENTENCE IS THAT THE NOTE CANNOT BE PAID OUT TODAY**, because
   * nothing can name its colour and no door makes a private payment, and not
   * because its place is unknowable.
   */
  say();
  say('  \x1b[33mWHAT THIS MONEY CANNOT DO ONCE IT IS IN\x1b[0m');
  say('    FIRST: no payment can name this colour. This product names a ledger token only for');
  say('    NIGHT paid publicly, and a probe-minted colour is not an asset it knows, so no run');
  say('    this client can build pays this note out.');
  say('    SECOND: a note is spent at the place the chain filed it, which a deposit cannot');
  say('    know. The pool records the transaction this deposit lands in, and a private payment');
  say('    reads the note\x27s place from that transaction\x27s events before it spends.');
  say('    THE NOTE IS RECORDED WITH ITS NONCE, COLOUR AND VALUE, which is what a recovery');
  say('    needs and is NOT the same as everything a payment needs. And the vault cannot be');
  say('    retired while it holds a note, so this is a decision that cannot be walked back');
  say('    from today. It is a test asset either way.');
  say();
  say('  \x1b[33mAND THE WINDOW THIS OPENS, WHICH HAS NEVER BEEN OPEN BEFORE\x1b[0m');
  say('    The note pool is written AFTER the transaction, on purpose: the other order leaves');
  say('    a pool claiming a note the chain has not got, which refuses every later payment');
  say('    with nothing on chain to recover from. If this run dies in that window, the chain');
  say('    holds a note the pool never heard of.');
  say('    WHAT MAKES THAT RECOVERABLE IS THE NONCE, and until this round nothing wrote it');
  say('    down before the call. It is written now — sealed, beside the pool, before anything');
  say('    is submitted — so the note can be rebuilt. THE REBUILD ITSELF STILL HAS NO DOOR');
  say('    (`V-96`), so it is a session\x27s job. Do not run this door again to fix it; it would');
  say('    deposit a second note.');
  say();

  const proverKey = join(VAULT_ARTEFACTS, 'keys', 'deposit.prover');
  if (!existsSync(proverKey)) {
    throw new Error(
      'contracts/managed-vault/keys/deposit.prover does not exist, so this call cannot be ' +
      'proved.\nCOMPILE-VAULT.command builds the vault\x27s keys and it is the ONLY file that ' +
      'does. MUTATE.command\x27s quick recompiles wipe them.');
  }
  good('the proving key for deposit is on disk');

  /* -------------------------------------------------- 2 */
  clock.begin(2, 7, 'The note pool, and who can still open it afterwards');

  const poolFile = vaultPoolFile(STATE_DIR, NETWORK, VAULT_NAME);
  const store = new FileSealedPoolStore(poolFile, entry.contractAddress);
  const sealed = await store.get(entry.contractAddress);
  if (!sealed) {
    throw new Error(
      `this vault has no note pool: ${poolFile.replace(ROOT + '/', '')} does not exist.\n` +
      'NOTHING ON CHAIN SAYS WHAT A NOTE IS — only that a commitment exists — so the pool is ' +
      'the record of the money, and a deposit made without one is a note nobody can ever spend ' +
      '(C242). OPEN-VAULT-POOL.command creates it, and it asks the chain first so it can tell ' +
      'a NEW vault from a FORGOTTEN one.');
  }
  good(`the pool record is present, version ${sealed.version}, wrapped for ${sealed.wrapped.length} signer(s)`);

  const signersFile = join(STATE_DIR, `vault-pool-signers-${VAULT_NAME}.json`);
  if (!existsSync(signersFile)) {
    throw new Error(
      `${signersFile.replace(ROOT + '/', '')} does not exist, and a deposit REWRITES the pool: ` +
      'it is sealed afresh and wrapped to the signers this run is told about.\n' +
      'Without that file this run would have nobody to wrap it to, and a pool wrapped to ' +
      'nobody is ciphertext with no key in the world. MAKE-TEST-SIGNERS.command writes it.');
  }
  const signers = JSON.parse(readFileSync(signersFile, 'utf8')) as PoolSigner[];
  assertNoSignerIsDropped(sealed.wrapped.map((w) => w.signerId), signers.map((s) => s.id));
  good(`the pool will be re-sealed to all ${signers.length} signer(s) it is wrapped for now`);

  /*
   * **THE IDENTITY THIS RUN OPENS THE POOL WITH, AND IT IS A TEST PATH.**
   *
   * The pool is opened with one signer's own wrapping secret; there is no
   * viewing key and no server copy, which is the mechanism working rather than
   * a gap. **Both halves of these keys were made on this machine**
   * (`MAKE-TEST-SIGNERS.command` says so in its header, on screen, in its
   * report and in the file it writes), which is correct for a stagenet vault
   * nobody relies on and wrong for anything else.
   *
   * **THE OPENER IS THE FIRST SIGNER WHOSE SECRET HERE HAS THE PUBLIC HALF THE
   * SIGNERS FILE PUBLISHES — NOT THE FIRST WHOSE ID MATCHES.** `C320`, and
   * `chooseOpener` above holds the rule and the four refusals. Until 31 Aug it
   * was the first id with a 64-hex secret under it, which is what let a
   * REPLACED key be reported as an ABSENT one.
   *
   * **It is not prompted for, because the choice decides nothing about the
   * money** — every wrapped copy opens the same pool — and a prompt for a value
   * with no decision in it teaches somebody to type past prompts.
   */
  if (!existsSync(SIGNER_SECRETS)) {
    throw new Error(
      `${SIGNER_SECRETS.replace(ROOT + '/', '')} does not exist, so this machine holds no ` +
      'signer secret and cannot open the pool.\nMAKE-TEST-SIGNERS.command writes both halves ' +
      'of TEST keys. A real signer\x27s secret half is made on that person\x27s own device and ' +
      'never leaves it, and S10 is the round that replaces this path.');
  }
  const secrets = JSON.parse(readFileSync(SIGNER_SECRETS, 'utf8'))?.signers ?? {};
  /*
   * **CHOSEN BY THE KEY, NOT BY THE ID.** `C320`, and `chooseOpener` above
   * carries the whole reasoning. It refuses rather than returning, and the four
   * refusals are four different sentences because they send a person to four
   * different places.
   */
  const chosen = chooseOpener(sealed.wrapped.map((w) => w.signerId), signers, secrets);
  const opener = chosen.id;
  good(`opening the pool as "${opener}" — its public half is the one the signers file publishes`);
  good('a TEST identity whose halves were both made here');

  const openerSecret = chosen.wrappingSecret;
  const pool = new SealedNotePool(
    store, { signerId: opener, wrappingSecret: openerSecret }, async () => signers);

  /*
   * **THE ATTEMPT JOURNAL, OPENED HERE SO IT CANNOT FAIL AFTER THE MONEY HAS
   * MOVED.** `V-188`.
   *
   * It is read before anything is spent for the same reason the pool is: if the
   * secrets on this machine no longer open it, that has to stop the run rather
   * than surface one statement after the call, which is the one moment this
   * file exists to survive.
   */
  const journalStore = new FileSealedPoolStore(
    depositJournalFile(STATE_DIR, NETWORK, VAULT_NAME), entry.contractAddress);
  let journal: { attempts: any[]; version: number };
  try {
    const rec = await journalStore.get(entry.contractAddress);
    journal = rec
      ? { attempts: openPool(rec, opener, openerSecret).notes as any[], version: rec.version }
      : { attempts: [], version: 0 };
  } catch (cause) {
    throw new Error(
      'this vault has an attempt journal on this machine and it could not be opened: ' +
      `${(cause as Error)?.message ?? String(cause)}\n` +
      'THAT IS NOT AN EMPTY JOURNAL. It records the nonce of every deposit ever attempted ' +
      'against this vault from here, and a nonce is the one value a note cannot be spent ' +
      'without and cannot be recovered from the chain. Depositing while it is unreadable would ' +
      'add another. Nothing was proved and nothing was spent.');
  }
  good(`the attempt journal holds ${journal.attempts.length} earlier attempt(s), and opens`);

  /* -------------------------------------------------- 3 */
  clock.begin(3, 7, 'Setting the network id');
  await applyNetworkId(NETWORK);
  good(`network id is the string "${NETWORK}"`);

  /* -------------------------------------------------- 4 */
  clock.begin(4, 7, 'Connecting to the network and the proof server');

  const logger = createDefaultTestLogger();
  const { env, how } = testEnvironmentFor(NETWORK, logger);
  note(`network ${NETWORK} — ${how}`);
  const cfg = await startEnvironment(env, new StaticProofServerContainer(PROVER_PORT), note);
  good(`node      ${cfg.node}`);
  good(`indexer   ${cfg.indexer}`);
  good(`prover    ${cfg.proofServer}`);

  proofServerImage = process.env.MIDNIGHT_PROOF_IMAGE
    ?? '(not exported — run through DEPOSIT-TO-VAULT.command to record it)';
  try {
    const res = await withTimeout('the proof server /version', 10_000, fetch(`${cfg.proofServer}/version`));
    proofServerVersion = (await res.text()).trim().slice(0, 200) || `(empty, HTTP ${res.status})`;
  } catch (e: any) {
    proofServerVersion = `(did not answer: ${String(e?.message ?? e).slice(0, 80)})`;
  }
  good(`prover image    ${proofServerImage}`);
  good(`prover /version ${proofServerVersion}`);

  try {
    const { LedgerParameters } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
    ledgerParameters = LedgerParameters;
    blockLimits = limitsFromLedger(LedgerParameters);
    good(`block usage limit ${blockLimits.blockUsage === null ? '(could not derive)' : `${blockLimits.blockUsage.toLocaleString()} bytes`}`);
    note('  the GENESIS parameters, not the chain\x27s live ones — V-178.');
  } catch (e: any) {
    note(`the block limits could not be read: ${String(e?.message ?? e)}`);
  }

  /* -------------------------------------------------- 5 */
  clock.begin(5, 7, 'The wallet, and the coin this deposit is funded from');

  if (!existsSync(SEED_FILE)) {
    throw new Error(
      `there is no wallet: ${SEED_FILE.replace(ROOT + '/', '')} does not exist. This door will ` +
      'not make one. DEPLOY-PREVIEW.command prints the address and the faucet URL.');
  }
  const masterSeed = readFileSync(SEED_FILE, 'utf8').trim();
  const live = await bringUpWallet(logger, cfg, masterSeed, NETWORK, ROOT, {
    withDust: true, requireDust: true, withShielded: true, onNote: note,
  });
  const wallet: any = live.wallet;
  good(`wallet ready — NIGHT ${live.night().toLocaleString()}, DUST ${live.dust().toLocaleString()}`);
  const cached = await saveDustState(wallet, masterSeed, NETWORK, ROOT);
  if (cached) good(`dust wallet state cached (${(cached / 1024).toFixed(0)} KB)`);

  /*
   * **THE SHIELDED BALANCE OF THIS COLOUR, FROM THE WALLET'S OWN COINS.**
   *
   * Refused in words before a proof, and the balancer would refuse it again
   * anyway. The duplication is the one the contract's own asserts carry: the
   * second refusal protects the money whatever this believes, and this one
   * gives a person a sentence instead of a coin-selection error eighty seconds
   * into proving.
   *
   * **THE READ IS TAKEN AFTER THE SCAN, NOT THREE SECONDS AFTER THE WALLET WAS
   * BUILT.** This read happened once, immediately, and threw — twice on
   * 30 August against a wallet that had held ten trillion of this colour
   * minutes earlier. The wait is `bringUpWallet`'s `withShielded`, above, and
   * its implementation is `shielded-wallet.ts`.
   *
   * **THIS DOOR AND `mint-test-token.ts` SHARE THAT ONE IMPLEMENTATION.
   * `chain-probe.ts` STILL DOES NOT** — it reads `shielded.availableCoins`
   * itself, keeps its own five-minute poll, and spends what it finds without
   * waiting for the scan at all. That is outside this round and is recorded as
   * a row rather than claimed closed here.
   */
  const scan = live.shieldedScan();
  if (scan) {
    note(`shielded scan: ${scan.reached === 'deadline' ? 'DEADLINE PASSED' : 'caught up'} after ${Math.round(scan.waitedMs / 1000)}s — ${scan.describe}`);
    /*
     * **THE DISCLOSURE IS PRINTED ON EVERY PATH, INCLUDING THE ONE WHERE THE
     * NUMBER DECIDED THE OUTCOME.** The first draft printed it only on success,
     * which withheld *the deadline is a guess* from the single case where the
     * guess is what a person is looking at. `S17`'s money-safety pass.
     */
    note(`  ${SHIELDED_DEADLINE_IS_NOT_MEASURED}`);
    if (scan.reached !== 'deadline' && scan.waitedMs > 0) {
      /*
       * **AN UPPER BOUND, NOT A TIMING.** The wait samples every two seconds,
       * so this overstates by up to one poll and is not the first qualifying
       * emission. Calling it a measurement would be rule 9. `S17`'s
       * platform fact-check.
       */
      note(`  the scan finished within ${Math.round(scan.waitedMs / 1000)}s — an upper bound sampled every 2s, not a measurement.`);
    }
  }

  /*
   * **A SHIELDED BALANCE IS NOT A SYNCED SHIELDED WALLET.** `C243`'s sentence,
   * one sub-wallet along, and it is a REFUSAL rather than a note.
   *
   * The first draft treated a passed deadline as advice and gated only on the
   * balance — so a partial scan that happened to show enough of the colour
   * would go on to prove and submit a spend from a view this door had just
   * finished calling incomplete. A partial scan can also over-report: it has
   * applied a coin's arrival and not yet the event that spent it. Found by
   * `S17`'s money-safety pass, against this door.
   */
  if (scan && scan.reached === 'deadline') {
    throw new Error(
      'the shielded scan did not finish inside its deadline, and this door will not build a ' +
      `deposit out of a view it has just called incomplete.\n${whyNoCoin(colour, scan, 0n).message}`);
  }

  const shielded = shieldedHeldOf(live.state(), colour);
  if (shielded === null || shielded === 0n) {
    /*
     * **THREE STATES REACH THIS LINE AND NONE OF THEM IS SPELT LIKE ANOTHER.**
     * Waiting fixes one of them, nothing fixes another, and the third is
     * this machine failing to read its own wallet. `whyNoCoin` decides on the
     * platform's own caught-up predicate and names which state it is in;
     * `null` is a read that failed and is never reported as an absence.
     */
    throw new Error(noColourRefusal(colour, scan, shielded));
  }
  good(`the wallet holds ${shielded.toLocaleString()} of that colour`);
  if (shielded < amount) {
    throw new Error(
      `the wallet holds ${shielded} of that colour and this deposit is ${amount}. Both numbers ` +
      'were read just now. Nothing was proved and nothing was spent.');
  }
  good('the wallet holds enough to fund this deposit');

  /* -------------------------------------------------- 6 */
  clock.begin(6, 7, 'The deposit — the first shielded vault circuit this project has proved');

  const zkConfigProvider = new NodeZkConfigProvider<string>(VAULT_ARTEFACTS);
  const providers: any = {
    zkConfigProvider,
    proofProvider: httpClientProofProvider(cfg.proofServer, zkConfigProvider),
    privateStateProvider: levelPrivateStateProvider({
      accountId: PRIVATE_STATE_ID,
      privateStateStoreName: PRIVATE_STATE_ID,
      privateStoragePasswordProvider: async () => PRIVATE_STATE_PASSWORD,
    } as any),
    publicDataProvider: indexerPublicDataProvider(cfg.indexer, cfg.indexerWS),
    walletProvider: wallet,
    midnightProvider: wallet,
  };

  const measured = measuringProviders(providers, (m) => {
    txMeasurements.push(m);
    note(`transaction size (${m.stage}) ${m.bytes === null ? `not measured: ${m.problem ?? 'unknown'}` : `${m.bytes.toLocaleString()} bytes`}`);
    if (m.cost?.exceeded) note(`  THE LEDGER WILL NOT NORMALISE THIS COST: ${m.cost.exceeded}`);
  }, ledgerParameters);

  /* MEMOISED, AND IT IS LOAD BEARING. `VaultLedger` calls this twice per
   * circuit call, and an unmemoised factory balances with a different wallet
   * handle than the one whose key went into the transaction. */
  const providersOnce = async () => measured;

  const compiled = CompiledContract.make('Vault', VaultContract as any).pipe(
    CompiledContract.withCompiledFileAssets(VAULT_ARTEFACTS as never),
  ) as any;
  good(`compiled contract "${compiled.tag}", assets at contracts/managed-vault`);

  const ledger = new VaultLedger(
    { networkId: NETWORK } as never, {} as never, providersOnce, compiled, pool, VAULT_ARTEFACTS);

  /*
   * **THE BALANCE BEFORE, AND IT IS A RECONCILIATION RATHER THAN A READING.**
   *
   * `VaultLedger.balance` loads the pool, asks the chain for the vault's note
   * set, checks that every note the pool claims IS on chain and that the counts
   * agree, and only then returns a number. So this call answers three questions
   * at once before anything is spent: the chain is readable, the
   * deployed state decodes against this reader, and the pool and the
   * chain already agree.
   *
   * **IT IS THE CLIENT'S OWN PATH AND NOT A SECOND ONE.** `M-104`, and `S13c`
   * deleted the last hand-rolled chain read for exactly this reason: a rule the
   * money depends on, written twice, is one copy behind on whichever was
   * forgotten.
   */
  let before: bigint | null = null;
  try {
    before = await ledger.balance(entry.contractAddress, colour);
    good(`before this deposit the vault holds ${before.toLocaleString()} of that colour, pool and chain agreed`);
  } catch (e: any) {
    if (e instanceof VaultPoolDisagreesWithChain) {
      throw new Error(
        'the pool and the chain do not agree about this vault BEFORE anything was deposited, ' +
        'so nothing was deposited.\n' + String(e?.message ?? e) + '\n' +
        'Depositing into a vault whose record already disagrees would add a note to a pool ' +
        'that cannot be reconciled, and the disagreement would then be attributed to this run.');
    }
    if (e instanceof VaultChainUnreadable) {
      throw new Error(
        'the vault could not be read from the chain, which is NOT the chain saying it is ' +
        'empty.\n' + String(e?.message ?? e) + '\n' +
        'C110: a state the node had finalised read as absent to the indexer 168ms later. ' +
        'Nothing was proved and nothing was spent.');
    }
    throw e;
  }

  /*
   * **THE NONCE IS THIS SIDE'S, AND IT IS FRESH.** The deposit CREATES the
   * coin, so the nonce is chosen before the transaction exists — that is what
   * lets the note be recorded in the same breath. Two deposits of the
   * same amount and colour under one nonce are one coin, which the ledger will
   * not take twice.
   */
  const hexOf = (b: Uint8Array): string =>
    [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const nonce = hexOf(randomBytes(32)) as Hex;
  note(`nonce ${nonce.slice(0, 24)}… (fresh this run)`);

  /*
   * **THE JOURNAL ENTRY, WRITTEN BEFORE THE CALL AND NOT AFTER IT.** `V-188`,
   * `C240`, and it is the one write in this file whose ORDER is the point.
   *
   * Between the call and `VaultLedger.deposit`'s pool write there is a window
   * `C199` accepts as the recoverable one. It is only recoverable if the nonce
   * survives, and until this line the nonce lived in this process's memory and
   * nowhere else: a commitment cannot be inverted, `replayVault` rebuilds from
   * a history nothing in this repository produces, and the recovery's own
   * source says a nonce cannot be got back at all.
   *
   * **A JOURNAL ENTRY FOR A CALL THAT NEVER LANDS IS HARMLESS AND CORRECT** —
   * it records an attempt, not a holding — which is exactly why this order is
   * safe here and the same order would be wrong for the pool.
   *
   * Sealed and wrapped to the same signers as the pool, because it carries what
   * the pool carries.
   */
  await journalStore.put(entry.contractAddress, sealPool(
    entry.contractAddress,
    /* Note-shaped, plus when it was attempted. Cast once, here, rather than
     * widening the pool's own type for a file that is not a pool. */
    { notes: [...journal.attempts, { nonce, token: colour, value: amount, attemptedAt: new Date().toISOString() }] } as any,
    signers,
    journal.version + 1));
  good('the attempt is journalled, sealed, BEFORE the call — so the nonce survives a crash');

  const startedAt = Date.now();
  const tx = await ledger.deposit(
    entry.contractAddress, { nonce, token: colour, value: amount }, DEPOSITOR,
    indexerNoteEvents(cfg.indexer));
  provingSeconds = (Date.now() - startedAt) / 1000;
  good(`submitted in ${provingSeconds.toFixed(1)}s`);

  say();
  for (const line of whatTheDepositLeftBehind(tx)) say(line);

  printProving();
  printTxSize();

  /* -------------------------------------------------- 7 */
  clock.begin(7, 7, "Asking the chain whether the vault holds the note, through the client's own path");

  let verdict: DepositVerdict = 'not-confirmed';
  try {
    const after = await ledger.balance(entry.contractAddress, colour);
    verdict = depositVerdict(before, after, amount);
    say();
    say(verdict === 'confirmed-by-the-chain'
      ? '  \x1b[1mWhat this vault holds\x1b[0m'
      : '  \x1b[1mWhat this vault holds: THIS RUN COULD NOT CONFIRM IT\x1b[0m');
    say(`    ${after.toLocaleString()} of colour ${colour}`);
    say('    WHERE THAT NUMBER CAME FROM: the pool this machine holds, RECONCILED against the');
    say('    vault\x27s note set on chain — every commitment the pool claims was found in the');
    say('    chain\x27s own set, and the counts agree. A number that had not been reconciled');
    say('    would be this machine describing its own file.');
    if (verdict === 'confirmed-by-the-chain') {
      say(`    IT MOVED BY EXACTLY WHAT WAS DEPOSITED: ${before!.toLocaleString()} to ${after.toLocaleString()}.`);
      say('    THE VAULT HOLDS A SHIELDED NOTE. That is the whole of what this door set out to');
      say('    establish, and everything on the private path was behind it.');
    } else {
      say('    \x1b[33mIT DID NOT MOVE BY WHAT WAS DEPOSITED.\x1b[0m');
      say('    \x1b[1mDO NOT RUN THIS DOOR AGAIN TO FIND OUT. IT WOULD DEPOSIT AGAIN.\x1b[0m');
      say('    INDEXER-CHECK.command says whether the indexer is level with the node.');
    }
  } catch (e: any) {
    say();
    say('  \x1b[1mWhat this vault holds: NOT ESTABLISHED BY THIS RUN\x1b[0m');
    if (e instanceof VaultPoolDisagreesWithChain) {
      say('    THE POOL AND THE CHAIN DISAGREE, AND THE DEPOSIT IS THE ONLY THING THAT HAPPENED');
      say('    BETWEEN THEM AGREEING AND NOT. The likeliest reading is that the indexer has not');
      say('    published this transaction yet — C110 — and the second is that the note landed');
      say('    under a commitment this client did not compute. The pool holds the note either');
      say('    way, with its nonce, colour and value.');
    }
    if (e instanceof VaultChainUnreadable) {
      say('    THE CHAIN COULD NOT BE READ, WHICH IS NOT THE CHAIN SAYING ZERO. C110.');
    }
    if (e instanceof VaultPoolUnreadable) {
      say('    THE POOL COULD NOT BE OPENED AFTER THE DEPOSIT, WHICH IS THE WORST OF THESE.');
      say('    The note is on chain and the record of it is unreadable. replayVault rebuilds a');
      say('    pool from the chain and the history — and it has no door (V-96).');
    }
    say(`    ${String(e?.message ?? e)}`);
    say('    NO FIGURE IS PRINTED IN PLACE OF THE ONE THAT COULD NOT BE READ (C238).');
    say('    \x1b[1mDO NOT RUN THIS DOOR AGAIN TO FIND OUT. IT WOULD DEPOSIT AGAIN.\x1b[0m');
  }

  say();
  say('  \x1b[1mWhat this vault can and cannot do now\x1b[0m');
  say('    IT HOLDS PRIVATE MONEY, AND PRIVATE MEANS THE CHAIN HOLDS A COMMITMENT. Nobody');
  say('    watching the chain can read the amount or the colour off the vault\x27s state. What');
  say('    a watcher CAN see is that a deposit happened: the depositing transaction is the');
  say('    depositor\x27s own and says so.');
  say('    MONEY LEAVES IT ONLY THROUGH AN APPROVED RUN, and no door here can raise one —');
  say('    deliberately, because a script that could raise one could move money.');
  say('    IT STILL CANNOT BE SENT MONEY. C236: funding a vault is a CALL and never a');
  say('    transfer. A plain send to this vault\x27s address is money nobody can ever spend.');

  live.stop();
  return verdict;
}

/* ------------------------------------------------------------------ *
 * the refusal, unabridged and bounded
 * ------------------------------------------------------------------ */

function fail(e: any): never {
  /*
   * NOT THROUGH THE SCREEN GUARD, for `open-vault-pool.ts`'s reason: an error
   * thrown from inside the guard would be unprintable. Every line below has the
   * address replaced by a marker instead — a substitution, which cannot throw.
   */
  const redact = (text: string): string => (vaultAddress
    ? text.split(vaultAddress).join('[the vault\x27s address, withheld — C236]')
    : text);
  const out = (text: string) => console.log(redact(text));

  out('');
  out(`\x1b[31m\x1b[1m  Failed during: ${clock.stage}\x1b[0m`);
  out(describeError(e, explainNodeError).split('\n').map((l) => '  ' + l).join('\n'));
  if (e?.stack) out(`\n\x1b[2m${String(e.stack).split('\n').slice(1, 8).join('\n')}\x1b[0m`);

  clock.print('stopped');
  try { printProving(); } catch { /* what is above stands */ }
  try { printTxSize(); } catch { /* the same */ }

  console.log();
  console.log("  \x1b[1mThe node's own words, verbatim and uncut\x1b[0m");
  if (rawNodeLines.length) {
    for (const line of collapseRepeatedLines(rawNodeLines)) {
      for (const part of line.split('\n')) out(`    ${part}`);
    }
    const codes = [...new Set(rawNodeLines.flatMap(
      (l) => [...l.matchAll(/Custom error:\s*(\d+)/g)].map((m) => m[1])))];
    console.log();
    for (const c of codes) {
      console.log(`    code ${c} = ${NODE_ERROR_CODES[c!] ?? '(not in our table — look it up in the node source, do not guess)'}`);
    }
    if (!codes.length) {
      console.log('    No numeric rejection code appears above. The node answered, but not with a');
      console.log('    Custom error.');
    }
  } else if (/deposit/i.test(clock.stage)) {
    console.log('    NOTHING, AND THE RUN HAD REACHED THE SUBMISSION STAGE. THAT HAS TWO');
    console.log('    READINGS AND THIS DOOR WILL NOT PICK ONE.');
    console.log('    One: the node never answered — the websocket dropped and the chain never');
    console.log('    saw it (M-23), and nothing happened.');
    console.log('    Two: it landed, and this run threw AFTERWARDS, on the pool write. That is');
    console.log('    C199\x27s window, it produces no node line either, and it is the case the');
    console.log('    attempt journal exists for. The journal entry above was written BEFORE the');
    console.log('    call, so the nonce is on disk in both readings.');
    console.log('    THE TRANSACTION ID, IF ONE WAS PRINTED ABOVE, IS WHAT SEPARATES THEM.');
  } else {
    console.log('    NOTHING, AND THE RUN NEVER REACHED THE SUBMISSION — it stopped in');
    console.log(`    "${clock.stage}". This failure is local: read the error above.`);
  }

  console.log();
  console.log('  \x1b[1mThe error object, whole — bounded, and it says what it dropped\x1b[0m');
  const serialised = serialiseWholeDetailed(e);
  out(serialised.text.split('\n').map((l) => '    ' + l).join('\n'));
  console.log();
  for (const line of describeDropped(serialised.dropped)) console.log(`    ${line}`);

  console.log();
  console.log('  \x1b[33mIF THE DEPOSIT LANDED AND THIS RUN STOPPED BEFORE THE POOL WAS WRITTEN,\x1b[0m');
  console.log('  \x1b[33mthe chain holds a note this machine has no record of.\x1b[0m C199, and it is the');
  console.log('  window this door opens. The recovery is replayVault, which rebuilds a pool from');
  console.log('  the chain and the history and HAS NO DOOR (V-96). Running this door again would');
  console.log('  deposit a second note, not recover the first.');
  process.exit(1);
}

/**
 * GUARDED, so a test can import the pure parts above without this file going to
 * the network and spending money on import.
 */
const RUN_DIRECTLY = typeof process.argv[1] === 'string'
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

/**
 * 0  the vault holds the note and the chain confirmed it.
 * 3  the deposit was submitted and the reconciliation did not confirm it — the
 *    pool holds the note either way, and the door must not claim the vault does.
 * 1  the run stopped before the deposit, or on it. `fail` prints why.
 */
if (RUN_DIRECTLY) {
  main().then((v) => process.exit(v === 'confirmed-by-the-chain' ? 0 : 3), fail);
}

/* ------------------------------------------------------------------ *
 * THE `.command` THIS NEEDS, NAMED AND WRITTEN BESIDE IT
 * ------------------------------------------------------------------ */

/*
 * **`DEPOSIT-TO-VAULT.command`.** Recorded here because the door is what a
 * person opens.
 *
 * WHAT IT PASSES:
 *
 *     MIDNIGHT_NETWORK_ID   ACCEPTED AND NEVER DECIDING. The network is the one
 *                           this build is compiled for; naming a different one
 *                           here is refused, and naming none is the ordinary case.
 *     VAULT_NAME            the vault, by name. NO DEFAULT.
 *     DEPOSIT_AMOUNT        how much, digits only. NO DEFAULT.
 *     MIDNIGHT_PROOF_IMAGE  the pinned image.
 *
 * WHAT IT REFUSES, before running anything:
 *
 *   1. **No name, or a name that is not a vault name.** It lists the vaults.
 *   2. **No amount, or an amount that is not digits.**
 *   3. **No `.midnight/<network>-test-token.json`** → names
 *      `MINT-TEST-TOKEN.command`.
 *   4. **No `contracts/managed-vault/keys/deposit.prover`** → names
 *      `COMPILE-VAULT.command`.
 *   5. **The proof server on 6301 not answering the pin**, through the shared
 *      check, whose refusals name `STOP-PROVER.command`.
 *
 * WHAT IT MUST NOT DO:
 *
 *   · **Not retry.** One attempt. A second run deposits again.
 *   · **Not print the address**, and not `cat` the registry or the pool file.
 *   · **Not stop the proof server.**
 *
 * WHAT IT EXPORTS AS A REPORT: `REPORT-DEPOSIT-TO-VAULT.txt`, ANSI stripped.
 */
