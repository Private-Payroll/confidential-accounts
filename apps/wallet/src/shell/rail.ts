import { useCallback, useState } from 'react';
import { readPref, writePref } from './prefs.js';

/**
 * WHETHER THE DESKTOP RAIL IS FOLDED — *"remembered across reloads."*
 *
 * IT IS READ ONCE, IN A LAZY INITIALISER, and never again. That is deliberate:
 * unlike the theme, this preference has nothing outside the app that can change
 * it — no `prefers-reduced-*`, no machine setting, no second surface writing the
 * same record. `shell/account.tsx` re-reads storage after every click because a
 * SECOND surface can change which wallet is open and the rule says two surfaces
 * must never disagree; a rail nobody else can fold needs none of that
 * machinery, and adding it "for symmetry" would be adding a document-wide click
 * listener for a fact only one button can change.
 *
 * COLLAPSED IS NOT THE DEFAULT. Somebody opening this wallet for the first time
 * gets labels. The rail folds because a person folded it.
 *
 * IT IS A DESKTOP FACT ONLY. Below the layout switch there is no rail at all —
 * the bottom bar is a different element and is never folded — so this value is
 * read by the rail and by nothing else. By design: the switch
 * is a media query, never JavaScript, so nothing here measures a viewport.
 */

const KEY = 'rail';
const COLLAPSED = 'collapsed';

export interface RailControl {
  readonly collapsed: boolean;
  toggle(): void;
}

export function useRail(): RailControl {
  const [collapsed, setCollapsed] = useState(() => readPref(KEY) === COLLAPSED);
  const toggle = useCallback((): void => {
    setCollapsed((was) => {
      const next = !was;
      writePref(KEY, next ? COLLAPSED : null);
      return next;
    });
  }, []);
  return { collapsed, toggle };
}
