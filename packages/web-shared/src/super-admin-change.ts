/**
 * **A CHANGE OF THE SUPER ADMINS, RAISED, JOINED, APPROVED AND FINISHED ON A DEVICE.** One more kind of proposal
 * (`governance-from-the-chain.ts` dispatches to it), and never a proposal on the account: the super admins'
 * approvals are their wallets' signatures on each contract's maintenance update, counted only where they verify under
 * that contract's committee on the chain. Nothing here holds or reads a seat's secret, so a page with no seat runs it.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { whyNotInstallable, type SuperAdminChangeOnTheWire } from 'midnight-identity/profile/request';
import { superAdminChangeBytes } from 'midnight-identity/profile/committee-sign';
import { readAccountAddress, readCompanyLabel, type AccountAddress, type CompanyLabel } from 'midnight-identity/profile/company-label';
import type { ContractAuthority } from 'midnight-identity/profile/contract-authority';
import { sameCommittee } from '../../../src/midnight/vault-committee.js';
import {
  authorityHere, committeeWarning, superAdminsSeenHere,
  type SuperAdminChangeInProgress, type SuperAdminsSeen,
} from './committee-here.js';
import type { FromTheChainDoors } from './governance-from-the-chain.js';
import {
  PROPOSAL_FILE_FORMAT, proposalFileRefusal, signatureListRefusal, type JoiningSignature, type ProposalFile, type SuperAdminSignature,
} from './proposal-file.js';
import type { CommitteeReads } from './committee-reads.js';
import type { SuperAdminLedger } from './super-admin-ledger.js';
import { watchedOnTheChain } from './watched-on-the-chain.js';

type Key = { readonly tag: string; readonly value: string };

const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** What the person asks to change: the committee every contract of the company is to hold, in order, and its threshold. */
export interface SuperAdminsAskedFor {
  readonly change: { readonly kind: 'super-admins'; readonly committee: readonly Key[]; readonly threshold: number };
  /** The company's label, which every wallet derives its key for the company from. */
  readonly company: string;
  /** The company's account, by its address. */
  readonly account: string;
  readonly summary: string;
}

/**
 * **WHAT A CHANGE OF THE SUPER ADMINS ASKS OF THIS DEVICE.** Every fact is read
 * at the indexer the person's own wallet names (`chain`) or asked of their own
 * wallet; the company's service is only a way to send, and to fetch
 * signatures each device checks for itself. Nothing here needs a seat in the
 * company, its records or a sign-in with its service.
 */
