import type { ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, SafeIcon } from '@hugeicons/core-free-icons';
import { Button, EmptyState, PageHeader, StatTiles, useText } from 'vaults-ui';
import { CreateVault } from '../actions/create-vault.js';
import { useVaultActions, VaultsPending } from '../records/vault-pending.js';
import { ReadOf, VaultTile, WithRecords } from '../records/parts.js';

/**
 * VAULTS: Create a vault on the title line, opening the one create-a-vault
 * component in the right-hand panel; what is pending on the company's vaults
 * on top, when anything is; and a tile for each vault under the page's one
 * heading, each opening the vault's own page, which is shown here in place of
 * the tiles.
 */
export function Vaults({ children }: { children?: ReactNode }) {
  const t = useText();
  const actions = useVaultActions();
  if (children !== undefined) return <>{children}</>;
  return (
    <div className="flex flex-col gap-6" data-screen="vaults">
      <PageHeader
        title={t('page.vaults.name')}
        actions={<Button onClick={() => actions.inPanel(t('vaults.create'), (props) => <CreateVault {...props} />)} data-action="create-vault"><HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />{t('vaults.create')}</Button>}
      />
      <WithRecords>
        {(records) => (
          <ReadOf read={records.vaults}>
            {(rows) => (
              <>
                <VaultsPending rows={rows} />
                <div data-part="vaults" data-count={rows.length}>
                  {rows.length === 0
                    ? <EmptyState icon={SafeIcon}>{t('vaults.none')}</EmptyState>
                    : <StatTiles>{rows.map((v, i) => <VaultTile key={v.vault} company={records.id} vault={v} index={i} />)}</StatTiles>}
                </div>
              </>
            )}
          </ReadOf>
        )}
      </WithRecords>
    </div>
  );
}
