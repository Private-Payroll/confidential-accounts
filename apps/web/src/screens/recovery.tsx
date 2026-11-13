import { useEffect, useRef, useState } from 'react';
import { FileSecurityIcon } from '@hugeicons/core-free-icons';
import { Alert, AlertDescription, Button, EmptyState, FieldLegend, FieldSet, Section, useText } from 'vaults-ui';
import {
  approveRecovery, carryOutRecovery, FILE_REFUSED, openRecoveryFile, RECOVERED, RECOVERY_ACT, RECOVERY_FILE_ACCEPT, RECOVERY_STATE, RECOVERY_WHY, RECOVERY_WINDOW_RANGE,
  RECOVERY_WITHIN, raiseRecovery, readRecordsStates, recoveryStanding, recoveryWithinUpTo, saveRecoveryFile, type RecordsStates, type FileRefusal, type RecoveryAct, type RecoveryActed, type RecoveryHere, type RecoveryStanding, type RecoveryWhy, type RecoveryWithin,
} from '../adapters/recovery.js';
import { READ, type Read } from '../adapters/reads.js';
import { useMoment } from '../records/parts.js';
import { useCompanyRecords } from '../records/company-records.js';
import { ActDone, ActOutcome, ActStopped, type ActStep } from '../records/proposal-act.js';
import { useSession } from '../session.js';
import { RecoveryWindowSection } from '../actions/recovery-window.js';

type Words = ReturnType<typeof useText>;

const withinSays = (t: Words, id: RecoveryWithin): string => {
  switch (id) {
    case 'hour': return t('recovery.within.hour');
    case 'day': return t('recovery.within.day');
    case 'three-days': return t('recovery.within.three-days');
    case 'six-days': return t('recovery.within.six-days');
    case 'two-weeks': return t('recovery.within.two-weeks');
    case 'longest': return t('recovery.within.longest', { days: RECOVERY_WINDOW_RANGE.longest / (24 * 60 * 60) });
  }
};
const FILE_SAYS = (t: Words): Record<FileRefusal, string> => ({
  [FILE_REFUSED.unreadable]: t('recovery.file.refused.unreadable'), [FILE_REFUSED.notARecovery]: t('recovery.file.refused.not-a-recovery'),
  [FILE_REFUSED.notThisCompany]: t('recovery.file.refused.not-this-company'), [FILE_REFUSED.companyUnread]: t('recovery.file.refused.company-unread'),
});
const DONE_SAYS = (t: Words): Record<RecoveryAct, string> => ({
  [RECOVERY_ACT.raise]: t('recovery.done.raise'), [RECOVERY_ACT.approve]: t('recovery.done.approve'), [RECOVERY_ACT.carry]: t('recovery.done.carry'),
});
const NOT_DONE_SAYS = (t: Words): Record<RecoveryAct, string> => ({
  [RECOVERY_ACT.raise]: t('recovery.why.not-done.raise'), [RECOVERY_ACT.approve]: t('recovery.why.not-done.approve'), [RECOVERY_ACT.carry]: t('recovery.why.not-done.carry'),
});
const WHY_SAYS = (t: Words): Record<RecoveryWhy, string> => ({
  [RECOVERY_WHY.seat]: t('recovery.why.seat'), [RECOVERY_WHY.noAccount]: t('recovery.why.no-account'), [RECOVERY_WHY.noDust]: t('recovery.why.no-dust'),
  [RECOVERY_WHY.notARecovery]: t('recovery.why.not-a-recovery'), [RECOVERY_WHY.notRaised]: t('recovery.why.not-raised'), [RECOVERY_WHY.closed]: t('recovery.why.closed'),
  [RECOVERY_WHY.outrun]: t('recovery.why.outrun'), [RECOVERY_WHY.stillOpen]: t('recovery.why.still-open'), [RECOVERY_WHY.mayBeSent]: t('recovery.why.may-be-sent'),
  [RECOVERY_WHY.notDone]: t('recovery.why.other'), [RECOVERY_WHY.noWallet]: t('recovery.why.no-wallet'), [RECOVERY_WHY.stopped]: t('recovery.why.stopped'),
  [RECOVERY_WHY.other]: t('recovery.why.other'), [RECOVERY_WHY.windowUnread]: t('recovery.why.window-unread'),
});

type Phase = (ActStep & { readonly act: RecoveryAct }) | null;

/**
 * RECOVERY: raising a recovery of the company's records, approving one a signer sent as a file, carrying it out, saving its file and
 * opening a saved one. Each press opens the person's wallet, which signs with the passkey and sends from its own account, so this
 * page holds nothing secret and sends nothing. A recovery is never listed on Proposals: it is held here, from the file just made or
 * opened, and where the network holds it is read from the chain each time it is shown, never from the file.
 */
