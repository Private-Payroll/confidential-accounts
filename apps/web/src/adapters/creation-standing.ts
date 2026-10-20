import {
  api, canOpenCompanies, companyAwaitingItsSecondPress, companyBeingCreated, companyBeingCreatedLabel, companyCreationStanding, currentUser,
  keptCreationShowsItsKeyCommitted, walletShowsPayKeyCommitted, type CompanyCreationState,
} from 'vaults-web-shared/keyring.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { ACCOUNT_ORIGIN } from './session.js';

/*
 * A COMPANY'S CREATION STATE, FOR EVERY SCREEN. The service's read of the chain says where the company stands and
 * only leads; it is FINISHED only when the person's wallet, reading the account itself, shows its pay-record key
 * committed. For a company this browser keeps, the wallet is asked about the label and account this browser kept; for
 * another, about the pair the service names, which is the service's word. With the saved keys shut nothing is
 * confirmed, because a kept creation cannot be seen. A screen asks here and nowhere else, and is handed codes.
 */

/** Where the service keeps a company's account. */
const SERVICE = { company: '/api/accounts/' } as const;

/** The mark a company carries in a list. Only this one exists: a company without it is shown as every other. */
export const CREATION_MARK = { notFinished: 'not-finished' } as const;
type CreationMark = (typeof CREATION_MARK)[keyof typeof CREATION_MARK];

/** Which stage a company waits on, in the order it passes them: its account on the network, the account finished, its pay-record key sealed, then the network showing that to the wallet; `read` when where it stands is not known. */
export const STAGE = { deploy: 'deploy', finish: 'finish', key: 'key', shown: 'shown', read: 'read' } as const;
export type Stage = (typeof STAGE)[keyof typeof STAGE];

/**
 * What each standing the service can name means here, the one list: whether the company still owes the chain a step
 * (it carries the mark), whether the next step is built from what this browser keeps so shut saved keys must be opened
 * first, and the stage it waits on while the chain works.
 */
export const CREATION_STANDINGS: Readonly<Record<CompanyCreationState, { owesTheChain: boolean; needsTheKeys: boolean; stage: Stage }>> = {
  'not-created': { owesTheChain: false, needsTheKeys: true, stage: STAGE.read },
  'deploy-sent': { owesTheChain: true, needsTheKeys: false, stage: STAGE.deploy },
  'deploy-expired': { owesTheChain: true, needsTheKeys: true, stage: STAGE.deploy },
  'finish-owed': { owesTheChain: true, needsTheKeys: false, stage: STAGE.finish },
  'finish-expired': { owesTheChain: true, needsTheKeys: true, stage: STAGE.finish },
  'finish-sent': { owesTheChain: true, needsTheKeys: false, stage: STAGE.finish },
  'pay-key-owed': { owesTheChain: true, needsTheKeys: true, stage: STAGE.key },
  finished: { owesTheChain: false, needsTheKeys: true, stage: STAGE.shown },
  unknown: { owesTheChain: false, needsTheKeys: false, stage: STAGE.read },
};

export interface CompanyCreation {
  /** The company this answer is about, or null when there is none to ask about. */
  company: string | null;
  /** Where the service reads the creation, or null when it could not be read. */
  standing: CompanyCreationState | null;
  /** This browser holds the company's creation, waiting for the second press in the wallet. */
  awaitingSecondPress: boolean;
  /** This browser holds the company's creation at all, whatever it waits for. */
  kept: boolean;
  /** The service says finished and the wallet's own read of the account shows the pay-record key committed. */
  confirmedFinished: boolean;
  /** The mark the company carries in a list, or null for none. */
  mark: CreationMark | null;
}

interface Read {
  standing: CompanyCreationState;
  confirmed: boolean;
  /** Every read it rests on was answered, so it is kept for the rest of the sign-in. */
  settled: boolean;
}

