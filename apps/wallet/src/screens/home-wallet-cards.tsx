import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Identity, Secret } from 'midnight-identity';
import { nightFromStars } from '../chain/amount.js';
import { hrefOf } from '../routes.js';
import { WALLET_ACCOUNTS, displayNameOf, hueOf } from '../accounts/subwallets.js';
import { WalletSwitcher } from '../shell/switcher.js';
import {
  WalletBalanceCell,
  anyNeverChecked,
  earnsAPreviewPlace,
  rowFor,
  useWalletBalances
} from '../shell/wallet-balances.js';
import { dismissPendingSend, liveResolutionDoors, loadPendingSends, resolvePendingSends } from '../chain/pending.js';
import type { PendingSend, ResolutionDoors } from '../chain/pending.js';
import {
  Button,
  CardAction,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  EmptyState
} from 'vaults-ui';
import { RowItem, RowItems } from '../components/rows.js';
import { GLYPH, Glyph } from '../glyphs.js';

/* --------------------------------------------------------- recent activity */

/**
 * RECENT ACTIVITY — the link is what makes this change additive.
 *
 * **THE LIST IS EMPTY BECAUSE NOTHING READS HISTORY YET, AND THE SCREEN SAYS
 * THAT RATHER THAN SHOWING AN EMPTY LIST OF PAYMENTS.** The same discipline
 * applied to a list instead of a balance: *"nothing here yet"* and *"we have
 * not asked"* are different sentences, and only one of them is true here.
 * `facade.getAllFromTxHistory()` exists and Activity's own round wires it; a
 * home screen that printed "no payments" today would be making a claim about
 * money out of a feature that is not built.
 *
 * "View all" IS A LINK TO A PLACE, never a drawer — the rule that
 * makes a right panel a later addition instead of a rewrite.
 *
 * THE AFFORDANCE MOVED AND THE RULE DID NOT. It was a `View all`
 * link in the footer; it is the card header's action slot now, holding a
 * chevron. **It is still an anchor and it still goes to `#/activity`** — the
 * rule at the top of this comment is the one thing about it that may never
 * change, and the test asserts the `href` rather than the words.
 *
 * THE WORDS DID NOT DISAPPEAR, THEY MOVED INTO THE ACCESSIBLE NAME. An
 * icon-only control with no name is an unnamed link in a screen reader's list,
 * which is worse than the footer it replaced.
 */
export function RecentActivity(): ReactNode {
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={3}>
          Recent activity
        </CardTitle>
        <CardAction>
          <Button asChild variant="ghost" size="icon">
            <a href={hrefOf('activity')} aria-label="View all activity" title="View all activity">
              <Glyph icon={GLYPH.next} className="size-5" />
            </a>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <EmptyState icon={GLYPH.inbox} title="Payment history is not read on this screen yet">
          The wallet SDK already answers for it — this is a screen to build, not a capability to invent. Nothing above
          is a statement that no payments exist.
        </EmptyState>
      </CardContent>
    </Card>
  );
}

/* --------------------------------------------------------- every wallet */

/**
 * HOW MANY SLOTS THE PREVIEW SHOWS WHEN NONE OF THEM IS KNOWN TO HOLD MONEY.
 * Three, by decision. It is a FLOOR: see the note on `AllWalletsCard`.
 */
const PREVIEWED = 3;