export function Recovery() {
  const t = useText();
  const { person, company } = useSession();
  const { reload } = useCompanyRecords();
  const [within, setWithin] = useState<RecoveryWithin>(RECOVERY_WITHIN[1].id);
  const [windowInForce, setWindowInForce] = useState<number | null>(null);
  const choices = recoveryWithinUpTo(windowInForce);
  const chosen = choices.some((w) => w.id === within) ? within : (choices[choices.length - 1]?.id ?? within);
  const [held, setHeld] = useState<RecoveryHere | null>(null);
  const [phase, setPhase] = useState<Phase>(null);
  const [result, setResult] = useState<RecoveryActed | null>(null);
  const [standing, setStanding] = useState<RecoveryStanding | null>(null);
  const [reads, setReads] = useState(0);
  const [refusedFile, setRefusedFile] = useState<FileRefusal | null>(null);
  const [records, setRecords] = useState<Read<RecordsStates> | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const busy = phase !== null;

  useEffect(() => {
    if (held === null || company === null) { setStanding(null); return undefined; }
    let current = true;
    setStanding(null);
    void recoveryStanding(company, held).then((read) => { if (current) setStanding(read); });
    return () => { current = false; };
  }, [held, company, reads]);

  useEffect(() => {
    if (company === null) return undefined;
    let current = true;
    void readRecordsStates(person.id, company).then((read) => { if (current) setRecords(read); });
    return () => { current = false; };
  }, [person.id, company, reads]);

  const press = async (act: RecoveryAct, ask: (onStep: (step: number, steps: number) => void) => Promise<RecoveryActed>): Promise<void> => {
    if (company === null || busy) return;
    setResult(null);
    setRefusedFile(null);
    setPhase({ act, step: 0, steps: 0 });
    const ended = await ask((step, steps) => setPhase({ act, step, steps }));
    setPhase(null);
    setResult(ended);
    if (ended.of === RECOVERED.refused) return;
    if (ended.held !== null) setHeld(ended.held);
    setReads((n) => n + 1);
    if ((ended.of === RECOVERED.done && ended.state === RECOVERY_STATE.carriedOut) || (ended.of === RECOVERED.stopped && ended.partial)) reload();
  };

  const open = async (file: File | undefined): Promise<void> => {
    if (file === undefined || company === null || busy) return;
    setResult(null);
    const opened = await openRecoveryFile(company, await file.text());
    if (opened.of === 'refused') { setRefusedFile(opened.why); return; }
    setRefusedFile(null);
    setHeld(opened.held);
  };

  return (
    <div className="flex max-w-xl flex-col gap-8 text-sm" data-screen="recovery">
      <p className="text-muted-foreground" data-recovery-intro>{t('recovery.intro')}</p>
      <RecordsStandingSays read={records} />
      <Section title={t('recovery.raise.heading')} list={false}>
        <form className="flex flex-col gap-4" data-recovery-raise onSubmit={(e) => { e.preventDefault(); if (company !== null) void press(RECOVERY_ACT.raise, (onStep) => raiseRecovery(person.id, company, chosen, onStep)); }}>
          <FieldSet disabled={busy}>
            <FieldLegend variant="label">{t('recovery.raise.within')}</FieldLegend>
            <div className="flex flex-wrap gap-2" role="group" aria-label={t('recovery.raise.within')}>
              {choices.map((w) => (
                <Button key={w.id} type="button" size="sm" variant={w.id === chosen ? 'default' : 'outline'} aria-pressed={w.id === chosen} disabled={busy} data-within={w.id} onClick={() => setWithin(w.id)}>
                  {withinSays(t, w.id)}
                </Button>
              ))}
            </div>
          </FieldSet>
          <p className="text-muted-foreground" data-recovery-horizon>{t('recovery.horizon', { days: RECOVERY_WINDOW_RANGE.longest / (24 * 60 * 60) })}</p>
          <div><Button type="submit" disabled={busy || company === null} data-action="raise-recovery">{t('recovery.raise.press')}</Button></div>
        </form>
      </Section>
      <RecoveryWindowSection personId={person.id} company={company} onRead={setWindowInForce} />
      <Section title={t('recovery.held.heading')} list={false} data-recovery-held>
        {held === null ? <EmptyState icon={FileSecurityIcon}>{t('recovery.held.nothing')}</EmptyState> : (
          <HeldRecovery
            held={held} standing={standing} busy={busy}
            approve={() => { if (company !== null) void press(RECOVERY_ACT.approve, (onStep) => approveRecovery(person.id, company, held, onStep)); }}
            carry={() => { if (company !== null) void press(RECOVERY_ACT.carry, (onStep) => carryOutRecovery(person.id, company, held, onStep)); }}
          />
        )}
        <div className="flex flex-col items-start gap-2">
          <input ref={picker} type="file" accept={RECOVERY_FILE_ACCEPT} className="hidden" data-recovery-file onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void open(f); }} />
          <Button type="button" variant="outline" disabled={busy} data-action="open-recovery-file" onClick={() => picker.current?.click()}>{t('recovery.file.open')}</Button>
          {refusedFile === null ? null : <Alert variant="destructive" data-file-refused={refusedFile}><AlertDescription>{FILE_SAYS(t)[refusedFile]}</AlertDescription></Alert>}
        </div>
      </Section>
      <Says phase={phase} result={result} />
    </div>
  );
}

