/**
 * **A ROUND OF A VAULT'S START, OR A RUN REPLACING ITS SECRET, APPROVED OR CARRIED OUT BY A SIGNER WHO DID NOT RAISE
 * IT**, as the wallet's one approval names it: found from the company's record of it and the chain, checked, approved
 * (`approveStartRoundHere`) and carried out (`carryStartRoundHere`, `finishedSecretRunHere`). A secret run's secret is
 * opened from this signer's own sealed copy in the run's record, so any signer can approve it and set it.
 */
import { ADOPT_VAULT, VAULT_SECRET, proposalFilingRefusal } from '../../../src/core/proposal-filing.js';
import type { CreateVaultDoors } from './vault-doors.js';
import type { Hex } from '../../../src/core/crypto.js';
import { STALE_ADOPTION, START_STOP, type StartReadStopCode, type StartStopCode, VaultStartOwed } from './vault-start-stops.js';
import type { SealedProposal } from '../../../src/core/types.js';
import type { RunSecret } from './vault-pool-opened.js';
import { type StartStanding, accountStep, adoptionRound, approvedHere, carriedOutWrittenDown, standingNow, untilTheChainShows } from './vault-start-steps.js';
import {
  everyCopyWritten, everyReaderChecksOut, readersNow, secretRunApprovedHere, secretSetHere, stillTheNewestFiled, thisSignersCopyOpens,
} from './vault-secret-run.js';
import {
  FIRST_SECRET_SUMMARY, NEW_SECRET_SUMMARY, replacesNothing, runLive, runSecretOfTheRecord, secretWrittenDown, startRecordOpened,
} from './vault-secret-run-record.js';
import { kindAsked, listedHere } from './vault-page-doors.js';
import { refuseLeavingAVaultShort } from '../../../src/core/vault-approvers.js';
import { ADOPTED_AGAIN_SINCE, adoptionAlreadyClosed } from './vault-adopt-again.js';

/* ------------------------------------------------------------ a round of a vault's start, approved by another signer */

/**
 * The two kinds of round the one approval names: a vault's adoption, and a secret run (`first-secret`, its name on the
 * wire, for the vault's first secret and for every one replacing it).
 */
export type StartRoundKind = 'adoption' | 'first-secret';

/** A round of a vault's start, named by its vault and by the company's record of it. */
export interface StartRoundNamed {
  readonly vault: Hex;
  readonly round: StartRoundKind;
  /** The company's record of the proposal, by its name at the service. */
  readonly proposal: string;
}

/**
 * **A ROUND OF A VAULT'S START THIS DEVICE DOES NOT APPROVE OR CARRY OUT**, and why, in a sentence that says what
 * resolves it. Whether anything was sent is the caller's to say, from what it handed over.
 */
export class StartRoundRefused extends Error {
  constructor(why: string, readonly stoppedAt?: StartStopCode | StartReadStopCode) {
    super(why);
    this.name = 'StartRoundRefused';
  }
}

/** The proposal as this device found it: its identity on the chain, where the chain shows its start, and whether it is done. */
interface StartRoundFound {
  /** The doors to read and act with: for a re-adoption, carrying the proposal that retired the vault. */
  readonly doors: CreateVaultDoors;
  readonly chainId: Hex;
  readonly at: StartStanding;
  readonly secret?: RunSecret;
  readonly done: boolean;
  /** A secret run's secret is set on the vault; `done` only once every signer's sealed copy is written too. */
  readonly set?: boolean;
}

/** A stop of the start's own, said as the proposal's refusal; anything else is left as it is. */
const asRefused = (e: unknown): unknown => (e instanceof VaultStartOwed ? new StartRoundRefused(e.why, e.stoppedAt) : e);

/**
 * **THE PROPOSAL NAMED, FOUND FROM THE COMPANY'S RECORD OF IT AND THE CHAIN.** The record is read only through the
 * company's directory as this device believes it (`listedHere`), filed as this company files, and opened with the
 * company's keys to a round of this kind for this vault. Its identity on the chain is then made here, never taken
 * from the record: the adoption's from the vault alone, a secret run's from the secret this signer's own sealed copy
 * in the record opens to (a first secret's record sealed before records carried copies: the secret the company's
 * records hold, read back), the readers and the replaced commitment the record names, and its window. A record whose
 * identity or payload is not that one is refused, and so is one withdrawn: it stands for nothing on the chain.
 */
