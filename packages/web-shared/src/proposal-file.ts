/**
 * **A PROPOSAL FILE**: what a proposal raised from the chain carries from one device to the next, and the one check of
 * its shape every device runs before anything in it is believed. Nothing here reads the chain or holds a key.
 */
import type { ResumesFrom } from '../../../src/midnight/record-tree.js';
import type { GovernanceOnTheWire } from './governed-call-builder.js';
import { whyNotInstallable, type SuperAdminChangeOnTheWire } from 'midnight-identity/profile/request';
import { readCompanyLabel } from 'midnight-identity/profile/company-label';

/** What names a proposal file, so a file of any other kind is never read as one. */
export const PROPOSAL_FILE_FORMAT = 'confidential-accounts/proposal-file/v1';

/**
 * **A GOVERNANCE PROPOSAL, AS ITS RAISER HANDS IT TO THE OTHER SIGNERS**: the
 * company and its account, the change and the salt the proposal was raised
 * with, its identity on chain, the words the person is shown, and what the
 * change's own check reads beside it - for a recovery of the record anchor,
 * the header it resumes from. A recovery's change also names the head the
 * latest recovery carried out wrote, which the approvals bind. Nothing in it is believed: the identity is made
 * again from the change and the salt, and the chain must hold it open.
 */
export interface ProposalFile {
  readonly format: typeof PROPOSAL_FILE_FORMAT;
  /** The company as its records name it; for a change of the super admins, the company's label, which wallets derive their keys from. */
  readonly company: string;
  readonly account: string;
  readonly change: GovernanceOnTheWire | SuperAdminChangeOnTheWire;
  readonly salt: string;
  readonly chainId: string;
  readonly summary: string;
  /** A recovery's: the header it resumes from, whose head its change names; the change also names the last time it may be carried out. */
  readonly resumesFrom?: ResumesFrom;
  /** A change of the super admins only: each joining key's signature over the change, made with that key. */
  readonly joined?: readonly JoiningSignature[];
  /** A change of the super admins only: the wallets' signatures on each contract's maintenance update, as collected so far. */
  readonly signatures?: readonly SuperAdminSignature[];
}

type Key = { readonly tag: string; readonly value: string };

/** A joining key's own signature over the change's bytes: proof that somebody holds the key before it is put on any contract. */
export interface JoiningSignature { readonly key: Key; readonly signature: string }

/** One wallet's signature on one contract's maintenance update, at one place on the committee holding that contract. */
export interface SuperAdminSignature {
  readonly address: string;
  /** The contract's counter it was signed at, in decimal. */
  readonly counter: string;
  /** The place on the contract's committee whose key made it. */
  readonly index: number;
  readonly signature: Key;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const KINDS = new Set(['add-signer', 'threshold', 'vault-threshold', 'spending-policy', 'policy-bar', 'recover-anchor', 'super-admins']);
const HEX = /^[0-9a-f]+$/u;
const HEX128 = /^[0-9a-f]{128}$/u;
const DIGITS = /^[0-9]{1,20}$/u;

/**
 * **WHY THIS IS NOT A PROPOSAL FILE THIS DEVICE CAN READ, OR NULL WHEN IT IS.**
 * Read before anything of it is used; every value is checked again against the
 * chain before anything is built.
 */
export function proposalFileRefusal(f: unknown): string | null {
  const x = f as Partial<ProposalFile> | null;
  if (typeof x !== 'object' || x === null || x.format !== PROPOSAL_FILE_FORMAT) {
    return 'this file is not a proposal handed over by a signer of a company. Ask the signer who raised it to send the file again';
  }
  if (typeof x.company !== 'string' || x.company.length === 0) return 'the file names no company. Ask the signer who raised it to send it again';
  for (const [name, v] of [['account', x.account], ['salt', x.salt], ['identity', x.chainId]] as const) {
    if (typeof v !== 'string' || !HEX64.test(v)) return `the proposal's ${name} in the file is not thirty-two bytes. Ask the signer who raised it to send it again`;
  }
  if (typeof x.summary !== 'string') return 'the file says nothing of what the proposal changes. Ask the signer who raised it to send it again';
  const change = x.change as { kind?: unknown } | undefined;
  if (typeof change !== 'object' || change === null || !KINDS.has(String(change.kind))) {
    return 'the file names a change this page does not carry out. Reload the page to use the current version, then open the file again';
  }
  const superAdmins = change.kind === 'super-admins';
  if (!superAdmins && (x.joined !== undefined || x.signatures !== undefined)) {
    return 'the file carries super admins\' signatures on a signers\' proposal, which never carries or counts them. Do not approve it; ask the signer who raised it';
  }
  if (superAdmins) return superAdminFileRefusal(x);
  if (change.kind === 'recover-anchor') {
    const r = x.resumesFrom as Partial<ResumesFrom> | undefined;
    const head = (change as { resumesFrom?: unknown }).resumesFrom;
    if (r === undefined || !Number.isSafeInteger(r.seq) || r.seq! < 0 || typeof r.head !== 'string' || !HEX64.test(r.head)
      || typeof r.root !== 'string' || !HEX64.test(r.root)) {
      return 'the file does not say which batch of the company\'s records the recovery resumes from. Ask the signer who raised it to send it again';
    }
    if (typeof head !== 'string' || head !== r.head) {
      return 'the batch the file says the recovery resumes from is not the one its change names. Do not approve it; ask the signer who raised it';
    }
    const latest = (change as { latest?: unknown }).latest;
    if (typeof latest !== 'string' || !/^[1-9][0-9]*$/u.test(latest)) {
      return 'the file does not say until when the recovery may be carried out. Ask the signer who raised it to send it again';
    }
    const lastRecovery = (change as { lastRecovery?: unknown }).lastRecovery;
    if (typeof lastRecovery !== 'string' || !HEX64.test(lastRecovery)) {
      return 'the file does not say which recovery of the company\'s records was the latest carried out when it was raised. '
        + 'Ask the signer who raised it to send it again';
    }
  }
  return null;
}

/** The file's text, as a signer saves and sends it. */
export const proposalFileText = (f: ProposalFile): string => `${JSON.stringify(f, null, 2)}\n`;

/** A proposal file read from its text, or refused in words that say what to do (`proposalFileRefusal`). */
export function proposalFileRead(text: string): ProposalFile {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    throw new Error('this file could not be read as a proposal. Ask the signer who raised it to send the file again');
  }
  const why = proposalFileRefusal(parsed);
  if (why !== null) throw new Error(why);
  return parsed as ProposalFile;
}