export interface SuperAdminDoors {
  /** The chain, read at the indexer the person's own wallet names (`committee-reads.ts`). */
  readonly chain: CommitteeReads;
  /** The ledger's part: the very bytes each contract's update is signed over, and its signature checks (`super-admin-ledger.ts`). */
  readonly ledger: SuperAdminLedger;
  /** Every vault the company's own records say it created, where this device holds those records; empty where it does not. */
  readonly createdByTheCompany: readonly string[];
  /** The seats this device believes, to name a committee key beside the seat whose opening proves it; empty where it holds none. */
  readonly seats: Parameters<typeof superAdminsSeenHere>[1]['seats'];
  readonly wallet: {
    /** This person's key for the company, as their own wallet gives it. */
    readonly key: (company: { readonly company: CompanyLabel; readonly account: AccountAddress }) => Promise<Key>;
    /**
     * One press: the wallet signs the update of every contract named, at its
     * counter, at each place its key holds. Asked only once every key the
     * change adds has signed it. The ask carries the change whole and its
     * salt, from which the wallet rebuilds the bytes (`superAdminChangeBytes`)
     * and compares them with `bytes`; and `joined`, every joining key's
     * signature over them, which the wallet checks against the joins it works
     * out from each contract's committee as it reads the chain itself. Who
     * holds each contract is never sent: the wallet reads it.
     */
    readonly signUpdates: (ask: {
      readonly company: CompanyLabel; readonly account: AccountAddress;
      readonly salt: string; readonly change: SuperAdminChangeOnTheWire;
      readonly bytes: Uint8Array; readonly joined: readonly JoiningSignature[];
      readonly contracts: ReadonlyArray<{ readonly contract: 'account' | 'vault'; readonly address: string; readonly counter: string }>;
    }) => Promise<{ readonly signer: Key; readonly signatures: ReadonlyArray<{ readonly address: string; readonly counter: string; readonly seat: number; readonly signature: Key }> }>;
    /**
     * A joining key signs the change with its own key: the wallet rebuilds the
     * bytes from the change and its salt, compares them with `bytes`, and
     * shows who joins and leaves each contract as it reads the chain itself.
     */
    readonly signJoin: (ask: {
      readonly company: CompanyLabel; readonly account: AccountAddress;
      readonly salt: string; readonly change: SuperAdminChangeOnTheWire; readonly bytes: Uint8Array;
    }) => Promise<{ readonly signer: Key; readonly signature: string }>;
  };
  /**
   * The company's service: the one way a maintenance update is sent and paid
   * for today, and a place signatures may be fetched from. Whatever it says,
   * a send is believed only when the chain shows it, and a signature it hands
   * over counts only where it verifies. Each send carries the change whole,
   * its salt and every joining key's signature, so the service can refuse an
   * update whose joins are not all signed.
   */
  readonly service?: {
    readonly send: (update: {
      readonly address: string; readonly counter: string;
      readonly to: { readonly committee: readonly Key[]; readonly threshold: number };
      readonly signatures: ReadonlyArray<{ readonly index: number; readonly signature: Key }>;
      readonly change: {
        readonly company: string; readonly salt: string; readonly change: SuperAdminChangeOnTheWire;
        readonly joined: readonly JoiningSignature[];
      };
    }) => Promise<unknown>;
    readonly collected?: () => Promise<readonly SuperAdminSignature[]>;
  };
  readonly watch?: FromTheChainDoors['watch'];
  readonly random?: (n: number) => Uint8Array;
}

export const isSuperAdminFile = (file: ProposalFile): boolean => (file.change as { kind?: unknown } | undefined)?.kind === 'super-admins';

const sameKey = (a: Key, b: Key): boolean => a.tag.toLowerCase() === b.tag.toLowerCase() && a.value.toLowerCase() === b.value.toLowerCase();
const keyAt = (keys: readonly Key[], k: Key): boolean => keys.some((x) => sameKey(x, k));

/** The change's identity: the hash of its bytes. */
const superAdminChangeId = (company: string, account: string, salt: string, change: SuperAdminChangeOnTheWire): string =>
  hexOf(sha256(superAdminChangeBytes(company, account, salt, change)));

/**
 * **THE KEYS A CHANGE OF THE SUPER ADMINS PUTS ON A CONTRACT**: every key of
 * the committee it installs that the committee holding some contract still to
 * move, as the chain holds it now, does not hold - in the installed order.
 * Read from the chain and never from the committee a file says it replaces,
 * so a stale or altered file cannot put a key on a contract unsigned.
 */
export const joiningKeys = (
  committee: readonly Key[], holders: ReadonlyArray<{ readonly committee: readonly Key[] }>,
): readonly Key[] => committee.filter((k) => holders.some((h) => !keyAt(h.committee, k)));

/** Why nothing goes further while joining keys are missing, in words for the person. */
const joinsHeld = (n: number): string => `${n} joining key${n === 1 ? ' has' : 's have'} not signed the change with ${n === 1 ? 'its' : 'their'} own key`;

/** The update one contract is moved by: the committee installed, signed at the counter the chain holds it at. */
const updateBytes = (doors: Pick<SuperAdminDoors, 'ledger'>, address: string, counter: bigint, change: SuperAdminChangeOnTheWire): Promise<Uint8Array> =>
  doors.ledger.updateBytes({ vault: address, counter, to: { committee: change.committee, threshold: change.threshold } });

/**
 * **THE SIGNATURES THAT COUNT FOR ONE CONTRACT NOW**: each at the counter the
 * chain holds the contract at, at a place on the committee holding it on the
 * chain, verifying under that place's key over that contract's update - one
 * per place, in increasing order. Anything else, from any device or the
 * service, counts for nothing.
 */
