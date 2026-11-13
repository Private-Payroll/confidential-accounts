import { useEffect, useId, useState } from 'react';
import { UserGroupIcon } from '@hugeicons/core-free-icons';
import { Alert, AlertDescription, Button, CopyText, EmptyState, Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet, RadioGroup, RadioGroupItem, Section, SectionRow, Textarea, useText } from 'vaults-ui';
import {
  approveWaitingChange, CARRIES, GRANT_ACTED, GRANT_WHY, giveReadAccess, GRANTS_READ, namedBefore, READER_ROLES, readGrants, takeAwayReadAccess,
  type Carries, type ChangeWaiting, type GrantActed, type GrantsRead, type GrantWhy, type ReaderHeld,
} from '../adapters/grants-here.js';
import { ACT_REFUSAL } from '../adapters/refusals.js';
import { watchPrivateMoneyReadable } from '../adapters/vault-private-money.js';
import { ActRefused } from '../act-refused.js';
import { PAGE } from '../pages.js';
import { addressOf } from '../router.js';
import { useSession } from '../session.js';
import { useCompanyRecords } from './company-records.js';
import { ActOutcome, ActDone, ActStopped, type ActPhase } from './proposal-act.js';

type Words = ReturnType<typeof useText>;
type Shown = { readonly acted: GrantActed; readonly carries: Carries | null };
type Run = (personId: string, companyId: string, onStep: (step: number, steps: number) => void) => Promise<Shown>;

const WHY_SAYS = (t: Words): Record<GrantWhy, string> => ({
  [GRANT_WHY.seat]: t('roles.why.seat'), [GRANT_WHY.notACode]: t('roles.why.not-a-code'), [GRANT_WHY.codeNotSigned]: t('roles.why.code-not-signed'),
  [GRANT_WHY.codeAnotherCompany]: t('roles.why.code-another-company'), [GRANT_WHY.notAsAsked]: t('roles.why.not-as-asked'),
  [GRANT_WHY.filedMeanwhile]: t('roles.why.filed-meanwhile'), [GRANT_WHY.notFiled]: t('roles.why.not-filed'), [GRANT_WHY.stopped]: t('roles.why.stopped'),
  [GRANT_WHY.other]: t('roles.why.other'),
});

const carriesSays = (t: Words, carries: Carries): string => {
  switch (carries) {
    case CARRIES.inForce: return t('roles.carries.in-force');
    case CARRIES.signed: return t('roles.carries.signed');
    case CARRIES.notTheWaitingChange: return t('roles.carries.not-the-waiting-change');
    case CARRIES.unread: return t('roles.carries.unread');
  }
};

const roleSays = (t: Words, role: string): string => (role === 'accountant' ? t('invite.role.accountant') : t('invite.role.limited'));
const readsSays = (t: Words, role: string): string => (role === 'accountant' ? t('roles.reads.accountant') : t('roles.reads.limited'));

/** One act at a time: the steps it has reached, and how it ended; the grants are read again once it changed or may have changed them. */
function useGrantAct(onChanged: () => void): { readonly phase: ActPhase; readonly shown: Shown | null; readonly start: (run: Run) => void } {
  const { person, company } = useSession();
  const [phase, setPhase] = useState<ActPhase>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const start = (run: Run): void => {
    if (company === null || phase !== null) return;
    setShown(null);
    setPhase({ step: 0, steps: 0 });
    void run(person.id, company, (step, steps) => setPhase({ step, steps })).then((ended) => {
      setPhase(null);
      setShown(ended);
      const a = ended.acted;
      if (a.of === GRANT_ACTED.done || (a.of === GRANT_ACTED.stopped && (a.partial || a.handedOver))) onChanged();
    });
  };
  return { phase, shown, start };
}

function GrantOutcome({ phase, shown }: { phase: ActPhase; shown: Shown | null }) {
  const t = useText();
  const acted = shown?.acted ?? null;
  const done = acted?.of === GRANT_ACTED.done ? acted : null;
  const stopped = acted?.of === GRANT_ACTED.stopped ? acted : null;
  const problem = acted?.of === GRANT_ACTED.problem ? acted.problem : null;
  return (
    <ActOutcome phase={phase} refused={acted?.of === GRANT_ACTED.refused ? acted.why : null}>
      {problem === null ? null : <p className="text-sm" role="alert" data-grant-problem={problem}>{problem === 'no-code' ? t('roles.give.problem.no-code') : t('roles.give.problem.no-role')}</p>}
      {done === null ? null : (
        <ActDone data-grant-done={done.state ?? 'unknown'} next={shown?.carries == null ? undefined : <span data-grant-carries={shown.carries}>{carriesSays(t, shown.carries)}</span>}>
          {done.state === 'in-force' ? t('roles.done.in-force')
            : done.signed !== null && done.needed !== null ? t('roles.done.waiting', { signed: done.signed, needed: done.needed }) : t('roles.done.unknown')}
        </ActDone>
      )}
      {stopped === null ? null : (
        <ActStopped calm={stopped.partial || stopped.handedOver} data-grant-stopped={stopped.why}>
          <AlertDescription>{stopped.handedOver && !stopped.partial ? t('roles.sent') : WHY_SAYS(t)[stopped.why]}</AlertDescription>
          {stopped.partial ? <AlertDescription data-partial>{t('roles.partial')}</AlertDescription> : null}
        </ActStopped>
      )}
    </ActOutcome>
  );
}