/** The recovery held: the last moment it may be carried out, where the chain holds it, and the three things to do with it. */
function HeldRecovery({ held, standing, busy, approve, carry }: {
  held: RecoveryHere; standing: RecoveryStanding | null; busy: boolean; approve: () => void; carry: () => void;
}) {
  const t = useText();
  const moment = useMoment();
  const over = standing?.of === 'read' && (standing.passed || standing.held === 'cleared' || standing.held === 'closed');
  return (
    <div className="flex flex-col gap-3" data-recovery={held.parts.chainId}>
      <p data-recovery-until>{t('recovery.held.until', { when: moment(held.until) })}</p>
      <StandingSays standing={standing} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={busy} data-action="save-recovery-file" onClick={() => saveRecoveryFile(held, t('recovery.file.summary', { seq: held.parts.resumesFrom.seq, until: moment(held.until) }))}>{t('recovery.file.save')}</Button>
        <Button type="button" disabled={busy || over} data-action="approve-recovery" onClick={approve}>{t('recovery.approve')}</Button>
        <Button type="button" disabled={busy || over} data-action="carry-out-recovery" onClick={carry}>{t('recovery.carry')}</Button>
      </div>
      <p className="text-muted-foreground">{t('recovery.file.why')}</p>
    </div>
  );
}

function StandingSays({ standing }: { standing: RecoveryStanding | null }) {
  const t = useText();
  if (standing === null) return <p className="text-muted-foreground" role="status" data-recovery-standing="reading">{t('recovery.standing.reading')}</p>;
  if (standing.of === 'unread') return <p data-recovery-standing="unread">{t('recovery.standing.unread')}</p>;
  const lines = [
    standing.held === 'never' ? t('recovery.standing.never')
      : standing.held === 'open'
        ? (standing.needed === null ? t('recovery.standing.open.count', { approvals: standing.approvals }) : t('recovery.standing.open', { approvals: standing.approvals, needed: standing.needed }))
        : t('recovery.standing.closed'),
    ...(standing.held === 'open' && standing.outrun ? [t('recovery.standing.outrun')] : []),
    ...(standing.passed && standing.held === 'open' ? [t('recovery.standing.passed')] : []),
  ];
  return <div className="flex flex-col gap-1" data-recovery-standing={standing.held}>{lines.map((l) => <p key={l}>{l}</p>)}</div>;
}

/** What the last press is doing, or came to. */
function Says({ phase, result }: { phase: Phase; result: RecoveryActed | null }) {
  const t = useText();
  const ended = result?.of === RECOVERED.done ? result : null;
  const stopped = result?.of === RECOVERED.stopped ? result : null;
  const filed = (r: { act: RecoveryAct; held: unknown }): boolean => r.held !== null && r.act === RECOVERY_ACT.raise;
  return (
    <ActOutcome phase={phase} refused={result?.of === RECOVERED.refused ? result.why : null}>
      {ended === null ? null : (
        <ActDone data-acted={ended.act} data-recovery-state={ended.state ?? 'unknown'}>
          {ended.state === RECOVERY_STATE.carriedOut ? t('recovery.done.carried') : ended.act === RECOVERY_ACT.carry ? t('recovery.done.not-yet') : DONE_SAYS(t)[ended.act]}
          {ended.approvals !== null && ended.needed !== null ? <> {t('proposal.act.counted', { approvals: ended.approvals, needed: ended.needed })}</> : null}
          {filed(ended) ? <> {t('recovery.done.save')}</> : null}
        </ActDone>
      )}
      {stopped === null ? null : (
        <ActStopped calm={stopped.partial} data-recovery-stopped={stopped.why}>
          <AlertDescription>{stopped.why === RECOVERY_WHY.notDone ? NOT_DONE_SAYS(t)[stopped.act] : WHY_SAYS(t)[stopped.why]}</AlertDescription>
          {stopped.partial ? <AlertDescription data-partial>{t('recovery.partial')}</AlertDescription> : null}
          {filed(stopped) ? <AlertDescription data-raised-file>{t('recovery.done.save')}</AlertDescription> : null}
        </ActStopped>
      )}
    </ActOutcome>
  );
}


