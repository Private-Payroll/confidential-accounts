/**
 * **A VAULT'S SECRET RUN ON THIS DEVICE**, for its first secret and for one replacing it: raised (`secretRunRaisedHere`,
 * `raiseASecretRunHere`), approved (`secretRunApprovedHere`), its secret set (`secretSetHere`) and every signer's sealed
 * copy written (`everyCopyWritten`), each step only once the chain shows the one before, and the first secret's whole
 * run as a vault's start takes it (`secretStartedHere`).
 *
 * Who a secret is sealed to is one rule: the seats the company's directory believes, has not retired and the chain holds
 * now (`secretReaders.directory().readers`, from `readersIn`), checked reader by reader against each signer's own
 * wallet before anything is raised, approved or set (`everyReaderChecksOut`). A run raised before a signer was removed
 * is never approved or carried by this device; it is raised again. A replacement carries the last secret every copy
 * was written for (`earlier`), which this device finds among the secrets the company's records hold for the vault.
 */
import { type DirectoryAsBelieved, READER_REFUSAL, type SeatsAsTheWalletRead, readerRefusalOf } from '../../../src/midnight/secret-readers.js';
import { type FirstSecretShown, MOST_READER_NAME, MOST_SECRET_READERS } from 'midnight-identity/profile/request';
import { type Hex, toHex } from '../../../src/core/crypto.js';
import { type NonceSecretReader, openNonceSecrets, recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import type { RosterVaultKeys } from '../../../src/core/vault-keys.js';
import type { SealedPool } from '../../../src/midnight/vault-pool.js';
import type { SecretRunOnTheWire } from './vault-worker-client.js';
import { handedOver } from './hand-over.js';
import { ownCopyOpened, sealSecretCopy } from '../../../src/midnight/sealed-secret-copy.js';
import { startVaultNonceSecretAgainOnThisDevice } from './deposit-on-device.js';
import { removalsOnTheChainHere } from './removals-on-the-chain.js';
import { secretRunWindowFrom } from '../../../src/midnight/secret-run-window.js';
import type { CreateVaultDoors } from './vault-doors.js';
import { START_STOP, type VaultCreated, VaultStartOwed } from './vault-start-stops.js';
import { theVaultReadForItsStart } from './vault-read-here.js';
import { type RunSecret, type SecretReadBack, openCompanyVaultPool, openedHere, theChainWins } from './vault-pool-opened.js';
import {
  type StartStanding, ZERO_HEX, accountStep, approvedHere, asTheWalletReadIt, buildOrOwe, nothingMoves,
  proposedAndWrittenDown, sent, standingNow, startDoorsOf, untilTheChainShows,
} from './vault-start-steps.js';
import {
  FIRST_SECRET_SUMMARY, NEW_SECRET_SUMMARY, heldSecretsOf, runLive, landedOrSet, noOtherRunStanding, replacesNothing, secretRunRound,
  secretRunStillStanding, secretWrittenDown,
} from './vault-secret-run-record.js';

/** A run of the secret run as the account holds it, as a vault's start reads it. */
type RunOnChain = NonNullable<NonNullable<StartStanding['standing']['secret']>['run']>;

/** A run's window, as a read of the chain names it: the run read is then that one, whatever else the chain holds. */
type Window = { readonly opensAt: bigint; readonly closesAt: bigint };
const windowOf = (r: { readonly opensAt: string | bigint; readonly closesAt: string | bigint }): Window =>
  ({ opensAt: BigInt(r.opensAt), closesAt: BigInt(r.closesAt) });

/** How a step names the secret it sets. */
const named = (secret: RunSecret): string => (replacesNothing(secret.previous) ? 'its first secret' : 'its new secret');

/**
 * **WHO A VAULT'S SECRET IS SEALED TO NOW**: the records keys of the seats the company's directory believes, has not
 * retired and the chain holds (`readersIn`, as the wallet reads the directory for the reader check), never a list the
 * service hands over.
 */
export async function readersNow(doors: CreateVaultDoors, vault: Hex): Promise<readonly Hex[]> {
  let directory: DirectoryAsBelieved;
  try {
    directory = await doors.secretReaders.directory();
  } catch (e) {
    throw new VaultStartOwed(vault, `who its secret is sealed to could not be read (${(e as Error)?.message ?? e}). Nothing was sent.`, READER_REFUSAL.directoryUnread);
  }
  return directory.readers.map((k) => String(k).toLowerCase() as Hex);
}

/** What the builder makes the run again from, to check the proposal it proves is the one this device made. */
const madeOf = (vault: Hex, secret: RunSecret, r: { readonly opensAt: string; readonly closesAt: string }) => ({
  kind: 'vault-secret' as const, vault, secret: secret.secret, readers: [...secret.readers],
  ...(replacesNothing(secret.previous) ? {} : { previous: secret.previous }), opensAt: r.opensAt, closesAt: r.closesAt,
});

/**
 * The run's public copies tree kept in this signer's own wallet, before this device raises or approves it, so the copies
 * can be written from here whatever the service holds. Never the secret. A wallet that cannot keep it stops the step.
 */
async function runKeptHere(doors: CreateVaultDoors, vault: Hex, run: SecretRunOnTheWire): Promise<void> {
  if (doors.secretKeptHere?.keepRun === undefined) return;
  try {
    await doors.secretKeptHere.keepRun(vault, { vault: run.vault, commitment: run.commitment, copies: run.copies, previous: run.previous });
  } catch (e) {
    throw new VaultStartOwed(vault, `this wallet could not keep the run's sealed copies (${(e as Error)?.message ?? e}), so it was neither `
      + 'raised nor approved. Nothing was sent.');
  }
}

/** Every signer's sealed copy of the vault's secret written, one call each, and the vault read started once the last is. */
export async function everyCopyWritten(
  doors: CreateVaultDoors, vault: Hex, from: StartStanding, run: SecretRunOnTheWire, secret: RunSecret,
): Promise<StartStanding> {
  let at = from;
  doors.progress?.('writing the sealed copies');
  for (let place = 0; place < run.copies.length; place += 1) {
    if (at.standing.secret!.written[place] === true) continue;
    const { tx } = await buildOrOwe(vault, 'writing a sealed copy of its secret', () => doors.builder.writeSecretCopy({
      vault, run, place, state: at.chain.vaultState, parameters: at.chain.parameters,
    }));
    await sent(vault, 'writing a sealed copy of its secret', () => handedOver(doors.handOver, {
      tx, call: { kind: 'vault-copy', contract: vault, circuit: 'writeSecretCopy' },
      viaService: () => startDoorsOf(doors, vault).copy(vault, tx, place), after: async () => undefined,
    }));
    at = await untilTheChainShows(doors, vault, 'writing a sealed copy of its secret',
      (n) => n.standing.secret?.written[place] === true, secret);
  }
  if (at.standing.secret?.started !== true) {
    at = await untilTheChainShows(doors, vault, 'the last sealed copy', (n) => n.standing.secret?.started === true, secret);
  }
  return at;
}

/**
 * **THIS SIGNER'S OWN COPY OF THE SECRET OPENS WITH THIS SIGNER'S OWN KEY,
 * BEFORE THIS DEVICE RAISES OR APPROVES THE RUN THAT SETS IT.** The sealed
 * copies a vault keeps are sealed to the records keys of the seats the company's
 * directory believes now (`readers`). This device derives its own records key
 * from the company key its wallet released, refuses when that list does not hold
 * it, seals its own copy from the secret it holds, and refuses unless the copy
 * the run would write for it is that one and opens with its own key to that
 * secret. Nothing is raised or approved when it refuses.
 */
export function thisSignersCopyOpens(
  doors: CreateVaultDoors, vault: Hex, secret: RunSecret, run: SecretRunOnTheWire, readers: readonly Hex[],
): void {
  const me = recordsKeypairFrom(doors.me.companyKey).publicKey.toLowerCase();
  if (!readers.some((r) => String(r).toLowerCase() === me)) {
    throw new VaultStartOwed(vault, 'the list of seats the company\'s directory believes does not have the key your own recovery words give, '
      + 'so you could not read this vault\'s secret back from the chain. Nothing was approved.');
  }
  const own = sealSecretCopy({ vault, secret: secret.secret, reader: me as Hex }).map((p) => toHex(p));
  const copy = run.copies.find((c) => String(c.reader).toLowerCase() === me);
  const opens = copy !== undefined && copy.parts.length === own.length && copy.parts.every((p, i) => String(p).toLowerCase() === own[i])
    && ownCopyOpened(doors.me.companyKey, vault, [copy]) === secret.secret.toLowerCase();
  if (!opens) {
    throw new VaultStartOwed(vault, 'the copy of its secret the vault would keep for you does not open with the key your '
      + 'own recovery words give. Nothing was approved.');
  }
}

/**
 * **EVERY KEY THE RUN SEALS A COPY TO, CHECKED BEFORE THIS DEVICE RAISES OR
 * APPROVES IT** (`readerRefusalOf`): signed by its signer's own wallet with the
 * wallet key their seat's opening proves for that seat, one per seat the
 * directory believes and the chain holds now, none missing and none extra, and
 * the vault pinned to the company's account, as the same wallet read the vault.
 * It runs on the keys a new first secret would be wrapped to, before it is filed,
 * and on the keys the run itself holds, before it is raised, approved or set;
 * each time with a read of its own.
 *
 * The wallet's screen for that read also shows the person the vault and every
 * key the secret will be sealed to, each named as the roster names it. That is
 * a confirmation for the person to see, not a check the chain enforces: this
 * device proves the approval with the seat's key it holds.
 */
export async function everyReaderChecksOut(doors: CreateVaultDoors, vault: Hex, readers: readonly string[]): Promise<void> {
  const sources = doors.secretReaders;
  let roster: readonly RosterVaultKeys[];
  try {
    roster = await sources.roster();
  } catch (e) {
    throw new VaultStartOwed(vault, `who its secret is sealed to could not be checked (${(e as Error)?.message ?? e}). Nothing was approved.`);
  }
  const names = new Map(roster.flatMap((e) => (e.keys === null ? [] : [[e.keys.recordsKey.toLowerCase(), e.name] as const])));
  const keys = [...new Set(readers.map((r) => r.toLowerCase()))];
  /*
   * Shown only when the wallet can take the list: with no reader, or more than one run can seal, the wallet would refuse
   * the whole ask and the person would be told their wallet said nothing; asked plainly instead, the reader check below
   * names what is wrong with the readers.
   */
  const firstSecret: FirstSecretShown | undefined = keys.length === 0 || keys.length > MOST_SECRET_READERS ? undefined : {
    readers: keys.map((key) => {
      const name = names.get(key);
      return name === undefined || name === '' ? { key } : { key, name: name.slice(0, MOST_READER_NAME) };
    }),
  };
  /* Asked afresh for this check alone: who holds the account and this vault, as this signer's own wallet reads them now. */
  let seats: SeatsAsTheWalletRead | null;
  try {
    seats = await sources.read(vault, firstSecret);
  } catch (e) {
    throw new VaultStartOwed(vault, `your wallet did not say who holds the company and this vault (${(e as Error)?.message ?? e}). `
      + 'Nothing was approved.', START_STOP.walletNotAnswered);
  }
  let directory: DirectoryAsBelieved;
  try {
    directory = await sources.directory();
  } catch (e) {
    throw new VaultStartOwed(vault, `whose seat each reader holds could not be checked (${(e as Error)?.message ?? e}). Nothing was approved.`, READER_REFUSAL.directoryUnread);
  }
  const refused = readerRefusalOf({
    company: sources.company, readers, roster, seats, vault, account: doors.account, directory,
  });
  if (refused !== null) throw new VaultStartOwed(vault, refused.says, refused.code);
}

/**
 * **THE RECORDS STILL HOLD THIS FIRST SECRET AS THEIR NEWEST VERSION**, asked
 * right before its run is raised and right before it is set. Another device may
 * have replaced a secret it could not vouch for in the meantime; a secret set on
 * the chain that the records no longer hold as their newest would leave this
 * app's devices building no deposit into the vault (the chain itself refuses
 * none for it). Nothing read here is built on: it is only compared. A secret
 * replacing another is filed only once the chain holds it, so it is not asked.
 */
export async function stillTheNewestFiled(doors: CreateVaultDoors, vault: Hex, secret: Pick<RunSecret, 'secret'>, what: string): Promise<void> {
  let newest: string | null = null;
  try {
    const filed = await doors.records('nonce-secret').get(vault);
    if (filed !== null) {
      const opened = openNonceSecrets(filed, vault, recordsKeypairFrom(doors.me.companyKey));
      newest = opened.secrets[opened.secrets.length - 1] ?? null;
    }
  } catch {
    newest = null;
  }
  if (newest === null || newest.toLowerCase() !== secret.secret.toLowerCase()) {
    throw new VaultStartOwed(vault, `the company's records no longer hold the secret this device was about to use, so ${what} `
      + 'was not sent: another device may have set a fresh one up meanwhile. Finish setting it up again.');
  }
}

/**
 * **A FRESH FIRST SECRET, MADE HERE IN PLACE OF ONE NOTHING VOUCHES FOR**, filed
 * as the next version after the one read back, once every key it would be
 * wrapped to checks out, and handed back as made here. Its readers are the seats
 * the directory believes now (`readersNow`).
 */
async function startTheSecretAgain(
  doors: CreateVaultDoors, vault: Hex, filed: SealedPool, beforeFiling: (readers: readonly Hex[]) => Promise<void>,
): Promise<SecretReadBack> {
  const { view, refusal } = await theVaultReadForItsStart(doors, vault);
  if (refusal !== null) throw new VaultStartOwed(vault, refusal);
  const removals = await removalsOnTheChainHere(doors, vault);
  const readers = await readersNow(doors, vault);
  await beforeFiling(readers);
  const others: NonceSecretReader[] = readers
    .filter((k) => k.toLowerCase() !== doors.myRecordsKey.toLowerCase())
    .map((publicKey) => ({ publicKey }));
  try {
    const made = await startVaultNonceSecretAgainOnThisDevice(vault, doors.me, others, doors.records, new Set(view.everCreated ?? []), filed, removals);
    return openedHere(doors, vault, made, true);
  } catch (e) {
    throw new VaultStartOwed(vault, `a fresh secret could not be filed for it (${(e as Error)?.message ?? e}).`);
  }
}

/**
 * **THE SECRET RUN RAISED, ONCE**: nothing is raised while the chain holds this run open in its window and raised after
 * the last removal. Otherwise, and never beside another signer's run that may still set a secret
 * (`noOtherRunStanding`), it is raised under a record of it still standing (`secretRunStillStanding`) or over a new
 * window (`secretRunWindowFrom`: a day for a replacement), its record carrying every reader's sealed copy, the copies
 * tree kept in this wallet first. Answers where it stands once the chain holds it, and what could not be written down.
 */
async function secretRunRaisedHere(
  doors: CreateVaultDoors, vault: Hex, secret: RunSecret, from: StartStanding, summary: string,
): Promise<{ readonly at: StartStanding; readonly said: string | null; readonly window: Window }> {
  const run = from.run!;
  const found = from.standing.secret!.run;
  if (found !== null && runLive(found)) return { at: from, said: null, window: windowOf(found) };
  const standing = await secretRunStillStanding(doors, vault, from, secret, found?.proposal ?? null);
  /* A run of this secret raised after the last removal stands open on the chain, beside the one reported: it is read by its window. */
  if (standing?.live === true) return { at: await standingNow(doors, vault, secret, standing.window), said: null, window: standing.window };
  await noOtherRunStanding(doors, vault, from, secret);
  const first = replacesNothing(secret.previous);
  const window = standing?.window ?? secretRunWindowFrom(from.now, !first);
  const fresh = await standingNow(doors, vault, secret, window);
  const raise = fresh.standing.secret?.raise;
  if (raise === undefined) throw new VaultStartOwed(vault, `${named(secret)} run could not be made.`);
  if (first) await stillTheNewestFiled(doors, vault, secret, 'its first secret run');
  await runKeptHere(doors, vault, run);
  const id = raise.proposal;
  /* The secret goes only to the call built here (`made`); the record is sealed from the run's public parts and copies. */
  const said = await proposedAndWrittenDown(doors, vault, secretRunRound(doors, vault, run, raise, summary), {
    order: {
      circuit: 'propose',
      run: { root: run.root, payees: run.payees, opensAt: raise.opensAt, closesAt: raise.closesAt, vault, required: '0' },
      half: nothingMoves(run.asset, raise.salt), proposal: raise.proposal,
    },
    opened: {
      chainId: raise.proposal, digest: raise.payload, vault: raise.named, salt: raise.salt, summary,
      half: { assetId: run.asset, changeAmount: '0', changeBatchDigest: ZERO_HEX },
      made: madeOf(vault, secret, raise),
    },
    heldNow: async () => landedOrSet(await standingNow(doors, vault, secret), id),
  });
  const at = await untilTheChainShows(doors, vault, `raising ${named(secret)}`, (n) => landedOrSet(n, id), secret, window);
  return { at, said, window };
}

/** This seat's approval of the run, the copies tree kept in this wallet first; where it stands once the chain counts it. */
export async function secretRunApprovedHere(
  doors: CreateVaultDoors, vault: Hex, at: StartStanding, secret: RunSecret, r: RunOnChain, summary: string,
): Promise<StartStanding> {
  const run = at.run!;
  await runKeptHere(doors, vault, run);
  await accountStep(doors, vault, at.chain, 'secret-run', { circuit: 'approve', proposal: r.proposal }, {
    chainId: r.proposal, digest: r.payload, vault: r.named, salt: r.salt, summary,
    half: { assetId: run.asset, changeAmount: '0', changeBatchDigest: ZERO_HEX },
    made: madeOf(vault, secret, r),
  }, `approving ${named(secret)}`);
  return untilTheChainShows(doors, vault, `approving ${named(secret)}`,
    (n) => n.standing.secret?.set === true || (n.standing.secret?.run?.proposal === r.proposal && n.standing.secret.run.approvedHere === true), secret, windowOf(r));
}

/**
 * **THE VAULT'S SECRET SET UNDER ITS APPROVED RUN**, by any signer holding it: a replacement carries the secret the
 * vault last had every copy written for (`earlier`, which the chain checks), found among the secrets this device holds
 * for the vault (the company's records' and this signer's own copy on the chain). When this device holds none of them
 * nothing is sent, and a signer whose company records or own copy on the chain hold that secret carries the run instead.
 */
export async function secretSetHere(
  doors: CreateVaultDoors, vault: Hex, at: StartStanding, secret: RunSecret, r: Pick<RunOnChain, 'proposal' | 'opensAt' | 'closesAt'>,
): Promise<StartStanding> {
  const what = `setting ${named(secret)}`;
  const earlier = at.standing.secret?.earlier;
  if ((earlier === undefined && !replacesNothing(secret.previous)) || (earlier != null && 'unheld' in earlier)) {
    throw new VaultStartOwed(vault, `${what} was not sent: the vault last had every copy written for a secret this device does not `
      + 'hold, and a new secret must carry it. Nothing was sent. A signer whose company records or own copy on the chain hold that secret '
      + 'carries the run instead.');
  }
  const run = at.run!;
  const { tx } = await buildOrOwe(vault, what, () => doors.builder.setNonceSecret({
    vault, account: at.chain.account, run, secret: secret.secret, ...(earlier != null && 'secret' in earlier ? { earlier: earlier.secret } : {}),
    proposal: r.proposal, opensAt: r.opensAt, closesAt: r.closesAt,
    chain: {
      blockHash: at.chain.blockHash, vaultState: at.chain.vaultState, zswapState: at.chain.zswapState,
      parameters: at.chain.parameters, accountState: at.chain.accountState,
    },
  }));
  await sent(vault, what, () => handedOver(doors.handOver, {
    tx, call: { kind: 'vault-secret', contract: vault, circuit: 'setNonceSecret', account: at.chain.account },
    viaService: () => startDoorsOf(doors, vault).secret(vault, tx), after: async () => undefined,
  }));
  return untilTheChainShows(doors, vault, what, (n) => n.standing.secret?.set === true, secret);
}

type Awaiting = Extract<VaultCreated, { readonly state: 'awaiting-approvals' }>['awaiting'];

/**
 * A new vault's first secret set: raised only from a secret made in this press (a secret read back is used only when
 * the chain holds it already, or an open run of the signers commits to it), approved by this seat, and set once the
 * run has every approval it needs. Answers where it stands, or the approvals it waits for.
 */
async function firstSecretSetHere(
  doors: CreateVaultDoors, vault: Hex, from: StartStanding, secret: SecretReadBack, readers: readonly Hex[], sayIt: (s: string | null) => void,
): Promise<{ readonly at: StartStanding } | { readonly awaiting: Awaiting }> {
  let at = from;
  const run = at.run!;
  thisSignersCopyOpens(doors, vault, secret, run, readers);
  await everyReaderChecksOut(doors, vault, run.copies.map((c) => String(c.reader)));
  let found = at.standing.secret!.run;
  if (!runLive(found)) {
    if (!secret.madeHere) {
      throw new VaultStartOwed(vault, 'its first secret run would be raised with a secret read back from the company\'s '
        + 'records, which nothing on the chain vouches for. Nothing was sent.', START_STOP.readBackOnly);
    }
    const raised = await secretRunRaisedHere(doors, vault, secret, at, FIRST_SECRET_SUMMARY);
    sayIt(raised.said);
    at = raised.at;
    found = at.standing.secret!.run;
    /* Read by the raised run's own window; a run raised before a removal is never approved or set from here. */
    if (found?.beforeARemoval === true) {
      throw new VaultStartOwed(vault, 'the chain reads this first secret run as raised before a signer was removed, so it is neither '
        + 'approved nor set from this device. Nothing was sent. Pressing again raises it afresh, sealed to the signers there are now.');
    }
  }
  if (!at.standing.secret!.set && found !== null && found.approvals < found.needed && !approvedHere(vault, found, 'its first secret')) {
    at = await secretRunApprovedHere(doors, vault, at, secret, found, FIRST_SECRET_SUMMARY);
    found = at.standing.secret!.run;
  }
  if (at.standing.secret!.set) return { at };
  if (found === null) throw new VaultStartOwed(vault, 'its first secret run is not on the chain.');
  if (found.approvals < found.needed) {
    doors.progress?.('waiting for approvals');
    return { awaiting: { round: 'first-secret', proposal: found.proposal as Hex, approvals: found.approvals, needed: found.needed } };
  }
  await stillTheNewestFiled(doors, vault, secret, 'its first secret');
  /* Read afresh right before the secret is set, not only before the run was raised: a signer may have left since. */
  await everyReaderChecksOut(doors, vault, run.copies.map((c) => String(c.reader)));
  return { at: await secretSetHere(doors, vault, at, secret, found) };
}

/**
 * **A NEW VAULT'S POOL, NONCE SECRET AND FIRST SECRET RUN, FROM WHAT THE CHAIN SHOWS** (step 5 b to d of a vault's
 * start): the pool and the secret made here, or read back and held to the chain; a secret read back that nothing on
 * the chain vouches for replaced, never used; the run raised, approved and set (`firstSecretSetHere`); every signer's
 * sealed copy written; and the run written down as carried out. Answers null once the vault takes money, or the
 * approvals its run waits for. Each step the chain already shows is passed over, so it runs again from wherever a press
 * stopped.
 */
export async function secretStartedHere(doors: CreateVaultDoors, vault: Hex, sayIt: (s: string | null) => void): Promise<Awaiting | null> {
  /* From here on the vault must be one the account itself has adopted, as the wallet reads it: never the service's row. */
  await asTheWalletReadIt(doors, vault);
  const checked = (filedTo: readonly Hex[]) => everyReaderChecksOut(doors, vault, filedTo);
  let secret = await openCompanyVaultPool(doors, vault, checked,
    (secret, state) => doors.builder.secretIsTheVaults({ vault, state, secret }), () => removalsOnTheChainHere(doors, vault),
    () => readersNow(doors, vault));
  doors.progress?.('setting the secret');
  let at = await standingNow(doors, vault, secret);
  const first = at.standing.secret;
  if (!secret.madeHere && first !== undefined && !first.set && !first.another && !runLive(first.run)) {
    /* No open run of the signers commits to a secret read back that the vault has not taken: a fresh one replaces it. */
    secret = await startTheSecretAgain(doors, vault, secret.filed, checked);
    at = await standingNow(doors, vault, secret);
  }
  const readers = await readersNow(doors, vault);
  const missing = readers.filter((r) => !secret.readers.some((k) => k.toLowerCase() === r.toLowerCase()));
  if (missing.length > 0) {
    throw new VaultStartOwed(vault, `${missing.length} signer(s) cannot open the vault's filed secret, so their sealed `
      + 'copies would be missing. Nothing was sent.', START_STOP.readersCannotOpen);
  }
  const run = at.run;
  if (run === undefined || at.standing.secret === undefined) throw new VaultStartOwed(vault, 'its first secret run could not be made.');
  if (at.standing.secret.another) {
    throw new VaultStartOwed(vault, 'it already holds a secret other than the one the company\'s records hold, so its '
      + 'first secret is not set again. Nothing was sent.', START_STOP.anotherSecret);
  }
  /* A first secret run the chain holds in its window for this secret is written down and entered, whatever else it shows. */
  const held = at.standing.secret.run;
  if (held !== null && runLive(held)) sayIt(await proposedAndWrittenDown(doors, vault, secretRunRound(doors, vault, run, held, FIRST_SECRET_SUMMARY)));
  if (!at.standing.secret.set) {
    const done = await firstSecretSetHere(doors, vault, at, secret, readers, sayIt);
    if ('awaiting' in done) return done.awaiting;
    at = done.at;
  }
  /* The chain wins: the records' newest version is made the one whose secret the vault now holds. */
  if (await theChainWins(doors, vault, at.chain.vaultState) === 'none-names-it') {
    throw new VaultStartOwed(vault, 'the vault holds a secret that no version of the company\'s records you can open holds, '
      + 'so no money can be put in or paid out with it. Nothing was sent.');
  }
  if (!at.standing.secret!.rootIsThisRuns) {
    throw new VaultStartOwed(vault, 'the sealed copies its signers approved are not the ones made from the company\'s '
      + 'filed secret now. Nothing was sent.');
  }
  at = await everyCopyWritten(doors, vault, at, run, secret);
  sayIt(await secretWrittenDown(doors, vault, at, secret));
  await doors.secretKeptHere?.drop(vault);
  return null;
}

/**
 * **A RUN REPLACING A VAULT'S SECRET, RAISED FROM THIS DEVICE** with `secret`, a new secret the caller made and keeps in
 * this wallet: sealed to the seats the directory believes now (`readersNow`), over the commitment the vault holds now
 * (`previous`), its record carrying every reader's sealed copy. Refuses a vault with no secret yet (its first is set by
 * finishing its start), a secret the vault already holds, and a run while another signer's may still set one
 * (`noOtherRunStanding`). Raises only: approving it and setting the secret are each signer's own press. Answers the run
 * as the chain holds it, the run as raised (its secret, readers, `previous` and earlier secrets), and what could not be
 * written down.
 */
export async function raiseASecretRunHere(
  doors: CreateVaultDoors, vault: Hex, secret: Hex,
): Promise<{ readonly at: StartStanding; readonly said: string | null; readonly run: RunSecret }> {
  const readers = await readersNow(doors, vault);
  const earlier = await heldSecretsOf(doors, vault);
  const asRead = await standingNow(doors, vault, { secret, readers, earlier });
  const held = asRead.standing.secret?.held ?? ZERO_HEX;
  if (replacesNothing(held)) {
    throw new VaultStartOwed(vault, 'the vault holds no secret yet, so none is replaced: its first secret is set by finishing setting it '
      + 'up. Nothing was sent.');
  }
  if (asRead.standing.secret?.set === true) {
    throw new VaultStartOwed(vault, 'the vault already holds this secret, so no run is raised for it. Nothing was sent.');
  }
  const run: RunSecret = { secret, readers, previous: held.toLowerCase() as Hex, earlier };
  const at = await standingNow(doors, vault, run);
  if (at.run === undefined || at.standing.secret === undefined) throw new VaultStartOwed(vault, 'its new secret run could not be made.');
  thisSignersCopyOpens(doors, vault, run, at.run, readers);
  await everyReaderChecksOut(doors, vault, at.run.copies.map((c) => String(c.reader)));
  return { ...await secretRunRaisedHere(doors, vault, run, at, NEW_SECRET_SUMMARY), run };
}
