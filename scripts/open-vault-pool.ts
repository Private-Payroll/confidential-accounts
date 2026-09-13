/**
 * **GIVE A VAULT THE NOTE POOL IT CANNOT BE FUNDED WITHOUT.**
 *
 * Run it with `OPEN-VAULT-POOL.command`. What that door must pass and must
 * refuse is at the bottom of this file; the order the doors go in, and what each
 * one needs first, is `docs/command-order.md`.
 *
 * ------------------------------------------------------------------------
 * WHAT IS BROKEN WITHOUT IT
 *
 * There is a vault on chain and **it cannot take a deposit.**
 * `SealedNotePool.load` refuses when no record exists — correctly, because an
 * absent pool and an empty vault are opposite claims about a company's
 * treasury — and `VaultLedger.deposit` loads before it calls. So the client
 * cannot take the FIRST deposit, and every later one is unreachable behind it.
 *
 * `scripts/deploy-vault.ts` deliberately does not create one and could not: a
 * pool is sealed under a fresh symmetric key **wrapped to each signer's own
 * wrapping public key**, and a deploy instrument holds no signer key material.
 * `sealPool` already refuses a pool wrapped to nobody (`V-91`), which is the
 * refusal that makes the gap visible rather than the gap itself.
 *
 * **SO THE POOL IS CREATED BY SOMETHING THAT HOLDS SIGNER KEYS, WHICH IS THIS.**
 * And it holds only the PUBLIC halves: sealing needs `wrapKey`, wrapping needs
 * a public key, and nothing here ever wants a signer's secret. That is worth
 * saying out loud — this instrument creates a pool every signer can open and
 * cannot itself open one.
 *
 * ------------------------------------------------------------------------
 * **WHEN IT MUST RUN: AFTER THE VAULT EXISTS AND BEFORE ITS FIRST DEPOSIT.**
 *
 * There is no earlier moment — the pool is keyed by the vault's address, which
 * does not exist until the deploy lands — and no later one, because `deposit`
 * loads first.
 *
 * **UNTIL IT HAS RUN FOR A VAULT, THE PRODUCT MUST NOT OFFER THAT VAULT AS A
 * DESTINATION FOR MONEY BY ANY ROUTE.** A deployed vault is not a fundable
 * vault. That is downtime on its own, and it becomes loss the moment somebody
 * funds it another way: a vault has an address, anybody can address a shielded
 * output to it, and money that arrives without a `deposit` call is owned by the
 * vault and spendable by nobody, permanently.
 *
 * ------------------------------------------------------------------------
 * **AND THE HALF THAT IS NOT ABOUT CREATION AT ALL.**
 *
 * `S6d` established that answering *empty* where the truth is *unreadable*
 * makes `balance` report zero and leaves every note on chain unexplained. An
 * instrument that can write an empty pool is precisely how that state gets
 * MANUFACTURED: for a vault whose pool record has been lost, `create` sees
 * nothing and succeeds, and the empty pool it writes is a lie about a treasury
 * that exists.
 *
 * **The chain is the only thing that can tell those two apart**, so
 * `VaultLedger.openPool` asks it — and this instrument exists to give it a
 * chain to ask. It writes a pool only for a vault whose on-chain note set is
 * EMPTY, refuses with `replayVault` named for a vault that holds notes, and
 * refuses without writing anything when the chain could not be read.
 *
 * ------------------------------------------------------------------------
 * WHAT IT DOES NOT DO, AND WILL NOT
 *
 * **It does not deposit, pay, adopt, deploy or submit anything.** It reads one
 * contract's state and writes one local file. No wallet, no proof server, no
 * fee, nothing on chain.
 *
 * **It does not mint or write key material.** The signers' public keys are read
 * from a file `MAKE-TEST-SIGNERS.command` writes, exactly as the maintenance
 * authority is written by `CHOOSE-AUTHORITY.command`, and the refusal below
 * names that door rather than printing a shape for somebody to type. Nothing is
 * ever handed to a person as a thing to hand-write.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

import { VaultLedger, VaultChainUnreadable, VaultAlreadyHoldsNotes } from '../src/midnight/vault-ledger.js';
import { SealedNotePool, type PoolSigner } from '../src/midnight/vault-pool.js';
import {
  assertVaultName, vaultRegistryFile, parseVaultRegistry, type VaultEntry,
} from '../src/midnight/vault-record.js';
import { applyNetworkId, theNetwork, ENDPOINTS } from '../src/midnight/network.js';
import { explainNodeError } from './node-errors.js';
import { serialiseWholeDetailed, describeDropped } from './error-report.js';
import { createScreen, phaseClock, describeError } from './deploy-report.js';
import { FileSealedPoolStore, vaultPoolFile } from './vault-pool-file.js';

/* ------------------------------------------------------------------ */

