import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Badge, Button, FocusedLayout, PageLayout, Separator, SidebarInset, SidebarProvider, SidebarTrigger,
  Tooltip, TooltipContent, TooltipTrigger, useSidebar,
} from 'vaults-ui';
import { GLYPH, Glyph } from '../glyphs.js';
import type { Identity, Secret } from 'midnight-identity';
import { hrefOf } from '../routes.js';
import type { RouteName } from '../routes.js';
import { useSession } from '../session.js';
import { INDEXER_HOST, NETWORK, ORIGIN } from '../config.js';
import { AccountChip, FlowAccountChip } from '../shell/account.js';
import { BottomBar, Rail } from '../shell/nav.js';
import { useRail } from '../shell/rail.js';
import { ThemePicker, useTheme } from '../shell/theme.js';
import type { Theme, ThemeChoice } from '../shell/themes.js';

/** The small shared pieces every screen builds from. */

export function Moon({ large }: { readonly large?: boolean }): ReactNode {
  return <div className={large ? 'moon-large' : 'moon'} aria-hidden="true" />;
}

/**
 * A failure, shown verbatim. The library's error messages say what happened
 * and what to do — several are the result of an audit finding — so this
 * component renders them and never rewrites them (§3).
 */
export function ErrorNote({ message }: { readonly message: string | null }): ReactNode {
  if (!message) return null;
  return <div className="error" role="alert">{message}</div>;
}

/** A ceremony in flight, announced to screen readers as it changes. */
export function StatusNote({ message }: { readonly message: string | null }): ReactNode {
  return <div className="status" role="status" aria-live="polite">{message ?? ''}</div>;
}

/** Copy to the clipboard, and say so briefly. `copied` lets a caller put a
 * fact in the confirmation — the address card names WHOSE address was just
 * copied (§3 of the subwallets rules: the name travels with the address,
 * because the address is the one thing people copy without reading). */
export function CopyButton({ text, label, copied: copiedLabel, kit }: {
  readonly text: string;
  readonly label: string;
  readonly copied?: string;
  /** A screen built from the kit's parts passes this and gets the kit's
   * button; the screens still written as plain markup omit it and get the
   * plain button their own rules dress. */
  readonly kit?: boolean;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  /* The confirmation is ABOUT the value that was copied, so a new value
   * clears it — found writing the owner-line test: switching wallets inside the
   * confirmation's 1.6 seconds re-rendered "Copied — the address of X" with
   * the NEW wallet's owner over the OLD wallet's clipboard, which is the
   * wrong-wallet mistake wearing the surface built to catch it. */
  useEffect(() => {
    setCopied(false);
    if (timer.current) clearTimeout(timer.current);
  }, [text]);
  const onClick = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    });
  };
  const words = copied ? (copiedLabel ?? 'Copied') : label;
  if (kit === true) {
    return <Button type="button" variant="outline" size="sm" onClick={onClick}>{words}</Button>;
  }
  return (
    <button type="button" onClick={onClick}>
      {words}
    </button>
  );
}

/**
 * ASKING FOR THE WALLET'S NAME — one field, and every screen that is about to
 * create a passkey renders THIS one rather than its own.
 *
 * **THE TIMING IS THE WHOLE POINT.** A credential's label is fixed by what
 * `navigator.credentials.create` was given, and no web application — this one
 * included — can change it afterwards; only the browser or the password
 * manager can rename a saved passkey. So the question is asked BEFORE the
 * ceremony, on the screen that is about to run it, and the answer goes into
 * it. A field offered after the fact would be a different, weaker feature
 * wearing the same words.
 *
 * IT NAMES THE WHOLE WALLET, NOT AN ACCOUNT IN IT. The accounts inside — the
 * main wallet and the ten slots — are named from the wallet itself, and that
 * control is elsewhere and unchanged.
 *
 * OPTIONAL, AND SAID TO BE. Empty is a supported answer on every screen this
 * appears on: the wallet then behaves exactly as it did before names existed,
 * down to the strings its passkey carries.
 */
