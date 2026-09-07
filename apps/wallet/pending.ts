import { TransactionStatus } from '@midnightntwrk/wallet-sdk-indexer-client';
import { QueryRunner } from '@midnightntwrk/wallet-sdk-indexer-client/effect';
import { toBase64Url } from 'midnight-identity/passkey/bytes';
import { fingerprintOf } from 'midnight-identity/recovery/pieces';
import type { Secret } from 'midnight-identity/keys/derivation';
import { INDEXER_HTTP_URL } from './config.js';

/**
 * THE PENDING SEND — the middle stops being a destination.
 *
 * The rule, verbatim: *"there can never be any situation
 * where a user sends money from their wallet but cannot be sure if the money
 * moved."* The middle itself cannot be abolished — a transaction handed to a
 * network has an unknown outcome for a bounded time, and a wallet that shows
 * a crisp yes/no at the press is guessing (and the guess that costs money is
 * "failed": a person told that sends again). What CAN be
 * abolished is the middle as a place a person is left standing. So:
 *
 *  1. **The payment is written down HERE, BEFORE submission** — identifiers,
 *     amount, recipient, time, and the transaction's own TTL — in
 *     localStorage, synchronously, so a tab killed one millisecond after
 *     the submit call still knows the question on reload.
 *  2. **Every record resolves itself against the chain, by identifier** —
 *     the indexer answers `transactions(offset: {identifier})` with the
 *     transaction's result (`TransactionStatus` — wallet-sdk-indexer-client/
 *     dist/graphql/queries/TransactionStatus.js:19–33) — on every start,
 *     without anybody pressing anything.
 *  3. **A transaction that is not on chain past its own TTL can never land**
 *     — the TTL travels inside the transaction, so once the chain's clock is
 *     safely past it, "failed, nothing moved" stops being a guess and
 *     becomes a fact. That is the bound that lets every middle END.
 *  4. **The answer is carried on the home screen** (`screens/home.tsx`)
 *     until a person has seen it — because the person who most needs it is
 *     the one who closed the tab and never went back to the send screen.
 *  5. **The same payment cannot be re-submitted while one is unresolved**
 *     (`send.ts` refuses at the door) — the double-send guard the whole
 *     middle exists to protect.
 *
 * THE RECORD IS PLAINTEXT IN LOCALSTORAGE, LIKE THE OTHER ACCOUNT RECORDS
 * (`storage.ts` — names, checkpoints), fingerprint-named so one
 * account's pending payment can never be shown over another's. What it
 * holds — recipient, amount, identifiers — is what the chain itself shows
 * for an unshielded send; nothing secret enters this file.
 *
 * WHAT ASKING COSTS, said because naming what a network call reveals is
 * this wallet's habit: resolving sends the transaction IDENTIFIER to the
 * indexer over HTTP — the same indexer the wallet already syncs from, one
 * identifier per question, never a key of any kind.
 */

export type PendingOutcome =
  | { readonly name: 'sent'; readonly at: number }
  | { readonly name: 'failed'; readonly at: number; readonly reason: string };

export interface PendingSend {
  /** The record's key: the transaction's first identifier. */
  readonly key: string;
  readonly identifiers: readonly string[];
  readonly account: number;
  readonly kind: 'shielded' | 'unshielded';
  readonly recipientBech32: string;
  /** STARs, as a decimal string — JSON has no bigint. */
  readonly stars: string;
  readonly feeSpecks: string;
  /** Written BEFORE the submit call — epoch ms. */
  readonly submittedAt: number;
  /** The transaction's own TTL, epoch ms — past this (plus a margin for
   * clock disagreement) it can never be included, so not-found means failed. */
  readonly ttlAt: number;
  readonly outcome: PendingOutcome | null;
}

const KEY = 'midnight-identity:pending-sends';

/** How far past a transaction's TTL the chain's clock is trusted to be past
 * it too. Generous on purpose: settling to "failed" one margin late costs
 * patience; settling early costs a double send. */
export const TTL_SETTLE_MARGIN_MS = 5 * 60_000;

interface StoredRecord extends PendingSend { readonly fingerprint: string }