const ROOT = process.cwd();
const STATE_DIR = join(ROOT, '.midnight');
const NETWORK = theNetwork();
const VAULT_ARTEFACTS = join(ROOT, 'contracts', 'managed-vault');

/**
 * WHICH VAULT, by the name a person chose. No default, for `deploy-vault.ts`'s
 * reason: a default here would silently open a pool for whichever vault the
 * registry happened to list first.
 */
const VAULT_NAME = (process.env.VAULT_NAME ?? '').trim();

/** Who must be able to open this pool. PUBLIC keys only — see the header. */
const signersFile = (name: string) =>
  join(STATE_DIR, `vault-pool-signers-${assertVaultName(name)}.json`);

/*
 * THE ADDRESS IS A SECRET FROM THE MOMENT IT IS READ.
 *
 * Everything printed goes through `say`, which refuses a line carrying the
 * address or any eight-character window of it — the abbreviations a careful
 * person actually writes included. This instrument reads the address out of the
 * registry at stage 1, so the guard is armed before anything else prints.
 */
let vaultAddress: string | null = null;
const say = createScreen(() => (vaultAddress
  ? [{ what: "the vault's address", value: vaultAddress }]
  : []));
const clock = phaseClock(say);
const note = (s: string) => say(`  ${s}`);
const good = (s: string) => say(`  \x1b[32m✓\x1b[0m ${s}`);

/** The company's vaults on this network, or a refusal — never a guess. */
function vaultFromRegistry(name: string): VaultEntry {
  const file = vaultRegistryFile(STATE_DIR, NETWORK);
  if (!existsSync(file)) {
    throw new Error(
      `no vault has ever been deployed on ${NETWORK}: ${file.replace(ROOT + '/', '')} does not ` +
      'exist.\nA note pool is keyed by a vault\'s address, and there is no address until a vault ' +
      'exists. DEPLOY-VAULT.command is what creates one.');
  }
  const registry = parseVaultRegistry(JSON.parse(readFileSync(file, 'utf8')), NETWORK);
  const entry = registry.vaults[name];
  if (!entry) {
    const known = Object.keys(registry.vaults);
    throw new Error(
      `this company has no vault called "${name}" on ${NETWORK}.\n` +
      (known.length
        ? `The vaults it does have are: ${known.join(', ')}.`
        : 'It has none at all on this network.') +
      '\nA vault is named rather than addressed because a vault\'s address must never reach a ' +
      'screen (C236), and the registry is the only place the two are tied together.');
  }
  return entry;
}

/**
 * Who may open this pool, read from a file a person writes.
 *
 * **PUBLIC KEYS ONLY, AND THE REFUSAL SAYS SO.** A pool key is wrapped to a
 * signer's wrapping public key with `wrapKey` — the same machinery a payslip
 * travels through and the same machinery that delivers the viewing key itself
 * — so nothing here needs, wants or should be handed a secret. A file
 * containing one would be key material this instrument had no reason to read.
 *
 * **EVERY SIGNER WHO MIGHT RUN A PAYOUT MUST BE IN IT.** Whoever runs a payment
 * needs the pool, and `wrapFor` (`vault-pool.ts`) is how somebody is added
 * afterwards — which needs a signer who can ALREADY open it to be present. A
 * pool created for one person is a vault that freezes with their laptop.
 */
