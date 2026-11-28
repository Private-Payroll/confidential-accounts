import { describe, expect, it } from 'vitest';
import type { RecordName } from '../../../src/midnight/record-tree.js';
import { companyViewFor, viewHeldOver, ViewEnded, type CompanyView, type HeldReader } from './company-view.js';
import {
  ANOTHER_SIGNER_CHANGED,
  Baseline,
  CompanyChangedMeanwhile,
  ENDED_BY_ANOTHER_SIGNER,
  GRANTS_NAME,
  holdersStandingOf,
  probe
} from './company-view-probe.js';
import { LANDED_EVERY_MS, LANDED_WITHIN_MS } from './watched-on-the-chain.js';
import { AskTooLong, serviceSource, superAdminAsks, treeServiceOf, type ServiceCall } from './records-source.js';
import type { ReadHere } from './records-anchored-here.js';
import { vaultsReadInTheView, withoutTheAccount } from './vaults-read-in-the-view.js';
import type { VaultOnChainOnTheWire } from './vault-worker-client.js';
import { vaultStandingHere } from './vault-read-here.js';

const COMPANY = 'c1';

/** A service in memory: the directory, the newest version entered of each record, and every call made to it. */
const aService = () => {
  const state = {
    directory: 2,
    newest: new Map<string, number>(),
    refuseWrites: false,
    dropAnswers: false,
    people: [] as unknown[]
  };
  const calls: { readonly path: string; readonly method: string; readonly body: any }[] = [];
  const call: ServiceCall = async (path, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ path, method, body });
    const p = path.split('?')[0]!;
    if (method !== 'GET' && !init?.read) {
      if (state.refuseWrites) throw new Error('refused');
      if (p.endsWith('/manifest/entries') || p.endsWith('/tree/headers'))
        for (const e of body.entries ?? [])
          state.newest.set(`${e.kind}:${e.id}`, Math.max(e.version, state.newest.get(`${e.kind}:${e.id}`) ?? 0));
      if (p.includes('/directory/')) state.directory = body.version;
      if (state.dropAnswers) throw new Error('the connection dropped');
      return { ok: true };
    }
    if (p.endsWith('/directory'))
      return { filings: Array.from({ length: state.directory }, (_, i) => ({ company: COMPANY, version: i + 1 })) };
    if (p.endsWith('/manifest/newest'))
      return { versions: body.records.map((r: RecordName) => state.newest.get(`${r.kind}:${r.id}`) ?? 0) };
    if (p.endsWith('/records/read') && !p.endsWith('/vault-records/read'))
      return {
        records: body.records.map((r: { kind: string; id: string }) => ({ kind: r.kind, id: r.id, filed: null }))
      };
    if (p.endsWith('/vault-records/read')) return { records: body.records.map(() => ({ filed: null })) };
    if (p.endsWith('/handovers'))
      return {
        handovers:
          body.people === undefined
            ? body.vendors.map((v: string) => ({ inbox: v === 'v-invited' ? 'sealed' : null }))
            : body.people.map(() => null)
      };
    if (p.endsWith('/proposals')) return { proposals: [] };
    if (p.endsWith('/people')) return { people: state.people };
    if (p.endsWith('/tree/pending')) return { entries: [] };
    return {};
  };
  return {
    state,
    calls,
    call,
    readsOf: (end: string) => calls.filter((c) => c.path.split('?')[0]!.endsWith(end)).length
  };
};

/** Who holds the company, as the chain answers it here. */
interface Holders {
  seats: string[];
  approvals: number;
  adoptedVaults: string[];
  threshold: number;
  committee: { tag: string; value: string }[];
  vaultThresholds: { vault: string; threshold: number }[];
  policyBar: number | null;
}
const seated = (...seats: string[]): Holders => ({
  seats,
  approvals: 1,
  adoptedVaults: ['v1'],
  threshold: 1,
  committee: [],
  vaultThresholds: [],
  policyBar: null
});

const holdersOf = (h: Holders) => ({
  holders: async () => h,
  onChain: async () => ({ landed: [], now: { approvals: 1 } }) as never,
  builder: { anchorHeads: async () => ({}) as never }
});

const NO_HELD: HeldReader = async () => ({}) as ReadHere;

const aView = (held: HeldReader = NO_HELD, filer?: string) => {
  const service = aService();
  const chain = seated('a', 'b');
  const view: CompanyView<Holders> = companyViewFor(
    serviceSource(service.call, COMPANY),
    { ...holdersOf(chain), ...(filer === undefined ? {} : { filer: () => filer }) },
    held
  );
  return { service, chain, view };
};

const person = (i: number) => ({ kind: 'person' as const, id: `p${i}` });

describe('the source names every path, and one ask carries at most one request of records', () => {
  it('refuses an ask of more records than one request carries, and sends nothing', async () => {
    const service = aService();
    const source = serviceSource(service.call, COMPANY);
    await expect(source.records(Array.from({ length: 257 }, (_, i) => person(i)))).rejects.toBeInstanceOf(AskTooLong);
    expect(service.calls).toHaveLength(0);
  });

  it('answers the record tree for its own company only', async () => {
    const tree = treeServiceOf(serviceSource(aService().call, COMPANY));
    await expect(tree.pending('another', '0x00')).rejects.toThrow(/another company/);
  });
});

describe('a view reads each thing once, however many ask, and joins what is asked together', () => {
  it('asks 300 records named in one turn in two requests, and nothing when they are asked again', async () => {
    const { service, view } = aView();
    const names = Array.from({ length: 300 }, (_, i) => person(i));
    await Promise.all([view.records(names.slice(0, 150)), view.records(names.slice(150))]);
    expect(service.readsOf('/records/read')).toBe(2);
    await view.records(names);
    expect(service.readsOf('/records/read')).toBe(2);
  });

  it('asks what vendors handed over in one request, answers each in the order asked, and nothing when asked again', async () => {
    const { service, view } = aView();
    const [first, second] = await Promise.all([
      view.vendorHandovers(['v-invited']),
      view.vendorHandovers(['v-not', 'v-invited'])
    ]);
    expect(service.readsOf('/handovers')).toBe(1);
    expect(service.calls.find((c) => c.path.endsWith('/handovers'))!.body).toEqual({ vendors: ['v-invited', 'v-not'] });
    expect(first).toEqual([{ inbox: 'sealed' }]);
    expect(second).toEqual([{ inbox: null }, { inbox: 'sealed' }]);
    await view.vendorHandovers(['v-not']);
    expect(service.readsOf('/handovers')).toBe(1);
    expect(view.counts()['vendorHandovers']).toBe(1);
  });

  it('reads the directory, a list, the account and who holds the company once each', async () => {
    const { service, view } = aView();
    await Promise.all([
      view.filings(),
      view.filings(),
      view.list('proposals'),
      view.list('proposals'),
      view.holders(),
      view.holders()
    ]);
    expect(service.readsOf('/directory')).toBe(1);
    expect(service.readsOf('/proposals')).toBe(1);
    expect(view.counts()['holders']).toBe(1);
  });

  it('proves every declared record in one held read, and reads held again only when something new is declared', async () => {
    const asked: unknown[] = [];
    const { view } = aView(async (_v, a) => {
      asked.push(a);
      return {} as ReadHere;
    });
    view.declare({ records: [{ store: 'company', ...person(1) }] });
    await Promise.all([view.held({ records: [{ store: 'company', ...person(2) }] }), view.held()]);
    expect(asked).toHaveLength(1);
    expect((asked[0] as { records: unknown[] }).records).toHaveLength(2);
    await view.held({ records: [{ store: 'company', ...person(1) }] });
    expect(asked).toHaveLength(1);
    await view.held({ kinds: [{ store: 'company', kind: 'run' }] });
    expect(asked).toHaveLength(2);
  });

  it("reads held again for no record of a kind already declared: the kind's read proves every record of it", async () => {
    const asked: unknown[] = [];
    const { view } = aView(async (_v, a) => {
      asked.push(a);
      return { records: { history: new Map(), notYetAnchored: [] } } as unknown as ReadHere;
    });
    const proposal = (id: string) => ({ store: 'proposal' as const, kind: 'proposal', id });
    await view.held({ kinds: [{ store: 'proposal', kind: 'proposal' }] });
    for (const id of ['p1', 'p2', 'p3']) await view.held({ records: [proposal(id)] });
    /* RED WHEN: each open proposal named after its kind was declared starts a held read of its own, so the reads grow with the proposals. */
    expect(asked).toHaveLength(1);
    await view.held({ records: [{ store: 'company', ...person(1) }] });
    /* RED WHEN: a record of a kind not declared is taken as proven by another kind's read. */
    expect(asked).toHaveLength(2);
    expect((asked[1] as { records: unknown[] }).records).toEqual([{ store: 'company', ...person(1) }]);
  });

  it("lets go of the held answer, what is built on it and the chain's head once, for a body newer than it, and never twice", async () => {
    let [held, chain, built] = [0, 0, 0];
    const view = companyViewFor(
      serviceSource(aService().call, COMPANY),
      {
        ...holdersOf(seated('a', 'b')),
        onChain: async () => {
          chain += 1;
          return { landed: [], now: { approvals: 1 } } as never;
        }
      },
      async () => {
        held += 1;
        return {} as ReadHere;
      }
    );
    const layer = () =>
      view.layer('believed', async () => {
        built += 1;
        return built;
      });
    await Promise.all([view.doors.onChain(), view.held(), layer(), view.newest([{ store: 'company', ...person(1) }])]);
    const newestBefore = view.counts()['newest']!;
    expect(await view.heldAgain()).toBe(true);
    await Promise.all([view.doors.onChain(), view.held(), layer(), view.newest([{ store: 'company', ...person(1) }])]);
    /* RED WHEN: the held answer, the directory built on it or the chain's head is kept, so a body read after it is judged by the same answer again. */
    expect([held, chain, built]).toEqual([2, 2, 2]);
    /* RED WHEN: the newest versions the held read is judged with are kept from before. */
    expect(view.counts()['newest']).toBe(newestBefore + 1);
    /* RED WHEN: a second body refused as newer reads held again: one fresh read a view, so a service changing records cannot keep a step reading. */
    expect(await view.heldAgain()).toBe(false);
    await view.held();
    expect(held).toBe(2);
  });

  it('keeps what it served when it lets go of held, so a write built on a version read before still stops', async () => {
    const { service, view } = aView();
    await view.newest([{ store: 'company', ...person(1) }]);
    service.state.newest.set('person:p1', 2);
    expect(await view.heldAgain()).toBe(true);
    expect(await view.newest([{ store: 'company', ...person(1) }])).toEqual([2]);
    /* RED WHEN: a fresh held read moves what the check compares, so a step that read version 0 writes past version 2. */
    await expect(view.write([{ to: 'roster', body: {} }])).rejects.toBeInstanceOf(CompanyChangedMeanwhile);
  });
});

