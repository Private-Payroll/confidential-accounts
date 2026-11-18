import { buildSetting } from 'midnight-identity/profile/origin';
import document from './networks.json' with { type: 'json' };

/**
 * **A NETWORK IS ONE RECORD IN ONE FILE, AND ADDING A NETWORK IS ADDING A
 * RECORD.**
 *
 * Every part of this application that needs to know what network it is on
 * reads a record from `networks.json` and nothing else. There is no second
 * list: no endpoints table written out again beside this one, no set of names
 * kept in a door, no default compiled into a script.
 *
 * **WHY ONE PLACE IS NOT TIDINESS.** A network name is not a label. It is
 * interpolated verbatim as a segment of every bech32m address the platform
 * encodes and decodes, so two parts of one deployment that disagree about the
 * network write the same person's address two different ways. And a network is
 * where money is: an asset that exists only on a test chain must be refused on
 * a real one, and a refusal can only be as reliable as the answer it is asking
 * about. Two answers is one answer too many.
 *
 * **WHICH NETWORK, AND WHETHER REAL MONEY SETTLES ON IT, IS NEVER CONFIGURED
 * HERE.** The record is imported, so it is part of the build; this module
 * reads no argument vector, no hostname and no file. The one thing it reads
 * from outside the build is a network's project token, in `endpointsOf` and
 * nowhere else, because some networks are reached only with one and a token
 * may never be written in a record. That read decides no network, no kind and
 * no asset: the asset registry reaches a network's `kind` and test token
 * without reaching any setting.
 */

/** Whether a network settles real money. A test asset may only exist where this is `test`. */
export type NetworkKind = 'test' | 'real';

/**
 * Where to reach a network, or `null` when this application has none recorded.
 *
 * `null` is an answer and not a gap. A network we can name but cannot reach is
 * a network a door refuses at the point it needs an endpoint, loudly, rather
 * than one it silently reaches at a host nobody here has ever read off
 * anything.
 */
export interface ReachableEndpoints {
  readonly node: string;
  /**
   * A separate websocket node endpoint, where the network publishes one.
   *
   * `null` means it publishes none, and the http node url with its scheme
   * swapped is used instead. That derivation happens in `websocketNodeOf`
   * below and nowhere else, so it is one rule rather than one rule per caller.
   */
  readonly nodeWs: string | null;
  readonly indexer: string;
  readonly indexerWs: string;
  /** Where to ask for test money. `null` on a network that gives none away. */
  readonly faucet: string | null;
}

/**
 * **HOW A NETWORK THAT ASKS FOR A PROJECT TOKEN IS GIVEN ONE, AND NEVER THE
 * TOKEN ITSELF.** Some networks answer their node and indexer only for a
 * caller that names a project. The record says which setting holds the token
 * and which query parameter carries it; the token stays in the environment of
 * whatever reaches the network (for the wallet, the environment it was built
 * in). A query parameter rather than a header because a browser cannot set a
 * header on a websocket, and the same rule then serves every endpoint.
 */
export interface ProjectTokenRecord {
  readonly setting: string;
  readonly parameter: string;
}

/** Where to reach a network as recorded: its endpoints and, where it asks for one, how its project token is carried. */
export interface NetworkEndpointRecord extends ReachableEndpoints {
  /** `null` on a network that answers without one. */
  readonly projectToken: ProjectTokenRecord | null;
}

export interface NetworkRecord {
  /**
   * **THE PLATFORM'S OWN VOCABULARY, AND NOT A NAME WE INVENTED.**
   *
   * This is the network id the platform's providers and wallets are handed,
   * and it is the join key every other per-network file uses - which is what
   * lets a separate application agree with this one about what `stagenet`
   * means without either side being told.
   */
  readonly id: string;
  readonly kind: NetworkKind;
  /** What to call the network on a screen. Never parsed, never compared. */
  readonly label: string;
  /**
   * **THE TEST SETTLEMENT TOKEN MINTED ON THIS NETWORK: ITS COLOUR, OR `null`.**
   *
   * A colour is produced by one mint on one chain and read off that mint's own
   * answer, so it is written here only once a mint has reported it. `null`
   * means no test token exists on this network, and a network whose record
   * says real money settles there may never carry one.
   */
  readonly testToken: string | null;
  readonly endpoints: NetworkEndpointRecord | null;
}

