/**
 * **WHAT A CALL TO A VAULT'S PUBLIC DEPOSIT ASKS FOR**, read from the call's own declared effects. The page checks this
 * before it proves a public deposit and before it sends the one the wallet signed; the service checks it before its fee
 * payer pays for one. It trusts only the call's transcripts, never whoever handed the call over, and it refuses a call
 * that asks for anything but one public token, a positive amount of it, in one part of the transaction.
 */

/** The vault's circuit that takes a public token in. */
export const PUBLIC_DEPOSIT_ENTRY = 'depositUnshielded';

const bare = (a: unknown): string => String(a).trim().toLowerCase().replace(/^0x/u, '');
const nameOf = (entryPoint: unknown): string =>
  entryPoint instanceof Uint8Array ? new TextDecoder().decode(entryPoint) : String(entryPoint);

/**
 * The public tokens one transcript of a call takes in (each token lower-case hex without a prefix), or why they cannot
 * be taken for that: `unread` when its effects carry no readable list, `not-public` when it takes in anything but a
 * public token. The one reader of what a call takes in, for every check that asks.
 */
export function publicTakesOfTranscript(transcript: unknown): Array<{ colour: string; value: bigint }> | 'unread' | 'not-public' {
  const inputs = (transcript as { effects?: { unshieldedInputs?: unknown } | null } | null)?.effects?.unshieldedInputs;
  if (!(inputs instanceof Map)) return 'unread';
  const takes: Array<{ colour: string; value: bigint }> = [];
  for (const [type, value] of inputs as Map<{ tag?: unknown; raw?: unknown } | null, unknown>) {
    if (type?.tag !== 'unshielded' || typeof value !== 'bigint') return 'not-public';
    takes.push({ colour: bare(type.raw), value });
  }
  return takes;
}

/**
 * Why a call is not a public deposit into the vault: `not-the-call` (another contract or circuit), `split` (its effects
 * sit in both the part that always runs and the part that may fail, so a failure of the second would leave the first
 * half paid in), `unread`, `more-than-public` (it asks for a coin, a payment out or another call as well),
 * `not-public` (it takes in something that is not a public token), `not-one-token` (not exactly one public token, a
 * positive amount of it).
 */
export type PublicDepositCallRefusal = 'not-the-call' | 'split' | 'unread' | 'more-than-public' | 'not-public' | 'not-one-token';

/**
 * **THE ONE TOKEN AND AMOUNT A CALL PUTS INTO `vault`'S PUBLIC DEPOSIT**, or why it is not such a call. Which token
 * and how much the caller expected is the caller's own comparison; this says only what the call itself asks for.
 */
export function readPublicDepositCall(
  call: unknown, vault: string,
): { readonly colour: string; readonly amount: bigint } | { readonly refused: PublicDepositCallRefusal } {
  const c = call as {
    address?: unknown; entryPoint?: unknown; guaranteedTranscript?: unknown; fallibleTranscript?: unknown;
  } | null;
  if (!c || c.entryPoint === undefined || c.address === undefined
    || bare(c.address) !== bare(vault) || nameOf(c.entryPoint) !== PUBLIC_DEPOSIT_ENTRY) return { refused: 'not-the-call' };
  const present = (t: unknown) => t !== undefined && t !== null;
  if (present(c.guaranteedTranscript) && present(c.fallibleTranscript)) return { refused: 'split' };
  const asked = new Map<string, bigint>();
  let transcripts = 0;
  for (const transcript of [c.guaranteedTranscript, c.fallibleTranscript]) {
    if (!present(transcript)) continue;
    transcripts += 1;
    const e = (transcript as { effects?: unknown }).effects as Record<string, unknown> | undefined | null;
    if (e === undefined || e === null) return { refused: 'unread' };
    for (const k of ['claimedNullifiers', 'claimedShieldedReceives', 'claimedShieldedSpends', 'claimedContractCalls']) {
      if (!Array.isArray(e[k])) return { refused: 'unread' };
      if ((e[k] as unknown[]).length !== 0) return { refused: 'more-than-public' };
    }
    for (const k of ['shieldedMints', 'unshieldedMints', 'unshieldedOutputs', 'claimedUnshieldedSpends']) {
      if (!(e[k] instanceof Map)) return { refused: 'unread' };
      if ((e[k] as Map<unknown, unknown>).size !== 0) return { refused: 'more-than-public' };
    }
    const takes = publicTakesOfTranscript(transcript);
    if (typeof takes === 'string') return { refused: takes };
    for (const { colour, value } of takes) asked.set(colour, (asked.get(colour) ?? 0n) + value);
  }
  if (transcripts === 0) return { refused: 'unread' };
  const [only] = [...asked];
  if (asked.size !== 1 || only === undefined || !(only[1] > 0n)) return { refused: 'not-one-token' };
  return { colour: only[0], amount: only[1] };
}
