import { RELEASED_CONTRACTS, RELEASED_VERSIONS, type ReleasedContract, type ReleasedVersion } from 'midnight-identity/wallet/released-versions';
import { contractStateOfHex, publishedBuildOfState } from '../apps/wallet/src/chain/published-build.js';

/*
 * What the count of companies decides, with nothing that reaches a network.
 *
 * The indexer lists no deploys, so the count walks the chain's blocks, asks each block which contracts were deployed in
 * it, reads each such contract's state as it is now, and judges its verifier keys with the one matcher the wallet uses
 * (every circuit, in every key slot, against each published version). The rules below are the decisions in that walk.
 */

export const TIP_QUERY = 'query { block { height } }';
export const BLOCK_QUERY = 'query ($height: Int!) { block(offset: { height: $height }) { height transactions { contractActions { __typename address } } } }';

const ADDRESS = /^[0-9a-f]{64}$/u;

/**
 * What one block's answer says. An answer that cannot be read whole is never read as a block with no deploys, and a
 * block the indexer does not hold is `no-block`: the walk only asks for heights up to the newest block, so that is a gap.
 */
export type BlockAnswer =
  | { readonly of: 'block'; readonly deploys: readonly string[] }
  | { readonly of: 'no-block' }
  | { readonly of: 'unread'; readonly why: string };

const unread = (why: string): BlockAnswer => ({ of: 'unread', why });
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** A deploy is a contract action whose type is ContractDeploy; calls and updates of a contract are not deploys. */
export function deploysInBlock(answer: unknown): BlockAnswer {
  if (!isObject(answer)) return unread('the indexer\'s answer is not an object.');
  if (answer.errors !== undefined) return unread('the indexer refused the question about this block.');
  if (!isObject(answer.data)) return unread('the indexer\'s answer carries no data.');
  const block = answer.data.block;
  if (block === null) return { of: 'no-block' };
  if (!isObject(block) || !Array.isArray(block.transactions)) return unread('the block\'s answer carries no list of transactions.');
  const deploys = new Set<string>();
  for (const tx of block.transactions) {
    if (!isObject(tx) || !Array.isArray(tx.contractActions)) return unread('a transaction\'s answer carries no list of contract actions.');
    for (const action of tx.contractActions) {
      if (!isObject(action) || typeof action.__typename !== 'string') return unread('a contract action carries no type.');
      if (action.__typename !== 'ContractDeploy') continue;
      const address = typeof action.address === 'string' ? action.address.toLowerCase() : '';
      if (!ADDRESS.test(address)) return unread('a deploy carries an address that is not 64 hex characters.');
      deploys.add(address);
    }
  }
  return { of: 'block', deploys: [...deploys] };
}

/** The chain's newest block height from the answer to TIP_QUERY, or null when the answer does not give one. */
export function tipOf(answer: unknown): number | null {
  if (!isObject(answer) || answer.errors !== undefined || !isObject(answer.data) || !isObject(answer.data.block)) return null;
  const height = answer.data.block.height;
  return Number.isSafeInteger(height) && (height as number) >= 0 ? (height as number) : null;
}

/** What one deployed contract's keys came to. "Matches none" and "could not be checked" are different answers. */
export type Verdict =
  | { readonly of: 'published'; readonly contract: ReleasedContract; readonly version: number }
  | { readonly of: 'matches-none' }
  | { readonly of: 'unchecked'; readonly why: string };

/**
 * Judges one deployed contract's state against each released contract in turn: the first match decides, and keys that
 * cannot be read end the search as "unchecked", never as "matches none".
 */
export function verdictOfState(hex: string | null, address: string, versions: readonly ReleasedVersion[] = RELEASED_VERSIONS): Verdict {
  if (hex === null) return { of: 'unchecked', why: 'the indexer holds no state at that address.' };
  const state = contractStateOfHex(hex);
  if (state === null) return { of: 'unchecked', why: 'the state is not a contract state.' };
  for (const contract of RELEASED_CONTRACTS) {
    const build = publishedBuildOfState(state, address, contract, versions);
    if (build.of === 'unchecked') return { of: 'unchecked', why: 'the contract\'s keys could not be read.' };
    if (build.of === 'published') return { of: 'published', contract, version: build.version };
  }
  return { of: 'matches-none' };
}

export interface Tally {
  readonly deploys: number;
  readonly byContract: Readonly<Record<string, Readonly<Record<number, number>>>>;
  readonly matchesNone: number;
  readonly unchecked: number;
}

export const emptyTally = (): Tally => ({
  deploys: 0, byContract: Object.fromEntries(RELEASED_CONTRACTS.map((contract) => [contract, {}])), matchesNone: 0, unchecked: 0,
});

/** One verdict added to the tally. A published one is counted under its contract and its version id. */
export function withVerdict(tally: Tally, verdict: Verdict): Tally {
  const deploys = tally.deploys + 1;
  if (verdict.of === 'matches-none') return { ...tally, deploys, matchesNone: tally.matchesNone + 1 };
  if (verdict.of === 'unchecked') return { ...tally, deploys, unchecked: tally.unchecked + 1 };
  const of = tally.byContract[verdict.contract] ?? {};
  return { ...tally, deploys, byContract: { ...tally.byContract, [verdict.contract]: { ...of, [verdict.version]: (of[verdict.version] ?? 0) + 1 } } };
}

