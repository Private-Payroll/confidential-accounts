import { useId, useState } from 'react';
import { Alert, AlertDescription, Button, Field, FieldDescription, FieldLabel, Input, useText } from 'vaults-ui';
import { ADMIT_BY, STANDING, type AdmitBy, type PersonStanding } from '../adapters/company-records.js';
import { admitPerson, PERSON_ACT, PERSON_ACTED, PROBLEM, WHY, type PersonAct, type PersonActed, type PersonKind, type PersonProblem, type PersonWhy } from '../adapters/person-acts.js';
import { ActRefused } from '../act-refused.js';
import { useCompanyRecords } from '../records/company-records.js';
import { useSession } from '../session.js';

/** What the wallet's stops come to in the page's words, one for each code the adapter gives. */
function useWhySays(): Record<PersonWhy, string> {
  const t = useText();
  return {
    [WHY.notACompany]: t('people.why.not-a-company'), [WHY.noSavedKeys]: t('people.why.no-saved-keys'), [WHY.noSeat]: t('people.why.no-seat'),
    [WHY.seatNotHeld]: t('people.why.seat-not-held'), [WHY.notOnChain]: t('people.why.not-on-chain'), [WHY.rosterNotOpened]: t('people.why.roster-not-opened'),
    [WHY.notBelieved]: t('people.why.not-believed'), [WHY.notFound]: t('people.why.not-found'), [WHY.notAsShown]: t('people.why.not-as-shown'),
    [WHY.notFiled]: t('people.why.not-filed'), [WHY.fingerprintNeeded]: t('people.why.fingerprint-needed'),
    [WHY.fingerprintNotNeeded]: t('people.why.fingerprint-not-needed'), [WHY.notAdmitted]: t('people.why.not-admitted'),
    [WHY.notChanged]: t('people.why.not-changed'), [WHY.dateRaised]: t('people.why.date-raised'), [WHY.termsRaised]: t('people.why.terms-raised'), [WHY.filedNotEntered]: t('people.why.filed-not-entered'),
    [WHY.filedNotEnteredNorAnchored]: t('people.why.filed-not-entered-nor-anchored'), [WHY.askedWrongly]: t('people.why.asked-wrongly'),
    [WHY.stopped]: t('people.why.stopped'), [WHY.other]: t('people.why.other'),
  };
}

/** What a mistake in the form comes to in the page's words, for the checks made before the wallet is asked. */
export function useProblemSays(): Record<PersonProblem, string> {
  const t = useText();
  return {
    [PROBLEM.noFingerprint]: t('people.problem.no-fingerprint'), [PROBLEM.badFingerprint]: t('people.problem.bad-fingerprint'),
    [PROBLEM.noAmount]: t('people.problem.no-amount'), [PROBLEM.badAmount]: t('people.problem.bad-amount'), [PROBLEM.zeroAmount]: t('people.problem.zero-amount'),
    [PROBLEM.tooManyDecimals]: t('people.problem.too-many-decimals'), [PROBLEM.noAsset]: t('people.problem.no-asset'),
    [PROBLEM.noDate]: t('people.problem.no-date'), [PROBLEM.badDate]: t('people.problem.bad-date'), [PROBLEM.noClassification]: t('people.problem.no-classification'),
  };
}

/** How a person or vendor was admitted, in the page's words: on the fingerprint they read out, or on their wallet's signed claim. */
export function useAdmitBySays(): Record<AdmitBy, string> {
  const t = useText();
  return { [ADMIT_BY.fingerprint]: t('people.admitBy.fingerprint'), [ADMIT_BY.claim]: t('people.admitBy.claim') };
}

/**
 * WHY AN ACTION IS SHOWN DISABLED, in the page's words, for the one record whose panel is open: an action is never hidden, so a form that
 * does not apply to where somebody stands is drawn with every control disabled and this beside it. Null when the action applies. The change
 * forms apply to an active person or vendor the check will pay; the admit control to one waiting for the check, or just admitted from this panel.
 */
export function useLockedSays(): { change: (standing: PersonStanding, notPayable: string | null) => string | null; admit: (standing: PersonStanding, admittedHere: boolean) => string | null } {
  const t = useText();
  return {
    change: (standing, notPayable) => (notPayable !== null ? t('people.locked.notPayable')
      : standing === STANDING.invited ? t('people.locked.invited')
        : standing === STANDING.waitingForCheck ? t('people.locked.waitingForCheck')
          : standing === STANDING.leaver ? t('people.locked.left') : null),
    admit: (standing, admittedHere) => (admittedHere || standing === STANDING.waitingForCheck ? null
      : standing === STANDING.invited ? t('people.admit.locked.invited')
        : standing === STANDING.leaver ? t('people.admit.locked.left') : t('people.admit.locked.admitted')),
  };
}

/** True when the act went through, or went part of the way or handed over transactions before it stopped, so the records have to be read again to see how far. */
export const changesRecords = (acted: PersonActed): boolean => acted.of === PERSON_ACTED.done || (acted.of === PERSON_ACTED.stopped && (acted.partial || acted.handedOver));

