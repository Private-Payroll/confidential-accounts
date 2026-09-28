import { useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle, Button, Input, Label, useText } from 'vaults-ui';
import { ACTED } from '../adapters/refusals.js';
import { createCompany, finishCreating, waitingToBeFinished, type Created } from '../adapters/create-company.js';
import { ActRefused } from '../act-refused.js';
import { useSession } from '../session.js';
import type { StepProps } from '../setup/step-ids.js';

/**
 * CREATE A COMPANY: its name, then the person's account is asked for the key
 * their keys are saved under, the company is created with them as its one
 * signer, and their keys for it are saved beside the others. The step's one
 * component, shown by the setup wizard.
 *
 * A company created whose keys could not be saved is shown first, with
 * Finish, and nothing else can be started until it is: its keys are only in
 * this tab.
 */
export function CreateCompany({ onChanged }: StepProps) {
  const t = useText();
  const { person, companiesChanged } = useSession();
  const nameId = useId();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Created | null>(null);
  const waiting = waitingToBeFinished();

  const after = async (r: Created): Promise<void> => {
    setResult(r);
    if (r.of === ACTED.done) { await companiesChanged(r.companyId); onChanged(); }
  };
  const create = async (): Promise<void> => {
    setBusy(true);
    await after(await createCompany(person.id, { name: name.trim(), firstSigner: person.name === '' ? t('setup.createCompany.you') : person.name }));
    setBusy(false);
  };
  const finish = async (): Promise<void> => {
    setBusy(true);
    await after(await finishCreating());
    setBusy(false);
  };

  return (
    <section className="flex max-w-md flex-col gap-4" data-action="create-company">
      {waiting === null ? null : (
        <Alert data-waiting-to-finish>
          <AlertTitle>{t('setup.createCompany.waitingTitle')}</AlertTitle>
          <AlertDescription>{t('setup.createCompany.waitingBody')}</AlertDescription>
          <div><Button disabled={busy} onClick={() => { void finish(); }} data-action="finish-company">{t('setup.createCompany.finish')}</Button></div>
        </Alert>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor={nameId}>{t('setup.createCompany.nameLabel')}</Label>
        <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
        <p className="text-xs text-muted-foreground">{t('setup.createCompany.nameHint')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy || waiting !== null || name.trim() === ''} onClick={() => { void create(); }} data-action="create">
          {t('setup.createCompany.create')}
        </Button>
        {waiting !== null ? <span className="text-sm text-muted-foreground" data-why-disabled>{t('setup.createCompany.finishFirst')}</span>
          : name.trim() === '' ? <span className="text-sm text-muted-foreground" data-why-disabled>{t('setup.createCompany.nameFirst')}</span> : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('setup.createCompany.how')}</p>
      {result?.of === ACTED.done ? <p className="text-sm" data-created={result.companyId}>{t('setup.createCompany.created')}</p> : null}
      {result?.of === ACTED.refused ? <ActRefused why={result.why} /> : null}
    </section>
  );
}