/** The first height a start argument names, or why it cannot be used. No argument means the first block. */
export function startHeight(arg: string | undefined, tip: number): { readonly of: 'ok'; readonly height: number } | { readonly of: 'refused'; readonly why: string } {
  if (arg === undefined || arg === '') return { of: 'ok', height: 0 };
  if (!/^\d+$/u.test(arg)) return { of: 'refused', why: `"${arg}" is not a block height. Give a whole number, or nothing to start at the first block.` };
  const height = Number(arg);
  if (!Number.isSafeInteger(height) || height > tip) return { of: 'refused', why: `block ${arg} is beyond the chain's newest block, ${tip}.` };
  return { of: 'ok', height };
}

/** The lines printed for a tally, with the range of blocks it covers; a run that counted nothing says so. */
export function tallyLines(tally: Tally, counted: { readonly from: number; readonly to: number | null }): string[] {
  const lines = [counted.to === null
    ? 'No block was counted: 0 contract deploys.'
    : `Counted blocks ${counted.from} to ${counted.to}: ${tally.deploys} contract deploys.`];
  for (const contract of RELEASED_CONTRACTS) {
    const versions = Object.entries(tally.byContract[contract] ?? {}).sort(([a], [b]) => Number(a) - Number(b));
    const total = versions.reduce((n, [, count]) => n + count, 0);
    lines.push(`  ${contract}: ${total} built from our published code${versions.length === 0 ? '' : ` (${versions.map(([v, n]) => `version ${v}: ${n}`).join(', ')})`}`);
  }
  lines.push(`  Contracts that match no published version: ${tally.matchesNone}`);
  lines.push(`  Contracts that could not be checked: ${tally.unchecked}`);
  return lines;
}

/** What the walk asks of the outside: one question of the indexer, and one contract's state as hex (null when none). */
export interface WalkDoors {
  readonly ask: (query: string, variables: Record<string, unknown>) => Promise<unknown>;
  readonly read: (address: string) => Promise<string | null>;
  /** How long a state read may take before it is counted as one that could not be checked. */
  readonly readTimeoutMs?: number;
  /** The published versions judged against; the released list when none is given. */
  readonly versions?: readonly ReleasedVersion[];
}

export type Walk =
  | { readonly of: 'done'; readonly tally: Tally; readonly lastCounted: number | null }
  | { readonly of: 'stopped'; readonly tally: Tally; readonly lastCounted: number | null; readonly stoppedIn: number; readonly why: string };

const AT_ONCE = 8;
const READ_TIMEOUT_MS = 30_000;
const TIMED_OUT = Symbol('timed out');

async function readWithin(doors: WalkDoors, address: string): Promise<string | null | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), doors.readTimeoutMs ?? READ_TIMEOUT_MS); });
  try {
    return await Promise.race([doors.read(address), late]);
  } finally {
    clearTimeout(timer);
  }
}

type Counted = { readonly of: 'counted'; readonly verdicts: readonly Verdict[] } | { readonly of: 'stopped'; readonly why: string };

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One block, whole: every deploy in it asked about and judged, or the reason it could not be. */
async function countBlock(doors: WalkDoors, height: number): Promise<Counted> {
  let answer: unknown;
  try {
    answer = await doors.ask(BLOCK_QUERY, { height });
  } catch (e) {
    return { of: 'stopped', why: reason(e) };
  }
  const block = deploysInBlock(answer);
  if (block.of === 'no-block') return { of: 'stopped', why: 'the indexer holds no block at this height, though the chain reaches past it.' };
  if (block.of === 'unread') return { of: 'stopped', why: block.why };
  const verdicts: Verdict[] = [];
  for (const address of block.deploys) {
    try {
      const hex = await readWithin(doors, address);
      verdicts.push(hex === TIMED_OUT ? { of: 'unchecked', why: 'the state read took too long.' } : verdictOfState(hex, address, doors.versions));
    } catch (e) {
      return { of: 'stopped', why: reason(e) };
    }
  }
  return { of: 'counted', verdicts };
}

/**
 * Walks blocks `start` to `tip`, eight at a time and counted in order. A block counts whole or not at all, so a walk
 * that stops resumes in the block it stopped in (`stoppedIn`), never after it, and a block the indexer does not hold
 * below the tip is a stop, never the end of the chain. Heights above `tip` are never asked for.
 */
export async function walkBlocks(doors: WalkDoors, start: number, tip: number, progress: (height: number, tally: Tally) => void = () => {}): Promise<Walk> {
  let tally = emptyTally();
  let lastCounted: number | null = null;
  for (let from = start; from <= tip; from += AT_ONCE) {
    const heights = Array.from({ length: Math.min(AT_ONCE, tip - from + 1) }, (_, i) => from + i);
    const group = await Promise.all(heights.map((h) => countBlock(doors, h)));
    for (const [i, result] of group.entries()) {
      const height = heights[i]!;
      if (result.of === 'stopped') return { of: 'stopped', tally, lastCounted, stoppedIn: height, why: result.why };
      for (const verdict of result.verdicts) tally = withVerdict(tally, verdict);
      lastCounted = height;
      progress(height, tally);
    }
  }
  return { of: 'done', tally, lastCounted };
}
