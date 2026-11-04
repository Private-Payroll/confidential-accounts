import { languagesFrom, type Messages, type MoreMessages } from 'vaults-ui';

/**
 * EVERY LANGUAGE THIS APPLICATION HAS A FILE FOR. A new language is a new file
 * in `locales/`, named by its tag; it is found here, and offered, with no code
 * changed. These files hold only the words the first download needs: the
 * shell's, the page names and the kit's. A screen's words are in
 * `locales/common/` and `locales/pages/<page>/`, read by `wordsFor`.
 */
export const LANGUAGES = languagesFrom(import.meta.glob('./locales/*.json', { eager: true, import: 'default' }));

const COMMON_FILES = import.meta.glob('./locales/common/*.json', { import: 'default' });
const PAGE_FILES = import.meta.glob('./locales/pages/*/*.json', { import: 'default' });
const tagOf = (path: string): string => /([^/]+)\.json$/.exec(path)![1]!;
const ASKED = new Map<string, Promise<MoreMessages>>();

/**
 * THE WORDS A SCREEN NEEDS BEYOND THE FIRST DOWNLOAD: the words several
 * screens share, which are in `locales/common/`, and the page's own, in
 * `locales/pages/<page>/`, each language's under its tag. They are fetched
 * the first time a screen of the page opens, and once however often it opens.
 */
export function wordsFor(page: string): () => Promise<MoreMessages> {
  return () => {
    let asked = ASKED.get(page);
    if (asked === undefined) {
      const files = [...Object.entries(COMMON_FILES), ...Object.entries(PAGE_FILES).filter(([path]) => /pages\/([\w-]+)\//.exec(path)?.[1] === page)];
      asked = Promise.all(files.map(async ([path, read]) => [tagOf(path), (await read()) as Messages] as const)).then((read) => {
        const out: Record<string, Messages> = {};
        for (const [tag, messages] of read) out[tag] = { ...out[tag], ...messages };
        return out;
      });
      ASKED.set(page, asked);
    }
    return asked;
  };
}

/** A language's name in that language, as the browser knows it, or its tag when it does not. */
export function languageName(tag: string): string {
  try { return new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
}
