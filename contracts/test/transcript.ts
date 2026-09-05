/**
 * WHAT A TRANSACTION PUBLISHES, AS OPPOSED TO WHAT THE LEDGER ENDS UP HOLDING.
 * `C389` `P1`, board row `2y9f0`, `S50`.
 *
 * **THE GAP THIS EXISTS TO CLOSE.** Every privacy claim this project has ever
 * checked mechanically has been checked over ledger STATE.
 * `contracts/test/signer-governance.test.ts:496` — the one guard rail written
 * for this class — counts occurrences in `JSON.stringify(sim.ledger, …)` before
 * and after an action. That is correct about the channel it reads, and it is
 * half of what a Midnight transaction publishes.
 *
 * The other half is the PUBLIC TRANSCRIPT: the sequence of on-chain-VM
 * operations a transaction carries so that a validator can replay the circuit's
 * effect on public state without the proof. **A ledger READ pushes its argument
 * into that transcript and stores nothing** — so it is invisible to a check
 * that diffs ledger state, and it passes straight through the only guard rail
 * that exists. Measured, at source, in the shipping contract:
 *
 *   `contracts/src/ConfidentialAccount.compact:1359`
 *       `return thresholds.member(vault) ? thresholds.lookup(vault) : threshold;`
 *   compiles to (`contracts/managed/contract/index.js:1617-1633`)
 *       `queryLedgerState(context, partialProofData,
 *          [ dup, idx(6n), push(cell(vault)), 'member', popeq ])`
 *
 * **`vault` goes into a `push` op, verbatim, and no ledger field moves.**
 * `transcript.test.ts` shows that op in a real cross-contract payout.
 *
 * **THIS IS NOT RESEARCH AND IT IS NOT A MOCK.** The field is already present
 * on every call this project's tests already make. `PartialProofData` declares
 * `publicTranscript: ocrt.Op<ocrt.AlignedValue>[]`
 * (`node_modules/@midnight-ntwrk/compact-runtime/dist/proof-data.d.ts:13`); the
 * runtime threads `callProofDataTrace: CallProofData[]` through every circuit
 * context (`…/dist/circuit-context.d.ts:82` and `:124`); and every generated
 * impure circuit ends with `finalizeCallProofData(context, partialProofData)`
 * (e.g. `contracts/managed/contract/index.js:323`) before returning the
 * context. Until this file, our own code touched `publicTranscript` exactly
 * once — as a hand-built EMPTY stub at `scripts/cross-contract-spike.ts:144`,
 * which is what asserting over an absent transcript looks like.
 *
 * ---
 *
 * **WHAT THIS INSTRUMENT DOES AND DOES NOT CLAIM — READ THIS BEFORE TRUSTING A
 * GREEN RUN.** The long form is `docs/build-log.md`'s `S50` §5.
 *
 * 1. **It reads ONE transaction's transcript.** Anything a watcher learns by
 *    counting transactions, timing them, or correlating them is outside it.
 *    The payout COUNT is exactly that shape (`C356`).
 * 2. **It does not read the circuit's `input`.** `PartialProofData.input`
 *    carries every argument in the clear, and it is PRIVATE — a proof witness,
 *    not chain data. A green run here says the chain does not learn the value;
 *    it says nothing about whoever builds the transaction.
 * 3. **It does not read the Zswap offer.** Coin commitments, nullifiers and
 *    the shielded outputs a payout creates live in the Zswap local state, not
 *    in this transcript. **The amount leaving a vault as a shielded note is
 *    therefore checked here only as "the account contract does not publish it",
 *    which is a narrower sentence than "nobody can see it".**
 * 4. **PRESENCE IS NOT SOUND, AND ABSENCE IS SOUND ONLY IN ONE ENCODING.**
 *    Every value is compared as a whole encoded atom, in the one encoding
 *    `asHex` builds. A narrow needle can COLLIDE with a structural constant — a
 *    `Uint<64>` of 3 encodes as the single byte `03`, and so does the ledger
 *    field index 3 — so a reported occurrence must be read at its op before it
 *    is believed, which is why every occurrence carries its op index and kind.
 *    **And a value published in DERIVED form is invisible here and always will
 *    be: `recordPayment` does not publish a payout leaf, it publishes
 *    `paidMovementOf(leaf)` (`ConfidentialAccount.compact:1082-1085`), a
 *    domain-separated UNBLINDED hash of it — measured present in the very
 *    transcript where the leaf is measured absent.**
 *
 * **THE ENCODING IS THE WHOLE OF POINT 4, AND GETTING IT WRONG IS A SILENT
 * GREEN.** `assertPublishes` fails LOUDLY when it cannot find something;
 * `assertAbsent` fails QUIETLY, by finding nothing and reporting no leak. The
 * first version of this file built a `Bytes<32>` needle at full width, and
 * `CompactTypeBytes.toValue`
 * (`node_modules/@midnight-ntwrk/compact-runtime/dist/compact-types.js:409-414`)
 * STRIPS TRAILING ZERO BYTES on the way into the transcript. So a payee key
 * ending in `0x00` — one in 256 — was published as 31 bytes, missed by a
 * 32-byte needle, and reported ABSENT. Measured, not argued: `transcript.test.ts`
 * §6 constructs such a payee and pins it at both ends. **It is `C369` on the
 * other side of the same runtime, at the same odds, and every fixture in this
 * repository is a repeated constant that can never exhibit it.**
 */
