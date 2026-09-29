import type { ReactNode } from 'react';
import {
  Button, Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
  EmptyState, Input, Label, Section, Separator, Skeleton, Tooltip, TooltipContent, TooltipTrigger,
} from 'vaults-ui';
import { DialogClose } from 'vaults-ui/components/dialog';
import {
  SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider,
} from 'vaults-ui/components/sidebar';
import {
  Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow,
} from 'vaults-ui/components/table';
import { Textarea } from 'vaults-ui/components/textarea';
import { GLYPH, Glyph } from '../glyphs.js';
import { RowItem, RowItems, ShortcutTile, ShortcutTiles } from '../components/rows.js';
import { StatusAlert, StatusBadge } from '../components/status.js';
import type { AlertTone, BadgeTone } from '../components/status.js';
import { THEME_ENTRIES, useTheme } from '../shell/theme.js';

/**
 * THE GALLERY — every component, every variant, every state, one page.
 *
 * WHY THIS EXISTS: *"the point is one look and
 * one round of feedback instead of one argument per screen. A component argued
 * about on the Activity screen gets argued about again on Settings; a
 * component agreed on the gallery is inherited by every screen after it."*
 *
 * IT IS NOT A SCREEN. Nothing here reads a wallet, a secret, storage or the
 * network; every value on this page is a literal written in this file. That is
 * deliberate — a gallery that needed an unlocked wallet could not be opened on
 * the machine somebody wants to look at it on, and a gallery that showed real
 * balances would be a place, with a place's obligations.
 *
 * WHAT TO REACT TO. Not padding — that is what adopting a made design system
 * is for. React to: does this look like serious financial software; is the
 * accent right; is the difference between a quiet button and a dangerous one
 * obvious enough; do the payment statuses read at a glance; does the light
 * theme hold up. Everything on this page is a token change away from being
 * different, and every screen built after it inherits the answer.
 */

/* ---------- page furniture, local to the gallery ---------- */

function Chapter({ id, title, says, children }: {
  readonly id: string;
  readonly title: string;
  readonly says?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section id={id} className="mb-12 scroll-mt-4">
      <div className="mb-4 border-b border-border pb-2">
        <h2 className="m-0 text-lg font-semibold text-foreground">{title}</h2>
        {says !== undefined && <p className="m-0 mt-1 text-sm text-muted-foreground">{says}</p>}
      </div>
      {children}
    </section>
  );
}

/** A labelled cell, so every specimen on the page says what it is. The optional
 * badge is how a variant carries a RULE beside its name rather than in a
 * paragraph somebody scrolls past. */
function Spec({ label, children, className, badge }: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly badge?: ReactNode;
}): ReactNode {
  return (
    <div className={className}>
      <p className="m-0 mb-2 flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
        <span>{label}</span>
        {badge}
      </p>
      {children}
    </div>
  );
}

function Swatch({ token, name, note }: {
  readonly token: string;
  readonly name: string;
  readonly note?: string;
}): ReactNode {
  return (
    <div className="flex items-center gap-3">
      <span
        className="size-10 shrink-0 rounded-md border border-border"
        style={{ background: `var(${token})` }}
        aria-hidden="true"
      />
      <span className="min-w-0">
        <span className="block font-mono text-xs text-foreground">{name}</span>
        {note !== undefined && <span className="block text-xs text-muted-foreground">{note}</span>}
      </span>
    </div>
  );
}

/* ---------- the specimens ---------- */

/* The looks a screen asks for, by the names this page has always shown, and
 * the kit's variant and size each one is drawn with. */
type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'link';
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';
const KIT_VARIANT = {
  primary: 'default', secondary: 'outline', outline: 'outline', ghost: 'ghost', danger: 'destructive', link: 'link',
} as const satisfies Record<ButtonVariant, string>;
const KIT_SIZE = { sm: 'sm', md: 'default', lg: 'lg', icon: 'icon' } as const satisfies Record<ButtonSize, string>;

const BUTTON_VARIANTS: readonly ButtonVariant[] = [
  'primary', 'secondary', 'outline', 'ghost', 'danger', 'link',
];
const BUTTON_SIZES: readonly ButtonSize[] = ['sm', 'md', 'lg', 'icon'];

const BADGE_TONES: readonly BadgeTone[] = [
  'neutral', 'accent', 'pending', 'sent', 'failed', 'warning',
];

