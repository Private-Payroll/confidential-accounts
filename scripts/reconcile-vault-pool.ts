/**
 * **REBUILDS A VAULT'S NOTE POOL FROM THE CHAIN AND EVERY VERSION THE POOL HAS
 * BEEN WRITTEN AT.**
 *
 * A vault's note pool is the only thing that can say what a note IS. The chain
 * publishes commitments, and a commitment discloses nothing and cannot be
 * inverted. So when a write to the pool is lost -- a process stopped between the
 * transaction and the write -- the money is on chain and this machine cannot name
 * it, and every payment that would reach it is refused.
 *
 * **UNTIL THIS DOOR EXISTED, FOURTEEN REFUSALS ON THE MONEY PATH NAMED A REMEDY
 * NOBODY COULD CARRY OUT.** They all said to rebuild the pool with `replayVault`,
 * which needs a history of the vault's events that nothing in this repository
 * produces. This is the route that needs none: the pool's versions are filed one
 * per write rather than overwriting each other, so the union of them is every note
 * this pool has ever believed in. That union is proposed to the chain, and the
 * chain chooses.
 *
 * ------------------------------------------------------------------------
 * **IT COSTS ONE CHAIN READ AND NOTHING ELSE IS SPENT.** Nothing is proved,
 * submitted, deployed or spent, and no proof server is touched. A run that
 * refuses has cost the reading. So it is safe to run this to find out whether
 * there is anything wrong, which is the point: a door somebody is afraid of is a
 * door they run too late.
 *
 * **WHAT IT CANNOT DO, SAID HERE RATHER THAN DISCOVERED.** A note that was never
 * written to any version of the pool is not proposed, so it comes back as a
 * commitment nothing explains rather than as money. That is the change note of a
 * payment whose write was lost: its nonce is derivable from the note that was
 * spent and its colour is that note's colour, but its VALUE is the spent value
 * minus an amount only the payment knew. **Nothing here guesses at it.**
 *
 * **AND IT NEVER WRITES AN EMPTY POOL.** A rebuild that could explain none of the
 * notes the chain holds is this machine's ignorance, and an empty pool is a claim
 * that the vault has no money -- indistinguishable afterwards from the truth.
 * `reconcile-vault-pool-rules.ts` refuses that case, and every decision this door
 * makes lives in that file so it can be measured without running this one.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { SealedNotePool, type PoolSigner } from '../src/midnight/vault-pool.js';
import { openPool } from '../src/midnight/vault-pool.js';
import {
  vaultRegistryFile, parseVaultRegistry, theVault, theVaultNameMeant,
} from '../src/midnight/vault-record.js';
import { assertVaultLedgerIsThisBuilds } from '../src/midnight/vault-ledger-shape.js';
import { theNetwork, ENDPOINTS } from '../src/midnight/network.js';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type { Hex } from '../src/core/crypto.js';
import { reconcileVaultPool } from '../src/midnight/vault-recovery.js';
import { FileSealedPoolStore, vaultPoolFile, everyVersionFiled } from './vault-pool-file.js';
import { chooseOpener } from './deposit-to-vault.js';
import { createScreen } from './deploy-report.js';
import { NotUsable } from './note-transaction-rules.js';
import {
  decideWhetherToWrite, assertNoSignerWouldLoseAccess,
  assertThePoolHasNotMovedSinceTheRebuild, linesForAnOperator,
} from './reconcile-vault-pool-rules.js';

const ROOT = process.cwd();
const STATE_DIR = join(ROOT, '.midnight');
const SIGNER_SECRETS = join(STATE_DIR, 'test-signer-keys.json');

const BOLD = '\x1b[1m'; const DIM = '\x1b[2m'; const OFF = '\x1b[0m';
const GREEN = '\x1b[32m'; const RED = '\x1b[31m'; const YELLOW = '\x1b[33m';

/*
 * **NOTHING THIS DOOR PRINTS MAY CARRY THE VAULT'S ADDRESS, AND THE GUARD IS A
 * MECHANISM RATHER THAN CARE.** `C236`. The address reaches this process, so the
 * screen is given it and refuses any line that carries it, a stack trace
 * included. A promise to be careful is kept by nobody in particular.
 */
const forbidden: Array<{ what: string; value: string }> = [];
const say = createScreen(() => forbidden);
const good = (l: string) => say(`  ${GREEN}✓${OFF} ${l}`);
const note = (l: string) => say(`    ${DIM}${l}${OFF}`);
const warn = (l: string) => say(`  ${YELLOW}!${OFF} ${l}`);
const step = (l: string) => { say(); say(`${BOLD}${l}${OFF}`); };

