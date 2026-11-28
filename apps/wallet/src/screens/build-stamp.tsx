/**
 * The line under a company's account or vault that says whether its contract runs a published build. It reads one
 * address's keys through a replaceable reader and gives and refuses nothing. Its words come from the locale file; the
 * older sentences in the company section are written inline.
 */
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useText } from 'vaults-ui';
import { readAccountAddress } from 'midnight-identity/profile/company-label';
import type { ReleasedContract } from 'midnight-identity/wallet/released-versions';
import { INDEXER_HTTP_URL } from '../config.js';
import { fromIndexerAt } from '../chain/view-doors.js';
import { publishedBuildAt, type PublishedBuild, type StateReader } from '../chain/published-build.js';

/** Reads which published build the contract at an address is. Tests hand in their own. */
export type KeysReader = (address: string, contract: ReleasedContract) => Promise<PublishedBuild>;

const stateAt = fromIndexerAt(INDEXER_HTTP_URL);
const liveState: StateReader = async (address) => {
  const found = readAccountAddress(address);
  if (found === null) throw new Error('that is not a contract address.');
  return stateAt(found);
};

export const liveKeysReader: KeysReader = (address, contract) => publishedBuildAt(liveState, address, contract);

/** The one way to swap how a screen reads keys: the live reader unless a provider above it says otherwise. */
export const KeysReaderContext = createContext<KeysReader>(liveKeysReader);

export type BuildStampRead = PublishedBuild | { readonly of: 'checking' };

/** The answer is kept with the address and contract it was read for, so it is never shown against another. */
export function useBuildStamp(address: string, contract: ReleasedContract, read: KeysReader): BuildStampRead {
  const [found, setFound] = useState<{ address: string; contract: ReleasedContract; build: PublishedBuild } | null>(
    null
  );
  useEffect(() => {
    let alive = true;
    read(address, contract).then(
      (build) => {
        if (alive) setFound({ address, contract, build });
      },
      () => {
        if (alive) setFound({ address, contract, build: { of: 'unchecked' } });
      }
    );
    return () => {
      alive = false;
    };
  }, [address, contract, read]);
  return found !== null && found.address === address && found.contract === contract ? found.build : { of: 'checking' };
}

/**
 * Says whether the contract's keys are a published build, by its kind. It gives and refuses nothing, and it says
 * nothing about whether the company is the one the person means: that is for the fingerprint.
 */
export function BuildStamp({
  address,
  contract
}: {
  readonly address: string;
  readonly contract: 'account' | 'vault';
}): ReactNode {
  const t = useText();
  const stamp = useBuildStamp(address, contract, useContext(KeysReaderContext));
  const kind = contract;
  const words =
    stamp.of === 'published'
      ? t('stamp.published', { kind, version: stamp.version })
      : stamp.of === 'not-published'
        ? t('stamp.not-published', { kind })
        : stamp.of === 'unchecked'
          ? t('stamp.unchecked', { kind })
          : t('stamp.checking', { kind });
  return (
    <p className="m-0 text-sm text-muted-foreground" data-build-stamp={stamp.of} data-build-contract={contract}>
      {words}
    </p>
  );
}
