/**
 * WHAT A CIRCUIT COSTS AT DEPLOY TIME — MEASURED, NOT DIVIDED. `S8` item 4.
 *
 * Run it with MEASURE-DEPLOY-SHAPE.command, or:
 *   npx tsx scripts/measure-deploy-shape.ts
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * The deploy is refused at `bytesWritten 41,324` against a derived ceiling of
 * 32,497 (it was believed to be 37,500 until S11),
 * and the fifteen verifier keys are 31,017 of it. Every plan that follows —
 * defer N circuits, move N circuits to another contract, split — is arithmetic
 * over TWO numbers nobody had measured:
 *
 *   what a contract costs with NO circuits, and
 *   what each ADDITIONAL circuit costs.
 *
 * Subtracting 31,017 from 41,324 gives a fixed overhead of 10,307 **only if
 * the overhead is fixed**, and it is not obviously fixed: a deploy's
 * `bytesWritten` is `map_insert(...) + tree_copy(initial_state)`
 * (`midnight-ledger@crate-ledger-9.1.0.0-rc.3`, `ledger/src/structure.rs`
 * :2086-2092), and `tree_copy` walks the whole state tree — including the
 * operations map, whose every entry carries an entry-point NAME as well as a
 * key.
 *
 * So this file does not divide. It BUILDS a deploy transaction for each circuit
 * count from 0 to 15 and reads the cost off each one.
 *
 * ── HOW ──────────────────────────────────────────────────────────────────────
 *
 * `createUnprovenDeployTxFromVerifierKeys` is four lines of the SDK
 * (`midnight-js-contracts/dist/index.mjs:936-943`): wrap a `ContractState` in a
 * `ContractDeploy`, put it in an `Intent`, and make a `Transaction`. Those four
 * lines are reproduced here over states carrying k operations, so what is
 * measured is a real transaction of the same shape the deploy builds — not an
 * estimate of one.
 *
 * The state's DATA is the real constructor's, from `contracts/test/simulator`,
 * so the ledger layout every deploy carries is present in every row. Only the
 * operations map varies, which is the thing being measured.
 *
 * No node, no indexer, no proof server, no wallet. Nothing is spent and
 * nothing is submitted.
 *
 * ── THE CEILING IS DERIVED, AND IT IS ~65%, NOT 75% ─────────────────────────
 *
 * This file used to hold `NORMAL_DISPATCH_RATIO = 0.75` as a literal, cited to
 * `runtime/src/lib.rs:307` — a real line, correctly read, and not the number
 * that decides: on 28 Aug a 35,748-byte deploy sat UNDER the 37,500
 * "75% ceiling" and the chain refused it with 1010. 75% is the NORMAL class's
 * per-BLOCK budget; ONE extrinsic is judged against `max_extrinsic` =
 * 0.75 − 0.10 − base_extrinsic ≈ 0.65 of the block. `scripts/dispatch-ceiling.ts`
 * derives it, cites every line, prints the chain on every run, and is
 * calibrated against the two real submissions (31,201 ACCEPTED, 35,748
 * REFUSED) by `scripts/dispatch-ceiling.test.ts`.
 *
 * ── WHICH CONTRACT. ──────────────────────────────────────────────────────────
 *
 *   npx tsx scripts/measure-deploy-shape.ts            the account (default)
 *   npx tsx scripts/measure-deploy-shape.ts vault      the vault
 *
 * **The default is the account and it is the account this file was written
 * against**, so everything that ran it before this argument existed produces
 * the same numbers. The vault is the reason the argument exists: it had never
 * had verifier keys built, so its deploy had never been measured by
 * anything and the whole vault column of `docs/scope-what-a-contract-costs.md`
 * §7 is a PREDICTION.
 *
 * **It refuses rather than guessing.** A contract whose keys are missing, or
 * whose operations map holds a name with no key beside it, is not measured at a
 * lower number — it is refused, naming the `.command` that builds the keys. A
 * deploy measured with keys missing is a deploy nobody would submit, and it
 * would read as good news.
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  ContractOperation, ContractState, createConstructorContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';

import { Contract as VaultContract } from '../contracts/managed-vault/contract/index.js';
import { AccountSimulator, privateStateFor } from '../contracts/test/simulator.js';
import { applyNetworkId, theNetwork } from '../src/midnight/network.js';
import { classCeiling, extrinsicCeiling, printDerivation } from './dispatch-ceiling.js';
import { limitsFromLedger, measureCost } from './tx-size.js';

const ROOT = process.cwd();
const ACCOUNT_ARTEFACTS = join(ROOT, 'contracts', 'managed');
const VAULT_ARTEFACTS = join(ROOT, 'contracts', 'managed-vault');
const NETWORK = theNetwork();

const line = (s = '') => console.log(s);
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

/**
 * WHICH CONTRACT IS BEING MEASURED.
 *
 * The argument first, the environment second, the ACCOUNT last — the default is
 * what every existing caller passes, which is nothing.
 */
