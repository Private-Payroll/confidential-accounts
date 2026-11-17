/*
 * What the browser probe records as it runs: the result object the driver reads off the page, the
 * log line each step prints, and the wording every phase shares for the network it is pointed at.
 */
import { nativeToken } from '@midnightntwrk/ledger-v9';
import { networkRecord, shownAddress } from '../../../src/core/networks.js';
import { NETWORK } from './config.js';

export interface ProbeStep { readonly name: string; readonly ms: number; readonly detail?: string }
export interface ProbeResult {
  done: boolean;
  verdict: 'FULL' | 'SYNC-INCOMPLETE' | 'ACT-FAILED' | 'STACK-OK-NETWORK-UNREACHED' | 'FAILED' | null;
  steps: ProbeStep[];
  error?: string;
  testWallet: boolean;
  coldSyncMs?: number;
  balanceEntries?: number;
  progress?: string;
  /** Unshielded NIGHT in STARs, as a decimal string — the §7.17 measurement
   * when the test wallet is funded. */
  unshieldedStars?: string;
  unshieldedSyncMs?: number;
  /** DUST in SPECKs, as a decimal string — the registration's result when above zero. */
  dustSpecks?: string;
  /** The registration transaction's identifier, the moment it is submitted
   * — reported even if DUST never appears, because "submitted, unknown" is
   * a different fact from "nothing happened". */
  registrationTxId?: string;
  /** How long the in-browser WASM proof of the registration took. */
  provingMs?: number;
  /** The measurement. Key material fetches, timed, with sizes. */
  keyMaterial?: { circuit: string; ms: number; proverBytes: number; irBytes: number }[];
  /** WHICH PARAMETER SIZE a real proof asks for (`getParams(k)`,
   * watched through the recording provider). This is the number the
   * key-hosting decision needs: a send fetches one k, not nine. */
  paramsFetched?: { k: number; ms: number; bytes: number }[];
  /** WHICH CIRCUITS a real proof asks for (`lookupKey`, watched
   * through the same recorder). `KeyMaterialAsk` has carried a `'circuit'`
   * variant for a while (`key-material.ts:281`) and both callbacks handled
   * only `'params'`, so the parameter half of the hosting number was
   * measured and the circuit half was asserted — 20.75 MB summed from what
   * was VENDORED, including `zswap/sign`, which no report says any proof
   * ever asked for. `askedBy` separates the probe's own warm-up loop from
   * a prover's ask, because a pre-fetch is the probe telling itself what to
   * fetch and proves nothing about what a proof needs. */
  circuitsAsked?: {
    keyLocation: string; ms: number; proverBytes: number;
    askedBy: 'probe-prefetch' | 'proof';
  }[];
  /** THE PENDING GUARD against a REAL send: the pending record as it stood ON DISK
   * at the moment it was written, BEFORE the network was touched. Read back
   * out of storage inside the engine's own `write` door, so it is the stored
   * record rather than the draft that was handed to it. */
  pendingBeforeSubmit?: {
    key: string; identifiers: readonly string[]; kind: string;
    recipientBech32: string; stars: string; feeSpecks: string;
    submittedAt: number; ttlAt: number; outcome: string;
  };
  /** What the ENGINE settled the record as, and from what. */
  pendingSettled?: { key: string; outcome: string; from: string };
  /** The record read off disk AFTER the send, independently. */
  pendingAfter?: { key: string; outcome: string } | 'no record on disk';
  /** THE RESOLUTION AGAINST THE CHAIN: the same identifier asked of the
   * indexer with the same call the home screen's resolver uses, and the same
   * `outcomeOfAnswer` applied to what came back. Silence resolves nothing —
   * that is the property, not a failure. */
  pendingChainResolution?: { identifier: string; answer: string; resolvedTo: string };
  /** HOW LONG THE INDEXER TAKES TO SHOW A TRANSACTION THE NODE
   * HAS ALREADY FINALISED. Measured by asking, by the record's own
   * identifier, until it is found. This is the number `TTL_SETTLE_MARGIN_MS`
   * should be set from — it was chosen to cover clock disagreement and has
   * been defending against the wrong thing. */
  indexerLag?: {
    identifier: string;
    /** ms from the successful submit to the indexer first reporting it, or
     * null if it was never found within this run's patience. */
    foundAfterMs: number | null;
    asks: number;
    patienceMs: number;
    answer: string;
  };
  /** Anything a PREVIOUS run left unresolved, and what this run's
   * start-up resolution did with it. The home screen's behaviour, run by the
   * probe: nobody presses anything. */
  pendingCarriedIn?: { key: string; outcome: string }[];
  /** One sentence, composed WHERE the failure happened, saying
   * whether rerunning can change the answer — printed under the verdict so
   * a permanent refusal is never dressed as "try again". */
  verdictAdvice?: string;
  /** THE NUMBER: real in-browser proofs of a plain shielded transfer
   * (zswap spend + two outputs + a dust spend), cold then warm. */
  shieldedProofMs?: number[];
  /** Why the measurement did not produce a number, when it did not. */
  measurementNote?: string;
  /** The real send: proving time of the live transaction (its dust
   * spend), the identifier, and the recipient's balance read afterwards. */
  realSendProvingMs?: number;
  realSendTxId?: string;
  realSendIdentifiers?: string[];
  realSendStars?: string;
  realSendRecipientStars?: string;
}