const isRecord = (value: unknown): value is StoredRecord => {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<StoredRecord>;
  return typeof r.fingerprint === 'string'
    && typeof r.key === 'string' && r.key.length > 0
    && Array.isArray(r.identifiers) && r.identifiers.every((id) => typeof id === 'string')
    && typeof r.account === 'number'
    && (r.kind === 'shielded' || r.kind === 'unshielded')
    && typeof r.recipientBech32 === 'string'
    && typeof r.stars === 'string' && /^\d+$/u.test(r.stars)
    && typeof r.feeSpecks === 'string'
    && typeof r.submittedAt === 'number'
    && typeof r.ttlAt === 'number'
    && (r.outcome === null
      || (typeof r.outcome === 'object' && r.outcome !== null
        && ((r.outcome as PendingOutcome).name === 'sent'
          || (r.outcome as PendingOutcome).name === 'failed')));
};

/** Every stored record, all accounts — damaged entries are skipped (they
 * cannot be repaired from here), never allowed to hide the healthy ones. */
function readAll(): StoredRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord);
  } catch {
    return [];
  }
}

function writeAll(records: readonly StoredRecord[]): void {
  localStorage.setItem(KEY, JSON.stringify(records));
}

const printOf = (secret: Secret): string => toBase64Url(fingerprintOf(secret));

/** This account's pending sends — resolved and not — newest first. */
export function loadPendingSends(secret: Secret): PendingSend[] {
  const print = printOf(secret);
  return readAll()
    .filter((r) => r.fingerprint === print)
    .sort((a, b) => b.submittedAt - a.submittedAt)
    .map(({ fingerprint: _fingerprint, ...record }) => record);
}

export const unresolvedPendingSends = (secret: Secret): PendingSend[] =>
  loadPendingSends(secret).filter((r) => r.outcome === null);

/** The double-send question: is THIS payment — same recipient, same exact
 * amount — already handed to the network with its outcome unknown? */
export const duplicateUnresolved = (
  secret: Secret, recipientBech32: string, stars: bigint,
): boolean => unresolvedPendingSends(secret)
  .some((r) => r.recipientBech32 === recipientBech32 && r.stars === String(stars));

export interface PendingDraft {
  readonly identifiers: readonly string[];
  readonly account: number;
  readonly kind: 'shielded' | 'unshielded';
  readonly recipientBech32: string;
  readonly stars: bigint;
  readonly feeSpecks: bigint;
  readonly ttlAt: number;
}

/**
 * Writes the payment down. CALLED BEFORE THE SUBMIT CALL, synchronously —
 * that ordering is the whole point, and `send.test.ts` pins it. Throws if
 * it cannot write: a payment that cannot be written down must not be
 * submitted, because the alternative is exactly the forgotten middle.
 */
export function writePendingSend(secret: Secret, draft: PendingDraft): PendingSend {
  const record: StoredRecord = {
    fingerprint: printOf(secret),
    key: draft.identifiers[0] ?? `no-identifier:${draft.recipientBech32}:${String(draft.stars)}`,
    identifiers: draft.identifiers,
    account: draft.account,
    kind: draft.kind,
    recipientBech32: draft.recipientBech32,
    stars: String(draft.stars),
    feeSpecks: String(draft.feeSpecks),
    submittedAt: Date.now(),
    ttlAt: draft.ttlAt,
    outcome: null,
  };
  const rest = readAll().filter((r) => r.key !== record.key);
  writeAll([...rest, record]);
  const { fingerprint: _fingerprint, ...pending } = record;
  return pending;
}

/** Settles one record. Settled records STAY until a person dismisses them —
 * the answer has to find somebody, not just exist. */
export function settlePendingSend(
  secret: Secret, key: string, outcome: PendingOutcome,
): void {
  const print = printOf(secret);
  writeAll(readAll().map((r) => (
    r.fingerprint === print && r.key === key && r.outcome === null
      ? { ...r, outcome }
      : r)));
}

/** A person saw the answer — the record's work is done. */
export function dismissPendingSend(secret: Secret, key: string): void {
  const print = printOf(secret);
  writeAll(readAll().filter((r) => !(r.fingerprint === print && r.key === key)));
}

/** The engine-facing shape (`SendDoors.pending` — send.ts): the store,
 * bound to one account of one secret. The send screen builds this; the
 * engine never sees storage. */
