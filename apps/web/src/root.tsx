import { useCallback, useEffect, useState } from 'react';
import { KitProvider } from 'vaults-ui';
import { App } from './app.js';
import { DocumentTitle } from './document-title.js';
import { LANGUAGES } from './languages.js';
import { browserStorage, computerIsDark, followComputer, keepPreferences, readPreferences, showAppearance, themeFor, type Preferences } from './preferences.js';
import { onAMac } from './shortcuts.js';

/**
 * WHAT IS ABOVE THE APPLICATION: the person's choices of how it looks and
 * which language it speaks, read from this browser before the first frame,
 * shown on the page, and handed down; and the kit's provider, in the language
 * chosen.
 */
export function Root() {
  const [preferences, setPreferences] = useState<Preferences>(() => readPreferences(browserStorage()));
  const [dark, setDark] = useState<boolean>(computerIsDark);
  useEffect(() => followComputer(() => setDark(computerIsDark())), []);
  useEffect(() => { showAppearance(document.documentElement, themeFor(preferences.mode, dark), preferences.base); }, [preferences.mode, preferences.base, dark]);
  const choose = useCallback((change: Partial<Preferences>) => {
    setPreferences((was) => {
      const next = { ...was, ...change };
      keepPreferences(browserStorage(), next);
      return next;
    });
  }, []);
  return (
    <KitProvider languages={LANGUAGES} pick={preferences.language}>
      <DocumentTitle />
      <App preferences={preferences} choose={choose} mac={onAMac(navigator.platform)} />
    </KitProvider>
  );
}