async function countedFor(
  doors: Pick<SuperAdminDoors, 'ledger'>, change: SuperAdminChangeOnTheWire, address: string, now: ContractAuthority,
  signatures: readonly SuperAdminSignature[],
): Promise<ReadonlyArray<{ readonly index: number; readonly signature: Key }>> {
  const data = await updateBytes(doors, address, now.counter, change);
  const byIndex = new Map<number, Key>();
  for (const s of signatures) {
    if (s.address.toLowerCase() !== address || s.counter !== now.counter.toString() || byIndex.has(s.index)) continue;
    const key = now.committee[s.index];
    if (key === undefined) continue;
    if (await doors.ledger.signedBy(key, data, s.signature)) byIndex.set(s.index, { tag: s.signature.tag, value: s.signature.value });
  }
  return [...byIndex].sort(([a], [b]) => a - b).map(([index, signature]) => ({ index, signature }));
}

/** Where one contract of a change of the super admins stands, as this device read it off the chain. */
export interface SuperAdminContractStanding {
  readonly contract: 'account' | 'vault';
  readonly address: string;
  /**
   * `current`: it holds the change's committee at a counter past the one the
   * change named for it. `waiting`: not enough
   * signatures count yet. `ready`: enough count. `sent`: sent and shown on
   * the chain. `not-shown`: sent, and the chain does not show it yet.
   * `moved`: its counter moved and it does not hold the change's committee, so
   * every signature at the old counter is spent. `unreadable`: the chain could
   * not be asked who holds it.
   */
  readonly state: 'current' | 'waiting' | 'ready' | 'sent' | 'not-shown' | 'moved' | 'unreadable';
  readonly have: number;
  readonly required: number;
  readonly why: string | null;
}

/** Where a change of the super admins stands, read on this device: every device reads the same from the chain and the file. */
export interface SuperAdminChangeProgress {
  /** The super admins and the company's contracts as this device shows them, the change in progress included. */
  readonly seen: SuperAdminsSeen;
  /** Joining keys, read from each contract's committee on the chain, that have not signed the change themselves: no wallet signs, nothing counts ready and nothing is sent while any is listed. */
  readonly joinsMissing: readonly Key[];
  readonly contracts: readonly SuperAdminContractStanding[];
  /** Every contract of the company, read from the chain now, that the change does not name and that does not hold its committee. */
  readonly leftOut: readonly string[];
  /** True once every contract the change names holds its committee at a counter past the one named for it, and every other contract of the company, read from the chain now, holds that committee. */
  readonly done: boolean;
  /** Why nothing more was sent from here, in words for the person; null when nothing held it back. */
  readonly held: string | null;
}

export interface SuperAdminChangeRaised {
  /** The file to hand to the joining keys' holders and the other super admins. Nothing was sent. */
  readonly file: ProposalFile;
  readonly seen: SuperAdminsSeen;
  /** Keys the change puts on any contract it names, read from each one's committee on the chain: each must sign it with its own key before any wallet signs an update. */
  readonly joining: readonly Key[];
  /** Said, never refused: one key left, or every key needed (`committeeWarning`). */
  readonly warnings: readonly string[];
}

export interface SuperAdminChangeApproved extends SuperAdminChangeProgress {
  /** The file with this device's signatures added, to hand on. */
  readonly file: ProposalFile;
  /** Whether this person's wallet was asked: false when they hold no place, at the chain's counter, on any contract still to move. */
  readonly asked: boolean;
}

/** One contract a change names, as this device read it: `confirmed` when the account's lists or the company's own records here show it is the company's. */
interface NamedContract {
  readonly contract: 'account' | 'vault';
  readonly address: string;
  /** The counter the change names for it. */
  readonly counter: string;
  readonly authority: ContractAuthority | null;
  readonly why: string | null;
  readonly current: boolean;
  readonly confirmed: boolean;
}

