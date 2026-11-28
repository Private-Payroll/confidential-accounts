/*
 * THE COMPANY'S VIEW IN AN ADAPTER'S TEST: the page's own (`openViewOf`), over the test's service in memory
 * (`service-in-memory.test-support.ts`). Its joining, declared kinds and batching are the page's own.
 */
import { openViewOf, type PageView } from './filing-judge.js';
import { useSession } from '../session.js';

/** A view of `company` as the page opens it, over the test's service. */
export const aViewOf = (company: string): PageView => openViewOf(company);

const handedDown = new Map<string, PageView>();

/**
 * The view a panel shown alone in a test is handed, where the page's frame would hand it the opening's: one view of
 * the shown company, the same one at every draw.
 */
export const useTheViewOfTheTest = (): PageView | null => {
  let company: string | null = null;
  /* A test that loads the application's code afresh draws under a frame this file's copy does not know: it is handed no view. */
  try {
    ({ company } = useSession());
  } catch {
    return null;
  }
  if (company === null) return null;
  const kept = handedDown.get(company) ?? aViewOf(company);
  handedDown.set(company, kept);
  return kept;
};
