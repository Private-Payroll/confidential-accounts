import { useEffect, useId, useState } from 'react';
import { Alert, AlertDescription, Button, Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet, Input, RadioGroup, RadioGroupItem, Section, SectionRow, useText } from 'vaults-ui';
import {
  chooseService, SERVICE_ACTED, SERVICE_READ, SERVICE_STATE, SERVICE_WHY, readService,
  SERVICE_CHOICE, type ServiceActed, type ServiceFiler, type ServiceHeld, type ServiceWhy,
} from '../adapters/service-acts.js';
import { ACT_REFUSAL } from '../adapters/refusals.js';
import { watchPrivateMoneyReadable } from '../adapters/vault-private-money.js';
import { ActRefused } from '../act-refused.js';
import { useCompanyRecords } from '../records/company-records.js';
import { ActDone, ActOutcome, ActStopped, type ActPhase } from '../records/proposal-act.js';
import { useListSaid } from '../records/list-said.js';
import { useSession } from '../session.js';

type Words = ReturnType<typeof useText>;
type Choice = (typeof SERVICE_CHOICE)[keyof typeof SERVICE_CHOICE];

const CHOICES: readonly Choice[] = [SERVICE_CHOICE.ours, SERVICE_CHOICE.own, SERVICE_CHOICE.none];

const WHY_SAYS = (t: Words): Record<ServiceWhy, string> => ({
  [SERVICE_WHY.seat]: t('service.why.seat'), [SERVICE_WHY.notAsAsked]: t('service.why.not-as-asked'), [SERVICE_WHY.mayNotFile]: t('service.why.may-not-file'),
  [SERVICE_WHY.seatNotBelieved]: t('service.why.seat-not-believed'), [SERVICE_WHY.keyBeingChanged]: t('service.why.key-being-changed'),
  [SERVICE_WHY.filedMeanwhile]: t('service.why.filed-meanwhile'), [SERVICE_WHY.notFiled]: t('service.why.not-filed'), [SERVICE_WHY.notEntered]: t('service.why.not-entered'),
  [SERVICE_WHY.unread]: t('service.why.unread'), [SERVICE_WHY.stopped]: t('service.why.stopped'), [SERVICE_WHY.other]: t('service.why.other'),
});

const choiceSays = (t: Words, choice: { readonly service: Choice; readonly at?: string }): string => {
  switch (choice.service) {
    case 'own': return t('service.choice.own', { at: choice.at ?? '' });
    case 'none': return t('service.choice.noService');
    case 'ours': return t('service.choice.ours');
  }
};

const FORM_SAYS = (t: Words): Record<Choice, { readonly name: string; readonly says: string }> => ({
  ours: { name: t('service.form.ours'), says: t('service.form.ours.says') },
  own: { name: t('service.form.own'), says: t('service.form.own.says') },
  none: { name: t('service.form.noService'), says: t('service.form.noService.says') },
});

/** A seat as the company's directory names it: the start of its id, which is all a seat is called here. */
const seatSays = (t: Words, f: ServiceFiler): string =>
  (f.you ? t('service.asked.you', { seat: f.seat.slice(0, 8) }) : f.seat.slice(0, 8));

function Standing({ read }: { read: Extract<ServiceHeld, { of: 'read' }> }) {
  const t = useText();
  const { asked } = read;
  const listSaid = useListSaid();
  return (
    <Section title={t('service.standing.title')} description={t('service.standing.description')} list={false} data-service-standing>
      <SectionRow data-service-in-force={read.inForce.service}>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-muted-foreground">{t('service.inForce.label')}</span>
          <span className="font-medium">{choiceSays(t, read.inForce)}</span>
          {read.unchosen === null ? null : <span className="text-sm text-muted-foreground" data-service-unchosen>{asked === null ? t('service.inForce.notChosen') : t('service.inForce.notAgreed')}</span>}
        </div>
      </SectionRow>
      {asked === null || read.unchosen === null ? null : (
        <SectionRow data-service-asked={asked.choice.service}>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-muted-foreground">{t('service.asked.label')}</span>
            <span className="font-medium">{choiceSays(t, asked.choice)}</span>
            <span className="text-sm" data-service-count>{t('service.asked.count', { filed: asked.filers.length, needed: asked.needed })}</span>
            <span className="text-sm text-muted-foreground" data-service-filers>{t('service.asked.filers')}: {listSaid(asked.filers.map((f) => seatSays(t, f)))}</span>
          </div>
        </SectionRow>
      )}
    </Section>
  );
}

function FileForm({ busy, again, onFile }: { busy: boolean; again: boolean; onFile: (choice: Choice, at: string) => void }) {
  const t = useText();
  const [choice, setChoice] = useState<Choice>(SERVICE_CHOICE.ours);
  const [at, setAt] = useState('');
  const ids = useId();
  return (
    <Section title={t('service.form.title')} description={t('service.form.description')} list={false} data-service-form>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); onFile(choice, at.trim()); }}>
        <FieldSet disabled={busy}>
          <FieldLegend variant="label">{t('service.form.legend')}</FieldLegend>
          <RadioGroup value={choice} onValueChange={(v) => setChoice(v as Choice)} data-field="service-choice">
            {CHOICES.map((c) => (
              <Field key={c} orientation="horizontal">
                <RadioGroupItem value={c} id={ids + c} disabled={busy} data-choice={c} />
                <FieldContent>
                  <FieldLabel htmlFor={ids + c}>{FORM_SAYS(t)[c].name}</FieldLabel>
                  <FieldDescription>{FORM_SAYS(t)[c].says}</FieldDescription>
                </FieldContent>
              </Field>
            ))}
          </RadioGroup>
        </FieldSet>
        {choice !== 'own' ? null : (
          <Field>
            <FieldLabel htmlFor={ids}>{t('service.form.address.label')}</FieldLabel>
            <Input id={ids} dir="ltr" value={at} disabled={busy} data-field="service-address" onChange={(e) => setAt(e.target.value)} />
            <FieldDescription>{t('service.form.address.hint')}</FieldDescription>
          </Field>
        )}
        <div><Button type="submit" disabled={busy} data-action={again ? 'file-again' : 'file-choice'}>{again ? t('service.form.again') : t('service.form.press')}</Button></div>
      </form>
    </Section>
  );
}

