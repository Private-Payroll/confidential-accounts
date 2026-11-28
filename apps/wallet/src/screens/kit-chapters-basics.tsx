import type { ReactNode } from 'react';
import {
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Separator
} from 'vaults-ui';
import { GLYPH, Glyph } from '../glyphs.js';
import { StatusAlert, StatusBadge } from '../components/status.js';
import {
  KIT_VARIANT,
  KIT_SIZE,
  BUTTON_VARIANTS,
  BUTTON_SIZES,
  BADGE_TONES,
  COLOUR_ROLES,
  TYPE_STEPS,
  CHART_STEPS,
  BY_REQUEST_ONLY
} from './kit-specimens.js';
import { Chapter, Spec, Swatch } from './kit-parts.js';

export function TokensChapter(): ReactNode {
  return (
    <>
      <Chapter
        id="tokens"
        title="Tokens"
        says="Colour is roles, never values. The scales are finite: if a screen needs a step
              that is not here, the answer is the nearest one, not a new one."
      >
        <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
          {COLOUR_ROLES.map((role) => (
            <Swatch key={role.token} token={role.token} name={role.token} note={role.note} />
          ))}
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <Spec label="radius — three steps, derived from one anchor">
            <div className="flex items-end gap-3">
              <span className="flex size-16 items-center justify-center rounded-md border border-input bg-card text-xs text-muted-foreground">
                tight
              </span>
              <span className="flex size-16 items-center justify-center rounded-xl border border-input bg-card text-xs text-muted-foreground">
                card
              </span>
              <span className="flex h-9 items-center justify-center rounded-full border border-input bg-card px-4 text-xs text-muted-foreground">
                pill
              </span>
            </div>
            <p className="m-0 mt-3 text-sm text-muted-foreground">
              <code>--radius-anchor</code> is <code>0.875rem</code>, which is what shadcn 4.18.0 calls “large”.{' '}
              <code>tight</code> and <code>card</code> are <code>calc()</code> either side of it, so “rounder” is one
              edit.
            </p>
          </Spec>

          <Spec label="type — the scale, and no arbitrary values">
            <div className="flex flex-col gap-1">
              {TYPE_STEPS.map((step) => (
                <p key={step.cls} className={`m-0 ${step.cls} text-foreground`}>
                  {step.name}
                </p>
              ))}
            </div>
            <p className="m-0 mt-3 text-sm text-muted-foreground">
              <code>text-display</code> is the step the kit added, and it is a ROLE rather than a size: there is one
              thing on a screen this big and it is the money. Tailwind’s own <code>text-3xl</code> and up exist and are
              not part of this scale.
            </p>
          </Spec>

          <Spec label="chart ramp — five categorical colours, and no chart">
            <div className="flex items-end gap-2">
              {CHART_STEPS.map((n) => (
                <span
                  key={n}
                  className="h-12 w-8 rounded-md border border-border"
                  style={{ background: `var(--color-chart-${n})` }}
                  aria-hidden="true"
                />
              ))}
            </div>
            <p className="m-0 mt-3 text-sm text-muted-foreground">
              All five are cool on purpose. A chart colour says <em>this series</em>, and a series drawn in the same red
              as a failed payment is a sentence the chart did not mean to say.
            </p>
          </Spec>

          <Spec label="the smallest touch target — 44px">
            <div className="flex items-center gap-3">
              <span className="size-11 rounded-md border border-dashed border-primary" aria-hidden="true" />
              <span className="text-sm text-muted-foreground">
                <code>--spacing-touch</code>. Every control on a place is at least this, because this app is meant to be
                wrapped in a native shell.
              </span>
            </div>
          </Spec>
        </div>
      </Chapter>
    </>
  );
}

export function ButtonsChapter(): ReactNode {
  return (
    <>
      <Chapter
        id="buttons"
        title="Button"
        says="Six variants, four sizes. Four of them are what screens use; two are marked
              below and are not. Danger is outlined rather than filled — a filled red button
              is the easiest thing on a screen to press by accident."
      >
        <div className="mb-6 flex flex-col gap-4">
          {BUTTON_VARIANTS.map((variant) => (
            <Spec
              key={variant}
              label={`variant="${variant}"`}
              badge={
                BY_REQUEST_ONLY.includes(variant) ? (
                  <StatusBadge tone="warning">by request only</StatusBadge>
                ) : undefined
              }
            >
              <div className="flex flex-wrap items-center gap-3">
                {BUTTON_SIZES.map((size) => (
                  <Button key={size} type="button" variant={KIT_VARIANT[variant]} size={KIT_SIZE[size]}>
                    {size === 'icon' ? <Glyph icon={GLYPH.send} className="size-5" /> : size}
                    {size === 'icon' && <span className="sr-only">Send</span>}
                  </Button>
                ))}
                <Button type="button" variant={KIT_VARIANT[variant]} disabled>
                  disabled
                </Button>
              </div>
            </Spec>
          ))}
        </div>

        <StatusAlert tone="info" title="Four variants, not six" role={null} className="mt-2">
          <strong>primary</strong>, <strong>secondary</strong>, <strong>ghost</strong> and <strong>danger</strong> are
          what a screen reaches for. <strong>outline</strong> and <strong>link</strong> are <em>by request only</em> —
          they exist because shadcn’s shapes have them and a screen that wants one is asking for a decision, not picking
          a class. This label is the enforcement: this page is what a person building a screen reads first.
        </StatusAlert>

        <Separator className="my-6" decorative />

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <Spec label="with an icon — the ordinary case">
            <div className="flex flex-wrap gap-3">
              <Button type="button" variant="default">
                <Glyph icon={GLYPH.send} className="size-5" />
                Send
              </Button>
              <Button type="button" variant="outline">
                <Glyph icon={GLYPH.printer} className="size-5" />
                Print this sheet
              </Button>
              <Button type="button" variant="destructive">
                <Glyph icon={GLYPH.secured} className="size-5" />
                Cut a fresh set
              </Button>
            </div>
          </Spec>
          <Spec label="ButtonLink — an anchor, because href means navigation">
            <div className="flex flex-wrap gap-3">
              <Button asChild variant="default">
                <a href="#/kit">A link that looks like a button</a>
              </Button>
              <Button asChild variant="link">
                <a href="#/kit">A link that looks like a link</a>
              </Button>
            </div>
          </Spec>
        </div>
      </Chapter>
    </>
  );
}

