import type { ReactNode } from 'react';
import {
  ActionTile, ActionTiles,
  Alert, Badge, Button, ButtonLink, Card, CardContent, CardDescription, CardFooter, CardHeader,
  CardTitle, EmptyState, GLYPH, Icon, Input, Label, ListRow, ListRows, Separator, Skeleton, Table,
  TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, Textarea, Tooltip,
  TooltipContent, TooltipProvider, TooltipTrigger,
  Section,
  SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuItem, sidebarMenuButtonVariants,
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, DialogTrigger,
} from '../kit/index.js';
import type { AlertTone, BadgeTone, ButtonSize, ButtonVariant } from '../kit/index.js';
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
      <div className="mb-4 border-b border-line pb-2">
        <h2 className="m-0 text-lg font-semibold text-ink">{title}</h2>
        {says !== undefined && <p className="m-0 mt-1 text-sm text-muted">{says}</p>}
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
      <p className="m-0 mb-2 flex flex-wrap items-center gap-2 font-mono text-xs text-faint">
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
        className="size-10 shrink-0 rounded-tight border border-line"
        style={{ background: `var(${token})` }}
        aria-hidden="true"
      />
      <span className="min-w-0">
        <span className="block font-mono text-xs text-ink">{name}</span>
        {note !== undefined && <span className="block text-xs text-muted">{note}</span>}
      </span>
    </div>
  );
}

