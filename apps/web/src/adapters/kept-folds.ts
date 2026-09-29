/*
 * WHICH COMPANIES' SETUP CARDS ARE FOLDED ON HOME, KEPT IN THIS BROWSER, so
 * the card stays as the person left it when they come back. Kept as JSON,
 * which the application's source rules let only its adapters write, which
 * is why this is one; nothing kept here is an amount.
 */

/** Where the folded companies are kept in the browser's storage. */
const KEPT = { folded: 'private-vaults.setup-folded' } as const;

/** This browser's storage, which a reload and a new tab keep, or null where the browser refuses it. */
export function browserKeep(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** The companies whose setup card is folded, as kept in `storage`; anything kept that is not a list of ids is read as none. */
export function readFolds(storage: Pick<Storage, 'getItem'> | null): Set<string> {
  let kept: unknown;
  try { kept = JSON.parse(storage?.getItem(KEPT.folded) ?? '[]'); } catch { return new Set(); }
  return new Set(Array.isArray(kept) ? kept.filter((c): c is string => typeof c === 'string') : []);
}

/** Keep `company`'s card folded or not in `storage`. A browser that refuses keeps it for this page only. */
export function keepFold(storage: Pick<Storage, 'getItem' | 'setItem'> | null, company: string, folded: boolean): void {
  const all = readFolds(storage);
  if (folded) all.add(company); else all.delete(company);
  try { storage?.setItem(KEPT.folded, JSON.stringify([...all])); } catch { /* kept for this page only */ }
}
