import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useText } from 'vaults-ui';
import type { Identity } from 'midnight-identity/keys/derivation';
import { INDEXER_HTTP_URL, NETWORK } from '../config.js';
import { accountBuilding } from '../chain/account-builder-client.js';
import { liveRegistryReads, registryEntriesFound, type RegistryFind, type RegistryFinder } from '../chain/private-registry-on-chain.js';

/**
 * **THE COMPANIES A RECOVERED WALLET FINDS AGAIN IN ITS OWN REGISTRY ENTRIES**, listed once the recovery has opened the
 * wallet. Each company shows its fingerprint and what was checked on the chain, never that it is genuine; two
 * accounts under one company's label are shown with both fingerprints, for the person to compare with the one their
 * company shows them, and neither is held to. Nothing is kept here: this screen holds no saved keys, so the first
 * action for a company found here keeps its account then.
 */

/** The find on this wallet's own network, through its own indexer and builder. */
export const liveFind: RegistryFinder = (identity) =>
  registryEntriesFound(identity, NETWORK, liveRegistryReads(NETWORK, INDEXER_HTTP_URL, accountBuilding()));

type Finding = { readonly of: 'reading' } | { readonly of: 'failed' } | RegistryFind;

/** The find, run once for `identity`. */
function useFound(identity: Identity, find: RegistryFinder): Finding {
  const [found, setFound] = useState<Finding>({ of: 'reading' });
  useEffect(() => {
    let live = true;
    setFound({ of: 'reading' });
    find(identity).then((f) => { if (live) setFound(f); }, () => { if (live) setFound({ of: 'failed' }); });
    return () => { live = false; };
  }, [identity, find]);
  return found;
}

/** What the recovered wallet found in its registry entries, as the person reads it. */
export function CompaniesFoundAgain({ identity, find }: { readonly identity: Identity; readonly find: RegistryFinder }): ReactNode {
  const t = useText();
  const found = useFound(identity, find);
  if (found.of === 'reading') return <p className="muted small" data-found-again="reading">{t('recover.found.reading')}</p>;
  if (found.of === 'failed') return <p className="muted small" data-found-again="failed">{t('recover.found.failed')}</p>;
  if (found.of === 'no-registries') return <p className="muted small" data-found-again="no-registries">{t('recover.found.no-registries', { network: found.network })}</p>;
  return (
    <section className="card" aria-label={t('recover.found.title')} data-found-again="read">
      <h2>{t('recover.found.title')}</h2>
      {found.companies.length === 0 && found.clashes.length === 0 && <p className="muted small">{t('recover.found.none')}</p>}
      {found.companies.map((c) => (
        <div key={`${c.label}|${c.account}`} data-found-company={c.fingerprint}>
          <p><strong>{c.fingerprint}</strong></p>
          <p className="small">{t('recover.found.checked', { version: c.version })}</p>
        </div>
      ))}
      {found.companies.length > 0 && <p className="faint small">{t('recover.found.kept-on-first-use')}</p>}
      {found.clashes.map((c) => (
        <div key={c.label} data-found-clash={c.label}>
          <p className="warn-text small">{t('recover.found.clash')}</p>
          {c.accounts.map((a) => <p key={a.account}><strong>{a.fingerprint}</strong></p>)}
        </div>
      ))}
      {found.passedOver.length > 0 && <p className="faint small">{t('recover.found.passed-over', { count: found.passedOver.length })}</p>}
    </section>
  );
}