export function BadgesChapter(): ReactNode {
  return (
    <>
      <Chapter
        id="badges"
        title="Badge"
        says="Three of these are the payment statuses pending.ts actually has. The word is the
              fact; the colour only helps you find it."
      >
        <div className="flex flex-wrap items-center gap-3">
          {BADGE_TONES.map((tone) => (
            <StatusBadge key={tone} tone={tone}>
              {tone}
            </StatusBadge>
          ))}
        </div>
        <p className="muted small" style={{ marginTop: '1rem' }}>
          In a list: <StatusBadge tone="pending">Still confirming</StatusBadge>{' '}
          <StatusBadge tone="sent">Sent</StatusBadge> <StatusBadge tone="failed">Did not go through</StatusBadge>
        </p>
      </Chapter>
    </>
  );
}

export function CardsChapter(): ReactNode {
  return (
    <>
      <Chapter
        id="cards"
        title="Card"
        says="Header, content, footer. The footer sits on a rule, and the header can carry
              one control on its right edge."
      >
        <CardSamples />
        <CardActionSlots />
        <CardLongTitle />
      </Chapter>
    </>
  );
}

function CardSamples(): ReactNode {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={3}>
              Header, content and footer
            </CardTitle>
            <CardDescription>The description sits under the title, in muted text.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="m-0 text-sm text-muted-foreground">
              A card knows nothing about what is inside it. That is the same rule the shell follows about a place.
            </p>
          </CardContent>
          <CardFooter>
            <Button type="button" variant="default" size="sm">
              Confirm
            </Button>
            <Button type="button" variant="ghost" size="sm">
              Not now
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={3}>
              Content only
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="m-0 font-mono text-2xl font-semibold text-foreground">
              1,240.5000 <span className="font-sans text-sm font-medium text-muted-foreground">tNIGHT</span>
            </p>
            <p className="m-0 mt-1 text-xs text-muted-foreground">
              A number always carries when it was true. This one is invented.
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function CardActionSlots(): ReactNode {
  return (
    <>
      {/* THE HEADER ACTION SLOT, WITH BOTH FILLINGS.
       *
       * It goes in `#/kit` beside its siblings with
       * both fillings shown — a chevron and an icon button — so the shape
       * is reviewed once rather than per screen. The two below are the two
       * kinds of thing that will ever go in it: something that NAVIGATES
       * and something that ACTS. They are `ButtonLink` and `Button` from
       * this same kit, unchanged and unstyled by the slot, which is the
       * whole claim — the slot decides WHERE, the screen decides WHAT.
       *
       * The chevron's href is `#/kit` because `kit.test.tsx` asserts every
       * link on this page points at the gallery itself: the gallery is
       * unlinked from the wallet, and a specimen is not an exception. */}
      <p className="m-0 mt-8 mb-4 text-sm text-muted-foreground">
        The header can carry <strong>one</strong> control on its right edge. It is a slot, not a button: the kit fixes
        the position — right edge, aligned to the title and not to the block beneath it — and the screen decides what
        sits there. More than one control is a footer.
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Spec label="CardHeader action — a chevron to the place this card previews">
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={3}>
                A preview of somewhere
              </CardTitle>
              <CardDescription>
                A card showing the first few of something says where the rest is, and the chevron is a LINK — never a
                drawer.
              </CardDescription>
              <CardAction>
                <Button asChild variant="ghost" size="icon">
                  <a href="#/kit" aria-label="All of this, in its own place">
                    <Glyph icon={GLYPH.next} className="size-5" />
                  </a>
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <p className="m-0 text-sm text-muted-foreground">Two callers: recent activity, and every wallet.</p>
            </CardContent>
          </Card>
        </Spec>

        <Spec label="CardHeader action — an icon button that acts">
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={3}>
                A card whose data can be refreshed
              </CardTitle>
              <CardAction>
                <Button type="button" variant="ghost" size="icon" aria-label="Check again">
                  <Glyph icon={GLYPH.switcher} className="size-5" />
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <p className="m-0 text-sm text-muted-foreground">
                The same slot, holding something that acts rather than navigates. The money card&rsquo;s refresh control
                is this filling, and it is designed in its own round rather than here.
              </p>
            </CardContent>
          </Card>
        </Spec>
      </div>
    </>
  );
}

function CardLongTitle(): ReactNode {
  return (
    <>
      <Spec label="CardHeader with a long title and a control — the alignment claim" className="mt-6">
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={3}>
              A title long enough to wrap onto a second line at a narrow width, which is where a control centred against
              the whole block starts to look wrong
            </CardTitle>
            <CardDescription>
              And a description under it, so the header is three lines tall. The control stays level with the first line
              of the title.
            </CardDescription>
            <CardAction>
              <Button asChild variant="ghost" size="icon">
                <a href="#/kit" aria-label="Somewhere else">
                  <Glyph icon={GLYPH.next} className="size-5" />
                </a>
              </Button>
            </CardAction>
          </CardHeader>
        </Card>
      </Spec>
    </>
  );
}
