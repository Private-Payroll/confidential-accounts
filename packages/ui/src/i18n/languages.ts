/**
 * THE LANGUAGES AN APPLICATION OFFERS, READ FROM ITS LANGUAGE FILES.
 *
 * An application keeps one file per language, named by its language tag
 * (`en.json`, `pt-BR.json`), and hands the files to `languagesFrom` as its
 * bundler found them. So a new language is a new file: it is in this list, and
 * so in the switcher, with no code changed. English is the language every
 * missing phrase falls back to, and there must be an English file.
 */
export type Messages = Readonly<Record<string, string>>;

export interface Language {
  /** The language tag, as the file is named: `en`, `pt-BR`. */
  tag: string;
  messages: Messages;
}

/** The language every other falls back to. */
export const FALLBACK = 'en';

/**
 * The languages in a set of files, keyed by path as `import.meta.glob` gives
 * them, English first and the rest by tag. Refuses a file not named by a
 * language tag, one that is not flat text, and a set with no English.
 */
export function languagesFrom(files: Readonly<Record<string, unknown>>): Language[] {
  const out: Language[] = [];
  for (const [path, content] of Object.entries(files)) {
    const name = /([^/\\]+)\.json$/.exec(path)?.[1];
    if (name === undefined) throw new Error(`${path} is not a language file: a language file is <tag>.json`);
    let tag: string;
    try { tag = Intl.getCanonicalLocales(name)[0] ?? ''; } catch { tag = ''; }
    if (tag !== name) throw new Error(`${path} is not named by a language tag${tag ? `; the tag is written ${tag}` : ''}`);
    if (content === null || typeof content !== 'object' || Array.isArray(content)
      || !Object.values(content).every((v) => typeof v === 'string')) {
      throw new Error(`${path} is not one object of phrases, each a string under its key`);
    }
    out.push({ tag, messages: content as Messages });
  }
  if (!out.some((l) => l.tag === FALLBACK)) throw new Error(`there is no ${FALLBACK}.json; every phrase falls back to English`);
  return out.sort((a, b) => (a.tag === FALLBACK ? -1 : b.tag === FALLBACK ? 1 : a.tag.localeCompare(b.tag)));
}

const RTL_SCRIPTS = new Set(['Arab', 'Hebr', 'Syrc', 'Thaa', 'Nkoo', 'Adlm', 'Rohg', 'Mand', 'Samr', 'Mend', 'Yezi']);

/** Which way a language is written. Read from the browser when it knows, else from the language's script. */
export function directionOf(tag: string): 'ltr' | 'rtl' {
  const locale = new Intl.Locale(tag) as Intl.Locale & {
    getTextInfo?: () => { direction?: string }; textInfo?: { direction?: string };
  };
  const info = typeof locale.getTextInfo === 'function' ? locale.getTextInfo() : locale.textInfo;
  if (info?.direction === 'rtl' || info?.direction === 'ltr') return info.direction;
  return RTL_SCRIPTS.has(locale.maximize().script ?? '') ? 'rtl' : 'ltr';
}

/**
 * The language to show: the person's pick when a file exists for it; else the
 * first of the browser's languages a file exists for, exactly or by its base
 * language (`pt-BR` finds `pt`); else English.
 */
export function chooseLanguage(offered: readonly Language[], pick: string | null | undefined, browser: readonly string[]): string {
  const tags = offered.map((l) => l.tag);
  if (pick && tags.includes(pick)) return pick;
  for (const b of browser) {
    if (tags.includes(b)) return b;
    const base = b.split('-')[0]!;
    if (tags.includes(base)) return base;
  }
  return FALLBACK;
}
