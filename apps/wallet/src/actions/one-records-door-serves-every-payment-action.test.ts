import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { VIEWING_KEY_FIELD } from '../../scripts/viewing-key-tripwire.mjs';
import { treeKeptInMemory } from '../../../../packages/web-shared/src/tree-kept-here.js';

/*
 * **ONE RECORDS DOOR FOR EVERY PAYMENT ACTION IN THE WALLET.** A one-off payment and a payroll run read the company's
 * records through the same door (`companyRecordsFor`, company-reach.ts), so what a payment decides on is read one way:
 * the people and vendors as every device judges them, the ceilings from the roster this wallet opens, the heads this
 * wallet checked itself, and the chain through this wallet's own indexer with this seat. Pinned here: what each part
 * reads, and that no payment action builds a door of its own beside it.
 */

const t = vi.hoisted(() => ({ readers: [] as unknown[] }));
vi.mock('../../../../packages/web-shared/src/people-read-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/people-read-here.js')>()),
  readPeopleHere: async (d: unknown) => { t.readers.push(d); return { people: [], notBelieved: [], notPayable: [] }; },
}));

const { companyRecordsFor, paidAmongFor } = await import('./company-reach.js');

const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const SEAT = { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: '04'.repeat(32) };
const KEYS = { epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }) };

const reachOf = (log: string[]) => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: SEAT, leaf: 'aa'.repeat(32), companyKey: '11'.repeat(32),
  api: async (path: string, init?: RequestInit) => { log.push(`api ${init?.method ?? 'GET'} ${path}`); return []; },
  send: async (path: string, init: { method: string }) => { log.push(`send ${init.method} ${path}`); return { status: 200, body: {} }; },
  judges: {
    directoryHereFor: () => async () => ({ dir: { seats: [] }, leafOf: () => null, records: { history: new Map() } }),
    filingJudgeFor: () => async () => null,
  },
  companyKeys: KEYS,
  roster: async () => ({ id: 'acc_1', signers: [], policy: { threshold: 2, limitsByRole: { admin: {} } } }),
  builder: {
    roundsOnChain: async (q: { seat?: string; indexer: unknown }) => { log.push(`rounds seat=${q.seat} ${JSON.stringify(q.indexer)}`); return {}; },
  },
  chain: {
    indexer: { indexerUri: 'https://indexer.wallet.example', indexerWsUri: 'wss://indexer.wallet.example' },
    payments: async (_a: string, _l: string, entries: string[]) => { log.push(`payments ${entries.join(',')}`); return { payKeyCommitment: null, held: [entries[1]], openRounds: [], entries: entries.length }; },
    roles: async () => [],
  },
});
const PURE = { account: { paidMovementOf: (b: Uint8Array) => b.map((x) => x ^ 1), paidOnceOf: (b: Uint8Array) => b }, details: {} } as never;
const code = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

describe('ONE RECORDS DOOR SERVES EVERY PAYMENT ACTION, FROM THIS WALLET\'S OWN READS', () => {
  it('reads the people, the ceilings, the checked heads, the payments and where proposals stand where this wallet reads them', async () => {
    const log: string[] = [];
    const r = reachOf(log);
    const tree = treeKeptInMemory();
    const heads = { latest: { seq: 3, head: 'ab'.repeat(32) }, fromZero: null, heads: ['ab'.repeat(32)], count: 1 };
    await tree.checked.write('acc_1', heads as never);
    const records = companyRecordsFor(r as never, { treeKept: () => tree }, PURE);
    /* RED WHEN: a run is drawn or raised over people this wallet did not read and judge itself, with the company's own keys. */
    await records.people();
    const reader = t.readers[0] as { company: { id: string } & Record<string, unknown>; directory: unknown; send: (p: string, i: { method: string }) => Promise<unknown> };
    expect(reader.company.id).toBe('acc_1');
    expect(reader.company[VIEWING_KEY_FIELD]).toBe(KEYS);
    await reader.send('/api/accounts/acc_1/people', { method: 'GET' });
    /* RED WHEN: reading the company's people can write anything to the service. */
    await expect(reader.send('/api/accounts/acc_1/people', { method: 'POST' })).rejects.toThrow(/writes nothing/u);
    /* RED WHEN: the company's ceilings come from anything but the roster this wallet opens. */
    expect(await records.policy()).toEqual({ threshold: 2, limitsByRole: { admin: {} } });
    /* RED WHEN: the head a raise vouches for is not one this wallet checked itself. */
    expect(await records.checked!()).toEqual(heads);
    /* RED WHEN: what the account records as paid, or where a proposal stands, is read from anything but this wallet's indexer with this seat. */
    const paid = await paidAmongFor(records, PURE)(['00'.repeat(32), '02'.repeat(32)] as never);
    expect(paid).toEqual({ known: true, paid: ['02'.repeat(32)] });
    await records.roundsOnChain!(['ab'.repeat(32)]);
    expect(log).toEqual([
      'send GET /api/accounts/acc_1/people',
      `payments ${'01'.repeat(32)},${'03'.repeat(32)}`,
      `rounds seat=${SEAT.signingSecret} ${JSON.stringify(r.chain.indexer)}`,
    ]);
    /* RED WHEN: a payment can file a spending policy through the records it reads. */
    await expect(records.spendingPolicies!.file({} as never)).rejects.toThrow(/files no spending policy/u);
  });

  it('no payment action builds a records door of its own beside the one door', () => {
    for (const file of ['./one-off-payment.ts', './raise-run.ts']) {
      const text = code(file);
      /* RED WHEN: a payment action reads the company's records through a door it builds itself, so two doors read them two ways. */
      expect(text, file).toMatch(/\bcompanyRecordsFor\(/u);
      for (const own of [/\bpaidMovementOf:\s*\(/u, /\bspendingPolicies:\s*\{/u, /\bchainReadThroughTheWallet\(/u, /\bimport\('[./]*contracts\/managed\/contract\/index\.js'\)/u]) {
        expect(text, `${file} ${own}`).not.toMatch(own);
      }
    }
  });
});