/** The change in progress as `superAdminsHere` compares contracts with it. */
const inProgressOf = (change: SuperAdminChangeOnTheWire): SuperAdminChangeInProgress => ({
  committee: change.committee.map((k) => ({ tag: k.tag, value: k.value.toLowerCase() })),
  threshold: change.threshold,
  contracts: change.contracts.map((c) => ({ address: c.address, counter: BigInt(c.counter) })),
});

/** The company and account a file names, read as a wallet takes them, or refused. */
function companyOf(file: Pick<ProposalFile, 'company' | 'account'>): { company: CompanyLabel; account: AccountAddress } {
  const company = readCompanyLabel(file.company);
  const account = readAccountAddress(file.account?.toLowerCase());
  if (company === null || account === null) throw new Error('the company is not named by its label and its account\'s address. Nothing was built or sent');
  return { company, account };
}

/**
 * **A CHANGE OF THE SUPER ADMINS RAISED ON THIS DEVICE.** The committee asked
 * for must pass the one install rule; the person must be a super admin, their
 * own wallet's key on the account's committee as the chain holds it at their
 * wallet's indexer; every contract the company has made is read there, and
 * every one is named with its counter, the account first, those already
 * holding the committee asked for too. Nothing is sent: the file is handed to every joining key's
 * holder, who signs it with their own key, and to the super admins. No seat,
 * signer, signers' threshold or roster is read.
 */
export async function raiseSuperAdminChange(doors: SuperAdminDoors, input: SuperAdminsAskedFor): Promise<SuperAdminChangeRaised> {
  const { company, account } = companyOf({ company: input.company, account: input.account });
  const to = { committee: input.change.committee.map((k) => ({ tag: k.tag, value: k.value.toLowerCase() })), threshold: input.change.threshold };
  const notInstallable = whyNotInstallable(to);
  if (notInstallable !== null) throw new Error(`${notInstallable} Nothing was raised`);
  const mine = await doors.wallet.key({ company, account });
  const seen = await superAdminsSeenHere(doors.chain, {
    account, createdByTheCompany: doors.createdByTheCompany, inProgress: null, seats: doors.seats, ownWalletKey: mine,
  });
  if (!seen.iAmOne) {
    throw new Error('the key your wallet gives for this company is not on the committee holding its account, as your wallet\'s indexer shows it, '
      + 'so you are not one of its super admins and cannot raise a change of them. Nothing was raised');
  }
  const unreadable = seen.contracts.find((c) => c.authority === null);
  if (unreadable !== undefined) {
    throw new Error(`the chain could not be asked who holds vault ${unreadable.address} (${unreadable.why ?? 'no answer'}), so a change `
      + 'cannot name every contract of the company. Nothing was raised. Try again when your wallet\'s indexer can read it');
  }
  const moving = seen.contracts.filter((c) => c.authority !== null && !sameCommittee(c.authority, to));
  if (moving.length === 0) throw new Error('every contract of this company already holds that committee. Nothing was raised');
  /*
   * Every contract of the company is named, the account first, those already
   * holding the committee asked for too: each gets its update, so landing the
   * change moves every counter and no update signed for an earlier change can
   * still land on any of them.
   */
  const named = seen.contracts;
  const change: SuperAdminChangeOnTheWire = {
    kind: 'super-admins',
    from: { committee: seen.superAdmins.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: seen.superAdmins.threshold },
    committee: to.committee, threshold: to.threshold,
    contracts: named.map((c) => ({ contract: c.contract, address: c.address, counter: c.authority!.counter.toString() })),
  };
  const random = doors.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const salt = hexOf(random(32));
  const file: ProposalFile = {
    format: PROPOSAL_FILE_FORMAT, company, account, change, salt, chainId: superAdminChangeId(company, account, salt, change),
    summary: input.summary, joined: [], signatures: [],
  };
  const why = proposalFileRefusal(file);
  if (why !== null) throw new Error(`${why}. Nothing was raised`);
  const warning = committeeWarning(to);
  return { file, seen, joining: joiningKeys(to.committee, named.map((c) => c.authority!)), warnings: warning === null ? [] : [warning] };
}

