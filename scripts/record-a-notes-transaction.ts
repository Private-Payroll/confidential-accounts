/**
 * **RECORDS WHICH TRANSACTION CREATED A NOTE, SO THE NOTE CAN BE SPENT AGAIN.**
 *
 * A vault spends a shielded note by proving where the chain filed its
 * commitment. That place is assigned when the transaction is applied, so no
 * client can know it in advance and nothing the vault holds is a function of
 * it. It is therefore READ, from the events of the transaction that created the
 * note, at the moment of the spend.
 *
 * **A NOTE WHOSE POOL ENTRY DOES NOT SAY WHICH TRANSACTION THAT WAS IS MONEY
 * THAT CANNOT BE REACHED.** It is on chain, it is the vault's, and it is worth
 * what it is worth — and every payment that would spend it is refused, with a
 * message naming this repair. Before this existed the message named something
 * nobody could do.
 *
 * **NOTHING IS PROVED, SUBMITTED OR SPENT HERE, AND NO PROOF SERVER IS
 * TOUCHED.** The chain is read and one sealed file is rewritten. A run that
 * refuses costs nothing but the reading.
 *
 * **ONLY THE TRANSACTION IS WRITTEN, NEVER AN INDEX.** A spend reads the index
 * from that transaction's events when it spends, so a number stored here would
 * have no reader — and a stored number is one a later spend could be handed by
 * mistake. The index read during this run is shown, because seeing it is the
 * evidence that the repair worked, and then it is discarded.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import {
  indexerNoteEvents, recordCreatingTransaction,
  NoteIndexUnreadable, NoteIndexRefused, NoteIndexUnaskable,
} from '../src/midnight/note-index.js';
import { SealedNotePool, type PoolSigner } from '../src/midnight/vault-pool.js';
import { assertVaultName, vaultRegistryFile, parseVaultRegistry } from '../src/midnight/vault-record.js';
import { networkFromEnv, ENDPOINTS } from '../src/midnight/network.js';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type { Hex } from '../src/core/crypto.js';
import { FileSealedPoolStore, vaultPoolFile } from './vault-pool-file.js';
import { chooseOpener, assertNoSignerIsDropped } from './deposit-to-vault.js';
import { createScreen } from './deploy-report.js';
import { commitmentForNote } from '../src/midnight/vault-recovery.js';
import {
  transactionFromText, notesWithNoTransaction, theNoteNamed, assertReplacingIsMeant, NotUsable,
} from './note-transaction-rules.js';

const ROOT = process.cwd();
const STATE_DIR = join(ROOT, '.midnight');
const SIGNER_SECRETS = join(STATE_DIR, 'test-signer-keys.json');

const BOLD = '[1m'; const DIM = '[2m'; const OFF = '[0m';
const GREEN = '[32m'; const RED = '[31m';
/*
 * **NOTHING THIS DOOR PRINTS MAY CARRY THE VAULT'S ADDRESS, AND THE GUARD IS A
 * MECHANISM RATHER THAN CARE.** Every other door that holds an address installs
 * this, and the reason it is not left to whoever edits the file next is that a
 * promise to be careful is kept by nobody in particular. The address reaches
 * this process, so the screen is given it and refuses any line that carries it
 * -- a stack trace included.
 */
const forbidden: Array<{ what: string; value: string }> = [];
const say = createScreen(() => forbidden);
const good = (l: string) => say(`  ${GREEN}✓${OFF} ${l}`);
const note = (l: string) => say(`    ${DIM}${l}${OFF}`);
const step = (l: string) => { say(); say(`${BOLD}${l}${OFF}`); };

const ask = async (prompt: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(prompt)).trim(); } finally { rl.close(); }
};

const shorten = (h: string): string => `${h.slice(0, 16)}…`;