/**
 * **A RECORD MISSING A FIELD IS REFUSED, AND `null` IS NOT MISSING.**
 *
 * Mainnet has no faucet; saying so is a different act from forgetting to say.
 * So every field is required to be PRESENT, and the ones that may be absent in
 * the world are required to be present and `null`. A record that simply lacks
 * a key would otherwise be defaulted by whichever reader met it first, which
 * is the same defect one layer down.
 *
 * This runs when the module is loaded, so a malformed record is a process that
 * does not start rather than a payroll run that behaves oddly.
 */
const KINDS: readonly string[] = ['test', 'real'];

function refuse(what: string): never {
  throw new Error(
    `networks.json is not usable: ${what}. A network is one record in one file and every field of `
    + 'a record is required to be present - an endpoint that does not exist is written as null, '
    + 'which is an answer, and a key that is absent is an error. Nothing defaults.');
}

const A_COLOUR = /^[0-9a-f]{64}$/;

function checkedProjectToken(id: string, raw: unknown): ProjectTokenRecord | null {
  if (raw === null) return null;
  if (typeof raw !== 'object') refuse(`"${id}" has a projectToken that is neither an object nor null`);
  const t = raw as Record<string, unknown>;
  for (const key of ['setting', 'parameter'] as const) {
    if (typeof t[key] !== 'string' || (t[key] as string).length === 0) {
      refuse(`"${id}" has a projectToken whose "${key}" is not a name`);
    }
  }
  return Object.freeze({ setting: t.setting as string, parameter: t.parameter as string });
}

function checkedEndpoints(id: string, raw: unknown): NetworkEndpointRecord | null {
  if (raw === null) return null;
  if (typeof raw !== 'object') refuse(`"${id}" has an endpoints value that is neither an object nor null`);
  const e = raw as Record<string, unknown>;
  for (const key of ['node', 'nodeWs', 'indexer', 'indexerWs', 'faucet', 'projectToken']) {
    if (!Object.prototype.hasOwnProperty.call(e, key)) refuse(`"${id}" has endpoints with no "${key}" key`);
  }
  for (const key of ['node', 'indexer', 'indexerWs'] as const) {
    if (typeof e[key] !== 'string' || (e[key] as string).length === 0) {
      refuse(`"${id}" has endpoints whose "${key}" is not a url`);
    }
  }
  for (const key of ['nodeWs', 'faucet'] as const) {
    if (e[key] !== null && (typeof e[key] !== 'string' || (e[key] as string).length === 0)) {
      refuse(`"${id}" has endpoints whose "${key}" is neither a url nor null`);
    }
  }
  return Object.freeze({
    node: e.node as string,
    nodeWs: e.nodeWs as string | null,
    indexer: e.indexer as string,
    indexerWs: e.indexerWs as string,
    faucet: e.faucet as string | null,
    projectToken: checkedProjectToken(id, e.projectToken),
  });
}

function checkedTestToken(key: string, kind: NetworkKind, raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string' || !A_COLOUR.test(raw)) {
    refuse(`"${key}" has a testToken that is neither 64 lower-case hex characters nor null`);
  }
  if (kind === 'real') {
    refuse(`"${key}" settles real money and names a test token, and a test token may exist only on a test network`);
  }
  return raw;
}