/** Why this file's change of the super admins cannot be read, or null when its shape can. Nothing in it is believed yet. */
function superAdminFileRefusal(x: Partial<ProposalFile>): string | null {
  const c = x.change as Partial<SuperAdminChangeOnTheWire>;
  const ask = 'Ask the super admin who raised it to send it again';
  if (readCompanyLabel(x.company) === null) return `the file does not name the company by its label. ${ask}`;
  const keysOk = (keys: unknown): boolean => Array.isArray(keys) && keys.every((k) => typeof k === 'object' && k !== null
    && typeof (k as Key).tag === 'string' && typeof (k as Key).value === 'string' && HEX.test((k as Key).value));
  const from = c.from as Partial<SuperAdminChangeOnTheWire['from']> | undefined;
  if (typeof from !== 'object' || from === null || !keysOk(from.committee) || !Number.isSafeInteger(from.threshold)) {
    return `the file does not say who held the company's account when the change was raised. ${ask}`;
  }
  /* The one install rule every door that installs a committee asks. */
  const notInstallable = whyNotInstallable({ committee: c.committee, threshold: c.threshold });
  if (notInstallable !== null) return `the committee the file names cannot be installed: ${notInstallable}`;
  const contracts = c.contracts;
  if (!Array.isArray(contracts) || contracts.length === 0 || !contracts.every((k, i) => typeof k === 'object' && k !== null
    && (k.contract === 'account') === (i === 0 && k.address === x.account) && (k.contract === 'account' || k.contract === 'vault')
    && typeof k.address === 'string' && HEX64.test(k.address) && typeof k.counter === 'string' && DIGITS.test(k.counter))) {
    return `the file does not name each contract the change moves, the account first, with its counter. ${ask}`;
  }
  if (new Set(contracts.map((k) => k.address)).size !== contracts.length) return `the file names one contract twice. ${ask}`;
  if (x.joined !== undefined && (!Array.isArray(x.joined) || !x.joined.every((j) => typeof j === 'object' && j !== null
    && keysOk([j.key]) && typeof j.signature === 'string' && HEX128.test(j.signature)))) {
    return `a joining key's signature in the file cannot be read. ${ask}`;
  }
  if (x.signatures !== undefined && (!Array.isArray(x.signatures) || signatureListRefusal(x.signatures) !== null)) {
    return `a super admin's signature in the file cannot be read. ${ask}`;
  }
  return null;
}

/**
 * **WHY A LIST OF SIGNATURES IS NOT ONE THIS DEVICE READS OR SENDS**, or null:
 * a list with a gap or an empty place in it, or an entry that is not a
 * signature at a whole place on a committee. This guards this device's own
 * reading of a file or of what the service hands over. It is not what keeps a
 * gapped list off the chain: the ledger's own update class packs every list
 * this device sends, and the ledger's decoding already refuses a list whose
 * places are not all below its length.
 */
export function signatureListRefusal(list: readonly unknown[]): string | null {
  if (!Array.isArray(list)) return 'the signatures are not a list';
  for (let i = 0; i < list.length; i += 1) {
    if (!(i in list)) return 'the list of signatures has a gap in it';
    const s = list[i] as Partial<SuperAdminSignature> | null;
    if (typeof s !== 'object' || s === null || typeof s.address !== 'string' || !HEX64.test(s.address.toLowerCase())
      || typeof s.counter !== 'string' || !DIGITS.test(s.counter) || !Number.isSafeInteger(s.index) || s.index! < 0
      || typeof s.signature !== 'object' || s.signature === null || typeof s.signature.tag !== 'string'
      || typeof s.signature.value !== 'string' || !HEX.test(s.signature.value)) {
      return 'an entry in the list of signatures is not a signature on a contract\'s update';
    }
  }
  return null;
}
