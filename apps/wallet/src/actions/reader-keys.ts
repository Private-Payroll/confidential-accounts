import { readAccountAddress, readCompanyLabel, type AccountAddress, type CompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import type { ReadKeysReleased } from 'midnight-identity/profile/read-keys-release';
import { companyJudges } from '../../../../packages/web-shared/src/company-judges.js';
import { serviceNotReached } from '../../../../packages/web-shared/src/hand-over.js';
import { grantsServedBy, readerKeysHere, type PurposeWrapsHeld, type ReaderKeysFound } from '../../../../packages/web-shared/src/purpose-wraps.js';
import { readerDirectoryFor, type ReaderDirectoryDoors } from '../../../../packages/web-shared/src/reader-directory-here.js';
import { treeKeptInMemory } from '../../../../packages/web-shared/src/tree-kept-here.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { readerKeypairOfThisWallet } from '../screens/join-code-reader-key.js';
import { apiOver, RECORDS_UNREACHED, type CompanyChain } from './company-reach.js';
import { StepRefused, type ActionDefinition, type ShownLine, type StepContext, type Words } from './definition.js';
import { ActionStopped } from './run.js';

/**
 * **READ A COMPANY AS ONE OF ITS READERS: THE KEYS ITS READ GRANT IN FORCE WRAPS TO THIS WALLET, HANDED TO THE PAGE.**
 *
 * A reader holds no seat. This wallet works out its own reader key for the company (`readerKeypairOfThisWallet`),
 * reads the company's read grants through the page, and believes a version only as every device does
 * (`readerKeysHere`): filed by a seat its directory and the chain hold, signed at the seat bar the chain names, and
 * not withheld against the anchor of the company's records. It then hands the page only the keys the latest such
 * change sealed to it wraps to it, for this one company: never the reader key, a company key or anything a seat holds.
 * A company with no grant at the bar for this wallet, or whose latest change at the bar takes this wallet's access
 * away, is refused and hands over nothing. It signs and sends nothing, and
 * keeps no checkpoint of the company's anchor (`anchoredForAReader`).
 */
export interface ReaderKeysReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  /** What `chainReadsOf` reads off the network, read some other way than `chain` and `builder`; for a test. */
  readonly readsFor?: (company: ReadCompany) => ChainReads;
}

type ReadCompany = { readonly accountId: string; readonly label: CompanyLabel; readonly account: AccountAddress };
type ChainReads = Pick<ReaderDirectoryDoors, 'holders' | 'leaves' | 'anchored' | 'invitedSeats' | 'proposalIdentity'>;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({ key: `act.reader-keys.why.${key}`, ...(values === undefined ? {} : { values }) });
const refuse = (key: string, values?: Readonly<Record<string, string | number>>): never => { throw new StepRefused(why(key, values)); };

/** The company the page names, or why it names none this wallet can read. */
const companyOf = (fields: Readonly<Record<string, string>>): ReadCompany | Words => {
  const label = readCompanyLabel(fields['company']);
  const account = readAccountAddress(fields['account']);
  const accountId = fields['record'] ?? '';
  return label === null || account === null || accountId === '' ? why('not-a-company') : { accountId, label, account };
};

/** The keys `held` carries, in the one shape the page reads (`readReleasedReadKeys`). */
export const releasedOf = (held: PurposeWrapsHeld): ReadKeysReleased => ({
  accountId: held.accountId,
  byEpoch: Object.fromEntries([...held.byEpoch].map(([epoch, keys]) => [String(epoch), Object.fromEntries(keys)])),
});

/**
 * What the network says, read through this wallet's chain reads and builder: who holds the account, each seat's leaf,
 * the anchor of the company's records, and the seat each signer invitation took.
 */
function chainReadsOf(reach: ReaderKeysReach, api: ReturnType<typeof apiOver>, c: ReadCompany): ChainReads {
  const chain = reach.chain();
  const builder = reach.builder();
  const holders = async (): Promise<AccountHoldersRead> => {
    const read = await chain.holders(c.account, c.label);
    if ('key' in read) throw new StepRefused(read);
    return read;
  };
  /* A reader has no seat: no key of its own to judge with, no served key, no company key released. */
  const judges = companyJudges({
    api, holders: async () => holders(), indexer: async () => chain.indexer, builder: async () => builder,
    keysFor: () => null, servedKeyFor: () => { throw new Error('a reader is given no company key.'); },
    released: () => null, askReleased: async () => null, treeKept: () => treeKeptInMemory(),
    openAccount: async () => null, seatsAdmittedFor: async () => new Set(), noAccount: () => refuse('not-on-chain'),
  });
  return {
    holders, leaves: judges.leavesFor(c.account), anchored: judges.anchoredForAReader(c.accountId, c.label, c.account),
    invitedSeats: judges.invitedSeatsFor(c.label, c.account), proposalIdentity: judges.identityHere,
  };
}

/** What the read grants in force give this wallet, read through the page and judged here. */
async function readKeysInForce(ctx: StepContext, reach: ReaderKeysReach, c: ReadCompany): Promise<ReaderKeysFound> {
  const api = apiOver(ctx);
  const reads = reach.readsFor?.(c) ?? chainReadsOf(reach, api, c);
  const pair = readerKeypairOfThisWallet(ctx.held.identity, c.label);
  return readerKeysHere({
    accountId: c.accountId, versions: grantsServedBy(api, c.accountId), me: { recipient: pair.publicKey, wrappingSecret: pair.secret },
    directoryFor: readerDirectoryFor({ accountId: c.accountId, label: c.label, account: c.account, api, ...reads }),
  });
}

/** **THE WALLET ACT THAT HANDS A READER'S PAGE THE READ KEYS ITS GRANT IN FORCE NAMES, FOR ONE COMPANY.** */
export function readerKeysAction(reach: ReaderKeysReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.reader-keys.headline',
    shown: async (intent): Promise<readonly ShownLine[]> => [
      { key: 'act.reader-keys.shown.company', values: { label: String(intent.fields['company'] ?? '') }, from: 'page' },
      { key: 'act.reader-keys.shown.keys', from: 'action' },
      { key: 'act.reader-keys.shown.nothing-else', from: 'action' },
    ],
    checks: [{ key: 'act.reader-keys.check.grant' }],
    check: async (intent) => {
      const c = companyOf(intent.fields);
      return 'key' in c ? c : null;
    },
    steps: () => [{
      title: { key: 'act.reader-keys.step.read' },
      run: async (ctx) => {
        const c = companyOf(ctx.intent.fields);
        if ('key' in c) throw new StepRefused(c);
        let found: ReaderKeysFound;
        try {
          found = await readKeysInForce(ctx, reach, c);
        } catch (e) {
          if (e instanceof ActionStopped || e instanceof StepRefused) throw e;
          if (serviceNotReached(e)) throw new StepRefused(RECORDS_UNREACHED);
          if ((e as { status?: unknown } | null)?.status === 404) return refuse('not-a-reader-here');
          return refuse('not-read', { says: String((e as Error)?.message ?? e) });
        }
        if (found.of === 'taken-away') return refuse('taken-away');
        if (found.of === 'none' || found.held.byEpoch.size === 0) return refuse('no-grant');
        ctx.releaseReadKeys(releasedOf(found.held));
      },
    }],
  } satisfies ActionDefinition);
}