/**
 * **A FILE'S CHANGE OF THE SUPER ADMINS, CHECKED AGAINST THE CHAIN AT THE
 * PERSON'S OWN WALLET'S INDEXER**: the file's shape and identity; every
 * joining signature it carries verifying over the change's bytes under the key
 * it names, which must be one the change installs; and the committee holding
 * the account on the chain being the one the change says it replaces at the
 * counter it was raised at, or the one it installs one counter on.
 * The joining keys are each contract's to-be committee less the committee the
 * chain holds it at now. Each contract it names is read there; one that is
 * not the company's as the account's lists and the company's own records on
 * this device find it is still read and counted, so nothing is sent while it
 * lacks its signatures, but this device never asks its wallet to sign it and
 * never sends it: a device holding the company's records does.
 */
async function superAdminChangeAgainstTheChain(doors: SuperAdminDoors, file: ProposalFile, mine: Key | null) {
  const why = proposalFileRefusal(file);
  if (why !== null) throw new Error(`${why}. Nothing was built or sent`);
  const change = file.change as SuperAdminChangeOnTheWire;
  const { company, account } = companyOf(file);
  if (superAdminChangeId(company, account, file.salt, change) !== file.chainId.toLowerCase()) {
    throw new Error('the change in this file is not the one its identity names. Nothing was built or sent. Do not approve it; ask the super admin who raised it');
  }
  const bytes = superAdminChangeBytes(company, account, file.salt, change);
  for (const j of file.joined ?? []) {
    if (!keyAt(change.committee, j.key)) throw new Error('the file carries a signature from a key the change does not add. Nothing was built or sent. Do not approve it');
    if (!(await doors.ledger.joinedBy(bytes, j.key, j.signature))) {
      throw new Error('a joining key\'s signature in the file is not its signature over this change. Nothing was built or sent. Do not approve it; ask its holder to sign the change again');
    }
  }
  const seen = await superAdminsSeenHere(doors.chain, {
    account, createdByTheCompany: doors.createdByTheCompany, inProgress: inProgressOf(change), seats: doors.seats, ownWalletKey: mine,
  });
  /*
   * The change is the account's next one only while the account sits at the
   * counter it was raised at, held by the committee it replaces, or has just
   * taken it, one counter on: a change that ran or was turned down is never
   * taken again, whatever committee the account has come back to since.
   */
  const raisedAt = BigInt(change.contracts[0]!.counter);
  const atFrom = sameCommittee(seen.superAdmins, change.from) && seen.superAdmins.counter === raisedAt;
  const atTo = sameCommittee(seen.superAdmins, { committee: change.committee, threshold: change.threshold }) && seen.superAdmins.counter === raisedAt + 1n;
  if (!atFrom && !atTo) {
    throw new Error('the company\'s account, as your wallet\'s indexer shows it, is not held by the committee this change says it replaces, at the counter '
      + 'it was raised at, nor by the committee it installs one counter on. Nothing was built or sent. Do not approve it; ask the super admin who raised it');
  }
  /*
   * Every change names every contract of the company. One this device finds on
   * the chain - the account's lists, or the company's own records here - that
   * the change leaves out, and that does not hold the change's committee, could
   * still take an update signed for an earlier change, so nothing is signed,
   * joined or sent for this one.
   */
  const inTheChange = new Set(change.contracts.map((c) => c.address.toLowerCase()));
  const leftOut = seen.contracts.filter((c) => !c.current && !inTheChange.has(c.address.toLowerCase())).map((c) => c.address);
  if (leftOut.length > 0) {
    throw new Error(`this change leaves out vault ${leftOut.join(' and vault ')}, which the company has on the chain and which is not held by `
      + 'the committee the change installs. Every change names every contract of the company. Nothing was signed or sent. Do not approve it; '
      + 'ask the super admin who raised it to raise a change that names every contract');
  }
  const found = new Map(seen.contracts.map((c) => [c.address, c]));
  const to = { committee: change.committee, threshold: change.threshold };
  /* A contract the change moved: it holds the change's committee at a counter past the one the change named for it. */
  const movedTo = (a: ContractAuthority | null, raised: string): boolean => a !== null && sameCommittee(a, to) && a.counter > BigInt(raised);
  const named: NamedContract[] = [];
  for (const c of change.contracts) {
    const f = found.get(c.address);
    if (f !== undefined) {
      named.push({ contract: f.contract, address: f.address, counter: c.counter, authority: f.authority, why: f.why, current: movedTo(f.authority, c.counter), confirmed: true });
      continue;
    }
    const authority = await authorityHere(doors.chain, c.address);
    named.push({
      contract: c.contract, address: c.address, counter: c.counter, authority, confirmed: false,
      why: authority === null ? 'the indexer your wallet names holds no contract there that can be read' : null,
      current: movedTo(authority, c.counter),
    });
  }
  const holders = named.flatMap((c) => (c.authority === null || c.current ? [] : [c.authority]));
  const joining = joiningKeys(change.committee, holders);
  const joinsMissing = joining.filter((k) => !(file.joined ?? []).some((j) => sameKey(j.key, k)));
  return { company, account, change, bytes, seen, named, joining, joinsMissing };
}