/**
 * EVERY WALLET, HONESTLY — and it is a PREVIEW of the switcher.
 *
 * WHAT IT IS FOR HAS NOT MOVED. Live sync follows the OPEN wallet only, and
 * this card is what keeps that decision from hiding money: each slot shows the
 * last number anyone established WITH ITS AGE, and a slot nobody has ever
 * checked says so in warning words — because a subwallet that never syncs is
 * one money can arrive in with nobody told, which is §2.3's invisible-money
 * trap arriving through a performance decision. **It is that trap on the screen**,
 * and six assertions stand on it.
 *
 * WHAT CHANGES. Eleven rows is a wall. So the card shows a
 * FEW, with a chevron in its header to the switcher, and **the sweep moves
 * into the switcher** where a person has asked to see all of them. One list,
 * three doors: the sidebar's chip, the money card's *Switch wallet*, and this
 * chevron all open the same surface.
 *
 * =====================================================================
 * THE FIRST THREE ARE NOT ALWAYS THREE, AND THAT IS THE RULE HOLDING.
 * =====================================================================
 *
 * THE RULE: *"a slot holding money is always listed, named or not …
 * three rows plus a chevron must not become a way for a funded slot to be
 * invisible. If 'the first three' can hide a slot that holds money, then it is
 * not the first three — a funded slot outranks an empty one for a place in
 * that list."*
 *
 * A rank alone does not finish the job: with FOUR funded slots, three rows
 * ranked perfectly still hide one of them. So the three is a FLOOR and not a
 * ceiling — every slot known to hold money is listed, and the preview is
 * topped up to three from the rest in slot order. In practice that is three
 * rows, because most slots are empty; the day it is five, it is five, and no
 * money is behind a press.
 *
 * AN UNCHECKED SLOT IS NOT AN EMPTY ONE and does not rank — it cannot, nothing
 * has asked. **That is what the warning sentence is for**, and it is computed
 * over all eleven rather than over the three shown, so shortening the list did
 * not shorten what the card admits.
 *
 * THE DERIVATION IS UNAFFECTED: the list is built from `WALLET_ACCOUNTS`, which never
 * contains account 1.
 */
