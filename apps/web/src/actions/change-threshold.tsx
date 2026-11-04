import { useId, useState } from 'react';
import { Alert, AlertDescription, Button, FieldDescription, FieldError, FieldLegend, FieldSet, useText } from 'vaults-ui';
import { changeThreshold, THRESHOLD_ACTED, THRESHOLD_PROBLEM, type ThresholdActed, type ThresholdProblem } from '../adapters/proposal-acts.js';
import { OPENED, READ } from '../adapters/reads.js';
import { ActedSays, type ActPhase } from '../records/proposal-act.js';
import { useCompanyRecords } from '../records/company-records.js';
import { PanelFooter } from '../shell/right-panel.js';
import { useSession } from '../session.js';

type Asked = { readonly wanted: number; readonly acted: ThresholdActed };

/**
 * CHANGE THE APPROVALS: the one control, drawn on the signers page, in the setup step for signers, in the panel the Create menu
 * opens, and, with `vault`, in the panel a vault's own page opens for that one vault's approvals. It starts at the number in
 * force (the company's, or the vault's own as the chain holds it) and asks for nothing until another is chosen; it steps no lower
 * than one and no higher than the signers the company seats; the page tells a number it can see the wallet would refuse before the
 * wallet window opens, and the wallet checks every vault again. Under the number it says why. For the company it cannot say which
 * vault would be left short (the wallet's refusal carries no vault), so it says the wallet checks every vault. For a vault it names
 * that vault and its number, and says the wallet checks the rest. A vault whose number was not read is not changed from here.
 * Where it is drawn under the page's records, a records reload empties them and unmounts it with its result: the vault page
 * therefore draws it in the shell's panel.
 */
export function ChangeThreshold({ onChanged, vault }: { onChanged?: () => void; vault?: string }) {
  const t = useText();
  const { person, company: companyId } = useSession();
  const { company, reload } = useCompanyRecords();
  const formId = useId();
  const [chosen, setChosen] = useState<number | null>(null);
  const [phase, setPhase] = useState<ActPhase>(null);
  const [asked, setAsked] = useState<Asked | null>(null);
  const open = company?.of === OPENED.open ? company : null;
  const vaultsRead = open?.vaults;
  const vaultRows = vaultsRead?.of === READ.read ? vaultsRead.value : null;
  const vaultAt = vault === undefined || vaultRows === null ? -1 : vaultRows.findIndex((v) => v.vault.toLowerCase() === vault.toLowerCase());
  const vaultName = vaultAt < 0 ? null : t('vaults.tile.name', { number: vaultAt + 1 });
  const nowRead = open?.approvalsNeeded;
  const now = vault !== undefined ? (vaultAt < 0 ? null : vaultRows?.[vaultAt]?.approvals ?? null) : nowRead?.of === READ.read ? nowRead.value : null;
  const seatsRead = open?.approvalsForSigners;
  const seatedRead = seatsRead?.of === READ.read ? seatsRead.value.seated : null;
  const seated = typeof seatedRead === 'number' ? seatedRead : null;
  const busy = phase !== null;
  const readable = now !== null && seated !== null;
  const from = chosen ?? now ?? 1;
  const canMore = readable && from < seated;
  const canFewer = readable && from > 1;
  const shown = chosen !== null ? t('changeThreshold.value', { count: chosen }) : now === null ? '' : t('changeThreshold.keeps', { count: now });

  const raise = async (): Promise<void> => {
    if (companyId === null || busy || chosen === null) return;
    setAsked(null);
    setPhase({ step: 0, steps: 0 });
    const acted = await changeThreshold(person.id, companyId, chosen, { now, seated }, (step, steps) => setPhase({ step, steps }), vault);
    setPhase(null);
    setAsked({ wanted: chosen, acted });
    const wentThrough = acted.of === THRESHOLD_ACTED.done || (acted.of === THRESHOLD_ACTED.stopped && (acted.partial || acted.handedOver));
    if (!wentThrough) return;
    if (acted.of === THRESHOLD_ACTED.done) setChosen(null);
    if (onChanged === undefined) reload(); else onChanged();
  };

  return (
    <form id={formId} className="flex max-w-xl flex-col gap-4 text-sm" data-action="change-threshold" onSubmit={(e) => { e.preventDefault(); void raise(); }}>
      <FieldSet disabled={busy}>
        <FieldLegend variant="label">{vault === undefined ? t('changeThreshold.label') : t('changeThreshold.vault.label')}</FieldLegend>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy || !canFewer} aria-label={t('changeThreshold.fewer')} data-action="threshold-fewer" onClick={() => setChosen(Math.max(from - 1, 1))}>-</Button>
          <span className="min-w-32 text-center" data-change-threshold-value>{shown}</span>
          <Button type="button" size="sm" variant="outline" disabled={busy || !canMore} aria-label={t('changeThreshold.more')} data-action="threshold-more" onClick={() => setChosen(Math.min(from + 1, seated ?? from))}>+</Button>
          {chosen === null ? null : <Button type="button" size="sm" variant="ghost" disabled={busy} data-action="threshold-keep" onClick={() => setChosen(null)}>{t('changeThreshold.keep')}</Button>}
        </div>
        {seated === null ? null : <FieldDescription data-change-threshold-hint>{t('changeThreshold.hint', { count: seated })}</FieldDescription>}
        {readable ? null : <FieldError data-change-threshold-unread>{vault === undefined ? t('changeThreshold.unread') : t('changeThreshold.vault.unread')}</FieldError>}
      </FieldSet>
      {now === null ? null : <p className="text-muted-foreground" data-needed-because>{vaultName === null ? t('changeThreshold.because', { count: now }) : t('changeThreshold.vault.because', { count: now, vault: vaultName })}</p>}
      {vault !== undefined ? null : <p className="text-muted-foreground" data-checks-every-vault>{t('changeThreshold.checks')}</p>}
      <p className="text-muted-foreground">{t('changeThreshold.walletNote')}</p>
      <PanelFooter>
        <div className="flex flex-col gap-4">
          <div>
            <Button type="submit" form={formId} disabled={busy || companyId === null || chosen === null || chosen === now} data-action="raise-threshold">{t('changeThreshold.raise')}</Button>
          </div>
          <Result phase={phase} asked={asked} vaultName={vaultName} />
        </div>
      </PanelFooter>
    </form>
  );
}