const ALERT_TONES: readonly AlertTone[] = ['info', 'success', 'warning', 'danger'];

const COLOUR_ROLES: readonly { readonly token: string; readonly note: string }[] = [
  { token: '--color-bg', note: 'the page' },
  { token: '--color-raised', note: 'a card, the rail' },
  { token: '--color-sunken', note: 'a field, a well' },
  { token: '--color-line', note: 'ordinary borders' },
  { token: '--color-line-strong', note: 'a control’s border' },
  { token: '--color-ink', note: 'text' },
  { token: '--color-muted', note: 'secondary text' },
  { token: '--color-faint', note: 'labels, hints' },
  { token: '--color-accent', note: 'one accent, and only one' },
  { token: '--color-accent-strong', note: 'its hover' },
  { token: '--color-pending', note: 'a payment with no answer yet' },
  { token: '--color-good', note: 'sent, secured, verified' },
  { token: '--color-warn', note: 'at risk' },
  { token: '--color-bad', note: 'failed, dangerous' },
];

const TYPE_STEPS: readonly { readonly cls: string; readonly name: string }[] = [
  { cls: 'text-xs', name: 'text-xs — 0.75rem' },
  { cls: 'text-sm', name: 'text-sm — 0.875rem' },
  { cls: 'text-base', name: 'text-base — 1rem' },
  { cls: 'text-lg', name: 'text-lg — 1.125rem' },
  { cls: 'text-xl', name: 'text-xl — 1.25rem' },
  { cls: 'text-2xl', name: 'text-2xl — 1.5rem' },
  { cls: 'text-[2.75rem]', name: 'text-display — 2.75rem' },
];

/* The five chart colours. They are a PALETTE entry and not a chart
 * component: shadcn's charts arrive later through `add chart`, and what had to
 * be settled now was whether the ramp agrees with the rest of the palette. */
const CHART_STEPS = ['1', '2', '3', '4', '5'] as const;

/* Six variants stay, four are the default, and **the label
 * on this page is the enforcement** — because this page is what a session
 * reads before building a screen. */