function poolSigners(name: string): PoolSigner[] {
  const file = signersFile(name);
  if (!existsSync(file)) {
    throw new Error(
      `no signer set has been written for the vault "${name}": ` +
      `${file.replace(ROOT + '/', '')} does not exist.\n\n` +
      'THE POOL IS SEALED UNDER A FRESH KEY WRAPPED TO EACH SIGNER, and `sealPool` refuses a\n' +
      'pool wrapped to nobody (V-91) — ciphertext with no key in the world would store,\n' +
      'replicate and back up perfectly while the money was gone.\n\n' +
      'RUN MAKE-TEST-SIGNERS.command. It asks which vault and how many signers, and writes\n' +
      'that file itself — PUBLIC KEYS ONLY, which is all this instrument wants: it wraps TO\n' +
      'them and can open nothing, and a secret in that file would be key material nothing\n' +
      'here has a reason to read.\n\n' +
      'THOSE ARE TEST KEYS. Both halves are made on one machine, which is right for a\n' +
      'stagenet vault nobody relies on and wrong for anything else; that door says so on\n' +
      'every line it prints.\n\n' +
      'PUT EVERY SIGNER WHO MIGHT RUN A PAYMENT IN IT. Whoever runs one needs the pool, and\n' +
      'adding somebody afterwards (wrapFor, src/midnight/vault-pool.ts) needs a signer who can\n' +
      'already open it. A pool created for one person is a vault that freezes with their\n' +
      'laptop, so take the count that door asks for seriously.');
  }
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `${file.replace(ROOT + '/', '')} holds no signers. A pool wrapped to nobody is ciphertext ` +
      'with no key in the world, and sealPool refuses it (V-91).');
  }
  return raw.map((s: any, i: number) => {
    const id = String(s?.id ?? '').trim();
    const wrappingPublicKey = String(s?.wrappingPublicKey ?? '').trim().toLowerCase();
    if (!id) throw new Error(`signer ${i + 1} in that file has no id`);
    if (!/^[0-9a-f]{64}$/.test(wrappingPublicKey)) {
      throw new Error(
        `signer "${id}" has no usable wrappingPublicKey (64 hex characters). A pool wrapped to a ` +
        'key nobody holds the secret for is one that signer can never open, and nothing would ' +
        'say so until they tried to make a payment.');
    }
    if (/^[0-9a-f]{64}$/.test(String(s?.wrappingSecret ?? ''))) {
      /*
       * REFUSED RATHER THAN IGNORED. A secret in this file is key material in a
       * place nothing needs it, and a file that "works either way" is one that
       * quietly accumulates secrets it never uses.
       */
      throw new Error(
        `signer "${id}" carries a wrappingSecret. This instrument wraps TO public keys and ` +
        'opens nothing; remove it. A secret kept where it is not needed is a secret that gets ' +
        'copied, logged and backed up for no benefit.');
    }
    return { id, wrappingPublicKey };
  });
}

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

