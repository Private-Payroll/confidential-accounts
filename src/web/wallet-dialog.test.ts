import { afterEach, describe, expect, it } from 'vitest';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { identityFromWords } from 'midnight-identity';
import { READY_PING } from 'midnight-identity/profile/channel';
import { parseAsk } from 'midnight-identity/profile/request';
import type { KeyringRequest } from 'midnight-identity/profile/request';
import { keyringReleaseFor } from 'midnight-identity/profile/unlock';
import {
  WALLET_DIALOG_NAME, WALLET_DIALOG_SIZE, WalletClosed, askWallet, openWalletDialog,
} from './wallet-sign-in.js';
import type { Openable, WalletWindow } from './wallet-sign-in.js';

/**
 * **THE WALLET OPENS AS A DIALOG, AND IT OPENS AT ALL.**
 * `docs/how-money-can-be-lost.md` `C154`, `docs/NEXT.md` X9 §1.
 *
 * ── THE ONE FACT THIS FILE EXISTS FOR ─────────────────────────────────────
 *
 * **A BROWSER ONLY LETS A PAGE OPEN A WINDOW WHILE IT IS STILL HANDLING A
 * PERSON'S CLICK.** Both wallet paths used to spend that permission on a round
 * trip to this product's own server and then reach `view.open()` with it gone.
 * Chromium forgives a few seconds of that, which is why every walk so far
 * worked; **Safari and Firefox do not**, so signing in with a wallet failed
 * outright in browsers this had never been opened in, and a slow answer broke
 * it everywhere.
 *
 * So the assertion is about ORDER, and it is made the only way an order can be
 * checked without a browser: **the call is started and not awaited**, and the
 * window is required to be open before the first `fetch` has been allowed to
 * answer. A test that awaited the whole journey would pass whichever order the
 * two lines are in, which is exactly how this shipped.
 * Two deliberate defects put the old order back, and this is what notices.
 *
 * ── AND WHY THE REST OF IT IS HERE RATHER THAN IN A SCREENSHOT ────────────
 *
 * A dialog is not a tab, and the difference is a string of window features
 * nothing renders. `view.open(url, '_blank')` passed none at all, so the only
 * thing about that window that was ever a popup was the error message when it
 * did not appear. These check the features, the name that makes a second ask
 * reuse the window rather than stack one, and the closing.
 */

const WALLET = 'https://wallet.example';
const US = 'https://payroll.example';
/** The address the stub server says a sign-in was for, in a shape the wallet's parser accepts. */
const SIGNED_IN = 'mn_addr_test1qqqqqqqqqqqqqqqqqqqq';
const identity = identityFromWords(TEST_MNEMONIC);

/** A wallet that holds the signed-in address and gives the keyring key for it. */
const givesTheKeys = (ask: unknown): unknown => {
  const parsed = parseAsk(ask, US, Date.now());
  if (parsed.kind !== 'keyring') return { schema: 'a-sign-in' };
  return keyringReleaseFor(identity, parsed as KeyringRequest, Date.now(), (a) => a === SIGNED_IN);
};

interface Opened { url: string; target: string; features: string }

/**
 * A window that records what was opened, and can be driven through the
 * conversation by hand. It is deliberately NOT a wallet: nothing here answers
 * unless a test says so, because half these assertions are about the moment
 * before anything has answered.
 */
class ARecordingView implements Openable {
  readonly opened: Opened[] = [];
  readonly posted: { message: unknown; target: string }[] = [];
  focused = 0;
  closed = 0;
  /** A wallet at the other end, when a test wants the journey to finish. */
  answers: ((ask: unknown) => unknown) | null = null;
  private handler: ((e: MessageEvent) => void) | null = null;
  private readonly timers = new Map<number, () => void>();
  private nextTimer = 1;

  constructor(private readonly happened: string[] = []) {}

  /** Where this page's own window sits, so the centring can be checked. */
  readonly screenX = 100;
  readonly screenY = 50;
  readonly outerWidth = 1200;
  readonly outerHeight = 900;

  /** The same window handed back for the same name, as a browser does. */
  private readonly windows = new Map<string, WalletWindow>();
  /**
   * The most recent window, which is what a message from the wallet comes
   * from. It is deliberately NOT looked up by the dialog's name: a mutation
   * that takes the name away would then route nothing, every journey would
   * hang on its own timeout, and the run that was meant to prove the name
   * matters would prove it by taking four minutes to say so.
   */
  private last: WalletWindow | null = null;

  /**
   * Every window this view has ever made, closed or not. A dialog that closes
   * the handle it is holding while a DIFFERENT window of its own is still on
   * screen is a wallet nobody can put away, and that is only visible against
   * the whole set rather than against one handle.
   */
  readonly made: WalletWindow[] = [];

  /**
   * **THE BROWSER SAYS NO TO THE NEXT ONE.** A page may only open a window
   * while it is handling a press, so a window wanted after the press is over
   * is a window a browser may refuse — `ABlockedView` below models that for
   * the FIRST open and nothing could model it for a later one.
   */
  refuseTheNextOpen = false;