function Result({ phase, asked, vaultName }: { phase: ActPhase; asked: Asked | null; vaultName: string | null }) {
  const t = useText();
  const problems: Record<ThresholdProblem, (most: number) => string> = {
    [THRESHOLD_PROBLEM.notWhole]: () => t('changeThreshold.problem.not-whole'),
    [THRESHOLD_PROBLEM.tooHigh]: (most) => t('changeThreshold.problem.too-high', { count: most }),
    [THRESHOLD_PROBLEM.same]: () => (vaultName === null ? t('changeThreshold.problem.same') : t('changeThreshold.vault.problem.same', { vault: vaultName })),
    [THRESHOLD_PROBLEM.unread]: () => t('changeThreshold.problem.unread'),
  };
  const acted = asked?.acted ?? null;
  if (acted !== null && acted.of === THRESHOLD_ACTED.problem) return <FieldError data-problem={acted.problem}>{problems[acted.problem](acted.most ?? 0)}</FieldError>;
  if (acted !== null && acted.of === THRESHOLD_ACTED.walletRefused) {
    return <Alert variant="destructive" data-wallet-refused><AlertDescription>{t('changeThreshold.refused')}</AlertDescription></Alert>;
  }
  const shown = acted !== null && (acted.of === THRESHOLD_ACTED.done || acted.of === THRESHOLD_ACTED.stopped || acted.of === THRESHOLD_ACTED.refused) ? acted : null;
  const done = shown?.of === THRESHOLD_ACTED.done && shown.state === 'carried-out'
    ? (vaultName === null ? t('changeThreshold.done.carried', { count: asked?.wanted ?? 0 }) : t('changeThreshold.vault.done.carried', { count: asked?.wanted ?? 0, vault: vaultName }))
    : (vaultName === null ? t('changeThreshold.done.waiting', { page: t('page.proposals.name') }) : t('changeThreshold.vault.done.waiting', { page: t('page.proposals.name'), vault: vaultName }));
  return <ActedSays phase={phase} result={shown} done={done} />;
}
