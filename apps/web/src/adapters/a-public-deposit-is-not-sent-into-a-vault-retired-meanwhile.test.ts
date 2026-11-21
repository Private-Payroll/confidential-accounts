// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, AssetRegistry } from '../../../../src/core/assets.js';
import type { DepositNow } from './deposit.js';

/*
 * A PUBLIC DEPOSIT FROM THE PAGE IS SENT THROUGH THE DEPOSIT'S OWN VIEW OF THE COMPANY, so who holds the company is read
 * again immediately before the send, after the person approved the deposit in their wallet. A vault retired while they
 * read the approval takes nothing. The person's wallet, the service and the vault worker are stood in for; the page's
 * adapter, the company's view and the shared public deposit run as they are.
 */
const VAULT = 'ab'.repeat(32);
const LABEL = `co_${'c1'.repeat(32)}`;
const ACCOUNT = 'c0'.repeat(32);
const PUB = 'cd'.repeat(32);
const COMMITTEE = [{ tag: 'schnorr', value: '21'.repeat(32) }, { tag: 'schnorr', value: '22'.repeat(32) }];
const INDEXER = { indexerUri: 'https://indexer.example/api/v3/graphql', indexerWsUri: 'wss://indexer.example/api/v3/graphql/ws' };
const holders = (adopted: string[]) => ({ committee: COMMITTEE, threshold: 2, seats: [], approvals: 1, adoptedVaults: adopted, vaultThresholds: [], policyBar: null });
const st = vi.hoisted(() => ({
  /* Whether the vault's retirement lands while the person reads the approval in their wallet. */
  retiredMeanwhile: false, adopted: [] as string[], asked: [] as string[], paid: 0,
}));
vi.mock('./keyring-person.js', () => ({ keyringFor: async () => true }));
vi.mock('vaults-web-shared/wallet-asks.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/wallet-asks.js')>()),
  holdersFromTheWallet: async () => ({ holders: holders(st.adopted), indexer: INDEXER }),
  payIntoAVaultFromTheWallet: async (_origin: string, ask: { transaction: string }) => {
    st.paid += 1;
    if (st.retiredMeanwhile) st.adopted = [];
    return { transaction: `${ask.transaction}+public-coins`, leaves: [{ token: PUB, amount: '40', kind: 'unshielded' }] };
  },
}));
vi.mock('vaults-web-shared/service-transport.js', async (real) => (await import('./service-in-memory.test-support.js')).withTheView({
  ...(await real<typeof import('vaults-web-shared/service-transport.js')>()),
  api: async (path: string) => {
    st.asked.push(path);
    if (path === '/api/accounts/c1') return { id: 'c1', companyLabel: LABEL, contractAddress: ACCOUNT };
    if (path.endsWith('/public-deposit')) return { txRef: 'r1', transactionHash: null };
    throw new Error(`no answer for ${path}`);
  },
}));
/* The vault worker: the vault as it reads it at the wallet's indexer, held by the account's committee and started; the deposit built, read and seen landed. */
const asBuilt = { identifiers: ['00aa'], timeToLive: Date.now() + 3_600_000, calls: [{ address: VAULT, entryPoint: 'depositUnshielded', segments: [0] }], coinsForContracts: [],
  publicTakes: [{ address: VAULT, entryPoint: 'depositUnshielded', colour: PUB, amount: '40' }], publicDeposits: [{ vault: VAULT, colour: PUB, amount: '40' }] };
vi.mock('./vault-builder.js', () => ({
  theVaultBuilder: async () => ({
    vaultOnChain: async () => ({ onChain: true, state: 'AAAA', notes: [], notesFromThisBuild: true, everCreated: [], authority: { committee: COMMITTEE, threshold: 2 },
      account: ACCOUNT, started: true, circuits: null, accountCircuits: null }),
    chainAtOneBlock: async () => ({ blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: btoa('midnight:ledger-parameters[v8]:stand-in'), accountState: 'A' }),
    publicDeposit: async () => ({ tx: 'PROVEN' }),
    readTransaction: async () => asBuilt,
    vaultCallOnChain: async () => ({ of: 'landed', transactionHash: 'c4'.repeat(32) }),
  }),
}));