async function startRoundFoundHere(asked: CreateVaultDoors, named: StartRoundNamed): Promise<StartRoundFound> {
  let doors = asked;
  const p = doors.proposals;
  const vault = named.vault.toLowerCase() as Hex;
  const called = named.round === 'adoption' ? 'adoption' : 'secret run';
  let rec: SealedProposal | undefined;
  try {
    const [served, here] = await Promise.all([p.service.sealedProposals(p.accountId), p.directory(kindAsked('proposal'))]);
    rec = listedHere(here, 'proposal', served, 'proposal').find((r) => r.id === named.proposal && r.accountId === p.accountId);
  } catch (e) {
    throw new StartRoundRefused(`the company's proposals could not be read (${String((e as Error)?.message ?? e).replace(/\.$/u, '')}). Nothing was sent. Reload the page and try again.`);
  }
  if (rec?.status === 'cancelled') {
    throw new StartRoundRefused(`the company's records hold this ${called} of the vault withdrawn, so it is neither approved nor carried out. `
      + `Nothing was sent. Reload the page: a ${called} still standing is listed open.`);
  }
  const opened = rec === undefined || proposalFilingRefusal(p.accountId, rec) !== null ? null : startRecordOpened(p.companyKeys, rec);
  const kind = named.round === 'adoption' ? ADOPT_VAULT : VAULT_SECRET;
  if (rec === undefined || opened === null || opened.kind !== kind || opened.vault !== vault || (named.round === 'first-secret' && opened.window === undefined)) {
    throw new StartRoundRefused(`the company's records hold no ${called} of this vault under that name that this device can open and believe. `
      + 'Nothing was sent. Reload the page.');
  }
  /* The adoption of a vault the company retired is made from the proposal that retired it, as its record says. */
  if (opened.again !== undefined) doors = { ...doors, again: opened.again };
  const notThisOne = (): StartRoundRefused => new StartRoundRefused(`the company's record under that name is not the ${called} of this vault `
    + 'as this device makes it from the chain and the company\'s records. Nothing was sent. Do not approve it.');
  try {
    if (named.round === 'adoption') {
      const at = await standingNow(doors, vault);
      const a = at.standing.adoption;
      if (a.proposal.toLowerCase() !== String(rec.chainId).toLowerCase() || a.payload.toLowerCase() !== String(rec.digest).toLowerCase()) throw notThisOne();
      if (opened.again !== undefined && !at.standing.adopted && await adoptionAlreadyClosed(doors, vault, a.proposal.toLowerCase() as Hex)) {
        throw new StartRoundRefused(ADOPTED_AGAIN_SINCE);
      }
      return { doors, chainId: a.proposal.toLowerCase() as Hex, at, done: at.standing.adopted };
    }
    let secret: RunSecret | null;
    try {
      secret = await runSecretOfTheRecord(doors, vault, opened);
    } catch (e) {
      throw new StartRoundRefused(`this device cannot open the run's secret (${String((e as Error)?.message ?? e).replace(/\.$/u, '')}), `
        + 'so it cannot check the run that sets it. Nothing was sent.');
    }
    if (secret === null) {
      throw new StartRoundRefused('this device cannot open the run\'s secret (the run seals no copy of it that the key your own recovery '
        + 'words give opens; it is raised again once your seat is one the company\'s directory believes), so it cannot check the run that sets it. Nothing was sent.');
    }
    const at = await standingNow(doors, vault, secret, opened.window);
    const raise = at.standing.secret?.raise;
    if (raise === undefined || raise.proposal.toLowerCase() !== String(rec.chainId).toLowerCase()
      || raise.payload.toLowerCase() !== String(rec.digest).toLowerCase()) throw notThisOne();
    return {
      doors, chainId: raise.proposal.toLowerCase() as Hex, at, secret,
      done: at.standing.secret?.started === true, set: at.standing.secret?.set === true,
    };
  } catch (e) {
    throw asRefused(e);
  }
}