import type { CircuitContext } from '@midnight-ntwrk/compact-runtime';

/** Anything a test is willing to call a secret, in the forms tests hold them. */
export type Secret = Uint8Array | bigint | string;

/**
 * ONE READABLE FIELD, AND WHERE IN THE TRANSCRIPT IT SITS.
 *
 * `kind` is not decoration. `push` is a value the circuit put on the VM stack;
 * `popeq` is a value the LEDGER handed back and the transcript records so a
 * validator can replay without the state; `key` is a map or array index inside
 * an `idx` path. **All three are public.** They are distinguished because point
 * 4 above means a human has to be able to look at a hit and say whether it is a
 * secret or a field number.
 */
export type Published = {
  readonly hex: string;
  readonly op: number;
  readonly kind: 'push' | 'popeq' | 'key';
  readonly circuitId: string;
  readonly contractAddress: string;
};

/** One circuit call's public transcript, flattened. */
export type CallTranscript = {
  readonly circuitId: string;
  readonly contractAddress: string;
  readonly opCount: number;
  readonly tags: readonly string[];
  readonly published: readonly Published[];
};

const hex = (u: Uint8Array | ArrayLike<number>): string =>
  Buffer.from(u as Uint8Array).toString('hex');

/**
 * A `Uint<n>` as the on-chain VM encodes it: LITTLE-ENDIAN, MINIMAL LENGTH,
 * and zero is the EMPTY string rather than a zero byte.
 *
 * Measured rather than assumed: a run window of `1799996400`/`1800003600`
 * (`0x6b49c3f0`/`0x6b49e010`) is written to `runWindow` as the pair
 * `["f0c3496b", "10e0496b"]`, and a `payees` of 3 appears as `"03"`.
 * **Getting this wrong is how an absence assertion passes for the wrong
 * reason**, so it is one function with one caller rather than spelled at each
 * site.
 */
export const encodeUint = (n: bigint): string => {
  if (n < 0n) throw new Error('a Uint cannot be negative');
  let v = n;
  const out: number[] = [];
  while (v > 0n) { out.push(Number(v & 0xffn)); v >>= 8n; }
  return hex(Uint8Array.from(out));
};

/**
 * A `Bytes<N>` as the on-chain VM encodes it: TRAILING ZERO BYTES STRIPPED.
 *
 * This is `CompactTypeBytes.toValue`
 * (`node_modules/@midnight-ntwrk/compact-runtime/dist/compact-types.js:409-414`)
 * and `_descriptor_0` in `contracts/managed/contract/index.js:4` is that type on
 * every 32-byte `push` the account emits — including the `push(cell(vault))` at
 * `:1617-1633` that this instrument's worked example is built on.
 *
 * **A NEEDLE BUILT AT FULL WIDTH MISSES ONE VALUE IN 256 AND REPORTS IT
 * ABSENT.** See the header's point 4.
 */
export const encodeBytes = (b: Uint8Array): string => {
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end -= 1;
  return hex(b.slice(0, end));
};

/**
 * A secret in the encoding the transcript would hold it in.
 *
 * A `string` is taken as already-encoded hex and is NOT normalised — a caller
 * who has read a value off a transcript is handing back what the VM wrote.
 */
export const asHex = (s: Secret): string =>
  typeof s === 'bigint' ? encodeUint(s)
    : typeof s === 'string' ? s.replace(/^0x/, '').toLowerCase()
      : encodeBytes(s);

/** Every `Uint8Array` field of an `AlignedValue`, or nothing if it is absent. */
const fieldsOf = (av: any): string[] =>
  (av && Array.isArray(av.value)) ? av.value.map((u: any) => hex(u)) : [];

/**
 * Every readable field inside an `EncodedStateValue`.
 *
 * A `push` does not always carry a bare cell: `map` and `array` shapes nest,
 * and a nested value is no less published for being nested. **A walker that
 * only looked at `cell` would be a check that goes green because it did not
 * look**, which is this round's named failure mode.
 */
