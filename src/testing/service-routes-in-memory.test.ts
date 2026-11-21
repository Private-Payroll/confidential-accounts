/*
 * The read routes a test's own service is given for the company's view: the reads of many records answered from the
 * service's reads of one, the newest version entered of each record read off what the service holds, and a directory the
 * test has to say it answers or holds no filing in: a route the test did not say anything about is refused, not answered as empty.
 */
import { describe, expect, it } from 'vitest';
import type { ServiceCall } from 'vaults-web-shared/records-source.js';
import { CompanyChangedMeanwhile } from 'vaults-web-shared/company-view-probe.js';
import { readRoutesOver, readRoutesOverSend } from './service-routes-in-memory.js';
import { viewOver } from './writes-over-a-send.js';

const CO = 'acc_routes';
const VAULT = 'ab'.repeat(32);

/** A service that answers only the reads of one record, and logs every path asked. */
const aService = () => {
  const asked: string[] = [];
  const call: ServiceCall = async (path) => {
    asked.push(path);
    if (path.endsWith('/versions')) return { versions: [{ version: 1 }, { version: 2 }] };
    return { filed: { version: 2 } };
  };
  return { asked, call };
};

const post = (records: unknown) => ({ method: 'POST', body: JSON.stringify({ records }) });

describe('A TEST\'S OWN SERVICE, GIVEN THE READ ROUTES THE COMPANY\'S VIEW ASKS', () => {
  it('answers a read of many company records from the service\'s read of each, in the order asked', async () => {
    const { asked, call } = aService();
    const answer = await readRoutesOver(call)(`/api/accounts/${CO}/records/read`, post([{ kind: 'person', id: 'p1' }, { kind: 'run', id: 'r1', every: true }]));
    /* RED WHEN: a read of many records is answered from another route than each record's own, or out of the order asked. */
    expect(asked).toEqual([`/api/accounts/${CO}/records/person/p1`, `/api/accounts/${CO}/records/run/r1/versions`]);
    expect(answer).toEqual({ records: [{ filed: { version: 2 } }, { versions: [{ version: 1 }, { version: 2 }] }] });
  });

  it('answers a read of many vault records the same way', async () => {
    const { asked, call } = aService();
    await readRoutesOver(call)(`/api/accounts/${CO}/vault-records/read`, post([{ vault: VAULT, record: 'pool' }, { vault: VAULT, record: 'payment-journal', every: true }]));
    /* RED WHEN: a read of many vault records reaches another route than each vault record's own. */
    expect(asked).toEqual([`/api/vaults/${VAULT}/records/pool`, `/api/vaults/${VAULT}/records/payment-journal/versions`]);
  });

  it('refuses the directory a test has not said what to do with, holds no filing where the test says so, and reads the newest entered off what the service holds', async () => {
    const { asked, call } = aService();
    const names = [{ store: 'company', kind: 'person', id: 'p1' }, { store: 'vault', kind: 'pool', id: VAULT }, { store: 'run', kind: 'run', id: 'r1' }];
    /* RED WHEN: a directory the test did not say anything about is answered as if no filing were made, so a filed entry is never missed. */
    await expect(readRoutesOver(call)(`/api/accounts/${CO}/directory`)).rejects.toThrow(/answers no directory/u);
    /* RED WHEN: a test that says its company has filed nothing is not answered an empty directory. */
    expect(await readRoutesOver(call, { directory: 'empty' })(`/api/accounts/${CO}/directory`)).toEqual({ filings: [] });
    expect(asked).toEqual([]);
    /* RED WHEN: the newest version entered is not the newest the service holds, for the stores whose records it serves, unless the test says it has entered none. */
    expect(await readRoutesOver(call)(`/api/accounts/${CO}/manifest/newest`, post(names))).toEqual({ versions: [2, 2, 0] });
    /* RED WHEN: a test that says its company has entered no record is answered the versions the service holds. */
    expect(await readRoutesOver(call, { newest: 'none-entered' })(`/api/accounts/${CO}/manifest/newest`, post(names))).toEqual({ versions: [0, 0, 0] });
  });

  it('lets a write through a view be refused for a record that moved after it was read, with the routes as given', async () => {
    let version = 1;
    const posted: string[] = [];
    const call: ServiceCall = async (path, init) => {
      if (init?.method === 'POST') { posted.push(path); return {}; }
      return path.endsWith('/versions') ? { versions: Array.from({ length: version }, (_, i) => ({ version: i + 1 })) } : { filed: { version } };
    };
    const view = viewOver(readRoutesOver(call, { directory: 'empty' }), CO).current();
    await view.newest([{ store: 'company', kind: 'person', id: 'p1' }]);
    version = 2;
    /* RED WHEN: the routes answer every record as never entered, so a record that moved after it was read cannot stop a write through a view. */
    await expect(view.write([{ to: 'roster', body: {} }])).rejects.toBeInstanceOf(CompanyChangedMeanwhile);
    expect(posted).toEqual([]);
  });

  it('leaves a route the test answers itself to the test, and any other path alone', async () => {
    const seen: string[] = [];
    const call: ServiceCall = async (path) => { seen.push(path); return { filings: [{ version: 1 }] }; };
    const routes = readRoutesOver(call, { directory: true, newest: 'by-the-test', joined: true });
    /* RED WHEN: a route the test answers itself is answered here instead, or a path that is no read route is changed. */
    expect(await routes(`/api/accounts/${CO}/directory`)).toEqual({ filings: [{ version: 1 }] });
    await routes(`/api/accounts/${CO}/manifest/newest`, post([]));
    await routes(`/api/accounts/${CO}/records/read`, post([]));
    await routes(`/api/accounts/${CO}/proposals`);
    expect(seen).toEqual([`/api/accounts/${CO}/directory`, `/api/accounts/${CO}/manifest/newest`, `/api/accounts/${CO}/records/read`, `/api/accounts/${CO}/proposals`]);
  });

  it('answers by status and body over a send, and passes what it does not answer to the send', async () => {
    const seen: string[] = [];
    const send = readRoutesOverSend(async (path) => { seen.push(path); return { status: 200, body: { filed: null } }; }, { directory: 'empty' });
    /* RED WHEN: a read answered here is given a status other than 200, or a path the send answers is not passed to it. */
    expect(await send(`/api/accounts/${CO}/directory`, { method: 'GET' })).toEqual({ status: 200, body: { filings: [] } });
    expect(await send(`/api/accounts/${CO}/records/read`, { method: 'POST', body: JSON.stringify({ records: [{ kind: 'person', id: 'p1' }] }) }))
      .toEqual({ status: 200, body: { records: [{ filed: null }] } });
    expect(await send(`/api/accounts/${CO}/people`, { method: 'GET' })).toEqual({ status: 200, body: { filed: null } });
    expect(seen).toEqual([`/api/accounts/${CO}/records/person/p1`, `/api/accounts/${CO}/people`]);
  });
});
