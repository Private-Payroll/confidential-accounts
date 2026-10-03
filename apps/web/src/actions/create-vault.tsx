import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle, Button, ConfirmInYourAccount, useText } from 'vaults-ui';
import {
  CREATING, createVault, finishHandingOver, giveYourVaultKeys, openYourKeys, OWED, READY, readOwedVaults, readVaultReadiness, STARTING,
  STOPPED, type Creating, type OwedVault, type Readiness, type StartStopped, type VaultCreated,
} from '../adapters/create-vault.js';
import { HANDOVER, readHandover } from '../adapters/handover-state.js';
import { ACTED, type ActRefusal } from '../adapters/refusals.js';
import { ActRefused } from '../act-refused.js';
import { useSession } from '../session.js';
import { STEP, type StepProps } from '../setup/step-ids.js';

/** What resolves a set-up that stopped before its secret was approved, in the person's own words. */
function useStoppedSays(): (stopped: StartStopped) => string {
  const t = useText();
  const says: Record<StartStopped, string> = {
    [STOPPED.wallet]: t('createVault.stopped.wallet'),
    [STOPPED.handOver]: t('createVault.stopped.handOver'),
    [STOPPED.vault]: t('createVault.stopped.vault'),
    [STOPPED.signers]: t('createVault.stopped.signers'),
    [STOPPED.mismatch]: t('createVault.stopped.mismatch'),
  };
  return (stopped) => says[stopped];
}

/** What the person is being asked to confirm, if anything: creating a vault, finishing the handover of the one named, or finishing setting it up. */
const ASKING = { create: 'create', finish: 'finish', start: 'start' } as const;
type Asking = { of: typeof ASKING.create } | { of: typeof ASKING.finish | typeof ASKING.start; vault: string };

/**
 * THE ONE ACTION THAT RESOLVES WHERE A SET-UP STOPPED. Waiting for approvals,
 * or stopped for the wallet or the signers, it is to finish setting it up. The
 * company not yet held by its signers leads to handing it over. The vault not
 * held by the signers as they stand now is finished handing over from the
 * device that holds its key; when it is waiting on another device nothing here
 * resolves it, so nothing is offered; when it was handed over, it leads to the
 * change the signers sign. Signers' keys that do not match offer nothing:
 * pressing again would stop the same way.
 */
function StopResolvedBy({ result, owed, disabled, ask, leadTo }: {
  result: Extract<VaultCreated, { of: typeof STARTING.owed | typeof STARTING.awaiting }>;
  owed: OwedVault | undefined; disabled: boolean; ask: (a: Asking) => void; leadTo: StepProps['leadTo'];
}) {
  const t = useText();
  const stopped = result.of === STARTING.owed ? result.stopped : undefined;
  if (stopped === STOPPED.mismatch || (stopped === STOPPED.vault && owed !== undefined && !owed.here)) return null;
  if (stopped === STOPPED.handOver || (stopped === STOPPED.vault && owed === undefined)) {
    return (
      <div>
        <Button variant="outline" disabled={disabled} onClick={() => leadTo(STEP.handOver)} data-lead-to={STEP.handOver}>
          {stopped === STOPPED.handOver ? t('createVault.goHandOver') : t('createVault.goSignChange')}
        </Button>
      </div>
    );
  }
  if (stopped === STOPPED.vault) {
    return (
      <div>
        <Button variant="outline" disabled={disabled} onClick={() => ask({ of: ASKING.finish, vault: result.vault })} data-action="finish-handover">{t('createVault.finish')}</Button>
      </div>
    );
  }
  return (
    <div>
      <Button variant="outline" disabled={disabled} onClick={() => ask({ of: ASKING.start, vault: result.vault })} data-action="finish-start">{t('createVault.finishStart')}</Button>
    </div>
  );
}

/**
 * CREATE A VAULT: built and proved on this device, sent, and handed to the
 * company's signers as soon as the network has it. One component, shown by
 * the setup wizard's vault step and in the right-hand panel the Vaults page
 * and a vault's page open.
 *
 * Create a vault is always shown; while it cannot be used it is disabled and
 * the reason is said in plain words. A person who has not given their vault
 * keys gives them here; the step that makes creating possible is led to
 * only for a company not created yet. A vault sent and not yet held by the
 * signers is named, with Finish handing it over, because this app puts no
 * money into it until then; on a device that does not hold the key it was
 * created with, Finish is shown disabled, with why. With `finishing`, the
 * component opens asking to finish handing over that vault, once it is read
 * as one this device can finish.
 *
 * Once the signers hold it, the vault is set up: it is added to the company's
 * account, its private records are made and its secret set, and each signer
 * is given a sealed copy. Each step is said as it happens. A step that waits
 * for other signers' approvals is named with how many it has and needs, and
 * says each of them approves it from their own device; a set up that stopped
 * is said as that, with what resolves it when it stopped at the check of who
 * the vault's secret is sealed to, and offers the one action that resolves
 * where it stopped (`StopResolvedBy`). With `starting` the component opens
 * once, after the company is read, asking to carry that vault on, which any
 * signer can do from their own device; until the set up is done, this app
 * puts no money into the vault.
 */