  /**
   * **WHAT THE PERSON DID WHILE THE PAGE WAS OPENING A WINDOW.** Reading
   * `closed` and then opening are two steps and a person is not obliged to
   * wait between them; this is the only way to put a test inside that gap.
   */
  duringTheNextOpen: (() => void) | null = null;

  open(url: string, target: string, features?: string): WalletWindow | null {
    const during = this.duringTheNextOpen;
    this.duringTheNextOpen = null;
    if (during) during();
    if (this.refuseTheNextOpen) {
      this.refuseTheNextOpen = false;
      this.opened.push({ url, target, features: features ?? '' });
      this.happened.push(`open ${target} REFUSED`);
      return null;
    }
    this.opened.push({ url, target, features: features ?? '' });
    this.happened.push(`open ${target}`);
    /*
     * **A NAME REACHES A WINDOW THAT IS STILL THERE, AND A CLOSED ONE IS NOT
     * THERE.** A browser hands back the window already on screen for a name it
     * recognises — and once that window has been closed the name reaches
     * nothing, so opening again makes a NEW one. Modelling only the first half
     * is what let a journey that talks to a closed window read as a journey
     * that talks to a window.
     */
    const existing = this.windows.get(target);
    if (existing && existing.closed !== true) return existing;

    let gone = false;
    const made: WalletWindow = {
      postMessage: (message: unknown, t: string) => {
        /*
         * **A CLOSED WINDOW SWALLOWS IT.** `window.postMessage` on a window
         * that has been closed is not an error and is not delivered: there is
         * no document at the other end to receive it. Nothing is recorded here
         * for the same reason — a message that reached nobody is not a message
         * this page sent to a wallet.
         */
        if (gone) return;
        this.posted.push({ message, target: t });
        if (this.answers) {
          const said = this.answers(message);
          queueMicrotask(() => this.fromTheWallet(said, WALLET, made));
        }
      },
      focus: () => { this.focused += 1; },
      /*
       * **CLOSING IS A STATE AND NOT A TALLY.** This counted and returned, so
       * every window in this file went on answering after it had been put away
       * and no test in it could express the one thing that breaks the invitee's
       * journey. The count is kept because the assertions about *how many
       * times* a dialog is closed are about a real property; what is added is
       * that the window is afterwards GONE.
       */
      close: () => { gone = true; this.closed += 1; },
      get closed(): boolean { return gone; },
    };
    this.windows.set(target, made);
    this.made.push(made);
    this.last = made;
    return made;
  }

  /** Windows this view made that are still on somebody's screen. */
  stillOpen(): WalletWindow[] { return this.made.filter(w => w.closed !== true); }

  addEventListener(_t: 'message', h: (e: MessageEvent) => void): void {
    this.handler = h;
    if (this.answers) queueMicrotask(() => this.fromTheWallet({ schema: READY_PING }));
  }
  removeEventListener(): void { this.handler = null; }
  setTimeout(handler: () => void): number {
    const id = this.nextTimer++;
    this.timers.set(id, handler);
    return id;
  }
  clearTimeout(id: number): void { this.timers.delete(id); }

  /**
   * **THE DEADLINE, RUN RATHER THAN WAITED FOR.** `setTimeout` above records
   * and never fires, so a silence this page gives up on after twenty seconds
   * could not be reached from a test at all — and a silence is exactly what a
   * closed window produces. This runs whatever is pending, once, so the
   * refusal a person would read is a value a test can hold.
   */
  fireTimers(): void {
    const due = [...this.timers.entries()];
    this.timers.clear();
    for (const [, run] of due) run();
  }

  /** Is anything still waiting on a deadline? */
  get waiting(): number { return this.timers.size; }

  /**
   * A message from the wallet's window, at the wallet's origin.
   *
   * **FROM A NAMED WINDOW, BECAUSE `event.source` IS WHAT THE PAGE CHECKS.**
   * It defaulted to whichever window was opened last, which is right while
   * there is one; a journey that opens a second window needs to be able to say
   * which of them spoke, and a CLOSED window must not be able to speak at all.
   */
  fromTheWallet(data: unknown, origin = WALLET, from: WalletWindow | null = this.last): void {
    if (from !== null && from.closed === true) return;
    this.handler?.({ origin, source: from, data } as unknown as MessageEvent);
  }
}

/** A view whose browser refuses to open anything. */
class ABlockedView extends ARecordingView {
  override open(url: string, target: string, features?: string): WalletWindow | null {
    super.open(url, target, features);
    return null;
  }
}

const featureOf = (features: string, key: string): number =>
  Number(new Map(features.split(',').map(p => p.split('=') as [string, string])).get(key));

/* ------------------------------------------------------------------------ */