export const pendingGuardFor = (secret: Secret, account: number): {
  duplicateUnresolved: (recipientBech32: string, stars: bigint) => boolean;
  write: (draft: Omit<PendingDraft, 'account'>) => void;
  settle: (key: string, outcome: PendingOutcome) => void;
} => ({
  duplicateUnresolved: (recipientBech32, stars) =>
    duplicateUnresolved(secret, recipientBech32, stars),
  write: (draft) => { writePendingSend(secret, { ...draft, account }); },
  settle: (key, outcome) => { settlePendingSend(secret, key, outcome); },
});

/** What a run watching its own pending record is told. The record handed to
 * `wrote` is the one READ BACK OUT OF STORAGE, never the draft that went in:
 * the draft is what the engine intended, the store is what a killed tab
 * would actually leave behind, and only the second one is evidence. */
export interface PendingObserver {
  readonly wrote: (stored: PendingSend) => void;
  readonly settled: (key: string, outcome: PendingOutcome) => void;
}

/**
 * THE SAME GUARD, WATCHED — against a real send.
 *
 * The probe drives the send engine with these doors so a real payment is
 * written down before the network is touched and the record can be reported
 * from the artefact rather than described. Every call goes to the real guard
 * first; this only observes.
 *
 * **It reads the record back off disk and REFUSES if it is not there.**
 * `writePendingSend` returns the record it built, and returning a value is
 * not the same claim as the value being in storage — a quota failure, a
 * serialisation that drops a field, a fingerprint mismatch on read-back all
 * leave a `write` that "succeeded" and a tab that would wake up remembering
 * nothing. The engine refuses a send whose record cannot be written
 * (`send.ts`), so throwing here is what turns a silent storage failure into
 * that refusal instead of into a forgotten middle.
 */
export const observedPendingGuard = (
  secret: Secret, account: number, observer: PendingObserver,
): ReturnType<typeof pendingGuardFor> => {
  const guard = pendingGuardFor(secret, account);
  return {
    duplicateUnresolved: (recipientBech32, stars) =>
      guard.duplicateUnresolved(recipientBech32, stars),
    write: (draftIn) => {
      /* `writePendingSend` RETURNS the record it built, key and all, and the
       * key is the store's to decide — `identifiers[0]` when there is one and
       * a constructed fallback when there is not. Re-deriving it here instead
       * of using the returned one looked identical and was not: a payment
       * with no identifiers was written down correctly and then reported
       * missing, so a perfectly good send would have been refused. Caught by
       * the test that counts the STORE's key rather than the draft's. */
      const written = writePendingSend(secret, { ...draftIn, account });
      const stored = loadPendingSends(secret).find((r) => r.key === written.key);
      if (!stored) {
        throw new Error('the pending record is NOT on disk after writing it — a payment '
          + 'this wallet cannot remember must not be submitted');
      }
      observer.wrote(stored);
    },
    settle: (key, outcome) => {
      guard.settle(key, outcome);
      observer.settled(key, outcome);
    },
  };
};

/**
 * The rehearsal's stand-in: same guard behaviour INSIDE one rehearsal (the
 * double-send refusal can be rehearsed too), nothing written to real
 * storage, nothing surviving the pretend chain — a pretend payment must
 * never appear on the real home screen.
 */
export const throwawayPendingGuard = (): ReturnType<typeof pendingGuardFor> => {
  const records = new Map<string, { recipientBech32: string; stars: string; outcome: PendingOutcome | null }>();
  return {
    duplicateUnresolved: (recipientBech32, stars) => [...records.values()]
      .some((r) => r.recipientBech32 === recipientBech32
        && r.stars === String(stars) && r.outcome === null),
    write: (draft) => {
      records.set(draft.identifiers[0] ?? '', {
        recipientBech32: draft.recipientBech32, stars: String(draft.stars), outcome: null,
      });
    },
    settle: (key, outcome) => {
      const record = records.get(key);
      if (record) record.outcome = outcome;
    },
  };
};

/* ------------------------------------------------ asking the chain itself */

/** What the chain says about one identifier. `not-found` is not an answer —
 * it is the absence of one, and only the TTL turns it into "failed". */
/** One segment of a transaction, as the chain reports it — `Segment`,
 * `wallet-sdk-indexer-client/dist/graphql/generated/graphql.d.ts:536-541`.
 * `TransactionStatus` has always selected these; the wallet once threw
 * them away and guessed in prose which part had failed. */
