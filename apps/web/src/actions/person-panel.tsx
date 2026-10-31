import { useId, useRef, useState, type ReactNode } from 'react';
import { Button, Field, FieldDescription, FieldLabel, Section, SectionRow, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, useText } from 'vaults-ui';
import { OPENED, READ, type PersonRow } from '../adapters/company-records.js';
import { CHANGE, changePerson, CLASSIFICATIONS, PERSON_ACT, type PersonActed, type PersonChange } from '../adapters/person-acts.js';
import { Details } from '../records/details.js';
import { CalendarDate, PaidWords, PayAmount, PayOf, StandingBadge, UnbuiltAction, useDayAsWritten, useMoment, WithRecords } from '../records/parts.js';
import { AmountInput, DATE, DateField, DayForm } from '../fields/form-fields.js';
import { useCompanyRecords } from '../records/company-records.js';
import { useSession } from '../session.js';
import { ActedSays, ActWorking, AdmitPerson, changesRecords, useAdmitBySays, useLockedSays } from './admit.js';

type Form = PersonChange['kind'];
/** The marks tests and styles find the fields of the forms that are this panel's own by; the end and leaving date forms are marked where they are drawn (`DayForm`). */
const FIELD = { leaveOn: 'leave-on', payFrom: 'pay-from', classificationFrom: 'classification-from', payAmount: 'pay-amount' } as const;

interface Phase { readonly form: Form; readonly step: number; readonly steps: number }
interface Answer { readonly form: Form; readonly acted: PersonActed }

function useClassificationSays(): Record<string, string> {
  const t = useText();
  return { [CLASSIFICATIONS[0]]: t('people.classification.full-time'), [CLASSIFICATIONS[1]]: t('people.classification.part-time') };
}

/**
 * A person's panel: what is known of them, the history their record keeps, and what can be done to them from here. The person is read
 * by their id from the company's records, and the last one read is kept while the records are read again after an act, so the panel
 * stays open and keeps what the wallet answered.
 */
export function PersonPanel({ id }: { id: string }) {
  const t = useText();
  const { company } = useCompanyRecords();
  const seen = useRef<PersonRow | null>(null);
  const belief = company?.of === OPENED.open ? company.peopleBelief : undefined;
  if (belief !== undefined && belief.of === READ.read) seen.current = belief.value.rows.find((p) => p.id === id) ?? null;
  const person = seen.current;
  if (person === null) {
    return <WithRecords>{() => <p className="text-sm text-muted-foreground" data-person-gone={id}>{t('people.panel.gone')}</p>}</WithRecords>;
  }
  return <Body person={person} reading={company === null} />;
}