let reads: { signIn: object | null; byCompany: Map<string, Promise<Read | null>> } = { signIn: null, byCompany: new Map() };

/** What was read since this sign-in; signing out, signing in again, or another person signing in, starts from nothing. */
const readsForThisSignIn = (): Map<string, Promise<Read | null>> => {
  const signIn = currentUser();
  if (reads.signIn !== signIn) reads = { signIn, byCompany: new Map() };
  return reads.byCompany;
};

/** Puts one company's reading away, for a creation step that moved it on; with no id, the creation this browser keeps. */
export function creationChanged(companyId: string | null): void {
  const id = companyId ?? companyBeingCreated();
  if (id !== null) readsForThisSignIn().delete(id);
}

/** True only when the wallet's own read shows the pay-record key committed on the company's account (the kept one for a kept creation); null when the wallet could not be asked. */
async function walletShowsTheKeyCommitted(companyId: string): Promise<boolean | null> {
  try {
    if (companyBeingCreated() === companyId) return await keptCreationShowsItsKeyCommitted(companyId, ACCOUNT_ORIGIN);
    const sealed = (await api(SERVICE.company + companyId)) as { companyLabel?: unknown; contractAddress?: unknown } | null;
    if (typeof sealed?.companyLabel !== 'string' || typeof sealed.contractAddress !== 'string') return null;
    return await walletShowsPayKeyCommitted(ACCOUNT_ORIGIN, sealed.companyLabel as CompanyLabel, sealed.contractAddress as AccountAddress);
  } catch {
    return null;
  }
}

async function readOnce(companyId: string): Promise<Read | null> {
  let standing: CompanyCreationState;
  try {
    ({ state: standing } = await companyCreationStanding(companyId));
  } catch {
    return null;
  }
  if (standing !== 'finished') return { standing, confirmed: false, settled: true };
  /* With the saved keys shut a kept creation cannot be seen, so nothing is confirmed on the service's pair; read again once they are open. */
  if (!canOpenCompanies()) return { standing, confirmed: false, settled: false };
  const committed = await walletShowsTheKeyCommitted(companyId);
  return { standing, confirmed: committed === true, settled: committed !== null };
}

function readOf(companyId: string): Promise<Read | null> {
  if (currentUser() === null) return Promise.resolve(null);
  const held = readsForThisSignIn();
  const had = held.get(companyId);
  if (had !== undefined) return had;
  const read = readOnce(companyId);
  held.set(companyId, read);
  void read.then((r) => { if (r === null || !r.settled) { if (held.get(companyId) === read) held.delete(companyId); } });
  return read;
}

/** The label the wallet drew for the creation this browser keeps (for that company, or whichever is kept with null): the keyring's own, read when shown. */
export const keptCreationLabel = (companyId: string | null): string | null => companyBeingCreatedLabel(companyId);

/**
 * Where a company's creation stands: with no id, the creation this browser keeps.
 * The service and the wallet are each read once for a company while the person
 * stays signed in (a new sign-in starts again), until `creationChanged` puts that reading away; what this
 * tab keeps is read fresh every time. A read that failed gives no mark and
 * confirms nothing. Never moves money and never sends anything.
 */
export async function creationOf(companyId: string | null): Promise<CompanyCreation> {
  const id = companyId ?? companyBeingCreated();
  if (id === null) return { company: null, standing: null, awaitingSecondPress: false, kept: false, confirmedFinished: false, mark: null };
  const read = await readOf(id);
  const kept = companyBeingCreated() === id;
  const awaitingSecondPress = kept && companyAwaitingItsSecondPress()?.accountId === id;
  const standing = read?.standing ?? null;
  const owed = standing !== null && (CREATION_STANDINGS[standing].owesTheChain || (standing === 'not-created' && kept));
  return {
    company: id, standing, awaitingSecondPress, kept,
    confirmedFinished: read?.confirmed === true, mark: owed ? CREATION_MARK.notFinished : null,
  };
}
