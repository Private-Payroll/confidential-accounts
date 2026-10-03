import { useState, type ReactNode } from 'react';
import { Badge, Button, Section, SectionRow, Tooltip, TooltipContent, TooltipTrigger, useText } from 'vaults-ui';
import { VAULT, type VaultRow, type VaultStanding } from '../adapters/company-records.js';
import { HOME } from '../pages.js';
import { useCompanyRecords } from './company-records.js';
import { go } from '../router.js';
import { startSetupAt } from '../setup/asked.js';
import type { StepId, StepProps } from '../setup/step-ids.js';
import { usePanel } from '../shell/right-panel.js';
import { CreateVault } from '../actions/create-vault.js';
import { HandOver } from '../actions/hand-over.js';

/*
 * A VAULT WAITING ON SOMETHING, AND THE ACTIONS THAT OPEN IN THE RIGHT-HAND
 * PANEL: creating a vault, finishing handing one over, and handing the
 * company to its signers. Each opens the one component the setup wizard's
 * step shows too, in the panel, and leaves the page where it was.
 */

/** What a pending vault's pill does when pressed: finish handing the vault over, hand the company over, or nothing, and only say why. */
const DOES = { finish: 'finish', start: 'start', handOver: 'hand-over', explain: 'explain' } as const;
type Does = (typeof DOES)[keyof typeof DOES];

/** The standings a vault is pending in, each with what its pill does. Any other standing is not pending. */
const PENDING: Partial<Record<VaultStanding, Does>> = {
  [VAULT.handoverOwed]: DOES.finish,
  /* Held by the signers and not set up: any signer carries it on from their own device, approving what is theirs to approve. */
  [VAULT.startOwed]: DOES.start,
  [VAULT.accountNotHandedOver]: DOES.handOver,
  [VAULT.notFundable]: DOES.explain,
  [VAULT.accountNotFundable]: DOES.explain,
  [VAULT.heldByOtherKeys]: DOES.explain,
};

/** Whether a vault in `standing` is pending. */
export const isPending = (standing: VaultStanding): boolean => PENDING[standing] !== undefined;

/** Where a vault stands, in words: for a pending vault, the explanation its pill shows. */
export function useStandingSays(): (standing: VaultStanding) => string {
  const t = useText();
  const says: Record<VaultStanding, string> = {
    [VAULT.held]: t('vaults.standing.held'),
    [VAULT.handoverOwed]: t('vaults.standing.handoverOwed'),
    [VAULT.startOwed]: t('vaults.standing.startOwed'),
    [VAULT.notOnChain]: t('vaults.standing.notOnChain'),
    [VAULT.notFundable]: t('vaults.standing.notFundable'),
    [VAULT.accountNotHandedOver]: t('vaults.standing.accountNotHandedOver'),
    [VAULT.accountNotFundable]: t('vaults.standing.accountNotFundable'),
    [VAULT.heldByOtherKeys]: t('vaults.standing.heldByOtherKeys'),
    [VAULT.unknown]: t('vaults.standing.unknown'),
  };
  return (standing) => says[standing];
}

/**
 * THE ACTIONS A VAULT'S PAGE AND THE VAULTS PAGE OPEN IN THE RIGHT-HAND
 * PANEL. `inPanel` opens a step's component there, given the way to the step
 * that makes it possible and what to read again when it changes something.
 */
export function useVaultActions() {
  const t = useText();
  const panel = usePanel();
  const { reload } = useCompanyRecords();
  /* A step that makes an action possible is taken in the setup wizard, open at that step. */
  const leadTo = (step: StepId): void => { panel.close(); startSetupAt(step); go(HOME.setup); };
  const inPanel = (title: string, body: (props: StepProps) => ReactNode): void => panel.open({ title, body: body({ leadTo, onChanged: reload }) });
  return {
    inPanel,
    finish: (vault: string): void => inPanel(t('createVault.finish'), (props) => <CreateVault {...props} finishing={vault} />),
    start: (vault: string): void => inPanel(t('createVault.finishStart'), (props) => <CreateVault {...props} starting={vault} />),
    handOver: (): void => inPanel(t('setup.step.handOver.name'), (props) => <HandOver {...props} />),
  };
}

/** What pressing a pending vault's pill, or its row's button, runs; null when it only says why. */
function actionOf(does: Does, actions: ReturnType<typeof useVaultActions>, vault: string): (() => void) | null {
  if (does === DOES.finish) return () => actions.finish(vault);
  if (does === DOES.start) return () => actions.start(vault);
  if (does === DOES.handOver) return actions.handOver;
  return null;
}

/**
 * THE PENDING PILL: on a pending vault's tile and on its page. Hovering or
 * focusing it says why the vault is pending. Pressing it finishes handing
 * the vault over, or hands the company over, when that is what it waits on;
 * otherwise pressing it shows why, for a touch screen. It is drawn inside the
 * tile's link, so pressing it does not follow the link.
 */
export function PendingPill({ vault }: { vault: Pick<VaultRow, 'vault' | 'standing'> }) {
  const t = useText();
  const says = useStandingSays();
  const actions = useVaultActions();
  const [open, setOpen] = useState(false);
  const does = PENDING[vault.standing];
  if (does === undefined) return null;
  const run = actionOf(does, actions, vault.vault);
  const press = (e: { preventDefault: () => void; stopPropagation: () => void }): void => {
    e.preventDefault(); e.stopPropagation();
    if (run === null) setOpen((o) => !o); else run();
  };
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <Badge asChild variant="destructive">
          <button type="button" onClick={press} data-pending={vault.standing} data-does={does}>{t('vaults.pending')}</button>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{says(vault.standing)}</TooltipContent>
    </Tooltip>
  );
}

/**
 * WHAT IS PENDING ON THE COMPANY'S VAULTS: a row for each pending vault,
 * with why, and the action that finishes it where there is one. Not drawn
 * when no vault is pending.
 */
export function VaultsPending({ rows }: { rows: readonly VaultRow[] }) {
  const t = useText();
  const says = useStandingSays();
  const actions = useVaultActions();
  const pending = rows.map((v, i) => ({ v, number: i + 1 })).filter(({ v }) => isPending(v.standing));
  if (pending.length === 0) return null;
  return (
    <Section title={t('vaults.pending')} count={pending.length} empty={null} data-part="vaults-pending">
      {pending.map(({ v, number }) => {
        const does = PENDING[v.standing]!;
        const run = actionOf(does, actions, v.vault);
        return (
          <SectionRow
            key={v.vault}
            data-pending-vault={v.vault}
            actions={run === null ? undefined : (
              <Button variant="outline" size="sm" onClick={run} data-action={does === DOES.finish ? 'finish-handover' : does === DOES.start ? 'finish-start' : 'hand-over'}>
                {does === DOES.finish ? t('createVault.finish') : does === DOES.start ? t('createVault.finishStart') : t('setup.handOver.button')}
              </Button>
            )}
          >
            <span className="font-medium">{t('vaults.tile.name', { number })}</span>
            <span className="text-muted-foreground">{says(v.standing)}</span>
          </SectionRow>
        );
      })}
    </Section>
  );
}