async function main() {
  say('────────────────────────────────────────────────────────────');
  say(`  Opening a vault's note pool on ${NETWORK}  —  C242`);
  say('────────────────────────────────────────────────────────────');
  say();
  say('  Nothing is deployed, submitted or spent. One contract state is READ');
  say('  and one local file is written.');

  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

  /* -------------------------------------------------- 1 */
  clock.begin(1, 4, 'Deciding which vault, and who will be able to open its pool');

  if (!VAULT_NAME) {
    throw new Error(
      'no vault name was given. OPEN-VAULT-POOL.command asks which vault and passes the ' +
      'answer here; reaching this means the question went unanswered.\n' +
      'There is deliberately no default: a default would open a pool for whichever vault the ' +
      'registry happened to list first, and a pool is the record of a vault\'s money.');
  }
  assertVaultName(VAULT_NAME);
  const entry = vaultFromRegistry(VAULT_NAME);
  vaultAddress = entry.contractAddress;
  good(`vault "${VAULT_NAME}", deployed ${entry.deployedAt}`);
  note('  its address is NOT printed, here or anywhere — C236');

  const signers = poolSigners(VAULT_NAME);
  good(`${signers.length} signer(s) will be able to open this pool: ${signers.map(s => s.id).join(', ')}`);
  if (signers.length === 1) {
    note('  ONE SIGNER. Whoever runs a payment needs this pool, so a vault whose pool is');
    note('  wrapped to one person freezes with that person\'s laptop. Adding somebody later');
    note('  needs a signer who can already open it (wrapFor). Consider more before funding.');
  }

  const poolFile = vaultPoolFile(STATE_DIR, NETWORK, VAULT_NAME);
  if (existsSync(poolFile)) {
    /*
     * REFUSED HERE AS WELL AS IN THE STORE, and not as a duplicate: this one
     * arrives before the network, and `SealedNotePool.create`'s is the one that
     * matters because it is the one no caller can skip.
     */
    throw new Error(
      `this vault already has a note pool: ${poolFile.replace(ROOT + '/', '')}.\n` +
      'Creating a second would replace the record of every note it holds with whatever this ' +
      'run happened to know about, which is nothing. If that file cannot be read, that is not ' +
      'the same event and the answer is not to replace it: rebuild from the chain and the ' +
      'payment history with replayVault (src/midnight/vault-recovery.ts).');
  }
  good(`no pool exists yet — it will be written to ${poolFile.replace(ROOT + '/', '')}`);

  /* -------------------------------------------------- 2 */
  clock.begin(2, 4, 'Setting the network id');
  await applyNetworkId(NETWORK);
  good(`network id is the string "${NETWORK}"`);

  /* -------------------------------------------------- 3 */
  clock.begin(3, 4, 'Asking the chain what this vault already holds');
  note('THE POINT OF THIS STAGE: an empty pool is a CLAIM that the vault has no money.');
  note('A vault whose pool record was lost looks exactly like a vault that never had one,');
  note('and only the chain can tell them apart. S6d.');

  /*
   * **THE INDEXER DIRECTLY, NOT THROUGH A TESTKIT ENVIRONMENT.**
   *
   * Every other instrument here starts one because it needs a wallet, a node
   * and a proof server. This needs a single GraphQL read. Starting an
   * environment would pull in a proof-server container this run has no use for
   * — and the standing rule is that the server on 6301 is left alone.
   *
   * The endpoints are `src/midnight/network.ts`'s, which is the one place they
   * are written down: a URL typed here would be a second copy of a value that
   * has already moved under this project once.
   */
  const endpoints = ENDPOINTS[NETWORK];
  if (!endpoints) {
    throw new Error(
      `no endpoints are known for the network "${NETWORK}", so the chain cannot be asked what ` +
      'this vault holds — and an empty pool must never be written without asking. ' +
      'src/midnight/network.ts is where they are declared.');
  }
  note(`indexer  ${endpoints.indexerUrl}`);

  /*
   * ONLY THE PUBLIC DATA PROVIDER. No wallet, no proof server, no proving
   * config — this run reads one contract state and never builds a transaction,
   * and a providers bundle carrying credentials it does not use is a bundle
   * somebody later reaches into.
   */
  const providers: any = {
    publicDataProvider: indexerPublicDataProvider(endpoints.indexerUrl, endpoints.indexerWsUrl),
  };

  /* -------------------------------------------------- 4 */
  clock.begin(4, 4, 'Writing the first pool, sealed and wrapped to every signer');

  const pool = new SealedNotePool(
    new FileSealedPoolStore(poolFile, entry.contractAddress),
    /*
     * **THIS INSTRUMENT IS NOBODY, AND THAT IS THE PROPERTY RATHER THAN A
     * WORKAROUND.** `SealedNotePool` takes an identity because a `NotePool` is
     * used by a process acting AS somebody — the operator running a payout —
     * and reading needs their secret. Creating does not: sealing wraps TO
     * public keys. The id below can open nothing, so if this file ever grew a
     * `load` the failure would be loud rather than silent.
     */
    { signerId: '(the pool opener, which can open nothing)', wrappingSecret: '00'.repeat(32) },
    async () => signers);

  const ledger = new VaultLedger(
    { networkId: NETWORK } as never, {} as never, async () => providers, {} as never,
    pool, VAULT_ARTEFACTS);

  await ledger.openPool(entry.contractAddress);

  good('the pool is open, sealed under a fresh key, wrapped to every signer above');
  say();
  say('  \x1b[1mWhat this vault can and cannot do now\x1b[0m');
  say('    IT CAN TAKE A DEPOSIT. The client refused every call before this, because');
  say('    SealedNotePool.load refuses an absent record rather than answering "empty" —');
  say('    those are opposite claims about a treasury and the refusal is correct.');
  say();
  say('    IT STILL CANNOT BE SENT MONEY. C236: funding a vault is a `deposit` CALL and');
  say('    never a transfer. A plain send to this vault\'s address is money on chain that');
  say('    nobody can ever spend, and no contract can refuse it — which is why the address');
  say('    is not printed above and why there is no "wire funds to this address" flow.');
  say();
  say('    THE POOL IS A CACHE AND NOT THE RECORD. The chain\'s note set is the record.');
  say('    If this file is lost, the answer is replayVault — never a second run of this,');
  say('    which would write an empty pool over a treasury. That is what stage 3 refuses.');
}

