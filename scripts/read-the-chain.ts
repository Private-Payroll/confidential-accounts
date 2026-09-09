/**
 * DOES THIS PRODUCT READ THE CHAIN? ASKED OF THE PRODUCT, NOT AROUND IT.
 *
 * The product says it reads a chain. Every module that would do the reading has
 * unit tests, and the tests hand in a double: no test anywhere sends a question
 * to an indexer and reads a deployed contract's answer back through the
 * product's own boundary. So the claim rests on the code looking right.
 *
 * **THIS INSTRUMENT ASKS THE PRODUCT'S OWN BOUNDARY AND NOTHING ELSE.** It
 * resolves a deployment the way the product resolves one, assembles the running
 * set the way the product assembles it, and asks that set for an account's
 * state. It builds no ledger of its own, and it does not fetch a contract by
 * hand and decode it. A reading obtained some other way would prove something
 * about this file and nothing about what ships.
 *
 * ── THE TWO RUNS, AND WHY THERE ARE TWO ──────────────────────────────────
 *
 * The boundary takes one input it does not own: the lookup that turns an
 * account id into the address of the contract that account lives at. The
 * product supplies that from its own store. So this asks twice.
 *
 *   AS CONFIGURED - the lookup reads the product's own store, exactly as the
 *   running service does. This is the only run that can settle the question,
 *   because it is the product.
 *
 *   WITH THE ADDRESS SUPPLIED - the same boundary, the same ledger, the same
 *   providers, with that one lookup answering with the address THE PRODUCT
 *   ITSELF ALREADY RESOLVED from its deployment. Nothing else changes. This
 *   cannot settle the question and is not allowed to: what it can do is say
 *   whether the rest of the path works, so that a failure in the first run is
 *   reported as the missing lookup rather than as a broken reader.
 *
 * **THE SECOND RUN NEVER PRODUCES THE SETTLING VERDICT.** That rule lives in
 * `./read-the-chain-rules.ts` with the rest of the decisions, and it is pinned
 * there against a copy of itself that has been broken on purpose.
 *
 * ── WHAT IT REPORTS AND WHY EACH ONE IS THERE ────────────────────────────
 *
 * The four public numbers an account answers with, so they can be set beside
 * the four the deploy recorded and compared rather than each believed alone.
 * What the boundary answers for a contract that has no state, because the value
 * that means "could not ask" and the value that means "nothing there" are the
 * same value at this boundary and a report that blurs them is worse than none.
 * A vault's payment count and note count through the vault's own generated
 * reader, which is a SECOND instrument over a SECOND contract, so the two can
 * check each other. And the wall clock for every read, because every screen
 * that reads the chain pays it.
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────
 *
 * Read-only. Nothing is built, proved, submitted, deployed or spent. It never
 * prints a contract address: every one it handles is registered with the screen
 * below before the first line is printed, and the screen refuses any line
 * carrying one.
 *
 * **IT ALSO DOES NOT OPEN THE PRODUCT'S STORE THROUGH THE PRODUCT'S STORE
 * CLASS, AND THAT IS A DELIBERATE DIVERGENCE THIS REPORT DECLARES.** That
 * class writes its file as it constructs - it normalises the shape and flushes
 * - so an instrument that opened it would CREATE the store it came to look at,
 * and every later run would be looking at this one's leavings. It reads the
 * same file, at the same path, resolved the same way, and never writes it.
 */
export {};

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createScreen, phaseClock } from './deploy-report.js';
import { loadEnvFile } from '../src/db/connect.js';
import { networkOfThePair } from '../src/midnight/network.js';
import { deployment, deploymentRecordPath, type Deployment } from '../src/wiring/deployment.js';
import { startProduct, type Startup } from '../src/wiring/product.js';
import { ContractBook, type RecordedContract } from '../src/wiring/account-contract.js';
import type { LedgerStatus } from '../src/core/ledger.js';
import {
  sayReading, carriesNumbers, compareReadbacks, vaultNumbers, verdict,
  type AccountNumbers, type Reading,
} from './read-the-chain-rules.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/*
 * **THE ENVIRONMENT IS LOADED THE WAY THE SERVICE LOADS IT, AND BEFORE
 * ANYTHING READS IT.** The service fills unset names from the environment file
 * on its first lines; an instrument that skipped that would resolve a different
 * deployment from the one the product resolves and then report about it.
 */
