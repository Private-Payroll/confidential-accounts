import { useEffect, useState } from 'react';
import { useText } from 'vaults-ui';
import { emptyOnChain, ON_CHAIN, readRetiredVaultOnChain, type RetiredVaultOnChain } from '../adapters/retired-vault-on-chain.js';

/*
 * Whether a retired vault is still shown. A retired vault is listed, with Adopt again, unless the chain itself shows it
 * holding nothing on both sides; while that read runs, or where a side could not be read, it stays listed and says it
 * may hold money. Nothing here waits on this device's note record or on the company key, so money paid in after the
 * retire is never hidden from every signer.
 */

/** What the chain shows a retired vault holding, or null while it is read; a vault that is not retired is never read. */
export function useRetiredVaultOnChain(company: string, vault: string, retired: boolean): RetiredVaultOnChain | null {
  const [read, setRead] = useState<RetiredVaultOnChain | null>(null);
  useEffect(() => {
    if (!retired) return undefined;
    let alive = true;
    setRead(null);
    void readRetiredVaultOnChain(company, vault).then((r) => { if (alive) setRead(r); });
    return () => { alive = false; };
  }, [company, vault, retired]);
  return read;
}

/** A retired vault is hidden only once the chain reads it empty on both sides. */
export const retiredVaultShown = (read: RetiredVaultOnChain | null): boolean => read === null || !emptyOnChain(read);

/** The line a retired vault shows while it is read, or when a side of it could not be read: it may hold money. */
export function RetiredMayHold({ read }: { read: RetiredVaultOnChain | null }) {
  const t = useText();
  if (read !== null && read.notes !== ON_CHAIN.unread && read.public !== ON_CHAIN.unread) return null;
  return <span className="text-muted-foreground" data-retired-may-hold>{t('vaults.retired.mayHold')}</span>;
}
