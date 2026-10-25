/**
 * HOW LONG EACH LONG STEP USUALLY TAKES, in seconds, as the screen states it beside the time that has run.
 * Where each number came from:
 * - PROVING (2 minutes): a proof made in the browser took 98 to 112 seconds in the WASM proving report, and a
 *   full run of each long step took over three minutes, most of it proving.
 * - Every other number for a company is an estimate from the same run (the rest of the three minutes), not a
 *   measured time.
 * - A deposit's numbers are measured ones only (DEPOSIT_USUAL_SECONDS); a step not measured has none.
 */
const USUAL_SECONDS_PROVING = 120;
const USUAL_SECONDS_SENDING = 30;
const USUAL_SECONDS_WAITING_FOR_NETWORK = 60;

export const COMPANY_PHASE = { proving: 'proving', sending: 'sending', waiting: 'waiting' } as const;
export type CompanyPhase = (typeof COMPANY_PHASE)[keyof typeof COMPANY_PHASE];

export const COMPANY_USUAL_SECONDS: Readonly<Record<CompanyPhase, number>> = {
  [COMPANY_PHASE.proving]: USUAL_SECONDS_PROVING,
  [COMPANY_PHASE.sending]: USUAL_SECONDS_SENDING,
  [COMPANY_PHASE.waiting]: USUAL_SECONDS_WAITING_FOR_NETWORK,
};

/**
 * Null where it was not measured: `checking` is every step of the wallet's action but the vault's own, and how long it
 * takes depends on what the company's records owe, which may include recording them on the network. Keyed by stage
 * name without importing the vault adapter, which only its own action file may; actions/create-vault.tsx checks a
 * number, or null, is here for every stage.
 */
export const VAULT_USUAL_SECONDS = {
  checking: null,
  building: USUAL_SECONDS_PROVING,
  done: null,
} as const satisfies Readonly<Record<string, number | null>>;

/**
 * HOW LONG EACH STEP OF A DEPOSIT USUALLY TAKES, in seconds, for each way money goes in; null where it was not measured
 * or waits on the person's own press in their wallet, so the screen shows the time that has run and no usual figure.
 * Measured in the browser: proving a public deposit took about 2 seconds. A private deposit's second step is made
 * whole in the person's wallet (proved, paid, sent and recorded) and has not been measured there, so it has none.
 * Keyed by the deposit adapter's step names without importing it; that adapter checks every step it lists has an entry
 * here.
 */
export const DEPOSIT_USUAL_SECONDS = {
  private: {
    'paying-in-your-wallet': null,
    'proving-the-deposit': null,
  },
  public: {
    'checking-the-vault': null,
    'proving-the-deposit': 2,
    'paying-in-your-wallet': null,
    sending: null,
    'waiting-for-the-chain': null,
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, number | null>>>>;

/** What one stage that ended leaves in the development console: which stage (its parts, such as the step and the phase), its measured seconds (to a tenth), and the usual figure the screen showed for it (null where it showed none). */
export type StageTimeRecord = { readonly stageTime: readonly string[]; readonly measuredSeconds: number; readonly usualShownSeconds: number | null };

export const stageTimeRecord = (which: readonly string[], measuredSeconds: number, usualSeconds: number | null): StageTimeRecord =>
  ({ stageTime: which, measuredSeconds: Math.round(measuredSeconds * 10) / 10, usualShownSeconds: usualSeconds });

const sameParts = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((part, i) => part === b[i]);

/**
 * Keeps which stage is running (named in parts) and writes its record when the next one begins (or when `which` is null:
 * nothing is running any more, or the screen went away). DEVELOPMENT ONLY: the development console sink carries console.warn to
 *  the web console report, one line per record, and the production build drops all of this. `since` is when the stage began and `now`
 * when this call is made; a stage that is followed by another ends where that one begins. Reads the usual figures and never changes them.
 */
export function stageTimeNoter(write: (record: StageTimeRecord) => void = (record) => { console.warn(record); }) {
  let running: { which: readonly string[]; since: number; usual: number | null } | null = null;
  return (which: readonly string[] | null, since: number, usual: number | null, now: number = Date.now()): void => {
    if (!import.meta.env.DEV) return;
    if (running !== null && which !== null && sameParts(running.which, which)) return;
    if (running !== null) write(stageTimeRecord(running.which, ((which === null ? now : since) - running.since) / 1000, running.usual));
    running = which === null ? null : { which, since, usual };
  };
}
