/**
 * **THE ATTEMPT JOURNALS, ON DISK: WHAT A DOOR WROTE DOWN BEFORE IT MOVED A
 * VAULT'S MONEY, AND HOW A REBUILD READS IT BACK.**
 *
 * A vault's pool is written AFTER the transaction, because the other order
 * leaves a pool claiming a note the chain never made. So between the call
 * landing and the pool write there is a window in which the chain holds a note
 * this machine has not yet named -- and a commitment discloses nothing, so a
 * process that stops in that window has lost the name for good unless it was
 * written down FIRST.
 *
 * Two doors move a vault's private money and each writes one line before its
 * call:
 *
 *   · **a deposit** writes the whole coin it is about to make.
 *     `VaultLedger.deposit` records it through the `DepositJournal` interface,
 *     and `SealedDepositJournal` below is the implementation the deposit door
 *     hands it. The door used to write this line in its own code, so the
 *     guarantee lasted as long as every caller remembered; the file and its
 *     shape are unchanged, so every line already on disk still reads.
 *   · **a payment** writes the note it is about to spend, whole, and the amount
 *     leaving it. `VaultLedger.payPrivately` records it through the
 *     `PaymentJournal` interface, and `SealedPaymentJournal` below is the
 *     implementation the payment door hands it.
 *
 * **A WRITE NEVER TAKES A READER AWAY.** Each write re-seals the whole journal
 * to the signers it is told about. A signer the journal is wrapped for and that
 * list has stopped naming would keep no copy of the new key, and the write would
 * succeed; so a write that would do that is refused, the same way a pool write
 * is.
 *
 * **A JOURNAL IS NOT A POOL AND MUST NEVER BE READ AS ONE.** The pool is a
 * claim about what the vault HOLDS; a journal is a record of what was
 * ATTEMPTED. A line for a call that never landed is correct and harmless: the
 * rebuild proposes it to the chain and the chain does not hold it. A pool
 * entry for the same call is the unrecoverable direction.
 *
 * **SEALED TO THE SAME SIGNERS AS THE POOL, BECAUSE IT CARRIES WHAT THE POOL
 * CARRIES** -- a nonce, a colour and a value. A plaintext journal beside a
 * sealed pool publishes exactly what the pool exists to protect. So each
 * journal is a `SealedPool` record in a `FileSealedPoolStore`, filed one
 * version per write like the pool, which is also what makes reading it back
 * a union over every version rather than a trust in the newest: a version
 * whose write raced another and lost is still on disk and still counts.
 *
 * **THE JOURNAL ITSELF IS `PaymentJournalInStore` AND `DepositJournalInStore`,
 * AND THIS FILE ONLY SAYS WHERE ON DISK THEY ARE KEPT.** The product keeps the same journal in its
 * database, and a journal whose rules lived here would be a guarantee only the
 * doors had. What stays here is the file names and the file store.
 *
 * **ONE FILE PER JOURNAL, NOT ONE FILE WITH TWO SHAPES.** The deposit journal's
 * lines are coins and were written before there was a second kind; a payment's
 * line is a different shape. A shared file would need a discriminator the
 * existing lines do not carry, and a reader guessing the shape of a line that
 * lacks one is a reader that can read a payment as a deposit -- proposing the
 * spent note as a coin the vault made, which it did not.
 */
import { join } from 'node:path';

import type { PoolSigner } from '../src/midnight/vault-pool.js';
import {
  PaymentJournalInStore, DepositJournalInStore, attemptsFromJournalVersions, type JournalOpener,
} from '../src/midnight/vault-journal.js';
import type { AttemptedVaultCalls } from '../src/midnight/vault-recovery.js';
import type { DepositNonceKey } from '../src/midnight/deposit-nonce.js';
import { assertVaultName } from '../src/midnight/vault-record.js';
import { FileSealedPoolStore, everyVersionFiled } from './vault-pool-file.js';

export type { JournalOpener } from '../src/midnight/vault-journal.js';

/** Where a vault's payment journal lives. Named after the vault, never addressed by it. */
export const paymentJournalFile = (stateDir: string, network: string, name: string): string =>
  join(stateDir, `${network}-vault-payment-journal-${assertVaultName(name)}.json`);

/**
 * Where a vault's deposit journal lives. The deposit door defines the same
 * name in its own file; it is repeated here rather than imported because a
 * rebuild that imports a door imports the door's whole module, and this one
 * has to stay importable by a test that runs no door.
 */
export const depositJournalFileOf = (stateDir: string, network: string, name: string): string =>
  join(stateDir, `${network}-vault-deposit-journal-${assertVaultName(name)}.json`);

/** **THE PAYMENT JOURNAL A DOOR HANDS `VaultLedger`**, kept in its file. */
export class SealedPaymentJournal extends PaymentJournalInStore {
  constructor(
    file: string,
    vault: string,
    me: JournalOpener,
    /** Everybody who must be able to open what this writes: the pool's signers. */
    signers: () => Promise<readonly PoolSigner[]>,
  ) {
    super(new FileSealedPoolStore(file, vault), vault, me, signers);
  }
}

/**
 * **THE DEPOSIT JOURNAL A DOOR HANDS `VaultLedger`**, kept in the same file, under
 * the same name and page the deposit door has always written, so every line
 * already on disk is read by the same reader. Lines written before nonces were
 * derived keep the random nonces they recorded, and are read exactly as before.
 */
export class SealedDepositJournal extends DepositJournalInStore {
  constructor(
    file: string,
    vault: string,
    me: JournalOpener,
    /** Everybody who must be able to open what this writes: the pool's signers. */
    signers: () => Promise<readonly PoolSigner[]>,
    /** The key this vault's deposit nonces are derived from. */
    nonces: DepositNonceKey,
    /** Called once the line is on disk, before the ledger calls the contract. */
    written: () => void = () => {},
  ) {
    super(new FileSealedPoolStore(file, vault), vault, me, signers, nonces, written);
  }
}

/**
 * **EVERYTHING THE JOURNALS ON THIS MACHINE SAY WAS ATTEMPTED AGAINST ONE
 * VAULT**, in the shape the rebuild takes. Every filed version of each journal
 * file is read; what is done with them is `attemptsFromJournalVersions`, the
 * same reader the product's store is read with.
 */
export const journalledAttempts = (input: {
  depositJournalFile: string;
  paymentJournalFile: string;
  vault: string;
  opener: JournalOpener;
}): AttemptedVaultCalls & { versionsRead: { deposits: number; payments: number } } =>
  attemptsFromJournalVersions({
    deposits: everyVersionFiled(input.depositJournalFile, input.vault),
    payments: everyVersionFiled(input.paymentJournalFile, input.vault),
    opener: input.opener,
    /* These files hold versions written before labels were sealed inside records. */
    unlabelled: 'accept',
  });
