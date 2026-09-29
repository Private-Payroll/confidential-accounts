import { languagesFrom } from 'vaults-ui';

/**
 * THE WALLET'S LANGUAGE FILES, one per language and named by its tag. The
 * kit's parts take their words from these - the close button on a dialog, the
 * sidebar's name for a screen reader - so the wallet says them in its own
 * words. English is the only file, and every phrase falls back to it.
 */
export const LANGUAGES = languagesFrom(import.meta.glob('./locales/*.json', { eager: true, import: 'default' }));
