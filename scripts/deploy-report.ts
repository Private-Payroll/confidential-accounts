/**
 * WHAT A DEPLOY REPORT OWES, AND THE ONE THING IT MUST NEVER SAY. S6e.
 *
 * `scripts/deploy-preview.ts` established what a deploy report is for, and this
 * module is the part of it a SECOND deploy needed: the phase clock, the node's
 * own words kept verbatim, the size block, and a timeout that turns silence
 * into an error. Those were written out inside that file when it was the only
 * deploy there was.
 *
 * **AND ONE THING THAT IS NEW HERE RATHER THAN LIFTED: THE SCREEN GUARD.**
 * `C236`.
 *
 * A shielded output addressed to a vault, without a `deposit` call, is money on
 * chain that nobody can ever spend — `deposit` does `receiveShielded` AND
 * `notes.insert` in one transaction (`contracts/src/Vault.compact`), a plain
 * send does the first only, and `payout` then refuses because the note is not
 * in the pool. **No contract can refuse such an output.** So the whole defence
 * is that the address is never shown, and a person who has used any other chain
 * will paste an address into a wallet without asking.
 *
 * "Be careful not to print it" is not a defence — it is a promise, kept by
 * whoever edits the file next. `createScreen` makes it a refusal: every line
 * this report prints goes through one function that REFUSES a line carrying a
 * forbidden value, or any window of it long enough to be worth having. A
 * truncated address is still an address to somebody who can find the rest, and
 * it looks exactly like a thing to paste.
 *
 * The guard throws rather than redacting, deliberately. A redacted line is a
 * line somebody wrote intending to show something, silently altered; a refusal
 * is a defect found at the moment it is written. This runs in an instrument,
 * where the cost of stopping is one run.
 */

/* ------------------------------------------------------------------ *
 * C236: the screen guard
 * ------------------------------------------------------------------ */

/**
 * How much of a secret is too much to print.
 *
 * Eight hex characters of a 64-character address is four bytes. It identifies
 * the vault to anybody holding the chain, and — the reason that matters — it
 * reads to a person as "the address, abbreviated", which is exactly the thing
 * they will go and complete.
 */
export const SECRET_WINDOW = 8;

export class WouldHaveShownASecret extends Error {
  constructor(readonly what: string, line: string) {
    super(
      `refusing to print a line carrying ${what}. C236: a plain send to a vault's address is ` +
      'money on chain that nobody can spend, permanently, and no contract can refuse it — so ' +
      'the address is never shown, and neither is any part of it long enough to be worth ' +
      'having. A vault is named to people by its NAME. If this line genuinely needs to say ' +
      'which vault it means, say the name.\n' +
      `  the line was: ${line.slice(0, 120)}`);
    this.name = 'WouldHaveShownASecret';
  }
}

/**
 * A printer that refuses to show what it was told never to show.
 *
 * `forbidden` is a function rather than a list because the values arrive DURING
 * the run — a vault's address does not exist until it is deployed, and the
 * lines printed after that are exactly the ones at risk.
 */
export function createScreen(
  forbidden: () => Array<{ what: string; value: string }>,
  out: (line: string) => void = (l) => console.log(l),
): (line?: string) => void {
  return (line = '') => {
    for (const { what, value } of forbidden()) {
      if (typeof value !== 'string' || value.length < SECRET_WINDOW) continue;
      for (let i = 0; i + SECRET_WINDOW <= value.length; i += 1) {
        if (line.includes(value.slice(i, i + SECRET_WINDOW))) {
          throw new WouldHaveShownASecret(what, line);
        }
      }
    }
    out(line);
  };
}

/* ------------------------------------------------------------------ *
 * the phase clock
 * ------------------------------------------------------------------ */

/**
 * How long each phase took, recorded as it goes. `R1b`.
 *
 * Printed on SUCCESS AND ON REFUSAL alike — a refusal after nine minutes in
 * "Deploying" and a refusal after four seconds are different failures and the
 * error text is identical in both. Wall clock, one process, no averaging: a
 * phase that never started has no row rather than a zero, and the phase that
 * did not finish is labelled, because reporting a duration for work that never
 * happened is worse than reporting nothing.
 */
