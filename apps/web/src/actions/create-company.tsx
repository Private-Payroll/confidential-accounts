import { useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle, Button, Input, Label, useText } from 'vaults-ui';
import { ACTED } from '../adapters/refusals.js';
import { CREATION, CREATION_WAITS, createCompany, finishCreating, waitingToBeFinished, type Created } from '../adapters/create-company.js';
import { ActRefused } from '../act-refused.js';
import { useSession } from '../session.js';
import type { StepProps } from '../setup/step-ids.js';

/**
 * CREATE A COMPANY: its name, then the company and its keys are made on this
 * device, held by the person's own wallet key from its first transaction, with
 * them as its one signer. The step's one component, shown by the setup wizard.
 *
 * A company started here and not finished is shown first, with Finish, which
 * carries it on as far as the chain allows each time it is pressed; nothing
 * else can be started until it is finished.
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
    await after(await finishCreating(person.id));
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
      {result?.of === CREATION_WAITS ? (
        <p className="text-sm" data-creation-waits={result.state}>
          {result.state === CREATION.notSent ? t('setup.createCompany.started') : t('setup.createCompany.chainWaits')}
        </p>
      ) : null}
      {result?.of === ACTED.refused ? <ActRefused why={result.why} /> : null}
    </section>
  );
}