loadEnvFile(join(ROOT, '.env'));

const B = '[1m'; const D = '[2m'; const O = '[0m';
const G = '[32m'; const R = '[31m'; const Y = '[33m';

/* Every address this run touches, registered before the first printed line. */
const secret: Array<{ what: string; value: string }> = [];
const say = createScreen(() => secret);
const clock = phaseClock(say);

/**
 * A caught message, with every registered address taken out of it first.
 *
 * The screen below is the backstop and it aborts the run, which is right for a
 * line this file forgot about. It is the wrong outcome for a refusal the
 * PRODUCT wrote, because those name the contract they are about by design - and
 * losing the whole reading to one of them would mean the instrument could never
 * report the very failures it exists to find.
 */
const scrubbed = (e: unknown): string => {
  let text = e instanceof Error ? e.message : String(e);
  for (const s of secret) {
    if (s.value.length >= 8) text = text.split(s.value).join(`<${s.what}>`);
  }
  return text;
};

const refusals: string[] = [];
const refuse = (what: string, why: string): void => {
  refusals.push(`${what}: ${why}`);
  say(`    ${Y}COULD NOT ESTABLISH${O}  ${what}`);
  say(`      ${D}${why}${O}`);
};

/** Milliseconds, to one decimal of a second, for a thing a screen will pay. */
const took = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/* ------------------------------------------------------------------ *
 * turning the boundary's answer into one of the four shapes
 * ------------------------------------------------------------------ */

/**
 * **A FIELD THAT DID NOT DECODE IS NOT A NUMBER, AND THIS IS WHERE THAT IS
 * CAUGHT.**
 *
 * The boundary underneath reads three of these straight off the decoded state
 * rather than through the guard its four maps get, so a state that decoded in
 * part hands back an absent field, and `Number(undefined)` is a value that
 * prints, compares and looks like a reading. The verdict this instrument
 * carries out turns on these four, so a run that cannot state all four has not
 * read the account: it has read some of it.
 */
function numbersOf(s: LedgerStatus): AccountNumbers | null {
  const four = {
    threshold: Number(s.threshold),
    signerCount: Number(s.signerCount),
    openProposals: Array.isArray(s.openProposals) ? s.openProposals.length : Number.NaN,
    movementCount: Number(s.movementCount),
  };
  for (const v of Object.values(four)) if (!Number.isFinite(v)) return null;
  return four;
}

/**
 * Ask the product's boundary for one account's state, and classify what came
 * back into a shape that cannot lose the distinction on the way to the report.
 *
 * **`addressWasResolvable` IS PASSED IN AND NEVER GUESSED.** The boundary
 * answers with one absent value whether the lookup found no address or the
 * chain carried no state, and this is the only place in the run that knows
 * which of the two happened - because it is the caller who supplied the lookup.
 */
async function readThrough(
  ledger: { status(id: string): Promise<LedgerStatus | null> },
  accountId: string,
  addressWasResolvable: boolean,
): Promise<{ reading: Reading; ms: number }> {
  const started = Date.now();
  try {
    const s = await ledger.status(accountId);
    const ms = Date.now() - started;
    if (s === null) {
      return { reading: addressWasResolvable ? { kind: 'no-state' } : { kind: 'never-asked' }, ms };
    }
    const numbers = numbersOf(s);
    if (numbers === null) {
      return { reading: { kind: 'failed', cause:
        'the contract answered and its state did not decode into all four of the numbers '
        + 'this reading turns on, so what came back is a measurement of how far the decoding '
        + 'got rather than of the account' }, ms };
    }
    return { reading: { kind: 'answered', numbers }, ms };
  } catch (e) {
    return { reading: { kind: 'failed', cause: scrubbed(e) }, ms: Date.now() - started };
  }
}

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