export function WalletNameField({ value, onChange, label, hint }: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly label: string;
  /** The sentence under the box. A default that fits the three CREATE paths;
   * a wallet coming back says something else, because it may already have had
   * a name somewhere else. */
  readonly hint?: ReactNode;
}): ReactNode {
  return (
    /* `textAlign` and the auto margins are for the three screens that render
     * this inside `.hero`, which is centred: a label and a box read as a form
     * or they read as decoration, and centred field text reads as neither.
     * Everywhere else the auto margins are inert. */
    <div
      className="wallet-name-field"
      style={{
        maxWidth: '22rem', marginTop: '1rem', marginInline: 'auto', textAlign: 'left',
      }}
    >
      <label className="small" htmlFor="whole-wallet-name">{label}</label>
      <input
        id="whole-wallet-name"
        type="text"
        maxLength={24}
        autoComplete="off"
        placeholder="e.g. “Rent money”, “Company”"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{ width: '100%' }}
      />
      <p className="faint small" style={{ marginTop: '0.4rem', marginBottom: 0 }}>
        {hint ?? (
          <>
            Optional. It goes on the passkey your browser saves, so a chooser listing
            several passkeys for this site says which wallet each one opens. It has to
            be set now: once a passkey exists, nothing here can rename it.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * THE HONESTY LINE. One copy of it, rendered by both frames below — a
 * sentence that says what is the case rather than the reassuring version
 * (§7.16), and it must not be able to differ between them.
 */
function Foot(): ReactNode {
  return (
    <footer className="border-t px-6 pt-4 pb-5 text-center text-xs text-muted-foreground">
      {/* §7.16: this sentence used to say "no server, no chain connection"
        * and that stopped being true the day balances arrived. Say what is
        * the case, not the reassuring version. */}
      Test build — keys and ceremonies run entirely in this browser; the passkey
      proves you to this browser only. Balances are read from {INDEXER_HOST},
      which learns this wallet&rsquo;s address — and only when you ask.
    </footer>
  );
}

/**
 * WHAT A PLACE NEEDS AROUND IT. Supplied by `app.tsx` for the four places and
 * for nothing else — a flow or a condition passes none, and gets the frame
 * this app has always had.
 */
export interface PlaceChrome {
  readonly identity: Identity;
  readonly secret: Secret;
  readonly route: RouteName;
}
/* `onSwitched` is GONE, with the remount it drove. An earlier shell needed it
 * because the home screen read `lastUsed` once, in a mount initialiser, so the
 * only way to make a switch from the chip true for the screen was to replace
 * the screen. Both now subscribe to the same record through
 * `shell/wallets.ts`, so a switch is a re-render of two subscribers rather
 * than the destruction and rebuild of a place — which also means switching
 * wallets no longer discards a place's own scroll position and state. */

/**
 * WHAT A FLOW NEEDS AROUND IT, and it is exactly one thing.
 *
 * A flow still gets NO navigation: no rail, no bar, no way to wander out of a
 * ceremony half-done. What it now gets is the ACCOUNT CHIP,
 * shown and not tappable — the design correcting an earlier reading of the
 * design's "flows get no navigation" as "flows get no chip".
 *
 * **The chip is identity, not navigation.** Trouble is what happens when a
 * ceremony does not name the account it is about, and somebody securing an
 * account has to be able to see which one while they secure it.
 */
export interface FlowChrome {
  readonly identity: Identity;
  readonly secret: Secret;
}

/**
 * THE FRAME. Two of them, and which one you get is decided by the KIND of
 * screen inside — the four kinds, of which only one
 * gets navigation.
 *
 * A PLACE is a scroll container with chrome around it, AND THAT IS ALL THIS
 * KNOWS ABOUT IT. Not that it is a list, not that it is a grid, not that it
 * scrolls at all. Home's contents are undecided on purpose and a frame that
 * assumed their shape would decide them here, in the wrong round.
 *
 * A FLOW OR A CONDITION gets no rail and no bar: a ceremony you can navigate
 * away from mid-way is an ordering accident, and a dead end that
 * offers a way onward is not a dead end. A flow that names an account passes
 * `flow` and gets the static chip; a condition passes nothing and its markup
 * is byte-for-byte what it was before.
 */
export function Shell({ children, narrow, widePage, place, flow, bare }: {
  readonly children: ReactNode;
  /** A column for one task: the entry screens and the ceremonies. */
  readonly narrow?: boolean;
  /** Carried by `app.tsx` for `#/kit` alone, which lays out wide specimens. */
  readonly bare?: boolean;
  readonly widePage?: boolean;
  readonly place?: PlaceChrome;
  readonly flow?: FlowChrome;
}): ReactNode {
  const { phase, lock } = useSession();
  const { theme, choice, setChoice } = useTheme();

  /* How wide the column is. The page around it is the kit's; the column keeps
   * a screen of reading or of one task from running the width of a monitor. */
  const column = narrow === true
    ? 'mx-auto w-full max-w-md'
    : (widePage === true ? 'mx-auto w-full' : 'mx-auto w-full max-w-2xl');

  /*
   * FRAMED: the wallet inside the page that asked, where it draws no frame of
   * its own and says whose wallet this is, served from where.
   */
  if (bare === true) {
    return (
      <div className="min-h-svh bg-background text-foreground" data-framed>
        <main className="px-4 py-4 outline-none" tabIndex={-1} data-page-body>
          <div className={`${column} flex flex-col gap-4`}>
            <p className="m-0 text-xs text-muted-foreground" data-framed-origin>
              Your wallet, served from <span className="font-mono">{ORIGIN}</span>
            </p>
            {children}
          </div>
        </main>
      </div>
    );
  }

  /* A FLOW OR A CONDITION: the kit's focused layout - no menu, the wallet's
   * name and network where a title goes, and the chip and Lock where a way
   * out goes. */
  if (!place) {
    return (
      <FocusedLayout
        title={(
          <span className="flex items-center gap-3">
            <a className="wordmark" href={hrefOf('home')}>
              <Moon />
              Midnight Identity
            </a>
            <Badge variant="outline" className="font-mono font-normal text-muted-foreground">{NETWORK}</Badge>
          </span>
        )}
        exit={(
          <span className="flex items-center gap-2">
            {/* Identity, not navigation. Rendered only where an account
                exists to name - never on welcome, unlock or recover. */}
            {flow !== undefined && (
              <FlowAccountChip identity={flow.identity} secret={flow.secret} />
            )}
            {phase.name === 'unlocked' && (
              <Button type="button" variant="outline" onClick={lock}>Lock</Button>
            )}
          </span>
        )}
      >
        {/* Focusable so navigation can move the keyboard and the screen reader
            to the new screen, which is what a page load would have done. */}
        <div className={`${column} outline-none`} tabIndex={-1} data-page-body>{children}</div>
        <Foot />
      </FocusedLayout>
    );
  }

  return (
    <PlaceFrame
      place={place}
      theme={theme}
      choice={choice}
      onTheme={setChoice}
      onLock={phase.name === 'unlocked' ? lock : null}
      column={column}
    >
      {children}
    </PlaceFrame>
  );
}

/**
 * A PLACE: the kit's sidebar in its inset layout, the place's header, the
 * page, and the phone's bar.
 *
 * THE SIDEBAR REMEMBERS WHETHER IT WAS FOLDED. The kit's sidebar is told its
 * state rather than keeping one, so the wallet's remembered choice is the only
 * copy, and Cmd/Ctrl+B folds and unfolds it as it always has.
 */
function PlaceFrame({ place, theme, choice, onTheme, onLock, column, children }: {
  readonly place: PlaceChrome;
  readonly theme: Theme;
  readonly choice: ThemeChoice;
  readonly onTheme: (next: ThemeChoice) => void;
  readonly onLock: (() => void) | null;
  readonly column: string;
  readonly children: ReactNode;
}): ReactNode {
  const rail = useRail();
  const { collapsed, toggle } = rail;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'b' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
  return (
    <SidebarProvider
      /* The sidebar, and the space it holds beside the page, never reach a printed sheet. */
      className="print:**:data-[slot=sidebar]:hidden"
      open={!collapsed}
      onOpenChange={(open) => { if (open === collapsed) toggle(); }}
    >
      <Rail
        current={place.route}
        identity={place.identity}
        secret={place.secret}
        theme={theme}
        choice={choice}
        onTheme={onTheme}
        onLock={onLock}
      />
      <SidebarInset className="min-w-0 outline-none" tabIndex={-1} data-page-body>
        <PlaceHead
          place={place}
          theme={theme}
          choice={choice}
          onTheme={onTheme}
          onLock={onLock}
        />
        <div className="flex-1">
          <PageLayout>
            <div className={column}>{children}</div>
          </PageLayout>
        </div>
        <Foot />
        <BottomBar current={place.route} />
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * The control that folds the sidebar, saying which way it will go. It keeps
 * the kit's own `sidebar-trigger` mark: the tooltip around it would otherwise
 * put its own in that place.
 */
function FoldControl(): ReactNode {
  const { open } = useSidebar();
  const label = open ? 'Hide the sidebar' : 'Show the sidebar';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <SidebarTrigger
          type="button"
          data-slot="sidebar-trigger"
          aria-label={label}
          aria-expanded={open}
          className="hidden md:inline-flex"
        />
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The place's header. On a desktop it carries the fold control, the network
 * and My profile; on a phone, where there is no sidebar, it also carries the
 * account chip, the theme and Lock.
 */
function PlaceHead({ place, theme, choice, onTheme, onLock }: {
  readonly place: PlaceChrome;
  readonly theme: Theme;
  readonly choice: ThemeChoice;
  readonly onTheme: (next: ThemeChoice) => void;
  readonly onLock: (() => void) | null;
}): ReactNode {
  return (
    <header
      className={[
        'sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 rounded-t-xl border-b',
        'bg-background/95 px-3 backdrop-blur-sm',
        'print:hidden',
      ].join(' ')}
    >
      <FoldControl />
      <Separator orientation="vertical" className="me-1 hidden data-vertical:h-4 data-vertical:self-center md:block" />
      <span className="flex min-w-0 flex-1 md:hidden">
        <AccountChip identity={place.identity} secret={place.secret} variant="bar" />
      </span>
      <span className="hidden flex-1 md:block" />
      <Badge variant="outline" className="shrink-0 font-mono font-normal text-muted-foreground">{NETWORK}</Badge>
      <Button asChild variant="ghost" size="icon" className="text-muted-foreground">
        <a href={hrefOf('profile')} aria-label="My profile" title="My profile">
          <Glyph icon={GLYPH.details} />
        </a>
      </Button>
      <div className="flex shrink-0 items-center gap-1 md:hidden">
        <ThemePicker choice={choice} theme={theme} onChoose={onTheme} />
        {onLock !== null && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onLock}
            aria-label="Lock the wallet"
            title="Lock the wallet"
            className="text-muted-foreground"
          >
            <Glyph icon={GLYPH.lock} />
          </Button>
        )}
      </div>
    </header>
  );
}