/**
 * **THE PROPOSAL NAMED, OPENED FOR THE ONE APPROVAL**: its identity on the chain, as `startRoundFoundHere` makes it. One
 * the chain shows done - the vault adopted, or started under the secret its run sets - and the company's records
 * still hold open is written down as carried out here (`carriedOutWrittenDown`, `secretWrittenDown`), so a press
 * after the proposal was carried out elsewhere closes the record; `said` is why it was not, or null.
 */
export async function startRoundOpenedHere(doors: CreateVaultDoors, named: StartRoundNamed): Promise<{ readonly chainId: Hex; readonly said: string | null }> {
  const found = await startRoundFoundHere(doors, named);
  doors = found.doors;
  return { chainId: found.chainId, said: found.done ? await writtenDownOnceDone(doors, named.vault.toLowerCase() as Hex, named.round, found) : null };
}

/** The proposal written down as carried out, once the chain shows it done: why not, or null. */
const writtenDownOnceDone = async (doors: CreateVaultDoors, vault: Hex, round: StartRoundKind, found: StartRoundFound): Promise<string | null> => {
  if (round === 'adoption') return carriedOutWrittenDown(doors, vault, adoptionRound(doors, vault, found.at.standing.adoption, 'Add a new vault to the company'));
  return secretWrittenDown(doors, vault, found.at, found.secret!);
};

/** Refuses an adoption that would leave a vault with fewer signers who may approve its runs than its bar (`refuseLeavingAVaultShort`). */
const noVaultLeftShort = async (doors: CreateVaultDoors, vault: Hex): Promise<void> => {
  try {
    refuseLeavingAVaultShort(await doors.approvers(), { kind: 'adopt', vault }, doors.vaultName);
  } catch (e) {
    throw new StartRoundRefused(`${(e as Error).message.replace(/ Nothing was approved\.$/u, '')} Nothing was sent.`, START_STOP.tooFewApprovers);
  }
};

/**
 * The checks before this device approves or carries out a vault's secret run, each as the start makes them: the vault
 * holds no secret but this run's or the one it replaces, the chain holds the run open and in its window, no signer was
 * removed since it was raised (it would seal the secret to a seat that is gone), and who it is sealed to
 * (`readersChecked`). Answers the run as the chain holds it.
 */
async function secretRunChecked(doors: CreateVaultDoors, vault: Hex, found: StartRoundFound): Promise<NonNullable<StartStanding['standing']['secret']>['run'] & object> {
  const s = found.at.standing.secret!;
  if (s.another) {
    throw new StartRoundRefused('the vault already holds a secret that is neither this run\'s nor the one it replaces, so this run\'s '
      + 'secret is not set. Nothing was sent.', START_STOP.anotherSecret);
  }
  const r = s.run;
  if (r === null || r.proposal.toLowerCase() !== found.chainId || !r.open) {
    throw new StartRoundRefused('the chain holds this secret run open no more, or never held it. Nothing was sent. Reload the page.');
  }
  if (!r.inWindow) {
    throw new StartRoundRefused('the time this secret run could be carried out in has passed, so it is not approved. Nothing was '
      + 'sent. Raising it again, from a device that holds its secret, makes the run afresh.');
  }
  if (r.beforeARemoval) {
    throw new StartRoundRefused('a signer was removed after this secret run was raised, so it would seal the vault\'s secret to the seats '
      + 'held then, and this device neither approves nor carries it. Nothing was sent. Raising the run again seals it to the signers '
      + 'there are now.');
  }
  /* Each part of `runLive` is refused above in its own words; this holds the steps to the one rule if a part is added. */
  if (!runLive(r)) throw new StartRoundRefused('this secret run is not one this device may act on now. Nothing was sent. Reload the page.');
  await readersChecked(doors, vault, found);
  return r;
}