async function main(): Promise<number> {
  say();
  say(`${B}  DOES THIS PRODUCT READ THE CHAIN?${O}`);
  say(`${D}  Asked of the product's own boundary. Nothing is built, proved, submitted,${O}`);
  say(`${D}  deployed or spent, and no contract address is printed.${O}`);
  say();

  /* ---- 1. which network, and what the product resolves ---- */

  clock.begin(1, 6, 'The deployment');

  let network: string;
  try {
    network = networkOfThePair(process.env.MIDNIGHT_NETWORK_ID);
  } catch (e) {
    say(`  ${R}✗${O} the network could not be settled: ${scrubbed(e)}`);
    say();
    clock.print('finished');
    return 3;
  }
  say(`  ${G}✓${O} network ${B}${network}${O}`);
  say(`    ${D}deployment record  ${deploymentRecordPath('.', network as any)}${O}`);

  let d: Deployment | undefined;
  try {
    d = deployment(ROOT, process.env);
    secret.push({ what: "the account's contract address", value: d.contractAddress });
    say(`  ${G}✓${O} the product resolved a deployment from what is on disk`);
    say(`    ${D}indexer            ${d.indexerUrl}${O}`);
    say(`    ${D}contract address   ${D}resolved, not printed${O}`);
  } catch (e) {
    say(`  ${R}✗${O} ${B}THE PRODUCT COULD NOT RESOLVE A DEPLOYMENT.${O}`);
    say();
    for (const line of scrubbed(e).split('. ')) say(`    ${line.trim()}`);
    refuse('the deployment', scrubbed(e));
  }
  say();

  /* ---- 2. the lookup the product uses, read without writing it ---- */

  clock.begin(2, 6, 'The lookup that turns an account into an address');
  say(`  ${D}The running service answers this from its own store and from nowhere else.${O}`);

  /*
   * **RESOLVED THE WAY THE SERVICE RESOLVES IT, CHARACTER FOR CHARACTER.** A
   * relative path taken against a different base is a different file, and the
   * failure would be this instrument reporting an empty store while the service
   * reads a full one.
   */
  const storePath = process.env.DATA_PATH ?? join(process.cwd(), '.data', 'beta.json');
  const storeExists = existsSync(storePath);
  say(`  ${D}store  ${process.env.DATA_PATH ?? '.data/beta.json'}${O}`);

  const stored = new Map<string, RecordedContract>();
  if (!storeExists) {
    say(`  ${Y}!${O} ${B}THERE IS NO STORE FILE.${O} The service's lookup answers with nothing`);
    say(`    for every account id, so no read it performs can name a contract.`);
  } else {
    try {
      const shape: any = JSON.parse(readFileSync(storePath, 'utf8'));
      const accounts = shape?.accounts ?? {};
      for (const [id, a] of Object.entries<any>(accounts)) {
        if (typeof a?.contractAddress === 'string' && a.contractAddress.trim() !== '') {
          /*
           * **THE TWO FACTS BESIDE THE ADDRESS TRAVEL WITH IT.** An address on
           * its own cannot be told from one a process invented for itself, and
           * an instrument that dropped them would be pointing a real indexer at
           * a value nobody assigned - which answers "no state" rather than
           * failing, so the report would call the account deployed and empty
           * when it was never deployed at all.
           */
          stored.set(id, {
            address: a.contractAddress,
            source: a.addressSource ?? null,
            wiring: a.wiring ?? null,
          });
          secret.push({ what: 'a stored account address', value: a.contractAddress });
        }
      }
      say(`  ${G}✓${O} ${Object.keys(accounts).length} account(s) stored, `
        + `${stored.size} carrying a contract address`);
    } catch (e) {
      refuse("the product's store", `it exists and could not be read: ${scrubbed(e)}`);
    }
  }
  say();

  if (!d) {
    say(`${B}  Nothing further can be asked without a deployment.${O}`);
    say();
    clock.print('finished');
    printRefusals();
    const v = verdict({ deploymentResolved: false,
      asConfigured: { kind: 'never-asked' }, withAddressSupplied: { kind: 'never-asked' } });
    return sayVerdict(v);
  }

  /* ---- 3. the product, exactly as configured ---- */

  clock.begin(3, 6, "The product's boundary, as this deployment is configured");

  const asConfigured = await runOne(
    id => stored.get(id) ?? null,
    stored.size > 0 ? [...stored.keys()] : ['the-account-this-deployment-was-built-for'],
    (id) => stored.has(id));
  say();

  /* ---- 4. the same boundary, with the address supplied ---- */

  clock.begin(4, 6, 'The same boundary, with the one input it does not own supplied');
  say(`  ${D}Same ledger, same providers, same deployment. The lookup answers with the${O}`);
  say(`  ${D}address the product itself resolved above. This cannot settle the question.${O}`);

  /*
   * The deployment's own contract, presented the way the product's store would
   * present a company it had opened. **The provenance is asserted here rather
   * than read**, and it is the deploy record's address, which a chain did
   * assign - so this phase measures the read and not the rule.
   */
  const supplied = await runOne(
    () => ({ address: d!.contractAddress, source: 'chain', wiring: 'chain' }),
    ['supplied'], () => true);
  say();

  /* ---- 5. a contract the indexer has no state for ---- */

  clock.begin(5, 6, 'What the boundary answers for a contract with no state');
  say(`  ${D}An address one character different from the deployed one. Well formed, and${O}`);
  say(`  ${D}nothing was deployed at it. Neither it nor the difference is printed.${O}`);

  const absent = neighbourOf(d.contractAddress);
  secret.push({ what: 'the undeployed address', value: absent });
  const absentRead = await runOne(
    () => ({ address: absent, source: 'chain', wiring: 'chain' }), ['absent'], () => true);

  if (absentRead.reading.kind === 'no-state') {
    say(`  ${B}THE SAME ABSENT VALUE THE EMPTY LOOKUP PRODUCES.${O} The boundary answers`);
    say(`  identically whether no question was sent, whether one was sent about a`);
    say(`  contract that has no state, and whether the account is genuinely empty.`);
    say(`  ${D}Nothing downstream of it can tell those apart from the answer alone.${O}`);
  }
  say();

  /* ---- 6. the second instrument, over the vault ---- */

  clock.begin(6, 6, "A vault, through the vault's own reader");
  say(`  ${D}A second contract read by a second instrument, so the two can be checked${O}`);
  say(`  ${D}against each other. The product's running set has no vault boundary, so${O}`);
  say(`  ${D}this one is not the product's and does not pretend to be.${O}`);
  await readVault(d, network);
  say();

  /* ---- what the two readings of the same four numbers say ---- */

  say(`${B}  The four numbers, against what the deploy wrote down${O}`);
  /*
   * **ONLY THE THRESHOLD HAS A RECORDED SIDE**, and that is stated rather than
   * left to be inferred from three blank cells: the deployment record carries
   * the threshold and does not carry the other three, so those three are
   * uncomparable here and no run of this instrument will ever call them agreed.
   */
  const recorded = recordedNumbers(ROOT, network);
  const from = carriesNumbers(asConfigured.reading) ? 'the product as configured'
    : carriesNumbers(supplied.reading) ? 'the run with the address supplied' : 'nothing';
  const read = carriesNumbers(asConfigured.reading) ? asConfigured.reading.numbers
    : carriesNumbers(supplied.reading) ? supplied.reading.numbers : {};
  say(`  ${D}read now: from ${from}. Recorded: the deployment record, which carries the${O}`);
  say(`  ${D}threshold and none of the other three.${O}`);
  const cmp = compareReadbacks(recorded, read);
  for (const k of ['threshold', 'signerCount', 'openProposals', 'movementCount'] as const) {
    const a = recorded[k]; const b = (read as Partial<AccountNumbers>)[k];
    const mark = cmp.perField[k] === 'agree' ? `${G}✓${O}`
      : cmp.perField[k] === 'differ' ? `${R}✗${O}` : `${Y}?${O}`;
    say(`    ${mark} ${k.padEnd(16)} recorded at deploy ${String(a ?? '-').padStart(6)}`
      + `    read now ${String(b ?? '-').padStart(6)}    ${cmp.perField[k]}`);
  }
  if (cmp.overall === 'incomparable') {
    say(`  ${Y}!${O} ${B}NOT COMPARED.${O} One side is missing, and a comparison with a missing`);
    say(`    side is not agreement.`);
  }
  say();

  clock.print('finished');
  printRefusals();

  return sayVerdict(verdict({
    deploymentResolved: true,
    asConfigured: asConfigured.reading,
    withAddressSupplied: supplied.reading,
  }));

  /* ---------------- helpers that need the closure ---------------- */

  async function runOne(
    recordedFor: (id: string) => RecordedContract | null,
    ids: string[],
    resolvable: (id: string) => boolean,
  ): Promise<{ reading: Reading; ms: number }> {
    /*
     * **THE PRODUCT'S OWN RULE RUNS HERE, WHICH IS THE POINT OF THE
     * INSTRUMENT.** The records go in through the reading half, so an address
     * no chain assigned - or one written by a ledger that is not this one - is
     * refused exactly as it would be in the product, and this report says so
     * rather than sending a question about it to a real indexer.
     */
    const startup = startProduct(new ContractBook(recordedFor, 'chain'), ROOT, process.env);
    if (!startup.started) {
      /*
       * **NAMED, BECAUSE THIS FILE IS TYPECHECKED WITHOUT STRICT NULL CHECKS
       * AND A BOOLEAN DISCRIMINANT DOES NOT NARROW A UNION THERE.** The shape
       * is written down rather than reached through `any`, so a change to the
       * refusing half of that union is still a compile error here.
       */
      const refused = startup as Extract<Startup, { started: false }>;
      say(`  ${R}✗${O} the running set did not assemble`);
      for (const line of refused.refusal.split('\n')) if (line.trim()) say(`    ${line.trim()}`);
      return { reading: { kind: 'failed', cause: 'the running set did not assemble' }, ms: 0 };
    }
    say(`  ${G}✓${O} running set assembled, marked ${B}${startup.wiring.name}${O}`);

    let ledger: any;
    try {
      ledger = startup.wiring.createLedger();
      say(`    ${D}${ledger.describe()}${O}`);
    } catch (e) {
      refuse('building the ledger', scrubbed(e));
      return { reading: { kind: 'failed', cause: scrubbed(e) }, ms: 0 };
    }

    let last: { reading: Reading; ms: number } = { reading: { kind: 'never-asked' }, ms: 0 };
    for (const id of ids) {
      last = await readThrough(ledger, id, resolvable(id));
      say(`  ${last.reading.kind === 'answered' ? `${G}✓${O}` : `${Y}!${O}`} `
        + `${sayReading(last.reading)}`);
      say(`    ${D}the read took ${took(last.ms)}${O}`);
      if (carriesNumbers(last.reading)) {
        const n = last.reading.numbers;
        say(`    ${B}threshold${O}        ${n.threshold}`);
        say(`    ${B}signers seated${O}   ${n.signerCount}`);
        say(`    ${B}open proposals${O}   ${n.openProposals}`);
        say(`    ${B}movements${O}        ${n.movementCount}`);
        break;
      }
    }
    return last;
  }

  function sayVerdict(v: { code: 0 | 1 | 2 | 3; headline: string }): number {
    say();
    const colour = v.code === 0 ? G : v.code === 1 ? R : Y;
    say(`${colour}${B}  ${v.headline.split('. ')[0]}.${O}`);
    for (const rest of v.headline.split('. ').slice(1)) if (rest.trim()) say(`  ${rest.trim()}`);
    say();
    return v.code;
  }

  function printRefusals(): void {
    if (refusals.length === 0) return;
    say(`${B}  What could not be established${O}`);
    for (const r of refusals) say(`    ${r}`);
    say();
  }
}

