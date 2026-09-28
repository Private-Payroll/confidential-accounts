import { useLayoutEffect } from 'react';
import { useLanguage, useText } from 'vaults-ui';

/**
 * THE PAGE'S TITLE, IN THE LANGUAGE SHOWN. The page is served with an empty
 * title, so no language is shown before one is chosen; this sets the title
 * from the language file before the first frame the application draws, and
 * again whenever the language changes. It renders nothing.
 */
export function DocumentTitle(): null {
  const t = useText();
  const language = useLanguage();
  useLayoutEffect(() => { document.title = t('app.title'); }, [language]);
  return null;
}