export function phaseClock(say: (line?: string) => void) {
  const phases: { name: string; ms: number }[] = [];
  let startedAt = Date.now();
  let stage = 'startup';

  return {
    get stage() { return stage; },
    begin(n: number, of: number, name: string) {
      phases.push({ name: stage, ms: Date.now() - startedAt });
      startedAt = Date.now();
      stage = name;
      say();
      say(`\x1b[1m${n} of ${of}  ${name}\x1b[0m`);
    },
    rows(outcome: 'finished' | 'stopped') {
      return [
        ...phases,
        {
          name: outcome === 'finished' ? stage : `${stage}  (did not finish)`,
          ms: Date.now() - startedAt,
        },
      ];
    },
    print(outcome: 'finished' | 'stopped') {
      const rows = this.rows(outcome);
      const w = Math.max(...rows.map((r) => r.name.length), 5);
      say();
      say('  \x1b[1mHow long each phase took\x1b[0m');
      for (const r of rows) say(`    ${r.name.padEnd(w)}  ${(r.ms / 1000).toFixed(1)}s`);
      say(`    ${'total'.padEnd(w)}  ${(rows.reduce((t, r) => t + r.ms, 0) / 1000).toFixed(1)}s`);
    },
  };
}

/* ------------------------------------------------------------------ *
 * silence, turned into an error
 * ------------------------------------------------------------------ */

/**
 * Runs a promise, or gives up on it out loud. `M-112`.
 *
 * **A `try/catch` cannot save you from a promise that never settles**, and that
 * is not hypothetical: a deploy sat silent for seven minutes inside
 * `estimateRegistration` after the node websocket closed cleanly. A wrong
 * answer is recoverable and a slow answer is annoying; silence is the one
 * outcome nobody can act on, and these scripts run with no console to inspect.
 */
export async function withTimeout<T>(what: string, ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * what an error is actually carrying
 * ------------------------------------------------------------------ */

/**
 * Everything an error carries, walked. These libraries wrap: the useful cause
 * is under `.cause`, `.errors`, or an axios `.response.data`, sometimes two
 * deep, and `e.message` alone gives "Transaction submission error".
 *
 * `explain` is passed in rather than imported so this module holds no table of
 * node error codes — `scripts/node-errors.ts` is the one place that lives.
 */
export function describeError(
  e: any, explain: (text: string) => string | null, depth = 0,
): string {
  if (e == null || depth > 4) return String(e);
  const pad = '  '.repeat(depth);
  const bits: string[] = [];
  const msg = e.message ?? String(e);
  bits.push(`${pad}${e.name ? e.name + ': ' : ''}${msg}`);
  const explained = explain(String(msg));
  if (explained) bits.push(`${pad}  \x1b[1m${explained}\x1b[0m`);
  /*
   * A dropped websocket carries no rejection code, because the chain never saw
   * the transaction. Without saying so it reads like a protocol failure and
   * sends you looking in the wrong place. M-23, M-59.
   */
  if (/normal closure|disconnected|socket hang up|ECONNRESET/i.test(String(msg))) {
    bits.push(`${pad}  \x1b[1mthe node websocket dropped — the transaction was never submitted, so this is worth retrying\x1b[0m`);
  }
  if (e.code) bits.push(`${pad}  code: ${e.code}`);
  const data = e.response?.data;
  if (data) bits.push(`${pad}  response: ${typeof data === 'string' ? data.slice(0, 400) : JSON.stringify(data).slice(0, 400)}`);
  if (Array.isArray(e.errors)) for (const sub of e.errors.slice(0, 3)) bits.push(describeError(sub, explain, depth + 1));
  if (e.cause && e.cause !== e) bits.push(describeError(e.cause, explain, depth + 1));
  return bits.join('\n');
}

/**
 * Every line the node's RPC layer printed that carries a rejection, kept whole.
 *
 * `R1b`: *"on refusal: the node's error IN FULL, with its numeric code,
 * unabridged and unparaphrased."* The exception cannot supply it — it is
 * `SubmissionError: Transaction submission error` and carries neither the code
 * nor the node's words. The code arrives on the console, from Polkadot's RPC
 * layer, and is discarded the moment it scrolls. So it is captured here.
 *
 * **AN EMPTY LIST IS ITSELF A FINDING**: no node line means the node never
 * answered, which is a dropped websocket and not a refusal.
 */
export function captureNodeLines(explain: (text: string) => string | null): string[] {
  const lines: string[] = [];
  for (const key of ['log', 'error', 'warn'] as const) {
    const original = console[key].bind(console);
    console[key] = (...args: unknown[]) => {
      original(...args);
      try {
        const joined = args.map(String).join(' ');
        if (/Custom error:\s*\d+|Invalid Transaction|SubmissionError|1010:|dispatch|Priority is too low/i.test(joined)) {
          lines.push(joined);
        }
        const explained = explain(joined);
        if (explained) original(`  \x1b[1m\x1b[33m^ ${explained}\x1b[0m`);
      } catch { /* never let annotation break logging */ }
    };
  }
  return lines;
}
