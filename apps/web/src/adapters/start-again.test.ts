// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * STARTING A KEPT CREATION AGAIN THROUGH THE ADAPTER, with the shared keyring's
 * check at its function: what the keyring says came of it is set by each test,
 * and what the adapter hands on and drops is read from the calls it makes.
 */
const kr = vi.hoisted(() => ({
  who: true, being: null as string | null, came: { of: 'dropped' } as unknown, throws: null as Error | null,
  calls: [] as string[], builders: [] as unknown[], changed: [] as (string | null)[],
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  startAnUnfinishedCreationAgain: async (id: string, _origin: string, builder: unknown) => {
    kr.calls.push(`again ${id}`);
    kr.builders.push(builder);
    if (kr.throws !== null) throw kr.throws;
    return kr.came;
  },
}));
vi.mock('./vault-builder.js', () => ({ theCreationBuilder: async () => ({ theBuilder: true }) }));
vi.mock('./keyring-person.js', () => ({ keyringFor: async () => kr.who }));
vi.mock('./creation-standing.js', async (real) => ({
  ...(await real<typeof import('./creation-standing.js')>()),
  creationChanged: (id: string | null) => { kr.changed.push(id); },
}));

async function load(origin = 'https://account.example') {
  vi.resetModules();
  vi.doMock('./session.js', async (real) => ({ ...(await real<typeof import('./session.js')>()), ACCOUNT_ORIGIN: origin }));
  return import('./start-again.js');
}
beforeEach(() => { kr.who = true; kr.being = null; kr.came = { of: 'dropped' }; kr.throws = null; kr.calls = []; kr.builders = []; kr.changed = []; });
afterEach(() => { vi.doUnmock('./session.js'); });

describe('starting again from the creation steps', () => {
  /* RED WHEN: a dropped creation is not handed on as done, or the cached read is left as it was. */
  it('drops the cached read of the company it dropped', async () => {
    const m = await load();
    expect(await m.startAgain('u1', 'c1')).toEqual({ of: 'done' });
    expect(kr.calls).toEqual(['again c1']);
    /* RED WHEN: the chain is read without the page's builder, which is what reads it at the wallet's indexer. */
    expect(kr.builders).toEqual([{ theBuilder: true }]);
    expect(kr.changed).toEqual(['c1']);
  });

  /* RED WHEN: with no company named, it starts some kept creation again, though several can be kept and only the one named is to be touched. */
  it('starts nothing again when no company is named, however many creations this browser keeps', async () => {
    const m = await load();
    kr.being = 'c7';
    expect(await m.startAgain('u1', null)).toEqual({ of: 'nothing' });
    expect(kr.calls).toEqual([]);
    expect(kr.changed).toEqual([]);
  });

  /* RED WHEN: a company this browser keeps no creation for ends as a failure with a generic message, or as set aside. */
  it('says there is nothing to start again for a company this browser keeps nothing for', async () => {
    const m = await load();
    const { NoCreationKeptHere } = await import('vaults-web-shared/keyring.js');
    kr.throws = new NoCreationKeptHere('none');
    expect(await m.startAgain('u1', 'c-unknown')).toEqual({ of: 'nothing' });
    expect(kr.changed).toEqual([]);
  });

  /* RED WHEN: a creation kept (landed, may still land, not confirmed) is handed on as done, or loses its words' kind. */
  it('hands on a creation that was kept by its kind and drops no cached read', async () => {
    const m = await load();
    kr.came = { of: 'on-the-chain' };
    expect(await m.startAgain('u1', 'c1')).toEqual({ of: 'landed' });
    kr.came = { of: 'may-still-land', minutes: 7 };
    expect(await m.startAgain('u1', 'c1')).toEqual({ of: 'wait', minutes: 7 });
    kr.came = { of: 'not-confirmed' };
    expect(await m.startAgain('u1', 'c1')).toEqual({ of: 'unsure' });
    expect(kr.changed).toEqual([]);
  });

  /* RED WHEN: a page not set up, a person not signed in, or a refusal of the keyring ends as done. */
  it('refuses for a page not set up, a person not signed in, and a keyring that refuses', async () => {
    let m = await load('');
    expect(await m.startAgain('u1', 'c1')).toMatchObject({ of: 'refused', why: 'not-set-up' });
    m = await load();
    kr.who = false;
    expect(await m.startAgain('u1', 'c1')).toMatchObject({ of: 'refused', why: 'not-signed-in' });
    kr.who = true; kr.throws = new Error('boom');
    expect(await m.startAgain('u1', 'c1')).toMatchObject({ of: 'refused' });
    expect(kr.changed).toEqual([]);
  });
});