function ReadersSection({ readers, busy, onTakeAway }: { readers: readonly ReaderHeld[]; busy: boolean; onTakeAway: (r: ReaderHeld) => void }) {
  const t = useText();
  return (
    <Section
      title={t('roles.readers.title')} count={readers.length} description={t('roles.readers.description')} data-readers
      empty={<EmptyState icon={UserGroupIcon}>{t('roles.readers.none')}</EmptyState>}
    >
      {readers.map((r) => (
        <SectionRow
          key={r.recipient} data-reader={r.recipient}
          actions={<Button size="sm" variant="outline" disabled={busy} data-action="take-away" onClick={() => onTakeAway(r)}>{t('roles.reader.takeAway')}</Button>}
        >
          <div className="flex min-w-0 flex-col gap-1">
            <span className="font-medium">{r.person}</span>
            <span className="text-muted-foreground" data-reader-role={r.role}>{roleSays(t, r.role)}. {readsSays(t, r.role)}</span>
          </div>
        </SectionRow>
      ))}
      {readers.length === 0 ? null : <SectionRow data-take-away-says>{t('roles.reader.takeAway.says')}</SectionRow>}
    </Section>
  );
}

function WaitingChange({ waiting, busy, onSign }: { waiting: ChangeWaiting; busy: boolean; onSign: (code: string) => void }) {
  const t = useText();
  const [code, setCode] = useState('');
  const codeId = useId();
  const one = waiting.gives.length + waiting.takesAway.length === 1;
  const give = waiting.gives[0];
  const away = waiting.takesAway[0];
  return (
    <SectionRow data-waiting-change={give !== undefined ? 'give' : 'take-away'}>
      <div className="flex min-w-0 flex-col gap-2">
        {!one ? <p data-waiting-many>{t('roles.waiting.many')}</p>
          : give !== undefined ? <p className="font-medium">{t('roles.waiting.give', { person: give.person, role: roleSays(t, give.role) })}</p>
            : <p className="font-medium">{t('roles.waiting.takeAway', { person: away!.person, role: roleSays(t, away!.role) })}</p>}
        <p className="text-sm text-muted-foreground" data-waiting-count>
          {waiting.signed === null ? t('roles.waiting.count.unread', { needed: waiting.needed }) : t('roles.waiting.count', { signed: waiting.signed, needed: waiting.needed })}
        </p>
        <p className="text-sm text-muted-foreground" data-waiting-mine={waiting.mine}>{waiting.mine ? t('roles.waiting.mine') : t('roles.waiting.notMine')}</p>
        {!one || give === undefined ? null : (
          <Field>
            <FieldLabel htmlFor={codeId}>{t('roles.waiting.code.label')}</FieldLabel>
            <Textarea id={codeId} value={code} disabled={busy} data-field="waiting-code" onChange={(e) => setCode(e.target.value)} />
            <FieldDescription data-waiting-code-hint>{t('roles.waiting.code.hint')}</FieldDescription>
          </Field>
        )}
        {!one ? null : <div><Button size="sm" disabled={busy || (give !== undefined && code.trim() === '')} data-action="sign-waiting" onClick={() => onSign(code)}>{t('roles.waiting.sign')}</Button></div>}
      </div>
    </SectionRow>
  );
}