/**
 * **A JOINING KEY'S HOLDER SIGNS THE CHANGE WITH THAT KEY**, on their own
 * device: the file checked against the chain, their wallet's key for the
 * company being one the change adds, and their wallet asked to sign the
 * change's bytes exactly, after it shows who joins and leaves and the
 * threshold. The signature is checked here before it is added. Returns the
 * file to hand on; nothing is sent.
 */
export async function joinFromAFile(doors: SuperAdminDoors, file: ProposalFile): Promise<ProposalFile> {
  if (!isSuperAdminFile(file)) throw new Error('only a change of the super admins is joined with a key\'s own signature. Nothing was signed');
  const { company, account } = companyOf(file);
  const mine = await doors.wallet.key({ company, account });
  const { change, bytes, joining } = await superAdminChangeAgainstTheChain(doors, file, mine);
  if (!keyAt(joining, mine)) {
    throw new Error('the key your wallet gives for this company is not one this change adds, so there is nothing for you to sign as a joining key. Nothing was signed');
  }
  const signed = await doors.wallet.signJoin({ company, account, salt: file.salt, change, bytes });
  if (!sameKey(signed.signer, mine) || !(await doors.ledger.joinedBy(bytes, mine, signed.signature.toLowerCase()))) {
    throw new Error('the wallet did not sign this change with the key it gives for this company, so nothing was added. Nothing was sent');
  }
  return {
    ...file,
    joined: [...(file.joined ?? []).filter((j) => !sameKey(j.key, mine)), { key: { tag: mine.tag, value: mine.value.toLowerCase() }, signature: signed.signature.toLowerCase() }],
  };
}

/**
 * **A SUPER ADMIN'S ONE PRESS**: the file checked against the chain; refused,
 * with no wallet asked, while any key the change puts on a contract has not
 * signed the change itself; then their wallet asked once to sign the update
 * of every contract still to move on whose committee, as the chain holds it
 * now, their key sits at a place not yet signed, at that contract's counter
 * now, the ask carrying the change's bytes and its joining signatures. A key's standing to sign a
 * contract's update is being on that contract's committee on the chain and
 * nothing else. Then the change is taken as far as it can go
 * (`resumeFromAFile`), so the device whose signature completes it sends it.
 */
