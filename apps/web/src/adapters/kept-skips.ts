import { STEP, type StepId } from '../setup/step-ids.js';

/*
 * THE SETUP STEPS SKIPPED, KEPT IN THE TAB'S OWN STORAGE, which a reload
 * keeps and closing the tab clears. They are kept as JSON, which is written
 * only in this folder; nothing kept here is an amount, and an amount refuses
 * to become JSON in any case.
 */

/** Where the skipped steps are kept in the tab's own storage. */
const KEPT = { skipped: 'private-vaults.setup-skipped' } as const;

/** The company a skip is kept under; the person's steps before they have a company are kept under none. */
const NO_COMPANY = '';

const STEP_IDS: readonly string[] = Object.values(STEP);

/** The tab's own storage, or null where the browser refuses it. */
export function tabStorage(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

/**
 * The skipped steps kept in `storage`, for each company. Anything kept that is
 * not a list of step ids, such as a step since removed from the list, is left
 * out, so nothing kept can name a step that does not exist.
 */
export function readSkips(storage: Pick<Storage, 'getItem'> | null): Map<string | null, Set<StepId>> {
  const out = new Map<string | null, Set<StepId>>();
  let kept: unknown;
  const text = storage?.getItem(KEPT.skipped) ?? null;
  if (text === null) return out;
  try { kept = JSON.parse(text); } catch { return out; }
  if (kept === null || typeof kept !== 'object' || Array.isArray(kept)) return out;
  for (const [company, steps] of Object.entries(kept as Record<string, unknown>)) {
    if (!Array.isArray(steps)) continue;
    out.set(company === NO_COMPANY ? null : company, new Set(steps.filter((s): s is StepId => typeof s === 'string' && STEP_IDS.includes(s))));
  }
  return out;
}

/** Keep the skipped steps in `storage`. A browser that refuses keeps them for this page only. */
export function keepSkips(storage: Pick<Storage, 'setItem'> | null, skips: ReadonlyMap<string | null, ReadonlySet<StepId>>): void {
  const kept: Record<string, StepId[]> = {};
  for (const [company, steps] of skips) if (steps.size > 0) kept[company ?? NO_COMPANY] = [...steps];
  try { storage?.setItem(KEPT.skipped, JSON.stringify(kept)); } catch { /* kept for this page only */ }
}
