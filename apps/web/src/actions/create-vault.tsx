import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Alert, AlertDescription, Button, ConfirmInYourAccount, Input, Label, Textarea, useText } from 'vaults-ui';
import {
  CREATING, createVault, finishStarting, giveYourVaultKeys, openYourKeys, pressingAgainCanClear, READY, readVaultReadiness, SAID, STARTING,
  STOPPED, type Creating, type Readiness, type SaidCode, type StartStopped, type VaultCreated,
} from '../adapters/create-vault.js';
import { HANDOVER, readHandover, type Handover } from '../adapters/handover-state.js';
import { proofsRunning } from '../adapters/proofs-running.js';
import { stageTimeNoter, VAULT_USUAL_SECONDS } from '../adapters/usual-times.js';
import { ACTED, type ActRefusal } from '../adapters/refusals.js';
import { ActRefused } from '../act-refused.js';
import { PAGE } from '../pages.js';
import { PageLink } from '../router.js';
import { useSession } from '../session.js';
import { secondsSince, StageProgress, useStageSince, useTicker } from '../stage-progress.js';
import { usePanel } from '../shell/right-panel.js';
import { useCreationFact } from '../setup/standing.js';
import { STEP, type StepProps } from '../setup/step-ids.js';

/** What resolves a set-up that stopped before its secret was approved, in the person's own words. */
function useStoppedSays(): (stopped: StartStopped) => string {
  const t = useText();
  const says: Record<StartStopped, string> = {
    [STOPPED.wallet]: t('createVault.stopped.wallet'),
    [STOPPED.walletAsk]: t('createVault.stopped.walletAsk'),
    [STOPPED.directory]: t('createVault.stopped.directory'),
    [STOPPED.signers]: t('createVault.stopped.signers'),
    [STOPPED.mismatch]: t('createVault.stopped.mismatch'),
    [STOPPED.adoptionStale]: t('createVault.stopped.adoptionStale'),
    [STOPPED.tooFewApprovers]: t('createVault.stopped.tooFewApprovers'),
    [STOPPED.readersCannotOpen]: t('createVault.stopped.readersCannotOpen'),
    [STOPPED.anotherSecret]: t('createVault.stopped.anotherSecret'),
    [STOPPED.readBackOnly]: t('createVault.stopped.readBackOnly'),
  };
  return (stopped) => says[stopped];
}

/* Every stage of creating a vault has its usual time, or null, in the usual times. */
VAULT_USUAL_SECONDS satisfies Record<Creating, number | null>;

/** What the person is being asked to confirm, if anything: creating a vault, or carrying on setting up the one named. */
const ASKING = { create: 'create', start: 'start' } as const;
type Asking = { of: typeof ASKING.create } | { of: typeof ASKING.start; vault: string };

/** What each thing a press left out of the company's records is said as, in the person's words. */
function useSaidSays(): Record<SaidCode, string> {
  const t = useText();
  return {
    [SAID.proposalNotWrittenDown]: t('createVault.said.proposalNotWrittenDown'),
    [SAID.nameNotFiled]: t('createVault.said.nameNotFiled'),
    [SAID.nameGivenBefore]: t('createVault.said.nameGivenBefore'),
  };
}

/** The four things the read of who holds the company can say after a vault is created, other than that its super admins hold it. */
const HELD_NOTICE: Record<Handover['of'], Extract<Handover['of'], 'change-owed' | 'held-by-other-keys' | 'unreadable' | 'unreachable'> | null> = {
  [HANDOVER.held]: null,
  [HANDOVER.changeOwed]: HANDOVER.changeOwed,
  [HANDOVER.heldByOtherKeys]: HANDOVER.heldByOtherKeys,
  [HANDOVER.unreadable]: HANDOVER.unreadable,
  [HANDOVER.notOnChain]: HANDOVER.unreadable,
  [HANDOVER.unreachable]: HANDOVER.unreachable,
  [HANDOVER.notSignedIn]: HANDOVER.unreachable,
  [HANDOVER.anotherPerson]: HANDOVER.unreachable,
};

/**
 * WHAT THE READ OF WHO HOLDS THE COMPANY SAYS, once a vault is created and
 * the read did not come to "held". A change of super admins still owed leads
 * to the signers page, where the change is made; the panel this is drawn in,
 * if any, is closed on the way.
 */