/* ------------------------------------------------------------------ *
 * the refusal, unabridged and bounded
 * ------------------------------------------------------------------ */

main().then(
  () => process.exit(0),
  (e) => {
    /*
     * NOT THROUGH THE SCREEN GUARD, for `deploy-vault.ts`'s reason: an error
     * thrown from inside the guard would be unprintable, and a report that
     * cannot print its own failure is worse than one that shows an address in a
     * stack trace on a run that did not finish.
     */
    /**
     * **REDACTED HERE, WHERE THE SUCCESS PATH REFUSES — AND THE DIFFERENCE IS
     * THE RULE, NOT AN EXCEPTION.**
     *
     * `createScreen` throws rather than redacting, for a good reason: a
     * redacted line is a line somebody wrote intending to show something,
     * silently altered, and a refusal is a defect found at the moment it is
     * written. **That argument inverts down here.** This block exists to print
     * a failure, it cannot go through a guard that throws, and the text it
     * prints is not ours — it is an error message and a whole-object
     * serialisation, neither of which any author chose line by line. A refusal
     * here would lose the failure; showing the address would be `C236`.
     *
     * So: every line printed after this point has the address replaced by a
     * marker. It is a string substitution and it cannot throw.
     *
     * **WHAT IT DOES NOT COVER, said rather than assumed:** an address this run
     * never read (there is none — the registry entry is the only one it
     * touches), and any value some line computes FROM the address. It is the
     * same limit `S6e` recorded for the guard: it protects what it is told to
     * protect, and it is not a general redactor.
     */
    const redact = (text: string): string => (vaultAddress
      ? text.split(vaultAddress).join('[the vault\x27s address, withheld — C236]')
      : text);
    const out = (text: string) => console.log(redact(text));

    out('');
    out(`\x1b[31m\x1b[1m  Failed during: ${clock.stage}\x1b[0m`);
    out(describeError(e, explainNodeError).split('\n').map((l) => '  ' + l).join('\n'));

    if (e instanceof VaultAlreadyHoldsNotes) {
      console.log();
      console.log('  \x1b[1mTHIS IS NOT A NEW VAULT, AND NOTHING WAS WRITTEN\x1b[0m');
      console.log('    The chain says this vault holds notes, so its pool record is MISSING');
      console.log('    rather than absent — and writing an empty one would claim a treasury that');
      console.log('    exists has no money in it. balance would report zero and every commitment');
      console.log('    on chain would read as unexplained.');
      console.log('    What rebuilds it is replayVault (src/midnight/vault-recovery.ts), from the');
      console.log('    chain and the payment history. It has no instrument yet — S6f names that.');
    }
    if (e instanceof VaultChainUnreadable) {
      console.log();
      console.log('  \x1b[1mTHE CHAIN COULD NOT BE READ, WHICH IS NOT THE CHAIN SAYING NO\x1b[0m');
      console.log('    C110: a transaction the node had finalised read as `not found` to the');
      console.log('    indexer 168ms later. A vault that reads as empty because we asked too');
      console.log('    early is one whose whole treasury would be claimed as nothing.');
      console.log('    NOTHING WAS WRITTEN. Run this again; if it persists, look at the indexer.');
    }

    clock.print('stopped');

    console.log();
    console.log('  \x1b[1mThe error object, whole — bounded, and it says what it dropped\x1b[0m');
    const serialised = serialiseWholeDetailed(e);
    out(serialised.text.split('\n').map((l) => '    ' + l).join('\n'));
    out('');
    for (const line of describeDropped(serialised.dropped)) out(`    ${line}`);

    console.log();
    console.log('  Nothing was deployed, submitted or spent.');
    process.exit(1);
  },
);

