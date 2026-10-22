import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, useText } from 'vaults-ui';
import { accountFrame, onWaiting, stopWaiting } from '../adapters/session.js';

/** What the browser itself reads: the marks an open panel's library hides the rest of the page with, and the event a guard of the window hears. */
const BROWSER = { hiddenMarks: ['aria-hidden', 'data-aria-hidden'], focus: 'focus' } as const;

/**
 * THE PERSON'S ACCOUNT, SHOWN IN THIS PAGE, AND WHAT THE PAGE IS WAITING FOR.
 *
 * The account's own screen is in the frame, where this page can draw nothing:
 * whatever the person approves, they approve there. This page draws a line
 * saying it is waiting, and a way out that puts the account away and stops
 * the request, so a page never holds the account on screen with nothing able
 * to close it. The frame sits beside the screen and is never moved while it is
 * in use, because moving a frame reloads what is in it. It is drawn afresh only
 * when the application passes between a visitor, a signed-in person and a
 * service it cannot reach, and by then no request is waiting on it.
 *
 * It stacks above the right-hand panel, a modal sheet at layer 50 that switches
 * off presses outside itself: the account's window is at layer 60 and takes
 * presses, so a window opened from a panel can be pressed.
 *
 * IT IS DRAWN IN THE PAGE'S BODY, NOT IN THE APPLICATION'S ROOT, because an
 * open panel tells assistive tools that everything outside it is not there,
 * and a window inside the root would go with it. While it is shown it is
 * never hidden from them, and it is a dialog of its own. When it is shown,
 * focus goes into the account (the frame), so a keyboard can use it, and when
 * it is put away focus goes back to where it was. The right-hand panel lets
 * focus into it (`useLeaveTheWalletWindowItsOwn`).
 */
export function AccountFrame() {
  const t = useText();
  const [shown, setShown] = useState<boolean>(accountFrame.shown());
  const [waiting, setWaiting] = useState(false);
  useEffect(() => accountFrame.onShown(setShown), []);
  useEffect(() => onWaiting(setWaiting), []);
  const card = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const stop = useRef<HTMLButtonElement>(null);
  const start = useRef<HTMLSpanElement>(null);
  const end = useRef<HTMLSpanElement>(null);
  const title = useId();
  /* Handed to the shared code once and kept, not made again at each draw: a frame handed over again is a frame taken away. */
  const mountFrame = useCallback((element: HTMLIFrameElement | null) => { frame.current = element; accountFrame.mount(element); }, []);
  /* Seen by assistive tools while shown: an open panel marks every other part of the body hidden, this one too, and is told otherwise each time it does. */
  useEffect(() => {
    const node = card.current;
    if (node === null || !shown) return undefined;
    const show = (): void => { for (const mark of BROWSER.hiddenMarks) node.removeAttribute(mark); };
    show();
    const watch = new MutationObserver(show);
    watch.observe(node, { attributes: true, attributeFilter: [...BROWSER.hiddenMarks] });
    return () => watch.disconnect();
  }, [shown]);
  /* Focus goes into the account when it opens, and back to where it was when it is put away. */
  useEffect(() => {
    const node = card.current;
    if (node === null || !shown) return undefined;
    const was = node.ownerDocument.activeElement;
    frame.current?.focus();
    return () => {
      const now = node.ownerDocument.activeElement;
      if (was instanceof HTMLElement && was.isConnected && (now === null || now === node.ownerDocument.body || node.contains(now))) was.focus();
    };
  }, [shown]);
  /*
   * Tab goes round inside the window: past the account's last control to the stop button, and back past the stop
   * button to the account, and never on to the page behind it, which the window covers. Heard as the guards'
   * own `focus`, not React's `onFocus`, which the panel does not let through (`useLeaveTheWalletWindowItsOwn`).
   */
  useEffect(() => {
    const ends: [HTMLElement | null, () => void][] = [[start.current, () => frame.current?.focus()], [end.current, () => stop.current?.focus()]];
    for (const [guard, go] of ends) guard?.addEventListener(BROWSER.focus, go);
    return () => { for (const [guard, go] of ends) guard?.removeEventListener(BROWSER.focus, go); };
  }, []);
  return createPortal(
    <div ref={card} className="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center bg-foreground/20 p-4 backdrop-blur-xs" hidden={!shown} data-account-frame>
      <div className="flex w-full max-w-md flex-col gap-3 rounded-xl bg-background p-4 shadow-lg ring-1 ring-foreground/10" role="dialog" aria-modal={true} aria-labelledby={title}>
        <span ref={start} className="sr-only" tabIndex={0} data-focus-guard="start" />
        <div className="flex items-start justify-between gap-3" role="status">
          <div className="flex flex-col gap-1">
            <strong className="text-sm font-medium" id={title}>{t('accountFrame.waiting')}</strong>
            <p className="text-xs text-muted-foreground">{waiting ? t('accountFrame.nothingSignedYet') : t('accountFrame.open')}</p>
          </div>
          <Button ref={stop} variant="outline" size="sm" onClick={stopWaiting} data-action="stop-waiting">{t('accountFrame.stop')}</Button>
        </div>
        <iframe ref={mountFrame} title={t('accountFrame.title')} allow={accountFrame.allow} className="h-[36rem] w-full rounded-lg border" />
        <span ref={end} className="sr-only" tabIndex={0} data-focus-guard="end" />
      </div>
    </div>,
    document.body,
  );
}
