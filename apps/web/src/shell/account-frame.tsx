import { useEffect, useState } from 'react';
import { Button, useText } from 'vaults-ui';
import { accountFrame, onWaiting, stopWaiting } from '../adapters/session.js';

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
 */
export function AccountFrame() {
  const t = useText();
  const [shown, setShown] = useState<boolean>(accountFrame.shown());
  const [waiting, setWaiting] = useState(false);
  useEffect(() => accountFrame.onShown(setShown), []);
  useEffect(() => onWaiting(setWaiting), []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 p-4 backdrop-blur-xs" hidden={!shown} data-account-frame>
      <div className="flex w-full max-w-md flex-col gap-3 rounded-xl bg-background p-4 shadow-lg ring-1 ring-foreground/10">
        <div className="flex items-start justify-between gap-3" role="status">
          <div className="flex flex-col gap-1">
            <strong className="text-sm font-medium">{t('accountFrame.waiting')}</strong>
            <p className="text-xs text-muted-foreground">{waiting ? t('accountFrame.nothingSignedYet') : t('accountFrame.open')}</p>
          </div>
          <Button variant="outline" size="sm" onClick={stopWaiting} data-action="stop-waiting">{t('accountFrame.stop')}</Button>
        </div>
        <iframe ref={accountFrame.mount} title={t('accountFrame.title')} allow={accountFrame.allow} className="h-[36rem] w-full rounded-lg border" />
      </div>
    </div>
  );
}