function checkedRecord(key: string, raw: unknown): NetworkRecord {
  if (raw === null || typeof raw !== 'object') refuse(`"${key}" is not a record`);
  const r = raw as Record<string, unknown>;
  for (const field of ['id', 'kind', 'label', 'testToken', 'endpoints']) {
    if (!Object.prototype.hasOwnProperty.call(r, field)) refuse(`"${key}" has no "${field}" key`);
  }
  /*
   * **THE KEY AND THE `id` ARE THE SAME STRING, AND THAT IS CHECKED RATHER
   * THAN ASSUMED.** Everything that resolves a network resolves it by the key;
   * everything that hands a name to the platform hands it the `id`. A record
   * where the two differ would be a deployment reaching one network's
   * endpoints while writing another network's addresses.
   */
  if (r.id !== key) refuse(`"${key}" carries the id "${String(r.id)}", and a record's key is its id`);
  if (typeof r.kind !== 'string' || !KINDS.includes(r.kind)) {
    refuse(`"${key}" has kind ${JSON.stringify(r.kind)}, and a network is either "test" or "real"`);
  }
  if (typeof r.label !== 'string' || r.label.length === 0) refuse(`"${key}" has no label`);
  return Object.freeze({
    id: key,
    kind: r.kind as NetworkKind,
    label: r.label,
    testToken: checkedTestToken(key, r.kind as NetworkKind, r.testToken),
    endpoints: checkedEndpoints(key, r.endpoints),
  });
}

/**
 * **THE WHOLE DOCUMENT, CHECKED, AS A PURE FUNCTION OF ITS TEXT.**
 *
 * Exported so the refusals above can be WATCHED refusing. A guard whose
 * failure path nothing has ever driven is a guard nobody knows the shape of,
 * and every one of these exists because a shape that looked fine defaulted
 * somewhere instead of stopping.
 */
export function recordsFrom(raw: unknown): ReadonlyMap<string, NetworkRecord> {
  if (raw === null || typeof raw !== 'object') refuse('it is not an object');
  const doc = raw as Record<string, unknown>;
  if (doc.version !== 1) refuse(`its version is ${JSON.stringify(doc.version)} and this build reads version 1`);
  const networks = doc.networks;
  if (networks === null || typeof networks !== 'object') refuse('it carries no networks object');
  const entries = Object.entries(networks as Record<string, unknown>);
  if (entries.length === 0) refuse('it carries no networks at all');
  return new Map(entries.map(([key, value]) => [key, checkedRecord(key, value)]));
}

const parsed: ReadonlyMap<string, NetworkRecord> = recordsFrom(document);

/** Every network this application has a record for, in the order the file writes them. */
export const NETWORK_IDS: readonly string[] = Object.freeze([...parsed.keys()]);

export const isNetworkId = (id: string): boolean => parsed.has(id);

/**
 * **THE RECORD, OR A REFUSAL. THERE IS NO THIRD ANSWER AND THERE IS NO
 * DEFAULT.**
 *
 * A name nobody has written a record for is refused rather than guessed at.
 * Guessing is worse than the defect it hides: a network resolved to "the last
 * one used", "the first key in the file" or "whatever the build was compiled
 * for" is a deployment that is silently on a network nobody asked for, and the
 * first thing that tells anybody is an address no wallet can read or a payment
 * in a token backed by nothing.
 */
export function networkRecord(id: string): NetworkRecord {
  const found = parsed.get(id);
  if (found === undefined) {
    throw new Error(
      `"${id}" is not a network this application has a record for. The networks it has records for `
      + `are: ${NETWORK_IDS.join(', ')}. A network is one record in one file, so the way to add one `
      + 'is to add a record - there is no setting that admits a network without one, and none may '
      + 'be added, because a network nobody has written down is a network nobody has decided '
      + 'whether real money settles on.');
  }
  return found;
}

/** Whether a network settles real money, read off its own record. */
export const networkIsReal = (id: string): boolean => networkRecord(id).kind === 'real';

/**
 * The websocket node endpoint, which most networks do not publish separately.
 *
 * One derivation in one place. Every caller that wrote `?? node.replace(...)`
 * for itself was a caller that could get it subtly wrong on its own.
 */
