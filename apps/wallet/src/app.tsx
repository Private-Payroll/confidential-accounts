import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useRoute } from './router.js';
import type { RouteName } from './routes.js';
import { useSession } from './session.js';
import type { Phase } from './session.js';
import { Shell } from './components/ui.js';
import type { PlaceChrome } from './components/ui.js';
import { AccountNoPasskey } from './screens/account-no-passkey.js';
import { OfferDevice, ReceiveDevice } from './screens/add-device.js';
import { Broken } from './screens/broken.js';
import { Explore } from './screens/explore.js';
import { Home } from './screens/home.js';
import { Kit } from './screens/kit.js';
import { NotBuilt } from './screens/notbuilt.js';
import { NotFound } from './screens/notfound.js';
import { PasskeyNoAccount } from './screens/passkey-no-account.js';
import { Approve } from './screens/approve.js';
import { ApproveEntry } from './screens/approve-entry.js';
import { ProfileScreen } from './screens/profile.js';
import { Recover } from './screens/recover.js';
import { Secure } from './screens/secure.js';
import { Send } from './screens/send.js';
import { Settings } from './screens/settings.js';
import { Unlock } from './screens/unlock.js';
import { Unsupported } from './screens/unsupported.js';
import { Welcome } from './screens/welcome.js';
import { forgetInbox, openInbox } from './accounts/inbox-live.js';
import { FRAMING } from './framing.js';
import { ORIGIN } from './config.js';

/**
 * **INSIDE ANOTHER PAGE, THE WALLET IS AN APPROVAL AND NOTHING ELSE.**
 *
 * Every other screen - settings, recovery, starting a fresh wallet - is a
 * control a page around this one could put under somebody's pointer. So a
 * framed wallet renders this instead, and it offers the one thing that is safe
 * from anywhere: opening the wallet in a tab of its own, where the address bar
 * is back.
 */
/** Nothing to make yet, locked, or open: the only phases an approval passes through. */
const FRAMED_PHASES: ReadonlySet<string> = new Set(['welcome', 'locked', 'unlocked']);

const FRAMED_ELSEWHERE =
  'only an approval opens inside another page. Everything else in your wallet opens in a tab of '
  + 'its own, where you can see its address.';

function FramedRefusal({ says }: { readonly says: string }): ReactNode {
  return (
    <>
      <h1 data-framed-refusal>Open your wallet on its own</h1>
      <p className="lede">{says.charAt(0).toUpperCase() + says.slice(1)}</p>
      <p><a href={`${ORIGIN}/`} target="_blank" rel="noopener noreferrer">Open your wallet in a new tab</a></p>
    </>
  );
}

/**
 * One decision, made in one place: which screen this browser's state and the
 * URL add up to. Screens render; they do not re-derive any of this.
 *
 * EVERY BRANCH IS PHASE-GUARDED (a measured finding) — so when securing puts a real
 * flow behind `secure`, that route already refuses to render without an
 * unlocked secret rather than acquiring the guard as a retrofit.
 */

/** The way in, for every phase that is not "in". Null only when unlocked. */
function entryFor(phase: Phase): ReactNode | null {
  switch (phase.name) {
    case 'welcome': return <Welcome />;
    case 'locked': return <Unlock />;
    case 'account-no-passkey':
      return <AccountNoPasskey recordDamaged={phase.recordDamaged} />;
    case 'passkey-no-account': return <PasskeyNoAccount />;
    case 'broken': return <Broken message={phase.message} />;
    default: return null;
  }
}

