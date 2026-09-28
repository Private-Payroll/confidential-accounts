import { BASE_COLORS, Card, CardDescription, CardHeader, CardTitle, Label, RadioGroup, RadioGroupItem, useText, type BaseColor } from 'vaults-ui';
import { MODE_NAMES, MODES, type Mode } from '../preferences.js';
import { useCurrentPage } from '../router.js';
import { useSession } from '../session.js';
import type { Text } from '../pages.js';

/** The name of each colour, in the person's language. A colour added to the kit's list is a type error here until it is named. */
const COLOUR_NAMES: Record<BaseColor, (t: Text) => string> = {
  neutral: (t) => t('appearance.colour.neutral'),
  stone: (t) => t('appearance.colour.stone'),
  zinc: (t) => t('appearance.colour.zinc'),
  mauve: (t) => t('appearance.colour.mauve'),
  olive: (t) => t('appearance.colour.olive'),
  mist: (t) => t('appearance.colour.mist'),
  taupe: (t) => t('appearance.colour.taupe'),
};

/**
 * SETTINGS > APPEARANCE: light, dark or the computer's setting, and the
 * colour, from the kit's one list of colours. A choice is shown at once, on
 * the whole application, and kept in this browser.
 */
export function Appearance() {
  const t = useText();
  const { preferences, choose } = useSession();
  const { page } = useCurrentPage();
  return (
    <section className="flex max-w-3xl flex-col gap-8" data-screen="appearance">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{page.name(t)}</h2>
        <p className="text-sm text-muted-foreground">{t('appearance.description')}</p>
      </header>
      <fieldset className="flex flex-col gap-3">
        <legend className="pb-3 text-sm font-medium">{t('appearance.mode.title')}</legend>
        <RadioGroup value={preferences.mode} onValueChange={(m) => choose({ mode: m as Mode })} className="grid gap-3 sm:grid-cols-3" data-choice="mode">
          {MODES.map((m) => (
            <Label key={m} className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary" data-mode={m}>
              <RadioGroupItem value={m} />
              <span>{MODE_NAMES[m](t)}</span>
            </Label>
          ))}
        </RadioGroup>
      </fieldset>
      <fieldset className="flex flex-col gap-3">
        <legend className="pb-3 text-sm font-medium">{t('appearance.colour.title')}</legend>
        <RadioGroup value={preferences.base} onValueChange={(b) => choose({ base: b as BaseColor })} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-choice="colour">
          {BASE_COLORS.map((b) => (
            <Label key={b} className="block cursor-pointer" data-colour={b}>
              <Card className="has-[[data-state=checked]]:ring-2 has-[[data-state=checked]]:ring-primary">
                <CardHeader className="flex flex-row items-center gap-3">
                  <RadioGroupItem value={b} />
                  <div className="flex flex-col gap-0.5">
                    <CardTitle className="text-sm">{COLOUR_NAMES[b](t)}</CardTitle>
                    {b === preferences.base ? <CardDescription>{t('appearance.colour.shown')}</CardDescription> : null}
                  </div>
                </CardHeader>
              </Card>
            </Label>
          ))}
        </RadioGroup>
      </fieldset>
    </section>
  );
}
