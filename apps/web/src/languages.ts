import { languagesFrom } from 'vaults-ui';

/**
 * EVERY LANGUAGE THIS APPLICATION HAS A FILE FOR. A new language is a new file
 * in `locales/`, named by its tag; it is found here, and offered, with no code
 * changed.
 */
export const LANGUAGES = languagesFrom(import.meta.glob('./locales/*.json', { eager: true, import: 'default' }));