export function App(): ReactNode {
  const { phase, recovery, paired } = useSession();
  const route = useRoute();

  /*
   * §3 RETIRES THE REMOUNT TOKEN.
   *
   * The old shell keyed the place on a counter the chip bumped, because the home screen
   * read the open wallet once in a mount initialiser and replacing the screen
   * was the only way to make a switch true for it without touching that file.
   * `shell/wallets.ts` now carries the change event `storage.ts` cannot emit,
   * so the chip and the screen re-render off one notification and neither is
   * rebuilt. Nothing here needs to know that a switch happened at all.
   */
  const placeChrome = (name: RouteName): PlaceChrome | undefined => {
    if (phase.name !== 'unlocked') return undefined;
    return { identity: phase.identity, secret: phase.secret, route: name };
  };

  /*
   * THE INBOX RUNS FOR THE UNLOCKED PHASE AND FOR NOTHING ELSE.
   * The rule: *"Nothing polls when the wallet is shut."*
   *
   * **IT IS HERE AND NOT IN THE CARD**, because *"poll while the wallet is
   * open"* is about the wallet and not about which screen somebody is looking
   * at: a poller owned by `screens/home.tsx` would stop the moment a person
   * walked to Settings. `app.tsx` is the one place that holds an unlocked
   * identity across every route, so it is the one place whose lifetime is the
   * phase's lifetime.
   *
   * **THE DEPENDENCY IS THE IDENTITY, SO LOCKING TEARS IT DOWN.** `lock()` sets
   * a phase with no identity (`session.tsx:1052`), this effect's dependency
   * becomes `null`, React runs the cleanup, and `openInbox`'s teardown both
   * stops the poller and empties the store — a store that outlived the phase
   * would be a locked wallet's notices still readable by whatever renders next.
   *
   * **AND THE ARRANGEMENT IS NOT THE PROOF.** `profile/inbox-poll.ts` asks
   * `unlocked()` on every tick and stops itself when the answer is no, whatever
   * this file did or failed to do. The ref is read at the moment of the tick
   * rather than captured at mount, so a lock that happens between two ticks is
   * seen by the next one.
   */
  const phaseNow = useRef(phase);
  useEffect(() => { phaseNow.current = phase; }, [phase]);
  const unlockedIdentity = phase.name === 'unlocked' ? phase.identity : null;
  useEffect(() => {
    if (unlockedIdentity === null) {
      forgetInbox();
      return undefined;
    }
    return openInbox(unlockedIdentity, () => phaseNow.current.name === 'unlocked');
  }, [unlockedIdentity]);

  /* Keyboard and screen reader: navigating moves focus to the main
   * region, so the next Tab lands inside the new screen and a screen reader
   * announces from its heading — instead of focus staying on the link that
   * has just disappeared. The first render is not a navigation, and stealing
   * focus from the page load would be its own bug. */
  const navigated = useRef(false);
  useEffect(() => {
    if (!navigated.current) {
      navigated.current = true;
      return;
    }
    document.querySelector<HTMLElement>('main')?.focus();
  }, [route.name]);

  /*
   * THE GALLERY, AND IT ANSWERS BEFORE EVERY OTHER GATE.
   *
   * `#/kit` renders every component in every state. It reads no wallet, no
   * secret and no storage, so there is nothing for a phase guard to protect —
   * and it has to render in the phases where looking at the design system is
   * most likely: a browser with no passkey support, or one whose record is
   * damaged. A gallery that could only be seen from an unlocked wallet would
   * be unreachable on exactly the machines somebody opens it on.
   *
   * It is UNLINKED. Nothing in the navigation points here and nothing ever
   * should; it is reached by typing the hash.
   */
  /*
   * **ABOVE EVERY OTHER GATE, THE GALLERY INCLUDED.** A frame the wallet was
   * not built for shows nothing, and a frame it was built for shows the
   * approval route only - in the three phases an approval needs, and never a
   * phase whose screen offers to start again, re-enrol a passkey or repair the
   * wallet, each of which stays a thing done in the wallet's own tab.
   */
  if (FRAMING.of === 'refused') return <Shell bare><FramedRefusal says={FRAMING.why} /></Shell>;
  if (FRAMING.of === 'framed' && (route.name !== 'approve' || !FRAMED_PHASES.has(phase.name))) {
    return <Shell bare><FramedRefusal says={FRAMED_ELSEWHERE} /></Shell>;
  }

  if (route.name === 'kit') return <Shell widePage><Kit /></Shell>;

  if (phase.name === 'unsupported') return <Shell narrow><Unsupported /></Shell>;

  /* Broken owns the window — except the two routes that are exactly the
   * doors out of it: recovery, and (a decision, now taken) receiving the
   * wallet from another device. Both LAND an account rather than opening the
   * corpse that is here, and both stand their landing behind the three-way
   * The landing gate, which for a broken browser names the stored wallet honestly. */
  if (phase.name === 'broken' && route.name !== 'recover' && route.name !== 'add-device') {
    return <Shell narrow><Broken message={phase.message} /></Shell>;
  }

  switch (route.name) {
    case 'home': {
      if (phase.name === 'unlocked') {
        return (
          <Shell place={placeChrome('home')}>
            <Home
              identity={phase.identity}
              secret={phase.secret}
              /* §7.15's third state: an account that arrived by recovery and
               * has no record of its own must hear "this browser does not
               * know", never the standing notice's "the money is gone". */
              justRecovered={recovery?.state === 'completed'}
            />
          </Shell>
        );
      }
      return <Shell narrow>{entryFor(phase)}</Shell>;
    }
    /*
     * SETTINGS IS A SCREEN NOW, AND THE TWO THAT ARE NOT ARE UNCHANGED.
     *
     * It is phase-guarded exactly as every other route is, and it is guarded
     * for a stronger reason than its neighbours: it reads the secured record,
     * the passkey record and the creation and arrival stamps, all of which are
     * fingerprint-bound to an unlocked secret. A settings page rendered without
     * one would have nothing true to say and would say something anyway.
     */
    case 'settings': {
      if (phase.name === 'unlocked') {
        return (
          <Shell place={placeChrome('settings')}>
            <Settings secret={phase.secret} />
          </Shell>
        );
      }
      return <Shell narrow>{entryFor(phase)}</Shell>;
    }
    /*
     * THE ONE PLACE STILL TO COME. Phase-guarded like every other route, and
     * it renders `NotBuilt` — the honest empty state this project already has,
     * which names what will be here and does not pretend to be a screen.
     *
     * EXPLORE WAS THE OTHER ONE AND IS A SCREEN NOW, BELOW. Nothing about
     * Activity moves with it: the frame is the same, the guard is the same,
     * and the words on it are still `screens/notbuilt.tsx`'s.
     */
    case 'activity': {
      if (phase.name === 'unlocked') {
        return (
          <Shell place={placeChrome(route.name)}>
            <NotBuilt route={route.name} />
          </Shell>
        );
      }
      return <Shell narrow>{entryFor(phase)}</Shell>;
    }
    /*
     * EXPLORE IS A SCREEN. Six things this wallet will host, each a tile
     * carrying a `Coming soon` badge and nothing else (`screens/explore.tsx`).
     *
     * IT IS PHASE-GUARDED LIKE EVERY OTHER PLACE, and that is worth a sentence
     * because the screen itself reads NOTHING — no identity, no secret, no
     * storage, no network. It could render in any phase. It does not, because
     * a place in this wallet's navigation is a room inside an unlocked wallet,
     * and a route that answered outside the guard would be the one place a
     * person could land in without unlocking. The guard is the shape of the
     * app, not a protection this particular screen needs.
     */
    case 'explore': {
      if (phase.name === 'unlocked') {
        return (
          <Shell place={placeChrome(route.name)}>
            <Explore />
          </Shell>
        );
      }
      return <Shell narrow>{entryFor(phase)}</Shell>;
    }
    case 'not-found':
      return <Shell narrow><NotFound path={route.path} /></Shell>;
    case 'send': {
      /* Acts on an unlocked account and on nothing else — money-adjacent
       * screens acquire the phase guard on arrival, never as a retrofit.
       *
       * THE READING COLUMN, NOT THE NARROW ONE, AND THAT IS THE ONLY
       * FRAME CHANGE THIS CHANGE MAKES. `narrow` is 460px; `content` is the
       * 620px column every other built screen uses. The confirmation is the
       * densest thing in this wallet — a short address, a display-sized
       * amount, an exact fee and two before-and-after balances — and it was
       * being read in the narrowest column in the app. Nothing else about the
       * frame moves: this is still an ACTION, so it gets no rail and no bottom
       * bar (the design keeps the navigation at four PLACES),
       * and the ENTRY screens below stay `narrow`, because an unlock prompt is
       * what `narrow` is for.
       */
      if (phase.name === 'unlocked') {
        return (
          <Shell>
            <Send identity={phase.identity} secret={phase.secret} />
          </Shell>
        );
      }
      return <Shell narrow>{entryFor(phase)}</Shell>;
    }
    case 'secure': {
      /* Acts on an unlocked account and on nothing else.
       *
       * The flow now NAMES the account it is about — *"the secured
       * record names no account, so it outlives the account it describes"* —
       * is precisely this ceremony, and somebody cutting an account into
       * pieces must be able to see which one. Shown, not tappable: switching
       * mid-ceremony is an ordering fault. The screen itself is untouched. */
      if (phase.name === 'unlocked') {
        return (
          <Shell narrow flow={{ identity: phase.identity, secret: phase.secret }}>
            <Secure secret={phase.secret} />
          </Shell>
        );
      }
      return <Shell narrow>{entryFor(phase)}</Shell>;
    }
    /*
     * THE PERSON'S OWN DETAILS, AND THE SURFACE THAT APPROVES LETTING
     * SOME OF THEM OUT.
     *
     * Both are phase-guarded exactly as every other route is, and both need it
     * for the strongest reason on this list: `profile` opens ciphertext with a
     * key derived from an unlocked secret, and `approve` SIGNS with the money
     * key of a subwallet. Neither has anything true to say without an unlocked
     * account, and a screen with nothing true to say says something anyway.
     *
     * NEITHER IS FRAMED AS A PLACE. The design keeps the
     * navigation at four places; these are reached from Settings, the way the
     * address book is.
     *
     * `approve` FOLLOWS THE SEND SCREEN'S FRAME, deliberately. An open question
     * is carried forward about whether an action is *pushed over
     * a place, dismissible* or a route in this frame. **The shape of the
     * approval surface is not data and is not a round's to settle**, so this
     * copies the existing precedent and says so rather than inventing a third
     * answer.
     */
    case 'profile': {
      if (phase.name === 'unlocked') {
        return <Shell><ProfileScreen identity={phase.identity} /></Shell>;
      }
      return <Shell narrow>{entryFor(phase)}</Shell>;
    }
    case 'approve': {
      if (phase.name === 'unlocked') {
        return (
          <Shell bare={FRAMING.of === 'framed'}>
            <Approve identity={phase.identity} secret={phase.secret} />
          </Shell>
        );
      }
      /*
       * **THE ONE ROUTE WHERE AN ENTRY PHASE IS NOT THE WHOLE STORY.**
       *
       * Everywhere else on this list, arriving without an unlocked account
       * means somebody opened the wallet and has not got in yet, and
       * `entryFor` is the whole of what there is to say. **This route is
       * different: a page opened this window to ask a question, and that page
       * is still on screen behind it.** So the entry screens are wrapped
       * rather than replaced — the wrapper tells the asking page that a wallet
       * is listening, which nothing did before, and gives the one phase that
       * has no words of its own — nothing stored at all, which is every new
       * employee — the words for the state it is actually in.
       *
       * `entryFor(phase)` is still what decides which screen a phase means;
       * the wrapper renders it unchanged for every phase but that one.
       */
      return (
        <Shell narrow bare={FRAMING.of === 'framed'}>
          <ApproveEntry phase={phase} entry={entryFor(phase)} />
        </Shell>
      );
    }
    case 'advanced':
    /* Home's shortcut to the address book. A DESTINATION, not a drawer
     * (by design): the shortcut is real now and the panel is a later
     * change, so nothing built today has to be unbuilt to add it. Framed like
     * `advanced` rather than as a place — the design keeps the
     * navigation at four places on purpose, and the book is managed in
     * Settings. */
    case 'address-book': {
      /* Acts on an unlocked account and on nothing else. */
      if (phase.name === 'unlocked') return <Shell narrow><NotBuilt route={route.name} /></Shell>;
      return <Shell narrow>{entryFor(phase)}</Shell>;
    }
    case 'recover': {
      /* Reachable WITHOUT an account, by design — recovery rebuilds one on a
       * machine that never had it (§1) — and from `broken`, whose
       * screen points here.
       *
       * NOT reachable idly from `unlocked`. A wallet is open on this
       * machine, and gathering pieces here ends in a landing that replaces
       * it; a stale link or the Back button must not put a primary button in
       * front of that. A session already in the provider still renders —
       * its completed screen shows after a finish flips the phase to
       * unlocked, and §7.11's resumability is not forfeited by unlocking
       * mid-gather (the finish step's own gate stands in front of the
       * landing either way). */
      if (phase.name === 'unlocked' && recovery === null) {
        /* The home screen, so it is framed as the home place — the route is
         * the one that was refused, the screen is the one that rendered. */
        return (
          <Shell place={placeChrome('home')}>
            <Home identity={phase.identity} secret={phase.secret} />
          </Shell>
        );
      }
      return <Shell narrow><Recover /></Shell>;
    }
    case 'add-device': {
      /* One route, two roles, decided by what this browser holds. Unlocked,
       * this machine HAS the wallet and offers it (`OfferDevice`). In every
       * other phase it is the machine that wants one (`ReceiveDevice`) —
       * reachable without an account by design (§1), and over an
       * existing wallet only through the landing gate inside.
       *
       * `paired` wins over `unlocked`: a successful landing UNLOCKS this
       * browser mid-render, and without this the completion screen — the one
       * that states the ceremony's outcome as its own fact (by rule) —
       * was replaced by the offer role before anybody read it. Offering from
       * a freshly-paired browser again works after a reload, which a machine
       * that just joined has no same-session reason to need. */
      if (phase.name === 'unlocked' && !paired) {
        /* The offering side is about a specific account — it is the one
         * being handed to another device — so it carries the chip. The
         * RECEIVING side is not: that browser has no account yet, which is the
         * whole reason it is asking for one. */
        return (
          <Shell narrow flow={{ identity: phase.identity, secret: phase.secret }}>
            <OfferDevice secret={phase.secret} />
          </Shell>
        );
      }
      return <Shell narrow><ReceiveDevice /></Shell>;
    }
  }
}
