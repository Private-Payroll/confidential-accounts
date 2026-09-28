import { languagesFrom } from 'vaults-ui';

/**
 * EVERY LANGUAGE THIS APPLICATION HAS A FILE FOR. A new language is a new file
 * in `locales/`, named by its tag; it is found here, and offered, with no code
 * changed.
 */
export const LANGUAGES = languagesFrom(import.meta.glob('./locales/*.json', { eager: true, import: 'default' }));

/** A language's name in that language, as the browser knows it, or its tag when it does not. */
export function languageName(tag: string): string {
  try { return new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
}