export function CreateVault({ leadTo, onChanged, finishing, starting }: StepProps & { finishing?: string; starting?: string }) {
  const t = useText();
  const stoppedSays = useStoppedSays();
  const { person, company } = useSession();
  const [ready, setReady] = useState<Readiness | null>(null);
  /* Each vault sent and not yet held by the signers, with its number among the company's vaults, as its tile names it. */
  const [owed, setOwed] = useState<readonly OwedVault[]>([]);
  const [opening, setOpening] = useState<ActRefusal | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [stage, setStage] = useState<Creating | null>(null);
  const [result, setResult] = useState<VaultCreated | null>(null);
  /* Whether the company was read as held by its signers as they stand now, once a vault was created: only then is the line on putting money in left out. */
  const [handedOver, setHandedOver] = useState(false);
  /* Whether this person's vault keys were just given here, or why not. */
  const [gave, setGave] = useState<typeof ACTED.done | ActRefusal | null>(null);

  const read = useCallback(async () => {
    if (company === null) { setReady(null); setOwed([]); return; }
    const [r, o] = await Promise.all([readVaultReadiness(person.id, company), readOwedVaults(person.id, company)]);
    setReady(r);
    setOwed(o);
  }, [person.id, company]);
  useEffect(() => { void read(); }, [read]);
  /* Asked to carry on setting up one vault, from this signer's own device: asked once, once the company has been read. */
  const askedToStart = useRef<string | null>(null);
  useEffect(() => {
    if (starting === undefined || ready === null || asking !== null || askedToStart.current === starting) return;
    askedToStart.current = starting;
    setAsking({ of: ASKING.start, vault: starting });
  }, [starting, ready, asking]);
  /* Asked to finish one vault: asked as soon as it is read as sent, not held, and finishable from this browser. */
  useEffect(() => {
    if (finishing !== undefined && owed.some((o) => o.vault === finishing && o.here)) setAsking((a) => a ?? { of: ASKING.finish, vault: finishing });
  }, [finishing, owed]);

  const busy = stage !== null;
  const act = async (asked: Asking): Promise<void> => {
    if (company === null) return;
    setAsking(null); setResult(null); setStage(CREATING.checking);
    const r = asked.of === ASKING.create
      ? await createVault(person.id, company, setStage)
      : await finishHandingOver(person.id, company, asked.vault, setStage);
    const handover = r.of === ACTED.done ? await readHandover(person.id, company) : null;
    setHandedOver(handover?.of === HANDOVER.held);
    setResult(r);
    setStage(null);
    await read();
    onChanged();
  };

  const openKeys = async (): Promise<void> => {
    setOpening(null);
    const r = await openYourKeys(person.id);
    setOpening(r.of === ACTED.refused ? r.why : null);
    await read();
  };

  const giveKeys = async (): Promise<void> => {
    if (company === null) return;
    setGave(null);
    const r = await giveYourVaultKeys(person.id, company);
    setGave(r.of === ACTED.refused ? r.why : ACTED.done);
    await read();
    onChanged();
  };

  const canCreate = company !== null && ready?.of === READY.ready && !busy;
  const why = company === null ? t('createVault.why.noCompany')
    : ready === null ? t('createVault.why.reading')
    : ready.of === READY.yoursMissing ? t('createVault.why.yoursMissing')
    : ready.of === READY.othersMissing ? t('createVault.why.othersMissing')
    : ready.of === READY.rosterDisagrees ? t('createVault.why.rosterDisagrees')
    : ready.of === READY.notOnChain ? t('createVault.why.notOnChain')
    : ready.of === READY.locked ? t('createVault.why.locked')
    : null;
  const STAGE_SAYS: Record<Creating, string> = {
    [CREATING.checking]: t('createVault.stage.checking'),
    [CREATING.building]: t('createVault.stage.building'),
    [CREATING.sending]: t('createVault.stage.sending'),
    [CREATING.waitingForChain]: t('createVault.stage.waitingForChain'),
    [CREATING.handingOver]: t('createVault.stage.handingOver'),
    [CREATING.waitingForHandover]: t('createVault.stage.waitingForHandover'),
    [CREATING.adopting]: t('createVault.stage.adopting'),
    [CREATING.openingThePool]: t('createVault.stage.openingThePool'),
    [CREATING.readingTheSecretBack]: t('createVault.stage.readingTheSecretBack'),
    [CREATING.settingTheSecret]: t('createVault.stage.settingTheSecret'),
    [CREATING.writingTheCopies]: t('createVault.stage.writingTheCopies'),
    [CREATING.waitingForApprovals]: t('createVault.stage.waitingForApprovals'),
    [CREATING.done]: t('createVault.stage.done'),
  };

  return (
    <div className="flex max-w-xl flex-col gap-4" data-action="create-vault" data-state={ready?.of ?? undefined}>
      <p className="text-sm text-muted-foreground">{t('createVault.what')}</p>
      {owed.map(({ vault, number, here }) => (
        <Alert key={vault} data-owed={vault} data-here={here ? '' : undefined}>
          <AlertTitle>{t('createVault.owed.title', { number })}</AlertTitle>
          <AlertDescription>{here ? t('createVault.owed.body') : t('createVault.owed.notHere')}</AlertDescription>
          <div><Button variant="outline" disabled={!here || busy || asking !== null} onClick={() => setAsking({ of: ASKING.finish, vault })} data-action="finish-handover">{t('createVault.finish')}</Button></div>
        </Alert>
      ))}
      {why === null ? null : <p className="text-sm" data-why={ready?.of ?? 'no-company'}>{why}</p>}
      {ready?.of === ACTED.refused ? <ActRefused why={ready.why} /> : null}

      {asking === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!canCreate || busy} onClick={() => setAsking({ of: ASKING.create })} data-action="create-vault-now">{t('vaults.create')}</Button>
          {company === null ? (
            <Button variant="outline" onClick={() => leadTo(STEP.createCompany)} data-lead-to={STEP.createCompany}>{t('createVault.goCreateCompany')}</Button>
          ) : null}
          {ready?.of === READY.yoursMissing ? (
            <Button variant="outline" disabled={busy} onClick={() => { void giveKeys(); }} data-action="give-vault-keys">{t('createVault.goGiveKeys')}</Button>
          ) : null}
          {ready?.of === READY.locked ? (
            <Button variant="outline" disabled={busy} onClick={() => { void openKeys(); }} data-action="open-with-your-account">{t('records.locked.open')}</Button>
          ) : null}
          {ready?.of === READY.othersMissing || ready?.of === READY.notOnChain || ready?.of === ACTED.refused ? (
            <Button variant="outline" disabled={busy} onClick={() => { void read(); }} data-action="read-again">{t('createVault.readAgain')}</Button>
          ) : null}
        </div>
      ) : (
        <ConfirmInYourAccount
          summary={asking.of === ASKING.create ? t('createVault.confirm') : asking.of === ASKING.start ? t('createVault.confirmStart') : t('createVault.confirmFinish')}
          busy={busy}
          onCancel={() => setAsking(null)}
          onConfirm={() => { void act(asking); }}
        />
      )}
      {stage === null ? null : <p className="text-sm" role="status" data-stage={stage}>{STAGE_SAYS[stage]}</p>}
      <div className="flex flex-col gap-4" role="status" data-outcome>
      {result?.of === ACTED.done ? (
        <p className="text-sm" data-created={result.vault}>
          {t('createVault.done')}
          {handedOver ? null : <> <span data-not-handed-over>{t('createVault.done.notHandedOver')}</span></>}
        </p>
      ) : null}
      {result?.of === OWED.here ? <p className="text-sm" data-result={result.of}>{t('createVault.owed.now')}</p> : null}
      {result?.of === OWED.elsewhere ? <p className="text-sm" data-result={result.of}>{t('createVault.owed.elsewhere')}</p> : null}
      {result?.of === OWED.rosterDisagrees ? <p className="text-sm" data-result={result.of}>{t('createVault.owed.rosterDisagrees')}</p> : null}
      {result?.of === STARTING.awaiting || result?.of === STARTING.owed ? (
        <div
          className="flex flex-col gap-2" data-result={result.of} data-round={result.of === STARTING.awaiting ? result.round : undefined}
          data-stopped={result.of === STARTING.owed ? result.stopped : undefined}
        >
          <p className="text-sm" data-says>
            {result.of === STARTING.owed ? (result.stopped === undefined ? t('createVault.startOwed') : stoppedSays(result.stopped))
              : result.round === 'adoption' ? t('createVault.awaiting.adoption', { approvals: result.approvals, needed: result.needed })
              : t('createVault.awaiting.firstSecret', { approvals: result.approvals, needed: result.needed })}
          </p>
          <StopResolvedBy
            result={result} owed={owed.find((o) => o.vault === result.vault)} disabled={busy || asking !== null}
            ask={setAsking} leadTo={leadTo}
          />
        </div>
      ) : null}
      </div>
      {gave === ACTED.done ? <p className="text-sm" data-gave-keys>{t('setup.handOver.done.giveKeys')}</p> : null}
      {gave === null || gave === ACTED.done ? null : <ActRefused why={gave} />}
      {opening === null ? null : <ActRefused why={opening} />}
      {result?.of === ACTED.refused ? <ActRefused why={result.why} /> : null}
    </div>
  );
}