function HeldNotice({ of }: { of: NonNullable<(typeof HELD_NOTICE)[Handover['of']]> }) {
  const t = useText();
  const panel = usePanel();
  const says: Record<typeof of, string> = {
    [HANDOVER.changeOwed]: t('createVault.held.changeOwed'),
    [HANDOVER.heldByOtherKeys]: t('createVault.held.byOtherKeys'),
    [HANDOVER.unreadable]: t('createVault.held.unreadable'),
    [HANDOVER.unreachable]: t('createVault.held.unreachable'),
  };
  return (
    <Alert data-held-notice={of}>
      <AlertDescription>{says[of]}</AlertDescription>
      {of === HANDOVER.changeOwed ? (
        <div>
          <Button asChild variant="outline">
            <PageLink to={PAGE.settingsSigners} onClick={panel.close} data-action="go-signers">{t('createVault.held.goSigners')}</PageLink>
          </Button>
        </div>
      ) : null}
    </Alert>
  );
}

/**
 * THE ONE ACTION THAT RESOLVES WHERE A SET-UP STOPPED. Waiting for approvals,
 * or stopped for the wallet or the signers, it is to finish setting it up.
 * Signers' keys that do not match offer nothing: pressing again would stop the
 * same way.
 */
function StopResolvedBy({ result, disabled, ask }: {
  result: Extract<VaultCreated, { of: typeof STARTING.owed | typeof STARTING.awaiting }>;
  disabled: boolean; ask: (a: Asking) => void;
}) {
  const t = useText();
  const stopped = result.of === STARTING.owed ? result.stopped : undefined;
  if (!pressingAgainCanClear(stopped)) return null;
  return (
    <div>
      <Button variant="outline" disabled={disabled} onClick={() => ask({ of: ASKING.start, vault: result.vault })} data-action="finish-start">{t('createVault.finishStart')}</Button>
    </div>
  );
}

/**
 * CREATE A VAULT: built, proved and signed in the person's wallet and sent
 * by this page, held from its first transaction by the company's super admins. One component, shown by
 * the setup wizard's vault step and in the right-hand panel the Vaults page
 * and a vault's page open.
 *
 * Create a vault is always shown; while it cannot be used it is disabled and
 * the reason is said in plain words beside it: no company, a company not
 * finished being created (with the way to the step that finishes it), keys not
 * given or not open, or no name typed yet. The vault's name (1 to 64
 * characters) and description (up to 1,000) are asked before the confirm step
 * and handed to the press. A person who has not given their vault keys gives
 * them here; the step that makes creating possible is led to only for a
 * company not created or not finished. With `starting` the
 * component opens once, after the company is read, asking to carry that
 * vault's set up on; a vault carried on whose name this device cannot read
 * has its name and description asked first, and they are filed as it is.
 *
 * Once the super admins hold it, the vault is set up: it is added to the company's
 * account, its private records are made and its secret set, and each signer
 * is given a sealed copy. While the wallet runs, the stage its step is at is
 * said, with how long it has run and usually takes. A start that waits
 * for other signers' approvals is named with how many it has and needs, and
 * says each of them approves it from their own device; a set up that stopped
 * is said as that, with what resolves it when it stopped at the check of who
 * the vault's secret is sealed to, and offers the one action that resolves
 * where it stopped (`StopResolvedBy`). Carrying a vault on can be done by any
 * signer from their own device; until the set up is done, this app puts no
 * money into the vault. What the press could not leave in the company's
 * records is said in the person's words under what it came to, and a
 * company account not read as held by its super admins is said once the vault
 * is created, with the way to the signers page where a change is owed.
 */
