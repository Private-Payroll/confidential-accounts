/**
 * **CREATING A COMPANY'S VAULT (WHICH ALSO OPENS ITS POOL), FROM A SIGNER'S
 * OWN DEVICE.** Everything it touches is handed in, so the same order runs in a
 * test against the ledger's own objects.
 *
 * ── CREATING A VAULT IS ONE OPERATION WITH NO SUCCESS STATE UNTIL THE END ──
 *
 *   1. the committee the vault is born held by is the one holding the
 *      company's account, at its threshold, as this signer's own wallet reads
 *      it off the chain: the super admins, whoever they are. No signer's key
 *      is asked for it, and a committee no contract may be held by builds no
 *      vault;
 *   2. the vault is built here held by that committee from its first
 *      transaction: there is no temporary key and no hand-over;
 *   3. the deploy is sent;
 *   4. as soon as the chain has the vault, this device reads it as it was born,
 *      from the deploy its address was made from, and refuses it unless it was
 *      held by the committee at counter 0, ran this build's circuits and wrote
 *      nothing;
 *   5. the vault is STARTED, each step raised only once the chain shows the one
 *      before:
 *        a. the company's account adopts it: the adoption round is raised,
 *           approved by this signer and carried out;
 *        b. its note pool and nonce secret are filed through the company's
 *           records route, and the secret is READ BACK and opened here;
 *        c. the first secret run is raised from what was read back, approved
 *           by this signer, and the secret set under it;
 *        d. every signer's sealed copy of the secret is written into the vault.
 *      The operation ends `started` when the chain shows every copy written.
 *      The adoption and the first secret run are each written down as a
 *      proposal of the company's, sealed and signed by this seat, in the same
 *      request as their raise (`proposedAndWrittenDown`), and one the chain
 *      holds with no record is written down on the next press, so the company's
 *      proposals hold a record of each; the record of the run carries every
 *      reader's copy of the secret sealed to that reader alone, never the
 *      secret. A raise written down that has not reached the chain is sent
 *      again under its record while it may still land; once the chain's time is
 *      past its deadline, this device's own adoption record is withdrawn and
 *      raised afresh, and a dead secret run record, whoever wrote it, is passed
 *      over and the run raised over a new window. A seat whose role may not
 *      raise a proposal sets up no vault. Once the chain shows the vault adopted,
 *      or started under its first secret, the record of that proposal is
 *      written down as carried out (`carriedOutWrittenDown`, `secretWrittenDown`).
 *
 *   Another signer approves either round, and carries it out once the chain
 *   counts its bar, with the same checks and without filing anything
 *   (`approveStartRoundHere`, `carryStartRoundHere`).
 *
 * **ANYTHING SHORT OF THE END IS A FAILURE THAT NAMES THE VAULT**
 * (`VaultStartOwed`, or `VaultNotTheCompanys` for a vault not born held),
 * or, for a company whose rounds need more approvals than this signer's, the
 * named state `awaiting-approvals`, saying which round waits for how many.
 * Running the operation again for that vault carries on from what the chain
 * shows, and every step already on the chain is passed over. The vault itself
 * takes no money until the end, and the service carries none into it either.
 */
import { refuseLeavingAVaultShort } from '../../../src/core/vault-approvers.js';
import type { Hex } from '../../../src/core/crypto.js';
import type { Committee } from '../../../src/midnight/vault-committee.js';
import { whyNotInstallable } from 'midnight-identity/profile/request';
import { fileVaultInfoHere, VaultInfoChanged, VaultInfoRefused } from './vault-info-filed-here.js';
import { vaultInfoTidied } from '../../../src/midnight/vault-info-record.js';
import { NO_ASSET } from '../../../src/core/assets.js';
import type { OpenedRound } from './governed-call-builder.js';
import { ReadRanOutOfTime } from './read-bound.js';
import type { AccountHolders } from 'midnight-identity/profile/records-key';
import { NOT_BUILT, type NotBuiltCode, SAID, STALE_ADOPTION, START_READ_STOP, START_STOP, type SaidCode, type VaultCreated, VaultNotReadHere, VaultNotTheCompanys, VaultStartOwed, sentNothing } from './vault-start-stops.js';
import { type CreateVaultDoors, type VaultChainView } from './vault-doors.js';
import { NO_VAULT_YET, circuitsOfARead, readHere } from './vault-read-here.js';
import { NOT_READ_IN_TIME, RAN_OUT, type SeatRefusal, ZERO_HEX, accountStep, adoptionRound, approvedHere, carriedOutWrittenDown, nothingMoves, proposedAndWrittenDown, seatRefusalIn, standingNow, untilReadHere, untilTheChainShows } from './vault-start-steps.js';
import { secretStartedHere } from './vault-secret-run.js';
import { notesAsThisDeviceReadsThem } from './vault-step-reads.js';