/**
 * A well formed address that differs from the deployed one in its last
 * character. Used to ask the boundary about a contract nothing was deployed at.
 */
function neighbourOf(address: string): string {
  const last = address.slice(-1);
  const swapped = last === '0' ? '1' : '0';
  return address.slice(0, -1) + swapped;
}

/**
 * The four numbers the deploy wrote down, for the comparison. Read off the
 * deployment record, which is the only thing on disk that carries any of them,
 * and absent fields stay absent rather than becoming zero.
 */
function recordedNumbers(root: string, network: string): Partial<AccountNumbers> {
  try {
    const rec: any = JSON.parse(
      readFileSync(join(root, '.midnight', `${network}-contract.json`), 'utf8'));
    return typeof rec?.threshold === 'number' ? { threshold: rec.threshold } : {};
  } catch {
    return {};
  }
}

/**
 * The vault's payment count and note count, through the compiled vault's own
 * generated reader and the same public data provider the client reads with.
 *
 * **EVERY FIELD IS FORCED BEFORE ANY NUMBER IS PRINTED.** A generated reader
 * decodes field by field, so a state that is wrong further along can still hand
 * back a well formed value for an earlier field. Forcing both first means a
 * half decode produces a refusal instead of one real looking number.
 */
async function readVault(d: Deployment, network: string): Promise<void> {
  const vaultsFile = join(ROOT, '.midnight', `${network}-vaults.json`);
  if (!existsSync(vaultsFile)) {
    refuse('a vault reading', 'no vault has been deployed and recorded on this network');
    return;
  }

  /*
   * **ASKED, WITH NO DEFAULT.** A default name is the only value this stage
   * could ever have, so it would read whichever vault happened to be last in a
   * file and report the numbers under the heading of a vault nobody asked
   * about. An unnamed vault is a stage that does not run.
   */
  const named = process.env.VAULT_NAME?.trim();
  if (!named) {
    refuse('a vault reading', 'no vault was named, and there is deliberately no default: a '
      + 'guessed name would report one vault\'s counters as another\'s');
    return;
  }

  let name: string | undefined; let address: string | undefined;
  try {
    const vaults: any = JSON.parse(readFileSync(vaultsFile, 'utf8'))?.vaults ?? {};
    name = vaults[named] ? named : undefined;
    address = name ? vaults[name]?.contractAddress : undefined;
    if (!name) {
      const known = Object.keys(vaults);
      refuse('a vault reading', known.length > 0
        ? `no vault of that name is recorded on ${network}; the recorded names are `
          + known.join(', ')
        : `no vault at all is recorded on ${network}`);
      return;
    }
  } catch (e) {
    refuse('a vault reading', `the record of deployed vaults could not be read: ${scrubbed(e)}`);
    return;
  }
  if (!name || typeof address !== 'string') {
    refuse('a vault reading', 'no deployed vault carries a contract address on this network');
    return;
  }
  secret.push({ what: "the vault's contract address", value: address });
  say(`  ${G}✓${O} vault ${B}${name}${O}`);

  const started = Date.now();
  let state: any;
  try {
    const { indexerPublicDataProvider } =
      await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
    state = await indexerPublicDataProvider(d.indexerUrl, d.indexerWsUrl)
      .queryContractState(address as any);
  } catch (e) {
    refuse("the vault's counters",
      `this machine could not reach the indexer: ${scrubbed(e)}. That is a fact about this `
      + 'machine and rules on nothing about the vault');
    return;
  }
  if (!state) {
    refuse("the vault's counters",
      'the indexer carried no state for this vault. That is not an empty vault, and an '
      + 'indexer that has not caught up answers exactly the same way');
    return;
  }

  const forced: { payments?: string; notes?: string } = {};
  try {
    const { ledger: readVaultState } =
      await import('../contracts/managed-vault/contract/index.js');
    const parsed: any = (readVaultState as any)(state.data);
    const notes = String(parsed.notes.size());
    const payments = String(parsed.payments);
    forced.notes = notes; forced.payments = payments;
  } catch (e) {
    refuse("the vault's counters", `the state did not decode: ${scrubbed(e).slice(0, 300)}`);
    return;
  }

  const numbers = vaultNumbers(forced);
  if (!numbers.reportable) {
    refuse("the vault's counters", 'the state decoded only in part, so neither number is a '
      + 'measurement of the vault rather than of how far the decoding got');
    return;
  }
  say(`    ${B}note commitments${O}  ${numbers.notes}`);
  say(`    ${B}payments recorded${O} ${numbers.payments}`);
  say(`    ${D}the read took ${took(Date.now() - started)}${O}`);
}

/*
 * Guarded, so the rules next door and everything importable from here can be
 * exercised by a test without this file reaching a network or exiting.
 */
const RUN_DIRECTLY = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (RUN_DIRECTLY) {
  main()
    .then((code) => { process.exit(code); })
    .catch((e) => {
      /*
       * **THE HANDLER MAY NOT THROW, AND THIS IS WHY IT IS WRAPPED.** The
       * screen refuses any line carrying an address, including a line printed
       * from here - and a throw inside a rejection handler is an unhandled
       * rejection, which exits 1. One is a substantive verdict in this
       * instrument's code list, so a crash would be reported as a finding about
       * the product. Whatever happens below, the code is 2.
       */
      try {
        say();
        say(`${R}${B}  THE READ STOPPED.${O}`);
        say(`  ${scrubbed(e)}`);
        say();
      } catch {
        process.stdout.write('\n  THE READ STOPPED, and the line saying why could not be '
          + 'printed without showing a contract address.\n\n');
      }
      process.exit(2);
    });
}