/** How an act ended, in the page's words: done, a mistake in the form, the wallet's refusal, or its stop (and whether part of it may have gone through). */
export function ActedSays({ acted, name, act }: { acted: PersonActed; name: string; act: PersonAct }) {
  const t = useText();
  const whySays = useWhySays();
  const problemSays = useProblemSays();
  if (acted.of === PERSON_ACTED.done) {
    const words = act === PERSON_ACT.admit
      ? (acted.state === 'already-admitted' ? t('people.done.alreadyAdmitted', { name }) : t('people.done.admitted', { name }))
      : t('people.done.changed', { name });
    return <p className="text-sm" data-acted={act}>{words}</p>;
  }
  if (acted.of === PERSON_ACTED.problem) return <p className="text-sm text-destructive" role="alert" data-person-problem={acted.problem}>{problemSays[acted.problem]}</p>;
  if (acted.of === PERSON_ACTED.refused) return <ActRefused why={acted.why} />;
  return (
    <Alert data-person-stopped={acted.why} variant={acted.partial || acted.handedOver ? 'default' : 'destructive'}>
      <AlertDescription>{acted.handedOver && !acted.partial ? t('people.sent') : whySays[acted.why]}</AlertDescription>
      {acted.partial ? <AlertDescription data-partial>{t('people.partial')}</AlertDescription> : null}
    </Alert>
  );
}

/** The line shown while the wallet works, with the step it has come to when it says. */
export function ActWorking({ phase }: { phase: { readonly step: number; readonly steps: number } | null }) {
  const t = useText();
  if (phase === null) return null;
  return <p role="status" className="text-sm text-muted-foreground" data-working>{phase.steps > 0 ? t('people.working.step', { step: phase.step, steps: phase.steps }) : t('people.working')}</p>;
}

/**
 * Admits one person or vendor (`kind`, an employee when none is given) who accepted, which is the one control for it: a fingerprint
 * box only for one admitted on the fingerprint they read out. It keeps its own answer, so a host shows it outside what is drawn from the records (reading them again unmounts
 * that) and keeps showing it after the person is admitted; `onDone` tells the host when to.
 */
export function AdmitPerson({ person, onDone, lockedWhy = null }: {
  person: { readonly id: string; readonly name: string; readonly kind?: PersonKind; readonly admitBy: AdmitBy }; onDone?: () => void;
  /** Why the control does not apply (`useLockedSays`): it is then shown disabled with the reason, and nothing can be sent. */
  lockedWhy?: string | null;
}) {
  const t = useText();
  const field = useId();
  const { person: me, company } = useSession();
  const { reload } = useCompanyRecords();
  const [fingerprint, setFingerprint] = useState('');
  const [phase, setPhase] = useState<{ step: number; steps: number } | null>(null);
  const [acted, setActed] = useState<PersonActed | null>(null);
  const busy = phase !== null;
  const admitted = acted?.of === PERSON_ACTED.done;

  const admit = async (): Promise<void> => {
    if (company === null || busy || admitted) return;
    setActed(null);
    setPhase({ step: 0, steps: 0 });
    const ended = await admitPerson(me.id, company, { id: person.id, name: person.name, ...(person.kind === undefined ? {} : { kind: person.kind }), admitBy: person.admitBy, fingerprint }, (step, steps) => setPhase({ step, steps }));
    setPhase(null);
    setActed(ended);
    if (changesRecords(ended)) reload();
    if (ended.of === PERSON_ACTED.done) onDone?.();
  };

  if (lockedWhy !== null) {
    return (
      <div className="flex flex-col gap-3" data-admit={person.id}>
        <p className="text-sm text-muted-foreground" data-locked="admit">{lockedWhy}</p>
        <div><Button type="button" disabled data-action="admit-person">{t('people.admit.button')}</Button></div>
      </div>
    );
  }
  return (
    <form className="flex flex-col gap-3" data-admit={person.id} onSubmit={(e) => { e.preventDefault(); void admit(); }}>
      {admitted ? null : person.admitBy === ADMIT_BY.fingerprint ? (
        <Field>
          <FieldLabel htmlFor={field}>{t('people.admit.fingerprint')}</FieldLabel>
          <Input id={field} data-field="fingerprint" dir="ltr" value={fingerprint} disabled={busy} onChange={(e) => setFingerprint(e.target.value)} />
          <FieldDescription>{t('people.admit.hint')}</FieldDescription>
        </Field>
      ) : <p className="text-sm text-muted-foreground" data-admit-by={person.admitBy}>{t('people.admit.claim')}</p>}
      {admitted ? null : <div><Button type="submit" disabled={busy} data-action="admit-person">{t('people.admit.button')}</Button></div>}
      <ActWorking phase={phase} />
      {acted === null ? null : <ActedSays acted={acted} name={person.name} act={PERSON_ACT.admit} />}
    </form>
  );
}
