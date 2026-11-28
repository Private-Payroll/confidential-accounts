import type { ReactNode } from 'react';
import { Button, Card, CardContent, EmptyState, Input, Label, Section } from 'vaults-ui';
import { Textarea } from 'vaults-ui/components/textarea';
import { GLYPH, Glyph } from '../glyphs.js';
import { RowItem, RowItems, ShortcutTile, ShortcutTiles } from '../components/rows.js';
import { StatusAlert, StatusBadge } from '../components/status.js';
import { ALERT_TONES } from './kit-specimens.js';
import { Chapter, Spec } from './kit-parts.js';
import { NETWORK_LABEL } from './network-words.js';

export function FieldsChapter(): ReactNode {
  return (
    <>
      <Chapter
        id="fields"
        title="Input, Textarea and Label"
        says="A label is a caption above its field, never beside it. The error state is
              aria-invalid — the attribute is the fact and the colour follows it."
      >
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <Spec label="default">
            <Label htmlFor="k-default" className="mb-2">
              Amount
            </Label>
            <Input id="k-default" placeholder="0.0000" />
          </Spec>

          <Spec label="mono — addresses, identifiers, piece bytes">
            <Label htmlFor="k-mono" className="mb-2">
              Pay to
            </Label>
            <Input
              className="font-mono text-sm tracking-tight"
              id="k-mono"
              defaultValue="mn_shield-addr_test1vqqqq…8f3a91c7"
            />
          </Spec>

          <Spec label="aria-invalid — with the message beside it">
            <Label htmlFor="k-bad" className="mb-2">
              Amount
            </Label>
            <Input id="k-bad" aria-invalid="true" aria-describedby="k-bad-note" defaultValue="12.5" />
            <p id="k-bad-note" className="m-0 mt-1.5 text-sm text-destructive">
              That is more than this wallet holds.
            </p>
          </Spec>

          <Spec label="disabled and read-only">
            <Label htmlFor="k-dis" className="mb-2">
              Network
            </Label>
            <Input id="k-dis" disabled defaultValue="Not available yet" />
            <Input className="mt-2" readOnly defaultValue="Read-only — shown, not editable" />
          </Spec>

          <Spec label="textarea" className="md:col-span-2">
            <Label htmlFor="k-ta" className="mb-2">
              Paste a recovery piece
            </Label>
            <Textarea className="font-mono text-sm tracking-tight" id="k-ta" placeholder="801f 4a2c 9b77 …" />
          </Spec>
        </div>
      </Chapter>
    </>
  );
}

export function AlertsChapter(): ReactNode {
  return (
    <>
      <Chapter
        id="alerts"
        title="Alert"
        says="Four severities. The amber one lives here, and it states what is at risk rather
              than what is undone — which is why it does not read as a nag and why it has no
              close button."
      >
        <div className="flex flex-col gap-3">
          <StatusAlert tone="warning" title="If you lose this device your money is gone" role={null}>
            Nobody can recover it, including us. Cutting your account into pieces takes about five minutes and a
            printer.
          </StatusAlert>

          {ALERT_TONES.map((tone) => (
            <StatusAlert key={tone} tone={tone} title={`tone="${tone}"`} role={null}>
              One sentence of body text, in muted, so the title carries the fact and this carries the detail.
            </StatusAlert>
          ))}

          <StatusAlert tone="danger" title="A payment did not go through" role={null}>
            <p className="m-0">The reason is printed verbatim and is never blank — that is the rule.</p>
          </StatusAlert>

          <StatusAlert tone="info" role={null}>
            An alert with no title — body only.
          </StatusAlert>
        </div>
      </Chapter>
    </>
  );
}

export function EmptyStatesChapter(): ReactNode {
  return (
    <>
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
            action={
              <Button type="button" variant="default" size="sm">
                Show your address
              </Button>
            }
          >
            When money arrives or leaves, it appears here.
          </EmptyState>
          <EmptyState icon={GLYPH.wallet} title="Nothing to show">
            An empty state with no action, because there is nothing useful to do from here.
          </EmptyState>
        </div>
      </Chapter>
    </>
  );
}

export function ListRowsChapter(): ReactNode {
  return (
    <>
      <Chapter
        id="rows"
        title="ListRow"
        says="A row that navigates is a link, a row that acts is a button, and a row that only
              displays is neither — so it is not a focus stop that does nothing."
      >
        <Card>
          <CardContent>
            <RowItems>
              <RowItem
                leading={
                  <span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Glyph icon={GLYPH.send} className="size-4" />
                  </span>
                }
                title="Sent to mn_shield-addr_test1…8f3a"
                subtitle="21 August, 09:14"
                trailing="−12.0000 tNIGHT"
                meta={<StatusBadge tone="sent">Sent</StatusBadge>}
                href="#/kit"
              />
              <RowItem
                leading={
                  <span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Glyph icon={GLYPH.send} className="size-4" />
                  </span>
                }
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
    </>
  );
}

export function SectionChapter(): ReactNode {
  return (
    <>
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
              list={false}
              box={false}
              aria-label="Network and hosts"
              title="Network and hosts"
              description="What this wallet is connected to. All of it is fixed, and none of it is a preference."
            >
              <Card>
                <CardContent>
                  <RowItems>
                    <RowItem title="Network" trailing={<span className="font-mono">{NETWORK_LABEL}</span>} />
                    <RowItem
                      title="Balances are read from"
                      trailing={<span className="font-mono">indexer.example</span>}
                    />
                  </RowItems>
                </CardContent>
              </Card>
            </Section>
          </Spec>
          <Spec label="tone: danger" badge={<StatusBadge tone="failed">the only one that is not cosmetic</StatusBadge>}>
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
                  Apart, so a destructive region cannot be mistaken for the rows above it. It is a REGION and not an
                  alert: an alert is a sentence that has just become true, and this is always here.
                </p>
                <div>
                  <Button type="button" variant="destructive" disabled>
                    Forget this wallet
                  </Button>
                </div>
              </Section>
            </div>
          </Spec>
        </div>
      </Chapter>
    </>
  );
}

export function ActionTilesChapter(): ReactNode {
  return (
    <>
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
          <ShortcutTile onClick={() => undefined} glyph={GLYPH.earn} label="A quiet tile" says="Coming soon" />
          <ShortcutTile
            href="#/kit"
            glyph={GLYPH.contacts}
            label="A tile with a very long label that has to be cut off somewhere"
            says="And a very long line under it, which is cut off in the same way"
          />
        </ShortcutTiles>
      </Chapter>
    </>
  );
}
