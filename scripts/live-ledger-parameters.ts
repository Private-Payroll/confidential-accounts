/**
 * THE PARAMETERS THE CHAIN ACTUALLY RUNS, AS OPPOSED TO THE ONES THIS PROJECT
 * SHIPS A COPY OF.
 *
 * ── WHY IT IS NOT THE SAME QUESTION ─────────────────────────────────────────
 *
 * `LedgerParameters.initialParameters()` is a constant compiled into the
 * library. It is what a chain starts with and not what a chain is running: the
 * runtime cost model is governable and moves. Measured against stagenet, the
 * two differ in 143 of their fields. The per-operation costs are roughly twice
 * the initial ones, which moves every fee and every dismiss time derived from
 * them, and the block usage limit is five times larger.
 *
 * A number taken from the initial parameters and reported as a reading of the
 * chain is therefore wrong in both directions at once: it understates what a
 * transaction costs and overstates the headroom it has. Every limit and
 * dismiss figure this project has recorded came from the initial parameters,
 * and none of them said so.
 *
 * ── THE READ IS FREE AND NOTHING IS SUBMITTED ───────────────────────────────
 *
 * `state_call` is a runtime query. It builds nothing, proves nothing, spends
 * nothing and leaves no trace. The runtime answers with a SCALE
 * `Result<Vec<u8>, _>`: one byte of discriminant, a compact length, then the
 * tagged serialisation the library's own `deserialize` reads.
 *
 * ── THE DECODE IS SELF-CHECKING, AND THAT IS MEASURED RATHER THAN ASSERTED ──
 *
 * The payload names itself in its first bytes, so a wrong offset does not
 * produce a wrong answer, it produces no answer. Five deliberate corruptions
 * were tried against a live payload - shifted one byte left, shifted one byte
 * right, not unwrapped at all, truncated by one byte, and one byte flipped in
 * the middle - and all five threw. Two of them named the expected header tag
 * and the others failed to fill a buffer or put an integer out of range. There
 * is no near miss here to guard against separately.
 *
 * ── AND THE ONE RULE THIS FILE EXISTS TO MAKE UNBREAKABLE ───────────────────
 *
 * NOTHING HERE EVER RETURNS THE INITIAL PARAMETERS LABELLED AS A LIVE READING.
 * A fallback is produced only by asking for one by name, and what comes back
 * carries `source: 'fallback'` in the same object as the parameters, so a
 * caller cannot hold one without holding the other. The alternative shape - a
 * function that quietly substitutes the constant when the network is down - is
 * the shape that put unlabelled initial numbers in every report this project
 * has written.
 */

/** Where a set of ledger parameters came from. There is no third answer. */
export type ParametersSource = 'live' | 'fallback';

export type ParametersReading = {
  /** `live` was decoded from the chain's own answer. `fallback` is the library constant. */
  source: ParametersSource;
  /** The parameters, or null when neither could be obtained. */
  parameters: unknown | null;
  /** Payload length in bytes, when it was read live. */
  payloadBytes: number | null;
  /** The self-describing tag at the head of the payload, when it was read live. */
  tag: string | null;
  /** Which node answered, when one did. */
  node: string | null;
  /** What could not be done, when something could not. */
  problem?: string;
};

/**
 * The SCALE compact integer at `offset`.
 *
 * Two bits of mode, then the value. The single-byte-per-mode arithmetic is
 * written out rather than looped because getting it wrong is the failure this
 * whole file guards against, and a reader should be able to check it by eye.
 */