export interface ChainSegment {
  readonly id: number;
  readonly success: boolean;
}

/**
 * THE STATUSES THIS WALLET HAS HEARD OF.
 *
 * The indexer's own type is
 * `'FAILURE' | 'PARTIAL_SUCCESS' | 'SUCCESS' | '%future added value'`
 * (`graphql.d.ts:759`). **That last member is the code generator saying the
 * server may one day answer something this wallet has never seen** — and a
 * wallet that folds an unknown answer into "failed" is the dangerous
 * guess again, in the code built to stop it.
 */
export const KNOWN_STATUSES = ['SUCCESS', 'FAILURE', 'PARTIAL_SUCCESS'] as const;

/** Whether an answer is one this wallet is entitled to act on. */
export const isKnownStatus = (status: string): boolean =>
  (KNOWN_STATUSES as readonly string[]).includes(status);

export type ChainAnswer =
  | { readonly found: false }
  | {
    readonly found: true;
    readonly status: string;
    /** Absent when the chain reported none — which is not the same as an
     * empty list, and neither is the same as "the parts all succeeded". */
    readonly segments?: readonly ChainSegment[] | undefined;
  };

/**
 * One identifier, asked of the indexer. The SDK's own query, run the way the
 * facade runs its own one-off queries (`WalletFacade.fetchTermsAndConditions`
 * — wallet-sdk-facade/dist/index.js:203–207: `QueryRunner.runPromise(query,
 * variables, { url })`).
 */
/**
 * THE QUERY'S ANSWER, TURNED INTO THIS WALLET'S, and it is exported
 * because the alternative is untestable.
 *
 * `TransactionStatus` has always selected `segments { id success }`
 * (`TransactionStatus.js:19-33`); the wallet read `status` and dropped them,
 * so on a `PARTIAL_SUCCESS` it held the chain's per-part answer and described
 * the outcome in prose. Reading them is one field — and reading them WHERE A
 * TEST CAN SEE IT is what stops the field being quietly dropped again, which
 * a mutation proved could happen unnoticed.
 */
export function answerFromTransactions(transactions: readonly {
  readonly __typename?: string;
  readonly transactionResult?: {
    readonly status: string;
    readonly segments?: readonly { readonly id: number; readonly success: boolean }[] | null;
  };
}[]): ChainAnswer {
  for (const tx of transactions) {
    if (tx.__typename === 'RegularTransaction' && tx.transactionResult) {
      const segments = tx.transactionResult.segments ?? undefined;
      return {
        found: true,
        status: tx.transactionResult.status,
        segments: segments?.map((seg) => ({ id: seg.id, success: seg.success })),
      };
    }
  }
  return { found: false };
}

export async function transactionStatusOnChain(identifier: string): Promise<ChainAnswer> {
  const result = await QueryRunner.runPromise(
    TransactionStatus,
    { transactionId: identifier },
    { url: INDEXER_HTTP_URL });
  return answerFromTransactions(result.transactions);
}

/** What resolution needs handed in — injectable so tests never dial. */
export interface ResolutionDoors {
  readonly status: (identifier: string) => Promise<ChainAnswer>;
  readonly now: () => number;
  readonly settleMarginMs?: number;
}

export const liveResolutionDoors = (): ResolutionDoors => ({
  status: transactionStatusOnChain,
  now: Date.now,
});

/** The outcome one chain answer (or its absence) implies — or null: keep
 * listening. Exported alone so the send engine's live watcher and the home
 * screen's resolver cannot drift apart on what an answer means. */
