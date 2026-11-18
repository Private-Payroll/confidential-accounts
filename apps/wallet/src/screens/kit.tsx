import type { ReactNode } from 'react';
import { Button } from 'vaults-ui';
import { THEME_ENTRIES, useTheme } from '../shell/theme.js';
import { TokensChapter, ButtonsChapter, BadgesChapter, CardsChapter } from './kit-chapters-basics.js';
import { FieldsChapter, AlertsChapter, EmptyStatesChapter, ListRowsChapter, SectionChapter, ActionTilesChapter } from './kit-chapters-inputs.js';
import { TableChapter, SkeletonChapter, TooltipChapter, DialogChapter, SidebarChapter } from './kit-chapters-data.js';

/**
 * THE GALLERY — every component, every variant, every state, one page.
 *
 * WHY THIS EXISTS: *"the point is one look and
 * one round of feedback instead of one argument per screen. A component argued
 * about on the Activity screen gets argued about again on Settings; a
 * component agreed on the gallery is inherited by every screen after it."*
 *
 * IT IS NOT A SCREEN. Nothing here reads a wallet, a secret, storage or the
 * network; every value on this page is a literal written in these files, except
 * the name of the network this wallet is built for, which comes from that
 * network's own record. That is deliberate — a gallery that needed an
 * unlocked wallet could not be opened on the machine somebody wants to look at
 * it on, and a gallery that showed real balances would be a place, with a
 * place's obligations.
 *
 * WHAT TO REACT TO. Not padding — that is what adopting a made design system
 * is for. React to: does this look like serious financial software; is the
 * accent right; is the difference between a quiet button and a dangerous one
 * obvious enough; do the payment statuses read at a glance; does the light
 * theme hold up. Everything on this page is a token change away from being
 * different, and every screen built after it inherits the answer.
 */
export function Kit(): ReactNode {
  const { choice, theme, setChoice } = useTheme();

  return (
    <>
      <h1>The kit</h1>
      <p className="lede">
        Every component, every variant, every state. Nothing on this page is real —
        no wallet is read and no number is a balance.
      </p>
      <p className="muted small">
        This page is not in the navigation. It is reached by typing <code>#/kit</code>,
        and it exists so a component is argued about once here rather than once per screen.
      </p>

      <div className="mb-10 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
        <span className="text-sm font-medium text-muted-foreground">Theme</span>
        {THEME_ENTRIES.map((option) => (
          <Button
            type="button"
            key={option.value}
            size="sm"
            variant={choice === option.value ? 'default' : 'outline'}
            aria-pressed={choice === option.value}
            onClick={() => setChoice(option.value)}
          >
            {option.label}
          </Button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          showing: {theme}
          {choice === 'system' && ' (from this machine)'}
          {' · '}
          print always forces light
        </span>
      </div>

      <TokensChapter />
      <ButtonsChapter />
      <BadgesChapter />
      <CardsChapter />
      <FieldsChapter />
      <AlertsChapter />
      <EmptyStatesChapter />
      <ListRowsChapter />
      <SectionChapter />
      <ActionTilesChapter />
      <TableChapter />
      <SkeletonChapter />
      <TooltipChapter />
      <DialogChapter />
      <SidebarChapter />

      <p className="faint small">
        End of the kit. Everything a screen is built from is on this page; if a screen needs
        something that is not, that is a decision, not a class at the call site.
      </p>
    </>
  );
}
