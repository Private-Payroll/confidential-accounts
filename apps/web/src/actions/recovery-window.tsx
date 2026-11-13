import { useEffect, useState } from 'react';
import { Alert, AlertDescription, Button, FieldLegend, FieldSet, Section, useText } from 'vaults-ui';
import {
  durationSaid, readRecoveryWindow, setRecoveryWindow, windowWhenNoneInForce, WINDOW_ACTED, WINDOW_READ, WINDOW_STATE, WINDOW_WHY,
  type WindowActed, type WindowHeld, type WindowWhy,
} from '../adapters/recovery-window.js';
import { RECOVERY_WITHIN } from '../adapters/recovery.js';

type Words = ReturnType<typeof useText>;

const WHY_SAYS = (t: Words): Record<WindowWhy, string> => ({
  [WINDOW_WHY.seat]: t('recovery.window.why.seat'), [WINDOW_WHY.mayNotStart]: t('recovery.window.why.may-not-start'),
  [WINDOW_WHY.seatNotBelieved]: t('recovery.window.why.seat-not-believed'), [WINDOW_WHY.keyBeingChanged]: t('recovery.window.why.key-being-changed'),
  [WINDOW_WHY.filedMeanwhile]: t('recovery.window.why.filed-meanwhile'), [WINDOW_WHY.notFiled]: t('recovery.window.why.not-filed'),
  [WINDOW_WHY.notEntered]: t('recovery.window.why.not-entered'), [WINDOW_WHY.unread]: t('recovery.window.why.unread'),
  [WINDOW_WHY.stopped]: t('recovery.window.why.stopped'), [WINDOW_WHY.other]: t('recovery.window.why.other'),
});

/** What the window read says: the length in force or none, and a change still waiting for signatures. */
function WindowSays({ held }: { held: WindowHeld | null }) {
  const t = useText();
  if (held === null) return <p className="text-muted-foreground" role="status" data-window="reading">{t('recovery.window.reading')}</p>;
  if (held.of === WINDOW_READ.unread) return <p data-window="unread">{t('recovery.window.unread', { why: held.why })}</p>;
  if (held.of === WINDOW_READ.refused) return <p data-window="refused">{t('recovery.window.refused')}</p>;
  return (
    <div className="flex flex-col gap-1" data-window="read">
      <p data-window-in-force>{held.inForce === null
        ? t('recovery.window.unchosen', { length: durationSaid(windowWhenNoneInForce()) })
        : t('recovery.window.in-force', { length: durationSaid(held.inForce) })}</p>
      {held.waiting === null ? null : (
        <p data-window-waiting>{t('recovery.window.waiting', { length: durationSaid(held.waiting.seconds), signed: held.waiting.signed, needed: held.waiting.needed })}</p>
      )}
    </div>
  );
}

/**
 * THE RECOVERY WINDOW: how far ahead a recovery may be carried out, as the company's signers chose it. Shows the window in
 * force or none, a change still waiting for signatures, and a press that opens the wallet to start a change or sign the one
 * waiting. The network does not hold the window: each signer's device does. `onRead` is told the length in force, so the
 * raise above offers only waits within it.
 */
export function RecoveryWindowSection({ personId, company, onRead }: {
  personId: string; company: string | null; onRead: (inForce: number | null) => void;
}) {
  const t = useText();
  const [held, setHeld] = useState<WindowHeld | null>(null);
  const [length, setLength] = useState<number>(RECOVERY_WITHIN[1].seconds);
  const [busy, setBusy] = useState(false);
  const [acted, setActed] = useState<WindowActed | null>(null);
  const [reads, setReads] = useState(0);

  useEffect(() => {
    if (company === null) return undefined;
    let current = true;
    setHeld(null);
    void readRecoveryWindow(personId, company).then((read) => {
      if (!current) return;
      setHeld(read);
      if (read.of === WINDOW_READ.read) {
        onRead(read.inForce);
        if (read.waiting !== null) setLength(read.waiting.seconds);
      }
    });
    return () => { current = false; };
  }, [personId, company, reads]);

  const press = async (): Promise<void> => {
    if (company === null || busy) return;
    setBusy(true);
    setActed(null);
    const ended = await setRecoveryWindow(personId, company, length);
    setBusy(false);
    setActed(ended);
    setReads((n) => n + 1);
  };

  return (
    <Section title={t('recovery.window.heading')} list={false} data-recovery-window>
      <p className="text-muted-foreground">{t('recovery.window.about')}</p>
      <WindowSays held={held} />
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void press(); }}>
        <FieldSet disabled={busy}>
          <FieldLegend variant="label">{t('recovery.window.set')}</FieldLegend>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('recovery.window.set')}>
            {RECOVERY_WITHIN.map((w) => (
              <Button key={w.id} type="button" size="sm" variant={w.seconds === length ? 'default' : 'outline'} aria-pressed={w.seconds === length} disabled={busy}
                data-window-length={w.id} onClick={() => setLength(w.seconds)}>
                {durationSaid(w.seconds)}
              </Button>
            ))}
          </div>
        </FieldSet>
        <p className="text-muted-foreground">{t('recovery.window.who')}</p>
        <div><Button type="submit" disabled={busy || company === null} data-action="set-recovery-window">{t('recovery.window.press')}</Button></div>
      </form>
      {acted === null ? null : acted.of === WINDOW_ACTED.done ? (
        <Alert data-window-done>
          <AlertDescription>{acted.state === WINDOW_STATE.inForce
            ? t('recovery.window.done.in-force')
            : t('recovery.window.done.waiting', { signed: acted.signed ?? 0, needed: acted.needed ?? 0 })}</AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive" data-window-stopped>
          <AlertDescription>{acted.of === WINDOW_ACTED.stopped ? WHY_SAYS(t)[acted.why] : t('recovery.window.why.other')}</AlertDescription>
        </Alert>
      )}
    </Section>
  );
}
