import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { GLYPH, Icon } from '../kit/icon.js';
import type { Identity, Secret } from 'midnight-identity';
import { hrefOf } from '../routes.js';
import type { RouteName } from '../routes.js';
import { useSession } from '../session.js';
import { INDEXER_HOST, NETWORK } from '../config.js';
import { AccountChip, FlowAccountChip } from '../shell/account.js';
import { BottomBar, Rail } from '../shell/nav.js';
import { SidebarProvider, SidebarTrigger } from '../kit/sidebar.js';
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
export function CopyButton({ text, label, copied: copiedLabel, className }: {
  readonly text: string;
  readonly label: string;
  readonly copied?: string;
  /** ADDITIVE, and omitting it renders exactly what it rendered before:
   * React emits no `class` attribute for `undefined`, so every existing caller
   * is byte-identical and `app.css`'s `button` rule still dresses them. It
   * exists because `screens/send.tsx` is on the kit now and a legacy button in
   * the middle of it would be the restyle half-done; the classes it passes come
   * from `kit/button.tsx`'s own `buttonClasses`, never assembled at the call
   * site. */
  readonly className?: string;
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
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1600);
        });
      }}
    >
      {copied ? (copiedLabel ?? 'Copied') : label}
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
    <footer className="foot">
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
export function Shell({ children, narrow, widePage, place, flow }: {
  readonly children: ReactNode;
  readonly narrow?: boolean;
  /** The gallery at `#/kit` and nothing else — a workshop surface, wider than
   * the reading column any real screen gets. */
  readonly widePage?: boolean;
  readonly place?: PlaceChrome;
  readonly flow?: FlowChrome;
}): ReactNode {
  const { phase, lock } = useSession();
  const { theme, choice, setChoice } = useTheme();

  const mainClass = narrow === true
    ? 'content narrow'
    : (widePage === true ? 'content wide-page' : 'content');

  if (!place) {
    return (
      <div className="shell">
        <header className="topbar">
          <a className="wordmark" href={hrefOf('home')}>
            <Moon />
            Midnight Identity
          </a>
          <span className="chip">{NETWORK}</span>
          <span className="spacer" />
          {/* Identity, not navigation. Rendered only where an account
            * exists to name, which is why a welcome or an unlock screen still
            * shows nothing here — there is no account yet to be about. */}
          {flow !== undefined && (
            <FlowAccountChip identity={flow.identity} secret={flow.secret} />
          )}
          {phase.name === 'unlocked' && (
            <button type="button" className="quiet" onClick={lock}>Lock</button>
          )}
        </header>
        {/* Focusable so navigation can move the keyboard and the screen reader
          * to the new screen's start — the App drives it. */}
        <main className={mainClass} tabIndex={-1}>{children}</main>
        <Foot />
      </div>
    );
  }

  /* The provider is mounted for a PLACE and for nothing else, which is
   * what keeps the ordering rules true of the SHORTCUT as well as of the chrome:
   * Cmd/Ctrl+B is registered by `SidebarProvider`, so inside a ceremony there
   * is no sidebar, no trigger, and no key that would summon one. */
  return (
    <SidebarProvider>
      <Rail
        current={place.route}
        identity={place.identity}
        secret={place.secret}
        theme={theme}
        choice={choice}
        onTheme={setChoice}
        onLock={phase.name === 'unlocked' ? lock : null}
      />
      <div className="flex min-h-svh min-w-0 flex-1 flex-col">
        <PlaceHead
          place={place}
          theme={theme}
          choice={choice}
          onTheme={setChoice}
          onLock={lock}
        />
        {/* The same single `main`, focused on navigation, that the app has
          * always had — there is exactly one on the page in either frame. */}
        <main className={mainClass} tabIndex={-1}>{children}</main>
        <Foot />
        <BottomBar current={place.route} />
      </div>
    </SidebarProvider>
  );
}

/**
 * The top of a place.
 *
 * THE FOLD CONTROL IS THE FIRST THING IN IT, AND THAT IS THE CHANGE. The kit put it
 * at the bottom of the column it collapses and it could not be found. It is now
 * top-left of the window — where `sidebar-07` puts it, where every application
 * that has one puts it, and where it is the first stop in the header's tab
 * order. `wide:` only: below the breakpoint there is no sidebar to fold.
 *
 * Then WHICH WALLET on a phone — on a desktop the switcher is in the sidebar's
 * footer — then the network, then, again only where there is no sidebar to
 * hold them, the theme and the lock.
 */
function PlaceHead({ place, theme, choice, onTheme, onLock }: {
  readonly place: PlaceChrome;
  readonly theme: Theme;
  readonly choice: ThemeChoice;
  readonly onTheme: (next: ThemeChoice) => void;
  readonly onLock: () => void;
}): ReactNode {
  return (
    <header
      className={[
        'sticky top-0 z-20 flex items-center gap-1.5 border-b border-line',
        'bg-bg/95 px-2 py-2 backdrop-blur-sm wide:px-3',
        'print:hidden',
      ].join(' ')}
    >
      <SidebarTrigger className="hidden wide:flex" />
      {/* The chip is the phone's; the sidebar's footer carries it on a desktop.
        * Rendering both and letting CSS decide is the same split the two
        * navigations have always used. */}
      <span className="flex min-w-0 flex-1 wide:hidden">
        <AccountChip identity={place.identity} secret={place.secret} variant="bar" />
      </span>
      <span className="hidden flex-1 wide:block" />
      <span className="chip shrink-0">{NETWORK}</span>
      {/*
        * MY PROFILE — THE SAME CONTROL THE LOCK IS, BUILT THE SAME WAY: one
        * 44px icon target, `title` and `aria-label` carrying the words,
        * `GLYPH.details`, and the identical class list. It is the same mark
        * Home's tile for this destination wears, and it is NOT `contacts` —
        * `kit/icon.tsx` carries why. It is an `<a>` rather than a `<button>`
        * because it
        * NAVIGATES — the kit's rule, and the reason is that a button setting
        * the hash cannot be opened in a new tab and is not in a screen
        * reader's link list.
        *
        * **IT IS NOT INSIDE THE `wide:hidden` GROUP BESIDE IT, AND THAT IS THE
        * ONE DEVIATION HERE.** The theme and lock controls hide at `wide:`
        * because the sidebar carries both; the sidebar carries NOTHING for
        * this destination — it is not a place and is not in the navigation —
        * so hiding it there would remove the control at exactly the width the
        * design asked for one. Same construction, different reason to hide.
        */}
      <a
        href={hrefOf('profile')}
        aria-label="My profile"
        title="My profile"
        className={[
          'flex size-touch items-center justify-center rounded-tight border border-transparent',
          'bg-transparent p-0 text-muted',
          'transition-colors duration-(--motion-quick) hover:border-line hover:text-ink',
        ].join(' ')}
      >
        <Icon glyph={GLYPH.details} />
      </a>
      <div className="flex shrink-0 items-center gap-1 wide:hidden">
        <ThemePicker choice={choice} theme={theme} onChoose={onTheme} />
        <button
          type="button"
          onClick={onLock}
          aria-label="Lock the wallet"
          title="Lock the wallet"
          className={[
            'flex size-touch items-center justify-center rounded-tight border border-transparent',
            'bg-transparent p-0 text-muted',
            'transition-colors duration-(--motion-quick) hover:border-line hover:text-ink',
          ].join(' ')}
        >
          <Icon glyph={GLYPH.lock} />
        </button>
      </div>
    </header>
  );
}
