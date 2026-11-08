import { beforeEach, describe, expect, it, vi } from 'vitest';

/* The registry the removal's hook is read from reads the page's address when it loads. */
vi.hoisted(() => { Object.assign(globalThis, { window: { location: { hostname: 'localhost', origin: 'http://localhost', protocol: 'http:', href: 'http://localhost/' }, addEventListener: () => {}, removeEventListener: () => {} } }); });
import { readFileSync } from 'node:fs';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { intentShapeOf, routeOf, type ActIntent } from 'midnight-identity/profile/request';
import { StepRefused, type StepContext } from './definition.js';

/*
 * **A COMPANY'S VAULT SECRETS ARE CHANGED FROM THE WALLET: BY THE HOOK ONCE A REMOVAL IS CARRIED OUT, AND BY A SIGNER WHO
 * STAYS PRESSING FOR AN OWED CHANGE.** The one rotation is stood in here, so what each caller hands it can be tried: the
 * vaults it is run for, whether it may raise, the seat that left, and the company key's reads of who is leaving and who
 * was admitted; and what the page is told back, which is counts and never which vault. The rotation itself is run for
 * real in a-vaults-secret-change-runs-for-real-in-the-wallet.test.ts.
 */

const t = vi.hoisted(() => ({
  asked: [] as { doors: Record<string, unknown>; vaults: readonly string[]; may: string; o: Record<string, unknown> }[],
  answer: [] as { vault: string; state: string }[],
  order: [] as string[],
  leaving: async () => new Set<string>(['leaving']),
  admitted: async () => new Set<string>(['admitted']),
}));
vi.mock('../../../../packages/web-shared/src/vault-secret-rotated-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/vault-secret-rotated-here.js')>()),
  vaultSecretsRotatedHere: async (doors: Record<string, unknown>, vaults: readonly string[], may: string, o: Record<string, unknown> = {}) => {
    t.order.push('change');
    t.asked.push({ doors, vaults, may, o });
    return t.answer;
  },
}));
vi.mock('./vault-doors-here.js', async (real) => ({
  ...(await real<typeof import('./vault-doors-here.js')>()),
  vaultDoorsFor: () => ({ startedOn: 'the vault doors' }),
}));
vi.mock('./upkeep.js', async (real) => ({
  ...(await real<typeof import('./upkeep.js')>()),
  rotationDoorsIn: async () => ({ leaving: t.leaving, admitted: t.admitted }),
  upkeepSteps: () => ({
    first: { title: { key: 'act.upkeep.step.first' }, run: async () => { t.order.push('upkeep first'); } },
    last: { title: { key: 'act.upkeep.step.last' }, run: async () => { t.order.push('upkeep last'); } },
  }),
}));

const { afterARemoval } = await import('./registry.js');
const { rotateVaultSecretsAction } = await import('./rotate-vault-secrets.js');

const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const LEAVER = 'a4'.repeat(32);
const VAULTS = ['AB'.repeat(32), 'cd'.repeat(32)];
const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const BASE = { record: 'acc_1', company: LABEL, account: ACCOUNT };
const intent = (fields: Record<string, string>): ActIntent => ({ name: 'rotate-vault-secrets', fields }) as ActIntent;

let adopted: string[] = VAULTS;
const companyRead = () => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, stepTo: () => {},
  api: async () => { throw new Error('the change of the vault secrets calls nothing outside the rotation'); },
  holders: async () => ({ seats: [], adoptedVaults: adopted }),
  judges: { directoryHereFor: () => async () => ({ dir: { seats: [] } }) },
  companyKeys: {}, roster: async () => null,
});
const ctxOf = (i: ActIntent = intent(BASE)) => {
  const told: Record<string, unknown>[] = [];
  const ctx = { intent: i, person: 'usr_a', signal: new AbortController().signal, tell: (x: Record<string, unknown>) => { told.push(x); } } as unknown as StepContext;
  return { ctx, told };
};
const vaultReach = { secrets: () => ({}) as never, pause: async () => {}, indexerHttp: 'https://indexer.example' };
const pressReach = () => ({ ...vaultReach, chain: () => ({}) as never, builder: () => ({}) as never, reachFor: async () => companyRead() as never });
const run = async (i: ActIntent): Promise<Record<string, unknown>[]> => {
  const { ctx, told } = ctxOf(i);
  for (const step of rotateVaultSecretsAction(pressReach()).steps(i)) await step.run(ctx);
  return told;
};

beforeEach(() => {
  t.asked = []; t.answer = []; t.order = []; adopted = VAULTS;
});