function Outcome({ phase, acted }: { phase: ActPhase; acted: ServiceActed | null }) {
  const t = useText();
  const done = acted?.of === SERVICE_ACTED.done ? acted : null;
  const stopped = acted?.of === SERVICE_ACTED.stopped ? acted : null;
  const problem = acted?.of === SERVICE_ACTED.problem ? acted.problem : null;
  return (
    <ActOutcome phase={phase} refused={acted?.of === SERVICE_ACTED.refused ? acted.why : null}>
      {problem === null ? null : <p className="text-sm" role="alert" data-service-problem={problem}>{problem === 'not-an-address' ? t('service.problem.not-an-address') : t('service.problem.not-a-choice')}</p>}
      {done === null ? null : (
        <ActDone data-service-done={done.state ?? 'unknown'} next={t('service.done.reread')}>
          {done.state === SERVICE_STATE.inForce ? t('service.done.in-force')
            : done.filed !== null && done.needed !== null ? t('service.done.waiting', { filed: done.filed, needed: done.needed }) : t('service.done.unknown')}
        </ActDone>
      )}
      {stopped === null ? null : (
        <ActStopped calm={stopped.partial || stopped.handedOver} data-service-stopped={stopped.why}>
          <AlertDescription>{stopped.handedOver && !stopped.partial ? t('service.sent') : WHY_SAYS(t)[stopped.why]}</AlertDescription>
          {stopped.partial ? <AlertDescription data-partial>{t('service.partial')}</AlertDescription> : null}
        </ActStopped>
      )}
    </ActOutcome>
  );
}

/** The Service tab of Settings: the company's choice of service as the company's records say it, who has filed it, filing it, and the providers to come. */
export function Service() {
  const t = useText();
  const { person, company } = useSession();
  const { openKeys } = useCompanyRecords();
  const [read, setRead] = useState<ServiceHeld | null>(null);
  const [reads, setReads] = useState(0);
  const [phase, setPhase] = useState<ActPhase>(null);
  const [acted, setActed] = useState<ServiceActed | null>(null);
  const [opening, setOpening] = useState(false);
  const again = (): void => setReads((n) => n + 1);
  const busy = phase !== null;

  useEffect(() => (company === null ? undefined : watchPrivateMoneyReadable(company, again)), [company]);
  useEffect(() => {
    if (company === null) return undefined;
    let alive = true;
    void readService(person.id, company).then((r) => { if (alive) setRead(r); });
    return () => { alive = false; };
  }, [person.id, company, reads]);

  const open = async (): Promise<void> => { setOpening(true); await openKeys(); setOpening(false); again(); };
  const file = (choice: Choice, at: string): void => {
    if (company === null || busy) return;
    setActed(null);
    setPhase({ step: 0, steps: 0 });
    void chooseService(person.id, company, choice === SERVICE_CHOICE.own ? { service: SERVICE_CHOICE.own, at } : { service: choice }, (step, steps) => setPhase({ step, steps })).then((ended) => {
      setPhase(null);
      setActed(ended);
      if (ended.of === SERVICE_ACTED.done || (ended.of === SERVICE_ACTED.stopped && (ended.partial || ended.handedOver))) again();
    });
  };

  const unread = read?.of === SERVICE_READ.unread ? read : null;
  const canFile = read?.of === SERVICE_READ.read || unread?.canFileOver === true;
  return (
    <div className="flex flex-col gap-6" data-screen="service">
      <p className="text-sm text-muted-foreground">{t('service.intro')}</p>
      {read?.of === SERVICE_READ.refused && read.why === ACT_REFUSAL.noKeysHere ? (
        <Alert data-service-no-keys>
          <AlertDescription>{t('service.noKeys')}</AlertDescription>
          <div className="mt-2"><Button size="sm" variant="outline" disabled={opening} data-action="open-with-your-wallet" onClick={() => { void open(); }}>{t('service.noKeys.open')}</Button></div>
        </Alert>
      ) : read?.of === SERVICE_READ.refused ? <ActRefused why={read.why} /> : null}
      {read === null ? <p className="text-sm text-muted-foreground" role="status" data-service-reading>{t('service.reading')}</p> : null}
      {read?.of === SERVICE_READ.read ? <Standing read={read} /> : null}
      {unread === null ? null : (
        <Alert data-service-unread={unread.canFileOver ? 'may-file-over' : 'cannot-file-over'}>
          <AlertDescription>{unread.canFileOver ? t('service.unread') : t('service.unread.cannot')}</AlertDescription>
        </Alert>
      )}
      {canFile ? <FileForm busy={busy} again={unread !== null} onFile={file} /> : null}
      <Outcome phase={phase} acted={acted} />
      <Section title={t('service.providers.title')} description={t('service.providers.description')} list={false} data-service-providers>
        <SectionRow><span className="text-muted-foreground" data-coming-soon>{t('service.providers.soon')}</span></SectionRow>
      </Section>
    </div>
  );
}