export function outcomeOfAnswer(
  record: Pick<PendingSend, 'ttlAt'>,
  answer: ChainAnswer | null,
  now: number,
  settleMarginMs: number = TTL_SETTLE_MARGIN_MS,
): PendingOutcome | null {
  /* NO answer decides NOTHING — not even past the TTL. Silence from the
   * indexer says nothing about the chain, and a "failed" built on silence
   * is the dangerous guess wearing a process. Only an actual "not found"
   * answer lets the TTL clause below speak. */
  if (answer === null) return null;
  if (answer.found) {
    if (answer.status === 'SUCCESS') return { name: 'sent', at: now };

    /* AN ANSWER THIS WALLET HAS NEVER HEARD OF RESOLVES NOTHING.
     *
     * The indexer's status type ends `'%future added value'`
     * (`graphql.d.ts:759`) — the generator saying the server may answer
     * something new one day. Folding that into `failed` would tell a person
     * their payment did not go through on the strength of a word this
     * wallet cannot read, and `failed` releases the duplicate guard, so the
     * next thing they would do is send it again. **It is the `null` case:
     * keep watching, and say so on screen the way an unreachable indexer
     * already does.** */
    if (!isKnownStatus(answer.status)) return null;

    /* WHICH PART FAILED, READ RATHER THAN GUESSED. The chain
     * reports a result per segment and the query has always asked for them.
     * Absent segments and an empty list are both "the chain did not tell
     * us", and neither is allowed to become a claim about which part
     * moved. */
    const segments = answer.segments ?? [];
    const failed = segments.filter((seg) => !seg.success).map((seg) => seg.id);
    const succeeded = segments.filter((seg) => seg.success).map((seg) => seg.id);
    const parts = segments.length === 0
      ? 'The chain did not say which part of it failed, so this wallet does not know '
        + 'which — and it is not going to guess.'
      : `The chain says ${failed.length === 0
        ? 'no part of it failed'
        : `part ${failed.join(', ')} failed`}${succeeded.length === 0
        ? ''
        : ` and part ${succeeded.join(', ')} succeeded`}.`;

    return {
      name: 'failed',
      at: now,
      reason: `the chain included the transaction and reports ${answer.status} — `
        + `the payment did not go through as a success. ${parts} The fee's DUST `
        + 'may have been spent. Check this payment on a block explorer before '
        + 'sending it again.',
    };
  }
  if (now > record.ttlAt + settleMarginMs) {
    /* WHAT THIS SENTENCE IS ALLOWED TO CLAIM.
     *
     * It used to end *"Nothing moved; it is safe to send this payment
     * again."* That is a claim about the CHAIN built on a silence from the
     * INDEXER, and the two are not the same thing — measured on 20 Aug: the
     * node reported a transaction FINALIZED and 168ms later the indexer,
     * asked by that transaction's own identifier, answered `not found`.
     * A transaction can be on the chain
     * and invisible here.
     *
     * What IS true past the deadline: the transaction's TTL travels inside
     * it, so from here on it can never be included. The payment is over.
     * What is NOT known: whether it was already included BEFORE the
     * deadline and simply never appeared to us. So the record settles —
     * it must, or the middle never ends — but it settles WITHOUT telling
     * anybody that nothing moved, and it does not say sending again is
     * safe, because on this evidence nobody can say that. */
    return {
      name: 'failed',
      at: now,
      reason: 'the transaction\'s own deadline has passed and it never appeared on '
        + 'the chain as far as this wallet could see, so it can no longer be '
        + 'included and this payment is over. Whether it went through BEFORE the '
        + 'deadline and was simply never visible from here is NOT known — the only '
        + 'thing that said no was a silence. Check this payment on a block explorer '
        + 'before sending it again.',
    };
  }
  return null;
}

/**
 * Resolves every unresolved record it can — called on every start (the home
 * screen mounts it) and again on a timer, never by a person. An indexer that
 * cannot be reached resolves nothing and is asked again next round: silence
 * from the network must never become an answer.
 */
export async function resolvePendingSends(
  secret: Secret, doors: ResolutionDoors = liveResolutionDoors(),
): Promise<PendingSend[]> {
  const settled: PendingSend[] = [];
  for (const record of unresolvedPendingSends(secret)) {
    let answer: ChainAnswer | null = null;
    for (const identifier of record.identifiers) {
      try {
        const found = await doors.status(identifier);
        if (found.found) { answer = found; break; }
        answer ??= found;
      } catch {
        /* No answer is NOT "not found": without one, this identifier says
         * nothing, and the TTL clause below must not run on silence. */
      }
    }
    if (answer === null) continue;
    const outcome = outcomeOfAnswer(record, answer, doors.now(), doors.settleMarginMs);
    if (outcome) {
      settlePendingSend(secret, record.key, outcome);
      settled.push({ ...record, outcome });
    }
  }
  return settled;
}