/** Where the company's records stand on this device, each state in its own words: a stop, where the check began, what a recovery gave up, versions passed over, changes not applied and records not yet anchored. */
function RecordsStandingSays({ read }: { read: Read<RecordsStates> | null }) {
  const t = useText();
  return (
    <Section title={t('recovery.records.heading')} list={false} data-recovery-records>
      {read === null ? <p className="text-muted-foreground" role="status" data-records-state="reading">{t('recovery.records.reading')}</p>
        : read.of === READ.unreadable ? <p data-records-state="unread">{t('recovery.records.unread')}</p>
          : <RecordsStates states={read.value} />}
    </Section>
  );
}

const short = (hex: string): string => hex.slice(0, 12);

function RecordsStates({ states }: { states: RecordsStates }) {
  const t = useText();
  const stop = states.stopped;
  const from = states.checkedFrom;
  return (
    <>
      <p data-records-state="reached">{states.reached < 0 ? t('recovery.records.nothingChecked') : t('recovery.records.reached', { seq: states.reached })}</p>
      <p data-records-state="checked-from">
        {from === null ? t('recovery.records.fromFirst')
          : from.by === 'vouched'
            ? (from.at === undefined ? t('recovery.records.fromVouched', { seq: from.seq, run: from.run === undefined ? '' : short(from.run) })
              : t('recovery.records.fromVouchedAt', { seq: from.seq, run: from.run === undefined ? '' : short(from.run), at: from.at }))
            : t('recovery.records.fromLatest', { seq: from.seq })}
      </p>
      {stop === null ? <p data-records-state="no-stop">{t('recovery.records.noStop')}</p> : <StopSays stop={stop} />}
      {states.recovered === null ? null
        : <p data-records-state="recovered">{t('recovery.records.recovered', { from: states.recovered.resumedFrom, to: states.recovered.gaveUpTo })}</p>}
      {states.notYetAnchored === 0 ? null : <p data-records-state="not-yet-anchored">{t('recovery.records.notYetAnchored', { count: states.notYetAnchored })}</p>}
      {states.passedOver.length === 0 ? null : (
        <p data-records-state="passed-over">
          {t('recovery.records.passedOver', { count: states.passedOver.length })}
          {states.passedOver.map((v) => <span key={v}> {v}</span>)}
        </p>
      )}
      {states.notApplied.length === 0 ? null : (
        <p data-records-state="not-applied">
          {t('recovery.records.notApplied', { count: states.notApplied.length })}
          {states.notApplied.map((v) => <span key={v}> {v}</span>)}
        </p>
      )}
    </>
  );
}

/** A stop in the records, as the quorum's matter and never the service's alone: a batch not given, a batch given after a recovery this device cannot follow, or a batch that is not honest. */
function StopSays({ stop }: { stop: NonNullable<RecordsStates['stopped']> }) {
  const t = useText();
  if (stop.stop === 'dishonest') {
    return (
      <Alert variant="destructive" data-records-state="stopped" data-stop="dishonest">
        <AlertDescription>{t('recovery.records.stop.dishonest', { batch: stop.seq + 1 })}</AlertDescription>
        <AlertDescription>
          {stop.anchoredBy === null ? t('recovery.records.stop.unsigned') : t('recovery.records.stop.signedBy', { seat: short(stop.anchoredBy) })}
        </AlertDescription>
        <AlertDescription>{t('recovery.records.stop.wayPast')}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive" data-records-state="stopped" data-stop="not-given">
      <AlertDescription>
        {stop.recovery === true ? t('recovery.records.stop.recovery', { seq: stop.seq }) : t('recovery.records.stop.notGiven', { batch: stop.seq + 1 })}
      </AlertDescription>
      {stop.movedBy === undefined ? null : (
        <AlertDescription data-moved-by={stop.movedBy}>
          {stop.anchorsInBlock !== undefined && stop.anchorsInBlock > 1
            ? t('recovery.records.stop.movedByOneOf', { seat: short(stop.movedBy), count: stop.anchorsInBlock })
            : t('recovery.records.stop.movedBy', { seat: short(stop.movedBy) })}
        </AlertDescription>
      )}
      <AlertDescription>{t('recovery.records.stop.wayPast')}</AlertDescription>
    </Alert>
  );
}