const fromStateValue = (sv: any, into: string[]): void => {
  if (!sv || typeof sv !== 'object') return;
  switch (sv.tag) {
    case 'cell': into.push(...fieldsOf(sv.content)); return;
    case 'map':
      for (const [k, v] of (sv.content ?? [])) { into.push(...fieldsOf(k)); fromStateValue(v, into); }
      return;
    case 'array': for (const e of (sv.content ?? [])) fromStateValue(e, into); return;
    case 'boundedMerkleTree': {
      const [, leaves] = sv.content ?? [0, new Map()];
      for (const [, pair] of leaves ?? []) if (pair?.[0]) into.push(hex(pair[0]));
      return;
    }
    default: return;
  }
};

/** Flattens one `CallProofData` into ops and the fields a reader can lift out. */
const readCall = (cpd: any): CallTranscript => {
  const circuitId = String(cpd.circuitId);
  const contractAddress = String(cpd.contractAddress);
  const published: Published[] = [];
  const tags: string[] = [];
  const ops = (cpd.publicTranscript ?? []) as any[];

  ops.forEach((op, i) => {
    if (typeof op === 'string') { tags.push(op); return; }
    const tag = Object.keys(op)[0]!;
    tags.push(tag);
    const add = (hexes: string[], kind: Published['kind']) => {
      for (const h of hexes) published.push({ hex: h, op: i, kind, circuitId, contractAddress });
    };
    if (tag === 'push') { const bag: string[] = []; fromStateValue(op.push?.value, bag); add(bag, 'push'); }
    else if (tag === 'popeq') add(fieldsOf(op.popeq?.result), 'popeq');
    else if (tag === 'idx') {
      const bag: string[] = [];
      for (const k of (op.idx?.path ?? [])) if (k?.tag === 'value') bag.push(...fieldsOf(k.value));
      add(bag, 'key');
    }
  });
  return { circuitId, contractAddress, opCount: ops.length, tags, published };
};

/**
 * THE INSTRUMENT.
 *
 * **IT IS THE SAME SHAPE AS THE GUARD RAIL IT EXTENDS AND NOT A REPLACEMENT FOR
 * IT.** `signer-governance.test.ts:496` reads `sim.ledger`; this reads
 * `context.callProofDataTrace`. Two channels, two instruments, and a privacy
 * claim needs both.
 */
export class Transcript {
  private constructor(readonly calls: readonly CallTranscript[]) {}

  /**
   * From a context a circuit returned.
   *
   * The trace is in DEPTH-FIRST order, so a cross-contract payout hands back
   * the callee's `recordPayment` first and the caller's `payout` last. Both are
   * kept: a transaction publishes the whole tree, and a check that read only
   * the entry circuit would miss everything the callee said.
   */
  static of(context: CircuitContext<any> | { callProofDataTrace?: unknown }): Transcript {
    const trace = (context as any)?.callProofDataTrace;
    if (!Array.isArray(trace)) {
      throw new Error(
        'no callProofDataTrace on this context — the runtime did not hand back a transcript, ' +
        'and asserting over an absent one is the failure this instrument exists to avoid');
    }
    return new Transcript(trace.map(readCall));
  }

  /**
   * WATCHES A CONTRACT IN PLACE, FOR CALLERS THAT THROW THE CONTEXT AWAY.
   *
   * `AccountSimulator.run` keeps the three things that carry between calls and
   * discards the rest, so a simulator call's transcript is gone by the time a
   * test could ask for it. Rather than change the simulator — which every test
   * file in this directory depends on — this wraps the contract instance's own
   * `impureCircuits` table, which is a plain object the simulator dereferences
   * on each call. **Nothing in `contracts/test/simulator.ts` is edited and
   * nothing else in this directory changes behaviour.**
   *
   * `stop()` puts the originals back. Call it in a test that then wants the
   * unwrapped object; leaving it wrapped is harmless, since the wrapper only
   * records.
   */
  static watch(contract: { impureCircuits: Record<string, any> }): Tape {
    return new Tape(contract);
  }

  /** Every readable field, in transcript order, across the whole call tree. */
  get published(): readonly Published[] { return this.calls.flatMap((c) => c.published); }

  /** Total ops. Zero means there is nothing to assert over — see `assertNotVacuous`. */
  get opCount(): number { return this.calls.reduce((n, c) => n + c.opCount, 0); }

  /** Where a value appears, if it does. Whole-field equality, never substring. */
  occurrences(secret: Secret): readonly Published[] {
    const needle = asHex(secret);
    if (needle === '') {
      throw new Error('the empty encoding is how the VM writes zero and is in every transcript; ' +
        'asking whether it "appears" is not a question about privacy');
    }
    return this.published.filter((p) => p.hex === needle);
  }

