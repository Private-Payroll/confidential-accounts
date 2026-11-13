/**
 * **THE RECOVERY WINDOW: HOW FAR AHEAD A RECOVERY OF THE COMPANY'S RECORDS MAY BE CARRIED OUT, AS ITS SIGNERS CHOSE.**
 *
 * One company record, kind `policy`, id `recovery-window`, holds numbered changes, each naming a length in seconds
 * within `RECOVERY_WINDOW_RANGE`, the one place the window's range is defined. A change counts once signatures of seats
 * the chain holds reach the seat bar (`signedChangesInForce`, as the read grants count), each signed with its own seat's
 * filing key in its own wallet. Only a seat whose role files policy records (an admin, or a seat with no role set) may start
 * a new change; any seat may file the change again with its own signature added.
 *
 * The chain does not hold the window. Each signer's device holds it: a device refuses to raise or approve a recovery
 * that may be carried out further ahead than the window it read.
 *
 * Each version is sealed under a key of its own, wrapped to every seat the filing device believes and once under the
 * company's key for the `policy` purpose (`COMPANY_WRAP_ID`), so a seat admitted later, and a reader whose grant names
 * policy, open it with no filing again.
 */
import { canonical, fromHex, newSymmetricKey, parseCanonical, seal, unseal, unwrapKey, wrapKey, type Hex } from '../core/crypto.js';
import { mayFile } from '../core/roles.js';
import { keyForThePurpose, type RecordsKey } from '../core/sealed-records.js';
import { recordsKeypairFrom } from './company-nonce-secret.js';
import { COMPANY_WRAP_ID, type ServiceOpener } from './company-service-record.js';
import type { SealedCompanyRecord } from './sealed-record-wire.js';
import { companyRecordKey } from './seat-directory.js';
import { quorumOf } from './seat-quorum.js';
import { signedChangesInForce, type SignedChange, type SignedInForce, type SignedQuorum } from './signed-change-fold.js';
import { paddedToABucket, type PoolSigner } from './vault-pool.js';

export const RECOVERY_WINDOW_RECORD = Object.freeze({ kind: 'policy' as const, id: 'recovery-window' });

/** Whether a record key, as a retirement's boundary or the filing judge names one, is the recovery window's. */
export const isRecoveryWindowKey = (recordKey: string): boolean => recordKey === companyRecordKey(RECOVERY_WINDOW_RECORD.kind, RECOVERY_WINDOW_RECORD.id);

/** The shortest and the longest window a company may choose, in seconds. */
export const RECOVERY_WINDOW_RANGE = Object.freeze({ shortest: 60 * 60, longest: 30 * 24 * 60 * 60 });

/** The window of a company whose records name no window in force, in seconds: 7 days, inside the range. */
export const RECOVERY_WINDOW_WHEN_NONE = 7 * 24 * 60 * 60;

/**
 * The window a device holds for a company whose records, as it checked them, put no window in force: none filed, or
 * none signed at the bar. The one place this is decided; every sentence that says it reads it from here.
 */
export const windowWhenNoneInForce = (): number => RECOVERY_WINDOW_WHEN_NONE;

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