function Body({ person, reading }: { person: PersonRow; reading: boolean }) {
  const t = useText();
  const { person: me, company } = useSession();
  const { reload } = useCompanyRecords();
  const [phase, setPhase] = useState<Phase | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [admittedHere, setAdmittedHere] = useState(false);
  const [draft, setDraft] = useState({
    amount: '', payFrom: '', classification: person.classification ?? '', classFrom: '', endDate: person.endDate ?? '', leavingDate: person.leavingDate ?? '', leaveOn: '',
  });
  const set = (over: Partial<typeof draft>): void => setDraft((d) => ({ ...d, ...over }));
  const busy = phase !== null || reading;
  const locked = useLockedSays();
  const changeWhy = locked.change(person.standing, person.notPayable);
  const admitWhy = locked.admit(person.standing, admittedHere);
  /* An action is never hidden: a form that does not apply is drawn disabled, with why beside it. */
  const off = busy || changeWhy !== null;

  const run = async (change: PersonChange): Promise<void> => {
    if (company === null || busy) return;
    setAnswer(null);
    setPhase({ form: change.kind, step: 0, steps: 0 });
    const ended = await changePerson(me.id, company, { id: person.id, name: person.name, asset: person.asset }, change, (step, steps) => setPhase({ form: change.kind, step, steps }));
    setPhase(null);
    setAnswer({ form: change.kind, acted: ended });
    if (changesRecords(ended)) reload();
  };
  const submit = (change: PersonChange) => (e: { preventDefault: () => void }): void => { e.preventDefault(); void run(change); };

  return (
    <div className="flex flex-col gap-4 text-sm" data-person-panel={person.id}>
      <PersonDetails person={person} />
      <History person={person} />
      {person.notPayable === null ? null : <p className="text-sm text-destructive" data-not-payable={person.id}>{t('people.panel.notPayable', { why: person.notPayable })}</p>}
      <Section title={t('people.admit.title')} list={false} box={false} data-part="admit">
        <AdmitPerson person={person} onDone={() => setAdmittedHere(true)} lockedWhy={admitWhy} />
      </Section>
      <Section title={t('people.panel.title')} list={false} box={false} data-part="change">
        {changeWhy === null ? null : <p className="text-sm text-muted-foreground" data-locked="change">{changeWhy}</p>}
        <ActWorking phase={phase} />
        {answer === null ? null : <div data-person-answer={answer.form}><ActedSays acted={answer.acted} name={person.name} act={PERSON_ACT.change} /></div>}
        <PayForm draft={draft} set={set} busy={off} onSubmit={submit({ kind: CHANGE.pay, amount: draft.amount, from: draft.payFrom })} />
        <ClassificationForm draft={draft} set={set} busy={off} onSubmit={submit({ kind: CHANGE.classification, classification: draft.classification, from: draft.classFrom })} />
        <DayForm which={DATE.endDate} label={t('people.endDate')} value={draft.endDate} busy={off} onChange={(endDate) => set({ endDate })}
          onSet={submit({ kind: CHANGE.endDate, day: draft.endDate })} onClear={() => { set({ endDate: '' }); void run({ kind: CHANGE.endDate, day: null }); }}
          setWords={t('people.change.endDateSet')} clearWords={t('people.change.endDateClear')} canClear={person.endDate !== null} />
        <DayForm which={DATE.leavingDate} label={t('people.leavingDate')} value={draft.leavingDate} busy={off} onChange={(leavingDate) => set({ leavingDate })}
          onSet={submit({ kind: CHANGE.leavingDate, day: draft.leavingDate })} onClear={() => { set({ leavingDate: '' }); void run({ kind: CHANGE.leavingDate, day: null }); }}
          setWords={t('people.change.leavingDateSet')} clearWords={t('people.change.leavingDateClear')} canClear={person.leavingDate !== null} />
        <form className="flex flex-col gap-2" data-form="leave" onSubmit={submit({ kind: CHANGE.leave, day: draft.leaveOn })}>
          <span className="font-medium">{t('people.leave.title')}</span>
          <DateField field={FIELD.leaveOn} label={t('people.leave.date')} value={draft.leaveOn} busy={off} onChange={(leaveOn) => set({ leaveOn })} />
          <div><Button type="submit" variant="outline" disabled={off} data-action="leave">{t('people.leave.button')}</Button></div>
        </form>
      </Section>
      <UnbuiltAction data-action="payslips">{t('people.payslips')}</UnbuiltAction>
    </div>
  );
}

function PayForm({ draft, set, busy, onSubmit }: { draft: { amount: string; payFrom: string }; set: (over: { amount?: string; payFrom?: string }) => void; busy: boolean; onSubmit: (e: { preventDefault: () => void }) => void }) {
  const t = useText();
  const id = useId();
  return (
    <form className="flex flex-col gap-2" data-form="pay" onSubmit={onSubmit}>
      <Field>
        <FieldLabel htmlFor={id}>{t('people.change.pay')}</FieldLabel>
        <AmountInput id={id} field={FIELD.payAmount} value={draft.amount} disabled={busy} onChange={(amount) => set({ amount })} />
        <FieldDescription>{t('people.change.pay.hint')}</FieldDescription>
      </Field>
      <DateField field={FIELD.payFrom} label={t('people.change.from')} value={draft.payFrom} busy={busy} onChange={(payFrom) => set({ payFrom })} />
      <div><Button type="submit" variant="outline" disabled={busy} data-action="change-pay">{t('people.change.payButton')}</Button></div>
    </form>
  );
}