export function AllWalletsCard({
  identity,
  secret,
  names,
  changed
}: {
  readonly identity: Identity;
  readonly secret: Secret;
  readonly names: Readonly<Record<string, string>>;
  readonly changed: number;
}): ReactNode {
  const { rows } = useWalletBalances(identity, changed);

  /* THE RANK, IN ONE LINE, AND THE ONLY QUESTION IT ASKS THE NUMBER IS
   * WHETHER IT IS MORE THAN NOTHING (`holdsMoney`, `shell/wallet-balances.tsx`
   * — the one question whose answer is the same in every unit, which is why
   * this is not a second reader of the atomic figure). A figure that did not
   * record the other tokens ranks with them (`earnsAPreviewPlace`). */
  const funded = WALLET_ACCOUNTS.filter((account) => earnsAPreviewPlace(rowFor(rows, account)));
  const rest = WALLET_ACCOUNTS.filter((account) => !earnsAPreviewPlace(rowFor(rows, account)));
  const shown = [...funded, ...rest.slice(0, Math.max(0, PREVIEWED - funded.length))].sort((a, b) => a - b);
  const hidden = WALLET_ACCOUNTS.length - shown.length;

  return (
    <Card aria-label="Every wallet's last known balance">
      <CardHeader>
        <CardTitle role="heading" aria-level={3}>
          Every wallet
        </CardTitle>
        <CardDescription>
          Live checking follows the wallet that is open. The others show the last time anyone looked — and how long ago
          that was.
        </CardDescription>
        <CardAction>
          <WalletSwitcher identity={identity} secret={secret}>
            <Button type="button" variant="ghost" size="icon" aria-label="See every wallet" title="See every wallet">
              <Glyph icon={GLYPH.next} className="size-5" />
            </Button>
          </WalletSwitcher>
        </CardAction>
      </CardHeader>
      <CardContent>
        <RowItems>
          {shown.map((account) => (
            <div
              key={account}
              /* `data-wallet-preview-row`, a NEW name for a NEW claim.
               * `data-wallet-balance-row` names *a row of the full eleven*
               * and moved to the switcher with them; this attribute names *a
               * row of the preview*, and keeping them apart is what lets a
               * test say which list it is looking at. */
              data-wallet-preview-row=""
              data-account={account}
              style={{ '--wallet-hue': String(hueOf(account)) } as CSSProperties}
            >
              <RowItem
                leading={<span className="wallet-swatch small" aria-hidden="true" />}
                title={displayNameOf(account, names)}
                trailing={<WalletBalanceCell row={rowFor(rows, account)} />}
              />
            </div>
          ))}
        </RowItems>
        {hidden > 0 && (
          <p className="m-0 mt-3 text-xs text-muted-foreground">
            {hidden === 1 ? 'One more slot is not shown here.' : `${hidden} more slots are not shown here.`} Every slot
            this wallet has, and the control that checks them all, is behind the arrow above.
          </p>
        )}
        {anyNeverChecked(rows) && (
          <p className="m-0 mt-3 text-sm text-warn-text">
            A wallet never checked can be holding money nobody was told about — its address exists whether or not anyone
            looks.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/* --------------------------------------------------- the carried question */

/**
 * THE CARRIED QUESTION. A payment whose outcome was not
 * known when its screen closed does not become nobody's problem: the record
 * written before submission (`pending.ts`) surfaces HERE, on the screen a person
 * actually returns to, and resolves itself against the chain — on mount (every
 * start), then on a timer — with nobody pressing anything. When the answer
 * arrives it stays on this card until a person dismisses it, because an answer
 * nobody saw is not yet an answer.
 *
 * Renders NOTHING when there is nothing pending — most days, for most people,
 * this card does not exist.
 *
 * **IT WAS PLACED AND WAS NOT REBUILT.** Its words are unchanged and are not
 * this change's; the amber banner stays amber, and the two answer cards stay the
 * cards a person dismisses. Only the wrapper markup below is the kit's.
 */
export function PendingSendsCard({
  secret,
  resolution
}: {
  readonly secret: Secret;
  /** Injectable for tests; the app asks the real indexer by identifier. */
  readonly resolution?: ResolutionDoors;
}): ReactNode {
  const [records, setRecords] = useState<PendingSend[]>(() => loadPendingSends(secret));
  const doors = resolution;
  useEffect(() => {
    let stale = false;
    const refresh = (): void => {
      if (!stale) setRecords(loadPendingSends(secret));
    };
    const resolve = (): void => {
      if (loadPendingSends(secret).every((r) => r.outcome !== null)) return;
      void resolvePendingSends(secret, doors ?? liveResolutionDoors())
        .then((settled) => {
          if (settled.length > 0) refresh();
        })
        .catch(() => {
          /* silence is not an answer; the next round asks again */
        });
    };
    resolve();
    const timer = setInterval(resolve, 15_000);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [secret, doors]);
  if (records.length === 0) return null;
  const dismiss = (key: string): void => {
    dismissPendingSend(secret, key);
    setRecords(loadPendingSends(secret));
  };
  return (
    <>
      {records.map((r) => {
        const amount = `${nightFromStars(BigInt(r.stars))} tNIGHT`;
        const to = `${r.recipientBech32.slice(0, 20)}…${r.recipientBech32.slice(-8)}`;
        if (r.outcome === null) {
          return (
            <section className="warn-banner" role="status" key={r.key} aria-label="A payment is still confirming">
              <h2>A payment is still confirming.</h2>
              <p className="small">
                {amount} to {to}, handed to the network {new Date(r.submittedAt).toLocaleString()}. Whether it went
                through is not known yet — this wallet is watching the chain and will say sent or failed here, on its
                own. <strong>Do not send this payment again</strong>; the send screen refuses it while this one is
                unresolved.
              </p>
              <details className="reveal">
                <summary>The identifier{r.identifiers.length === 1 ? '' : 's'}, for checking elsewhere</summary>
                {r.identifiers.map((id) => (
                  <div className="address-full" key={id}>
                    {id}
                  </div>
                ))}
              </details>
            </section>
          );
        }
        return r.outcome.name === 'sent' ? (
          <Card role="status" key={r.key} aria-label="A payment went through">
            <CardHeader>
              <CardTitle role="heading" aria-level={3} className="flex items-center gap-2">
                <span className="ok" aria-hidden="true">
                  ✓
                </span>{' '}
                That payment went through.
              </CardTitle>
              <CardDescription>
                {amount} to {to} — submitted {new Date(r.submittedAt).toLocaleString()}, confirmed on the chain by its
                identifier.
              </CardDescription>
            </CardHeader>
            <CardFooter>
              <Button type="button" variant="outline" onClick={() => dismiss(r.key)}>
                Understood
              </Button>
            </CardFooter>
          </Card>
        ) : (
          <Card role="alert" key={r.key} aria-label="A payment did not go through">
            <CardHeader>
              <CardTitle role="heading" aria-level={3}>
                A payment did not go through.
              </CardTitle>
              <CardDescription>
                {amount} to {to} — submitted {new Date(r.submittedAt).toLocaleString()}.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="error">{r.outcome.reason}</div>
            </CardContent>
            <CardFooter>
              <Button type="button" variant="outline" onClick={() => dismiss(r.key)}>
                Understood
              </Button>
            </CardFooter>
          </Card>
        );
      })}
    </>
  );
}