/** What a new vault is called and what it is for, as the person creating it gives them. */
export interface VaultInfoGiven {
  readonly name: string;
  readonly description: string;
}

/**
 * **NO VAULT WAS BUILT, AND NOTHING WAS SENT.** Thrown by `createCompanyVault`
 * for a press it refuses before building: its `code` is the kind of refusal.
 */
export class VaultNotBuilt extends Error {
  constructor(readonly code: NotBuiltCode, why: string) {
    super(why);
    this.name = 'VaultNotBuilt';
  }
}

/**
 * **THE COMMITTEE A NEW VAULT IS BORN HELD BY**: the very committee, at the
 * very threshold, that holds the company's account as this signer's own wallet
 * reads it off the chain - the super admins, whoever they are. Neither the
 * service's word nor the signers' keys are asked: a key no signer holds is as
 * good as any. Refused only when the chain's committee is one a contract may
 * not be held by.
 */
async function theCommitteeAVaultIsBornHeldBy(doors: CreateVaultDoors): Promise<Committee> {
  let holders: AccountHolders;
  try {
    /* Read before the vault exists, so the wallet is asked about the account the vault will be pinned to. */
    holders = (await doors.onChain(doors.account as string as Hex)).holders;
  } catch (e) {
    throw new VaultNotBuilt(NOT_BUILT.committeeUnread, `your wallet could not say who holds your company's account (${(e as Error)?.message ?? e}), so no vault was built.`);
  }
  const committee: Committee = {
    committee: holders.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: holders.threshold,
  };
  const notInstallable = whyNotInstallable(committee);
  if (notInstallable !== null) throw new VaultNotBuilt(NOT_BUILT.committeeNotInstallable, `no vault was built: ${notInstallable}`);
  return committee;
}

/**
 * **THE VAULT AS IT WAS BORN, READ ON THIS DEVICE BEFORE IT IS ADOPTED OR ITS
 * SET-UP IS CARRIED ON**: the chain shows it, and the deploy its
 * address was made from was held by the company's committee at counter 0, ran
 * this build's circuits and wrote nothing. Every later change needs the
 * committee's signatures, so this one read is enough; a vault adopted again
 * (`doors.again`) is read as held by the committee the company holds now, since
 * a change of super admins since moved it. Both chain reads, the
 * vault's notes and how it was deployed, are asked inside one wait: a read that
 * ran out of time is asked again, and a wait in which every read ran out stops
 * as a chain this device could not read.
 */
async function readBornHeld(doors: CreateVaultDoors, vault: Hex): Promise<void> {
  doors.progress?.('waiting for the chain');
  let deployedWith: BornHeldReadWith | undefined;
  const asDeployed = await untilReadHere(doors, async () => {
    let v: VaultChainView;
    try {
      v = await notesAsThisDeviceReadsThem(doors, vault);
    } catch (e) {
      if (ranOutOfTime(e)) return RAN_OUT;
      throw new VaultStartOwed(vault, `the chain could not be read for it on this device (${(e as Error)?.message ?? e}).`, START_READ_STOP.chainUnread);
    }
    if (!v.onChain) return null;
    deployedWith ??= await bornHeldReadWith(doors, vault);
    try {
      return await doors.builder.vaultAsDeployed!({ vault, account: doors.account, ...deployedWith, ...(doors.again === undefined ? {} : { again: true }) });
    } catch (e) {
      if (ranOutOfTime(e)) return RAN_OUT;
      throw e;
    }
  });
  if (asDeployed === RAN_OUT) throw new VaultStartOwed(vault, `it was sent, and ${NOT_READ_IN_TIME}`, START_READ_STOP.chainUnread);
  if (asDeployed === null) throw new VaultStartOwed(vault, 'it was sent and the chain has not shown it yet.');
  if (asDeployed.refusal !== null) {
    const why = asDeployed.refusal.replace(/ Nothing was sent\.$/u, '');
    throw new VaultNotTheCompanys(vault, doors.again !== undefined ? why : `${why} This vault is not set up and no money is put into it; create a new vault.`);
  }
}