describe('§1 — THE WINDOW IS OPENED IN THE CLICK, BEFORE ANYTHING IS AWAITED', () => {
  /**
   * **THE ORDER, WRITTEN DOWN AS IT HAPPENS.** Both the opening and the first
   * `fetch` happen synchronously inside the call, one after the other, so which
   * came first is not a matter of timing — it is the order of two lines, and
   * this list is that order.
   */
  const realFetch = globalThis.fetch;
  const realWindow = (globalThis as { window?: unknown }).window;

  const aServer = (happened: string[], hold?: string) => {
    let release: (() => void) | null = null;
    const held = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      happened.push(`fetch ${String(init?.method ?? 'GET')} ${String(url)}`);
      if (hold && String(url).includes(hold)) await held;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          nonce: 'n1', handle: 'h1', expiresAt: new Date(Date.now() + 600_000).toISOString(),
          session: { token: 'tok' }, address: SIGNED_IN, created: true,
          user: { id: 'usr_1', email: null, name: '' },
          company: 'a1'.repeat(32),
        }),
      } as Response;
    }) as typeof fetch;
    return { fetchImpl, letItAnswer: () => release?.() };
  };

  afterEach(async () => {
    globalThis.fetch = realFetch;
    (globalThis as { window?: unknown }).window = realWindow;
    const keyring = await import('./keyring.js');
    keyring.forgetLocally();
  });

  it('WATCHED FAILING: SIGNING IN OPENS THE WALLET BEFORE THE CHALLENGE IS ASKED FOR',
    async () => {
      const happened: string[] = [];
      const view = new ARecordingView(happened);
      view.answers = () => ({ schema: 'a-sign-in' });
      const server = aServer(happened, '/challenge');
      (globalThis as { window?: unknown }).window =
        Object.assign(view, { location: { origin: US } });
      globalThis.fetch = server.fetchImpl;

      const keyring = await import('./keyring.js');
      /*
       * NOT AWAITED, AND THAT IS THE TEST. Everything before the first `await`
       * inside `signInWithWallet` has run by the time this line returns. That
       * is precisely what a browser means by *while the click is still being
       * handled*, and it is the only place a window may be opened.
       */
      const journey = keyring.signInWithWallet(WALLET, undefined, view);

      expect(happened[0]).toBe(`open ${WALLET_DIALOG_NAME}`);
      expect(happened[1]).toBe('fetch POST /api/auth/wallet/challenge');
      expect(view.opened).toHaveLength(1);
      expect(view.opened[0]!.url.startsWith(`${WALLET}/`)).toBe(true);
      expect(view.opened[0]!.url).toContain('#/approve');
      /* The window is open and the server has still not said one word. */
      expect(view.posted).toHaveLength(0);

      server.letItAnswer();
      await journey;
    });

  it('WATCHED FAILING: A COMPANY\'S KEY OPENS THE WALLET BEFORE IT ASKS WHICH COMPANY',
    async () => {
      const happened: string[] = [];
      const view = new ARecordingView(happened);
      view.answers = () => ({ schema: 'a-sign-in' });
      const server = aServer(happened);
      (globalThis as { window?: unknown }).window =
        Object.assign(view, { location: { origin: US } });
      globalThis.fetch = server.fetchImpl;

      const keyring = await import('./keyring.js');
      await keyring.signInWithWallet(WALLET, undefined, view);
      view.answers = givesTheKeys;
      await keyring.openKeysWithWallet(WALLET, view, US);
      expect(keyring.canOpenCompanies()).toBe(true);

      happened.length = 0;
      /* Nothing answers this one: what is being watched is the first two
       * things it does, and both have happened by the time it returns. */
      view.answers = null;
      const asking = keyring.payslipKeyAndPayeeAddress('acc_1', WALLET, view, US);
      asking.catch(() => { /* it never finishes; the order is the subject */ });

      expect(happened[0]).toBe(`open ${WALLET_DIALOG_NAME}`);
      expect(happened[1]).toBe('fetch POST /api/accounts/acc_1/unlock');
    });
});