/**
 * The checks of who a secret is sealed to, as the start makes them before it approves the run or writes a sealed copy:
 * every seat the directory believes now can open it (`readersNow`), this signer's own copy opens with its own key, every
 * reader is a seat the account holds whose key its own wallet signed (`everyReaderChecksOut`), and a first secret is
 * still the newest the company's records hold.
 */
async function readersChecked(doors: CreateVaultDoors, vault: Hex, found: StartRoundFound): Promise<void> {
  const run = found.at.run!;
  const secret = found.secret!;
  const readers = await readersNow(doors, vault);
  const missing = readers.filter((k) => !secret.readers.some((x) => x.toLowerCase() === k.toLowerCase()));
  if (missing.length > 0) {
    throw new StartRoundRefused(`${missing.length} signer(s) cannot open the run's secret, so their sealed copies would be `
      + 'missing. Nothing was sent.', START_STOP.readersCannotOpen);
  }
  thisSignersCopyOpens(doors, vault, secret, run, readers);
  await everyReaderChecksOut(doors, vault, run.copies.map((c) => String(c.reader)));
  if (replacesNothing(secret.previous)) await stillTheNewestFiled(doors, vault, secret, 'its first secret');
}

/**
 * Every signer's sealed copy of a secret the vault already holds, written: the checks of who it is sealed to
 * first (`readersChecked`), and only copies of the very tree the signers approved (`rootIsThisRuns`).
 */
async function copiesOfASetSecretWritten(doors: CreateVaultDoors, vault: Hex, found: StartRoundFound, from: StartStanding): Promise<StartStanding> {
  await readersChecked(doors, vault, found);
  if (from.standing.secret?.rootIsThisRuns !== true) {
    throw new StartRoundRefused('the sealed copies the signers approved are not the ones made from the run\'s secret now, '
      + 'so none is written. The secret is set.');
  }
  return everyCopyWritten(doors, vault, from, from.run!, found.secret!);
}

/**
 * **THIS SEAT'S APPROVAL OF A ROUND OF A VAULT'S START ANOTHER SIGNER RAISED**, with every check the start makes before
 * it approves: an adoption raised before a removal is refused for good, and one that would leave a vault short of
 * signers who may approve its runs is refused; a secret run is checked as `secretRunChecked` says, and its copies tree
 * is kept in this wallet before it is approved (`secretRunApprovedHere`). Nothing is
 * built when the chain already counts this seat's approval (`counted`), or shows the proposal done (`carried-out`), each
 * read from the chain. Files no record.
 */
export async function approveStartRoundHere(doors: CreateVaultDoors, named: StartRoundNamed): Promise<'approved' | 'counted' | 'carried-out'> {
  const vault = named.vault.toLowerCase() as Hex;
  const found = await startRoundFoundHere(doors, named);
  doors = found.doors;
  if (found.done || found.set === true) return 'carried-out';
  try {
    if (named.round === 'adoption') {
      const a = found.at.standing.adoption;
      if (a.stale) throw new StartRoundRefused(STALE_ADOPTION, START_STOP.adoptionStale);
      if (!a.open) throw new StartRoundRefused('the chain holds no adoption of this vault raised. Nothing was sent. Reload the page.');
      await noVaultLeftShort(doors, vault);
      if (approvedHere(vault, a, 'its adoption')) return 'counted';
      const governance = { kind: 'adopt-vault', vault } as const;
      await accountStep(doors, vault, found.at.chain, 'adoption', { circuit: 'approve', proposal: a.proposal, of: { governance, proposalSalt: a.salt } }, {
        chainId: a.proposal, digest: a.payload, vault: a.named, salt: a.salt, summary: 'Add a new vault to the company', governance,
      }, 'approving its adoption');
      await untilTheChainShows(doors, vault, 'approving its adoption', (n) => n.standing.adopted || n.standing.adoption.approvedHere === true);
      return 'approved';
    }
    const r = await secretRunChecked(doors, vault, found);
    const secret = found.secret!;
    if (approvedHere(vault, r, replacesNothing(secret.previous) ? 'its first secret' : 'its new secret')) return 'counted';
    await secretRunApprovedHere(doors, vault, found.at, secret, r, replacesNothing(secret.previous) ? FIRST_SECRET_SUMMARY : NEW_SECRET_SUMMARY);
    return 'approved';
  } catch (e) {
    throw asRefused(e);
  }
}