type BornHeldReadWith = { readonly indexer: { readonly indexerUri: string; readonly indexerWsUri: string }; readonly holders: Committee };

/** The indexer and committee a vault's deploy is read against, once the chain shows the vault; refuses before any read of the deploy when this device has no reader for it, or the indexer or the committee cannot be named. */
async function bornHeldReadWith(
  doors: CreateVaultDoors, vault: Hex,
): Promise<BornHeldReadWith> {
  if (doors.builder.vaultAsDeployed === undefined) {
    throw new VaultNotTheCompanys(vault, 'this device cannot read how this vault was created, so it is not set up from here and '
      + 'no money is put into it. Reload the page and try again; if it still cannot be read, create a new vault.');
  }
  const indexer = await doors.indexer();
  if (indexer === null) {
    throw new VaultStartOwed(vault, 'your wallet did not say which indexer it reads the chain through, so this device cannot '
      + 'read how the vault was created.');
  }
  const holders = await theCommitteeAVaultIsBornHeldBy(doors).catch((e: unknown) => {
    if (e instanceof VaultNotBuilt) {
      throw new VaultStartOwed(vault, 'your wallet could not say which committee holds your company\'s account, so this device cannot '
        + 'read how the vault was created.');
    }
    throw e;
  });
  return { indexer, holders };
}

/**
 * **CREATING A VAULT, BORN HELD.** The vault is deployed held by the company's
 * committee at its threshold from its first transaction: there is no temporary
 * key, no hand-over, and nothing to forget. Then it is read as it was born and
 * started. With `resume`, a vault already sent is read as it was born and its
 * start carried on.
 *
 * With `info`, the vault's name and description are checked before anything is
 * built, and filed once this device has read the vault as born held by the
 * company (`fileVaultInfoHere`), never before, by a seat that may file them;
 * when they are not filed, the vault is still created and why is said. On a
 * resume they are filed only if the vault has none yet.
 */
export async function createCompanyVault(
  doors: CreateVaultDoors, resume?: Hex, info?: VaultInfoGiven,
): Promise<VaultCreated> {
  let tidied: VaultInfoGiven | undefined;
  if (info !== undefined) {
    try {
      tidied = vaultInfoTidied(info);
    } catch (e) {
      throw new VaultInfoRefused(`No vault was built: ${(e as Error).message} Nothing was sent.`, { cause: e });
    }
  }
  let vault = resume;
  if (vault === undefined) {
    doors.progress?.('checking the committee');
    /* Refused before the deploy, so a seat that could not raise the vault's adoption spends no fee on a vault it cannot start. */
    const may = await seatMayRaise(doors);
    if (may !== null) throw new VaultNotBuilt(may.code, `No vault was built: ${may.says} Nothing was sent.`);
    const holders = await theCommitteeAVaultIsBornHeldBy(doors);
    if (doors.builder.bornHeldVault === undefined) {
      throw new VaultNotBuilt(NOT_BUILT.pageOutOfDate, 'this page cannot build a vault held by the company from the start. Reload it to get the current version.');
    }
    doors.progress?.('building the vault');
    const built = await doors.builder.bornHeldVault({ account: doors.account, holders });
    doors.progress?.('sending the vault');
    try {
      vault = (await doors.service.deploy(built.tx)).vault;
    } catch (e) {
      if (sentNothing(e)) throw e;
      throw new VaultStartOwed(built.vault as Hex, `the vault may have been sent (${(e as Error)?.message ?? e}).`);
    }
    /* The vault carried on is the one this device built and sent, never another address the service answers with. */
    if (String(vault).toLowerCase() !== String(built.vault).toLowerCase()) {
      throw new VaultStartOwed(built.vault as Hex, 'the service answered with another vault than the one this device sent, so '
        + 'nothing is carried on with that one.');
    }
  }
  const sentVault: Hex = vault;
  try {
    await readBornHeld(doors, sentVault);
    if (tidied !== undefined) doors.progress?.('filing the name');
    const notNamed = tidied === undefined ? null : await vaultInfoFiledOnceItIsTheCompanys(doors, sentVault, tidied);
    const done = await startCompanyVault(doors, sentVault);
    if (notNamed === null) return done;
    return { ...done, said: [notNamed.says, ...(done.said ?? [])], saidCodes: [notNamed.code, ...(done.saidCodes ?? []).filter((c) => c !== notNamed.code)] };
  } catch (e) {
    /* The vault exists from here on: whatever else fails names it, so the page offers to carry it on and never to create another. */
    if (e instanceof VaultStartOwed || e instanceof VaultNotTheCompanys) throw e;
    throw new VaultStartOwed(sentVault, (e as Error)?.message ?? String(e));
  }
}