/* ------------------------------------------------------------------ *
 * THE `.command` THIS NEEDS, NAMED AND NOT WRITTEN
 * ------------------------------------------------------------------ */

/*
 * **`OPEN-VAULT-POOL.command`.** What that door must do, recorded here because
 * the door is what a person opens, and a run order naming
 * `npx tsx scripts/open-vault-pool.ts` is an instruction nobody at the machine
 * can follow.
 *
 * WHAT IT MUST PASS — exported, because this file reads the environment and
 * nothing else:
 *
 *     MIDNIGHT_NETWORK_ID   ACCEPTED AND NEVER DECIDING. The network is the one
 *                           this build is compiled for; naming a different one
 *                           here is refused, and naming none is the ordinary case.
 *     VAULT_NAME            the vault, by the name it was deployed under. NO
 *                           DEFAULT — the script refuses without it, and the
 *                           door must not invent one.
 *
 * WHAT IT MUST REFUSE, before running anything:
 *
 *   1. **`VAULT_NAME` unset.** The door prints what a vault name is and stops.
 *   2. **No `.midnight/<network>-vaults.json`.** No vault has been deployed, so
 *      there is no address a pool could be keyed by. Name
 *      `DEPLOY-VAULT.command`.
 *   3. **No `.midnight/vault-pool-signers-<name>.json`.** Name
 *      `MAKE-TEST-SIGNERS.command`, which writes it, and state the
 *      PUBLIC-KEYS-ONLY rule. Nobody is handed a shape to type.
 *   4. **A pool file already there.** Say that a second pool would replace the
 *      record of every note the vault holds, and that a pool which cannot be
 *      READ is a different event with a different answer (`replayVault`).
 *
 * WHAT IT MUST NOT DO:
 *
 *   · **Not touch the proof server.** This run needs none — no transaction is
 *     built. The server on 6301 is left alone.
 *   · **Not retry.** A second attempt after a refusal hides which one was real,
 *     and every refusal here is a decision rather than a flake.
 *   · **Not print the address.** Everything this script prints already goes
 *     through the screen guard; the door must not `cat` the registry or the
 *     pool file.
 *
 * WHAT IT MUST EXPORT AS A REPORT: `REPORT-VAULT-POOL.txt`, beside the other
 * `REPORT-*.txt` files, with the ANSI codes stripped — the same shape
 * `DEPLOY-VAULT.command` is specified to produce. The report is what says
 * afterwards that a vault became fundable, and when.
 */