describe('ONCE A REMOVAL IS CARRIED OUT, THE WALLET CHANGES THE SECRET OF EVERY VAULT THE ACCOUNT ADOPTED', () => {
  it('raises each change as a press would, names the seat that left, and tells the page only how many vaults ended in each state', async () => {
    t.answer = ['rotated', 'awaiting-approvals', 'owed', 'waits', 'not-this-seat', 'not-rotated', 'not-owed'].map((state) => ({ vault: VAULTS[1]!, state }));
    const { ctx } = ctxOf();
    const told = await afterARemoval(vaultReach).afterCarried!(ctx, companyRead() as never, { leaf: LEAVER, round: { id: 'prp_1', chainId: 'dd' } } as never);
    const asked = t.asked[0]!;
    /* RED WHEN: the change after a removal raises nothing, so no vault is ever changed until a signer presses. */
    expect(asked.may).toBe('raise');
    /* RED WHEN: the change is not told which seat left, so the wallet of that seat could make the new secret. */
    expect(asked.o).toEqual({ leaf: LEAVER });
    /* RED WHEN: a vault the account adopted is left out, or named in another spelling than the chain's lower case. */
    expect(asked.vaults).toEqual(VAULTS.map((v) => v.toLowerCase()));
    /* RED WHEN: the change runs on doors that do not read who is leaving and who was admitted as the company key's change does. */
    expect(asked.doors['leaving']).toBe(t.leaving);
    expect(asked.doors['admitted']).toBe(t.admitted);
    expect(asked.doors['startedOn']).toBe('the vault doors');
    expect(typeof asked.doors['directory']).toBe('function');
    /* RED WHEN: a vault is counted in the wrong state, a change that failed is told as one that waits, a vault that owed nothing is counted, or the page is told which vault. */
    expect(told).toEqual({ vaultsRotated: 1, vaultsAwaiting: 1, vaultsOwed: 1, vaultsWaiting: 2, vaultsNotChanged: 1 });
  });

  it('a company whose account adopted no vault changes nothing and counts nothing', async () => {
    adopted = [];
    const { ctx } = ctxOf();
    const told = await afterARemoval(vaultReach).afterCarried!(ctx, companyRead() as never, { leaf: LEAVER, round: { id: 'prp_1', chainId: 'dd' } } as never);
    /* RED WHEN: a company with no vault still runs the change, reading the company's key and directory for nothing. */
    expect(t.asked).toEqual([]);
    expect(told).toEqual({ vaultsRotated: 0, vaultsAwaiting: 0, vaultsOwed: 0, vaultsWaiting: 0, vaultsNotChanged: 0 });
  });
});