/**
 * Files a new vault's name and description, as `fileVaultInfoHere` does, with
 * the seat, keys and entry its proposals are filed with. Never throws: a name
 * not filed is said, and the vault's creation carries on.
 */
async function vaultInfoFiledOnceItIsTheCompanys(
  doors: CreateVaultDoors, vault: Hex, info: VaultInfoGiven,
): Promise<{ readonly says: string; readonly code: SaidCode } | null> {
  const notFiled = (why: string): { readonly says: string; readonly code: SaidCode } => ({
    says: `This vault was created without its name and description: ${why} An admin names it later.`, code: SAID.nameNotFiled,
  });
  if (doors.vaultInfo === undefined) return notFiled('this page cannot file them. Reload it to get the current version.');
  const p = doors.proposals;
  try {
    await fileVaultInfoHere(
      { accountId: p.accountId, companyKeys: p.companyKeys, signingSecret: p.signingSecret, directory: p.directory, entered: p.entered, records: doors.vaultInfo },
      { vault, name: info.name, description: info.description, over: null },
    );
    return null;
  } catch (e) {
    if (e instanceof VaultInfoChanged) {
      return { says: 'This vault already has a name, given before this press, so the one given here was not filed.', code: SAID.nameGivenBefore };
    }
    const why = String((e as Error)?.message ?? e).replace(/^This vault's name was not filed: /u, '')
      .replace(/\s*Nothing was filed\.\s*$/u, '').replace(/([^.])$/u, '$1.');
    return notFiled(why);
  }
}

/** A read that did not answer within SERVICE_READ_BOUND_MS, on its own or as the cause of a vault not read here. */
const ranOutOfTime = (e: unknown): boolean =>
  e instanceof ReadRanOutOfTime || (e instanceof VaultNotReadHere && e.cause instanceof ReadRanOutOfTime);

/**
 * Why this seat may not raise a proposal of the company's, as a kind and a
 * sentence, or null: its entry in
 * the company's directory as this device reads it, a seat this device believes
 * by the one rule every reader judges a filing by (`seatNotBelievedHere`), with a
 * role that may file one (`mayFile`). A record filed by any other seat is believed by
 * no device, so its raise is refused here before anything is sent.
 */
async function seatMayRaise(doors: CreateVaultDoors): Promise<SeatRefusal | null> {
  const here = await doors.proposals.directory();
  return seatRefusalIn(doors.proposals, here);
}

/**
 * Refuses a start, before anything is raised, for a vault or a company account whose circuits are not the ones this
 * app was built with, or whose read does not say: the account would otherwise adopt a vault this app then never starts.
 * The read is the vault worker's at the wallet's indexer, with the account named; who holds either is not asked. A read
 * that runs out of time is asked again within the wait.
 */
async function refuseCircuitsNotThisBuilds(doors: CreateVaultDoors, vault: Hex): Promise<void> {
  const read = await untilReadHere(doors, async () => {
    try {
      return await readHere(doors, vault, doors.account);
    } catch (e) {
      if (ranOutOfTime(e)) return RAN_OUT;
      if (e instanceof VaultNotReadHere) throw new VaultStartOwed(vault, (e as Error).message, START_READ_STOP.chainUnread);
      throw e;
    }
  });
  if (read === RAN_OUT) throw new VaultStartOwed(vault, `${NOT_READ_IN_TIME} Nothing was sent.`, START_READ_STOP.chainUnread);
  if (read === null) throw new VaultStartOwed(vault, `${NO_VAULT_YET} Nothing was sent.`);
  if (!read.onChain) throw new VaultStartOwed(vault, `${NO_VAULT_YET} Nothing was sent.`);
  const circuits = circuitsOfARead(read);
  if (circuits !== null) throw new VaultStartOwed(vault, `${circuits.why} Nothing was sent.`);
}

/**
 * **STEP 5: THE VAULT STARTED, FROM WHAT THE CHAIN SHOWS.** Each step is raised
 * only once the chain shows the one before, and a step the chain already shows
 * is passed over, so this runs again from wherever a press stopped.
 */
async function startCompanyVault(doors: CreateVaultDoors, vault: Hex): Promise<VaultCreated> {
  const noAsset = NO_ASSET;

  /* ---- a. the company's account adopts the vault ---- */
  doors.progress?.('adopting the vault');
  await refuseCircuitsNotThisBuilds(doors, vault);
  let at = await standingNow(doors, vault);
  /* What this press could not leave written down of the two setup proposals, said with whatever the press comes to; every sentence here is of that one kind. */
  const said: string[] = [];
  const sayIt = (sentence: string | null): void => { if (sentence !== null && !said.includes(sentence)) said.push(sentence); };
  const saying = (): { readonly said?: readonly string[]; readonly saidCodes?: readonly SaidCode[] } =>
    (said.length === 0 ? {} : { said: [...said], saidCodes: [SAID.proposalNotWrittenDown] });
  const adoption = adoptionRound(doors, vault, at.standing.adoption, 'Add a new vault to the company');
  /* Whatever the chain shows, the adoption it holds is written down and entered. */
  if (at.standing.adopted || at.standing.adoption.open) sayIt(await proposedAndWrittenDown(doors, vault, adoption));
  if (!at.standing.adopted) {
    const a = at.standing.adoption;
    const governance = { kind: 'adopt-vault', vault } as const;
    const opened: OpenedRound = {
      chainId: a.proposal, digest: a.payload, vault: a.named, salt: a.salt,
      summary: 'Add a new vault to the company', governance,
    };
    if (a.stale) {
      throw new VaultStartOwed(vault, STALE_ADOPTION, START_STOP.adoptionStale);
    }
    /* No adoption this device raises, approves or carries out leaves the new vault, or any other, unable to pay. */
    try {
      refuseLeavingAVaultShort(await doors.approvers(), { kind: 'adopt', vault }, doors.vaultName);
    } catch (e) {
      throw new VaultStartOwed(vault, `${(e as Error).message.replace(/ Nothing was approved\.$/u, '')} Nothing was sent.`, START_STOP.tooFewApprovers);
    }
    if (!a.open) {
      sayIt(await proposedAndWrittenDown(doors, vault, adoption, {
        order: { circuit: 'propose', adoption: governance, half: nothingMoves(noAsset, a.salt), proposal: a.proposal },
        opened: { ...opened, half: { assetId: noAsset, changeAmount: '0', changeBatchDigest: ZERO_HEX } },
        heldNow: async () => { const n = await standingNow(doors, vault); return n.standing.adopted || n.standing.adoption.open; },
      }));
      at = await untilTheChainShows(doors, vault, 'raising its adoption', (n) => n.standing.adoption.open || n.standing.adopted);
    }
    /* The raise counted as its raiser's approval when the raiser may approve, so this seat approves only when the chain does not count it yet. */
    if (!at.standing.adopted && at.standing.adoption.approvals < at.standing.adoption.needed
      && !approvedHere(vault, at.standing.adoption, 'its adoption')) {
      await accountStep(doors, vault, at.chain, 'adoption',
        { circuit: 'approve', proposal: a.proposal, of: { governance, proposalSalt: a.salt } }, opened, 'approving its adoption');
      at = await untilTheChainShows(doors, vault, 'approving its adoption',
        (n) => n.standing.adopted || n.standing.adoption.approvedHere === true);
    }
    if (!at.standing.adopted) {
      const now = at.standing.adoption;
      if (now.approvals < now.needed) {
        doors.progress?.('waiting for approvals');
        return { vault, state: 'awaiting-approvals', awaiting: { round: 'adoption', proposal: a.proposal as Hex, approvals: now.approvals, needed: now.needed }, ...saying() };
      }
      await accountStep(doors, vault, at.chain, 'adoption',
        { circuit: 'adopt', vault, proposal: a.proposal, proposalSalt: a.salt }, opened, 'adopting it');
      await untilTheChainShows(doors, vault, 'adopting it', (n) => n.standing.adopted);
    }
  }
  sayIt(await carriedOutWrittenDown(doors, vault, adoption));

  /* ---- b to d. the pool, the nonce secret, its first run set and every sealed copy written ---- */
  const awaiting = await secretStartedHere(doors, vault, sayIt);
  if (awaiting !== null) return { vault, state: 'awaiting-approvals', awaiting, ...saying() };
  doors.progress?.('done');
  return { vault, state: 'started', ...saying() };
}
