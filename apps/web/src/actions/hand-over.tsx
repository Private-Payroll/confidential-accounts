import { useCallback, useEffect, useState } from 'react';
import { Button, ConfirmInYourAccount, useText } from 'vaults-ui';
import { giveMyVaultKeys, handOver, signChange, type Acted } from '../adapters/hand-over.js';
import { HANDOVER, readHandover, type Handover } from '../adapters/handover-state.js';
import { ACTED } from '../adapters/refusals.js';
import { ActRefused } from '../act-refused.js';
import { useSession } from '../session.js';
import { STEP, type StepProps } from '../setup/step-ids.js';

/** What the person is being asked to confirm, if anything. */
const ASKING = { handOver: 'hand-over', change: 'change' } as const;
type Asking = (typeof ASKING)[keyof typeof ASKING];

/** What the person did here, each with the adapter that does it and the line said when it is done. */
const DID = { giveKeys: 'give-keys', handOver: 'hand-over', signChange: 'sign-change' } as const;
type Did = (typeof DID)[keyof typeof DID];
const RUN: Record<Did, (personId: string, companyId: string) => Promise<Acted>> = {
  [DID.giveKeys]: giveMyVaultKeys, [DID.handOver]: handOver, [DID.signChange]: signChange,
};
const DONE_SAYS: Record<Did, (t: ReturnType<typeof useText>) => string> = {
  [DID.giveKeys]: (t) => t('setup.handOver.done.giveKeys'),
  [DID.handOver]: (t) => t('setup.handOver.done.handOver'),
  [DID.signChange]: (t) => t('setup.handOver.done.signChange'),
};

/**
 * HAND THE COMPANY TO ITS COMMITTEE: the people who can change the rules the
 * company account and every vault follow. One component, shown by the setup
 * wizard and by the page where signers and approvals are set.
 *
 * Handing the company over is always shown; while it cannot be used it is
 * disabled and the reason is said in plain words. The other actions appear in
 * the state they answer: giving this person's vault keys, signing a change
 * owed, checking again, or leading to the step that makes the handover
 * possible.
 */
export function HandOver({ leadTo, onChanged }: StepProps) {
  const t = useText();
  const { person, company } = useSession();
  const [state, setState] = useState<Handover | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  /** What the person last did here, and how it ended. */
  const [result, setResult] = useState<{ did: Did; acted: Acted } | null>(null);

  const read = useCallback(async () => {
    setState(company === null ? null : await readHandover(person.id, company));
  }, [person.id, company]);
  useEffect(() => { void read(); }, [read]);

  const act = async (did: Did): Promise<void> => {
    if (company === null) return;
    setBusy(true); setAsking(null); setResult(null);
    setResult({ did, acted: await RUN[did](person.id, company) });
    await read();
    setBusy(false);
    onChanged();
  };

  const of = company === null ? null : state?.of ?? null;
  const canHandOver = of === HANDOVER.ready && !busy;
  const why = company === null ? t('setup.handOver.why.noCompany')
    : state === null ? t('setup.handOver.why.reading')
    : state.of === HANDOVER.notOnChain ? t('setup.handOver.why.notOnChain')
    : state.of === HANDOVER.vaultKeysMissing ? t('setup.handOver.why.vaultKeysMissing', { count: state.signers })
    : state.of === HANDOVER.tooFewApprovals ? t('setup.handOver.why.tooFewApprovals', { count: state.signers })
    : state.of === HANDOVER.held ? t('setup.handOver.why.held')
    : state.of === HANDOVER.changeOwed ? t('setup.handOver.why.changeOwed')
    : state.of === HANDOVER.waiting ? t('setup.handOver.why.waiting')
    : state.of === HANDOVER.heldByOtherKeys ? t('setup.handOver.why.heldByOtherKeys')
    : state.of === HANDOVER.unreadable ? t('setup.handOver.why.unreadable')
    : state.of === HANDOVER.unreachable ? t('setup.handOver.why.unreachable')
    : state.of === HANDOVER.notSignedIn ? t('act.refused.notSignedIn')
    : state.of === HANDOVER.anotherPerson ? t('act.refused.anotherPerson')
    : null;

  return (
    <section className="flex max-w-xl flex-col gap-4" data-action="hand-over" data-state={of ?? undefined}>
      <p className="text-sm text-muted-foreground">{t('setup.handOver.what')}</p>
      {state?.of === HANDOVER.ready ? <p className="text-sm" data-permanent>{t('setup.handOver.permanent')}</p> : null}
      {state?.of === HANDOVER.ready && state.everySignerNeeded
        ? <p className="text-sm" data-every-signer>{state.signers === 1 ? t('setup.handOver.onlySigner') : t('setup.handOver.everySigner')}</p> : null}
      {state?.of === HANDOVER.changeOwed ? (
        <ul className="text-sm" data-change-owed>
          {state.signed.map((c, i) => <li key={i}>{t('setup.handOver.signed', { have: c.have, required: c.required })}</li>)}
        </ul>
      ) : null}
      {why === null ? null : <p className="text-sm" data-why={of ?? 'no-company'}>{why}</p>}

      {asking === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!canHandOver} onClick={() => setAsking(ASKING.handOver)} data-action="hand-over-now">{t('setup.handOver.button')}</Button>
          {of === HANDOVER.vaultKeysMissing ? (
            <Button variant="outline" disabled={busy} onClick={() => { void act(DID.giveKeys); }} data-action="give-vault-keys">{t('setup.handOver.giveKeys')}</Button>
          ) : null}
          {of === HANDOVER.changeOwed ? (
            <Button variant="outline" disabled={busy} onClick={() => setAsking(ASKING.change)} data-action="sign-change">{t('setup.handOver.signChange')}</Button>
          ) : null}
          {company === null ? (
            <Button variant="outline" onClick={() => leadTo(STEP.createCompany)} data-lead-to={STEP.createCompany}>{t('setup.handOver.goCreate')}</Button>
          ) : null}
          {of === HANDOVER.tooFewApprovals ? (
            <Button variant="outline" onClick={() => leadTo(STEP.signers)} data-lead-to={STEP.signers}>{t('setup.handOver.goSigners')}</Button>
          ) : null}
          {of === HANDOVER.notOnChain || of === HANDOVER.waiting || of === HANDOVER.unreadable || of === HANDOVER.unreachable ? (
            <Button variant="outline" disabled={busy} onClick={() => { void read(); }} data-action="read-again">{t('setup.handOver.readAgain')}</Button>
          ) : null}
        </div>
      ) : (
        <ConfirmInYourAccount
          summary={asking === ASKING.handOver ? t('setup.handOver.confirmHandOver') : t('setup.handOver.confirmChange')}
          busy={busy}
          onCancel={() => setAsking(null)}
          onConfirm={() => { void act(asking === ASKING.handOver ? DID.handOver : DID.signChange); }}
        />
      )}
      {result?.acted.of === ACTED.done && state?.of !== HANDOVER.held ? <p className="text-sm" data-acted={result.did}>{DONE_SAYS[result.did](t)}</p> : null}
      {result?.acted.of === ACTED.refused ? <ActRefused why={result.acted.why} /> : null}
    </section>
  );
}