describe('§1 — IT IS A DIALOG RATHER THAN A TAB', () => {
  it('WATCHED FAILING: it is opened with a size and centred on the page that opened it',
    () => {
      const view = new ARecordingView();
      openWalletDialog(view, WALLET);

      const { features } = view.opened[0]!;
      /* `popup` is the only thing that makes it a window rather than a tab. */
      expect(features).toContain('popup=1');
      expect(featureOf(features, 'width')).toBe(WALLET_DIALOG_SIZE.width);
      expect(featureOf(features, 'height')).toBe(WALLET_DIALOG_SIZE.height);
      /* Centred across the opener: 100 + (1200 - 460) / 2. */
      expect(featureOf(features, 'left')).toBe(470);
      /* A third of the way down it: 50 + (900 - 760) / 3. */
      expect(featureOf(features, 'top')).toBe(97);
    });

  it('AND `noopener` IS NOT AMONG THEM, because it would break both sides', () => {
    /*
     * It would withhold the handle this side answers through AND
     * `window.opener` on the wallet's side, which is the only thing the
     * wallet's channel accepts a message from. A feature list is read by name,
     * so `noopener=0` is not a safe way of saying no: it is absent.
     */
    const view = new ARecordingView();
    openWalletDialog(view, WALLET);
    expect(view.opened[0]!.features).not.toContain('noopener');
    expect(view.opened[0]!.features).not.toContain('noreferrer');
  });

  it('WATCHED FAILING: A SECOND ASK REUSES THE WINDOW AND BRINGS IT FORWARD', () => {
    const view = new ARecordingView();
    const first = openWalletDialog(view, WALLET);
    const second = openWalletDialog(view, WALLET);

    /* One name, so the browser hands back the window already on screen. */
    expect(view.opened.map(o => o.target)).toEqual([WALLET_DIALOG_NAME, WALLET_DIALOG_NAME]);
    expect(second.wallet).toBe(first.wallet);
    /* Brought forward both times — a wallet behind the page that asked looks
     * exactly like a page that did nothing. */
    expect(view.focused).toBe(2);
    /*
     * AND RE-NAVIGATED. The wallet's channel answers one request per load and
     * ignores a second, so a window merely focused would receive the second
     * ask at a page that has already settled and nothing would come back. A
     * hash is not a navigation, so the URL carries a number that goes up.
     */
    expect(view.opened[0]!.url).not.toBe(view.opened[1]!.url);
  });

  it('WATCHED FAILING: THE DIALOG IS CLOSED WHEN THE ANSWER ARRIVES', async () => {
    const view = new ARecordingView();
    const answer = askWallet(view, WALLET, { schema: 'an-ask' });
    view.fromTheWallet({ schema: READY_PING });
    expect(view.posted).toHaveLength(1);
    view.fromTheWallet({ schema: 'the-answer' });

    await expect(answer).resolves.toMatchObject({ schema: 'the-answer' });
    expect(view.closed).toBe(1);
  });

  it('and when the person refuses it in their wallet', async () => {
    const view = new ARecordingView();
    const answer = askWallet(view, WALLET, { schema: 'an-ask' });
    view.fromTheWallet({ schema: READY_PING });
    view.fromTheWallet(
      { schema: 'midnight-identity/disclosure-refused/v1', reason: 'declined' });

    await expect(answer).rejects.toBeInstanceOf(WalletClosed);
    expect(view.closed).toBe(1);
  });
});

describe('§1 — THE PERSON CAN STOP WAITING, AND THE REFUSAL IS NOT BLAME', () => {
  it('WATCHED FAILING: GIVING UP CLOSES THE DIALOG AND REFUSES WHAT IS IN FLIGHT',
    async () => {
      const view = new ARecordingView();
      const dialog = openWalletDialog(view, WALLET);
      const answer = askWallet(view, WALLET, { schema: 'an-ask' }, dialog);

      dialog.giveUp();

      const refusal = await answer.then(() => null, (e: unknown) => e as WalletClosed);
      expect(refusal).toBeInstanceOf(WalletClosed);
      expect(refusal!.refusal.of).toBe('gave-up');
      expect(refusal!.message).toContain('Nothing was signed');
      expect(view.closed).toBe(1);
      /* Twice is not two closes and not two refusals. */
      dialog.giveUp();
      expect(view.closed).toBe(1);
    });

  it('WATCHED FAILING: A WINDOW THAT DID NOT OPEN DOES NOT BLAME THE PERSON’S BROWSER',
    async () => {
      /*
       * `C154`'s second half. It read *"your browser stopped this page opening
       * your wallet. Allow pop-ups for this site"* — advice for a problem the
       * person does not have, because the usual reason is that the page spent
       * the permission before it used it.
       */
      const view = new ABlockedView();
      const refusal = await askWallet(view, WALLET, { schema: 'an-ask' })
        .then(() => null, (e: unknown) => e as WalletClosed);

      expect(refusal).toBeInstanceOf(WalletClosed);
      expect(refusal!.refusal.of).toBe('no-wallet-tab');
      expect(refusal!.message).not.toContain('Allow pop-ups');
      expect(refusal!.message).not.toContain('your browser stopped');
      expect(refusal!.message).toContain('nothing has been signed');
      expect(refusal!.message).toContain('this page has to get right');
    });
});

/* ------------------------------------------------------------------------ */

/**
 * **THE INVITEE'S TWO ASKS, THROUGH ONE WINDOW.**
 *
 * Accepting an invitation asks a wallet twice through ONE dialog — the key
 * that opens this person's payslips, and then which of their own wallets the
 * company would be paying — because a person should meet one wallet window
 * with two things in it rather than two windows.
 *
 * **NO TEST IN THIS FILE COULD SEE WHETHER THAT WORKED, AND THE REASON WAS IN
 * THE DOUBLE RATHER THAN IN THE PRODUCT.** `close()` counted and returned, so
 * every window here went on answering after it had been put away — and putting
 * the window away when an answer arrives is precisely what the second ask then
 * runs into. A harness that cannot express a closed window cannot fail on the
 * one mechanism that breaks this journey, which is why these cases come with
 * the double's own behaviour pinned beside them.
 */
