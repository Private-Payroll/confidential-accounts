import { useId, useState } from 'react';
import { Button, Input, Label, useText } from 'vaults-ui';
import { ACT_REFUSAL, ACTED } from '../adapters/refusals.js';
import { createCompany, type Created } from '../adapters/create-company.js';
import { ActRefused } from '../act-refused.js';
import { useSession } from '../session.js';
import { STEP, type StepProps } from '../setup/step-ids.js';

/**
 * CREATE A COMPANY: its name, then the company and its keys are made on this
 * device, held by the person's own wallet key, with them as its one signer.
 * This is the first press only: nothing is sent to the network, and the label
 * the wallet drew is shown, with the way to the step that finishes the company.
 * The step's one component, shown by the setup wizard, which closes this step
 * once this tab keeps the company.
 */
export function CreateCompany({ leadTo, onChanged }: StepProps) {
  const t = useText();
  const { person } = useSession();
  const nameId = useId();
  const whyId = useId();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Created | null>(null);

  const create = async (): Promise<void> => {
    setBusy(true);
    const r = await createCompany(person.id, { name: name.trim(), firstSigner: person.name === '' ? t('setup.createCompany.you') : person.name });
    setResult(r);
    if (r.of === ACTED.done) onChanged();
    setBusy(false);
  };

  const made = result?.of === ACTED.done;
  const why = made ? t('setup.createCompany.made') : name.trim() === '' ? t('setup.createCompany.nameFirst') : null;

  return (
    <div className="flex max-w-md flex-col gap-4" data-action="create-company">
      <div className="flex flex-col gap-2">
        <Label htmlFor={nameId}>{t('setup.createCompany.nameLabel')}</Label>
        <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
        <p className="text-xs text-muted-foreground">{t('setup.createCompany.nameHint')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy || why !== null} aria-describedby={why === null ? undefined : whyId} onClick={() => { void create(); }} data-action="create">
          {t('setup.createCompany.create')}
        </Button>
        {why === null ? null : <span id={whyId} className="text-sm text-muted-foreground" data-why-disabled>{why}</span>}
      </div>
      <p className="text-xs text-muted-foreground">{t('setup.createCompany.how')}</p>
      {made ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm" data-created={result.companyId}>{t('setup.createCompany.started', { label: result.label })}</p>
          <div>
            <Button variant="outline" onClick={() => leadTo(STEP.finishCompany)} data-lead-to={STEP.finishCompany}>
              {t('setup.blocked.go', { step: t('setup.step.finishCompany.name') })}
            </Button>
          </div>
        </div>
      ) : null}
      {result?.of === ACTED.refused ? (
        <div className="flex flex-col gap-2">
          <ActRefused why={result.why} />
          {result.why === ACT_REFUSAL.companyKept ? (
            <div>
              <Button variant="outline" onClick={() => leadTo(STEP.finishCompany)} data-lead-to={STEP.finishCompany}>
                {t('setup.blocked.go', { step: t('setup.step.finishCompany.name') })}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
