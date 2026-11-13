import { Label, RadioGroup, RadioGroupItem, Section, useLanguage, useText } from 'vaults-ui';
import { LANGUAGES, languageName } from '../languages.js';
import { useCurrentPage } from '../router.js';
import { FOLLOW_BROWSER } from '../preferences.js';
import { useSession } from '../session.js';

/**
 * SETTINGS > LANGUAGE: the person's language, from the application's language
 * files, each named in its own language. A language arrives as a file and is
 * offered here with nothing else changed. Until they pick, the browser's
 * language is used when there is a file for it, and English otherwise.
 */
export function LanguageSettings() {
  const t = useText();
  const shown = useLanguage();
  const { preferences, choose } = useSession();
  const { page } = useCurrentPage();
  return (
    <Section title={page.name(t)} description={t('language.description')} list={false} data-screen="language">
      <RadioGroup
        aria-label={t('language.title')}
        value={preferences.language ?? FOLLOW_BROWSER}
        onValueChange={(v) => choose({ language: v === FOLLOW_BROWSER ? null : v })}
        className="flex flex-col gap-2" data-choice="language"
      >
        <Label className="flex cursor-pointer items-center gap-3 rounded-lg border p-3" data-language="">
          <RadioGroupItem value={FOLLOW_BROWSER} />
          <span className="flex flex-col">
            <span>{t('language.followBrowser')}</span>
            <span className="text-xs text-muted-foreground">{t('language.nowShown', { language: languageName(shown) })}</span>
          </span>
        </Label>
        {LANGUAGES.map((l) => (
          <Label key={l.tag} className="flex cursor-pointer items-center gap-3 rounded-lg border p-3" lang={l.tag} data-language={l.tag}>
            <RadioGroupItem value={l.tag} />
            <span>{languageName(l.tag)}</span>
          </Label>
        ))}
      </RadioGroup>
    </Section>
  );
}