describe('§2 — TWO ASKS THROUGH ONE DIALOG', () => {
  /** Let queued work run, the way a browser would between two paints. */
  const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0); });

  /**
   * **WHAT HAPPENED, RATHER THAN WHETHER IT HUNG.** An ask that reaches nothing
   * does not fail — it waits, and a test that merely awaited it would report a
   * thirty-second timeout instead of the sentence a person actually reads. So
   * the deadline is RUN, and what comes back is a value.
   */
  async function whatHappened<T>(
    view: ARecordingView, journey: Promise<T>,
  ): Promise<
    | { readonly of: 'answered'; readonly answer: T }
    | { readonly of: 'refused'; readonly refusal: WalletClosed }
    | { readonly of: 'never' }
  > {
    let seen:
      | { of: 'answered'; answer: T }
      | { of: 'refused'; refusal: WalletClosed }
      | null = null;
    void journey.then(
      answer => { seen = { of: 'answered', answer }; },
      (refusal: WalletClosed) => { seen = { of: 'refused', refusal }; });
    await flush();
    if (seen === null) { view.fireTimers(); await flush(); }
    return seen ?? { of: 'never' };
  }

  it('WATCHED FAILING: THE DOUBLE CAN EXPRESS A CLOSED WINDOW AT ALL', () => {
    /*
     * **THIS IS THE HARNESS'S OWN PIN AND IT IS THE FIRST CASE ON PURPOSE.**
     * The journey below is only evidence about the product while these four
     * lines hold. Putting `close: () => { this.closed += 1; }` back — the
     * shape this file shipped with — turns every one of them red, and without
     * this case that change would turn nothing red and leave the journey
     * passing against a window that cannot be shut.
     */
    const view = new ARecordingView();
    const dialog = openWalletDialog(view, WALLET);
    const window = dialog.wallet!;

    expect(window.closed).toBe(false);
    window.close!();
    expect(window.closed).toBe(true);

    /* A closed window is not an error to post to. It is a nobody. */
    window.postMessage({ schema: 'an-ask' }, WALLET);
    expect(view.posted).toHaveLength(0);

    /* And the name no longer reaches it, so opening again makes a new one —
     * which is what a retry does, and why a retry gets a window at all. */
    expect(openWalletDialog(view, WALLET).wallet).not.toBe(window);
  });

  it('WATCHED FAILING: BOTH ASKS GET AN ANSWER, AND THE SECOND DOES NOT TIME OUT',
    async () => {
      /*
       * **THE WHOLE OF THE INVITEE'S JOURNEY, AT THE LAYER THAT BREAKS IT.**
       * One dialog, opened in the click; two asks driven through it, in order,
       * each answered by the wallet. The second one is the one nobody could
       * see: the first ask's success put the window away, so the second was
       * handed a window that was no longer there and waited out its twenty
       * seconds against it.
       */
      const view = new ARecordingView();
      const dialog = openWalletDialog(view, WALLET);
      /* What the invitation screen says the moment it opens the window, and
       * the whole of what it says. Without it the first answer takes the
       * window away with it. */
      dialog.moreThanOneAsk();

      const one = askWallet(view, WALLET, { schema: 'the-company-key' }, dialog);
      view.fromTheWallet({ schema: READY_PING });
      view.fromTheWallet({ schema: 'the-key' });
      expect(await whatHappened(view, one))
        .toEqual({ of: 'answered', answer: { schema: 'the-key' } });
      /* The window is STILL THERE, which is the whole of the repair. */
      expect(dialog.wallet!.closed).toBe(false);

      const two = askWallet(view, WALLET, { schema: 'where-the-money-goes' }, dialog);
      view.fromTheWallet({ schema: READY_PING });
      view.fromTheWallet({ schema: 'the-address' });
      expect(await whatHappened(view, two))
        .toEqual({ of: 'answered', answer: { schema: 'the-address' } });

      /* Two asks, and the person saw ONE window — which is the thing the
       * shared dialog was for. */
      expect(view.opened.map(o => o.target)).toEqual(
        [WALLET_DIALOG_NAME, WALLET_DIALOG_NAME]);
      expect(new Set(view.opened.map(o => o.url)).size).toBe(2);
    });

  it('WATCHED FAILING: AND THE SECOND ASK REACHES A DOCUMENT THAT HAS NOT ANSWERED YET',
    async () => {
      /*
       * **THE SECOND MECHANISM, AND IT IS INDEPENDENT OF THE FIRST.** Even
       * with the window left open, the wallet's channel answers ONE request
       * per load and ignores every later one — so a window that is merely
       * still there is not a window that can be asked again. The URL carries a
       * number that goes up precisely so that each ask meets a fresh document,
       * and this is the assertion that the second ask gets one.
       *
       * Turning it red: make the second ask reuse the URL the first one had.
       */
      const view = new ARecordingView();
      const dialog = openWalletDialog(view, WALLET);
      dialog.moreThanOneAsk();

      const one = askWallet(view, WALLET, { schema: 'the-company-key' }, dialog);
      view.fromTheWallet({ schema: READY_PING });
      view.fromTheWallet({ schema: 'the-key' });
      await whatHappened(view, one);

      const before = view.opened.length;
      const two = askWallet(view, WALLET, { schema: 'where-the-money-goes' }, dialog);
      view.fromTheWallet({ schema: READY_PING });
      view.fromTheWallet({ schema: 'the-address' });
      await whatHappened(view, two);

      expect(view.opened.length).toBe(before + 1);
      const [first, second] = [view.opened[before - 1]!.url, view.opened[before]!.url];
      expect(second).not.toBe(first);
    });

  it('WATCHED FAILING: A WINDOW THE PERSON CLOSED IS REFUSED BY NAME RATHER THAN WAITED ON',
    async () => {
      /*
       * **AND WHEN THERE IS GENUINELY NO WINDOW, IT SAYS SO AT ONCE.** A page
       * may only open a window while it is handling a press, so a dialog whose
       * window has gone cannot quietly make another one — the honest answer is
       * a refusal naming what happened, now, rather than twenty seconds of
       * *your wallet did not answer*, which sends somebody to look at their
       * wallet for a window this page no longer has.
       */
      const view = new ARecordingView();
      const dialog = openWalletDialog(view, WALLET);
      dialog.wallet!.close!();

      const asking = askWallet(view, WALLET, { schema: 'an-ask' }, dialog);
      /*
       * **READ BEFORE ANYTHING RUNS THE TIMERS, AND THAT IS THE ASSERTION.**
       * `whatHappened` fires whatever is pending, so a `waiting` read after it
       * is zero whichever way the product behaves — which is an assertion that
       * cannot fail dressed as the one that carries the point. `askWallet`
       * sets its deadline synchronously, so by the line below it either
       * refused without one or it is waiting out twenty seconds.
       *
       * Turning it red: take the `closed` read out of `take()`.
       */
      expect(view.waiting).toBe(0);

      const what = await whatHappened(view, asking);

      expect(what.of).toBe('refused');
      const refusal = (what as { refusal: WalletClosed }).refusal;
      expect(refusal.refusal.of).toBe('window-gone');
      expect(refusal.message).toContain('nothing has been signed');
      /* And it did not talk to the window that is not there. */
      expect(view.posted).toHaveLength(0);
    });

  it('WATCHED FAILING: A RE-NAVIGATION THE BROWSER REFUSES IS REFUSED BY NAME TOO',
    async () => {
      /*
       * **THE ANSWER FROM `view.open` IS THE ONLY THING THAT KNOWS.** A page
       * may open a window while it is handling a press and not afterwards, and
       * the second ask is well after the press — so the re-navigation can be
       * refused. A refusal that is DROPPED leaves this page posting into the
       * document that has already answered, which produces twenty seconds of
       * *your wallet did not answer*: the very failure this section exists
       * about, reached by a second road.
       *
       * Turning it red: ignore what `view.open` returns inside `take()`.
       */
      const view = new ARecordingView();
      const dialog = openWalletDialog(view, WALLET);
      dialog.moreThanOneAsk();

      const one = askWallet(view, WALLET, { schema: 'the-company-key' }, dialog);
      view.fromTheWallet({ schema: READY_PING });
      view.fromTheWallet({ schema: 'the-key' });
      await whatHappened(view, one);

      view.refuseTheNextOpen = true;
      const posted = view.posted.length;
      const two = askWallet(view, WALLET, { schema: 'where-the-money-goes' }, dialog);
      expect(view.waiting).toBe(0);

      const what = await whatHappened(view, two);
      expect(what.of).toBe('refused');
      expect((what as { refusal: WalletClosed }).refusal.refusal.of).toBe('window-gone');
      /* Nothing was said into the document that had already answered. */
      expect(view.posted).toHaveLength(posted);
    });

  it('WATCHED FAILING: A WINDOW CLOSED WHILE THE PAGE IS OPENING ONE LEAVES NOTHING BEHIND',
    async () => {
      /*
       * **THE GAP BETWEEN READING `closed` AND OPENING.** A person can close
       * the wallet in that gap. The name then reaches nothing, so the browser
       * makes a NEW window and hands it back — and a dialog that kept its old
       * handle would afterwards be talking to a window that is gone and
       * closing that one, while the window actually on the person's screen
       * stays there with nothing in this product able to put it away.
       *
       * Turning it red: drop what `view.open` returns inside `take()` and go
       * on using the handle from the first open.
       */
      const view = new ARecordingView();
      const dialog = openWalletDialog(view, WALLET);
      dialog.moreThanOneAsk();
      const firstWindow = dialog.wallet!;

      const one = askWallet(view, WALLET, { schema: 'the-company-key' }, dialog);
      view.fromTheWallet({ schema: READY_PING });
      view.fromTheWallet({ schema: 'the-key' });
      await whatHappened(view, one);

      /* The person closes it exactly as this page reaches for it. */
      view.duringTheNextOpen = () => { firstWindow.close!(); };

      const two = askWallet(view, WALLET, { schema: 'where-the-money-goes' }, dialog);
      view.fromTheWallet({ schema: READY_PING });
      view.fromTheWallet({ schema: 'the-address' });
      expect(await whatHappened(view, two))
        .toEqual({ of: 'answered', answer: { schema: 'the-address' } });

      /* It is talking to the window that exists, not to the one that went. */
      expect(view.made).toHaveLength(2);
      expect(dialog.wallet).not.toBe(firstWindow);

      /* And when the journey ends, no wallet is left on the screen. */
      dialog.giveUp();
      expect(view.stillOpen()).toHaveLength(0);
    });

  it('AND A DIALOG NOBODY CLAIMED IS STILL PUT AWAY BY THE ASK THAT USED IT',
    async () => {
      /*
       * **THE DEFAULT IS UNCHANGED, AND THAT IS DELIBERATE.** Every other
       * wallet journey in this product is one ask through one window, and for
       * those the ask closing the window when it settles is the right
       * behaviour and the reason a person never meets a wallet screen that is
       * no longer about anything. Only a caller with a second ask coming says
       * otherwise.
       *
       * Turning it red: make `askEnded` never close, or make
       * `moreThanOneAsk` the default.
       */
      const view = new ARecordingView();
      const dialog = openWalletDialog(view, WALLET);

      const one = askWallet(view, WALLET, { schema: 'an-ask' }, dialog);
      view.fromTheWallet({ schema: READY_PING });
      view.fromTheWallet({ schema: 'the-answer' });
      await whatHappened(view, one);

      expect(dialog.wallet!.closed).toBe(true);
      expect(view.closed).toBe(1);
    });

  it('AND THE CALLER THAT CLAIMED IT IS WHAT CLOSES IT, ON EVERY OUTCOME', async () => {
    /*
     * **THE OTHER HALF OF THE CONTRACT.** A window an ask will not close has
     * to be closed by somebody, and it is the `finally` of the journey that
     * opened it — including when that journey fails half way, which is the
     * case that would otherwise leave a wallet on screen for ever.
     *
     * Turning it red: make `giveUp` stop closing a dialog that has been
     * claimed.
     *
     * **AND WHAT IT DOES NOT PIN, SAID HERE RATHER THAN LEFT TO BE ASSUMED.**
     * This case builds its own dialog. **It says nothing about whether the
     * invitation screen actually claims one or actually gives it up** —
     * deleting either of those two lines from that screen turns nothing in
     * this file red, and the journey breaks again. What stops that being a
     * silent return of the same defect is that a second ask through an
     * unclaimed dialog now meets a window that has gone, and refuses by name
     * at once instead of waiting out twenty seconds and blaming the wallet.
     * A test that would close the gap drives the screen itself.
     */
    const view = new ARecordingView();
    const dialog = openWalletDialog(view, WALLET);
    dialog.moreThanOneAsk();

    const one = askWallet(view, WALLET, { schema: 'an-ask' }, dialog);
    view.fromTheWallet({ schema: READY_PING });
    view.fromTheWallet({ schema: 'the-answer' });
    await whatHappened(view, one);
    expect(dialog.wallet!.closed).toBe(false);

    dialog.giveUp();
    expect(dialog.wallet!.closed).toBe(true);
    expect(view.closed).toBe(1);
    /* Twice is not two closes. */
    dialog.giveUp();
    expect(view.closed).toBe(1);
  });
});