const BY_REQUEST_ONLY: readonly ButtonVariant[] = ['outline', 'link'];

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

      {/* ---------------- tokens ---------------- */}

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
              <span className="flex size-16 items-center justify-center rounded-md border border-input bg-card text-xs text-muted-foreground">tight</span>
              <span className="flex size-16 items-center justify-center rounded-xl border border-input bg-card text-xs text-muted-foreground">card</span>
              <span className="flex h-9 items-center justify-center rounded-full border border-input bg-card px-4 text-xs text-muted-foreground">pill</span>
            </div>
            <p className="m-0 mt-3 text-sm text-muted-foreground">
              <code>--radius-anchor</code> is <code>0.875rem</code>, which is what shadcn
              4.18.0 calls “large”. <code>tight</code> and <code>card</code> are{' '}
              <code>calc()</code> either side of it, so “rounder” is one edit.
            </p>
          </Spec>

          <Spec label="type — the scale, and no arbitrary values">
            <div className="flex flex-col gap-1">
              {TYPE_STEPS.map((step) => (
                <p key={step.cls} className={`m-0 ${step.cls} text-foreground`}>{step.name}</p>
              ))}
            </div>
            <p className="m-0 mt-3 text-sm text-muted-foreground">
              <code>text-display</code> is the step the kit added, and it is a ROLE rather than
              a size: there is one thing on a screen this big and it is the money. Tailwind’s
              own <code>text-3xl</code> and up exist and are not part of this scale.
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
              All five are cool on purpose. A chart colour says <em>this series</em>, and a
              series drawn in the same red as a failed payment is a sentence the chart did
              not mean to say.
            </p>
          </Spec>

          <Spec label="the smallest touch target — 44px">
            <div className="flex items-center gap-3">
              <span className="size-11 rounded-md border border-dashed border-primary" aria-hidden="true" />
              <span className="text-sm text-muted-foreground">
                <code>--spacing-touch</code>. Every control on a place is at least this,
                because this app is meant to be wrapped in a native shell.
              </span>
            </div>
          </Spec>
        </div>
      </Chapter>

      {/* ---------------- buttons ---------------- */}

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
              badge={BY_REQUEST_ONLY.includes(variant)
                ? <StatusBadge tone="warning">by request only</StatusBadge>
                : undefined}
            >
              <div className="flex flex-wrap items-center gap-3">
                {BUTTON_SIZES.map((size) => (
                  <Button key={size} type="button" variant={KIT_VARIANT[variant]} size={KIT_SIZE[size]}>
                    {size === 'icon' ? <Glyph icon={GLYPH.send} className="size-5" /> : size}
                    {size === 'icon' && <span className="sr-only">Send</span>}
                  </Button>
                ))}
                <Button type="button" variant={KIT_VARIANT[variant]} disabled>disabled</Button>
              </div>
            </Spec>
          ))}
        </div>

        <StatusAlert tone="info" title="Four variants, not six" role={null} className="mt-2">
          <strong>primary</strong>, <strong>secondary</strong>, <strong>ghost</strong> and{' '}
          <strong>danger</strong> are what a screen reaches for.{' '}
          <strong>outline</strong> and <strong>link</strong> are <em>by request only</em> —
          they exist because shadcn’s shapes have them and a screen that wants one is asking
          for a decision, not picking a class. This label is the enforcement: this page is
          what a session reads before it builds a screen.
        </StatusAlert>

        <Separator className="my-6" decorative />

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <Spec label="with an icon — the ordinary case">
            <div className="flex flex-wrap gap-3">
              <Button type="button" variant="default"><Glyph icon={GLYPH.send} className="size-5" />Send</Button>
              <Button type="button" variant="outline"><Glyph icon={GLYPH.printer} className="size-5" />Print this sheet</Button>
              <Button type="button" variant="destructive"><Glyph icon={GLYPH.secured} className="size-5" />Cut a fresh set</Button>
            </div>
          </Spec>
          <Spec label="ButtonLink — an anchor, because href means navigation">
            <div className="flex flex-wrap gap-3">
              <Button asChild variant="default"><a href="#/kit">A link that looks like a button</a></Button>
              <Button asChild variant="link"><a href="#/kit">A link that looks like a link</a></Button>
            </div>
          </Spec>
        </div>
      </Chapter>

      {/* ---------------- badges ---------------- */}

      <Chapter
        id="badges"
        title="Badge"
        says="Three of these are the payment statuses pending.ts actually has. The word is the
              fact; the colour only helps you find it."
      >
        <div className="flex flex-wrap items-center gap-3">
          {BADGE_TONES.map((tone) => (
            <StatusBadge key={tone} tone={tone}>{tone}</StatusBadge>
          ))}
        </div>
        <p className="muted small" style={{ marginTop: '1rem' }}>
          In a list: <StatusBadge tone="pending">Still confirming</StatusBadge>{' '}
          <StatusBadge tone="sent">Sent</StatusBadge> <StatusBadge tone="failed">Did not go through</StatusBadge>
        </p>
      </Chapter>

      {/* ---------------- cards ---------------- */}

      <Chapter
        id="cards"
        title="Card"
        says="Header, content, footer. The footer sits on a rule, and the header can carry
              one control on its right edge."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={3}>Header, content and footer</CardTitle>
              <CardDescription>The description sits under the title, in muted text.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="m-0 text-sm text-muted-foreground">
                A card knows nothing about what is inside it. That is the same rule the shell
                follows about a place.
              </p>
            </CardContent>
            <CardFooter>
              <Button type="button" variant="default" size="sm">Confirm</Button>
              <Button type="button" variant="ghost" size="sm">Not now</Button>
            </CardFooter>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={3}>Content only</CardTitle>
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
          The header can carry <strong>one</strong> control on its right edge. It is a
          slot, not a button: the kit fixes the position — right edge, aligned to the
          title and not to the block beneath it — and the screen decides what sits
          there. More than one control is a footer.
        </p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Spec label="CardHeader action — a chevron to the place this card previews">
            <Card>
              <CardHeader>
                <CardTitle role="heading" aria-level={3}>A preview of somewhere</CardTitle>
                <CardDescription>
                  A card showing the first few of something says where the rest is, and
                  the chevron is a LINK — never a drawer.
                </CardDescription>
                <CardAction>
                  <Button asChild variant="ghost" size="icon"><a
                    href="#/kit"
                    aria-label="All of this, in its own place"
                  >
                    <Glyph icon={GLYPH.next} className="size-5" />
                  </a></Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                <p className="m-0 text-sm text-muted-foreground">
                  Two callers: recent activity, and every wallet.
                </p>
              </CardContent>
            </Card>
          </Spec>

          <Spec label="CardHeader action — an icon button that acts">
            <Card>
              <CardHeader>
                <CardTitle role="heading" aria-level={3}>A card whose data can be refreshed</CardTitle>
                <CardAction>
                  <Button type="button" variant="ghost" size="icon" aria-label="Check again">
                    <Glyph icon={GLYPH.switcher} className="size-5" />
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                <p className="m-0 text-sm text-muted-foreground">
                  The same slot, holding something that acts rather than navigates. The
                  money card&rsquo;s refresh control is this filling, and it is designed
                  in its own round rather than here.
                </p>
              </CardContent>
            </Card>
          </Spec>
        </div>

        <Spec label="CardHeader with a long title and a control — the alignment claim" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={3}>
                A title long enough to wrap onto a second line at a narrow width, which is
                where a control centred against the whole block starts to look wrong
              </CardTitle>
              <CardDescription>
                And a description under it, so the header is three lines tall. The control
                stays level with the first line of the title.
              </CardDescription>
              <CardAction>
                <Button asChild variant="ghost" size="icon"><a
                  href="#/kit"
                  aria-label="Somewhere else"
                >
                  <Glyph icon={GLYPH.next} className="size-5" />
                </a></Button>
              </CardAction>
            </CardHeader>
          </Card>
        </Spec>
      </Chapter>

      {/* ---------------- fields ---------------- */}

      <Chapter
        id="fields"
        title="Input, Textarea and Label"
        says="A label is a caption above its field, never beside it. The error state is
              aria-invalid — the attribute is the fact and the colour follows it."
      >
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <Spec label="default">
            <Label htmlFor="k-default" className="mb-2">Amount</Label>
            <Input id="k-default" placeholder="0.0000" />
          </Spec>

          <Spec label="mono — addresses, identifiers, piece bytes">
            <Label htmlFor="k-mono" className="mb-2">Pay to</Label>
            <Input className="font-mono text-sm tracking-tight" id="k-mono"  defaultValue="mn_shield-addr_test1vqqqq…8f3a91c7" />
          </Spec>

          <Spec label="aria-invalid — with the message beside it">
            <Label htmlFor="k-bad" className="mb-2">Amount</Label>
            <Input id="k-bad" aria-invalid="true" aria-describedby="k-bad-note" defaultValue="12.5" />
            <p id="k-bad-note" className="m-0 mt-1.5 text-sm text-destructive">
              That is more than this wallet holds.
            </p>
          </Spec>

          <Spec label="disabled and read-only">
            <Label htmlFor="k-dis" className="mb-2">Network</Label>
            <Input id="k-dis" disabled defaultValue="Not available yet" />
            <Input className="mt-2" readOnly defaultValue="Read-only — shown, not editable" />
          </Spec>

          <Spec label="textarea" className="md:col-span-2">
            <Label htmlFor="k-ta" className="mb-2">Paste a recovery piece</Label>
            <Textarea className="font-mono text-sm tracking-tight" id="k-ta"  placeholder="801f 4a2c 9b77 …" />
          </Spec>
        </div>
      </Chapter>

      {/* ---------------- alerts ---------------- */}

      <Chapter
        id="alerts"
        title="Alert"
        says="Four severities. The amber one lives here, and it states what is at risk rather
              than what is undone — which is why it does not read as a nag and why it has no
              close button."
      >
        <div className="flex flex-col gap-3">
          <StatusAlert
            tone="warning"
            title="If you lose this device your money is gone"
            role={null}
          >
            Nobody can recover it, including us. Cutting your account into pieces takes about
            five minutes and a printer.
          </StatusAlert>

          {ALERT_TONES.map((tone) => (
            <StatusAlert key={tone} tone={tone} title={`tone="${tone}"`} role={null}>
              One sentence of body text, in muted, so the title carries the fact and this
              carries the detail.
            </StatusAlert>
          ))}

          <StatusAlert tone="danger" title="A payment did not go through" role={null}>
            <p className="m-0">
              The reason is printed verbatim and is never blank — that is the rule.
            </p>
          </StatusAlert>

          <StatusAlert tone="info" role={null}>
            An alert with no title — body only.
          </StatusAlert>
        </div>
      </Chapter>

      {/* ---------------- empty states ---------------- */}

      <Chapter
        id="empty"
        title="EmptyState"
        says="An empty room, said honestly. It is never a zero and never a wait that has quietly
              stopped waiting."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <EmptyState
            icon={GLYPH.inbox}
            title="No payments yet"
            action={<Button type="button" variant="default" size="sm">Show your address</Button>}
          >
            When money arrives or leaves, it appears here.
          </EmptyState>
          <EmptyState icon={GLYPH.wallet} title="Nothing to show">
            An empty state with no action, because there is nothing useful to do from here.
          </EmptyState>
        </div>
      </Chapter>

      {/* ---------------- list rows ---------------- */}

      <Chapter
        id="rows"
        title="ListRow"
        says="A row that navigates is a link, a row that acts is a button, and a row that only
              displays is neither — so it is not a focus stop that does nothing."
      >
        <Card>
          <CardContent >
            <RowItems>
              <RowItem
                leading={<span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground"><Glyph icon={GLYPH.send} className="size-4" /></span>}
                title="Sent to mn_shield-addr_test1…8f3a"
                subtitle="21 August, 09:14"
                trailing="−12.0000 tNIGHT"
                meta={<StatusBadge tone="sent">Sent</StatusBadge>}
                href="#/kit"
              />
              <RowItem
                leading={<span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground"><Glyph icon={GLYPH.send} className="size-4" /></span>}
                title="Sent to mn_shield-addr_test1…c701"
                subtitle="21 August, 09:02"
                trailing="−3.5000 tNIGHT"
                meta={<StatusBadge tone="pending">Still confirming</StatusBadge>}
                onClick={() => undefined}
              />
              <RowItem
                title="A row that only displays"
                subtitle="No href and no handler — not in the tab order"
                trailing="—"
              />
              <RowItem title="The current row" subtitle="aria-current" current onClick={() => undefined} />
              <RowItem title="A disabled row" subtitle="Not pressable" disabled onClick={() => undefined} />
            </RowItems>
          </CardContent>
        </Card>
      </Chapter>

      {/* ---------------- section ---------------- */}

      <Chapter
        id="sections"
        title="Section"
        says="A titled region of a page. It is a real <section> with a real <h2> and
              aria-labelledby, so a screen reader's landmark list is a way to skip to the
              part you want — which a div with a bold paragraph on top is not."
      >
        <div className="grid gap-6 md:grid-cols-2">
          <Spec label="tone: default" badge={<StatusBadge>no box</StatusBadge>}>
            <Section
              list={false} box={false} aria-label="Network and hosts"
              title="Network and hosts"
              description="What this wallet is connected to. All of it is fixed, and none of it is a preference."
            >
              <Card>
                <CardContent >
                  <RowItems>
                    <RowItem title="Network" trailing={<span className="font-mono">stagenet</span>} />
                    <RowItem title="Balances are read from" trailing={<span className="font-mono">indexer.example</span>} />
                  </RowItems>
                </CardContent>
              </Card>
            </Section>
          </Spec>
          <Spec
            label="tone: danger"
            badge={<StatusBadge tone="failed">the only one that is not cosmetic</StatusBadge>}
          >
            <div data-danger-frame className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 md:p-5">
            <Section
              list={false}
              box={false}
              aria-label="Forget this wallet"
              data-tone="danger"
              title={<span className="text-destructive">Forget this wallet</span>}
              description="Clears this browser and everything in it. Nothing on the chain changes."
            >
              <p className="m-0 text-sm text-foreground">
                Apart, so a destructive region cannot be mistaken for the rows above it.
                It is a REGION and not an alert: an alert is a sentence that has just
                become true, and this is always here.
              </p>
              <div>
                <Button type="button" variant="destructive" disabled>Forget this wallet</Button>
              </div>
            </Section>
            </div>
          </Spec>
        </div>
      </Chapter>

      {/* ---------------- action tiles ---------------- */}

      <Chapter
        id="action-tiles"
        title="ActionTile"
        says="An entry point into something, as a tile. One that NAVIGATES is a link; one that
              ACTS is a button — and on Home that distinction is load-bearing, because Send is
              a link and one surface approves anything that moves money."
      >
        <ShortcutTiles>
          <ShortcutTile
            href="#/kit"
            glyph={GLYPH.send}
            tone="accent"
            label="A tile that navigates"
            says="An anchor — openable in a new tab"
          />
          <ShortcutTile
            onClick={() => undefined}
            glyph={GLYPH.receive}
            tone="accent"
            label="A tile that acts"
            says="A button — Space and Enter both work"
          />
          {/* THE SPECIMEN CARRIES THE PHRASE THE WALLET USES, because the
            * gallery is what the next screen is copied from. `Coming soon` is
            * what a planned feature is called — `screens/explore.tsx` carries
            * the decision — and a specimen still reading `Not built yet` is
            * how the losing phrase gets copied back in. */}
          <ShortcutTile
            onClick={() => undefined}
            glyph={GLYPH.earn}
            label="A quiet tile"
            says="Coming soon"
          />
          <ShortcutTile
            href="#/kit"
            glyph={GLYPH.contacts}
            label="A tile with a very long label that has to be cut off somewhere"
            says="And a very long line under it, which is cut off in the same way"
          />
        </ShortcutTiles>
      </Chapter>

      {/* ---------------- table ---------------- */}

      <Chapter
        id="table"
        title="Table"
        says="For things genuinely compared down a column. It scrolls inside its own box, so the
              page never scrolls sideways."
      >
        <Table>
          <TableCaption>Where this account’s pieces are — an invented example.</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Piece</TableHead>
              <TableHead>Where it is</TableHead>
              <TableHead>Locked with</TableHead>
              <TableHead className="text-right">Last verified</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>1</TableCell>
              <TableCell>A printed copy</TableCell>
              <TableCell className="text-muted-foreground">Nothing — the paper is the lock</TableCell>
              <TableCell className="text-right">21 Aug 2026</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>2</TableCell>
              <TableCell>A cloud account of mine</TableCell>
              <TableCell className="text-muted-foreground">A password</TableCell>
              <TableCell className="text-right">21 Aug 2026</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>3</TableCell>
              <TableCell>A second device</TableCell>
              <TableCell className="text-muted-foreground">A passkey</TableCell>
              <TableCell className="text-right text-warn">Never</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Chapter>

      {/* ---------------- skeleton and separator ---------------- */}

      <Chapter
        id="skeleton"
        title="Skeleton and Separator"
        says="A skeleton says something is arriving. When nothing is arriving, the honest failure
              state has words — a skeleton must never be what a person is left looking at."
      >
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <Spec label="Skeleton — a balance card that has not answered yet">
            <Card>
              <CardContent  aria-busy="true">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="mt-3 h-8 w-48" />
                <Skeleton className="mt-3 h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-2/3" />
              </CardContent>
            </Card>
          </Spec>
          <Spec label="Separator — horizontal and vertical">
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="m-0 text-sm text-muted-foreground">Above the rule</p>
              <Separator className="my-3" />
              <p className="m-0 text-sm text-muted-foreground">Below the rule</p>
              <div className="mt-4 flex h-10 items-center gap-3">
                <span className="text-sm text-muted-foreground">left</span>
                <Separator orientation="vertical" />
                <span className="text-sm text-muted-foreground">right</span>
              </div>
            </div>
          </Spec>
        </div>
      </Chapter>

      {/* ---------------- tooltip ---------------- */}

      <Chapter
        id="tooltip"
        title="Tooltip"
        says="The one component FETCHED rather than written. It exists because the
              desktop rail folds to icons, and a glyph with no word beside it needs a label
              that a keyboard can reach."
      >
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="outline" size="icon" aria-label="Send">
                  <Glyph icon={GLYPH.send} className="size-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>Send</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="sm">Hover me, or Tab to me</Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={8}>
                Radix opens this on focus as well as hover
              </TooltipContent>
            </Tooltip>
          </div>
        </>
        <p className="muted small" style={{ marginTop: '1rem' }}>
          Restyled onto this repo’s tokens and nothing else: <code>bg-ink</code>/
          <code>text-bg</code> for shadcn’s <code>bg-foreground</code>/
          <code>text-background</code>; <code>rounded-tight</code> for{' '}
          <code>rounded-md</code>; and the shell’s own <code>shell-fade</code> for a set of
          animation utilities this repo does not install. Every Radix part is as fetched —
          the original payload was printed in full before it was written.
        </p>
      </Chapter>

      <Chapter
        id="dialog"
        title="Dialog"
        says="The component FETCHED — shadcn's dialog, on Radix. It is a BOTTOM
              SHEET below 900px and a centred panel above, which is the shape
              shell/account.tsx has shipped all along rather than a second one."
      >
        <div className="flex flex-wrap gap-3">
          <Dialog>
            <DialogTrigger asChild>
              <Button type="button" variant="outline">Open a dialog</Button>
            </DialogTrigger>
            <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>A dialog</DialogTitle>
                <DialogDescription>
                  Radix traps focus inside this panel, closes it on Escape, locks the
                  page behind it, and returns focus to the control that opened it.
                  Every one of those is a thing a hand-rolled panel gets wrong quietly.
                </DialogDescription>
              </DialogHeader>
              <p className="m-0 text-sm text-muted-foreground">
                Nothing on this page does anything — this dialog holds text and a way
                out, and the way out is the specimen.
              </p>
              <DialogFooter showCloseButton />
            </DialogContent>
          </Dialog>

          <Dialog>
            <DialogTrigger asChild>
              <Button type="button" variant="outline">…with no close button</Button>
            </DialogTrigger>
            <DialogContent showCloseButton={false} className="max-h-[calc(100svh-2rem)] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>No corner control</DialogTitle>
                <DialogDescription>
                  `showCloseButton={'{false}'}` is for a panel whose only way out should
                  be a deliberate one. Escape and the overlay still close it, so this is
                  never a trap.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="default">Done</Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        <p className="muted small" style={{ marginTop: '1rem' }}>
          Eleven substitutions, all named in <code>kit/dialog.tsx</code> and measured against the installed Tailwind.{' '}
          The one that matters:{' '}
          <code>data-[state=open]:bg-accent</code> EMITS A RULE here and it is the WRONG
          one — shadcn means a neutral hover surface by <code>accent</code> and this
          repo means the indigo. Eleven of the payload’s class names emit nothing at
          all, six of them animation utilities from a package this repo does not
          install; the shell’s own <code>shell-fade</code> and <code>shell-rise</code>
          replace those.
        </p>
      </Chapter>

      <Chapter
        id="sidebar"
        title="Sidebar"
        says="The block FETCHED — shadcn's sidebar-07. What is drawn below is
              static: the live one is the app's frame, and it is looked at by opening the
              app rather than by visiting a workshop page."
      >
        <SidebarProvider className="min-h-0 w-auto flex-wrap gap-6">
          {([false, true] as const).map((collapsed) => (
            <div
              key={String(collapsed)}
              /* The block's own contract, set by hand rather than by the
               * provider: `group` plus `data-collapsible` is what every
               * `group-data-[collapsible=icon]` variant inside reacts to. That
               * is the whole mechanism, and showing both states side by side is
               * only possible because it is an ATTRIBUTE and not a hook. */
              className="group rounded-xl border bg-sidebar text-sidebar-foreground"
              data-state={collapsed ? 'collapsed' : 'expanded'}
              data-collapsible={collapsed ? 'icon' : ''}
              style={{ width: collapsed ? '4.75rem' : '14rem' }}
            >
              <SidebarHeader>
                <span className="wordmark px-2 py-1">
                  <span className="moon" aria-hidden="true" />
                  {!collapsed && 'Midnight Identity'}
                </span>
              </SidebarHeader>
              <SidebarGroup>
                <SidebarMenu>
                  {([
                    ['Home', GLYPH.home, true],
                    ['Activity', GLYPH.activity, false],
                    ['Explore', GLYPH.explore, false],
                    ['Settings', GLYPH.settings, false],
                  ] as const).map(([label, glyph, active]) => (
                    <SidebarMenuItem key={label}>
                      <SidebarMenuButton asChild isActive={active}>
                        <span>
                          <Glyph icon={glyph} />
                          {!collapsed && <span>{label}</span>}
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            </div>
          ))}
        </SidebarProvider>
        <p className="muted small" style={{ marginTop: '1rem' }}>
          Every specimen here is a <code>&lt;span&gt;</code>, not a link or a button:
          nothing on this page navigates, and the live sidebar’s rows are anchors.
          The eight <code>--sidebar-*</code> colour roles the payload declares were
          never admitted — the fetch’s own guard caught the write and restored{' '}
          <code>app.css</code> by hash. What is above is this repository’s own tokens,
          and <code>kit/sidebar.tsx</code> lists all nine substitutions.
        </p>
      </Chapter>

      <p className="faint small">
        End of the kit. Everything a screen is built from is on this page; if a screen needs
        something that is not, that is a decision, not a class at the call site.
      </p>
    </>
  );
}