/** What the network this wallet is built for is called on a screen or in a log line: its record's label. */
export const NETWORK_NAME = networkRecord(NETWORK).label;

/**
 * The line that says which indexer a sync is asking. The address is printed as `shownAddress` gives
 * it, without its query, because the project token an indexer address carries travels in the query.
 */
export const syncingAgainst = (indexerUrl: string): string => `syncing against ${shownAddress(indexerUrl)}`;

/** Unshielded NIGHT, exactly as `unshielded.ts` keys the balances record. */
export const NIGHT_UNSHIELDED_RAW = nativeToken().raw;

const t0 = performance.now();
export const result: ProbeResult = { done: false, verdict: null, steps: [], testWallet: false };
/** The page's window with the three values the probe and its driver share through it. */
interface ProbeWindow extends Window {
  __PROBE__?: ProbeResult;
  __TEST_WALLET_SEED__?: unknown;
  __PROBE_SAME_PAYMENT__?: unknown;
}
export const probeWindow: ProbeWindow = window;
probeWindow.__PROBE__ = result;

const logEl = document.getElementById('log');
const outEl = document.getElementById('probe-out');
export const flush = (): void => { if (outEl) outEl.textContent = JSON.stringify(result, null, 2); };
export const step = (name: string, detail?: string): void => {
  result.steps.push({ name, ms: Math.round(performance.now() - t0), ...(detail ? { detail } : {}) });
  if (logEl) logEl.textContent += `${String(Math.round(performance.now() - t0)).padStart(7)}ms  ${name}${detail ? ` — ${detail}` : ''}\n`;
  flush();
};
export const finish = (verdict: ProbeResult['verdict'], error?: string): void => {
  result.verdict = verdict;
  if (error) result.error = error;
  result.done = true;
  step(`verdict: ${verdict}`, error);
  flush();
};

/**
 * What the probe reports for each payment an earlier run left unresolved: the
 * outcome the chain settled it to, or that the chain has not answered yet, or,
 * when resolving them failed before any answer (`failed` carries why), that it
 * was not asked. A failed attempt is never reported as the chain's silence,
 * because "still unresolved" claims the chain was asked.
 */
export function carriedInOutcomes(
  carriedIn: readonly { readonly key: string }[],
  settled: readonly { readonly key: string; readonly outcome?: { readonly name: string } | null }[],
  failed: string | null,
): { key: string; outcome: string }[] {
  return carriedIn.map((r) => {
    const now = settled.find((x) => x.key === r.key);
    let outcome: string;
    if (now?.outcome) outcome = now.outcome.name;
    else if (failed !== null) outcome = `NOT ASKED — resolving it failed: ${failed}`;
    else outcome = 'STILL unresolved — the chain has not answered, and silence decides nothing';
    return { key: r.key, outcome };
  });
}
