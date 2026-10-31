import { useId, useRef, useState } from 'react';
import { Button, Section, useText } from 'vaults-ui';
import { OPENED, READ, type VendorRow } from '../adapters/company-records.js';
import { FIELD, payAssets, TERMS } from '../adapters/invite.js';
import { changeVendor, PERSON_ACT, PERSON_ACTED, PERSON_KIND, VENDOR_CHANGE, type PersonActed, type VendorChange } from '../adapters/person-acts.js';
import { Details } from '../records/details.js';
import { CalendarDate, PaidWords, StandingBadge, TermsOf, useMoment, WithRecords } from '../records/parts.js';
import { useCompanyRecords } from '../records/company-records.js';
import { useSession } from '../session.js';
import { DATE, DayForm, TermsChoice } from '../fields/form-fields.js';
import { ActedSays, ActWorking, AdmitPerson, changesRecords, useAdmitBySays, useLockedSays, useProblemSays } from './admit.js';

type Form = VendorChange['kind'];
interface Phase { readonly form: Form; readonly step: number; readonly steps: number }
interface Answer { readonly form: Form; readonly acted: PersonActed }
interface Draft { terms: string; asset: string; amount: string; endDate: string }

/**
 * A vendor's panel: what is known of them and what can be done to them from here. The vendor is read by their id from the company's
 * records, and the last one read is kept while the records are read again after an act, so the panel stays open and keeps what the
 * wallet answered. A vendor this device will not pay is shown with why, and every form is drawn disabled, as one who has not been
 * admitted yet or has left is: an action is never hidden.
 */
export function VendorPanel({ id }: { id: string }) {
  const t = useText();
  const { company } = useCompanyRecords();
  const seen = useRef<VendorRow | null>(null);
  const belief = company?.of === OPENED.open ? company.vendorsBelief : undefined;
  if (belief !== undefined && belief.of === READ.read) seen.current = belief.value.rows.find((v) => v.id === id) ?? null;
  const vendor = seen.current;
  if (vendor === null) {
    return <WithRecords>{() => <p className="text-sm text-muted-foreground" data-vendor-gone={id}>{t('vendors.panel.gone')}</p>}</WithRecords>;
  }
  return <Body vendor={vendor} reading={company === null} />;
}

function Body({ vendor, reading }: { vendor: VendorRow; reading: boolean }) {
  const t = useText();
  const { person: me, company } = useSession();
  const { reload } = useCompanyRecords();
  const ids = { amount: useId(), asset: useId() };
  const problemSays = useProblemSays();
  const locked = useLockedSays();
  const [phase, setPhase] = useState<Phase | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [admittedHere, setAdmittedHere] = useState(false);
  const [draft, setDraft] = useState<Draft>({ terms: vendor.termsKind, asset: vendor.asset ?? payAssets()[0]?.code ?? '', amount: '', endDate: vendor.endDate ?? '' });
  const set = (over: Partial<Draft>): void => setDraft((d) => ({ ...d, ...over }));
  const busy = phase !== null || reading;
  const changeWhy = locked.change(vendor.standing, vendor.notPayable);
  const admitWhy = locked.admit(vendor.standing, admittedHere);
  /* An action is never hidden: a form that does not apply is drawn disabled, with why beside it. */
  const off = busy || changeWhy !== null;
  /* A mistake in the terms form is told beside the amount it is about, as the invite form tells it, and not in a line apart. */
  const problem = answer !== null && answer.form === VENDOR_CHANGE.terms && answer.acted.of === PERSON_ACTED.problem ? problemSays[answer.acted.problem] : null;

  const run = async (change: VendorChange): Promise<void> => {
    if (company === null || busy) return;
    setAnswer(null);
    setPhase({ form: change.kind, step: 0, steps: 0 });
    const ended = await changeVendor(me.id, company, { id: vendor.id, name: vendor.name }, change, (step, steps) => setPhase({ form: change.kind, step, steps }));
    setPhase(null);
    setAnswer({ form: change.kind, acted: ended });
    if (changesRecords(ended)) reload();
  };
  const submit = (change: VendorChange) => (e: { preventDefault: () => void }): void => { e.preventDefault(); void run(change); };
  const termsChange = (): VendorChange => (draft.terms === TERMS.monthly
    ? { kind: VENDOR_CHANGE.terms, terms: TERMS.monthly, asset: draft.asset, amount: draft.amount }
    : { kind: VENDOR_CHANGE.terms, terms: TERMS.oneOff });

  return (
    <div className="flex flex-col gap-4 text-sm" data-vendor-panel={vendor.id}>
      <VendorDetails vendor={vendor} />
      {vendor.notPayable === null ? null : <p className="text-sm text-destructive" data-not-payable={vendor.id}>{t('vendors.panel.notPayable', { why: vendor.notPayable })}</p>}
      <Section title={t('people.admit.title')} list={false} box={false} data-part="admit">
        <AdmitPerson person={{ id: vendor.id, name: vendor.name, kind: PERSON_KIND.vendor, admitBy: vendor.admitBy }} onDone={() => setAdmittedHere(true)} lockedWhy={admitWhy} />
      </Section>
      <Section title={t('people.panel.title')} list={false} box={false} data-part="change">
        {changeWhy === null ? null : <p className="text-sm text-muted-foreground" data-locked="change">{changeWhy}</p>}
        <ActWorking phase={phase} />
        {answer === null || problem !== null ? null : <div data-vendor-answer={answer.form}><ActedSays acted={answer.acted} name={vendor.name} act={PERSON_ACT.change} /></div>}
        <form className="flex flex-col gap-2" data-form="terms" onSubmit={submit(termsChange())}>
          <TermsChoice terms={draft.terms} onTerms={(terms) => set({ terms })} idAmount={ids.amount} idAsset={ids.asset} asset={draft.asset} amount={draft.amount} locked={off}
            amountField={FIELD.termsAmount} assetField={FIELD.termsAsset} problem={problem} onAsset={(asset) => set({ asset })} onAmount={(amount) => set({ amount })} />
          <div><Button type="submit" variant="outline" disabled={off} data-action="change-terms">{t('vendors.change.termsButton')}</Button></div>
        </form>
        <DayForm which={DATE.endDate} label={t('people.endDate')} value={draft.endDate} busy={off} onChange={(endDate) => set({ endDate })}
          onSet={submit({ kind: VENDOR_CHANGE.endDate, day: draft.endDate })} onClear={() => { set({ endDate: '' }); void run({ kind: VENDOR_CHANGE.endDate, day: null }); }}
          setWords={t('people.change.endDateSet')} clearWords={t('people.change.endDateClear')} canClear={vendor.endDate !== null} />
      </Section>
    </div>
  );
}

function VendorDetails({ vendor }: { vendor: VendorRow }) {
  const t = useText();
  const moment = useMoment();
  const admitBySays = useAdmitBySays();
  return (
    <Details
      rows={[
        [t('people.column.standing'), <StandingBadge standing={vendor.standing} />],
        [t('vendors.column.terms'), <TermsOf vendor={vendor} />],
        [t('people.started'), <CalendarDate date={vendor.startedAt} />],
        [t('people.endDate'), <CalendarDate date={vendor.endDate} />],
        [t('people.column.paid'), <PaidWords paid={vendor.paid} />],
        ...(vendor.admittedAt === null ? [] : [
          [t('people.admittedAt'), <time dateTime={vendor.admittedAt}>{moment(vendor.admittedAt)}</time>] as const,
          [t('people.admitBy'), admitBySays[vendor.admitBy]] as const,
        ]),
      ]}
    />
  );
}