const ask = async (prompt: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(prompt)).trim(); } finally { rl.close(); }
};

async function main(): Promise<number> {
  const network = theNetwork();

  step('1 of 5  Which vault');
  const registryFile = vaultRegistryFile(STATE_DIR, network);
  if (!existsSync(registryFile)) {
    throw new NotUsable(
      `${registryFile.replace(ROOT + '/', '')} does not exist, so this machine knows of no `
      + `vaults on ${network}.`);
  }
  const registry = parseVaultRegistry(JSON.parse(readFileSync(registryFile, 'utf8')), network);
  const asked = ((process.env.VAULT_NAME ?? '').trim() || await ask(
    registry.current === undefined
      ? '  vault name: '
      : `  vault name (blank for "${registry.current}", the live one): `)).trim();
  const vaultName = theVaultNameMeant(registry, asked);
  /*
   * **A DISPOSED VAULT IS REFUSED BEFORE THE CHAIN IS ASKED**, and the refusal is
   * not written here or in this door's rules file: it is inside the lookup that
   * turns a name into an entry, which is the one act this door has in common with
   * every other door that touches a vault.
   *
   * **THIS DOOR IS THE ONE THAT WOULD DO THE MOST DAMAGE WITH THE WRONG ANSWER,
   * WHICH IS WHY IT REFUSED FIRST AND ALONE FOR A WHILE.** A vault read off the
   * wrong field hands back a note set that is not its note set -- against which
   * every note this pool holds is STALE and every commitment UNEXPLAINED -- and
   * this door's whole purpose is to write the pool that follows from that
   * comparison. It would offer to write an emptier pool than it started from,
   * about a vault it was reading wrongly.
   */
  const entry = theVault(registry, vaultName);
  forbidden.push({ what: "the vault's address", value: entry.contractAddress });
  good(`vault "${vaultName}", deployed ${entry.deployedAt}. Its address is not printed.`);
  if (registry.current !== undefined && registry.current !== vaultName) {
    warn(`this is not the vault recorded as live on ${network}, which is "${registry.current}"`);
  }

  step('2 of 5  Every version this pool has been written at');
  const poolFile = vaultPoolFile(STATE_DIR, network, vaultName);
  const filed = everyVersionFiled(poolFile, entry.contractAddress);
  if (filed.length === 0) {
    throw new NotUsable(
      `this machine holds no version of this vault's pool: ${poolFile.replace(ROOT + '/', '')} and `
      + 'its numbered versions are all absent. **That is not a vault holding nothing.** A rebuild '
      + 'proposes notes to the chain and there is nothing here to propose, so nothing can be '
      + 'reconciled -- a commitment cannot be inverted, and no rebuild can invent what a note is '
      + 'worth. Restore a pool file from a backup first.');
  }
  good(`${filed.length} version(s) filed: ${filed.map((f) => `v${f.version}`).join(' ')}`);

  const signersFile = join(STATE_DIR, `vault-pool-signers-${vaultName}.json`);
  if (!existsSync(signersFile) || !existsSync(SIGNER_SECRETS)) {
    throw new NotUsable(
      `${(existsSync(signersFile) ? SIGNER_SECRETS : signersFile).replace(ROOT + '/', '')} does `
      + 'not exist, so this machine cannot open the pool. A pool is sealed under a key wrapped to '
      + 'each signer, and opening one needs a signer’s own secret half.');
  }
  const signers = JSON.parse(readFileSync(signersFile, 'utf8')) as PoolSigner[];
  const secrets = JSON.parse(readFileSync(SIGNER_SECRETS, 'utf8'))?.signers ?? {};

  /*
   * **THE WRITE THIS DOOR MAKES RE-SEALS THE WHOLE POOL, SO IT CAN TAKE AWAY A
   * SIGNER'S ACCESS, SO IT ASKS FIRST.** The same refusal the deposit door and the
   * repair door make, for the same write: anybody the signers file has stopped
   * listing keeps no copy of the new key, and the run that did it SUCCEEDS.
   */
  const newest = filed[filed.length - 1]!;
  assertNoSignerWouldLoseAccess(
    newest.sealed.wrapped.map((w) => w.signerId), signers.map((s) => s.id));
  good(`the pool would be re-sealed to all ${signers.length} signer(s) it is wrapped for now`);

  const chosen = chooseOpener(newest.sealed.wrapped.map((w) => w.signerId), signers, secrets);
  good(`opening every version as "${chosen.id}"`);
  const versions = filed.map((f) => ({
    version: f.version,
    notes: openPool(f.sealed, chosen.id, chosen.wrappingSecret).notes,
  }));
  const everFiled = new Set(versions.flatMap((v) => v.notes.map((n) => n.nonce)));
  note(`the newest version holds ${newest.sealed.version === versions[versions.length - 1]!.version
    ? versions[versions.length - 1]!.notes.length : '?'} note(s)`);
  note(`across every version, ${everFiled.size} distinct note(s) have ever been filed`);

  step('3 of 5  What the chain says this vault holds');
  const endpoints = ENDPOINTS[network];
  if (!endpoints) {
    throw new NotUsable(
      `this client holds no indexer address for ${network}, so the chain cannot be asked which `
      + 'notes this vault holds.');
  }
  note(`indexer ${endpoints.indexerUrl}`);
  const providers = indexerPublicDataProvider(endpoints.indexerUrl, endpoints.indexerWsUrl);
  let chain: Hex[];
  try {
    const state: any = await providers.queryContractState(entry.contractAddress);
    if (!state) {
      throw new NotUsable(
        'the indexer returned no state for this vault. **That is not a vault holding nothing** -- '
        + 'a state the node has finalised can read as absent for a moment afterwards, and an '
        + 'address nothing was deployed at answers the same way. Nothing is written from an answer '
        + 'that could be either. Read again shortly.');
    }
    /*
     * **THE SAME LEDGER-SHAPE CHECK EVERY OTHER VAULT READ MAKES, AND THIS DOOR
     * NEEDS IT MOST.** `assertVaultLedgerIsThisBuilds` compares the deployed
     * vault's field layout against what this build compiles, because a client
     * reads those fields by COUNTING -- so a vault one field short reads as a
     * different vault entirely, and the note set is the field this door acts on.
     * `C465` is that, measured on a live vault. The disposed flag above is a
     * record somebody wrote; this is the mechanism, and it holds for a vault
     * nobody has got round to marking.
     */
    await assertVaultLedgerIsThisBuilds(state);
    const { ledger: readVault } = await import('../contracts/managed-vault/contract/index.js');
    const parsed: any = readVault(state.data);
    if (parsed?.notes == null || typeof parsed.notes[Symbol.iterator] !== 'function') {
      throw new NotUsable(
        'the vault’s state decoded without a readable note set. A set the reader did not hand '
        + 'over is not an empty one, and nothing is written from the difference.');
    }
    chain = [...parsed.notes].map((c: Uint8Array) => Buffer.from(c).toString('hex') as Hex);
  } catch (cause) {
    if (cause instanceof NotUsable) throw cause;
    throw new NotUsable(
      `the vault’s own note set could not be read (${(cause as Error)?.message ?? String(cause)}). `
      + 'Nothing is written. This says nothing about the money: it is the read that failed.');
  }
  good(`the chain holds ${chain.length} note(s) for this vault`);

  step('4 of 5  The rebuild');
  const { pureCircuits } = await import('../contracts/managed-vault/contract/index.js');
  const rebuilt = reconcileVaultPool({
    vault: entry.contractAddress as Hex,
    chain,
    versions,
    circuits: pureCircuits as never,
  });
  say();
  for (const line of linesForAnOperator(rebuilt)) say(`  ${line}`);

  step('5 of 5  Whether anything is written');
  /*
   * **ADDING IS THE RECOVERY AND REMOVING IS A CONVENIENCE, SO REMOVING IS
   * OPT-IN.** An audit of this round found the sequence: a payment settles and has
   * not yet written its change note; this door reads the chain, sees the spent
   * note gone, files a pool without it; the payment then cannot find the note it
   * spent and refuses -- and that refusal is not a lost race, so nothing retries
   * it. The change note is then in no version of the pool and never will be.
   */
  const alsoDropStaleNotes = (process.env.ALSO_DROP_NOTES_THE_CHAIN_DOES_NOT_HOLD ?? '').toLowerCase() === 'yes';
  const newestClaims = versions[versions.length - 1]!.notes.length;
  const decision = decideWhetherToWrite({
    recovery: rebuilt, notesTheNewestVersionClaims: newestClaims, alsoDropStaleNotes,
  });
  if (decision.do === 'refuse') {
    say();
    say(`  ${RED}${BOLD}Nothing is written.${OFF}`);
    say();
    say(`  ${decision.why}`);
    return 1;
  }
  if (decision.do === 'nothing') {
    say();
    good(decision.why);
    say(`  ${GREEN}${BOLD}Nothing needed writing. Nothing was proved, submitted or spent.${OFF}`);
    return 0;
  }

  say();
  warn(decision.why);
  if (decision.unexplained > 0) {
    warn(`and ${decision.unexplained} note(s) the chain holds stay unnameable by this machine, `
      + 'which this write does not change');
  }
  /*
   * **THE CONFIRMATION IS AN ENVIRONMENT VARIABLE AND THE REFUSAL NAMES IT.**
   * Rule 19. A door that refuses without saying what unlocks it is a door somebody
   * works around, and the way round this one is editing a sealed file by hand.
   */
  const meant = (process.env.WRITE_THE_REBUILT_POOL ?? '').toLowerCase() === 'yes';
  if (!meant) {
    say();
    say(`  ${RED}${BOLD}Nothing is written.${OFF}`);
    say();
    say('  This would replace the record of what this vault holds. Nothing on chain changes and');
    say('  nothing is spent, but every earlier version stays filed, so the write is answerable.');
    say(`  Run this again with ${BOLD}WRITE_THE_REBUILT_POOL=yes${OFF} to write it.`);
    return 1;
  }

  /*
   * **A REBUILD IS NOT A DIFFERENCE, SO IT CANNOT BE RE-APPLIED.** Every other
   * writer of this pool records a change -- one note added, one spent and its
   * change kept -- and a change can be applied again to a pool that has moved.
   * This replaces the whole record, so if another writer filed a version while the
   * chain was being read, the only correct answer is to read again.
   */
  const store = new FileSealedPoolStore(poolFile, entry.contractAddress);
  const storedNow = await store.get(entry.contractAddress);
  assertThePoolHasNotMovedSinceTheRebuild(newest.version, storedNow?.version ?? -1);

  const pool = new SealedNotePool(
    store, { signerId: chosen.id, wrappingSecret: chosen.wrappingSecret }, async () => signers);
  /*
   * **WHAT IS WRITTEN, AND WHY IT IS A UNION RATHER THAN A REPLACEMENT.**
   *
   * Additively: everything the newest version claimed, plus every note the chain
   * holds that the pool had lost. A note the chain does not hold stays -- it is
   * refused at the spend, before any money moves, which is a cost and not a loss,
   * and removing it can strand the change note of a payment in flight.
   *
   * With `ALSO_DROP_NOTES_THE_CHAIN_DOES_NOT_HOLD=yes`: exactly what the chain
   * holds and this machine can name. The index is not written by either -- a spend
   * reads a note's place in the commitment tree from the chain at the moment it
   * spends, so a number stored here has no reader that should trust it.
   */
  const bare = ({ commitment: _onChain, index: _readAtTheSpend, ...note }: typeof rebuilt.held[number]) => note;
  const byNonce = new Map<string, ReturnType<typeof bare>>();
  if (!alsoDropStaleNotes) {
    for (const n of versions[versions.length - 1]!.notes) byNonce.set(n.nonce, { ...n });
  }
  for (const n of rebuilt.held) byNonce.set(n.nonce, bare(n));
  await pool.save(
    entry.contractAddress,
    { notes: [...byNonce.values()] },
    { vault: entry.contractAddress, version: newest.version });

  say();
  good(`written as version ${newest.version + 1}. Every earlier version is still filed.`);
  say(`  ${GREEN}${BOLD}The pool is the chain's pool. Nothing was proved, submitted or spent.${OFF}`);
  if (rebuilt.unexplained.length > 0) {
    say();
    warn(`${rebuilt.unexplained.length} note(s) the chain holds are still unnameable by this `
      + 'machine. They are listed above, and what names one is whoever created it.');
  }
  return 0;
}

main().then((c) => process.exit(c)).catch((e: unknown) => {
  say();
  if (e instanceof NotUsable) {
    say(`  ${RED}${BOLD}Nothing was written.${OFF}`);
    say();
    say((e as Error).message);
    process.exit(1);
  }
  say(`  ${RED}${BOLD}Nothing was written.${OFF}`);
  say();
  say(String((e as Error)?.message ?? e));
  process.exit(1);
});
