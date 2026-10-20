import { useEffect, useState, type ReactNode } from 'react';
import { Badge, Button, Section, SectionRow, Tooltip, TooltipContent, TooltipTrigger, useText } from 'vaults-ui';
import { readVaultName, VAULT, type VaultRow, type VaultStanding } from '../adapters/company-records.js';
import { HOME } from '../pages.js';
import { useCompanyRecords } from './company-records.js';
import { go } from '../router.js';
import { startSetupAt } from '../setup/asked.js';
import type { StepId, StepProps } from '../setup/step-ids.js';
import { usePanel } from '../shell/right-panel.js';
import { useSession } from '../session.js';
import { CreateVault } from '../actions/create-vault.js';
import { CommitteeChange } from '../actions/committee-change.js';

/*
 * A VAULT WAITING ON SOMETHING, AND THE ACTIONS THAT OPEN IN THE RIGHT-HAND
 * PANEL: creating a vault, carrying a vault's set up on, and seeing who holds
 * the company. Creating a vault opens the one component the setup wizard's
 * step shows too; seeing who holds the company opens the one component the
 * signers page shows too. Each opens in the panel and leaves the page where it was.
 */

/** What a pending vault's pill does when pressed: carry its set up on, show who holds the company, or nothing, and only say why. */
const DOES = { start: 'start', committee: 'committee-change', explain: 'explain' } as const;
type Does = (typeof DOES)[keyof typeof DOES];

/** The standings a vault is pending in, each with what its pill does. Any other standing is not pending. */
const PENDING: Partial<Record<VaultStanding, Does>> = {
  /* Held by the super admins and not set up: any signer carries it on from their own device, approving what is theirs to approve. */
  [VAULT.startOwed]: DOES.start,
  [VAULT.accountNotHandedOver]: DOES.committee,
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
 * PANEL. `inPanel` opens a component there, given the way to the step
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
    start: (vault: string): void => inPanel(t('createVault.finishStart'), (props) => <CreateVault {...props} starting={vault} />),
    committeeChange: (): void => inPanel(t('committeeChange.name'), (props) => <CommitteeChange onChanged={props.onChanged} />),
  };
}

/** What pressing a pending vault's pill, or its row's button, runs; null when it only says why. */
function actionOf(does: Does, actions: ReturnType<typeof useVaultActions>, vault: string): (() => void) | null {
  if (does === DOES.start) return () => actions.start(vault);
  if (does === DOES.committee) return actions.committeeChange;
  return null;
}

/**
 * THE PENDING PILL: on a pending vault's tile and on its page. Hovering or
 * focusing it says why the vault is pending. Pressing it carries the vault's set
 * up on, or shows who holds the company, when that is what it waits on;
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
 * A VAULT'S NAME: the name the company filed for a vault its account adopted,
 * read on this device, and its number (`number`, counted in the company's
 * list) for any other vault, for one filed with no name, and while the name is
 * being read. A name that cannot be read or believed is never guessed at.
 */
export function VaultName({ company, vault, number }: { company: string | null; vault: Pick<VaultRow, 'vault' | 'adopted'>; number: number }) {
  const t = useText();
  const { person } = useSession();
  const [name, setName] = useState<string | null>(null);
  const adopted = vault.adopted === true;
  useEffect(() => {
    let alive = true;
    setName(null);
    if (adopted && company !== null) void readVaultName(person.id, company, vault.vault).then((n) => { if (alive) setName(n); });
    return () => { alive = false; };
  }, [person.id, company, vault.vault, adopted]);
  return <>{name ?? t('vaults.tile.name', { number })}</>;
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
  const { company } = useSession();
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
              <Button variant="outline" size="sm" onClick={run} data-action={does === DOES.start ? 'finish-start' : 'committee-change'}>
                {does === DOES.start ? t('createVault.finishStart') : t('committeeChange.button')}
              </Button>
            )}
          >
            <span className="font-medium"><VaultName company={company} vault={v} number={number} /></span>
            <span className="text-muted-foreground">{says(v.standing)}</span>
          </SectionRow>
        );
      })}
    </Section>
  );
}
