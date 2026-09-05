import { afterEach, describe, expect, it } from 'vitest';
import { READY_PING } from 'midnight-identity/profile/channel';
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
 * `scripts/mutate-wallet-dialog.mjs` 01 and 02 put the old order back.
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

  open(url: string, target: string, features?: string): WalletWindow | null {
    this.opened.push({ url, target, features: features ?? '' });
    this.happened.push(`open ${target}`);
    const existing = this.windows.get(target);
    if (existing) return existing;
    const made: WalletWindow = {
      postMessage: (message: unknown, t: string) => {
        this.posted.push({ message, target: t });
        if (this.answers) {
          const said = this.answers(message);
          queueMicrotask(() => this.fromTheWallet(said));
        }
      },
      focus: () => { this.focused += 1; },
      close: () => { this.closed += 1; },
    };
    this.windows.set(target, made);
    this.last = made;
    return made;
  }

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

  /** A message from the wallet's window, at the wallet's origin. */
  fromTheWallet(data: unknown, origin = WALLET): void {
    this.handler?.({ origin, source: this.last, data } as unknown as MessageEvent);
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
          session: { token: 'tok' }, address: 'mn_addr', created: true,
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

  it('WATCHED FAILING: UNLOCKING OPENS THE WALLET BEFORE IT ASKS WHICH COMPANY',
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

      happened.length = 0;
      /* Nothing answers this one: what is being watched is the first two
       * things it does, and both have happened by the time it returns. */
      view.answers = null;
      const unlocking = keyring.unlockWithWallet('acc_1', WALLET, view, US);
      unlocking.catch(() => { /* it never finishes; the order is the subject */ });

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