export function CreateVault({ leadTo, onChanged, starting }: StepProps & { starting?: string }) {
  const t = useText();
  const stoppedSays = useStoppedSays();
  const { person, company } = useSession();
  const saidSays = useSaidSays();
  const nameId = useId();
  const descriptionId = useId();
  const whyId = useId();
  const { creation, reread } = useCreationFact(company);
  const [ready, setReady] = useState<Readiness | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [opening, setOpening] = useState<ActRefusal | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [stage, setStage] = useState<Creating | null>(null);
  const [result, setResult] = useState<VaultCreated | null>(null);
  /* What the read of who holds the company said once a vault was created; the notice under the outcome is shown for any read but "held". */
  const [held, setHeld] = useState<Handover['of'] | null>(null);
  /* Whether this person's vault keys were just given here, or why not. */
  const [gave, setGave] = useState<typeof ACTED.done | ActRefusal | null>(null);
  /* The vault being carried on that has no name this device can read: its name and description are asked before it is. */
  const [nameOwed, setNameOwed] = useState<string | null>(null);
  /* The vault whose name has been read: the confirm to carry a vault on waits for it. */
  const [nameReadFor, setNameReadFor] = useState<string | null>(null);
  /* The vault being carried on whose name could not be read here. */
  const [nameUnreadFor, setNameUnreadFor] = useState<string | null>(null);

  const read = useCallback(async () => {
    if (company === null) { setReady(null); return; }
    setReady(await readVaultReadiness(person.id, company));
  }, [person.id, company]);
  useEffect(() => { void read(); }, [read]);
  /* Asked to carry on setting up one vault, from this signer's own device: asked once, once the company has been read. */
  const askedToStart = useRef<string | null>(null);
  useEffect(() => {
    if (starting === undefined || ready === null || asking !== null || askedToStart.current === starting) return;
    askedToStart.current = starting;
    setAsking({ of: ASKING.start, vault: starting });
  }, [starting, ready, asking]);

  /*
   * A vault asked to be carried on is read for its name; with none filed, the name is asked again and handed to the set
   * up. A name that could not be read is said so, and no name is asked over one that may be filed.
   */
  useEffect(() => {
    if (asking?.of !== ASKING.start || company === null) return undefined;
    let alive = true;
    const vault = asking.vault;
    void import('../adapters/company-records.js').then(({ readVaultName, NAME_NOT_READ }) => readVaultName(person.id, company, vault, NAME_NOT_READ)
      .then((filed) => { if (alive) { setNameOwed(filed === null ? vault : null); setNameUnreadFor(filed === NAME_NOT_READ ? vault : null); setNameReadFor(vault); } }));
    return () => { alive = false; };
  }, [asking, person.id, company]);

  const busy = stage !== null;
  const act = async (asked: Asking): Promise<void> => {
    if (company === null) return;
    setAsking(null); setResult(null); setStage(CREATING.checking);
    const r = asked.of === ASKING.create
      ? await createVault(person.id, company, setStage, { name: name.trim(), description: description.trim() })
      : await finishStarting(person.id, company, asked.vault, setStage,
        nameOwed === asked.vault && name.trim() !== '' ? { name: name.trim(), description: description.trim() } : undefined);
    const handover = r.of === ACTED.done ? await readHandover(person.id, company) : null;
    /* Any read of who holds the company but "held" is said under the outcome: a vault created does not make the company's account held. */
    setHeld(handover === null ? null : handover.of);
    setResult(r);
    setStage(null);
    await read();
    onChanged();
  };

  const openKeys = async (): Promise<void> => {
    setOpening(null);
    const r = await openYourKeys(person.id);
    setOpening(r.of === ACTED.refused ? r.why : null);
    await Promise.all([read(), reread()]);
  };

  const giveKeys = async (): Promise<void> => {
    if (company === null) return;
    setGave(null);
    const r = await giveYourVaultKeys(person.id, company);
    setGave(r.of === ACTED.refused ? r.why : ACTED.done);
    await read();
    onChanged();
  };

  /* Not finished: the creation read is in and does not confirm it. Keys not open on a company the service reads as finished are the keys' reason, not this one. */
  const unfinished = creation !== null && !creation.confirmedFinished && !(creation.standing === 'finished' && ready?.of === READY.locked);
  const named = name.trim() !== '';
  const askingTheName = asking?.of === ASKING.start && nameOwed === asking.vault;
  /* Creating a vault gives this person's own vault keys first, in the same action, so their keys still to give do not hold it back. */
  /* Keys not open here hold nothing back either: the action in the wallet reads them itself and checks the vault can be created. */
  const canCreate = company !== null && creation !== null && !unfinished
    && (ready?.of === READY.ready || ready?.of === READY.yoursMissing || ready?.of === READY.locked) && named && !busy;
  const why = company === null ? t('createVault.why.noCompany')
    : ready === null || creation === null ? t('createVault.why.reading')
    : unfinished ? t('createVault.why.notFinished')
    : ready.of === READY.yoursMissing && !named ? t('createVault.why.yoursMissing')
    : ready.of === READY.othersMissing ? t('createVault.why.othersMissing')
    : ready.of === READY.notOnChain ? t('createVault.why.notOnChain')
    : ready.of === READY.locked && !named ? t('createVault.why.locked')
    : !named ? t('createVault.why.nameFirst')
    : null;
  const { now, proofStartedAt } = useTicker(proofsRunning);
  const stageSince = useStageSince(stage ?? null);
  const noteStageTime = useRef(stageTimeNoter());
  const timedStage = stage === null || stage === CREATING.done ? null : stage;
  useEffect(() => {
    noteStageTime.current(timedStage === null ? null : [timedStage], proofStartedAt ?? stageSince, timedStage === null ? null : VAULT_USUAL_SECONDS[timedStage]);
  }, [timedStage]);
  useEffect(() => () => { noteStageTime.current(null, 0, null); }, []);
  const STAGE_SAYS: Record<Creating, string> = {
    [CREATING.checking]: t('createVault.stage.checking'),
    [CREATING.building]: t('createVault.stage.building'),
    [CREATING.done]: t('createVault.stage.done'),
  };

  return (
    <div className="flex max-w-xl flex-col gap-4" data-action="create-vault" data-state={ready?.of ?? undefined}>
      <p className="text-sm text-muted-foreground">{t('createVault.what')}</p>
      <div className="flex flex-col gap-2">
        <Label htmlFor={nameId}>{t('createVault.nameLabel')}</Label>
        <Input id={nameId} data-field="vault-name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} disabled={busy || (asking !== null && !askingTheName)} />
        <p className="text-xs text-muted-foreground">{t('createVault.nameHint')}</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={descriptionId}>{t('createVault.descriptionLabel')}</Label>
        <Textarea id={descriptionId} data-field="vault-description" value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} disabled={busy || (asking !== null && !askingTheName)} />
        <p className="text-xs text-muted-foreground">{t('createVault.descriptionHint')}</p>
      </div>
      {why === null ? null : <p id={whyId} className="text-sm" data-why={ready?.of ?? 'no-company'}>{why}</p>}
      {ready?.of === ACTED.refused ? <ActRefused why={ready.why} /> : null}

      {asking === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!canCreate || busy} aria-describedby={!canCreate && why !== null ? whyId : undefined} onClick={() => setAsking({ of: ASKING.create })} data-action="create-vault-now">{t('vaults.create')}</Button>
          {company === null ? (
            <Button variant="outline" onClick={() => leadTo(STEP.createCompany)} data-lead-to={STEP.createCompany}>{t('createVault.goCreateCompany')}</Button>
          ) : null}
          {unfinished ? (
            <Button variant="outline" className="h-auto whitespace-normal text-start" onClick={() => leadTo(STEP.finishCompany)} data-lead-to={STEP.finishCompany}>
              {t('setup.blocked.go', { step: t('setup.step.finishCompany.name') })}
            </Button>
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
      ) : asking.of === ASKING.start && nameReadFor !== asking.vault ? null : asking.of === ASKING.start && nameUnreadFor === asking.vault ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm" data-name-unread>{t('createVault.resume.nameUnread')}</p>
          <Button variant="outline" onClick={() => setAsking(null)}>{t('kit.confirm.cancel')}</Button>
        </div>
      ) : askingTheName && !named ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm" data-name-again>{t('createVault.resume.nameAgain')}</p>
          <Button variant="outline" onClick={() => setAsking(null)}>{t('kit.confirm.cancel')}</Button>
        </div>
      ) : (
        <ConfirmInYourAccount
          summary={asking.of === ASKING.create ? t('createVault.confirm') : t('createVault.confirmStart')}
          busy={busy}
          onCancel={() => setAsking(null)}
          onConfirm={() => { void act(asking); }}
        />
      )}
      {stage === null ? null : <p className="text-sm" role="status" data-stage={stage}>{STAGE_SAYS[stage]}</p>}
      {stage === null || stage === CREATING.done ? null : (
        <StageProgress stage={stage} elapsedSeconds={secondsSince(now, proofStartedAt ?? stageSince)} usualSeconds={VAULT_USUAL_SECONDS[stage]} />
      )}
      <div className="flex flex-col gap-4" role="status" data-outcome>
      {result?.of === ACTED.done ? (
        <>
          <p className="text-sm" data-created={result.vault}>{t('createVault.done')}</p>
          {held === null || HELD_NOTICE[held] === null ? null : <HeldNotice of={HELD_NOTICE[held]} />}
        </>
      ) : null}
      {result?.of === ACTED.done || result?.of === STARTING.awaiting ? (
        result.said === undefined ? null : (
          <div className="flex flex-col gap-1" data-said>
            {result.said.map((code) => <p key={code} className="text-sm" data-said-code={code}>{saidSays[code]}</p>)}
          </div>
        )
      ) : null}
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
          <StopResolvedBy result={result} disabled={busy || asking !== null} ask={setAsking} />
        </div>
      ) : null}
      </div>
      {gave === ACTED.done ? <p className="text-sm" data-gave-keys>{t('createVault.keysGiven')}</p> : null}
      {gave === null || gave === ACTED.done ? null : <ActRefused why={gave} />}
      {opening === null ? null : <ActRefused why={opening} />}
      {result?.of === ACTED.refused ? <ActRefused why={result.why} /> : null}
    </div>
  );
}