function ClassificationForm({ draft, set, busy, onSubmit }: { draft: { classification: string; classFrom: string }; set: (over: { classification?: string; classFrom?: string }) => void; busy: boolean; onSubmit: (e: { preventDefault: () => void }) => void }) {
  const t = useText();
  const id = useId();
  const says = useClassificationSays();
  return (
    <form className="flex flex-col gap-2" data-form="classification" onSubmit={onSubmit}>
      <Field>
        <FieldLabel htmlFor={id}>{t('people.change.classificationLabel')}</FieldLabel>
        <Select value={draft.classification} onValueChange={(classification) => set({ classification })} disabled={busy}>
          <SelectTrigger id={id} data-field="classification"><SelectValue /></SelectTrigger>
          <SelectContent>{CLASSIFICATIONS.map((c) => <SelectItem key={c} value={c}>{says[c]}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <DateField field={FIELD.classificationFrom} label={t('people.change.from')} value={draft.classFrom} busy={busy} onChange={(classFrom) => set({ classFrom })} />
      <div><Button type="submit" variant="outline" disabled={busy} data-action="change-classification">{t('people.change.classificationButton')}</Button></div>
    </form>
  );
}

function PersonDetails({ person }: { person: PersonRow }) {
  const t = useText();
  const moment = useMoment();
  const says = useClassificationSays();
  const by = useAdmitBySays();
  const classified = person.classification === null ? t('people.classification.notStated') : says[person.classification];
  return (
    <Details
      rows={[
        [t('people.column.title'), person.title],
        [t('people.column.standing'), <StandingBadge standing={person.standing} />],
        [t('people.started'), <CalendarDate date={person.startedAt} />],
        [t('people.column.pay'), <PayOf person={person} />],
        [t('people.classification'), classified],
        [t('people.endDate'), <CalendarDate date={person.endDate} />],
        [t('people.leavingDate'), <CalendarDate date={person.leavingDate} />],
        [t('people.column.paid'), <PaidWords paid={person.paid} />],
        ...(person.admittedAt === null ? [] : [[t('people.admittedAt'), <time dateTime={person.admittedAt}>{moment(person.admittedAt)}</time>] as const, [t('people.admitBy'), by[person.admitBy]] as const]),
      ]}
    />
  );
}

function History({ person }: { person: PersonRow }) {
  const t = useText();
  const when = useDayAsWritten();
  const moment = useMoment();
  const says = useClassificationSays();
  const recorded = (madeAt: string | null): ReactNode => (madeAt === null ? null : <span className="text-muted-foreground"> <time dateTime={madeAt}>{t('people.history.recorded', { when: moment(madeAt) })}</time></span>);
  return (
    <Section
      title={t('people.history.title')} count={person.pays.length + person.classifications.length} data-part="history"
      empty={<p className="text-sm text-muted-foreground" data-history-nothing>{t('people.history.nothingYet')}</p>}
    >
      {person.pays.map((p, i) => (
        <SectionRow key={i} data-history="pay">
          <span>{t('people.history.pay', { date: when(p.from) })}: {p.amount === null ? t('records.unrecognisedOne') : <PayAmount amount={p.amount} paid={person.paid} />}{recorded(p.madeAt)}</span>
        </SectionRow>
      ))}
      {person.classifications.map((c, i) => (
        <SectionRow key={i} data-history="classification">
          <span>{t('people.history.classification', { kind: says[c.classification] ?? c.classification, date: when(c.from) })}{recorded(c.madeAt)}</span>
        </SectionRow>
      ))}
    </Section>
  );
}
