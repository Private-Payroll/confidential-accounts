/*
 * RECORDS FILED AS ONE CHECKED BATCH: a step's vault records, and a company's records sent together (`filedTogether`).
 * A vault filing that is held (`VaultRecordsHeld`) is not sent when its store is
 * asked to file it: it waits, and the store answers a read of that vault's record with it, so a step builds each next
 * version on the one it holds. Then every held filing is sent at once (`filedTogether`): the view checks once that
 * nothing moved before the first write, as it does before one write, then sends each write in order and stops at the
 * first that is refused or whose outcome is not known. What landed before the stop is this device's own, and is
 * entered in the company's records with one entry write; the refused one is answered with the same refusal a filing
 * sent alone gets, and every one after it is not sent and is answered as not filed, so the next attempt files it again.
 * A change found before the first write sends nothing, and every filing of the batch is answered with that change.
 */
import { VaultRecordRefused, type SealedPool } from '../../../src/midnight/vault-pool.js';
import type { ManifestEntryBody } from '../../../src/midnight/record-manifest.js';
import type { RecordsEntered } from './record-entered-here.js';
import type { RecordWrite } from './records-source.js';

/** One record signed and ready to send: its write, its entry, and how the service's answer to it is taken. */
export interface RecordFiling {
  readonly write: RecordWrite;
  /** The entry that names it in the company's records, entered once it is filed. */
  readonly entry: ManifestEntryBody;
  /** How what was filed is entered: the view's manifest, as this seat signs it. */
  readonly entered: RecordsEntered;
  /** Throws unless the service's answer names this record, version and body as filed. */
  readonly answered: (answer: unknown) => void;
  /**
   * What a refusal of it means: resolves when the version the service already holds is this one (it is entered with
   * the rest), and otherwise throws what a filing sent alone throws for that refusal.
   */
  readonly refused: (cause: unknown) => Promise<void>;
  /** What it is answered with when a write before it in the same batch was refused or its outcome is not known. */
  readonly notSent: () => Error;
}

/** One vault record signed and ready to send, with the record, vault and sealed version a held filing answers reads with. */
export interface VaultFiling extends RecordFiling {
  readonly record: string;
  readonly vault: string;
  /** The sealed version sent, which a held filing answers reads of its vault's record with. */
  readonly sealed: SealedPool;
}

/** Why a filing of a batch was not sent, for `what`, the version and record it names. */
export const notSentInTheBatch = (what: string): string => `${what} was not sent, so it is not filed: a write before it in the `
  + 'same batch was refused, or its outcome is not known. It is filed again the next time.';

/** A vault filing not sent, refused as a filing of that vault's record. */
export const vaultFilingNotSent = (record: string, version: number): Error =>
  new VaultRecordRefused(notSentInTheBatch(`version ${version} of this vault's ${record}`));

/** Each filing's outcome, in the order sent. */
type FiledOutcome = PromiseSettledResult<void>;

/** The answers of the writes that landed before the one that failed, as the view's write hands them on its error. */
const answeredBefore = (cause: unknown): readonly unknown[] => {
  const answered = (cause as { readonly answered?: unknown } | null)?.answered;
  return Array.isArray(answered) ? answered : [];
};

const nothingWasSent = (cause: unknown): boolean => (cause as { readonly nothingWasSent?: unknown } | null)?.nothingWasSent === true;

/**
 * Sends `filings` through `send` (the view's one checked write of a batch) and takes each answer: each filing's
 * outcome, in order. Every filing that landed is entered with one entry write; if entering fails, each of them is
 * answered with that failure, as a filing sent alone is.
 */
export async function filedTogether(
  send: (writes: readonly RecordWrite[]) => Promise<readonly unknown[]>, filings: readonly RecordFiling[],
): Promise<readonly FiledOutcome[]> {
  if (filings.length === 0) return [];
  let answers: readonly unknown[];
  let cause: unknown;
  try {
    answers = await send(filings.map((f) => f.write));
  } catch (e) {
    if (nothingWasSent(e)) return filings.map(() => ({ status: 'rejected', reason: e }));
    cause = e;
    answers = answeredBefore(e);
  }
  const stoppedAt = cause === undefined ? filings.length : answers.length;
  const outcomes: FiledOutcome[] = [];
  const landed: number[] = [];
  for (const [i, f] of filings.entries()) {
    try {
      if (i < stoppedAt) f.answered(answers[i]);
      else if (i === stoppedAt) await f.refused(cause);
      else throw f.notSent();
      landed.push(i);
      outcomes.push({ status: 'fulfilled', value: undefined });
    } catch (e) {
      outcomes.push({ status: 'rejected', reason: e });
    }
  }
  if (landed.length === 0) return outcomes;
  try {
    await filings[landed[0]!]!.entered.enter(landed.map((i) => filings[i]!.entry));
  } catch (e) {
    for (const i of landed) outcomes[i] = { status: 'rejected', reason: e };
  }
  return outcomes;
}

/** A step's vault filings held back and sent as one checked batch (`filedTogether`) when the step says so. */
export class VaultRecordsHeld {
  private held: VaultFiling[] = [];

  constructor(private readonly send: (writes: readonly RecordWrite[]) => Promise<readonly unknown[]>) {}

  hold(filing: VaultFiling): void {
    this.held.push(filing);
  }

  /** The newest version held for this vault's record, which a read of it is answered with until the batch is sent. */
  newestHeld(record: string, vault: string): SealedPool | undefined {
    for (let i = this.held.length - 1; i >= 0; i--) if (this.held[i]!.record === record && this.held[i]!.vault === vault) return this.held[i]!.sealed;
    return undefined;
  }

  /** Sends every filing held, once, and lets go of them: each one's record, vault and outcome, in order. */
  async sent(): Promise<readonly { readonly record: string; readonly vault: string; readonly outcome: FiledOutcome }[]> {
    const filings = this.held;
    this.held = [];
    const outcomes = await filedTogether(this.send, filings);
    return filings.map((f, i) => ({ record: f.record, vault: f.vault, outcome: outcomes[i]! }));
  }
}
