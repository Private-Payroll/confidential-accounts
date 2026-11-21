/*
 * A roster's reads and writes go through the view of the company: the account, the proposals, the open offers, every
 * version of the roster, the manifest and each write.
 */
import { describe, expect, it } from 'vitest';
import { rosterServiceOf, type RosterView } from './roster-through-the-view.js';
import { viewOver } from '../../../src/testing/writes-over-a-send.js';
import { readRoutesOver } from '../../../src/testing/service-routes-in-memory.js';

const viewThatKeeps = () => {
  const asked: string[] = [];
  const view: RosterView = {
    account: async () => { asked.push('account'); return { id: 'acc_1' }; },
    list: async (kind) => { asked.push(`list ${kind}`); return []; },
    records: async (r) => { asked.push(`records ${r.map((x) => `${x.kind}:${x.id}:${x.every === true}`).join()}`); return [{ versions: [] }]; },
    manifest: { newest: async () => { asked.push('newest'); return []; }, enter: async () => { asked.push('enter'); } },
    write: async (batch) => { asked.push(...batch.map((w) => `write ${w.to}`)); return batch.map(() => ({})); },
  };
  return { asked, view };
};

describe('A ROSTER IS READ AND FILED THROUGH THE COMPANY\'S VIEW', () => {
  it('reads and writes every part of the roster through the view, and nothing over the sign-in', async () => {
    const { asked, view } = viewThatKeeps();
    const s = rosterServiceOf({ accountId: 'acc_1', view: { current: () => view } });
    await s.account(); await s.proposals(); await s.offers(); await s.rosterVersions();
    expect(await s.first('state', 'founding')).toBeNull();
    await s.manifest.newest('acc_1', []); await s.manifest.enter('acc_1', []);
    await s.file({ to: 'roster', body: {} }); await s.file({ to: 'admission', signer: 's1', body: {} }); await s.file({ to: 'vault-keys', body: {} });
    /* RED WHEN: a read or a write of the roster goes around the view, so the view's check does not run before the roster's writes. */
    expect(asked).toEqual([
      'account', 'list proposals', 'list vault-key-offers', 'records roster:signers:true', 'records state:founding:true', 'newest', 'enter',
      'write roster', 'write admission', 'write vault-keys',
    ]);
  });

  it('reaches each record\'s own route through a view over the service', async () => {
    const paths: string[] = [];
    const s = rosterServiceOf({ accountId: 'acc_1', view: viewOver(async (path: string, init?: RequestInit) => { paths.push(`${init?.method ?? 'GET'} ${path}`); return readRoutesOver(async () => ({ filed: null }), { directory: 'empty', newest: 'none-entered' })(path, init); }, 'acc_1') });
    await s.account(); await s.proposals(); await s.offers();
    await s.file({ to: 'roster', body: {} }); await s.file({ to: 'admission', signer: 's 1', body: {} }); await s.file({ to: 'vault-keys', body: {} });
    /*
     * RED WHEN: a read or write of the roster reaches another route than its own, or names the signer it admits unescaped, or a
     * write is sent without the view having read the company's directory and the newest versions just before it.
     */
    const check = ['GET /api/accounts/acc_1/directory', 'POST /api/accounts/acc_1/manifest/newest'];
    expect(paths).toEqual([
      ...check, 'GET /api/accounts/acc_1', 'GET /api/accounts/acc_1/proposals', 'GET /api/accounts/acc_1/vault-keys/offers',
      ...check, 'POST /api/accounts/acc_1/roster', ...check, 'POST /api/accounts/acc_1/signers/s%201/admit', ...check, 'PUT /api/accounts/acc_1/vault-keys',
    ]);
  });
});
