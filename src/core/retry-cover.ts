/**
 * **WHICH RETRIES ON A LEG STILL COVER THEIR PEOPLE, WHEN THE RUN WAS NEVER
 * TOLD WHICH PROPOSAL THEY WERE WRITTEN DOWN AS - DECIDED ONCE, FOR THE COMPANY
 * AND FOR THE PAGE ALIKE.**
 *
 * A retry is written onto the leg before it is raised, and which proposal it
 * was raised as is written afterwards. A raise that stopped in between leaves
 * an entry on the leg with no proposal, and it may have left a proposal
 * written down that the run does not point at. That proposal can still reach
 * the chain and pay the same people, so while it can, nobody else may be put
 * on a retry over them. Once it is withdrawn or stopped, or its window has
 * closed, or no proposal was ever written down for it, it covers nobody.
 *
 * The company refuses a new retry over the people this names, and the page
 * leaves them out of what it offers and shows the retry instead. Both read it
 * from here, so the page does not hide people the company would let a retry
 * pay, nor offer people it would refuse, for every round the page can open.
 */
import type { StateChange } from './ledger.js';
import { parseCanonical, unseal, type Hex, type Sealed } from './crypto.js';

/** A round still able to reach the chain: neither withdrawn nor stopped by the company's own policy. */
export const isLiveRound = (r: { readonly status: string }): boolean =>
  r.status !== 'cancelled' && r.status !== 'blocked';

/** Two lists of people, in the same order. */
export const sameList = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * **ONE PAYROLL ROUND AS ITS SEALED PAYLOAD DESCRIBES IT**: the run and the leg
 * it is for, and for a retry the people it pays as positions in the leg.
 * `null` for a proposal that is not a payroll round of a run. The payload opens
 * with the account's viewing key.
 */
export function payrollRoundOf<S extends string>(
  p: {
    readonly id: string; readonly kind: string; readonly status: S; readonly raisedAt?: string;
    readonly chainId: Hex; readonly sealedPayload: Sealed;
  },
  viewingKey: Hex,
): {
  id: string; runId: string; asset: StateChange['asset']; status: S; raisedAt?: string; chainId: Hex; retry?: number[];
} | null {
  if (p.kind !== 'payroll') return null;
  const payload = parseCanonical<{ runId?: unknown; retry?: unknown; __change: StateChange }>(
    unseal(p.sealedPayload, viewingKey));
  if (typeof payload.runId !== 'string') return null;
  return {
    id: p.id, runId: payload.runId, asset: payload.__change.asset, status: p.status,
    ...(p.raisedAt ? { raisedAt: p.raisedAt } : {}), chainId: p.chainId,
    ...(Array.isArray(payload.retry) ? { retry: payload.retry as number[] } : {}),
  };
}

/**
 * **THE RETRY ROUNDS WRITTEN DOWN FOR ONE LEG THAT THE RUN WAS NEVER TOLD
 * ABOUT, AND STILL COVER THEIR PEOPLE**, in the order the rounds are handed in.
 *
 * `rounds` are the rounds written down for this run's leg and no other. One
 * covers its people when it is a retry, is live, is not a proposal any entry on
 * the leg names, is not `except` (the one a raise is sending again as itself),
 * and its window has not closed. Its window is read off the leg's entries with
 * no proposal that name exactly the same people, the latest of them; with none
 * to read, it covers until it is withdrawn.
 */
export function untoldRetryRounds<R extends { readonly id: string; readonly status: string; readonly retry?: readonly number[] }>(
  entries: ReadonlyArray<{
    readonly originalIndices: readonly number[]; readonly closesAt: bigint | string | number; readonly proposalId?: string;
  }>,
  rounds: readonly R[],
  nowInSeconds: bigint,
  except?: string,
): Array<{ readonly round: R; readonly people: readonly number[]; readonly closesAt: bigint | undefined }> {
  const told = new Set(entries.map((e) => e.proposalId).filter(Boolean));
  const covering: Array<{ round: R; people: readonly number[]; closesAt: bigint | undefined }> = [];
  for (const r of rounds) {
    if (r.retry === undefined || !isLiveRound(r)) continue;
    if (told.has(r.id) || r.id === except) continue;
    const windows = entries
      .filter((e) => e.proposalId === undefined && sameList(e.originalIndices, r.retry!))
      .map((e) => BigInt(String(e.closesAt)));
    const closesAt = windows.length ? windows.reduce((a, b) => (a > b ? a : b)) : undefined;
    if (closesAt !== undefined && nowInSeconds >= closesAt) continue;
    covering.push({ round: r, people: r.retry, closesAt });
  }
  return covering;
}
