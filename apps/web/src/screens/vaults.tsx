import type { ReactNode } from 'react';
import { useText } from 'vaults-ui';
import { ReadOf, SoonAction, VaultTile, WithRecords } from '../records/parts.js';

/**
 * VAULTS: a tile for each of the company's vaults, as on Home, each opening
 * the vault's own page, which is shown here in place of the tiles. Creating a
 * vault is shown, and is Coming soon.
 */
export function Vaults({ children }: { children?: ReactNode }) {
  const t = useText();
  if (children !== undefined) return <>{children}</>;
  return (
    <div className="flex flex-col gap-4" data-screen="vaults">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('page.vaults.name')}</h1>
        <SoonAction label={t('vaults.create')} soon={t('vaults.create.soon')} data-action="create-vault" />
      </div>
      <WithRecords>
        {(records) => (
          <ReadOf read={records.vaults}>
            {(rows) => rows.length === 0 ? <p className="text-sm text-muted-foreground" data-empty>{t('vaults.none')}</p> : (
              <div className="grid gap-4 md:grid-cols-3">{rows.map((v, i) => <VaultTile key={v.vault} vault={v} index={i} />)}</div>
            )}
          </ReadOf>
        )}
      </WithRecords>
    </div>
  );
}