  /**
   * **THE ASSERTION THE ROUND IS FOR.** Every named value must be absent from
   * the public transcript. The message names the value by the founder's own
   * words and points at the op, because a privacy failure that reports
   * `expected 1 to be 0` teaches nobody anything.
   */
  assertAbsent(secrets: Record<string, Secret>): void {
    const bad: string[] = [];
    for (const [name, value] of Object.entries(secrets)) {
      const hits = this.occurrences(value);
      if (hits.length === 0) continue;
      bad.push(
        `  ${name} (${asHex(value)}) appears ${hits.length}× in the PUBLIC TRANSCRIPT:\n` +
        hits.map((h) => `    ${h.circuitId} op ${h.op} as a ${h.kind}`).join('\n'));
    }
    if (bad.length > 0) {
      throw new Error(
        'THE PUBLIC TRANSCRIPT PUBLISHES A VALUE THIS TEST CALLS PRIVATE.\n' +
        bad.join('\n') +
        `\n  (transcript: ${this.calls.map((c) => `${c.circuitId}=${c.opCount} ops`).join(', ')})\n` +
        '  A value in a ledger READ argument reaches the transcript verbatim and writes no\n' +
        '  ledger field, so signer-governance.test.ts:496 cannot see this. C389.');
    }
  }

  /**
   * THE POSITIVE CONTROL, AND IT IS NOT OPTIONAL.
   *
   * An absence check over a transcript this instrument failed to read is green
   * for the worst possible reason — `scripts/cross-contract-spike.ts:144` is
   * that mistake sitting in this repository already. A test that asserts
   * something IS published proves the scan can find things at all.
   */
  assertPublishes(values: Record<string, Secret>): void {
    for (const [name, value] of Object.entries(values)) {
      if (this.occurrences(value).length === 0) {
        throw new Error(
          `${name} (${asHex(value)}) was expected in the public transcript and is not there. ` +
          'Either the contract changed or this instrument has stopped reading — and an ' +
          'absence check run through a blind instrument is green for no reason.');
      }
    }
  }

  /** Refuses a transcript with nothing in it. §8's first failure condition. */
  assertNotVacuous(): void {
    if (this.calls.length === 0) throw new Error('no circuit calls were recorded');
    if (this.opCount === 0) throw new Error('the transcript is empty; there is nothing to assert over');
  }

  /** For a report, a build log, or a person reading a failure. */
  describe(): string {
    return this.calls.map((c) =>
      `${c.circuitId} @${c.contractAddress.slice(0, 8)} — ${c.opCount} ops: ` +
      `${c.tags.join(' ')}`).join('\n');
  }
}

/** A running recording of every impure circuit call made on one contract. */
export class Tape {
  private readonly originals = new Map<string, any>();
  /** One entry per WATCHED call; each entry is that call's whole depth-first trace. */
  private readonly calls: any[][] = [];

  constructor(private readonly contract: { impureCircuits: Record<string, any> }) {
    for (const [name, fn] of Object.entries(contract.impureCircuits)) {
      if (typeof fn !== 'function') continue;
      this.originals.set(name, fn);
      contract.impureCircuits[name] = async (...args: any[]) => {
        const out = await fn(...args);
        /*
         * **THE WHOLE TRACE, NOT ITS LAST ENTRY.**
         *
         * `callProofDataTrace` is depth-first with the ROOT LAST
         * (`circuit-context.d.ts:81-85`), so `t[t.length - 1]` is the entry
         * circuit alone and every callee is dropped. An earlier version of this
         * line did exactly that while the comment above it claimed otherwise —
         * latent, because every `Tape` use today is single-contract, and it
         * would have failed GREEN the first time a round watched a vault
         * through a payout. `C286`'s shape. `transcript.test.ts` §7 requires
         * two calls back from one watched cross-contract call.
         */
        const t = out?.context?.callProofDataTrace;
        if (Array.isArray(t) && t.length > 0) this.calls.push([...t]);
        return out;
      };
    }
  }

  /** Puts the contract back the way it was found. */
  stop(): void {
    for (const [name, fn] of this.originals) this.contract.impureCircuits[name] = fn;
  }

  /** Forgets everything recorded so far — for skipping fixture setup. */
  clear(): this { this.calls.length = 0; return this; }

  /** Everything recorded since the last `clear()`, across every watched call. */
  get all(): Transcript { return Transcript.of({ callProofDataTrace: this.calls.flat() }); }

  /**
   * The most recent WATCHED CALL, including everything it called.
   *
   * One watched call contributes one whole depth-first trace, so this returns
   * that trace and not its last entry — see the note in the wrapper above.
   */
  get last(): Transcript {
    if (this.calls.length === 0) throw new Error('no circuit call has been recorded');
    return Transcript.of({ callProofDataTrace: [...this.calls[this.calls.length - 1]!] });
  }
}