describe('A SIGNER WHO STAYS PRESSES TO CHANGE AN OWED VAULT SECRET', () => {
  it('raises the change for the vault the page names, or for every vault the account adopted, never naming a seat that left', async () => {
    await run(intent({ ...BASE, vault: VAULTS[0]! }));
    await run(intent(BASE));
    /* RED WHEN: the press only finishes, so a change whose maker's wallet was lost can never be raised again. */
    expect(t.asked.map((a) => a.may)).toEqual(['raise', 'raise']);
    /* RED WHEN: the press changes another vault than the one the page named, or not every adopted vault when it named none. */
    expect(t.asked.map((a) => a.vaults)).toEqual([[VAULTS[0]!.toLowerCase()], VAULTS.map((v) => v.toLowerCase())]);
    /* RED WHEN: a press names a seat that left, which only the removal's own change knows. */
    expect(t.asked.map((a) => a.o)).toEqual([{}, {}]);
  });

  it('runs what the company is owed of this seat first and last, around the change', async () => {
    await run(intent(BASE));
    /* RED WHEN: the change runs before the company key's change the upkeep makes, or the upkeep's anchor is not last. */
    expect(t.order).toEqual(['upkeep first', 'change', 'upkeep last']);
  });

  it('tells the page done when every vault is on its new secret or owed nothing, and partial with the counts when one is not', async () => {
    t.answer = [{ vault: VAULTS[0]!, state: 'rotated' }, { vault: VAULTS[1]!, state: 'not-owed' }];
    const done = await run(intent(BASE));
    t.answer = [{ vault: VAULTS[0]!, state: 'rotated' }, { vault: VAULTS[1]!, state: 'awaiting-approvals' }];
    const partial = await run(intent(BASE));
    /* RED WHEN: a press that left a vault waiting for approvals is told as done, or one that finished is told as partial. */
    expect(done).toContainEqual({ state: 'done', vaultsRotated: 1, vaultsAwaiting: 0, vaultsOwed: 0, vaultsWaiting: 0, vaultsNotChanged: 0 });
    expect(partial).toContainEqual({ state: 'partial', vaultsRotated: 1, vaultsAwaiting: 1, vaultsOwed: 0, vaultsWaiting: 0, vaultsNotChanged: 0 });
    t.answer = [{ vault: VAULTS[0]!, state: 'rotated' }, { vault: VAULTS[1]!, state: 'not-rotated' }];
    /* RED WHEN: a press whose change of a vault failed is told as done, or the failure is not counted on its own. */
    expect(await run(intent(BASE))).toContainEqual({ state: 'partial', vaultsRotated: 1, vaultsAwaiting: 0, vaultsOwed: 0, vaultsWaiting: 0, vaultsNotChanged: 1 });
  });

  it('refuses at its check a vault the page names that is not one, and a page that names no company, before anything is read', async () => {
    const act = rotateVaultSecretsAction(pressReach());
    /* RED WHEN: a vault that does not read as one passes the check, and the press runs on what the page made up. */
    expect(await act.check(intent({ ...BASE, vault: 'not-a-vault' }), {} as never)).toEqual({ key: 'act.rotate-vault-secrets.why.not-a-vault' });
    expect(await act.check(intent({ company: LABEL, account: ACCOUNT }), {} as never)).toEqual({ key: 'act.rotate-vault-secrets.why.not-a-company' });
    expect(await act.check(intent(BASE), {} as never)).toBeNull();
    expect(await act.check(intent({ ...BASE, vault: VAULTS[0]! }), {} as never)).toBeNull();
    const refused = await run(intent({ ...BASE, vault: 'not-a-vault' })).then(() => null, (e: unknown) => e);
    /* RED WHEN: the change step runs for a vault that does not read as one. */
    expect(refused).toBeInstanceOf(StepRefused);
    expect(t.asked).toEqual([]);
  });

  it('every call the change and its upkeep make is one the act lists, and every word it says is written', () => {
    const shape = intentShapeOf('rotate-vault-secrets')!;
    const calls: [string, string][] = [
      ['POST', '/api/accounts/acc_1/proposals'], ['POST', '/api/proposals/prp_1/send'], ['POST', '/api/proposals/prp_1/approve'],
      ['POST', '/api/proposals/prp_1/standing'], ['POST', '/api/proposals/prp_1/carried'],
      ['POST', `/api/accounts/acc_1/vaults/${VAULTS[1]}/start/secret`], ['POST', `/api/accounts/acc_1/vaults/${VAULTS[1]}/start/copy`],
      ['GET', `/api/vaults/${VAULTS[1]}/records/pool/versions`], ['PUT', `/api/vaults/${VAULTS[1]}/records/pool/2`],
      ['POST', '/api/accounts/acc_1/proven'], ['PUT', '/api/accounts/acc_1/directory/3'],
    ];
    /* RED WHEN: the page refuses a call the change of a vault's secret or its upkeep makes, so the press stops part way. */
    for (const [method, path] of calls) expect(routeOf(shape, method, path), `${method} ${path}`).not.toBeNull();
    /* RED WHEN: the act takes a field the page could use to name what it is not, beyond the company and one vault. */
    expect(Object.keys(shape.fields).sort()).toEqual(['account', 'company', 'record', 'vault']);
    const source = readFileSync(new URL('./rotate-vault-secrets.ts', import.meta.url), 'utf8');
    const keys = [...source.matchAll(/'(act\.rotate-vault-secrets\.[a-z.-]+)'/gu)].map((m) => m[1]!);
    const whys = [...source.matchAll(/why\('([a-z-]+)'/gu)].map((m) => m[1]!);
    const reads = ['not-a-company', 'no-saved-keys', 'no-seat', 'seat-not-held', 'not-on-chain', 'roster-not-opened'];
    /* RED WHEN: the proofs listed leave out the approval a seat makes when its raise does not count as one. */
    expect(WORDS['act.rotate-vault-secrets.shown.proofs']).toMatch(/one that approves it where your seat's raise does not already count as an approval/u);
    /* RED WHEN: the page is told a change that failed as one that waits. */
    expect(WORDS['act.rotate-vault-secrets.shown.nothing-else']).toMatch(/could not be changed on this press/u);
    /* RED WHEN: the wallet says a word its language file does not hold. */
    for (const k of [...keys, ...[...whys, ...reads].map((w) => `act.rotate-vault-secrets.why.${w}`)]) expect(WORDS[k], k).toBeTypeOf('string');
  });
});