function GiveForm({ busy, onGive }: { busy: boolean; onGive: (code: string, role: string) => void }) {
  const t = useText();
  const [code, setCode] = useState('');
  const [role, setRole] = useState<string>(READER_ROLES[0]);
  const ids = useId();
  return (
    <Section title={t('roles.give.title')} description={t('roles.give.description')} list={false} data-give-read>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); onGive(code, role); }}>
        <Field>
          <FieldLabel htmlFor={ids}>{t('roles.give.code.label')}</FieldLabel>
          <Textarea id={ids} value={code} disabled={busy} data-field="reader-code" onChange={(e) => setCode(e.target.value)} />
          <FieldDescription>{t('roles.give.code.hint')}</FieldDescription>
        </Field>
        <FieldSet disabled={busy}>
          <FieldLegend variant="label">{t('roles.give.role.label')}</FieldLegend>
          <RadioGroup value={role} onValueChange={setRole} data-field="reader-role">
            {READER_ROLES.map((r) => (
              <Field key={r} orientation="horizontal">
                <RadioGroupItem value={r} id={ids + r} disabled={busy} data-role={r} />
                <FieldContent>
                  <FieldLabel htmlFor={ids + r}>{roleSays(t, r)}</FieldLabel>
                  <FieldDescription data-role-reads={r}>{readsSays(t, r)}</FieldDescription>
                </FieldContent>
              </Field>
            ))}
          </RadioGroup>
        </FieldSet>
        <p className="text-sm text-muted-foreground">{t('roles.give.bar')}</p>
        <div><Button type="submit" disabled={busy} data-action="give-read">{t('roles.give.press')}</Button></div>
      </form>
    </Section>
  );
}

/** The link a reader opens to sign up for this company, built from the company's own id, label and contract address; nothing is shown until they are known. */
function ReaderLink() {
  const t = useText();
  const { person, company } = useSession();
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => {
    if (company === null) return undefined;
    let alive = true;
    void namedBefore(person.id, company).then((named) => {
      if (alive) setLink(typeof named === 'string' ? null : window.location.origin + addressOf(PAGE.readerSignUp, { id: company, label: named.company, account: named.account }));
    });
    return () => { alive = false; };
  }, [person.id, company]);
  if (link === null) return null;
  return (
    <Section title={t('roles.readerLink.title')} description={t('roles.readerLink.description')} list={false} data-reader-link>
      <CopyText text={link} label={t('roles.readerLink.copy')} copied={t('invite.link.copied')} refused={t('invite.link.refused')} />
    </Section>
  );
}

/** Who reads the company's records, the changes waiting for more signers, and the forms to give or take away access and to sign a waiting change. */
export function ReadAccess() {
  const t = useText();
  const { person, company } = useSession();
  const { openKeys } = useCompanyRecords();
  const [read, setRead] = useState<GrantsRead | null>(null);
  const [reads, setReads] = useState(0);
  const [opening, setOpening] = useState(false);
  const again = (): void => setReads((n) => n + 1);
  const act = useGrantAct(again);
  const busy = act.phase !== null;

  useEffect(() => (company === null ? undefined : watchPrivateMoneyReadable(company, again)), [company]);
  useEffect(() => {
    if (company === null) return undefined;
    let alive = true;
    void readGrants(person.id, company).then((r) => { if (alive) setRead(r); });
    return () => { alive = false; };
  }, [person.id, company, reads]);

  const open = async (): Promise<void> => { setOpening(true); await openKeys(); setOpening(false); again(); };
  const readNow = read?.of === GRANTS_READ.read ? read : null;
  const waiting = readNow?.waiting ?? null;
  return (
    <>
      {read?.of === GRANTS_READ.refused && read.why === ACT_REFUSAL.noKeysHere ? (
        <Alert data-roles-no-keys>
          <AlertDescription>{t('roles.noKeys')}</AlertDescription>
          <div className="mt-2"><Button size="sm" variant="outline" disabled={opening} data-action="open-with-your-wallet" onClick={() => { void open(); }}>{t('roles.noKeys.open')}</Button></div>
        </Alert>
      ) : read?.of === GRANTS_READ.refused ? <ActRefused why={read.why} /> : null}
      {read === null ? <p className="text-sm text-muted-foreground" role="status" data-roles-reading>{t('roles.reading')}</p> : null}
      {readNow === null ? null : (
        <ReadersSection
          readers={readNow.readers} busy={busy}
          onTakeAway={(r) => act.start(async (p, c, onStep) => ({ acted: await takeAwayReadAccess(p, c, r.recipient, onStep), carries: null }))}
        />
      )}
      {waiting === null ? null : (
        <Section title={t('roles.waiting.title')} description={t('roles.waiting.description')} count={1} empty={null} data-waiting-changes>
          <WaitingChange
            waiting={waiting} busy={busy}
            onSign={(code) => act.start((p, c, onStep) => approveWaitingChange(
              p, c, waiting.gives[0] === undefined ? { takeAway: waiting.takesAway[0]!.recipient } : { code, role: waiting.gives[0].role }, waiting, onStep,
            ))}
          />
        </Section>
      )}
      <ReaderLink />
      <GiveForm busy={busy} onGive={(code, role) => act.start(async (p, c, onStep) => ({ acted: await giveReadAccess(p, c, { code, role }, onStep), carries: null }))} />
      <GrantOutcome phase={act.phase} shown={act.shown} />
    </>
  );
}