export function websocketNodeOf(endpoints: ReachableEndpoints): string {
  return endpoints.nodeWs ?? endpoints.node.replace(/^http/, 'ws');
}

/**
 * The endpoints of a network this application can actually reach, each
 * carrying the network's project token where it asks for one, or a refusal
 * naming the network.
 *
 * Separate from `networkRecord` because "we know this network and settle real
 * money on it" and "we have somewhere to send a request" are two different
 * facts, and a door that needs the second should say so when it is missing
 * rather than read `undefined` off a table.
 *
 * **THE ONE PLACE A PROJECT TOKEN JOINS AN ENDPOINT.** It is read from the
 * setting the record names, when this is called rather than when this module
 * loads, so a service that reads its environment file at start-up has the
 * token by the time it asks. A network that asks for a token and has none is
 * refused here, naming the setting, rather than answered by the network with a
 * refusal that names nothing of ours. The faucet is not the network's own
 * host and is left as recorded.
 */
export function endpointsOf(
  id: string,
  setting: (name: string) => unknown = buildSetting,
): ReachableEndpoints {
  const record = networkRecord(id);
  if (record.endpoints === null) {
    throw new Error(
      `this application has no endpoints recorded for ${record.label} ("${id}"), so it cannot reach `
      + 'it. The record exists and names the network; what it does not carry is a node, an indexer '
      + 'or a faucet, and nothing here will invent one.');
  }
  const { projectToken, ...recorded } = record.endpoints;
  if (projectToken === null) return Object.freeze(recorded);
  const carry = withToken(projectToken.parameter, tokenFrom(record, projectToken, setting));
  return Object.freeze({
    node: carry(recorded.node),
    nodeWs: recorded.nodeWs === null ? null : carry(recorded.nodeWs),
    indexer: carry(recorded.indexer),
    indexerWs: carry(recorded.indexerWs),
    faucet: recorded.faucet,
  });
}

function tokenFrom(
  record: NetworkRecord, token: ProjectTokenRecord, setting: (name: string) => unknown,
): string {
  const value = setting(token.setting);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  throw new Error(
    `${record.label} ("${record.id}") answers its node and indexer only for a caller that names a `
    + `project, and ${token.setting} is not set here, so nothing was asked of it. Set `
    + `${token.setting} to the network's project token in the environment of this process, or, `
    + 'for the wallet, in the environment it is built in. The token is never written in the record.');
}

/**
 * **AN ENDPOINT AS IT MAY BE SHOWN TO A PERSON OR WRITTEN DOWN**: its address
 * without its query, which is where a network's project token travels. Every
 * sentence, log line or record that names an endpoint goes through this, so a
 * token joined by `endpointsOf` is sent only to the network it is for. Text
 * that is not an address keeps only what comes before its first `?`.
 */
export function shownAddress(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return String(url).split('?')[0]!; // not an address: nothing parses, so everything after a query mark goes
  }
  return `${u.origin}${u.pathname}`;
}

const ADDRESS_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s<>"'`)\]]+/giu;
const ENDS_A_SENTENCE = /[.,;:!?]+$/u;

/**
 * **EVERY ADDRESS INSIDE A FREE TEXT AS IT MAY BE SHOWN**: each http(s) or
 * ws(s) address is rewritten as `shownAddress` shows it, so a failure's text
 * that carries an endpoint carries no project token. Punctuation that ends a
 * sentence stays outside the address, an address with no query is left exactly
 * as written, and all other text is returned unchanged.
 */
export function shownAddressesIn(text: string): string {
  return text.replace(ADDRESS_IN_TEXT, (found) => {
    const tail = ENDS_A_SENTENCE.exec(found)?.[0] ?? '';
    const address = found.slice(0, found.length - tail.length);
    return (/[?#]/u.test(address) ? shownAddress(address) : address) + tail;
  });
}

const withToken = (parameter: string, token: string) => (url: string): string => {
  const u = new URL(url);
  u.searchParams.set(parameter, token);
  return u.toString();
};
