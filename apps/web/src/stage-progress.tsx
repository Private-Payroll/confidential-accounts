import { useEffect, useRef, useState } from 'react';
import { formatNumber, useLanguage, useText } from 'vaults-ui';

const TICK_MS = 1000;

/** Re-reads the clock and the running proofs every second; the proof that began first sets when the stage began. */
export function useTicker(proofs: () => ReadonlyArray<{ readonly startedAt: number }>): { now: number; proofStartedAt: number | null } {
  const [seen, setSeen] = useState<{ now: number; proofStartedAt: number | null }>(() => ({ now: Date.now(), proofStartedAt: null }));
  useEffect(() => {
    const look = (): void => {
      const running = proofs();
      setSeen({ now: Date.now(), proofStartedAt: running.length === 0 ? null : Math.min(...running.map((p) => p.startedAt)) });
    };
    look();
    const timer = setInterval(look, TICK_MS);
    return () => clearInterval(timer);
  }, [proofs]);
  return seen;
}

/** When the named stage was first drawn; a new name (any part of it) starts the count again. */
export function useStageSince(...name: ReadonlyArray<string | null>): number {
  const since = useRef<{ name: ReadonlyArray<string | null>; at: number } | null>(null);
  const same = since.current !== null && since.current.name.length === name.length && since.current.name.every((part, i) => part === name[i]);
  if (!same) since.current = { name, at: Date.now() };
  return since.current!.at;
}

export const secondsSince = (now: number, startedAt: number): number => Math.max(0, Math.floor((now - startedAt) / 1000));


/** What a stage is doing, how long it has run, and how long it usually takes. */
export function StageProgress({ stage, words, elapsedSeconds, usualSeconds }: {
  stage: string; words?: string; elapsedSeconds: number; usualSeconds: number | null;
}) {
  const t = useText();
  const language = useLanguage();
  const clock = t('stageProgress.clock', {
    minutes: formatNumber(Math.floor(elapsedSeconds / 60), language),
    seconds: formatNumber(elapsedSeconds % 60, language, { minimumIntegerDigits: 2 }),
  });
  const usual = usualSeconds === null ? t('stageProgress.noUsual')
    : elapsedSeconds > usualSeconds ? t('stageProgress.longer')
    : usualSeconds < 60 ? t('stageProgress.usualSeconds', { seconds: usualSeconds })
    : usualSeconds < 90 ? t('stageProgress.usualMinute')
    : t('stageProgress.usualMinutes', { minutes: Math.round(usualSeconds / 60) });
  return (
    <div className="flex flex-col gap-1" data-stage-clock={stage} data-elapsed-seconds={elapsedSeconds} data-usual-seconds={usualSeconds ?? undefined}>
      {words === undefined ? null : <p className="text-sm" data-phase-words>{words}</p>}
      <p className="text-xs text-muted-foreground tabular-nums" data-elapsed>{t('stageProgress.running', { time: clock })}</p>
      <p className="text-xs text-muted-foreground" data-usual>{usual}</p>
    </div>
  );
}