export async function approveSuperAdminChange(doors: SuperAdminDoors, file: ProposalFile): Promise<SuperAdminChangeApproved> {
  const { company, account } = companyOf(file);
  const mine = await doors.wallet.key({ company, account });
  const { change, bytes, named, joinsMissing } = await superAdminChangeAgainstTheChain(doors, file, mine);
  if (joinsMissing.length > 0) {
    throw new Error(`${joinsHeld(joinsMissing.length)}, so your wallet is not asked to sign any contract's update: a key nobody holds is never put on `
      + 'the company\'s contracts. Hand the file to each joining key\'s holder first. Nothing was signed or sent');
  }
  const held = file.signatures ?? [];
  const toSign: Array<{ contract: 'account' | 'vault'; address: string; counter: string }> = [];
  for (const c of named) {
    if (c.authority === null || c.current || !c.confirmed) continue;
    const counted = new Set((await countedFor(doors, change, c.address, c.authority, held)).map((s) => s.index));
    const places = c.authority.committee.flatMap((k, i) => (sameKey(k, mine) && !counted.has(i) ? [i] : []));
    if (places.length > 0) toSign.push({ contract: c.contract, address: c.address, counter: c.authority.counter.toString() });
  }
  let next = file;
  if (toSign.length > 0) {
    const signed = await doors.wallet.signUpdates({
      company, account, salt: file.salt, change, bytes, joined: file.joined ?? [], contracts: toSign,
    });
    if (!sameKey(signed.signer, mine)) throw new Error('the wallet signed with a key other than the one it gives for this company, so nothing was kept. Nothing was sent');
    const added = signed.signatures.map((s) => ({
      address: s.address.toLowerCase(), counter: s.counter, index: s.seat, signature: { tag: s.signature.tag, value: s.signature.value },
    }));
    const listed = signatureListRefusal(added);
    if (listed !== null) throw new Error(`the wallet's answer could not be read: ${listed}. Nothing was kept or sent`);
    const fresh = (s: SuperAdminSignature) => !added.some((a) => a.address === s.address && a.counter === s.counter && a.index === s.index);
    next = { ...file, signatures: [...held.filter(fresh), ...added] };
  }
  return { file: next, asked: toSign.length > 0, ...(await resumeFromAFile(doors, next)) };
}

/**
 * **A CHANGE OF THE SUPER ADMINS TAKEN AS FAR AS IT CAN GO FROM THIS DEVICE**,
 * from the file it holds and the signatures the service hands over, each
 * counted only where it verifies (`countedFor`). Nothing is sent while a
 * joining key has not signed the change itself, or any contract still to move
 * lacks its committee's threshold of signatures at its counter now. Then the
 * account's update is sent first through the company's service, the one way a
 * maintenance update is sent today, and believed only once the account reads
 * current at the wallet's indexer; only then is each vault's sent, one at a
 * time, each judged the same way. A send the chain does not show stops the
 * rest; reading the file again later finishes it from any super admin's
 * device, and a contract that already moved is never sent again.
 */