describe("A VIEW READS WHO HOLDS THE ACCOUNT, THE COMMITTEE CHANGE OWED, THE VAULTS' READERS AND THE ROLES ONCE, AND SENDS THE CHANGE BY ITS OWN ROUTE", () => {
  it('reads each once, and the change owed and who holds the account again after the change is signed', async () => {
    const { service, view } = aView();
    await Promise.all([
      view.authority(),
      view.authority(),
      view.committeeChange(),
      view.committeeChange(),
      view.vaultKeys(),
      view.vaultKeys()
    ]);
    expect(['/authority', '/committee-change', '/vault-keys'].map((end) => service.readsOf(end))).toEqual([1, 1, 1]);
    await view.write([{ to: 'committee-change', act: 'signatures', body: { s: 1 } }]);
    expect(service.calls.at(-1)).toMatchObject({
      path: '/api/accounts/c1/committee-change/signatures',
      method: 'POST',
      body: { s: 1 }
    });
    await Promise.all([view.authority(), view.committeeChange(), view.vaultKeys()]);
    /* RED WHEN: after this device signed the change, the change owed or who holds the account is answered from before it. */
    expect(['/authority', '/committee-change', '/vault-keys'].map((end) => service.readsOf(end))).toEqual([2, 2, 1]);
    await view.write([{ to: 'committee-change', act: 'send', body: { u: 1 } }]);
    expect(service.calls.at(-1)).toMatchObject({
      path: '/api/accounts/c1/committee-change/send',
      method: 'POST',
      body: { u: 1 }
    });
    await view.write([{ to: 'roster', body: {} }]);
    await view.vaultKeys();
    /* RED WHEN: after the roster changed, the readers a vault is started for are answered from before it. */
    expect(service.readsOf('/vault-keys')).toBe(2);
  });

  it('sends no change of the committee once another signer changed the company', async () => {
    const { service, chain, view } = aView();
    await view.authority();
    chain.seats = ['a', 'b', 'c'];
    /* RED WHEN: a committee change is signed or sent without the check that the company is as it was read. */
    const stopped = view.write([{ to: 'committee-change', act: 'send', body: {} }]);
    await expect(stopped).rejects.toBeInstanceOf(CompanyChangedMeanwhile);
    /* RED WHEN: a write the check stopped is said as one that may have been sent. */
    await expect(stopped).rejects.toMatchObject({ nothingWasSent: true, thisSendNotSent: true });
    expect(service.calls.filter((c) => c.path.includes('/committee-change/'))).toEqual([]);
  });

  it('reads each role asked once, the ones not yet read together, again after a call reached the chain, and none without the door', async () => {
    const service = aService();
    const asked: string[][] = [];
    const roles = async (r: readonly string[]) => {
      asked.push([...r]);
      return { roles: r.map((key) => ({ key, value: `held-${key}` })) };
    };
    const view = companyViewFor(serviceSource(service.call, COMPANY), { ...holdersOf(seated('a')), roles }, NO_HELD);
    const [, yx] = await Promise.all([view.roles(['x', 'y']), view.roles(['y', 'x']), view.roles(['z'])]);
    expect(asked).toEqual([['x', 'y'], ['z']]);
    /* RED WHEN: an ask answered from what the view kept gives the roles in another order than asked. */
    expect(yx).toEqual({
      roles: [
        { key: 'y', value: 'held-y' },
        { key: 'x', value: 'held-x' }
      ]
    });
    /* RED WHEN: an ask whose keys were all read before is read again, or one with a key not yet read asks again for the keys already read. */
    expect(await view.roles(['z', 'x'])).toEqual({
      roles: [
        { key: 'z', value: 'held-z' },
        { key: 'x', value: 'held-x' }
      ]
    });
    expect(asked).toEqual([['x', 'y'], ['z']]);
    expect(await view.roles(['y', 'w'])).toEqual({
      roles: [
        { key: 'y', value: 'held-y' },
        { key: 'w', value: 'held-w' }
      ]
    });
    expect(asked).toEqual([['x', 'y'], ['z'], ['w']]);
    asked.length = 0;
    await view.write([{ to: 'proven', tx: 'ab' }]);
    await view.roles(['x', 'y']);
    /* RED WHEN: after a call reached the chain, the roles are answered from before it. */
    expect(asked).toEqual([['x', 'y']]);
    expect(view.counts()['roles']).toBe(4);
    await expect(aView().view.roles(['x'])).rejects.toThrow(/no way to read its roles/u);
  });

  it('keeps no role from an answer that does not name every key asked, and none once the view has ended', async () => {
    const service = aService();
    const asked: string[][] = [];
    let answer = (r: readonly string[]) => ({
      roles: r.slice(1).map((key) => ({ key, value: null as string | null }))
    });
    const roles = async (r: readonly string[]) => {
      asked.push([...r]);
      return answer(r);
    };
    const view = companyViewFor(serviceSource(service.call, COMPANY), { ...holdersOf(seated('a')), roles }, NO_HELD);
    /* RED WHEN: an answer that leaves out a key asked is given back as the chain's, or any key of it is kept. */
    expect(await view.roles(['x', 'y'])).toEqual({});
    answer = (r) => ({ roles: r.map((key) => ({ key, value: null })) });
    expect(await view.roles(['y'])).toEqual({ roles: [{ key: 'y', value: null }] });
    expect(asked).toEqual([['x', 'y'], ['y']]);
    /* RED WHEN: a role kept before the view ended is answered after it. */
    view.end('a reload');
    await expect(view.roles(['y'])).rejects.toBeInstanceOf(ViewEnded);
    expect(asked).toHaveLength(2);
  });

  it('asks and sends a change of the super admins by its own routes, each with the headers given', async () => {
    const service = aService();
    const headers: unknown[] = [];
    const asks = superAdminAsks(
      async (path, init) => {
        headers.push(init?.headers);
        return service.call(path, init);
      },
      COMPANY,
      async () => null
    );
    const h = { 'x-signed': 'yes' };
    await asks.raise({ r: 1 }, h);
    await asks.join({ j: 1 }, h);
    await asks.kept(h);
    await asks.keep({ k: 1 }, h);
    await asks.send({ u: 1 }, h);
    expect(service.calls.map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body ?? null)}`)).toEqual([
      'POST /api/accounts/c1/committee-change/raise {"r":1}',
      'POST /api/accounts/c1/committee-change/join {"j":1}',
      'GET /api/accounts/c1/committee-change/signatures null',
      'POST /api/accounts/c1/committee-change/signatures {"k":1}',
      'POST /api/accounts/c1/committee-change/send {"u":1}'
    ]);
    /* RED WHEN: an ask of a super admin's change goes without the signed request the service checks. */
    expect(headers).toEqual([h, h, h, h, h]);
  });
});

describe('a view writes only when the company is as it read it', () => {
  const entry = (id: string, version: number) =>
    ({ store: 'company', kind: 'person', id, version, digest: '0x00', filedBy: {} }) as never;
  /** `e`, filed by the seat whose filing key is `publicKey`. */
  const filedBy = (e: never, publicKey: string) =>
    ({ ...(e as object), filedBy: { publicKey, signature: '00' } }) as never;

  it('checks in three requests, then writes', async () => {
    const { service, view } = aView();
    await view.filings();
    await view.holders();
    const before = service.calls.length;
    await view.write([{ to: 'entries', entries: [entry('p1', 1)] }]);
    expect(service.calls.slice(before).map((c) => c.path.split('/').slice(-2).join('/'))).toEqual([
      'c1/directory',
      'manifest/newest',
      'manifest/entries'
    ]);
    expect(view.counts()['holders']).toBe(2);
  });

  it('stops before writing when another signer filed the directory meanwhile, and ends the view', async () => {
    const { service, view } = aView();
    await view.filings();
    service.state.directory = 3;
    await expect(view.write([{ to: 'entries', entries: [entry('p1', 1)] }])).rejects.toThrow(ANOTHER_SIGNER_CHANGED);
    expect(service.readsOf('/manifest/entries')).toBe(0);
    await expect(view.filings()).rejects.toBeInstanceOf(ViewEnded);
  });

  it('stops before writing when who holds the company changed on the chain', async () => {
    const { service, chain, view } = aView();
    await view.holders();
    chain.seats = ['a'];
    await expect(view.stillAsRead()).rejects.toBeInstanceOf(CompanyChangedMeanwhile);
    expect(service.readsOf('/manifest/entries')).toBe(0);
  });

  it('stops before writing when a record it served was entered again by someone else, naming it', async () => {
    const { service, view } = aView();
    await view.newest([{ store: 'company', ...person(7) }]);
    service.state.newest.set('person:p7', 4);
    const refused = await view.write([{ to: 'roster', body: {} }]).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CompanyChangedMeanwhile);
    expect((refused as CompanyChangedMeanwhile).moved).toEqual(['person p7']);
  });

  it('stops before its first write when the read grants moved after it began, though it never served them', async () => {
    const { service, view } = aView();
    await view.records([person(1)]);
    service.state.newest.set('grants:read-grants', 2);
    await expect(view.write([{ to: 'roster', body: {} }])).rejects.toBeInstanceOf(CompanyChangedMeanwhile);
    expect(service.readsOf('/roster')).toBe(0);
  });

  it('stops before writing when a record it served by name, or a vault record, was entered again by someone else', async () => {
    const { service, view } = aView();
    await view.records([person(3)]);
    await view.vaultRecords([{ vault: 'v1', record: 'pool' }]);
    service.state.newest.set('pool:v1', 5);
    service.state.newest.set('person:p3', 2);
    const refused = await view.write([{ to: 'roster', body: {} }]).catch((e: unknown) => e);
    expect((refused as CompanyChangedMeanwhile).moved).toEqual(['person p3', 'pool v1']);
  });

  it('stops before writing when a person the people list served was filed again by someone else, though never read by name', async () => {
    const { service, view } = aView();
    service.state.people = [{ filed: { kind: 'person', id: 'p5', version: 1 } }];
    service.state.newest.set('person:p5', 1);
    await view.list('people');
    service.state.newest.set('person:p5', 2);
    const refused = await view.write([{ to: 'roster', body: {} }]).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CompanyChangedMeanwhile);
    expect((refused as CompanyChangedMeanwhile).moved).toEqual(['person p5']);
    expect(service.readsOf('/roster')).toBe(0);
  });

  it('writes when a person the people list served is filed and not yet entered, and stops once someone else enters it', async () => {
    const { service, view } = aView();
    service.state.people = [{ filed: { kind: 'person', id: 'p6', version: 1 } }];
    await view.list('people');
    await view.write([{ to: 'roster', body: {} }]);
    service.state.newest.set('person:p6', 1);
    const refused = await view.write([{ to: 'roster', body: {} }]).catch((e: unknown) => e);
    expect((refused as CompanyChangedMeanwhile).moved).toEqual(['person p6']);
  });

  it('stops before writing when a record of a kind it read whole, named by the step, was entered again by someone else', async () => {
    const proposal = { store: 'proposal' as const, kind: 'proposal', id: 'p1' };
    /* The kind's held read proves the proposal at its version 1, and nothing newer waiting. */
    const heldAtOne = {
      records: { history: new Map([['proposal:proposal:p1', [{ version: 1 }]]]), notYetAnchored: [] }
    } as unknown as ReadHere;
    const { service, view } = aView(async () => heldAtOne);
    service.state.newest.set('proposal:p1', 1);
    await view.held({ kinds: [{ store: 'proposal', kind: 'proposal' }] });
    const asked = service.readsOf('/manifest/newest');
    await view.held({ records: [proposal] });
    /* RED WHEN: naming a record of a kind already read whole asks the service for its newest version again. */
    expect(service.readsOf('/manifest/newest')).toBe(asked);
    service.state.newest.set('proposal:p1', 2);
    /* RED WHEN: the step's write goes ahead though a proposal it named moved after the kind's read. */
    const refused = await view.write([{ to: 'roster', body: {} }]).catch((e: unknown) => e);
    expect((refused as CompanyChangedMeanwhile).moved).toEqual(['proposal p1']);
  });

  it('does not stop on a waiting entry of a record of a kind it read whole that the read saw and left out, and stops on one entered after it', async () => {
    const proposal = { store: 'proposal' as const, kind: 'proposal', id: 'p1' };
    /* The kind's held read believes the proposal at version 1, and saw version 2 waiting, filed by a seat it does not place. */
    const leftOut = {
      records: {
        history: new Map([['proposal:proposal:p1', [{ version: 1 }]]]),
        notYetAnchored: [],
        seenWaiting: new Map([['proposal:proposal:p1', 2]])
      }
    } as unknown as ReadHere;
    const { service, view } = aView(async () => leftOut);
    service.state.newest.set('proposal:p1', 2);
    await view.held({ kinds: [{ store: 'proposal', kind: 'proposal' }] });
    await view.held({ records: [proposal] });
    /* RED WHEN: an entry the service entered and the read set aside stops every write that names its record, on every device. */
    await expect(view.write([{ to: 'roster', body: {} }])).resolves.toHaveLength(1);
    /* Another seat enters version 3 once the held read has read what was waiting, before the step names the proposal. */
    let entering = (): void => undefined;
    const again = aView(async () => {
      entering();
      return leftOut;
    });
    entering = () => {
      again.service.state.newest.set('proposal:p1', 3);
    };
    again.service.state.newest.set('proposal:p1', 2);
    await again.view.held({ kinds: [{ store: 'proposal', kind: 'proposal' }] });
    await again.view.held({ records: [proposal] });
    /* RED WHEN: an entry made after the read is taken in, as a later read of the newest would take it, and the write goes ahead. */
    const refused = await again.view.write([{ to: 'roster', body: {} }]).catch((e: unknown) => e);
    expect((refused as CompanyChangedMeanwhile).moved).toEqual(['proposal p1']);
  });

  it('does not take a version that jumps past its own next one as its own', async () => {
    const { service, view } = aView();
    await view.newest([{ store: 'company', ...person(7) }]);
    await view.write([{ to: 'entries', entries: [entry('p7', 3)] }]);
    expect(service.state.newest.get('person:p7')).toBe(3);
    await expect(view.write([{ to: 'roster', body: {} }])).rejects.toBeInstanceOf(CompanyChangedMeanwhile);
  });

  it('takes the entries of its own a header it files carries as its own, and writes again', async () => {
    const { view } = aView(NO_HELD, 'aa'.repeat(32));
    await view.newest([{ store: 'company', ...person(7) }]);
    await view.write([{ to: 'header', header: {} as never, entries: [filedBy(entry('p7', 1), 'AA'.repeat(32))] }]);
    /* RED WHEN: a lost entry this device files again with its header is taken for another signer's change. */
    await expect(view.write([{ to: 'roster', body: {} }])).resolves.toHaveLength(1);
  });

  it("files a header again as a repair: past another signer's change, and never ending the view, refused or unanswered", async () => {
    const { service, view } = aView();
    await view.filings();
    service.state.directory = 3;
    /* RED WHEN: a repair is stopped by the check before a write, as though it changed what the step read. */
    await expect(view.tree.refileHeader!(COMPANY, {} as never, [])).resolves.toBe(true);
    expect(service.readsOf('/tree/headers')).toBe(1);
    service.state.refuseWrites = true;
    /* RED WHEN: a repair refused or unanswered ends the view, so the held read the repair was for throws ViewEnded. */
    await expect(view.tree.refileHeader!(COMPANY, {} as never, [])).resolves.toBe(false);
    expect(view.ended).toBeNull();
    const filings = service.readsOf('/directory');
    await Promise.all([view.filings(), view.filings()]);
    /* RED WHEN: a re-file keeps the filings a header write changes, or reads them more than once after. */
    expect(service.readsOf('/directory')).toBe(filings + 1);
  });

  it('takes its own entries a re-filed header carries as its own only when the service answered it kept', async () => {
    const own = [filedBy(entry('p7', 1), 'AA'.repeat(32))];
    const kept = aView(NO_HELD, 'aa'.repeat(32));
    await kept.view.newest([{ store: 'company', ...person(7) }]);
    await expect(kept.view.tree.refileHeader!(COMPANY, {} as never, own)).resolves.toBe(true);
    /* RED WHEN: a re-file the service kept is taken for another signer's change. */
    await expect(kept.view.write([{ to: 'roster', body: {} }])).resolves.toHaveLength(1);
    const lost = aView(NO_HELD, 'aa'.repeat(32));
    await lost.view.newest([{ store: 'company', ...person(7) }]);
    /* The entry is entered meanwhile, and the re-file's answer never comes back: whose version it is, is not known. */
    lost.service.state.dropAnswers = true;
    await expect(lost.view.tree.refileHeader!(COMPANY, {} as never, own)).resolves.toBe(false);
    lost.service.state.dropAnswers = false;
    /* RED WHEN: an unanswered re-file is taken as this device's own, so another seat's version entered meanwhile is passed over. */
    await expect(lost.view.write([{ to: 'roster', body: {} }])).rejects.toBeInstanceOf(CompanyChangedMeanwhile);
  });

  it("does not take another seat's entry a header it files carries as its own, so the next write stops on it", async () => {
    const { view } = aView(NO_HELD, 'aa'.repeat(32));
    await view.newest([{ store: 'company', ...person(7) }]);
    await view.write([{ to: 'header', header: {} as never, entries: [filedBy(entry('p7', 1), 'bb'.repeat(32))] }]);
    /* RED WHEN: another seat's entry the service lost, carried again by this device's header, moves the view's reading on, so a write built on the older version passes. */
    const refused = await view.write([{ to: 'roster', body: {} }]).catch((e: unknown) => e);
    expect((refused as CompanyChangedMeanwhile).moved).toEqual(['person p7']);
  });

  it('takes two versions of one record entered in one write as its own, whatever order they are given in', async () => {
    const { view } = aView();
    await view.newest([{ store: 'company', ...person(7) }]);
    await view.write([{ to: 'entries', entries: [entry('p7', 2), entry('p7', 1)] }]);
    /* RED WHEN: versions entered newest first move the baseline once, and the next write stops on its own entry. */
    await expect(view.write([{ to: 'roster', body: {} }])).resolves.toHaveLength(1);
  });

  it('takes its own entry of a directory version it read as its own, though the versions between were never entered', async () => {
    const { view } = aView();
    const directory = { store: 'directory', kind: 'directory', id: 'directory' } as const;
    await view.newest([directory]);
    await view.filings();
    await view.write([
      { to: 'entries', entries: [{ ...directory, version: 2, digest: '0x00', filedBy: {} } as never] }
    ]);
    /* RED WHEN: a device that passed over a directory version takes its own entry of the next one for another signer's change. */
    await expect(view.write([{ to: 'roster', body: {} }])).resolves.toHaveLength(1);
  });

  it('does not take an entry of a directory version past the one it read as its own', async () => {
    const { view } = aView();
    const directory = { store: 'directory', kind: 'directory', id: 'directory' } as const;
    await view.newest([directory]);
    await view.filings();
    await view.write([
      { to: 'entries', entries: [{ ...directory, version: 3, digest: '0x00', filedBy: {} } as never] }
    ]);
    /* RED WHEN: an entry of a directory version the view never read is taken as its own, so a change it never saw passes. */
    await expect(view.write([{ to: 'roster', body: {} }])).rejects.toBeInstanceOf(CompanyChangedMeanwhile);
  });

  it('sends a proven call through the service after the check, and reads the chain and held again after it', async () => {
    const service = aService();
    let [held, chain] = [0, 0];
    const counted = companyViewFor(
      serviceSource(service.call, COMPANY),
      {
        ...holdersOf(seated('a', 'b')),
        onChain: async () => {
          chain += 1;
          return { landed: [], now: { approvals: 1 } } as never;
        }
      },
      async () => {
        held += 1;
        return {} as ReadHere;
      }
    );
    await Promise.all([counted.doors.onChain(), counted.held()]);
    await counted.write([{ to: 'proven', tx: 'ab' }]);
    expect(service.calls.at(-1)).toMatchObject({ path: '/api/accounts/c1/proven', method: 'POST', body: { tx: 'ab' } });
    await Promise.all([counted.doors.onChain(), counted.held()]);
    /* RED WHEN: after its own call reached the chain, the view answers the anchors or held from before it. */
    expect([chain, held]).toEqual([2, 2]);
    /* RED WHEN: a read of the anchors asked fresh is answered from a kept one. */
    await counted.doors.onChainNow();
    expect(chain).toBe(3);
  });

  it('reads where a proposal stands and the call chain once, and again only after a proposal step or a call reached the chain', async () => {
    const { service, view } = aView();
    await Promise.all([view.standing('pr1'), view.standing('pr1'), view.callState(), view.callState()]);
    expect([service.readsOf('/standing'), service.readsOf('/call-state')]).toEqual([1, 1]);
    expect(service.calls.find((c) => c.path.endsWith('/standing'))).toMatchObject({
      path: '/api/proposals/pr1/standing',
      method: 'POST'
    });
    await view.write([{ to: 'proposal', id: 'pr1', act: 'approve', body: {} }]);
    await Promise.all([view.standing('pr1'), view.callState()]);
    /* RED WHEN: after a step of the proposal, where it stands or the call chain is answered from before it. */
    expect([service.readsOf('/standing'), service.readsOf('/call-state')]).toEqual([2, 2]);
  });

  it('sends a vault call by its own route, and reads the vault, the account and the list of vaults again after it', async () => {
    const service = aService();
    const held = viewHeldOver((from) =>
      companyViewFor(serviceSource(service.call, COMPANY), holdersOf(seated('a', 'b')), NO_HELD, from)
    );
    const reads = () => {
      const v = held.current();
      return Promise.all([
        v.vaultChain('v1'),
        v.payoutState('v1'),
        v.account(),
        v.list('vaults'),
        v.vaultRecords([{ vault: 'v1', record: 'pool' } as never])
      ]);
    };
    await reads();
    const first = held.current();
    await first.write([{ to: 'vault-send', tx: 'cd', calls: [{ act: 'deposit', vault: 'v1' }] }]);
    expect(service.calls.at(-1)).toMatchObject({
      path: '/api/accounts/c1/vaults/v1/deposit',
      method: 'POST',
      body: { tx: 'cd' }
    });
    /* RED WHEN: a send into a vault leaves the view open, where the same send through the runner's door ends it. */
    expect(first.endedAs).toBe('sent');
    await held.current().write([{ to: 'vault-send', tx: 'ef', calls: [{ act: 'deploy' }] }]);
    expect(service.calls.at(-1)).toMatchObject({ path: '/api/accounts/c1/vaults', method: 'POST', body: { tx: 'ef' } });
    await reads();
    /* RED WHEN: after a vault call reached the chain, the vault, its payouts, the account, the vaults or the vault's records are answered from before it. */
    /* The account once more: the check read it again before the first send, as it was served; the deploy's view had not read it. */
    expect(
      ['/chain', '/payout-state', '/accounts/c1', '/vault-records/read'].map((end) => service.readsOf(end))
    ).toEqual([2, 2, 3, 2]);
    expect(service.calls.filter((c) => c.method === 'GET' && c.path === '/api/accounts/c1/vaults')).toHaveLength(2);
  });

  it('sends no deposit, public or private, into a vault the holders it just read do not adopt', async () => {
    for (const act of ['deposit', 'public-deposit'] as const) {
      const { service, view } = aView();
      await view.account();
      /* RED WHEN: money goes into a vault the company's account does not adopt, which a vault's own deposits do not check. */
      await expect(view.write([{ to: 'vault-send', tx: 'cd', calls: [{ act, vault: 'v9' }] }])).rejects.toMatchObject({
        name: 'VaultNotAdopted',
        nothingWasSent: true
      });
      expect(
        service.calls.filter((c) => c.method === 'POST' && c.path.includes('/vaults/')),
        act
      ).toEqual([]);
      expect(view.endedAs, act).toBe('not-adopted');
    }
  });

  it('moves the reading by exactly the move its source gives a proposal step, and opens again from it', async () => {
    const service = aService();
    const chain = seated('a', 'b');
    const source = {
      ...serviceSource(service.call, COMPANY),
      movesOf: (w: { to: string }) =>
        w.to === 'proposal' ? <H extends Holders>(h: H): H => ({ ...h, seats: [...h.seats, 'c'] }) : undefined
    };
    const held = viewHeldOver((from) => companyViewFor(source as never, holdersOf(chain), NO_HELD, from));
    await held.current().account();
    await held.current().write([{ to: 'proposal', id: 'p1', act: 'carry', body: {} }]);
    chain.seats = ['a', 'b', 'c'];
    /* RED WHEN: the step's own declared move is taken for another signer's change at its next write. */
    await expect(held.current().write([{ to: 'roster', body: {} }])).resolves.toBeDefined();
    chain.seats = ['a', 'b', 'c', 'd'];
    /* RED WHEN: a change beyond the declared move passes. */
    await expect(held.current().write([{ to: 'roster', body: {} }])).rejects.toThrow(
      /Another signer changed the company/u
    );
  });

  it('reads the account and the vault keys offered again after a roster or vault keys write', async () => {
    const { service, view } = aView();
    await Promise.all([view.account(), view.list('vault-key-offers')]);
    await view.write([{ to: 'roster', body: {} }]);
    await Promise.all([view.account(), view.list('vault-key-offers')]);
    await view.write([{ to: 'vault-keys', body: {} }]);
    await view.list('vault-key-offers');
    /* Twice by the view, once after each write it changed, and twice by the check before each write, as it was served. */
    expect(service.readsOf('/accounts/c1')).toBe(4);
    expect(service.readsOf('/vault-keys/offers')).toBe(3);
  });

  it('builds what rests on the read grants again after writing them, and reads a vault record again after filing it', async () => {
    const { service, view } = aView();
    let built = 0;
    const layer = () =>
      view.layer('company-keys', async () => {
        built += 1;
        return built;
      });
    await layer();
    await view.write([{ to: 'record', kind: 'grants', id: 'read-grants', version: 2, body: {} }]);
    expect(await layer()).toBe(2);
    await view.vaultRecords([{ vault: 'v1', record: 'pool' }]);
    await view.write([{ to: 'vault-record', vault: 'v1', record: 'pool', version: 1, body: {} }]);
    await view.vaultRecords([{ vault: 'v1', record: 'pool' }]);
    expect(service.readsOf('/vault-records/read')).toBe(2);
    expect(service.calls.some((c) => c.method === 'PUT' && c.path === '/api/vaults/v1/records/pool/1')).toBe(true);
  });

  it('refuses the record tree and the chain once it has ended, and never answers them from before', async () => {
    const { view } = aView();
    await view.tree.pending(COMPANY, '0x01');
    view.end('a reload');
    await expect(view.tree.pending(COMPANY, '0x01')).rejects.toBeInstanceOf(ViewEnded);
    await expect(view.doors.onChain()).rejects.toBeInstanceOf(ViewEnded);
  });

  it('reads who holds the company again after a read of it failed', async () => {
    let fail = true;
    const doors = {
      ...holdersOf(seated('a')),
      holders: async () => {
        if (fail) throw new Error('no answer');
        return seated('a');
      }
    };
    const view = companyViewFor(serviceSource(aService().call, COMPANY), doors, NO_HELD);
    await expect(view.holders()).rejects.toThrow('no answer');
    fail = false;
    await expect(view.holders()).resolves.toEqual(seated('a'));
  });

  it('takes its own entry and its own directory filing as its own, and writes again', async () => {
    const { view } = aView();
    await view.newest([{ store: 'company', ...person(7) }]);
    await view.filings();
    await view.write([
      { to: 'entries', entries: [entry('p7', 1)] },
      { to: 'directory', filing: { company: COMPANY, version: 3 } as never }
    ]);
    await expect(view.write([{ to: 'roster', body: {} }])).resolves.toHaveLength(1);
  });

  it('reads the directory again after filing it, and never answers from what it kept before', async () => {
    const { service, view } = aView();
    await view.filings();
    await view.write([{ to: 'directory', filing: { company: COMPANY, version: 3 } as never }]);
    expect((await view.filings()).length).toBe(3);
    expect(service.readsOf('/directory')).toBe(3);
  });

  it('ends when a write is refused, and refuses every read after it', async () => {
    const { service, view } = aView();
    service.state.refuseWrites = true;
    await expect(view.write([{ to: 'roster', body: {} }])).rejects.toThrow('refused');
    expect(view.ended).not.toBeNull();
    await expect(view.records([person(1)])).rejects.toBeInstanceOf(ViewEnded);
  });
});

describe('WHAT A STEP BEFORE READ ONLY MAKES THE CHECK STRICTER', () => {
  it('keeps the lower of the version the view served and the one read before, never the higher', () => {
    const name = { store: 'company' as const, kind: 'person', id: 'p1' };
    const base = new Baseline();
    base.served(name, 3);
    base.readBefore(name, 5);
    /* RED WHEN: a version read elsewhere, newer than the view's own, lets a change the view's read would stop go through. */
    expect(base.versionOf(name)).toBe(3);
    base.readBefore(name, 2);
    /* RED WHEN: a draw's older version does not take the place of a newer one the view served, so a change since the draw passes. */
    expect(base.versionOf(name)).toBe(2);
    const fresh = new Baseline();
    fresh.readBefore(name, 4);
    expect(fresh.versionOf(name)).toBe(4);
  });
});

describe("AN INDEXER THAT DOES NOT SHOW THIS SIDE'S OWN SEND YET IS WAITED FOR, AND NOTHING ELSE IS", () => {
  /* A check after this side's own send moved who holds the company from two seats to three, reading holders `reads` in turn. */
  const checkAfterOwnMove = (...reads: Holders[]) => {
    const base = new Baseline();
    base.directory = 2;
    base.served(GRANTS_NAME, 0);
    base.holders = holdersStandingOf(seated('a', 'b'));
    base.moveHolders(holdersStandingOf(seated('a', 'b', 'c')));
    const pauses: number[] = [];
    const service = aService();
    const meanwhile = { onPause: (): void => undefined };
    let i = 0;
    const check = () =>
      probe(
        {
          source: serviceSource(service.call, COMPANY),
          holdersNow: async () => reads[Math.min(i++, reads.length - 1)]!,
          pause: async (ms) => {
            pauses.push(ms);
            meanwhile.onPause();
          }
        },
        base
      );
    return { base, pauses, check, service, meanwhile };
  };

  it('reads again while the indexer still shows the company as before the send, and goes on once it shows the send', async () => {
    const { base, pauses, check } = checkAfterOwnMove(seated('a', 'b'), seated('a', 'b'), seated('a', 'b', 'c'));
    /* RED WHEN: an indexer behind this side's own confirmed send stops the step as if another signer changed the company. */
    await expect(check()).resolves.toMatchObject({ seats: ['a', 'b', 'c'] });
    expect(pauses).toEqual([LANDED_EVERY_MS, LANDED_EVERY_MS]);
    expect(base.lagging).toBeNull();
  });

  it('reads the directory and the records again after the wait, so a change made while it waited stops the send', async () => {
    const { check, service, meanwhile } = checkAfterOwnMove(seated('a', 'b'), seated('a', 'b', 'c'));
    meanwhile.onPause = () => {
      service.state.directory = 3;
    };
    /* RED WHEN: another signer's filing made while the check waited for the indexer is compared against a read from before the wait. */
    await expect(check()).rejects.toMatchObject({ moved: ["the company's directory"] });
  });

  it('stops once a send is waited for as long as a call is on the chain and the indexer still does not show it', async () => {
    const { pauses, check } = checkAfterOwnMove(seated('a', 'b'));
    /* RED WHEN: a send the indexer never shows is taken as landed, or waited for without end. */
    await expect(check()).rejects.toBeInstanceOf(CompanyChangedMeanwhile);
    expect(pauses).toHaveLength(LANDED_WITHIN_MS / LANDED_EVERY_MS);
  });

  it('stops at once on anything else, and on the reading before the send once the indexer has shown the send', async () => {
    const other = checkAfterOwnMove(seated('a', 'd'));
    /* RED WHEN: a change by another signer is waited on as if it were the indexer's lag. */
    await expect(other.check()).rejects.toBeInstanceOf(CompanyChangedMeanwhile);
    expect(other.pauses).toEqual([]);
    const back = checkAfterOwnMove(seated('a', 'b', 'c'), seated('a', 'b'));
    await back.check();
    /* RED WHEN: once the indexer showed the send, the company read back as it was before it passes as the indexer's lag. */
    await expect(back.check()).rejects.toBeInstanceOf(CompanyChangedMeanwhile);
    expect(back.pauses).toEqual([]);
  });

  it('keeps the reading before the send across a view opened again after it', async () => {
    const service = aService();
    const chain = seated('a', 'b');
    const source = {
      ...serviceSource(service.call, COMPANY),
      movesOf: (w: { to: string }) =>
        w.to === 'proposal' ? <H extends Holders>(h: H): H => ({ ...h, seats: [...h.seats, 'c'] }) : undefined
    };
    const held = viewHeldOver((from) => companyViewFor(source as never, holdersOf(chain), NO_HELD, from));
    await held.current().account();
    await held.current().write([{ to: 'proposal', id: 'p1', act: 'carry', body: {} }]);
    /* RED WHEN: a view opened again after its own send forgets the reading before it, so a lagging indexer stops it at once. */
    expect(held.current().carried().lagging).toBe(holdersStandingOf(seated('a', 'b')));
  });
});

describe('WHO HOLDS THE COMPANY IS COMPARED BY ONE RULE, OVER ITS SEATS, ITS APPROVALS NEEDED AND ITS ADOPTED VAULTS', () => {
  const held = (over: Partial<Holders> = {}): Holders => ({
    seats: ['aa', 'bb'],
    approvals: 2,
    adoptedVaults: ['v1', 'v2'],
    threshold: 2,
    committee: [
      { tag: 'schnorr', value: 'face' },
      { tag: 'schnorr', value: 'feed' }
    ],
    vaultThresholds: [
      { vault: 'v1', threshold: 2 },
      { vault: 'v2', threshold: 1 }
    ],
    policyBar: 2,
    ...over
  });

  it('moves when a seat, the approvals needed or an adopted vault moves, and for nothing else', () => {
    const was = holdersStandingOf(held());
    /* RED WHEN: the order a read lists the seats or vaults in, or the case of their hex, is taken as a change by another signer. */
    expect(holdersStandingOf(held({ seats: ['BB', 'aa'], adoptedVaults: ['V2', 'v1'] }))).toBe(was);
    /* RED WHEN: a seat removed, the approvals changed or a vault no longer adopted compares equal to the company as it was read. */
    expect(holdersStandingOf(held({ seats: ['aa'] }))).not.toBe(was);
    expect(holdersStandingOf(held({ approvals: 3 }))).not.toBe(was);
    expect(holdersStandingOf(held({ adoptedVaults: ['v1'] }))).not.toBe(was);
  });

  it("moves when the committee, its threshold, a vault's own threshold or the policy bar moves, and not for their order", () => {
    const was = holdersStandingOf(held());
    expect(
      holdersStandingOf(
        held({
          committee: [
            { tag: 'schnorr', value: 'FEED' },
            { tag: 'schnorr', value: 'face' }
          ],
          vaultThresholds: [
            { vault: 'V2', threshold: 1 },
            { vault: 'v1', threshold: 2 }
          ]
        })
      )
    ).toBe(was);
    /* RED WHEN: the committee's threshold moved and the check compares the company as it was read. */
    expect(holdersStandingOf(held({ threshold: 3 }))).not.toBe(was);
    /* RED WHEN: the maintenance committee was replaced and the check compares the company as it was read. */
    expect(
      holdersStandingOf(
        held({
          committee: [
            { tag: 'schnorr', value: 'face' },
            { tag: 'schnorr', value: 'fade' }
          ]
        })
      )
    ).not.toBe(was);
    /* RED WHEN: a vault's own threshold moved and the check compares the company as it was read. */
    expect(
      holdersStandingOf(
        held({
          vaultThresholds: [
            { vault: 'v1', threshold: 3 },
            { vault: 'v2', threshold: 1 }
          ]
        })
      )
    ).not.toBe(was);
    /* RED WHEN: the bar a spending policy needs moved and the check compares the company as it was read. */
    expect(holdersStandingOf(held({ policyBar: null }))).not.toBe(was);
  });

  it('stops before a send when a vault the view read as adopted is no longer adopted, and ends the view as changed', async () => {
    const { chain, view } = aView();
    await view.holders();
    chain.adoptedVaults = [];
    /* RED WHEN: the check before a send does not compare the vaults adopted, so money goes into a vault the company let go of. */
    await expect(view.stillAsRead()).rejects.toBeInstanceOf(CompanyChangedMeanwhile);
    expect(view.ended).toBe(ENDED_BY_ANOTHER_SIGNER);
  });

  it('answers the check with who holds the company as the check read it', async () => {
    const chain = seated('a', 'b');
    const view = companyViewFor(
      serviceSource(aService().call, COMPANY),
      { ...holdersOf(chain), holders: async () => ({ ...chain }) },
      NO_HELD
    );
    await view.holders();
    chain.adoptedVaults = ['V1'];
    /* RED WHEN: the check answers with the holders the view read first, so a caller cannot judge the vault against the chain now. */
    await expect(view.stillAsRead()).resolves.toMatchObject({ adoptedVaults: ['V1'] });
  });
});

describe("a vault's start and a proposal carried go through the view to their own routes", () => {
  it("sends each step of a vault's start to its route and ends the view as sent, and tells a carried proposal without ending it", async () => {
    const { service, view } = aView();
    await view.write([{ to: 'carried', id: 'prp/1', body: { vault: 'v1' } }]);
    /* RED WHEN: a carried proposal is told to another route, or ends the view as if a call had gone to the chain. */
    expect(service.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/proposals/prp%2F1/carried',
      body: { vault: 'v1' }
    });
    expect(view.ended).toBeNull();
    for (const step of ['account', 'secret', 'copy'] as const) {
      const { service: s, view: v } = aView();
      await v.write([{ to: 'vault-start', vault: 'v2', step, body: { tx: 'AA' } }]);
      /* RED WHEN: a step of a vault's start goes to another route, or leaves the view open on a company its own send changed. */
      expect(s.calls.at(-1)).toMatchObject({
        method: 'POST',
        path: `/api/accounts/${COMPANY}/vaults/v2/start/${step}`,
        body: { tx: 'AA' }
      });
      expect(v.endedAs).toBe('sent');
    }
  });
});

describe('what a device reads of the company on the chain itself is never asked of the service', () => {
  it("answers the account's call state from the device's own door, and asks the service only a view given none", async () => {
    const service = aService();
    const refused = async (): Promise<never> => {
      throw new Error('not read here');
    };
    const chain = {
      callState: async () => ({ blockHash: 'b1' }),
      vaultChain: refused,
      payoutState: refused,
      authority: refused,
      committeeChange: refused,
      vaultKeys: refused
    };
    const own = companyViewFor(serviceSource(service.call, COMPANY), { ...holdersOf(seated('a')), chain }, NO_HELD);
    /* RED WHEN: the view asks the service for the account's call state though the device reads it on the chain itself. */
    expect(await own.callState()).toEqual({ blockHash: 'b1' });
    await expect(own.vaultKeys()).rejects.toThrow(/not read here/u);
    expect(service.calls.filter((c) => /call-state|vault-keys/u.test(c.path))).toEqual([]);
    const served = companyViewFor(serviceSource(service.call, COMPANY), holdersOf(seated('a')), NO_HELD);
    await served.callState();
    expect(service.calls.filter((c) => c.path.endsWith('/call-state'))).toHaveLength(1);
  });
});

describe('THE VAULTS A STEP STANDS ON ARE READ ONCE FOR IT, IN ITS VIEW', () => {
  const INDEXER = { indexerUri: 'https://indexer.example', indexerWsUri: 'wss://indexer.example' };
  const ACCOUNT = 'c0'.repeat(32) as never;
  const aVault = (vault: string): VaultOnChainOnTheWire => ({
    onChain: true,
    state: vault,
    notesFromThisBuild: true,
    everCreated: [],
    account: 'c0'.repeat(32),
    started: true,
    circuits: null,
    accountCircuits: null
  });
  /*
   * The builder standing in: each ask of many vaults named in `asked`, and whether it named the account in `named`;
   * `leave` drops the last vault from the next answer, `fail` refuses it, and an ask naming a vault in `unreadable` fails.
   */
  const aBuilder = () => {
    const b = {
      asked: [] as string[][],
      named: [] as boolean[],
      leave: false,
      fail: false,
      unreadable: new Set<string>()
    };
    return Object.assign(b, {
      vaultsOnChain: async (i: { vaults: readonly string[]; account?: string }) => {
        b.asked.push([...i.vaults]);
        b.named.push(i.account !== undefined);
        if (b.fail) {
          b.fail = false;
          throw new Error('the indexer did not answer');
        }
        if (i.vaults.some((v) => b.unreadable.has(v)))
          throw new Error(`vault ${i.vaults.find((v) => b.unreadable.has(v))} could not be read`);
        const answer = i.vaults.map(aVault);
        if (b.leave) {
          b.leave = false;
          answer.pop();
        }
        return answer;
      }
    });
  };

  it('READS EVERY VAULT ASKED IN ONE TURN AND EVERY VAULT DECLARED IN ONE ASK, AND ASKS NONE OF THEM AGAIN UNTIL THE VIEW WRITES', async () => {
    const { view } = aView();
    const b = aBuilder();
    const vaults = vaultsReadInTheView(() => view, b);
    vaults.declare(['V3']);
    const [one, two] = await Promise.all([
      vaults.read('v1' as never, INDEXER, ACCOUNT),
      vaults.read('v2' as never, INDEXER, ACCOUNT)
    ]);
    /* RED WHEN: each vault is asked on its own, or a declared vault is left to an ask of its own. */
    expect(b.asked).toEqual([['v1', 'v3', 'v2']]);
    expect([one!.onChain && one.state, two!.onChain && two.state]).toEqual(['v1', 'v2']);
    await vaults.read('v3' as never, INDEXER, ACCOUNT);
    await vaults.read('v1' as never, INDEXER, ACCOUNT);
    /* RED WHEN: a vault already read in this view is asked again before anything is written. */
    expect(b.asked).toHaveLength(1);
    await view.write([{ to: 'vault-record', vault: 'v1', record: 'pool', version: 1, body: {} }]);
    await vaults.read('v1' as never, INDEXER, ACCOUNT);
    /* RED WHEN: a read kept from before the view wrote is served after it. */
    expect(b.asked).toEqual([
      ['v1', 'v3', 'v2'],
      ['v1', 'v3']
    ]);
  });

  it('A VAULT THAT CANNOT BE READ FAILS ONLY ITSELF: EVERY OTHER VAULT OF THE STEP, AND OF THE SCREEN, IS READ', async () => {
    const { view } = aView();
    const b = aBuilder();
    b.unreadable.add('v2');
    const vaults = vaultsReadInTheView(() => view, b);
    vaults.declare(['v1', 'v2', 'v3']);
    const read = await Promise.allSettled(['v1', 'v2', 'v3'].map((v) => vaults.read(v as never, INDEXER, ACCOUNT)));
    /* RED WHEN: one vault that cannot be read fails every vault's read in the step, or is read as absent rather than refused. */
    expect(read.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect((read[1] as PromiseRejectedResult).reason).toEqual(new Error('vault v2 could not be read'));
    /* RED WHEN: the vaults are read one by one when nothing failed. */
    expect(b.asked).toEqual([['v1', 'v2', 'v3'], ['v1'], ['v2'], ['v3']]);
    /* RED WHEN: a vault whose read failed is asked again within the same view, so a builder that fails is asked once more for every later read. */
    await expect(vaults.read('v2' as never, INDEXER, ACCOUNT)).rejects.toThrow(/v2 could not be read/u);
    expect(b.asked).toHaveLength(4);
    const page = aBuilder();
    page.unreadable.add('v1');
    const shown = await Promise.allSettled(
      ['v1', 'v2'].map((v) => vaultsReadInTheView(() => aView().view, page).read(v as never, INDEXER))
    );
    /* RED WHEN: one vault a screen cannot read leaves every vault of the screen unread. */
    expect(shown.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
  });

  it('A BUILDER THAT FAILS EVERY ASK IS ASKED ONCE FOR THE VIEW AND ONCE FOR EACH VAULT, HOWEVER MANY READS THE VIEW MAKES', async () => {
    const { view } = aView();
    const b = aBuilder();
    for (const v of ['v1', 'v2', 'v3']) b.unreadable.add(v);
    const vaults = vaultsReadInTheView(() => view, b);
    vaults.declare(['v1', 'v2', 'v3']);
    await expect(vaults.read('v1' as never, INDEXER, ACCOUNT)).rejects.toThrow(/v1 could not be read/u);
    await expect(vaults.read('v2' as never, INDEXER, ACCOUNT)).rejects.toThrow(/v2 could not be read/u);
    /* RED WHEN: each read of the same view asks every vault again, 2 x (1 + 3) asks where 1 + 3 is the cost. */
    expect(b.asked).toEqual([['v1', 'v2', 'v3'], ['v1'], ['v2'], ['v3']]);
  });

  it("A HEALTHY VAULT'S READ DOES NOT WAIT ON A VAULT THAT FAILED", async () => {
    const { view } = aView();
    const b = aBuilder();
    b.unreadable.add('v2');
    let asksOfV2 = 0;
    const builder = {
      vaultsOnChain: (i: { vaults: readonly string[]; account?: string }) => {
        if (i.vaults.length === 1 && i.vaults[0] === 'v2' && ++asksOfV2 > 1) return new Promise<never>(() => {});
        return b.vaultsOnChain(i);
      }
    };
    const vaults = vaultsReadInTheView(() => view, builder);
    vaults.declare(['v1', 'v2', 'v3']);
    await vaults.read('v1' as never, INDEXER, ACCOUNT);
    const late = new Promise((r) => {
      setTimeout(() => r('still waiting'), 50);
    });
    /* RED WHEN: a read of a vault already kept waits for the failed vault to be asked again, here an ask that never answers. */
    expect(
      await Promise.race([vaults.read('v3' as never, INDEXER, ACCOUNT).then((r) => r.onChain && r.state), late])
    ).toBe('v3');
    expect(asksOfV2).toBe(1);
  });

  it("A VAULT THAT DOES NOT ANSWER HOLDS UP NO HEALTHY VAULT'S READ, BEFORE OR AFTER THE VIEW WRITES", async () => {
    const { view } = aView();
    const b = aBuilder();
    /* Every ask naming 'v2' waits until the test runs out its bound, as an indexer that never answers does. */
    const waiting: Array<() => void> = [];
    const builder = {
      vaultsOnChain: (i: { vaults: readonly string[]; account?: string }) =>
        i.vaults.includes('v2')
          ? new Promise<never>((_r, no) => {
              b.asked.push([...i.vaults]);
              waiting.push(() => no(new Error('the read ran out of time')));
            })
          : b.vaultsOnChain(i)
    };
    const settledSoon = <T>(p: Promise<T>) =>
      Promise.race([
        p.then(
          () => 'settled',
          () => 'settled'
        ),
        new Promise((r) => {
          setTimeout(() => r('waiting'), 30);
        })
      ]);
    const tick = () =>
      new Promise((r) => {
        setTimeout(r, 10);
      });
    const vaults = vaultsReadInTheView(() => view, builder);
    vaults.declare(['v1', 'v2', 'v3']);
    const one = vaults.read('v1' as never, INDEXER, ACCOUNT);
    await tick();
    waiting.shift()!();
    /* RED WHEN: a healthy vault waits for the vault that does not answer to run out its own ask too, or its read waits on another declared vault's. */
    expect(await settledSoon(one)).toBe('settled');
    expect(b.asked).toEqual([['v1', 'v2', 'v3'], ['v1'], ['v2'], ['v3']]);
    waiting.shift()!();
    await expect(vaults.read('v2' as never, INDEXER, ACCOUNT)).rejects.toThrow(/ran out of time/u);
    await view.write([{ to: 'vault-record', vault: 'v1', record: 'pool', version: 1, body: {} }]);
    const again = vaults.read('v2' as never, INDEXER, ACCOUNT);
    /* RED WHEN: after a write the vault that did not answer is joined with the healthy vaults again, so each of their reads waits out its bound once more. */
    expect(await settledSoon(vaults.read('v3' as never, INDEXER, ACCOUNT))).toBe('settled');
    /* RED WHEN: the vault that failed is not asked again after the write, or is asked with the others. */
    expect(b.asked.slice(4)).toEqual([['v2'], ['v1', 'v3']]);
    waiting.shift()!();
    await expect(again).rejects.toThrow(/ran out of time/u);
  });

  it('TAKES NO ANSWER THAT LEFT A VAULT OUT, KEEPS A FAILED READ ONLY FOR ITS VIEW, AND NOTHING FROM A VIEW THAT ENDED', async () => {
    const { view } = aView();
    const b = aBuilder();
    const vaults = vaultsReadInTheView(() => view, b);
    b.leave = true;
    /* RED WHEN: an answer that leaves a vault out is taken, so that vault reads as whatever comes next: each is read on its own instead. */
    const [one, two] = await Promise.all([
      vaults.read('v1' as never, INDEXER, ACCOUNT),
      vaults.read('v2' as never, INDEXER, ACCOUNT)
    ]);
    expect([one.onChain && one.state, two.onChain && two.state]).toEqual(['v1', 'v2']);
    expect(b.asked).toEqual([['v1', 'v2'], ['v1'], ['v2']]);
    b.asked.length = 0;
    b.fail = true;
    await expect(vaults.read('v3' as never, INDEXER, ACCOUNT)).rejects.toThrow(/did not answer/u);
    await expect(vaults.read('v3' as never, INDEXER, ACCOUNT)).rejects.toThrow(/did not answer/u);
    expect(b.asked).toEqual([['v3']]);
    /* RED WHEN: a failed read is served past its view: the next view asks the chain again. */
    const next = vaultsReadInTheView(() => aView().view, b);
    expect((await next.read('v3' as never, INDEXER, ACCOUNT)).onChain).toBe(true);
    expect(b.asked).toEqual([['v3'], ['v3']]);
    view.end('a reload');
    await expect(vaults.read('v1' as never, INDEXER, ACCOUNT)).rejects.toBeInstanceOf(ViewEnded);
  });

  it('A READ THAT NAMES NO ACCOUNT ASKS NO ACCOUNT, AND IS KEPT APART FROM ONE THAT DOES', async () => {
    const { view } = aView();
    const b = aBuilder();
    const vaults = vaultsReadInTheView(() => view, b);
    const [one, two] = await Promise.all([vaults.read('V1' as never, INDEXER), vaults.read('v2' as never, INDEXER)]);
    /* RED WHEN: a page's read of its vaults asks the account's circuits it never shows, or each vault is asked on its own. */
    expect([b.asked, b.named]).toEqual([[['v1', 'v2']], [false]]);
    expect([one.onChain && one.state, two.onChain && two.state]).toEqual(['v1', 'v2']);
    await vaults.read('v1' as never, INDEXER, ACCOUNT);
    /* RED WHEN: a read without the account's circuits answers one that asked for them. */
    expect([b.asked, b.named]).toEqual([
      [['v1', 'v2'], ['v1']],
      [false, true]
    ]);
  });

  it("A STANDING READ MADE AFTER THE STEP'S VIEW ENDED SAYS THE VIEW ENDED, NOT THAT THE CHAIN COULD NOT BE READ", async () => {
    const { view } = aView();
    const vaults = vaultsReadInTheView(() => view, aBuilder());
    view.end('changed');
    /* RED WHEN: the ended view is worded as a chain that could not be read, so the stop names the wrong remedy. */
    await expect(
      vaultStandingHere({ indexer: async () => INDEXER, account: ACCOUNT, vaultsHere: vaults } as never, 'v1' as never)
    ).rejects.toBeInstanceOf(ViewEnded);
  });

  it('A SEND THAT OPENS THE VIEW AGAIN READS THE VAULTS AGAIN, WHATEVER IT WAS SENT THROUGH', async () => {
    const service = aService();
    const held = viewHeldOver((from) =>
      companyViewFor(serviceSource(service.call, COMPANY), holdersOf(seated('a', 'b')), NO_HELD, from)
    );
    const b = aBuilder();
    const vaults = vaultsReadInTheView(() => held.current(), b);
    await vaults.read('v1' as never, INDEXER, ACCOUNT);
    held.current().end('a vault send through the chain', 'sent');
    await vaults.read('v1' as never, INDEXER, ACCOUNT);
    /* RED WHEN: a vault read before a send made outside the view's own writes is served after it. */
    expect(b.asked).toEqual([['v1'], ['v1']]);
  });

  it('A READ THAT DID NOT NAME THE ACCOUNT IS SERVED WITHOUT WHAT IT SAYS OF THE ACCOUNT', () => {
    expect(withoutTheAccount(aVault('v1'))).not.toHaveProperty('accountCircuits');
    expect(withoutTheAccount(aVault('v1'))).toMatchObject({ state: 'v1', circuits: null });
    expect(withoutTheAccount({ onChain: false })).toEqual({ onChain: false });
  });
});

/** A company whose handovers, invitations and account the test moves, as another seat or the service would. */
const aCompanyOfFacts = () => {
  const service = aService();
  const facts = {
    handovers: new Map<string, unknown>([['p1', { inbox: 'sealed to p1' }]]),
    vendorHandovers: new Map<string, unknown>([['v1', { inbox: 'sealed to v1' }]]),
    invites: [
      { kind: 'employee', subjectId: 'p1', role: 'payee', createdBy: 'u-a', createdAt: 't0' } as Record<string, unknown>
    ],
    /* The account as the service answers it: the sealed account with the newest roster filed beside it (index.ts withRoster). */
    account: {
      id: COMPANY,
      createdAt: 't0',
      keyEpoch: 1,
      signerCount: 1,
      memberUserIds: ['u-a'],
      pendingSigners: [],
      wrappedKeys: [{ signerId: 's-a', body: 'k-a' }],
      inboxPublicKey: 'ee',
      sealedPolicy: { body: 'p' },
      sealedRoster: { body: 'r1' },
      roster: { version: 1, body: 'r1' }
    } as Record<string, any>
  };
  const seen = (path: string, method: string, body?: unknown) => {
    service.calls.push({ path, method, body });
  };
  const call: ServiceCall = async (path, init) => {
    const p = path.split('?')[0]!;
    const method = init?.method ?? 'GET';
    if (method === 'GET' && p === `/api/accounts/${COMPANY}`) {
      seen(path, method);
      return structuredClone(facts.account);
    }
    if (method === 'GET' && p.endsWith('/invites')) {
      seen(path, method);
      return structuredClone(facts.invites);
    }
    if (p.endsWith('/handovers')) {
      const body = JSON.parse(String(init?.body));
      seen(path, method, body);
      return body.people === undefined
        ? { handovers: body.vendors.map((v: string) => facts.vendorHandovers.get(v) ?? { inbox: null }) }
        : { handovers: body.people.map((id: string) => facts.handovers.get(id) ?? { inbox: null }) };
    }
    /* The service, on an admission, lets the subject's handover go (people-route.ts). */
    if (p.endsWith('/admit')) {
      const id = decodeURIComponent(p.split('/').at(-2)!);
      facts.handovers.set(id, { inbox: null });
      facts.vendorHandovers.set(id, { inbox: null });
    }
    return service.call(path, init);
  };
  const view = companyViewFor(serviceSource(call, COMPANY), holdersOf(seated('a', 'b')), NO_HELD);
  return { service, facts, call, view };
};

const NOTHING_NEW = { to: 'entries' as const, entries: [] };

describe('the check reads again what a write rests on that carries no version', () => {
  it('stops a write when what a person or a vendor handed over moved meanwhile, read again from the service and not from the view', async () => {
    const { facts, view } = aCompanyOfFacts();
    await view.handovers(['p1']);
    facts.handovers.set('p1', { inbox: 'sealed to someone else' });
    /* RED WHEN: the check compares no handover, or reads it through the view's own kept answer. */
    await expect(view.write([NOTHING_NEW])).rejects.toMatchObject({
      moved: ['what p1 handed over'],
      nothingWasSent: true
    });
    const other = aCompanyOfFacts();
    await other.view.vendorHandovers(['v1']);
    other.facts.vendorHandovers.set('v1', { inbox: null });
    await expect(other.view.write([NOTHING_NEW])).rejects.toMatchObject({ moved: ['what the vendor v1 handed over'] });
  });

  it('reads every handover served again in one request, and nothing that was not served', async () => {
    const { service, view } = aCompanyOfFacts();
    await view.write([NOTHING_NEW]);
    /* RED WHEN: the check reads the account, the invitations or a handover no read of the step was answered with. */
    expect(['/handovers', '/invites', `/accounts/${COMPANY}`].map((end) => service.readsOf(end))).toEqual([0, 0, 0]);
    await view.handovers(['p1', 'p2', 'p3']);
    await view.write([NOTHING_NEW]);
    expect(service.readsOf('/handovers')).toBe(2);
    expect(service.calls.filter((c) => c.path.endsWith('/handovers')).at(-1)!.body).toEqual({
      people: ['p1', 'p2', 'p3']
    });
  });

  it("lets the view's own admission through, and its next write; another seat withdrawing the invitation stops the admission", async () => {
    const { view } = aCompanyOfFacts();
    await Promise.all([view.handovers(['p1']), view.list('invites')]);
    await view.write([{ to: 'person', id: 'p1', act: 'admit', body: {} }]);
    /* RED WHEN: the admission's own clearing of the handover is taken for another signer's change (its entries are then never written). */
    await expect(view.write([NOTHING_NEW])).resolves.toBeDefined();
    const vendor = aCompanyOfFacts();
    await Promise.all([vendor.view.vendorHandovers(['v1']), vendor.view.list('invites')]);
    await vendor.view.write([{ to: 'vendor-admitted', id: 'v1', body: {} }]);
    await expect(vendor.view.write([NOTHING_NEW])).resolves.toBeDefined();
    const withdrawn = aCompanyOfFacts();
    await Promise.all([withdrawn.view.handovers(['p1']), withdrawn.view.list('invites')]);
    withdrawn.facts.invites[0]!['revokedAt'] = 't1';
    /* RED WHEN: an invitation withdrawn after the step read the list is admitted all the same. */
    await expect(withdrawn.view.write([{ to: 'person', id: 'p1', act: 'admit', body: {} }])).rejects.toMatchObject({
      moved: ["the company's invitations"]
    });
  });

  it('takes an invitation accepted or a late seat asked for meanwhile for no change', async () => {
    const { facts, view } = aCompanyOfFacts();
    await view.list('invites');
    Object.assign(facts.invites[0]!, { acceptedAt: 't1', lateSeatRequests: [{ leaf: '00', userId: 'u-b', id: 'r1' }] });
    /* RED WHEN: the whole list is compared, so every payee accepting anywhere stops the company's writes. */
    await expect(view.write([NOTHING_NEW])).resolves.toBeDefined();
  });

  it("stops a write when the account's roster, waiting signers, wrapped keys or key epoch moved meanwhile, and for nothing else of it", async () => {
    const moves: readonly ((a: Record<string, any>) => void)[] = [
      (a) => {
        a['roster'] = { version: 2, body: 'r2' };
      },
      (a) => {
        a['sealedRoster'] = { body: 'r2' };
      },
      (a) => {
        a['pendingSigners'] = [{ id: 's-b', leaf: '00' }];
      },
      (a) => {
        a['wrappedKeys'] = [...a['wrappedKeys'], { signerId: 's-b', body: 'k-b' }];
      },
      (a) => {
        a['keyEpoch'] = 2;
      },
      (a) => {
        a['memberUserIds'] = ['u-a', 'u-b'];
      }
    ];
    for (const move of moves) {
      const { facts, view } = aCompanyOfFacts();
      await view.account();
      facts.account['inboxPublicKey'] = 'ff';
      await expect(view.write([NOTHING_NEW])).resolves.toBeDefined();
      move(facts.account);
      /* RED WHEN: a roster, a vault's keys or an admission are built on an account another seat changed after the step read it. */
      await expect(view.write([NOTHING_NEW])).rejects.toMatchObject({ moved: ["the company's account"] });
    }
  });

  it('serves the account the doors read and the one the view answers from one request', async () => {
    const { service, view } = aCompanyOfFacts();
    await Promise.all([view.doors.account(), view.account(), view.doors.account()]);
    expect(service.readsOf(`/accounts/${COMPANY}`)).toBe(1);
  });

  it('after its own write of a kind, serves the next read of it afresh and compares from there', async () => {
    const { facts, view } = aCompanyOfFacts();
    await view.account();
    await view.write([{ to: 'roster', body: {} }]);
    /* The roster filed is the step's own change, read afresh. */
    facts.account['roster'] = { version: 2, body: 'r2' };
    await view.account();
    await expect(view.write([NOTHING_NEW])).resolves.toBeDefined();
    facts.account['roster'] = { version: 3, body: 'r3' };
    /* RED WHEN: a step's write rests on an account read before its own write, never compared again. */
    await expect(view.write([NOTHING_NEW])).rejects.toMatchObject({ moved: ["the company's account"] });
  });

  it('gives the same facts for the same answer, whatever order its rows and fields come in', async () => {
    const { servedFactsOf } = await import('./records-source.js');
    const a = { kind: 'employee', subjectId: 'p1', role: 'payee' };
    const b = { subjectId: 'p2', kind: 'vendor', revokedAt: 't1' };
    expect(servedFactsOf('invites', [a, b])).toBe(
      servedFactsOf('invites', [{ ...b }, { role: 'payee', subjectId: 'p1', kind: 'employee' }])
    );
    expect(
      servedFactsOf('account', {
        pendingSigners: [{ id: 'x', b: 1 }, { id: 'y' }],
        wrappedKeys: [],
        memberUserIds: ['u2', 'u1']
      })
    ).toBe(
      servedFactsOf('account', {
        wrappedKeys: [],
        inboxPublicKey: 'other',
        memberUserIds: ['u1', 'u2'],
        pendingSigners: [{ id: 'y' }, { b: 1, id: 'x' }]
      })
    );
    expect(servedFactsOf('invites', [a])).not.toBe(servedFactsOf('invites', [{ ...a, revokedAt: 't1' }]));
  });
});

describe('a send is checked call by call', () => {
  it('sends no transaction one of whose calls deposits into a vault the company does not adopt', async () => {
    const { service, view } = aView();
    await view.holders();
    /* RED WHEN: only one call of a transaction is checked, so a second deposit goes into a vault the account does not adopt. */
    await expect(
      view.write([
        {
          to: 'vault-send',
          tx: 'aa',
          calls: [
            { act: 'deposit', vault: 'v1' },
            { act: 'deposit', vault: 'v9' }
          ]
        }
      ])
    ).rejects.toMatchObject({ name: 'VaultNotAdopted', vault: 'v9', nothingWasSent: true });
    expect(service.calls.filter((c) => c.method === 'POST' && c.path.includes('/vaults'))).toHaveLength(0);
  });

  it('sends no deposit into a vault an earlier write of the batch stopped adopting, and reads on from what landed', async () => {
    const service = aService();
    const retired = (h: Holders): Holders => ({ ...h, adoptedVaults: [] });
    const source = {
      ...serviceSource(service.call, COMPANY),
      movesOf: (w: { readonly to: string }) => (w.to === 'proposal' ? (retired as never) : undefined)
    };
    const view = companyViewFor(source, holdersOf(seated('a', 'b')), NO_HELD);
    await view.holders();
    const failed = await view
      .write([
        { to: 'proposal', id: 'r1', act: 'retirement', body: {} },
        { to: 'vault-send', tx: 'bb', calls: [{ act: 'deposit', vault: 'v1' }] }
      ])
      .catch((e: unknown) => e);
    /* RED WHEN: every deposit is checked only against the holders read before the batch, so it goes into the vault just retired. */
    expect(failed).toMatchObject({ name: 'VaultNotAdopted', vault: 'v1', thisSendNotSent: true });
    expect((failed as { nothingWasSent?: unknown }).nothingWasSent).toBeUndefined();
    expect(service.calls.filter((c) => c.path.endsWith('/vaults/v1/deposit'))).toHaveLength(0);
    /* RED WHEN: the reading stays where it was before the retirement that landed, so the next view stops as if another signer moved it. */
    expect(view.carried().holders).toBe(holdersStandingOf(retired(seated('a', 'b'))));
  });

  it("refuses at the service's door a transaction of more calls than its vault routes file, and sends nothing", async () => {
    const service = aService();
    await expect(
      serviceSource(service.call, COMPANY).write({
        to: 'vault-send',
        tx: 'cc',
        calls: [
          { act: 'payout', vault: 'v1' },
          { act: 'merge', vault: 'v1' }
        ]
      })
    ).rejects.toMatchObject({ nothingWasSent: true });
    expect(service.calls).toHaveLength(0);
  });
});

describe('an ended view lets go of what it read', () => {
  it('keeps no answer and no key a layer opened once it ends', async () => {
    const v8 = await import('node:v8');
    const vm = await import('node:vm');
    v8.setFlagsFromString('--expose_gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const { view } = aView();
    const refs: WeakRef<object>[] = [];
    await view
      .layer('company-keys', async () => {
        const keys = { opened: new Uint8Array(1 << 16) };
        refs.push(new WeakRef(keys));
        return keys;
      })
      .then(() => undefined);
    await view.account().then(() => undefined);
    view.end('the screen closed');
    for (let i = 0; i < 5 && refs[0]!.deref() !== undefined; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      gc();
    }
    /* RED WHEN: an ended view still holds the keys its layers opened for as long as anything holds the view. */
    expect(refs[0]!.deref()).toBeUndefined();
    await expect(view.layer('company-keys', async () => ({}))).rejects.toBeInstanceOf(ViewEnded);
  });
});

describe("the builder's doors and the rounds of reading again, through the view", () => {
  const INDEXER = { indexerUri: 'i', indexerWsUri: 'w' };
  it('reads the vaults on the chain through the door its opener gave, refuses plainly when it gave none, and nothing once ended', async () => {
    const { view } = aView();
    /* RED WHEN: a view given no way to read the vaults answers as if it read them, or fails with no word of the missing door. */
    await expect(view.doors.builder.vaultsOnChain({ vaults: ['v1'], indexer: INDEXER })).rejects.toThrow(
      /vaultsOnChain/u
    );
    const asked: string[][] = [];
    const given = companyViewFor(
      serviceSource(aService().call, COMPANY),
      {
        ...holdersOf(seated('a')),
        builder: {
          anchorHeads: async () => ({}) as never,
          vaultsOnChain: async (a) => {
            asked.push([...a.vaults]);
            return [];
          }
        }
      },
      NO_HELD
    );
    await given.doors.builder.vaultsOnChain({ vaults: ['v1'], indexer: INDEXER });
    expect(asked).toEqual([['v1']]);
    given.end('the screen closed');
    /* RED WHEN: an ended view still reads the chain for whoever kept its builder. */
    await expect(given.doors.builder.vaultsOnChain({ vaults: ['v1'], indexer: INDEXER })).rejects.toBeInstanceOf(
      ViewEnded
    );
    expect(asked).toHaveLength(1);
  });

  it('hands out rounds from 1, one for each press, and a write drops no count', async () => {
    const { view } = aView();
    const first = [view.nextRound(), view.nextRound()];
    await view.write([NOTHING_NEW]);
    /* RED WHEN: two presses share a round, or a write starts the rounds again, so a press is shown an earlier press's read. */
    expect([...first, view.nextRound()]).toEqual([1, 2, 3]);
  });
});

describe('THE CHECK BEFORE A WRITE ASKS THE NEWEST VERSIONS BY NAME ALONE', () => {
  it("a record served or read before with more than its name, a run's entry with its digest among them, is asked by its name only", () => {
    const base = new Baseline();
    const entry = {
      store: 'run',
      kind: 'run',
      id: 'run_aaaaaaaaaaa1',
      digest: 'ab'.repeat(32),
      version: 1
    } as unknown as RecordName;
    base.served(entry, 1);
    base.readBefore({ ...entry, id: 'run_aaaaaaaaaaa2' } as RecordName, 1);
    /* RED WHEN: a name keeps what else its entry carried, which the service's ask for the newest versions refuses with a 400. */
    expect(
      base
        .names()
        .slice(1)
        .map((n) => Object.keys(n).sort())
    ).toEqual([
      ['id', 'kind', 'store'],
      ['id', 'kind', 'store']
    ]);
  });
});