/**
 * **A ROUND OF A VAULT'S START CARRIED OUT ONCE THE CHAIN COUNTS ITS APPROVALS**, read again from the chain, with every
 * check `approveStartRoundHere` makes: the adoption adopted, or the run's secret set (`secretSetHere`, a replacement
 * carrying the secret it replaces) and every signer's sealed copy written; a secret already set with copies still owed
 * has those copies written. `waiting` when the chain does not count the approvals the proposal needs yet, and nothing
 * is sent. Once the
 * chain shows the proposal done, its record is written down as carried out; `said` is why it was not, or null.
 */
export async function carryStartRoundHere(
  doors: CreateVaultDoors, named: StartRoundNamed,
): Promise<{ readonly state: 'carried-out' | 'waiting'; readonly said: string | null }> {
  const vault = named.vault.toLowerCase() as Hex;
  const found = await startRoundFoundHere(doors, named);
  doors = found.doors;
  try {
    let at = found.at;
    if (!found.done && named.round === 'adoption') {
      const a = at.standing.adoption;
      if (a.stale) throw new StartRoundRefused(STALE_ADOPTION, START_STOP.adoptionStale);
      if (!a.open) throw new StartRoundRefused('the chain holds no adoption of this vault raised. Nothing was sent. Reload the page.');
      if (a.approvals < a.needed) return { state: 'waiting', said: null };
      await noVaultLeftShort(doors, vault);
      await accountStep(doors, vault, at.chain, 'adoption', { circuit: 'adopt', vault, proposal: a.proposal, proposalSalt: a.salt }, {
        chainId: a.proposal, digest: a.payload, vault: a.named, salt: a.salt, summary: 'Add a new vault to the company',
        governance: { kind: 'adopt-vault', vault },
      }, 'adopting it');
      at = await untilTheChainShows(doors, vault, 'adopting it', (n) => n.standing.adopted);
    } else if (!found.done && found.set === true) {
      at = await copiesOfASetSecretWritten(doors, vault, found, at);
    } else if (!found.done) {
      const r = await secretRunChecked(doors, vault, found);
      if (r.approvals < r.needed) return { state: 'waiting', said: null };
      at = await secretSetHere(doors, vault, at, found.secret!, r);
      at = await copiesOfASetSecretWritten(doors, vault, found, at);
    }
    const said = named.round === 'adoption'
      ? await carriedOutWrittenDown(doors, vault, adoptionRound(doors, vault, at.standing.adoption, 'Add a new vault to the company'))
      : await secretWrittenDown(doors, vault, at, found.secret!);
    return { state: 'carried-out', said };
  } catch (e) {
    throw asRefused(e);
  }
}

/**
 * **A SECRET RUN THE CHAIN HAS CLOSED, FINISHED FROM THE ONE APPROVAL**: once the vault holds the secret the run
 * set, every sealed copy still owed is written (`copiesOfASetSecretWritten`) and the run is written down as carried
 * out, so a carrying out cut off between the set and the last copy is finished by the next press. Null when the vault
 * does not hold that secret: the run closed without setting it, and nothing is sent.
 */
export async function finishedSecretRunHere(
  doors: CreateVaultDoors, named: StartRoundNamed,
): Promise<{ readonly state: 'carried-out'; readonly said: string | null } | null> {
  if (named.round !== 'first-secret') return null;
  const vault = named.vault.toLowerCase() as Hex;
  const found = await startRoundFoundHere(doors, named);
  doors = found.doors;
  if (found.set !== true) return null;
  try {
    const at = found.done ? found.at : await copiesOfASetSecretWritten(doors, vault, found, found.at);
    return { state: 'carried-out', said: await secretWrittenDown(doors, vault, at, found.secret!) };
  } catch (e) {
    throw asRefused(e);
  }
}