type Target = 'account' | 'vault';
const TARGET_ARG = (process.argv[2] ?? process.env.MEASURE_TARGET ?? 'account').toLowerCase();
if (TARGET_ARG !== 'account' && TARGET_ARG !== 'vault') {
  console.log(`\n  \x1b[31mUnknown contract "${TARGET_ARG}".\x1b[0m Say "account" or "vault".\n`);
  process.exit(2);
}
const TARGET = TARGET_ARG as Target;
const ARTEFACTS = TARGET === 'vault' ? VAULT_ARTEFACTS : ACCOUNT_ARTEFACTS;
/** What builds the keys for this target, named in every refusal. */
const BUILT_BY = TARGET === 'vault' ? 'COMPILE-VAULT.command' : 'DEPLOY-PREVIEW.command';
/** A block hash the vault's constructor context is anchored to. Offline; nothing reads it. */
const BLOCK = '0'.repeat(64);

/**
 * The contract's initial state, as its own constructor produces it.
 *
 * NOT a hand-built `ContractState` in either case. What `tree_copy` walks at
 * deploy is the real constructor's ledger, and a second construction of it here
 * would be measuring this file rather than the contract.
 *
 * The vault's constructor takes the account it is married to (`V-37`). The
 * ADDRESS is a sampled one: a contract address is 32 bytes whichever account it
 * names, and this file never calls anything, so nothing here depends on that
 * account existing.
 */
const initialStateOf = async (target: Target): Promise<any> => {
  if (target === 'account') {
    const sim = await AccountSimulator.create(privateStateFor(1));
    return sim.contractStateForCall;
  }
  const vault = new VaultContract({
    /* The vault declares one witness. The constructor calls none of them. */
    noteToSpend: (ctx: unknown) => [ctx, {
      nonce: new Uint8Array(32), color: new Uint8Array(32), value: 0n, mt_index: 0n,
    }],
  } as never);
  const init: any = await vault.initialState(
    createConstructorContext({} as never, BLOCK),
    { bytes: Uint8Array.from(Buffer.from(String(sampleContractAddress()), 'hex')) } as never);
  return init.currentContractState;
};