const REG: AssetRegistry = (() => {
  const list: Asset[] = [{ code: PUB, symbol: 'PUB', name: 'PUB', decimals: 0, ledger: { shielded: null, unshielded: PUB }, enabled: true, sortOrder: 1 }];
  return { all: () => list, enabled: () => list, find: (c) => list.find((a) => a.code === c) ?? null, require: (c) => list.find((a) => a.code === c)! };
})();

const putIn = async (): Promise<DepositNow> => {
  const m = await import('./deposit.js');
  const { aViewOf } = await import('./page-view.test-support.js');
  m.putAwayEndedDeposit(VAULT);
  const started = m.putMoneyIn('u1', aViewOf('c1'), VAULT, { code: PUB, kind: m.DEPOSIT_KIND.public }, '40', 100n, REG);
  if (started.of !== m.PUT_IN.started) throw new Error('the deposit did not start');
  return started.ended;
};
const sends = () => st.asked.filter((p) => p.endsWith('/public-deposit'));

beforeEach(() => { st.retiredMeanwhile = false; st.adopted = [VAULT]; st.asked = []; st.paid = 0; });

describe('a public deposit from the page reads who holds the company again before it sends', () => {
  /* RED WHEN: the deposit is sent through anything but its view, so nothing reads the company between the approval and the send. */
  it('sends the deposit the person approved into a vault the company still adopts', async () => {
    expect(await putIn()).toMatchObject({ of: 'done', kind: 'public' });
    expect(sends()).toEqual([`/api/accounts/c1/vaults/${VAULT}/public-deposit`]);
  });

  /*
   * RED WHEN: a retirement landing while the person reads the approval is not seen before the send, so public money goes
   * into a vault the company no longer adopts; or the person is told the deposit may have been sent, or not told why.
   */
  it('sends nothing into a vault retired while the person read the approval, and says so plainly', async () => {
    st.retiredMeanwhile = true;
    const ended = await putIn();
    expect(st.paid).toBe(1);
    expect(sends()).toEqual([]);
    expect(ended).toMatchObject({ of: 'failed', kind: 'public', signedNotSent: true });
    if (ended.of !== 'failed') throw new Error('the deposit did not fail');
    expect(ended.reasons[0]).toMatch(/^this page did not send the public deposit, because the company changed while you approved it in your wallet[^]*No money moved/);
  });

  /* RED WHEN: the view's own refusal of a vault the company no longer adopts is said as anything but that, or as a deposit that may have been sent. */
  it('says a vault the check found no longer adopted is retired, and that no money moved', async () => {
    const { depositPubliclyIntoCompanyVault, PublicDepositStoppedByAChange } = await import('vaults-web-shared/vault-public-deposit.js');
    const { marked } = await import('vaults-web-shared/vault-service-doors.js');
    const { VaultNotAdopted } = await import('vaults-web-shared/company-view-probe.js');
    const refusedByTheView = () => marked(async () => { throw Object.assign(new VaultNotAdopted(VAULT), { nothingWasSent: true, thisSendNotSent: true }); });
    const doors = {
      sleep: async () => {}, builder: await (await import('./vault-builder.js')).theVaultBuilder(), company: LABEL, account: ACCOUNT,
      onChain: async () => ({ holders: holders([VAULT]) }), indexer: async () => INDEXER,
      pay: async (ask: { transaction: string }) => ({ transaction: ask.transaction, leaves: [{ token: PUB, amount: '40', kind: 'unshielded' }] }),
      service: { depositPublicly: refusedByTheView },
    };
    const e = await depositPubliclyIntoCompanyVault(doors as never, VAULT as never, { token: PUB as never, value: 40n }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PublicDepositStoppedByAChange);
    expect((e as Error).message).toMatch(/^this page did not send the public deposit, because the company no longer adopts this vault[^]*No money moved[^]*retired vault/);
  });
});
