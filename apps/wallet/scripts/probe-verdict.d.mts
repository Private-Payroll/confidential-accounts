/* Types for the driver's pure rules, so the pins that hold them typecheck
 * with the rest of this project rather than under an implicit `any`. The
 * implementation is plain JS because the probe driver loads it at
 * runtime and Node does not read TypeScript. */

export declare function verdictFor(input?: {
  killed?: boolean;
  done?: boolean;
  pageVerdict?: string | null;
}): string;

export declare function exitCodeFor(verdict: string, keyOnTheWire?: boolean): number;

export declare function unfinishedSentence(input?: {
  killed?: boolean;
  done?: boolean;
  waitedMs?: number;
  leashMs?: number;
  progress?: string | null;
}): string | null;

export declare const LAG_BOUND_MIN_RUNS: number;

export interface LagSeen {
  runs: number;
  found: number;
  neverFound: number;
  worstFoundMs: number | null;
  minRuns: number;
  allFound: boolean;
  enoughRuns: boolean;
  isBound: boolean;
}

export declare function worstLag(
  history?: readonly { foundAfterMs?: number | null }[],
  minRuns?: number,
): LagSeen;

export declare function boundSentence(seen: LagSeen): string;
