import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  NETWORK_IDS, endpointsOf, isNetworkId, networkRecord, recordsFrom, shownAddress, shownAddressesIn, websocketNodeOf,
} from './networks.js';

/**
 * **EVERY REFUSAL IN THE RECORD READER, WATCHED REFUSING.**
 *
 * The reader's whole job is to say no: to a document from a version it does not
 * read, to a record missing a field, to a record whose key and id disagree, to
 * a name nobody has written a record for. **A refusal nobody has seen say no is
 * a claim**, so each one below is driven with the shape that should trigger it
 * and with a neighbouring shape that should not.
 *
 * The document itself is checked separately, against the file on disk, because
 * a reader that parses anything correctly still tells you nothing about whether
 * the records are right.
 */

const AT_LEAST_ONE = (id: string) => ({
  version: 1,
  networks: { [id]: { id, kind: 'test', label: 'A network', testToken: null, endpoints: null } },
});

describe('§1 the document, and what the reader will not take', () => {
  it('takes a well-formed document, so the refusals below are not the only outcome', () => {
    const read = recordsFrom(AT_LEAST_ONE('stagenet'));
    expect([...read.keys()]).toEqual(['stagenet']);
    expect(read.get('stagenet')!.kind).toBe('test');
    expect(read.get('stagenet')!.endpoints).toBeNull();
  });

  it('REFUSES a version it does not read, rather than hoping the shape is the same', () => {
    /* RED WHEN a document from another version is read as though it were this
     * one. A field that has moved is read as the field that used to be there. */
    expect(() => recordsFrom({ ...AT_LEAST_ONE('stagenet'), version: 2 }))
      .toThrow(/its version is 2 and this build reads version 1/);
    expect(() => recordsFrom({ networks: {} })).toThrow(/version is undefined/);
  });

  it('REFUSES a document with no networks in it', () => {
    /* RED WHEN an empty file is accepted, which would make every network name
     * unknown and every door refuse for a reason that points at the wrong
     * thing. */
    expect(() => recordsFrom({ version: 1, networks: {} })).toThrow(/carries no networks at all/);
    expect(() => recordsFrom({ version: 1 })).toThrow(/carries no networks object/);
    expect(() => recordsFrom('stagenet')).toThrow(/it is not an object/);
  });

  it('REFUSES A RECORD MISSING A FIELD, AND `null` IS NOT MISSING', () => {
    const ok = { id: 'stagenet', kind: 'test', label: 'A network', testToken: null, endpoints: null };
    for (const field of ['id', 'kind', 'label', 'testToken', 'endpoints']) {
      const short: Record<string, unknown> = { ...ok };
      delete short[field];
      /*
       * RED WHEN an absent key is defaulted by whichever reader meets it
       * first. Saying a network has no faucet and forgetting to say are
       * different acts and must have different outcomes.
       */
      expect(() => recordsFrom({ version: 1, networks: { stagenet: short } }), field)
        .toThrow(new RegExp(`has no "${field}" key`));
    }
    /* And the same record with every field present is taken. */
    expect(() => recordsFrom({ version: 1, networks: { stagenet: ok } })).not.toThrow();
  });

  it('REFUSES a record whose key and id disagree', () => {
    /*
     * RED WHEN the two may differ. Everything resolves a network by the key and
     * everything hands the platform the id, so a record where they disagree is
     * a deployment reaching one network's endpoints while writing another
     * network's addresses.
     */
    expect(() => recordsFrom({
      version: 1,
      networks: { stagenet: { id: 'preview', kind: 'test', label: 'x', testToken: null, endpoints: null } },
    })).toThrow(/carries the id "preview", and a record's key is its id/);
  });

  it('REFUSES a kind that is neither test nor real', () => {
    /*
     * RED WHEN a third kind is allowed. Every consumer asks "is this test?" or
     * "is this real?"; a third answer is answered by whichever of the two the
     * asking code happens to have written.
     */
    for (const kind of ['testing', 'Test', '', 'staging', null, 1]) {
      expect(() => recordsFrom({
        version: 1, networks: { stagenet: { id: 'stagenet', kind, label: 'x', testToken: null, endpoints: null } },
      }), JSON.stringify(kind)).toThrow(/is either "test" or "real"/);
    }
  });

  it('REFUSES endpoints that are half written, and takes null for the ones that may be absent', () => {
    const full = {
      node: 'https://n', nodeWs: null, indexer: 'https://i', indexerWs: 'wss://i', faucet: null, projectToken: null,
    };
    const withEndpoints = (e: unknown) => () => recordsFrom({
      version: 1, networks: { stagenet: { id: 'stagenet', kind: 'test', label: 'x', testToken: null, endpoints: e } },
    });
    expect(withEndpoints(full)).not.toThrow();
    for (const key of ['node', 'nodeWs', 'indexer', 'indexerWs', 'faucet', 'projectToken']) {
      const short: Record<string, unknown> = { ...full };
      delete short[key];
      /* RED WHEN a missing endpoint key is defaulted rather than refused. */
      expect(withEndpoints(short), key).toThrow(new RegExp(`has endpoints with no "${key}" key`));
    }
    for (const key of ['node', 'indexer', 'indexerWs']) {
      /* RED WHEN an endpoint that must exist is allowed to be null, which is a
       * door reaching `undefined` and asking it for a url. */
      expect(withEndpoints({ ...full, [key]: null }), key).toThrow(new RegExp(`whose "${key}" is not a url`));
      expect(withEndpoints({ ...full, [key]: '' }), key).toThrow(new RegExp(`whose "${key}" is not a url`));
    }
    expect(withEndpoints({ ...full, faucet: 7 })).toThrow(/neither a url nor null/);
    expect(withEndpoints('https://n')).toThrow(/neither an object nor null/);
    /* RED WHEN a project token is half described, so the reader would carry
     * an undefined token or carry it under no name. */
    const token = { setting: 'A_PROJECT_TOKEN', parameter: 'project_id' };
    expect(withEndpoints({ ...full, projectToken: token })).not.toThrow();
    expect(withEndpoints({ ...full, projectToken: { parameter: 'project_id' } })).toThrow(/projectToken whose "setting" is not a name/);
    expect(withEndpoints({ ...full, projectToken: { ...token, parameter: '' } })).toThrow(/projectToken whose "parameter" is not a name/);
    expect(withEndpoints({ ...full, projectToken: 'project_id' })).toThrow(/projectToken that is neither an object nor null/);
  });

  it('REFUSES A TEST TOKEN THAT IS NOT A COLOUR, AND ANY TEST TOKEN ON A REAL NETWORK', () => {
    const colour = 'ab'.repeat(32);
    const withTestToken = (kind: string, testToken: unknown) => () => recordsFrom({
      version: 1, networks: { n: { id: 'n', kind, label: 'x', testToken, endpoints: null } },
    });
    expect(withTestToken('test', colour)).not.toThrow();
    expect(withTestToken('real', null)).not.toThrow();
    /* RED WHEN a test token other than 64 lower-case hex characters is taken,
     * which names money no mint made. */
    for (const bad of ['AB'.repeat(32), 'ab'.repeat(31), '', 7]) {
      expect(withTestToken('test', bad), JSON.stringify(bad)).toThrow(/testToken that is neither 64 lower-case hex/);
    }
    /* RED WHEN a network where real money settles may name a test token. */
    expect(withTestToken('real', colour)).toThrow(/settles real money and names a test token/);
  });
});

describe('§2 resolving one, and refusing the rest', () => {
  it('REFUSES A NAME NO RECORD EXISTS FOR, with no default and no fallback', () => {
    for (const invented of ['', ' ', 'STAGENET', 'stagenet2', 'prod', 'production', 'main',
      'localhost', 'undefined', 'null', 'devnet', 'testnet', '__proto__', 'toString']) {
      /*
       * RED WHEN an unknown name resolves to anything - a guess, the first key
       * in the file, the last one used. A guess is silent, and the first thing
       * that tells anybody is an address nothing can read.
       *
       * `__proto__` and `toString` are in the list because a record store built
       * on a plain object answers both, and answering them would be this
       * function returning a record nobody wrote.
       */
      expect(isNetworkId(invented), JSON.stringify(invented)).toBe(false);
      expect(() => networkRecord(invented), JSON.stringify(invented))
        .toThrow(/is not a network this application has a record for/);
    }
  });

  it('the refusal says what would resolve it, in terms somebody can act on', () => {
    let said = '';
    try { networkRecord('prod'); } catch (e) { said = (e as Error).message; }
    /* RED WHEN the refusal stops naming the networks that do have records, or
     * stops saying that adding one is adding a record. */
    for (const id of NETWORK_IDS) expect(said, id).toContain(id);
    expect(said).toMatch(/the way to add one is to add a record/);
    /* RED WHEN the refusal offers a setting, which is the thing that must not
     * exist. */
    expect(said).toMatch(/there is no setting that admits a network without one/);
  });

  it('every record this build carries resolves to itself', () => {
    expect(NETWORK_IDS.length).toBeGreaterThan(1);
    for (const id of NETWORK_IDS) {
      expect(isNetworkId(id), id).toBe(true);
      expect(networkRecord(id).id, id).toBe(id);
      expect(networkRecord(id).label.length, id).toBeGreaterThan(0);
    }
  });

  it('A NETWORK WITH NO ENDPOINTS IS NAMED AND REFUSED, NOT REACHED AT A GUESS', () => {
    const unreachable = NETWORK_IDS.filter(id => networkRecord(id).endpoints === null);
    /* RED WHEN every network becomes reachable, which makes the loop vacuous. */
    expect(unreachable.length).toBeGreaterThan(0);
    for (const id of unreachable) {
      /* RED WHEN a missing endpoint is defaulted to somebody else's host - the
       * shape seven doors had, where the fallback answered exactly when the
       * real answer was missing. */
      expect(() => endpointsOf(id), id).toThrow(/has no endpoints recorded/);
      expect(() => endpointsOf(id), id).toThrow(/nothing here will invent one/);
      /* And it is still a network we can name and still says what kind it is. */
      expect(networkRecord(id).kind, id).toBe('real');
    }
  });

  it('the websocket node is derived in ONE place when a network publishes none', () => {
    /* RED WHEN the derivation changes shape. Every caller that wrote it out for
     * itself was a caller that could get it subtly wrong on its own. */
    expect(websocketNodeOf({ node: 'https://rpc.example', nodeWs: null, indexer: 'i', indexerWs: 'w', faucet: null }))
      .toBe('wss://rpc.example');
    expect(websocketNodeOf({ node: 'http://localhost:9944', nodeWs: null, indexer: 'i', indexerWs: 'w', faucet: null }))
      .toBe('ws://localhost:9944');
    /* RED WHEN a stated websocket endpoint is derived over rather than used. */
    expect(websocketNodeOf({ node: 'https://rpc.example', nodeWs: 'wss://other.example', indexer: 'i', indexerWs: 'w', faucet: null }))
      .toBe('wss://other.example');
  });
});

describe('§3 what the records this build ships actually say', () => {
  const raw = JSON.parse(readFileSync(
    fileURLToPath(new URL('./networks.json', import.meta.url)), 'utf8'));

  it('the reader drops no record the file carries, and invents none it does not', () => {
    /*
     * Two reads of one file, which is the point rather than a mistake: the left
     * side is the text on disk and the right side is what the reader made of
     * it.
     *
     * RED WHEN the reader silently skips a record it cannot parse. A reader
     * that dropped one would leave a network the file names and nothing can
     * resolve - which reads, from every door, exactly like a network nobody
     * wrote down.
     */
    expect(Object.keys(raw.networks).sort()).toEqual([...NETWORK_IDS].sort());
  });

  it('SAYS OF EVERY NETWORK WHETHER REAL MONEY SETTLES THERE', () => {
    /*
     * RED WHEN a record is added without deciding this. It is the fact a test
     * asset's refusal is keyed on, and a network admitted without it is a
     * network nobody decided about.
     */
    /*
     * `kinds.every(k => k === 'test' || k === 'real')` stood here and could not
     * fail: `checkedRecord` refuses any other value when the module loads, so
     * by the time a kind is readable it is necessarily one of the two. The two
     * lines below are the claim - that this build ships both, so neither the
     * refusal nor the permission is asserted against an empty set.
     */
    const kinds = NETWORK_IDS.map(id => networkRecord(id).kind);
    expect(kinds).toContain('real');
    expect(kinds).toContain('test');
  });

  it('every endpoint it states is an https or wss url, and no two networks share one', () => {
    const seen = new Map<string, string>();
    for (const id of NETWORK_IDS) {
      const e = networkRecord(id).endpoints;
      if (e === null) continue;
      for (const [field, url] of Object.entries(e)) {
        if (url === null || field === 'projectToken') continue;
        /* RED WHEN a url is written without a scheme, which is a fetch that
         * fails somewhere far from here. */
        expect(url, `${id}.${field}`).toMatch(/^(https?|wss?):\/\//);
        /* RED WHEN two networks are given the same endpoint, which is one
         * network wearing two names and the mistake this file exists to make
         * impossible. */
        const key = `${field}:${url}`;
        expect(seen.get(key), `${id}.${field} is also ${seen.get(key)}'s`).toBeUndefined();
        seen.set(key, id);
      }
    }
    expect(seen.size).toBeGreaterThan(10);
  });
});

describe('§4 a network reached only with a project token gets it in one place, and the record never holds it', () => {
  const asking = NETWORK_IDS.filter(id => networkRecord(id).endpoints?.projectToken);
  const settingOf = (id: string) => networkRecord(id).endpoints!.projectToken!;
  const TOKEN = 'aProjectToken42';

  it('there is a network that asks for one, and its record names the setting, not a token', () => {
    /* RED WHEN no record asks for a token, so everything below is vacuous. */
    expect(asking.length).toBeGreaterThan(0);
    const text = readFileSync(fileURLToPath(new URL('./networks.json', import.meta.url)), 'utf8');
    for (const id of asking) {
      /* RED WHEN a record carries a token, or a url with one already joined. */
      expect(JSON.stringify(networkRecord(id).endpoints), id).not.toContain(`${settingOf(id).parameter}=`);
    }
    expect(text).not.toMatch(/[?&][a-z_]+=/);
  });

  it('EVERY NODE AND INDEXER ENDPOINT CARRIES THE TOKEN, READ FROM THE SETTING THE RECORD NAMES', () => {
    for (const id of asking) {
      const { setting, parameter } = settingOf(id);
      const asked: string[] = [];
      const e = endpointsOf(id, (name) => { asked.push(name); return name === setting ? TOKEN : undefined; });
      /* RED WHEN the token is read from any setting but the one the record names. */
      expect(asked, id).toEqual([setting]);
      const recorded = networkRecord(id).endpoints!;
      for (const [field, url] of [['node', e.node], ['indexer', e.indexer], ['indexerWs', e.indexerWs],
        ['websocket node', websocketNodeOf(e)]] as const) {
        /* RED WHEN an endpoint is handed out without the token, which the
         * network answers with a refusal naming nothing of ours. */
        expect(new URL(url).searchParams.get(parameter), `${id} ${field}`).toBe(TOKEN);
      }
      /* RED WHEN joining the token moves an endpoint to another host or path. */
      expect(new URL(e.indexer).host + new URL(e.indexer).pathname).toBe(new URL(recorded.indexer).host + new URL(recorded.indexer).pathname);
      expect(new URL(e.indexerWs).pathname).toBe(new URL(recorded.indexerWs).pathname);
      /* The faucet is not the network's own host, and is left as recorded. */
      expect(e.faucet).toBe(recorded.faucet);
    }
  });

  it('A NETWORK THAT ASKS FOR A TOKEN AND HAS NONE IS REFUSED BY NAME, WHEN IT IS ASKED FOR', () => {
    for (const id of asking) {
      const { setting } = settingOf(id);
      for (const none of [undefined, '', '   ']) {
        /* RED WHEN an endpoint is handed out with no token, to be refused by
         * the network far from here. */
        expect(() => endpointsOf(id, () => none), `${id} ${JSON.stringify(none)}`).toThrow(`${setting} is not set here`);
      }
    }
  });

  it('AN ENDPOINT IS SHOWN WITHOUT ITS QUERY, SO THE TOKEN GOES ONLY TO THE NETWORK', () => {
    for (const id of asking) {
      const e = endpointsOf(id, () => TOKEN);
      for (const url of [e.node, e.indexer, e.indexerWs, websocketNodeOf(e)]) {
        /* RED WHEN an endpoint is shown with its query, which is the project token. */
        expect(shownAddress(url), url).not.toContain(TOKEN);
        expect(shownAddress(url), url).toBe(`${new URL(url).origin}${new URL(url).pathname}`);
      }
    }
    /* RED WHEN text that is not an address is shown with whatever follows its query mark. */
    expect(shownAddress(`not an address?project_id=${TOKEN}`)).toBe('not an address');
  });

  it('shows every address inside a free text without its query, and leaves the rest of the text alone', () => {
    /* RED WHEN an address inside a failure's text keeps its query, which is the project token. */
    expect(shownAddressesIn(`could not reach wss://node.example.org/ws?project_id=${TOKEN} just now`)).toBe('could not reach wss://node.example.org/ws just now');
    /* RED WHEN only the first address of a text is rewritten. */
    expect(shownAddressesIn(`a https://a.example.org/x?project_id=${TOKEN} b http://b.example.org:8080/y?k=${TOKEN}&z=1 c ws://c.example.org/?t=${TOKEN}`))
      .toBe('a https://a.example.org/x b http://b.example.org:8080/y c ws://c.example.org/');
    /* RED WHEN text with no address, or an address with no query, is changed. */
    expect(shownAddressesIn('the node did not answer?')).toBe('the node did not answer?');
    expect(shownAddressesIn('see https://a.example.org and http://b.example.org/p')).toBe('see https://a.example.org and http://b.example.org/p');
    /* RED WHEN an address at the end of a sentence loses its full stop, or takes it into the address. */
    expect(shownAddressesIn(`could not reach https://a.example.org/x?project_id=${TOKEN}.`)).toBe('could not reach https://a.example.org/x.');
    expect(shownAddressesIn(`(${'wss://a.example.org/ws'}?project_id=${TOKEN}), then`)).toBe('(wss://a.example.org/ws), then');
  });

  it('a network that asks for no token is reached exactly as recorded, whatever is set', () => {
    for (const id of NETWORK_IDS.filter(n => networkRecord(n).endpoints !== null && !asking.includes(n))) {
      const { projectToken: _none, ...recorded } = networkRecord(id).endpoints!;
      /* RED WHEN a token is joined to a network that did not ask for one. */
      expect(endpointsOf(id, () => TOKEN), id).toEqual(recorded);
    }
  });
});