export async function resumeFromAFile(doors: SuperAdminDoors, file: ProposalFile): Promise<SuperAdminChangeProgress> {
  if (!isSuperAdminFile(file)) throw new Error('only a change of the super admins is finished from this device this way. Nothing was sent');
  const { company, account } = companyOf(file);
  const mine = await doors.wallet.key({ company, account }).catch(() => null);
  const { account: accountRead, change, seen, named, joinsMissing } = await superAdminChangeAgainstTheChain(doors, file, mine);
  let fromService: readonly SuperAdminSignature[] = [];
  if (doors.service?.collected !== undefined) {
    try {
      const got = await doors.service.collected();
      if (Array.isArray(got) && signatureListRefusal(got) === null) fromService = got;
    } catch { /* the service's signatures are a convenience: without them, the file's are counted alone */ }
  }
  const all = [...(file.signatures ?? []), ...fromService];
  const standing = new Map<string, SuperAdminContractStanding>();
  const counted = new Map<string, ReadonlyArray<{ readonly index: number; readonly signature: Key }>>();
  for (const c of named) {
    if (c.authority === null) {
      standing.set(c.address, { contract: c.contract, address: c.address, state: 'unreadable', have: 0, required: 0, why: c.why });
      continue;
    }
    if (c.current) {
      standing.set(c.address, { contract: c.contract, address: c.address, state: 'current', have: 0, required: 0, why: null });
      continue;
    }
    const list = await countedFor(doors, change, c.address, c.authority, all);
    counted.set(c.address, list);
    const moved = c.authority.counter.toString() !== c.counter;
    const enough = list.length >= c.authority.threshold;
    standing.set(c.address, {
      contract: c.contract, address: c.address, have: list.length, required: c.authority.threshold,
      /* Signatures on an update never make it ready while a joining key has not signed the change. */
      state: enough && joinsMissing.length === 0 ? 'ready' : moved && !enough ? 'moved' : 'waiting',
      why: enough && joinsMissing.length > 0
        ? 'it has its super admins\' signatures, and waits for every joining key to sign the change with its own key'
        : !c.confirmed
        ? 'it is not one this device can confirm as the company\'s, so it is signed and sent from a device holding the company\'s records'
        : moved && list.length < c.authority.threshold
          ? 'it was changed since the change was raised, so its update must be signed again at its counter now'
          : null,
    });
  }
  const order = named.map((c) => c.address);
  let sentAny = false;
  const result = async (heldBack: string | null): Promise<SuperAdminChangeProgress> => {
    const contracts = order.map((a) => standing.get(a)!);
    /* Read again after anything was sent, so what is shown is the chain as it stands now. */
    const shownNow = sentAny ? await superAdminsSeenHere(doors.chain, {
      account: accountRead, createdByTheCompany: doors.createdByTheCompany, inProgress: inProgressOf(change), seats: doors.seats, ownWalletKey: mine,
    }) : seen;
    /* Every contract of the company as the chain shows it now, so a vault the change left out keeps it from being done. */
    const leftOut = shownNow.contracts.filter((c) => !c.current && !order.includes(c.address)).map((c) => c.address);
    const done = contracts.every((c) => c.state === 'current' || c.state === 'sent') && shownNow.behind.length === 0;
    const notNamed = leftOut.map((a) => `vault ${a} is not in this change and is not held by its committee on the chain, so the company is not done. `
      + 'Raise a change that names it').join('; ');
    return { seen: shownNow, joinsMissing, contracts, leftOut, done, held: heldBack ?? (notNamed === '' ? null : notNamed) };
  };
  const pending = order.filter((a) => !['current', 'sent'].includes(standing.get(a)!.state));
  if (pending.length === 0) return result(null);
  if (joinsMissing.length > 0) {
    return result(`${joinsHeld(joinsMissing.length)}, so nothing is sent: a key nobody holds is never put on the company's contracts`);
  }
  if (pending.some((a) => standing.get(a)!.state !== 'ready')) {
    return result('not every contract still to move has enough of its super admins\' signatures, so nothing is sent yet');
  }
  if (doors.service === undefined) return result('the company\'s service is not reachable from this page, and it is the one way a change is sent today');
  let leftForTheRecords: string | null = null;
  for (const address of pending) {
    /* The account is first in the change, and a send the chain does not show stops every one after it. */
    const s = standing.get(address)!;
    const c = named.find((x) => x.address === address)!;
    if (!c.confirmed) {
      leftForTheRecords = `vault ${address} is not one this device can confirm as the company's, so a device holding the company's records sends it`;
      continue;
    }
    const before = c.authority!;
    const list = counted.get(address)!;
    if (signatureListRefusal(list.map((x) => ({ address, counter: before.counter.toString(), ...x }))) !== null) {
      return result('the signatures for a contract could not be put in order, so nothing more was sent');
    }
    try {
      await doors.service.send({
        address, counter: before.counter.toString(), to: { committee: change.committee, threshold: change.threshold }, signatures: list,
        change: { company, salt: file.salt, change, joined: file.joined ?? [] },
      });
    } catch { /* what the service says is not believed either way: the chain is read below */ }
    const after = await watchedOnTheChain(doors, async () => {
      const now = await authorityHere(doors.chain, address);
      return now !== null && now.counter !== before.counter ? now : null;
    });
    sentAny = true;
    if (after === null) {
      standing.set(address, { ...s, state: 'not-shown', why: 'it was handed to the company\'s service, and the chain, as your wallet\'s indexer shows it, does not show it yet' });
      return result('a change handed to the company\'s service does not show on the chain yet, so nothing after it was sent. Open the file again in a few minutes to finish it');
    }
    if (!sameCommittee(after, { committee: change.committee, threshold: change.threshold })) {
      standing.set(address, { ...s, state: 'moved', why: 'another change landed on it first, so this change\'s signatures for it are spent' });
      return result('a contract was changed by another change first, so nothing after it was sent');
    }
    sentAny = true;
    standing.set(address, { ...s, state: 'sent' });
  }
  return result(leftForTheRecords);
}
