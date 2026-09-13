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
 * **THIS MODULE IS PURE AND MUST STAY PURE.** It reads no environment, no
 * argument vector, no hostname and no file at run time - the record is
 * imported, so it is part of the build. The module that reads the environment
 * is a different module, one layer out, and it is the only one. Keeping the
 * two apart is what lets the asset registry reach a network's `kind` without
 * reaching a configuration value in the same step.
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
export interface NetworkEndpointRecord {
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

export interface NetworkRecord {
  /**
   * **THE PLATFORM'S OWN VOCABULARY, AND NOT A NAME WE INVENTED.**
   *
   * This is the string handed to the platform's `setNetworkId`, and it is the
   * join key every other per-network file uses - which is what lets a separate
   * application agree with this one about what `stagenet` means without either
   * side being told.
   */
  readonly id: string;
  readonly kind: NetworkKind;
  /** What to call the network on a screen. Never parsed, never compared. */
  readonly label: string;
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

function checkedEndpoints(id: string, raw: unknown): NetworkEndpointRecord | null {
  if (raw === null) return null;
  if (typeof raw !== 'object') refuse(`"${id}" has an endpoints value that is neither an object nor null`);
  const e = raw as Record<string, unknown>;
  for (const key of ['node', 'nodeWs', 'indexer', 'indexerWs', 'faucet']) {
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
  });
}

function checkedRecord(key: string, raw: unknown): NetworkRecord {
  if (raw === null || typeof raw !== 'object') refuse(`"${key}" is not a record`);
  const r = raw as Record<string, unknown>;
  for (const field of ['id', 'kind', 'label', 'endpoints']) {
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
export function websocketNodeOf(endpoints: NetworkEndpointRecord): string {
  return endpoints.nodeWs ?? endpoints.node.replace(/^http/, 'ws');
}

/**
 * The endpoints of a network this application can actually reach, or a refusal
 * naming the network.
 *
 * Separate from `networkRecord` because "we know this network and settle real
 * money on it" and "we have somewhere to send a request" are two different
 * facts, and a door that needs the second should say so when it is missing
 * rather than read `undefined` off a table.
 */
export function endpointsOf(id: string): NetworkEndpointRecord {
  const record = networkRecord(id);
  if (record.endpoints === null) {
    throw new Error(
      `this application has no endpoints recorded for ${record.label} ("${id}"), so it cannot reach `
      + 'it. The record exists and names the network; what it does not carry is a node, an indexer '
      + 'or a faucet, and nothing here will invent one.');
  }
  return record.endpoints;
}
