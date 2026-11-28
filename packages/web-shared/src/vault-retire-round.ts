/**
 * **A VAULT RETIRED FROM THE COMPANY'S ACCOUNT: RAISED, APPROVED AND CARRIED OUT FROM THIS DEVICE.** A retire is a
 * change to the company, approved at the company's threshold, and carried out by the vault itself, which marks itself
 * retired, so it takes no deposit from then on, and asks the account to retire it, whatever it still holds. What it
 * holds stays payable. This device refuses before raising or carrying only while it keeps a deposit into the vault or a
 * payment out of it on its way; it shows each approver what the vault holds and the runs open on it, as that approver's
 * own device reads them. Its facts come from the chain as the
 * person's own wallet reads it, and from the company's sealed records this device opens and believes; the service only
 * carries records and calls.
 */
import {
  RETIRE_VAULT,
  retireProposalIn,
  runVaultIn,
  sealGovernanceProposal
} from '../../../src/core/proposal-filing.js';
import { NO_ASSET } from '../../../src/core/assets.js';
import { adoptionSaltOf } from '../../../src/midnight/vault-start.js';
import { ADOPTED_AGAIN_SINCE, adoptionAlreadyClosed } from './vault-adopt-again.js';
import { signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import type { SealedProposal } from '../../../src/core/types.js';
import type { CreateVaultDoors } from './vault-doors.js';
import type { RoundOnChain } from './governed-call-builder.js';
import { handedOver, type HandOver } from './hand-over.js';
import type { MoneyOnChain } from './money-on-chain.js';
import { lowerHex, saidWithoutStop } from './vault-info-here.js';
import { kindAsked, listedHere } from './vault-page-doors.js';
import { chainAtOneBlockHere, moneyHeldHere, theWalletsIndexer } from './vault-read-here.js';
import { ViewEnded } from './company-view.js';
import {
  RAN_OUT,
  ZERO_HEX,
  nothingMoves,
  proposedAndWrittenDown,
  randomHex,
  untilReadHere,
  type StartRound
} from './vault-start-steps.js';

/** What the company's records and the chain call a vault's retire. */
const RETIRE_SUMMARY = 'Retire a vault';

/** A retire this device does not raise, approve or carry out, and why, with what clears it: a sentence, so it starts in capitals. */
export class RetireRefused extends Error {
  constructor(why: string) {
    super(why.charAt(0).toUpperCase() + why.slice(1));
    this.name = 'RetireRefused';
  }
}

/** One kept item on its way into or out of a vault, as this device keeps it; null when there is none. */
interface KeptHere {
  get(vault: Hex): Promise<unknown | null>;
}

/** Everything a retire needs besides a vault's start, all of it on this device or through the company's service. */
export interface RetireDoors extends CreateVaultDoors {
  /** Sends a seat's approval of a proposal through the company's service. */
  readonly approveSent: (proposalId: string, body: { readonly tx: string; readonly filer: string }) => Promise<unknown>;
  /** Asks the service to write a proposal the chain closed down as carried out. */
  readonly closedSent?: (
    proposalId: string,
    body: { readonly filer: string; readonly how: 'carried' }
  ) => Promise<unknown>;
  /** A deposit into a vault and a payment out of it that this device keeps on their way; absent where none is kept here. */
  readonly inFlight?: { readonly deposits: KeptHere; readonly payments: KeptHere };
  /** Whether this device holds the key to prove a circuit of the vault; every circuit where absent. */
  readonly proves?: (circuit: string) => boolean;
}

/** What a person reads when this wallet cannot yet send the vault's retire, and what clears it. */
const CANNOT_YET = 'This wallet cannot retire this vault yet. It needs an update first. Nothing was sent.';

/** Refuses, before anything is built or sent, when this device holds no key to prove the vault's retire. */
const refuseUnprovable = (doors: RetireDoors): void => {
  if (doors.proves === undefined || doors.proves('retire')) return;
  throw new RetireRefused(CANNOT_YET);
};

/** The vault and the company's record of its retire, by the record's name. */
export interface RetireNamed {
  readonly vault: Hex;
  readonly proposal: string;
}

const keptOnItsWay = async (kept: KeptHere | undefined, vault: Hex): Promise<boolean> =>
  kept !== undefined && (await kept.get(vault)) !== null;
const governanceOf = (vault: Hex) => ({ kind: 'retire-vault', vault }) as const;

/** The retire's round, its identity and payload made in the worker by the account's own functions from the vault and the salt. */
async function retireRoundOf(
  doors: CreateVaultDoors,
  vault: Hex,
  salt: Hex
): Promise<StartRound & { readonly noVault: Hex }> {
  const id = await doors.builder.proposalIdentity(governanceOf(vault), salt);
  return {
    what: 'raising its retire',
    called: 'retire',
    chainId: lowerHex(id.chainId),
    digest: lowerHex(id.digest),
    salt,
    noVault: lowerHex(id.noVault),
    seal: (key) =>
      sealGovernanceProposal({
        accountId: doors.proposals.accountId,
        viewingKey: key,
        kind: RETIRE_VAULT,
        summary: RETIRE_SUMMARY,
        noVault: lowerHex(id.noVault),
        body: { vault },
        change: { asset: NO_ASSET, amount: 0n, batchDigest: ZERO_HEX as Hex, salt },
        proposedBy: doors.me.signerId
      })
  };
}

/** The company's records of this vault's retire that this device opens and believes, newest first. */
async function retireRecordsHere(
  doors: CreateVaultDoors,
  vault: Hex
): Promise<Array<{ readonly rec: SealedProposal; readonly salt: Hex }>> {
  const p = doors.proposals;
  let listed: SealedProposal[];
  try {
    const [served, here] = await Promise.all([
      p.service.sealedProposals(p.accountId),
      p.directory(kindAsked('proposal'))
    ]);
    listed = listedHere(here, 'proposal', served, 'proposal').filter((r) => r.accountId === p.accountId);
  } catch (e) {
    throw new RetireRefused(
      `the company's proposals could not be read (${saidWithoutStop(e)}). Nothing was sent. Reload the page and try again.`
    );
  }
  return listed
    .flatMap((rec) => {
      const o = retireProposalIn(rec, p.accountId, p.companyKeys);
      return o === null || o.vault !== vault ? [] : [{ rec, salt: o.salt }];
    })
    .sort((a, b) => String(b.rec.createdAt).localeCompare(String(a.rec.createdAt)));
}

/** Where the retire stands on the chain, read through the person's own wallet's indexer, with this seat's approval. */
async function roundHere(doors: CreateVaultDoors, vault: Hex, chainId: Hex): Promise<RoundOnChain> {
  try {
    const indexer = await theWalletsIndexer(doors, vault);
    const read = await doors.builder.roundsOnChain({
      account: lowerHex(String(doors.account)),
      indexer,
      chainIds: [chainId],
      seat: doors.material.signingSecret
    });
    const r = read[chainId];
    if (r !== undefined) return r;
  } catch (e) {
    throw new RetireRefused(
      `where the vault's retire stands could not be read from the network (${saidWithoutStop(e)}). Nothing was sent. Press again in a minute.`
    );
  }
  throw new RetireRefused(
    "the network read did not say where the vault's retire stands. Nothing was sent. Press again in a minute."
  );
}

/**
 * Refuses while this device keeps a deposit into the vault or a payment out of it on its way, which pressing Deposit or
 * Pay on this vault again settles first (`settleDepositInFlight`, `settlePaymentInFlight`). What the vault holds is never
 * a reason: a retire gives up whatever its signers approved it giving up, and it all stays payable.
 */
async function nothingOnItsWay(doors: RetireDoors, vault: Hex): Promise<void> {
  if (await keptOnItsWay(doors.inFlight?.deposits, vault)) {
    throw new RetireRefused(
      'your wallet holds a deposit into this vault that it has not yet seen land or fail. Nothing was sent. Press ' +
        'Deposit on this vault again, which settles the one on its way first, then retire it.'
    );
  }
  if (await keptOnItsWay(doors.inFlight?.payments, vault)) {
    throw new RetireRefused(
      'your wallet holds a payment out of this vault that it has not yet seen land or fail. Nothing was sent. Press ' +
        'Pay on this vault again, which settles the one on its way first, then retire it.'
    );
  }
}

/**
 * How many runs open on the chain now are runs of this vault, by the company's records this device opens and believes;
 * null when the chain or the records could not be read, or when a run open on the chain has no record here this device
 * can open, since it may be a run of this vault.
 */
async function openRunsHere(doors: CreateVaultDoors, vault: Hex): Promise<number | null> {
  const p = doors.proposals;
  try {
    const indexer = await theWalletsIndexer(doors, vault);
    const [open, served, here] = await Promise.all([
      doors.builder.runsOutrun({ account: lowerHex(String(doors.account)), indexer }),
      p.service.sealedProposals(p.accountId),
      p.directory(kindAsked('proposal'))
    ]);
    const records = listedHere(here, 'proposal', served, 'proposal').filter((r) => r.accountId === p.accountId);
    let count = 0;
    for (const chainId of Object.keys(open).map(lowerHex)) {
      const named = records
        .filter((r) => lowerHex(String(r.chainId ?? '')) === chainId)
        .map((r) => runVaultIn(r, p.accountId, p.companyKeys));
      if (named.includes(vault)) count += 1;
      else if (!named.some((v) => v !== 'unopened' && v !== null)) return null;
    }
    return count;
  } catch (e) {
    if (e instanceof ViewEnded) throw e;
    /* Not passed over: a count that could not be read is shown to the approver as not read, never as none. */
    return null;
  }
}

/** What a retire gives up, as this device reads it now: what the vault holds on each side, and the runs open on it (null: not read). */
export interface RetireGivesUp {
  readonly money: MoneyOnChain;
  readonly openRuns: number | null;
}

/** What the retire `named` gives up, read by this device itself: the vault's holdings and the runs open on it. */
export async function retireGivesUpHere(doors: CreateVaultDoors, vault: Hex): Promise<RetireGivesUp> {
  const at = lowerHex(vault);
  const [money, openRuns] = await Promise.all([moneyHeldHere(doors, at), openRunsHere(doors, at)]);
  return { money, openRuns };
}

/** The person's own wallet's way straight to the chain, which a vault's retire and the calls before it go by; refused when there is none. */
function walletToChain(over: HandOver | undefined): NonNullable<HandOver['toChain']> {
  if (over?.refused !== undefined) throw new RetireRefused(`${over.refused}`);
  const toChain = over?.path === 'service' ? over.fallback?.toChain : over?.toChain;
  if (toChain === undefined) {
    throw new RetireRefused(
      "a vault's retire goes from your own wallet to the network, and this page reaches no wallet that sends one. " +
        'Nothing was sent. Retire the vault from your wallet.'
    );
  }
  return toChain;
}

/** The opened retire this device acts on: its record, its salt, its round made here, and where the chain holds it. */
interface RetireFound {
  readonly vault: Hex;
  readonly rec: SealedProposal;
  readonly salt: Hex;
  readonly round: Awaited<ReturnType<typeof retireRoundOf>>;
  readonly onChain: RoundOnChain;
}

/**
 * The company's record of this vault's retire under `named.proposal`, opened here, made again from its vault and salt,
 * and read off the chain. Refuses a record this device cannot open and believe, one withdrawn, and one whose identity
 * is not the retire this device makes from it.
 */
export async function retireFoundHere(doors: CreateVaultDoors, named: RetireNamed): Promise<RetireFound> {
  const vault = lowerHex(named.vault);
  const mine = (await retireRecordsHere(doors, vault)).find((r) => r.rec.id === named.proposal);
  if (mine === undefined) {
    throw new RetireRefused(
      "the company's records hold no retire of this vault under that name that your wallet can open and believe. " +
        'Nothing was sent. Reload the page.'
    );
  }
  if (mine.rec.status === 'cancelled') {
    throw new RetireRefused(
      "the company's records hold this retire withdrawn, so it is neither approved nor carried out. Nothing was sent."
    );
  }
  const round = await retireRoundOf(doors, vault, mine.salt);
  if (round.chainId !== lowerHex(mine.rec.chainId) || round.digest !== lowerHex(mine.rec.digest)) {
    throw new RetireRefused(
      "the company's record under that name is not the retire of this vault as your wallet makes it from its " +
        'vault and salt. Nothing was sent. Do not approve it.'
    );
  }
  return { vault, rec: mine.rec, salt: mine.salt, round, onChain: await roundHere(doors, vault, round.chainId) };
}

/**
 * The proposal that retired this vault, by the company's record of its retire, for adopting the vault again: the record
 * opened and made again here, and the chain showing it carried out, never withdrawn. Refuses any other.
 */
export async function retiredBy(doors: CreateVaultDoors, named: RetireNamed): Promise<Hex> {
  const found = await retireFoundHere(doors, named);
  const by = found.onChain.closedBy ?? [];
  if (found.onChain.held !== 'closed' || by.length === 0 || by.includes('cancel')) {
    throw new RetireRefused(
      'the network does not show this retire carried out, so the vault is not adopted again under it. Nothing was ' +
        'sent. Reload the page: a vault the company retired shows the retire that retired it.'
    );
  }
  const adoption = await doors.builder.proposalIdentity(
    { kind: 'adopt-vault', vault: found.vault },
    adoptionSaltOf(found.vault, found.round.chainId)
  );
  if (await adoptionAlreadyClosed(doors, found.vault, lowerHex(adoption.chainId)))
    throw new RetireRefused(ADOPTED_AGAIN_SINCE);
  return found.round.chainId;
}

/** Reads the retire again until `seen` holds, within the doors' wait; refuses once the wait is over. */
async function untilTheRetireShows(
  doors: CreateVaultDoors,
  found: RetireFound,
  what: string,
  seen: (r: RoundOnChain) => boolean
): Promise<RoundOnChain> {
  const got = await untilReadHere(doors, async () => {
    const r = await roundHere(doors, found.vault, found.round.chainId);
    return seen(r) ? r : null;
  });
  if (got === null || got === RAN_OUT) {
    throw new RetireRefused(
      `${what} was sent and the network has not shown it yet. Press again in a minute: what the network already shows is not sent again.`
    );
  }
  return got;
}

/**
 * **THE RETIRE RAISED FROM THIS DEVICE**, or the one the company's records already hold for this vault carried on.
 * The raiser's approval counts at the raise. It refuses first where this device holds no key to prove the vault's
 * retire, so no approval is spent on a retire it could never carry out. It then refuses while this device keeps money
 * on its way into or out of the vault (`nothingOnItsWay`), and refuses as the raise of any proposal refuses
 * (`proposedAndWrittenDown`). What the vault holds never stops it.
 * Returns the record's name, where the chain holds it, and a sentence when the record could not be written down.
 */
export async function retireRaisedHere(
  doors: RetireDoors,
  asked: Hex
): Promise<{ readonly found: RetireFound; readonly said: string | null }> {
  const vault = lowerHex(asked);
  refuseUnprovable(doors);
  await nothingOnItsWay(doors, vault);
  const standing = (await retireRecordsHere(doors, vault)).find(
    (r) => r.rec.status === 'open' || r.rec.status === 'approved'
  );
  const salt = standing?.salt ?? lowerHex(randomHex());
  const round = await retireRoundOf(doors, vault, salt);
  const held = async (): Promise<boolean> => (await roundHere(doors, vault, round.chainId)).held !== 'never';
  const governance = governanceOf(vault);
  const raise = (await held())
    ? undefined
    : {
        order: { circuit: 'propose', governance, half: nothingMoves(NO_ASSET, salt), proposal: round.chainId } as const,
        opened: {
          chainId: round.chainId,
          digest: round.digest,
          vault: round.noVault,
          salt,
          summary: RETIRE_SUMMARY,
          governance,
          half: { assetId: NO_ASSET, changeAmount: '0', changeBatchDigest: ZERO_HEX }
        },
        heldNow: held
      };
  const saidHere = await proposedAndWrittenDown(doors, vault, round, raise);
  const rec = (await retireRecordsHere(doors, vault)).find(
    (r) => lowerHex(r.rec.chainId) === round.chainId && r.rec.status !== 'cancelled'
  );
  if (rec === undefined) {
    throw new RetireRefused(
      `the retire is raised on the network and the company's records do not hold it yet${saidHere === null ? '' : ` (${saidWithoutStop(saidHere)})`}. ` +
        'Press again: the retire the network holds is carried on, not raised again.'
    );
  }
  const found = await retireFoundHere(doors, { vault, proposal: rec.rec.id });
  if (found.onChain.held !== 'never') return { found, said: saidHere };
  return {
    found: { ...found, onChain: await untilTheRetireShows(doors, found, 'the retire', (r) => r.held !== 'never') },
    said: saidHere
  };
}

/**
 * **THIS SEAT'S APPROVAL OF THE RETIRE**, sent once: `counted` when the chain already holds it, `carried-out` when the
 * chain closed the retire. Approving moves nothing, so it is not held back by money still in the vault.
 */
export async function approveRetireHere(
  doors: RetireDoors,
  named: RetireNamed
): Promise<'approved' | 'counted' | 'carried-out'> {
  const found = await retireFoundHere(doors, named);
  const r = found.onChain;
  if (r.held === 'closed') return 'carried-out';
  if (r.held === 'never')
    throw new RetireRefused('the network holds no retire of this vault raised. Nothing was sent. Reload the page.');
  if (r.approvedHere === true) return 'counted';
  const p = doors.proposals;
  const governance = governanceOf(found.vault);
  let tx: string;
  try {
    const chain = await p.service.callState(p.accountId);
    ({ tx } = await doors.builder.governedCall({
      account: chain.account,
      material: doors.material,
      chain,
      order: { circuit: 'approve', proposal: found.round.chainId, of: { governance, proposalSalt: found.salt } },
      opened: {
        chainId: found.round.chainId,
        digest: found.round.digest,
        vault: found.round.noVault,
        salt: found.salt,
        summary: RETIRE_SUMMARY,
        governance
      }
    }));
  } catch (e) {
    throw new RetireRefused(
      `approving the retire could not be built in your wallet (${saidWithoutStop(e)}). Nothing was sent.`
    );
  }
  const filer = signingPublicKeyOf(p.signingSecret).toLowerCase();
  await handedOver(doors.handOver, {
    tx,
    call: { kind: 'account-call', contract: String(doors.account), circuit: 'approve' },
    viaService: () => doors.approveSent(found.rec.id, { tx, filer }),
    after: async () => undefined
  });
  await untilTheRetireShows(
    doors,
    found,
    'approving the retire',
    (n) => n.approvedHere === true || n.held === 'closed'
  );
  return 'approved';
}

/**
 * **THE RETIRE CARRIED OUT BY THE VAULT ITSELF**, once the chain holds it at its bar: built here against one block of
 * both contracts, and sent from the person's own wallet to the chain with its fee paid, since the service relays no
 * retire. Waits, sending nothing, while it is short of approvals. Refuses where this device holds no key to prove the
 * vault's retire, and while this device keeps money on its way into or out of the vault; never for what the vault
 * holds. Writes the record down as carried out once the chain closed it.
 */
export async function carryRetireHere(
  doors: RetireDoors,
  named: RetireNamed
): Promise<
  { readonly state: 'carried-out'; readonly said: string | null } | { readonly state: 'waiting'; readonly said: null }
> {
  const found = await retireFoundHere(doors, named);
  const r = found.onChain;
  if (r.held === 'never')
    throw new RetireRefused('the network holds no retire of this vault raised. Nothing was sent. Reload the page.');
  if (r.held !== 'closed') {
    if (r.approvals < (r.needed ?? Number.POSITIVE_INFINITY)) return { state: 'waiting', said: null };
    if (r.outrun === true) {
      throw new RetireRefused(
        'a signer was removed or replaced after this retire was raised, so the account never carries it out. Nothing ' +
          'was sent. Withdraw it and raise the retire again.'
      );
    }
    refuseUnprovable(doors);
    await nothingOnItsWay(doors, found.vault);
    await retireSent(doors, found);
    await untilTheRetireShows(doors, found, 'the retire', (n) => n.held === 'closed');
  }
  const said = await retireWrittenDown(doors, found);
  return { state: 'carried-out', said };
}

/** Builds the vault's retire and sends it from the person's own wallet straight to the chain, its fee paid. */
async function retireSent(doors: RetireDoors, found: RetireFound): Promise<void> {
  const build = doors.builder.retire;
  if (build === undefined) throw new RetireRefused(CANNOT_YET);
  const toChain = walletToChain(doors.handOver);
  let tx: string;
  let account: Hex;
  try {
    const chain = await chainAtOneBlockHere(doors, found.vault);
    account = chain.account;
    ({ tx } = await build({ vault: found.vault, account, proposal: found.round.chainId, salt: found.salt, chain }));
  } catch (e) {
    throw new RetireRefused(`the retire could not be built in your wallet (${saidWithoutStop(e)}). Nothing was sent.`);
  }
  await toChain(tx, { kind: 'vault-retire', contract: found.vault, circuit: 'retire', account });
}

/** Writes the retire down as carried out; a sentence saying why it is not, or null. */
async function retireWrittenDown(doors: RetireDoors, found: RetireFound): Promise<string | null> {
  if (found.rec.status === 'executed' || doors.closedSent === undefined) return null;
  try {
    await doors.closedSent(found.rec.id, {
      filer: signingPublicKeyOf(doors.proposals.signingSecret).toLowerCase(),
      how: 'carried'
    });
    return null;
  } catch (e) {
    return `The vault is retired on the network, and the company's proposals still show its retire open: ${saidWithoutStop(e)}. Pressing again writes it down.`;
  }
}
