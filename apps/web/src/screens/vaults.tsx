import type { ReactNode } from 'react';
import { SafeIcon } from '@hugeicons/core-free-icons';
import { EmptyState, PageHeader, Section, StatTiles, useText } from 'vaults-ui';
import { CreateVault } from '../actions/create-vault.js';
import { HOME } from '../pages.js';
import { go } from '../router.js';
import { ReadOf, VaultTile, WithRecords } from '../records/parts.js';
import { useCompanyRecords } from '../records/company-records.js';
import { startSetupAt } from '../setup/asked.js';
import type { StepId } from '../setup/step-ids.js';

/**
 * VAULTS: a tile for each of the company's vaults, each opening the vault's
 * own page, which is shown here in place of the tiles; and Create a vault,
 * the same component the setup wizard's vault step shows.
 *
 * CREATE A VAULT IS DRAWN OUTSIDE THE COMPANY'S RECORDS, so reading them
 * again after a vault is created does not take away what it said.
 */
export function Vaults({ children }: { children?: ReactNode }) {
  const t = useText();
  const { reload } = useCompanyRecords();
  if (children !== undefined) return <>{children}</>;
  /* A step that makes creating a vault possible is taken in the setup wizard, open at that step. */
  const leadTo = (step: StepId): void => { startSetupAt(step); go(HOME.setup); };
  return (
    <div className="flex flex-col gap-6" data-screen="vaults">
      <PageHeader title={t('page.vaults.name')} />
      <WithRecords>
        {(records) => (
          <ReadOf read={records.vaults}>
            {(rows) => (
              <Section title={t('page.vaults.name')} count={rows.length} list={false} box={false} data-part="vaults">
                {rows.length === 0
                  ? <EmptyState icon={SafeIcon}>{t('vaults.none')}</EmptyState>
                  : <StatTiles>{rows.map((v, i) => <VaultTile key={v.vault} company={records.id} vault={v} index={i} />)}</StatTiles>}
              </Section>
            )}
          </ReadOf>
        )}
      </WithRecords>
      <Section title={t('vaults.create')} list={false} data-part="create-vault">
        <CreateVault leadTo={leadTo} onChanged={reload} />
      </Section>
    </div>
  );
}