async function main(): Promise<number> {
  const network = networkFromEnv(process.env.MIDNIGHT_NETWORK_ID, 'stagenet');

  step('1 of 4  Which vault');
  const vaultName = (process.env.VAULT_NAME ?? await ask('  vault name: ')).trim();
  assertVaultName(vaultName);
  const registryFile = vaultRegistryFile(STATE_DIR, network);
  if (!existsSync(registryFile)) {
    throw new NotUsable(
      `${registryFile.replace(ROOT + '/', '')} does not exist, so this machine knows of no `
      + `vaults on ${network}.`);
  }
  const registry = parseVaultRegistry(JSON.parse(readFileSync(registryFile, 'utf8')), network);
  const entry = registry.vaults[vaultName];
  if (!entry) {
    throw new NotUsable(
      `there is no vault called "${vaultName}" on ${network}. This machine knows: `
      + `${Object.keys(registry.vaults).join(', ') || '(none)'}.`);
  }
  forbidden.push({ what: "the vault's address", value: entry.contractAddress });
  good(`vault "${vaultName}", deployed ${entry.deployedAt}. Its address is not printed.`);

  step('2 of 4  Opening the pool, which is the only record of what a note is');
  const poolFile = vaultPoolFile(STATE_DIR, network, vaultName);
  const store = new FileSealedPoolStore(poolFile, entry.contractAddress);
  const sealed = await store.get(entry.contractAddress);
  if (!sealed) {
    throw new NotUsable(
      `this vault has no note pool: ${poolFile.replace(ROOT + '/', '')} does not exist, so there `
      + 'is no note here to record a transaction against. Nothing on chain says what a note is, '
      + 'only that a commitment exists.');
  }
  const signersFile = join(STATE_DIR, `vault-pool-signers-${vaultName}.json`);
  if (!existsSync(signersFile) || !existsSync(SIGNER_SECRETS)) {
    throw new NotUsable(
      `${(existsSync(signersFile) ? SIGNER_SECRETS : signersFile).replace(ROOT + '/', '')} does `
      + 'not exist, so this machine cannot open the pool. A pool is sealed under a key wrapped '
      + 'to each signer, and opening it needs one signer’s own secret half.');
  }
  const signers = JSON.parse(readFileSync(signersFile, 'utf8')) as PoolSigner[];
  const secrets = JSON.parse(readFileSync(SIGNER_SECRETS, 'utf8'))?.signers ?? {};
  /*
   * **THIS DOOR REWRITES THE WHOLE POOL, SO IT CAN DROP A SIGNER, SO IT ASKS
   * FIRST.**
   *
   * A pool is not patched in place: a write seals it afresh under a new key and
   * wraps that key to the signers the SIGNERS FILE lists. Anyone the file has
   * stopped listing keeps no copy of the new key, and their access to the
   * record of the company's money ends -- silently, because the run that did it
   * succeeds. Opening the pool does not catch this: one matching signer is
   * enough to open it and enough to write it back narrower.
   *
   * The refusal is the same one the deposit door makes, for the same write,
   * because the danger is in the write and not in the errand.
   */
  assertNoSignerIsDropped(sealed.wrapped.map((w) => w.signerId), signers.map((s) => s.id));
  good(`the pool will be re-sealed to all ${signers.length} signer(s) it is wrapped for now`);
  const chosen = chooseOpener(sealed.wrapped.map((w) => w.signerId), signers, secrets);
  good(`opening the pool as "${chosen.id}" — its public half is the one the signers file publishes`);
  const pool = new SealedNotePool(
    store, { signerId: chosen.id, wrappingSecret: chosen.wrappingSecret }, async () => signers);

  const loaded = await pool.load(entry.contractAddress);
  const stranded = notesWithNoTransaction(loaded.notes);
  good(`the pool holds ${loaded.notes.length} note(s); ${stranded.length} record no transaction`);
  if (stranded.length === 0) {
    note('every note in this pool already records where to read its place from, so every one of');
    note('them can be spent. There is nothing here to repair.');
  } else {
    say();
    say(`  ${BOLD}These notes cannot be spent until their transaction is named:${OFF}`);
    for (const n of stranded) say(`      ${n.nonce.slice(0, 16)}…   ${n.value.toLocaleString()} of colour ${n.token.slice(0, 12)}…`);
  }

  step('3 of 4  Which note, and which transaction created it');
  const which = (process.env.NOTE_NONCE ?? await ask('  the first characters of the note’s nonce: ')).trim();
  const target = theNoteNamed(loaded.notes, which);
  assertReplacingIsMeant(target, (process.env.REPLACE_RECORDED ?? '').toLowerCase() === 'yes');
  good(`note ${target.nonce.slice(0, 16)}…, ${target.value.toLocaleString()} of colour ${target.token.slice(0, 12)}…`);

  say();
  note('The transaction that paid this note in. Either name the chain uses is taken:');
  note('a 32-byte hash, or the 33-byte identifier a deposit reports when it settles — which is');
  note('usually the one written down, and is not the one the pool records.');
  const typed = (process.env.CREATED_IN ?? await ask('  transaction: ')).trim();
  const transaction = transactionFromText(typed);
  good(`naming it by ${'hash' in transaction ? 'hash' : 'identifier'}`);

  step('4 of 4  Asking whether the vault still holds this note, then writing');

  const endpoints = ENDPOINTS[network];
  if (!endpoints) {
    throw new NotUsable(
      `this client holds no indexer address for ${network}, so the chain cannot be asked where `
      + 'it filed this note.');
  }
  const { indexerUrl } = endpoints;
  note(`indexer ${indexerUrl}`);

  /*
   * **A CREATING TRANSACTION IS IMMUTABLE HISTORY, AND THAT IS WHY THIS CHECK
   * EXISTS.**
   *
   * The events of the transaction that created a note say what they say
   * forever. Spending the note does not change them: the contract removes the
   * commitment from its own set, and the output event that put it there is
   * still on chain and still readable. So the question this door would
   * otherwise ask -- *did this transaction create this note* -- is answered YES
   * for a note the vault has ALREADY SPENT.
   *
   * **AND THE STATE THIS DOOR IS REACHED FROM IS EXACTLY THE STATE THAT
   * PRODUCES ONE.** A payment that landed while the pool write failed leaves a
   * pool still listing a note the chain no longer holds. Every later payment is
   * then refused -- for free, before any fee, naming this repair. Without the
   * check below this door would answer that refusal by recording a transaction,
   * printing an index, and saying the note can be spent; the next payroll would
   * then raise a proposal, gather approvals, pay for a proof, and die inside
   * the circuit on a note the vault does not have.
   *
   * **SO THE CHAIN IS ASKED WHETHER IT STILL HOLDS THIS NOTE, AND A DOOR THAT
   * CANNOT ASK DOES NOT WRITE.** Three answers and not two: held, gone, or
   * unreadable. An unreadable vault is not an empty one.
   */
  const providers = indexerPublicDataProvider(endpoints.indexerUrl, endpoints.indexerWsUrl);
  let onChain: { member(c: Uint8Array): boolean; size(): bigint };
  try {
    const state: any = await providers.queryContractState(entry.contractAddress);
    if (!state) {
      throw new NotUsable(
        'the indexer returned no state for this vault. **That is not a vault holding nothing** '
        + '-- a state the node has finalised can read as absent for a moment afterwards, and an '
        + 'address nothing was deployed at answers the same way. Nothing is written from an '
        + 'answer that could be either. Read again shortly.');
    }
    const { ledger: readVault } = await import('../contracts/managed-vault/contract/index.js');
    const parsed: any = readVault(state.data);
    if (parsed?.notes == null || typeof parsed.notes.member !== 'function') {
      throw new NotUsable(
        'the vault\u2019s state decoded without a readable note set. A set the reader did not '
        + 'hand over is not an empty one, and nothing is written from the difference.');
    }
    onChain = parsed.notes;
  } catch (cause) {
    if (cause instanceof NotUsable) throw cause;
    throw new NotUsable(
      `the vault\u2019s own note set could not be read (${(cause as Error)?.message ?? String(cause)}). `
      + 'Nothing is written. This says nothing about the note: it is the read that failed.');
  }

  const { pureCircuits } = await import('../contracts/managed-vault/contract/index.js');
  const held = commitmentForNote(pureCircuits as never, entry.contractAddress as Hex, {
    nonce: target.nonce as Hex, token: target.token as Hex, value: target.value,
  });
  if (!onChain.member(Uint8Array.from(Buffer.from(held.replace(/^0x/, ''), 'hex')))) {
    throw new NotUsable(
      `the chain no longer holds this note. It is in this vault\u2019s pool and it is NOT in the `
      + `vault\u2019s own note set on chain, which is what a note that has already been SPENT `
      + 'looks like from here.\n'
      + 'Recording a transaction against it would make an unspendable note look spendable, and '
      + 'the next payment would be proposed, approved and paid for before the circuit refused '
      + 'it. So nothing is written.\n'
      + 'The pool and the chain disagree, which is what a payment that landed while the pool '
      + 'write failed leaves behind. The pool has to be rebuilt from the chain\u2019s own history '
      + 'rather than repaired one note at a time.');
  }
  good(`the chain still holds this note, among the ${onChain.size()} this vault has`);

  say();
  note('Only now is the creating transaction read, and written.');
  note('The chain is asked for that transaction’s events. The note is recorded only if one of');
  note('them is an output carrying this note’s commitment, owned by this vault.');
  const written = await recordCreatingTransaction(
    pool, entry.contractAddress as Hex, target.nonce as Hex, indexerNoteEvents(indexerUrl), transaction);

  say();
  good(`recorded: note ${target.nonce.slice(0, 16)}… was created by transaction ${shorten(written.createdIn)}`);
  if (written.previously !== undefined) {
    good(`it previously recorded ${shorten(written.previously)}, which the chain contradicts`);
  }
  say();
  say(`  ${BOLD}THE CHAIN FILED THIS NOTE AT INDEX ${written.index}.${OFF}`);
  note('That number is NOT written down. It is shown because reading it is the evidence that');
  note('this note can now be spent; a payment reads it again, from the chain, when it spends.');
  say();
  say(`  ${GREEN}${BOLD}This note can be spent. Nothing was proved, submitted or spent to establish it.${OFF}`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e: unknown) => {
  say();
  if (e instanceof NotUsable || e instanceof NoteIndexRefused || e instanceof NoteIndexUnreadable
    || e instanceof NoteIndexUnaskable) {
    say(`  ${RED}${BOLD}Nothing was written.${OFF}`);
    say();
    say(`  ${(e as Error).message}`);
    if (e instanceof NoteIndexUnreadable) {
      say();
      note('This is the chain not answering, which is not the chain saying no. Reading again');
      note('later may answer. Nothing about the note has been decided.');
    }
    if (e instanceof NoteIndexUnaskable) {
      say();
      note('This is not the chain being slow and it is not the chain saying no. This machine');
      note('asked the indexer for something it does not have, so READING AGAIN WILL NOT ANSWER:');
      note('it is the two of them out of step, and one of them has to move. Nothing about the');
      note('note has been decided, and the note is exactly where it was.');
    }
    process.exit(1);
  }
  say(`  ${RED}${BOLD}This run stopped, and nothing was written.${OFF}`);
  say();
  say(`  ${(e as Error)?.stack ?? String(e)}`);
  process.exit(1);
});