/** A length of time in words: whole days, else whole hours, else minutes. */
export const durationSaid = (seconds: number): string => {
  const [n, unit] = seconds % DAY === 0 ? [seconds / DAY, 'day'] : seconds % HOUR === 0 ? [seconds / HOUR, 'hour'] : [Math.floor(seconds / 60), 'minute'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
};

/** One change of the window: its number, its length in seconds, and the signatures over it. */
export interface WindowChange extends SignedChange {
  readonly seconds: number;
}

const DOMAIN = 'confidential-accounts/recovery-window/v1';

/** What each signer signs: the company, the change's number and its length. */
export const windowMessage = (company: string, change: { readonly sequence: number; readonly seconds: number }): string =>
  canonical({ domain: DOMAIN, company, sequence: change.sequence, seconds: change.seconds });

export const WINDOW_REFUSAL = {
  'not-opened': 'this version of the recovery window is not sealed to this device, or does not open, so it is not read here. A seat files the window again from its wallet.',
  'not-a-window': 'this version of the recovery window is not in the one shape a window is held in, so it is not believed. A seat whose role files policy starts the change again from its wallet.',
  'outside-the-range': `this version of the recovery window names a length outside ${durationSaid(RECOVERY_WINDOW_RANGE.shortest)} to ${durationSaid(RECOVERY_WINDOW_RANGE.longest)}, so it is not believed. A seat whose role files policy starts a change within it from its wallet.`,
  'not-the-next-change': 'this version of the recovery window is neither the change in force filed again nor the next change after it, so it is not believed. A seat files the change again from its wallet, on the window as it stands.',
  'started-by-a-seat-that-may-not': 'this version of the recovery window starts a change, and the seat that filed it is not one whose role files policy (an admin, or a seat with no role set), so it is not believed. A seat whose role files policy starts the change from its wallet.',
  'not-signed': 'a signature on this version of the recovery window does not verify, or one seat signed it twice, so it is not believed. Each signer signs the change again from their wallet.',
  'below-quorum': 'not enough of the company\'s signers have signed this change of the recovery window yet: it needs as many as a change of who is seated needs on the company\'s account. It counts once the other signers sign it in their own wallets.',
} as const;
export type WindowRefusal = keyof typeof WINDOW_REFUSAL;

/** Why a length is not a window a company may choose, or null. */
export const windowSecondsRefusal = (seconds: unknown): 'not-a-window' | 'outside-the-range' | null =>
  typeof seconds !== 'number' || !Number.isSafeInteger(seconds) ? 'not-a-window'
    : seconds < RECOVERY_WINDOW_RANGE.shortest || seconds > RECOVERY_WINDOW_RANGE.longest ? 'outside-the-range' : null;

/** Whether a value read from a version holds a change's three fields and nothing else. */
const windowShaped = (x: unknown): x is WindowChange => {
  if (typeof x !== 'object' || x === null) return false;
  const c = x as Partial<Record<keyof WindowChange, unknown>>;
  return canonical(Object.keys(x).sort()) === canonical(['seconds', 'sequence', 'signatures'])
    && typeof c.sequence === 'number' && Number.isSafeInteger(c.sequence) && c.sequence >= 1 && Array.isArray(c.signatures);
};

/** Why a change is not in the window's shape, or null. */
export const windowChangeRefusal = (change: WindowChange): 'not-a-window' | 'outside-the-range' | null =>
  (windowShaped(change) ? windowSecondsRefusal(change.seconds) : 'not-a-window');

export class RecoveryWindowRefused extends Error {
  constructor(why: string, options?: { cause?: unknown }) {
    super(why, options);
    this.name = 'RecoveryWindowRefused';
  }
}

interface WindowLabel { readonly record: 'policy'; readonly id: string; readonly company: string; readonly version: number }
const LABEL = '$label';

const companyWrapping = (key: RecordsKey, company: string) => recordsKeypairFrom(fromHex(keyForThePurpose(key, company, 'policy')));

/** One version of the window, sealed to `seats` and once under the company's key for the policy purpose. */
export const sealRecoveryWindow = (input: {
  readonly company: string; readonly version: number; readonly sealing: { readonly key: RecordsKey; readonly epoch: number };
  readonly change: WindowChange; readonly seats: readonly PoolSigner[];
}): SealedCompanyRecord => {
  const refused = windowChangeRefusal(input.change);
  if (refused !== null) throw new RecoveryWindowRefused(WINDOW_REFUSAL[refused]);
  if (input.seats.length === 0 || input.seats.some((s) => s.id === COMPANY_WRAP_ID)) {
    throw new RecoveryWindowRefused(`the recovery window is sealed to the seats the company holds, and none of them is named ${COMPANY_WRAP_ID}`);
  }
  const key = newSymmetricKey();
  const label: WindowLabel = { record: RECOVERY_WINDOW_RECORD.kind, id: RECOVERY_WINDOW_RECORD.id, company: input.company, version: input.version };
  return {
    company: input.company, kind: RECOVERY_WINDOW_RECORD.kind, id: RECOVERY_WINDOW_RECORD.id, version: input.version, keyEpoch: input.sealing.epoch,
    sealed: seal(paddedToABucket(canonical({ ...input.change, [LABEL]: label })), key),
    wrapped: [
      ...input.seats.map((s) => ({ signerId: s.id, wrapped: wrapKey(key, s.wrappingPublicKey) })),
      { signerId: COMPANY_WRAP_ID, wrapped: wrapKey(key, companyWrapping(input.sealing.key, input.company).publicKey) },
    ],
  };
};

/** The company's copy of a version, opened with the company's key at the version's epoch. */
export const windowOpenedWithTheCompanyKey = (company: string, keyAt: (epoch: number) => Hex): ServiceOpener['companyCopy'] =>
  (epoch, wrapped) => unwrapKey(wrapped, companyWrapping(keyAt(epoch), company).secret) as Hex;

/** One version opened: through this seat's own copy, else the company's; null when neither opens it. */
export const openRecoveryWindow = (rec: SealedCompanyRecord, me: ServiceOpener): WindowChange | null => {
  if (rec.kind !== RECOVERY_WINDOW_RECORD.kind || rec.id !== RECOVERY_WINDOW_RECORD.id || me.signerId === COMPANY_WRAP_ID) return null;
  const mine = rec.wrapped.find((w) => w.signerId === me.signerId);
  const companys = rec.wrapped.filter((w) => w.signerId === COMPANY_WRAP_ID);
  const copies = [
    ...(mine === undefined ? [] : [() => me.keyOf(mine.wrapped)]),
    ...(companys.length !== 1 ? [] : [() => me.companyCopy(rec.keyEpoch, companys[0]!.wrapped)]),
  ];
  for (const copy of copies) {
    let body: Record<string, unknown>;
    try {
      body = parseCanonical<Record<string, unknown>>(unseal(rec.sealed, copy()));
    } catch {
      // This copy does not open the version; the next copy is tried, and none opening reads as not opened.
      continue;
    }
    const label = body[LABEL] as Partial<WindowLabel> | undefined;
    if (label?.record !== rec.kind || label.id !== rec.id || label.company !== rec.company || label.version !== rec.version) return null;
    const { [LABEL]: _label, ...change } = body;
    return windowShaped(change) ? change : null;
  }
  return null;
};

/** One version as the fold reads it: its number, the filing key that filed it, and its change, or null when it did not open. */
export interface WindowVersion {
  readonly version: number;
  readonly filer: Hex | null;
  readonly change: WindowChange | null;
}

export type WindowInForce = SignedInForce<WindowVersion, WindowChange, WindowRefusal>;

/**
 * **THE WINDOW IN FORCE, JUDGED VERSION BY VERSION.** A version is believed when it is in its shape, within the range,
 * the change in force filed again (the same length) or the next change after it, signed at the bar (as the records
 * anchored it, for a version they anchor), and, for the first version of a change, filed by a seat whose role files
 * policy. Every later version of that change may be filed by any seat, adding its signature.
 */
export const recoveryWindowInForceOf = (company: string, versions: readonly WindowVersion[], quorum: SignedQuorum): WindowInForce => {
  const started = new Set<string>();
  const startedKey = (c: WindowChange): string => `${c.sequence}:${c.seconds}`;
  return signedChangesInForce<WindowVersion, WindowChange, WindowRefusal>(versions, quorum, {
    shape: (_v, c) => windowChangeRefusal(c),
    follows: (_v, c, prior, again) => (again ? c.seconds === prior.change.seconds : c.sequence === prior.change.sequence + 1),
    counted: (count, _v, c) => quorumOf(count.seats, windowMessage(company, c), c.signatures, count.held),
    afterCount: (count, v, c) => {
      if (started.has(startedKey(c))) return null;
      const by = v.filer?.toLowerCase();
      const filer = by === undefined ? undefined : count.seats.find((s) => s.signingKey === by);
      if (filer === undefined || !mayFile(filer).includes('policy')) return 'started-by-a-seat-that-may-not';
      started.add(startedKey(c));
      return null;
    },
  });
};