async function main() {
  line('────────────────────────────────────────────────────────────');
  line(`  What does one CIRCUIT cost a deploy? — ${TARGET === 'vault' ? 'THE VAULT' : 'the account'}`);
  line('────────────────────────────────────────────────────────────');
  line();
  line('  No node, no indexer, no proof server, no wallet. Nothing is spent and');
  line('  nothing is submitted.');
  line();

  const L: any = await import('@midnightntwrk/ledger-v9');
  await applyNetworkId(NETWORK);
  line(`  network id  ${NETWORK}`);

  line(`  contract    ${TARGET}  (${ARTEFACTS.replace(`${ROOT}/`, '')})`);

  /*
   * THE KEYS, OR NOTHING. A missing key directory is a refusal and not a
   * smaller number: with no keys every row would collapse onto the empty
   * baseline and the file would report a cheap contract rather than an
   * unmeasurable one.
   */
  if (!existsSync(join(ARTEFACTS, 'keys'))) {
    line();
    line(`  \x1b[31m${ARTEFACTS.replace(`${ROOT}/`, '')}/keys does not exist — there is nothing to measure.\x1b[0m`);
    line(`  Run ${bold(BUILT_BY)} once, then run this again.`);
    if (TARGET === 'vault') {
      line('  The vault has never had verifier keys built (C226): contracts/managed-vault/');
      line('  holds compiler/, contract/ and zkir/ and no keys/.');
    }
    line('  Nothing was measured and no number was estimated.');
    process.exit(1);
  }

  const limits = limitsFromLedger(L.LedgerParameters);
  /*
   * BOTH numbers, on every run — the class budget (75%) and the per-extrinsic
   * budget (~65%) — so the difference is on the page rather than in somebody's
   * head. `ceiling`, which every verdict below is judged against, is the
   * per-EXTRINSIC one: a deploy is one extrinsic.
   */
  const ceiling = extrinsicCeiling(limits.bytesWritten ?? 0);
  line(`  bytesWritten limit ${(limits.bytesWritten ?? 0).toLocaleString()}   class max_total ${classCeiling(limits.bytesWritten ?? 0).toLocaleString()} (75%)   per-extrinsic ceiling ${ceiling.toLocaleString()} (~65%)`);
  line();
  printDerivation(line, limits.bytesWritten);

  /* ------------------------------------------------- the state to build on */
  const runtimeState: any = await initialStateOf(TARGET);
  const names: string[] = [...runtimeState.operations()].sort();

  const keyBytes = new Map<string, Uint8Array>();
  const keyless: string[] = [];
  for (const n of names) {
    const f = join(ARTEFACTS, 'keys', `${n}.verifier`);
    if (existsSync(f)) keyBytes.set(n, new Uint8Array(readFileSync(f)));
    else keyless.push(n);
  }
  /*
   * A NAME IN THE OPERATIONS MAP WITH NO KEY BESIDE IT IS A REFUSAL.
   *
   * `deployWith` skips a circuit it has no key for, so a half-built key
   * directory would quietly measure a SMALLER contract than the one on disk —
   * and the number it printed would be under the ceiling for the wrong reason.
   */
  if (keyless.length > 0) {
    line();
    line(`  \x1b[31mthese circuits are in the contract and have no verifier key:\x1b[0m ${keyless.join(', ')}`);
    line(`  The build is incomplete. Run ${bold(BUILT_BY)} again.`);
    line('  Nothing was measured and no number was estimated.');
    process.exit(1);
  }
  line(`  circuits    ${names.length}, every one with a verifier key on disk`);

  /**
   * A deploy transaction over a state carrying exactly the operations in `keep`
   * — the others ABSENT, not merely keyless.
   *
   * The difference is worth 155 bytes a circuit and it is the whole point of
   * the file: a deferred circuit does not exist in the deployed contract, so it
   * costs neither its key nor its ENTRY-POINT NAME nor its entry in the
   * operations map, and `tree_copy` walks all three
   * (`ledger/src/structure.rs:2086-2092`). Leaving the names in and only
   * dropping the keys measures a contract nobody would deploy.
   *
   * `setOperation` cannot remove, so the state is rebuilt rather than pruned:
   * a fresh `ContractState` carrying the real constructor's `data` and
   * maintenance authority, and only the operations kept. Everything a deploy
   * writes except the operations map is therefore present in every row.
   *
   * The crossing between the two WASM modules is `serialize`/`deserialize`,
   * which is how the SDK does it too (`midnight-js-contracts/dist/index.mjs`
   * :934-943). A hand-built ledger state would be a second construction of the
   * thing being measured.
   */
  const deployWith = (keep: string[]) => {
    const cs: any = new ContractState();
    cs.data = runtimeState.data;
    cs.maintenanceAuthority = runtimeState.maintenanceAuthority;
    for (const n of keep) {
      const k = keyBytes.get(n);
      if (!k) continue;
      const op = new ContractOperation();
      op.verifierKey = k;
      cs.setOperation(n, op);
    }
    const ledgerState = L.ContractState.deserialize(cs.serialize(), NETWORK);
    const intent = L.Intent.new(new Date(Date.now() + 3_600_000));
    return L.Transaction.fromParts(
      NETWORK, undefined, undefined, intent.addDeploy(new L.ContractDeploy(ledgerState)));
  };

  /*
   * TWO ORDERINGS, because the answer is not a straight line.
   *
   * The marginal cost of a circuit is its key plus about 155 bytes of name and
   * map entry — except every few entries, where it is about 510 bytes more:
   * `tree_copy` walks the operations map and the map gets deeper. So "how many
   * fit" depends slightly on WHICH, and the cheap circuit (`closeExpiredRun`,
   * the only one with no `persistent_hash` and therefore the only 1,351-byte
   * key) is worth 770 bytes wherever it sits.
   *
   * Alphabetical is the order the state already holds them in. `big-first`
   * puts every 2,119-byte key first, which is the worst case and the one a
   * plan should be built on.
   */
  const orderings: Array<[string, string[]]> = [
    ['alphabetical — the order the operations map holds', names],
    ['big-first — every 2,119-byte key first, the worst case',
      [...names.filter((n) => (keyBytes.get(n)?.length ?? 0) === 2119),
       ...names.filter((n) => (keyBytes.get(n)?.length ?? 0) !== 2119)]],
  ];

  const bestRows: Array<{ k: number; keys: number; written: number }> = [];
  for (const [label, order] of orderings) {
    line();
    line(`  ${bold(`A deploy transaction, built once per circuit count — ${label}`)}`);
    line();
    line(`    ${'circuits'.padStart(8)}${'key bytes'.padStart(12)}${'bytesWritten'.padStart(14)}` +
         `${'marginal'.padStart(11)}${'of ceiling'.padStart(12)}`);
    let prev: number | null = null;
    const rows: Array<{ k: number; keys: number; written: number }> = [];
    for (let k = 0; k <= order.length; k++) {
      const keep = order.slice(0, k);
      const keys = keep.reduce((t, n) => t + (keyBytes.get(n)?.length ?? 0), 0);
      let written: number | null = null;
      try {
        written = measureCost(deployWith(keep), L.LedgerParameters).cost?.bytesWritten ?? null;
      } catch (e: any) {
        line(`    ${String(k).padStart(8)}   could not be built: ${String(e?.message ?? e).slice(0, 90)}`);
        continue;
      }
      if (written === null) { line(`    ${String(k).padStart(8)}   no cost returned`); continue; }
      rows.push({ k, keys, written });
      const marg = prev === null ? '' : (written - prev).toLocaleString();
      const over = written > ceiling ? '   \x1b[31mOVER\x1b[0m' : '';
      line(`    ${String(k).padStart(8)}${keys.toLocaleString().padStart(12)}${written.toLocaleString().padStart(14)}` +
           `${marg.padStart(11)}${`${((written / ceiling) * 100).toFixed(1)}%`.padStart(12)}${over}`);
      prev = written;
    }
    line();
    for (const r of rows) {
      if (r.written > ceiling) {
        const last = rows[rows.indexOf(r) - 1];
        line(`    first count OVER the ceiling: ${r.k} circuits at ${r.written.toLocaleString()}.` +
             `  ${last.k} fit, at ${last.written.toLocaleString()} — ${(ceiling - last.written).toLocaleString()} bytes of headroom.`);
        break;
      }
    }
    if (label.startsWith('big-first')) bestRows.push(...rows);
  }

  /* ------------------------------------ the set the deploy will actually carry */
  /*
   * THE EXACT SET, NOT A PREFIX OF AN ORDERING.
   *
   * The two orderings above bound the answer, but the deploy carries the
   * specific circuits `src/midnight/deferral.ts` names, and WHICH names are
   * kept moves the number: an entry-point NAME is part of what `tree_copy`
   * walks, so two sets with identical key bytes can differ. This row is the
   * gate a redeploy runs on, and it reads the same list the deploy reads —
   * never a hand-copied one, which is how a gate and a deploy drift apart.
   */
  if (TARGET === 'account') {
    const { DEPLOYED_CIRCUITS, DEFERRED_CIRCUITS } = await import('../src/midnight/deferral.js');
    const keep: string[] = [...DEPLOYED_CIRCUITS];
    const missing = keep.filter((n) => !names.includes(n));
    line();
    line(`  ${bold('The deployment src/midnight/deferral.ts actually names')}`);
    line(`    deployed  ${keep.join(', ')}`);
    line(`    deferred  ${DEFERRED_CIRCUITS.join(', ')}`);
    if (missing.length > 0) {
      line(`    \x1b[31mthe deferral list names circuits this contract does not export:\x1b[0m ${missing.join(', ')}`);
      line('    Nothing was measured for this set.');
    } else {
      const keys = keep.reduce((t, n) => t + (keyBytes.get(n)?.length ?? 0), 0);
      const written = measureCost(deployWith(keep), L.LedgerParameters).cost?.bytesWritten ?? null;
      if (written === null) {
        line('    no cost returned');
      } else {
        const over = written > ceiling;
        line(`    ${keep.length} circuits, ${keys.toLocaleString()} bytes of key — ` +
             `${written.toLocaleString()} bytesWritten, ${((written / ceiling) * 100).toFixed(1)}% of the ` +
             `${ceiling.toLocaleString()} ceiling` +
             (over ? '   \x1b[31mOVER\x1b[0m' : ` — ${(ceiling - written).toLocaleString()} bytes of headroom`));
        line('    unproven and unbalanced, like every row above; the two balanced deploys');
        line('    this repository has measured moved by +257 and −249 from their unproven');
        line('    measurements (C218), so read this row as ±~260 once proven and balanced.');
        if (over) {
          line('    \x1b[31mTHIS SET DOES NOT FIT UNDER THE CEILING. Do not deploy it.\x1b[0m');
        }
      }
    }
  }

  const rows = bestRows;

  /* ------------------------------------------------------- what that means */
  if (rows.length > 1) {
    const empty = rows[0].written;
    const full = rows[rows.length - 1];
    line();
    line(`  ${bold('What the two numbers are')}`);
    line(`    a contract with NO verifier keys      ${empty.toLocaleString()} bytesWritten`);
    line(`    all ${String(full.k).padStart(2)} keys (${full.keys.toLocaleString()} bytes of key)   ${full.written.toLocaleString()} bytesWritten`);
    line(`    the circuits therefore account for   ${(full.written - empty).toLocaleString()} of it`);
    line(`      of which the KEYS themselves are   ${full.keys.toLocaleString()}`);
    line(`      and their NAMES and map entries    ${(full.written - empty - full.keys).toLocaleString()}  (about ${Math.round((full.written - empty - full.keys) / full.k)} a circuit)`);
    line();
    line(`  ${bold('And what a BALANCED, PROVEN deploy adds on top')}`);
    if (TARGET === 'account') {
      /*
       * TWO observations, OPPOSITE signs, and both are the PRE-S11 contract's —
       * the 15-circuit refusal (unproven 41,067 → balanced 41,324, +257) and
       * the 11-circuit acceptance (unproven 31,450 → balanced 31,201, −249).
       * Neither is this contract, so the delta is stated as a band rather than
       * subtracted from the rows above.
       */
      line('    Bounded by the two real submissions, both of the PRE-S11 contract:');
      line('    proving and balancing moved bytesWritten by +257 on the refused');
      line('    15-circuit deploy (41,067 → 41,324) and by −249 on the accepted');
      line('    11-circuit one (31,450 → 31,201). So read every row above as');
      line('    ±~260 bytes once proven and balanced. It is the only part of this');
      line('    file that is not measured here, and it is stated, not folded in.');
    } else {
      /*
       * THE 257 IS THE ACCOUNT'S AND IT IS ONE OBSERVATION. It is the
       * difference between the node's 41,324 refusal and this file's 41,067
       * measurement of the same contract — a single point, on a different
       * contract, with a different number of circuits and a different balancing
       * problem. Applying it to the vault would turn one observation into a law
       * and hide that this row is unmeasured. Scope §11 item 5.
       */
      line('    UNKNOWN FOR THIS CONTRACT, and deliberately not borrowed. The one');
      line('    observation this repository has — about 257 bytes — is the account\x27s:');
      line('    the difference between the node\x27s 41,324 refusal and the same');
      line('    contract measured here at 41,067. It is one point on another');
      line('    contract, so the figure above is a floor and nothing here narrows it.');
    }
  }

  /* --------------------------------------------------------- the other one */
  if (TARGET === 'account') {
    line();
    line(`  ${bold('The vault, for comparison')}`);
    const vaultKeys = join(VAULT_ARTEFACTS, 'keys');
    if (!existsSync(vaultKeys)) {
      line('    \x1b[33mTHE VAULT HAS NO VERIFIER KEYS ON DISK.\x1b[0m contracts/managed-vault/ holds');
      line('    compiler/, contract/ and zkir/ and no keys/. COMPILE-CONTRACT.command');
      line('    compiles with proving keys SKIPPED and DEPLOY-PREVIEW.command builds');
      line('    them for the ACCOUNT only, so THE VAULT DEPLOY HAS NEVER BEEN MEASURED');
      line('    by anything, and is not measured here.');
      line('    THE TWO DOORS, IN ORDER: COMPILE-VAULT.command builds the keys, then');
      line('    MEASURE-DEPLOY-SHAPE-VAULT.command measures the vault.');
    } else {
      /*
       * **READ OFF THE DIRECTORY, NOT OFF A LIST WRITTEN HERE.** `S29`, `C316`'s
       * family. This loop named four circuits — `deposit`, `payout`, `retire`,
       * `splitNote` — and the vault has SEVEN, so three of them (the unshielded
       * three) were absent from a block a person reads as the vault's keys. A
       * hand-written list of a compiled contract's circuits is a second place
       * the answer can come from, and it went stale the round the contract grew.
       */
      for (const f of readdirSync(vaultKeys).filter(n => n.endsWith('.verifier')).sort()) {
        const p = join(vaultKeys, f);
        line(`    ${f.replace(/\.verifier$/, '').padEnd(20)} ${statSync(p).size} bytes`);
      }
      line('    Measure it properly with: MEASURE-DEPLOY-SHAPE-VAULT.command');
    }
  } else {
    line();
    line(`  ${bold('The account, for comparison')}`);
    line('    Not re-measured here — one run measures one contract, so a number in');
    line('    this report is never a number from the other one.');
    line();
    line('    \x1b[33mAND NO FIGURE OF THE ACCOUNT\x27S IS QUOTED HERE.\x1b[0m Two stood in this');
    line('    paragraph until 31 Aug — 5,176 bytesWritten for an empty contract and');
    line('    41,067 for fifteen circuits — as string literals this run did not read');
    line('    off anything. Both were the PRE-S11 account: measured the same morning');
    line('    it is 4,018 and TEN circuits, and the account has not had fifteen since');
    line('    S11. A reader was then asked to check scope §7\x27s bound against the');
    line('    stale one. C316.');
    line();
    line('    THE DOOR THAT ANSWERS IT IS MEASURE-DEPLOY-SHAPE.command, which measures');
    line('    the account and writes REPORT-DEPLOY-SHAPE.txt. Scope §7\x27s bound on');
    line('    this contract\x27s empty-contract cost is checked against THAT report and');
    line('    against the row above — both measured, in runs that say when.');
  }

  line();
  line('  Nothing was submitted and nothing was spent.');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.log();
    console.log(`\x1b[31m\x1b[1m  It did not finish: ${String(e?.message ?? e)}\x1b[0m`);
    if (e?.stack) console.log(`\x1b[2m${String(e.stack).split('\n').slice(1, 10).join('\n')}\x1b[0m`);
    process.exit(1);
  },
);