/* ------------------------------------------------------------------------ */

describe('§3 — A JOURNEY WHOSE SERVER CALL FAILS PUTS ITS WALLET AWAY', () => {
  /**
   * **EVERY WALLET JOURNEY OPENS THE WALLET IN THE PRESS AND THEN TALKS TO THIS
   * SERVER.** When that talk fails, the ask never runs, so nothing the ask does
   * on its way out closes the wallet - and the page's *waiting* line, which
   * carries the only control that could, is taken down at the same moment. A
   * wallet left on screen with nothing able to put it away is the shape a
   * person presses. One case per journey, because each was its own site.
   */
  const realFetch = globalThis.fetch;
  const realWindow = (globalThis as { window?: unknown }).window;

  afterEach(async () => {
    globalThis.fetch = realFetch;
    (globalThis as { window?: unknown }).window = realWindow;
    const keyring = await import('./keyring.js');
    keyring.forgetLocally();
  });

  /** A server that answers everything, except the one path it falls over on. */
  const aServerThatFails = (failsOn: (method: string, url: string) => boolean) =>
    (async (url: string, init?: RequestInit) => {
      const method = String(init?.method ?? 'GET');
      if (failsOn(method, String(url))) {
        return { ok: false, status: 500, json: async () => ({ error: 'the server fell over' }) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          nonce: 'n1', handle: 'h1', expiresAt: new Date(Date.now() + 600_000).toISOString(),
          session: { expiresAt: new Date(Date.now() + 600_000).toISOString() },
          address: SIGNED_IN, created: true,
          user: { id: 'usr_1', email: null, name: '' },
          company: 'a1'.repeat(32),
        }),
      } as Response;
    }) as typeof fetch;

  const signedIn = async (view: ARecordingView) => {
    (globalThis as { window?: unknown }).window = Object.assign(view, { location: { origin: US } });
    view.answers = () => ({ schema: 'a-sign-in' });
    globalThis.fetch = aServerThatFails(() => false);
    const keyring = await import('./keyring.js');
    await keyring.signInWithWallet(WALLET, undefined, view);
    view.answers = null;
    expect(view.stillOpen(), 'the sign-in left its own window open').toEqual([]);
    return keyring;
  };

  it('WATCHED FAILING: SIGNING IN, WHEN THE CHALLENGE FAILS', async () => {
    const view = new ARecordingView();
    (globalThis as { window?: unknown }).window = Object.assign(view, { location: { origin: US } });
    globalThis.fetch = aServerThatFails((_m, url) => url.endsWith('/challenge'));
    const keyring = await import('./keyring.js');
    await expect(keyring.signInWithWallet(WALLET, undefined, view)).rejects.toThrow('the server fell over');
    expect(view.made).toHaveLength(1);
    expect(view.stillOpen()).toEqual([]);
  });

  it('WATCHED FAILING: ASKING WHERE TO PAY THIS PERSON, WHEN THE CHALLENGE FAILS', async () => {
    const view = new ARecordingView();
    const keyring = await signedIn(view);
    globalThis.fetch = aServerThatFails((_m, url) => url.endsWith('/payee-challenge'));
    await expect(keyring.payeeDisclosureFromWallet('acc_1', WALLET, view)).rejects.toThrow('the server fell over');
    expect(view.stillOpen()).toEqual([]);
  });

  it('WATCHED FAILING: A COMPANY\'S KEY, WHEN THE COMPANY CANNOT BE ASKED FOR', async () => {
    const view = new ARecordingView();
    const keyring = await signedIn(view);
    view.answers = givesTheKeys;
    await keyring.openKeysWithWallet(WALLET, view, US);
    view.answers = null;
    globalThis.fetch = aServerThatFails((_m, url) => url.endsWith('/unlock'));
    await expect(keyring.payslipKeyAndPayeeAddress('acc_1', WALLET, view, US)).rejects.toThrow('the server fell over');
    expect(view.stillOpen()).toEqual([]);
  });

  it('WATCHED FAILING: A COMPANY\'S KEY AND WHERE TO PAY GO THROUGH ONE WINDOW, WHICH IS PUT AWAY AFTER BOTH',
    async () => {
      const view = new ARecordingView();
      const keyring = await signedIn(view);
      view.answers = givesTheKeys;
      await keyring.openKeysWithWallet(WALLET, view, US);
      /* The keyring ask with a company is answered with both keys; the payee ask
       * with anything, since this page judges none of it. */
      view.answers = givesTheKeys;
      const { companyKey, disclosure } = await keyring.payslipKeyAndPayeeAddress('acc_1', WALLET, view, US);
      expect(companyKey).toMatch(/^[0-9a-f]{64}$/u);
      expect(disclosure.handle).toBe('h1');
      /* Both asks reached a window, and none is left on screen afterwards. */
      expect(view.posted.length).toBeGreaterThanOrEqual(3);
      expect(view.stillOpen()).toEqual([]);
    });

  it('WATCHED FAILING: CREATING A COMPANY, WHEN THE COMPANY CANNOT BE MADE', async () => {
    const view = new ARecordingView();
    const keyring = await signedIn(view);
    view.answers = givesTheKeys;
    globalThis.fetch = aServerThatFails((method, url) => method === 'POST' && url === '/api/accounts');
    await expect(keyring.createCompanyWithWallet(
      { name: 'Acme', signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 }, WALLET, view, US,
    )).rejects.toThrow('the server fell over');
    expect(view.stillOpen()).toEqual([]);
  });

  it('AND THE PAGE STOPS SAYING IT IS WAITING, in the same failure', async () => {
    const view = new ARecordingView();
    const keyring = await signedIn(view);
    view.answers = givesTheKeys;
    const said: Array<unknown> = [];
    const stop = keyring.onWalletWaiting((d) => said.push(d === null ? 'done' : 'waiting'));
    globalThis.fetch = aServerThatFails((method, url) => method === 'POST' && url === '/api/accounts');
    await keyring.createCompanyWithWallet(
      { name: 'Acme', signers: [{ name: 'Ada', role: 'admin' }], threshold: 1 }, WALLET, view, US,
    ).catch(() => {});
    stop();
    expect(said).toEqual(['waiting', 'done']);
  });
});