/* ---------- the specimens ---------- */

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
  { cls: 'text-display', name: 'text-display — 2.75rem' },
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

      <div className="mb-10 flex flex-wrap items-center gap-2 rounded-card border border-line bg-raised p-3">
        <span className="text-sm font-medium text-muted">Theme</span>
        {THEME_ENTRIES.map((option) => (
          <Button
            key={option.value}
            size="sm"
            variant={choice === option.value ? 'primary' : 'outline'}
            aria-pressed={choice === option.value}
            onClick={() => setChoice(option.value)}
          >
            {option.label}
          </Button>
        ))}
        <span className="ml-auto text-xs text-faint">
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
        <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 wide:grid-cols-3">
          {COLOUR_ROLES.map((role) => (
            <Swatch key={role.token} token={role.token} name={role.token} note={role.note} />
          ))}
        </div>

        <div className="grid grid-cols-1 gap-6 wide:grid-cols-3">
          <Spec label="radius — three steps, derived from one anchor">
            <div className="flex items-end gap-3">
              <span className="flex size-16 items-center justify-center rounded-tight border border-line-strong bg-raised text-xs text-muted">tight</span>
              <span className="flex size-16 items-center justify-center rounded-card border border-line-strong bg-raised text-xs text-muted">card</span>
              <span className="flex h-9 items-center justify-center rounded-pill border border-line-strong bg-raised px-4 text-xs text-muted">pill</span>
            </div>
            <p className="m-0 mt-3 text-sm text-muted">
              <code>--radius-anchor</code> is <code>0.875rem</code>, which is what shadcn
              4.18.0 calls “large”. <code>tight</code> and <code>card</code> are{' '}
              <code>calc()</code> either side of it, so “rounder” is one edit.
            </p>
          </Spec>

          <Spec label="type — the scale, and no arbitrary values">
            <div className="flex flex-col gap-1">
              {TYPE_STEPS.map((step) => (
                <p key={step.cls} className={`m-0 ${step.cls} text-ink`}>{step.name}</p>
              ))}
            </div>
            <p className="m-0 mt-3 text-sm text-muted">
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
                  className="h-12 w-8 rounded-tight border border-line"
                  style={{ background: `var(--color-chart-${n})` }}
                  aria-hidden="true"
                />
              ))}
            </div>
            <p className="m-0 mt-3 text-sm text-muted">
              All five are cool on purpose. A chart colour says <em>this series</em>, and a
              series drawn in the same red as a failed payment is a sentence the chart did
              not mean to say.
            </p>
          </Spec>

          <Spec label="the smallest touch target — 44px">
            <div className="flex items-center gap-3">
              <span className="size-touch rounded-tight border border-dashed border-accent" aria-hidden="true" />
              <span className="text-sm text-muted">
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
                ? <Badge tone="warning">by request only</Badge>
                : undefined}
            >
              <div className="flex flex-wrap items-center gap-3">
                {BUTTON_SIZES.map((size) => (
                  <Button key={size} variant={variant} size={size}>
                    {size === 'icon' ? <Icon glyph={GLYPH.send} /> : size}
                    {size === 'icon' && <span className="visually-hidden">Send</span>}
                  </Button>
                ))}
                <Button variant={variant} disabled>disabled</Button>
              </div>
            </Spec>
          ))}
        </div>

        <Alert tone="info" title="Four variants, not six" role={null} className="mt-2">
          <strong>primary</strong>, <strong>secondary</strong>, <strong>ghost</strong> and{' '}
          <strong>danger</strong> are what a screen reaches for.{' '}
          <strong>outline</strong> and <strong>link</strong> are <em>by request only</em> —
          they exist because shadcn’s shapes have them and a screen that wants one is asking
          for a decision, not picking a class. This label is the enforcement: this page is
          what a session reads before it builds a screen.
        </Alert>

        <Separator className="my-6" decorative />

        <div className="grid grid-cols-1 gap-6 wide:grid-cols-2">
          <Spec label="with an icon — the ordinary case">
            <div className="flex flex-wrap gap-3">
              <Button variant="primary"><Icon glyph={GLYPH.send} />Send</Button>
              <Button variant="secondary"><Icon glyph={GLYPH.printer} />Print this sheet</Button>
              <Button variant="danger"><Icon glyph={GLYPH.secured} />Cut a fresh set</Button>
            </div>
          </Spec>
          <Spec label="ButtonLink — an anchor, because href means navigation">
            <div className="flex flex-wrap gap-3">
              <ButtonLink href="#/kit" variant="primary">A link that looks like a button</ButtonLink>
              <ButtonLink href="#/kit" variant="link">A link that looks like a link</ButtonLink>
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
            <Badge key={tone} tone={tone}>{tone}</Badge>
          ))}
        </div>
        <p className="muted small" style={{ marginTop: '1rem' }}>
          In a list: <Badge tone="pending">Still confirming</Badge>{' '}
          <Badge tone="sent">Sent</Badge> <Badge tone="failed">Did not go through</Badge>
        </p>
      </Chapter>

      {/* ---------------- cards ---------------- */}

      <Chapter
        id="cards"
        title="Card"
        says="Header, content, footer. The footer sits on a rule, and the header can carry
              one control on its right edge."
      >
        <div className="grid grid-cols-1 gap-4 wide:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Header, content and footer</CardTitle>
              <CardDescription>The description sits under the title, in muted text.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="m-0 text-sm text-muted">
                A card knows nothing about what is inside it. That is the same rule the shell
                follows about a place.
              </p>
            </CardContent>
            <CardFooter>
              <Button variant="primary" size="sm">Confirm</Button>
              <Button variant="ghost" size="sm">Not now</Button>
            </CardFooter>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Content only</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="m-0 font-mono text-2xl font-semibold text-ink">
                1,240.5000 <span className="font-sans text-sm font-medium text-muted">tNIGHT</span>
              </p>
              <p className="m-0 mt-1 text-xs text-faint">
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
        <p className="m-0 mt-8 mb-4 text-sm text-muted">
          The header can carry <strong>one</strong> control on its right edge. It is a
          slot, not a button: the kit fixes the position — right edge, aligned to the
          title and not to the block beneath it — and the screen decides what sits
          there. More than one control is a footer.
        </p>
        <div className="grid grid-cols-1 gap-4 wide:grid-cols-2">
          <Spec label="CardHeader action — a chevron to the place this card previews">
            <Card>
              <CardHeader
                action={(
                  <ButtonLink
                    variant="ghost"
                    size="icon"
                    href="#/kit"
                    aria-label="All of this, in its own place"
                  >
                    <Icon glyph={GLYPH.next} className="size-5" />
                  </ButtonLink>
                )}
              >
                <CardTitle>A preview of somewhere</CardTitle>
                <CardDescription>
                  A card showing the first few of something says where the rest is, and
                  the chevron is a LINK — never a drawer.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="m-0 text-sm text-muted">
                  Two callers: recent activity, and every wallet.
                </p>
              </CardContent>
            </Card>
          </Spec>

          <Spec label="CardHeader action — an icon button that acts">
            <Card>
              <CardHeader
                action={(
                  <Button variant="ghost" size="icon" aria-label="Check again">
                    <Icon glyph={GLYPH.switcher} className="size-5" />
                  </Button>
                )}
              >
                <CardTitle>A card whose data can be refreshed</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="m-0 text-sm text-muted">
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
            <CardHeader
              action={(
                <ButtonLink
                  variant="ghost"
                  size="icon"
                  href="#/kit"
                  aria-label="Somewhere else"
                >
                  <Icon glyph={GLYPH.next} className="size-5" />
                </ButtonLink>
              )}
            >
              <CardTitle>
                A title long enough to wrap onto a second line at a narrow width, which is
                where a control centred against the whole block starts to look wrong
              </CardTitle>
              <CardDescription>
                And a description under it, so the header is three lines tall. The control
                stays level with the first line of the title.
              </CardDescription>
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
        <div className="grid grid-cols-1 gap-5 wide:grid-cols-2">
          <Spec label="default">
            <Label htmlFor="k-default">Amount</Label>
            <Input id="k-default" placeholder="0.0000" />
          </Spec>

          <Spec label="mono — addresses, identifiers, piece bytes">
            <Label htmlFor="k-mono">Pay to</Label>
            <Input id="k-mono" mono defaultValue="mn_shield-addr_test1vqqqq…8f3a91c7" />
          </Spec>

          <Spec label="aria-invalid — with the message beside it">
            <Label htmlFor="k-bad">Amount</Label>
            <Input id="k-bad" aria-invalid="true" aria-describedby="k-bad-note" defaultValue="12.5" />
            <p id="k-bad-note" className="m-0 mt-1.5 text-sm text-bad">
              That is more than this wallet holds.
            </p>
          </Spec>

          <Spec label="disabled and read-only">
            <Label htmlFor="k-dis">Network</Label>
            <Input id="k-dis" disabled defaultValue="Not available yet" />
            <Input className="mt-2" readOnly defaultValue="Read-only — shown, not editable" />
          </Spec>

          <Spec label="textarea" className="wide:col-span-2">
            <Label htmlFor="k-ta">Paste a recovery piece</Label>
            <Textarea id="k-ta" mono placeholder="801f 4a2c 9b77 …" />
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
          <Alert
            tone="warning"
            title="If you lose this device your money is gone"
            role={null}
          >
            Nobody can recover it, including us. Cutting your account into pieces takes about
            five minutes and a printer.
          </Alert>

          {ALERT_TONES.map((tone) => (
            <Alert key={tone} tone={tone} title={`tone="${tone}"`} role={null}>
              One sentence of body text, in muted, so the title carries the fact and this
              carries the detail.
            </Alert>
          ))}

          <Alert tone="danger" title="A payment did not go through" role={null}>
            <p className="m-0">
              The reason is printed verbatim and is never blank — that is the rule.
            </p>
          </Alert>

          <Alert tone="info" role={null}>
            An alert with no title — body only.
          </Alert>
        </div>
      </Chapter>

      {/* ---------------- empty states ---------------- */}

      <Chapter
        id="empty"
        title="EmptyState"
        says="An empty room, said honestly. It is never a zero and never a wait that has quietly
              stopped waiting."
      >
        <div className="grid grid-cols-1 gap-4 wide:grid-cols-2">
          <EmptyState
            icon={GLYPH.inbox}
            title="No payments yet"
            action={<Button variant="primary" size="sm">Show your address</Button>}
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
          <CardContent className="pt-5">
            <ListRows>
              <ListRow
                leading={<span className="flex size-9 items-center justify-center rounded-pill bg-sunken text-muted"><Icon glyph={GLYPH.send} className="size-4" /></span>}
                title="Sent to mn_shield-addr_test1…8f3a"
                subtitle="21 August, 09:14"
                trailing="−12.0000 tNIGHT"
                meta={<Badge tone="sent">Sent</Badge>}
                href="#/kit"
              />
              <ListRow
                leading={<span className="flex size-9 items-center justify-center rounded-pill bg-sunken text-muted"><Icon glyph={GLYPH.send} className="size-4" /></span>}
                title="Sent to mn_shield-addr_test1…c701"
                subtitle="21 August, 09:02"
                trailing="−3.5000 tNIGHT"
                meta={<Badge tone="pending">Still confirming</Badge>}
                onClick={() => undefined}
              />
              <ListRow
                title="A row that only displays"
                subtitle="No href and no handler — not in the tab order"
                trailing="—"
              />
              <ListRow title="The current row" subtitle="aria-current" current onClick={() => undefined} />
              <ListRow title="A disabled row" subtitle="Not pressable" disabled onClick={() => undefined} />
            </ListRows>
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
        <div className="grid gap-6 wide:grid-cols-2">
          <Spec label="tone: default" badge={<Badge>no box</Badge>}>
            <Section
              title="Network and hosts"
              description="What this wallet is connected to. All of it is fixed, and none of it is a preference."
            >
              <Card>
                <CardContent className="pt-5">
                  <ListRows>
                    <ListRow title="Network" trailing={<span className="font-mono">stagenet</span>} />
                    <ListRow title="Balances are read from" trailing={<span className="font-mono">indexer.example</span>} />
                  </ListRows>
                </CardContent>
              </Card>
            </Section>
          </Spec>
          <Spec
            label="tone: danger"
            badge={<Badge tone="failed">the only one that is not cosmetic</Badge>}
          >
            <Section
              tone="danger"
              title="Forget this wallet"
              description="Clears this browser and everything in it. Nothing on the chain changes."
            >
              <p className="m-0 text-sm text-ink">
                Apart, so a destructive region cannot be mistaken for the rows above it.
                It is a REGION and not an alert: an alert is a sentence that has just
                become true, and this is always here.
              </p>
              <div>
                <Button variant="danger" disabled>Forget this wallet</Button>
              </div>
            </Section>
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
        <ActionTiles>
          <ActionTile
            href="#/kit"
            glyph={GLYPH.send}
            tone="accent"
            label="A tile that navigates"
            says="An anchor — openable in a new tab"
          />
          <ActionTile
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
          <ActionTile
            onClick={() => undefined}
            glyph={GLYPH.earn}
            label="A quiet tile"
            says="Coming soon"
          />
          <ActionTile
            href="#/kit"
            glyph={GLYPH.contacts}
            label="A tile with a very long label that has to be cut off somewhere"
            says="And a very long line under it, which is cut off in the same way"
          />
        </ActionTiles>
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
          <TableHead>
            <TableRow>
              <TableHeader>Piece</TableHeader>
              <TableHeader>Where it is</TableHeader>
              <TableHeader>Locked with</TableHeader>
              <TableHeader className="text-right">Last verified</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            <TableRow>
              <TableCell>1</TableCell>
              <TableCell>A printed copy</TableCell>
              <TableCell className="text-muted">Nothing — the paper is the lock</TableCell>
              <TableCell className="text-right">21 Aug 2026</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>2</TableCell>
              <TableCell>A cloud account of mine</TableCell>
              <TableCell className="text-muted">A password</TableCell>
              <TableCell className="text-right">21 Aug 2026</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>3</TableCell>
              <TableCell>A second device</TableCell>
              <TableCell className="text-muted">A passkey</TableCell>
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
        <div className="grid grid-cols-1 gap-6 wide:grid-cols-2">
          <Spec label="Skeleton — a balance card that has not answered yet">
            <Card>
              <CardContent className="pt-5" aria-busy="true">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="mt-3 h-8 w-48" />
                <Skeleton className="mt-3 h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-2/3" />
              </CardContent>
            </Card>
          </Spec>
          <Spec label="Separator — horizontal and vertical">
            <div className="rounded-card border border-line bg-raised p-4">
              <p className="m-0 text-sm text-muted">Above the rule</p>
              <Separator className="my-3" />
              <p className="m-0 text-sm text-muted">Below the rule</p>
              <div className="mt-4 flex h-10 items-center gap-3">
                <span className="text-sm text-muted">left</span>
                <Separator orientation="vertical" />
                <span className="text-sm text-muted">right</span>
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
        <TooltipProvider delayDuration={250}>
          <div className="flex flex-wrap items-center gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="secondary" size="icon" aria-label="Send">
                  <Icon glyph={GLYPH.send} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>Send</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm">Hover me, or Tab to me</Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={8}>
                Radix opens this on focus as well as hover
              </TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
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
              <Button variant="secondary">Open a dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>A dialog</DialogTitle>
                <DialogDescription>
                  Radix traps focus inside this panel, closes it on Escape, locks the
                  page behind it, and returns focus to the control that opened it.
                  Every one of those is a thing a hand-rolled panel gets wrong quietly.
                </DialogDescription>
              </DialogHeader>
              <p className="m-0 text-sm text-muted">
                Nothing on this page does anything — this dialog holds text and a way
                out, and the way out is the specimen.
              </p>
              <DialogFooter showCloseButton />
            </DialogContent>
          </Dialog>

          <Dialog>
            <DialogTrigger asChild>
              <Button variant="secondary">…with no close button</Button>
            </DialogTrigger>
            <DialogContent showCloseButton={false}>
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
                  <Button variant="primary">Done</Button>
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
        <div className="flex flex-wrap gap-6">
          {([false, true] as const).map((collapsed) => (
            <div
              key={String(collapsed)}
              /* The block's own contract, set by hand rather than by the
               * provider: `group` plus `data-collapsible` is what every
               * `group-data-[collapsible=icon]` variant inside reacts to. That
               * is the whole mechanism, and showing both states side by side is
               * only possible because it is an ATTRIBUTE and not a hook. */
              className="group rounded-card border border-line bg-raised"
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
                      <span
                        className={sidebarMenuButtonVariants({})}
                        data-active={active}
                        data-sidebar="menu-button"
                      >
                        <Icon glyph={glyph} />
                        {!collapsed && <span>{label}</span>}
                      </span>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroup>
            </div>
          ))}
        </div>
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
