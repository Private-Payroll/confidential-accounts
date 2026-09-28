import { createInstance, type i18n as I18n } from 'i18next';
import { useEffect, useMemo, type ReactNode } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { FALLBACK, chooseLanguage, directionOf, type Language } from 'vaults-ui/i18n/languages';

/**
 * A translator for these languages, showing `language`, with English for
 * anything missing. Keys are flat: the dots in `kit.public.label` are part of
 * the key, not a path.
 */
export function createTranslator(languages: readonly Language[], language: string): I18n {
  const i18n = createInstance();
  void i18n.init({
    resources: Object.fromEntries(languages.map((l) => [l.tag, { translation: l.messages }])),
    lng: language,
    fallbackLng: FALLBACK,
    supportedLngs: languages.map((l) => l.tag),
    initAsync: false,
    keySeparator: false,
    nsSeparator: false,
    returnNull: false,
    returnEmptyString: false,
    interpolation: { escapeValue: false, prefix: '{', suffix: '}' },
  });
  return i18n;
}

export interface LanguageProviderProps {
  /** Every language the application has a file for, from `languagesFrom`. */
  languages: readonly Language[];
  /** The person's pick, when they made one. */
  pick?: string | null;
  children?: ReactNode;
}

/**
 * THE ONE LANGUAGE PROVIDER. Every word a screen shows is asked for by its key
 * through `useText`, and comes from the language files the application passes
 * in. A phrase missing from a language falls back to English; a phrase with a
 * count takes the plural form its language needs; a placeholder is written
 * `{name}`. The page's `lang` and `dir` follow the language shown.
 */
export function LanguageProvider({ languages, pick, children }: LanguageProviderProps) {
  const browser = typeof navigator === 'undefined' ? [] : navigator.languages;
  const language = chooseLanguage(languages, pick, browser);
  const i18n = useMemo(() => createTranslator(languages, language), [languages]);
  useEffect(() => { if (i18n.language !== language) void i18n.changeLanguage(language); }, [i18n, language]);
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = directionOf(language);
  }, [language]);
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}

/** The phrase for a key, in the language shown: `t('kit.public.label')`, `t('run.people', { count })`. */
export function useText(): (key: string, values?: Record<string, unknown>) => string {
  const { t } = useTranslation();
  return (key, values) => t(key, values ?? {}) as string;
}

/** The tag of the language shown. */
export function useLanguage(): string {
  return useTranslation().i18n.language;
}