export function readCompact(bytes: Uint8Array, offset: number): { value: number; width: number } {
  if (offset >= bytes.length) throw new Error('the answer ended before its length prefix');
  const b0 = bytes[offset]!;
  switch (b0 & 0b11) {
    case 0b00:
      return { value: b0 >> 2, width: 1 };
    case 0b01: {
      if (offset + 2 > bytes.length) throw new Error('a two-byte length prefix ran past the end of the answer');
      return { value: ((b0 | (bytes[offset + 1]! << 8)) >>> 0) >> 2, width: 2 };
    }
    case 0b10: {
      if (offset + 4 > bytes.length) throw new Error('a four-byte length prefix ran past the end of the answer');
      const raw =
        ((b0 | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0);
      return { value: raw >>> 2, width: 4 };
    }
    default:
      throw new Error('the length prefix is a big integer, which this decode does not handle');
  }
}

/**
 * The `Vec<u8>` inside a SCALE `Result<Vec<u8>, _>`.
 *
 * Throws rather than returning a partial answer, because every failure here
 * means the bytes are not what they were taken to be, and a decode that
 * proceeds on that is how a wrong number gets a confident label.
 */
export function unwrapStateCallResult(bytes: Uint8Array): { payload: Uint8Array; headerBytes: number } {
  if (bytes.length < 2) throw new Error('the answer is too short to be a result carrying bytes');
  if (bytes[0] !== 0x00) {
    throw new Error(`the runtime answered with an error rather than parameters (0x${bytes[0]!.toString(16).padStart(2, '0')})`);
  }
  const { value: length, width } = readCompact(bytes, 1);
  const headerBytes = 1 + width;
  const payload = bytes.subarray(headerBytes, headerBytes + length);
  if (payload.length !== length) {
    throw new Error(`the length prefix says ${length} bytes and ${payload.length} followed it`);
  }
  return { payload, headerBytes };
}

/** The printable head of the payload, which is where it names itself. */
export function tagOf(payload: Uint8Array): string {
  let out = '';
  for (const byte of payload.subarray(0, 32)) out += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
  return out;
}

/** Hexadecimal, without a prefix, lower case. */
const fromHex = (hex: string): Uint8Array => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('the answer is an odd number of hexadecimal digits');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('the answer is not hexadecimal');
    out[i] = byte;
  }
  return out;
};

/** What the live read needs, injected so the decode can be tested without a network. */
export type LiveParametersDeps = {
  /** Posts the query and returns whatever the node said. */
  post: (node: string, body: string) => Promise<{ result?: string; error?: unknown }>;
  /** The library's `LedgerParameters`, which owns both the decode and the constant. */
  LedgerParameters: { deserialize: (raw: Uint8Array) => unknown; initialParameters: () => unknown };
};

export const STATE_CALL_METHOD = 'MidnightRuntimeApi_get_ledger_parameters';

/**
 * The parameters the given node is running.
 *
 * Never throws and never substitutes. A failure comes back as a reading whose
 * `parameters` is null and whose `problem` names the step that did not
 * complete, so a caller that must refuse can say what could not be checked
 * rather than that something went wrong.
 */
export async function readLiveParameters(node: string, deps: LiveParametersDeps): Promise<ParametersReading> {
  const empty: ParametersReading = {
    source: 'live', parameters: null, payloadBytes: null, tag: null, node,
  };
  let answer: { result?: string; error?: unknown };
  try {
    answer = await deps.post(node, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'state_call', params: [STATE_CALL_METHOD, '0x'],
    }));
  } catch (e: any) {
    return { ...empty, problem: `the node did not answer: ${String(e?.message ?? e).slice(0, 160)}` };
  }
  if (answer?.error !== undefined && answer.error !== null) {
    return { ...empty, problem: `the node refused the query: ${JSON.stringify(answer.error).slice(0, 160)}` };
  }
  if (typeof answer?.result !== 'string' || answer.result.length === 0) {
    return { ...empty, problem: 'the node answered without a result' };
  }
  try {
    const { payload } = unwrapStateCallResult(fromHex(answer.result));
    const parameters = deps.LedgerParameters.deserialize(payload);
    return { source: 'live', parameters, payloadBytes: payload.length, tag: tagOf(payload), node };
  } catch (e: any) {
    return { ...empty, problem: `the answer could not be decoded: ${String(e?.message ?? e).slice(0, 160)}` };
  }
}

/**
 * The library's own constant, LABELLED AS WHAT IT IS.
 *
 * This is the only way to obtain it through this file, it is the only thing
 * here that can carry `source: 'fallback'`, and the label travels with the
 * parameters rather than beside them.
 */
export function fallbackParameters(
  LedgerParameters: { initialParameters: () => unknown },
  why: string,
): ParametersReading {
  return {
    source: 'fallback',
    parameters: LedgerParameters.initialParameters(),
    payloadBytes: null,
    tag: null,
    node: null,
    problem: why,
  };
}

/** One line a person can act on, whatever the reading turned out to be. */
export function describeParameters(reading: ParametersReading): string {
  if (reading.source === 'fallback') {
    return 'THE CHAIN\'S OWN PARAMETERS WERE NOT READ. These are the library\'s built-in starting '
      + `values, which are not what any live chain is running: ${reading.problem ?? 'no reason given'}`;
  }
  if (reading.parameters === null) {
    return `the chain's parameters could not be read from ${reading.node}: ${reading.problem ?? 'no reason given'}`;
  }
  return `parameters read from ${reading.node}, ${reading.payloadBytes} bytes, carrying the tag ${reading.tag}`;
}
