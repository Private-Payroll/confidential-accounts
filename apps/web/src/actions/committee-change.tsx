import { useCallback, useEffect, useState } from 'react';
import { Button, ConfirmInYourAccount, Section, SectionRow, useText } from 'vaults-ui';
import { signChange, type Acted } from '../adapters/committee-change.js';
import { HANDOVER, readHandover, type Handover } from '../adapters/handover-state.js';
import { ACTED } from '../adapters/refusals.js';
import { ActRefused } from '../act-refused.js';
import { useSession } from '../session.js';

/** What is said for each state the company can stand in when no change is owed to sign: what holds now, said plainly. */
const HOLDS: Record<Exclude<Handover['of'], typeof HANDOVER.changeOwed>, (t: ReturnType<typeof useText>) => string> = {
  [HANDOVER.notOnChain]: (t) => t('committeeChange.holds.notOnChain'),
  [HANDOVER.held]: (t) => t('committeeChange.holds.held'),
  [HANDOVER.heldByOtherKeys]: (t) => t('committeeChange.holds.heldByOtherKeys'),
  [HANDOVER.unreadable]: (t) => t('committeeChange.holds.unreadable'),
  [HANDOVER.unreachable]: (t) => t('committeeChange.holds.unreachable'),
  [HANDOVER.notSignedIn]: (t) => t('act.refused.notSignedIn'),
  [HANDOVER.anotherPerson]: (t) => t('act.refused.anotherPerson'),
};

/**
 * WHO HOLDS THE COMPANY: the super admins, whose committee holds the company
 * account and every vault. One component, shown in the panel a vault waiting
 * on its account opens and on the page where signers and approvals are set,
 * and nowhere else. It says what holds now. When the super admins have changed
 * and a vault is still held by those from before, it shows the signatures that
 * change has and needs, and offers to sign it in the person's own account.
 * Nothing of the signers is read or asked for here.
 */
export function CommitteeChange({ onChanged }: { onChanged?: () => void }) {
  const t = useText();
  const { person, company } = useSession();
  const [state, setState] = useState<Handover | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  /** How the last signing ended, if the person has signed here. */
  const [result, setResult] = useState<Acted | null>(null);

  const read = useCallback(async () => {
    setState(company === null ? null : await readHandover(person.id, company));
  }, [person.id, company]);
  useEffect(() => { void read(); }, [read]);

  const sign = async (): Promise<void> => {
    if (company === null) return;
    setBusy(true); setAsking(false); setResult(null);
    setResult(await signChange(person.id, company));
    await read();
    setBusy(false);
    onChanged?.();
  };

  const of = company === null ? null : state?.of ?? null;
  const holds = company === null ? t('committeeChange.noCompany')
    : state === null ? t('committeeChange.reading')
      : state.of === HANDOVER.changeOwed ? t('committeeChange.holds.changeOwed')
        : HOLDS[state.of](t);

  return (
    <div className="flex max-w-xl flex-col gap-4" data-action="committee-change" data-state={of ?? undefined}>
      <p className="text-sm text-muted-foreground">{t('committeeChange.what')}</p>
      {state?.of === HANDOVER.changeOwed ? (
        <Section title={t('committeeChange.signedTitle')} empty={null} data-change-owed>
          {state.signed.map((c, i) => <SectionRow key={i}>{t('committeeChange.signed', { have: c.have, required: c.required })}</SectionRow>)}
        </Section>
      ) : null}
      <p className="text-sm" data-holds={of ?? 'no-company'}>{holds}</p>

      {asking ? (
        <ConfirmInYourAccount
          summary={t('committeeChange.confirm')}
          busy={busy}
          onCancel={() => setAsking(false)}
          onConfirm={() => { void sign(); }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {of === HANDOVER.changeOwed ? (
            <Button variant="outline" disabled={busy} onClick={() => setAsking(true)} data-action="sign-change">{t('committeeChange.sign')}</Button>
          ) : null}
          {of === HANDOVER.notOnChain || of === HANDOVER.unreadable || of === HANDOVER.unreachable ? (
            <Button variant="outline" disabled={busy} onClick={() => { void read(); }} data-action="read-again">{t('committeeChange.readAgain')}</Button>
          ) : null}
        </div>
      )}
      {result?.of === ACTED.done && state?.of !== HANDOVER.held ? <p className="text-sm" data-acted="sign-change">{t('committeeChange.done')}</p> : null}
      {result?.of === ACTED.refused ? <ActRefused why={result.why} /> : null}
    </div>
  );
}
