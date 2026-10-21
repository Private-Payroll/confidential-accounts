/**
 * HOW LONG EACH LONG STEP USUALLY TAKES, in seconds, as the screen states it beside the time that has run.
 * Where each number came from:
 * - PROVING (2 minutes): a proof made in the browser took 98 to 112 seconds in logs/REPORT-WASM-PROVING.txt, and the
 *   founder's own run of each long step took over three minutes, most of it proving.
 * - Every other number is an estimate from the same run (the rest of the three minutes), not a measured time.
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
 * Null where how long it takes depends on other people, not on this device or the network. Keyed by stage name without
 * importing the vault adapter, which only its own action file may; actions/create-vault.tsx checks a number is here for every stage.
 */
export const VAULT_USUAL_SECONDS = {
  checking: 5,
  building: USUAL_SECONDS_PROVING,
  sending: USUAL_SECONDS_SENDING,
  'waiting-for-chain': USUAL_SECONDS_WAITING_FOR_NETWORK,
  'filing-the-name': 20,
  adopting: 30,
  'opening-the-pool': 5,
  'reading-the-secret-back': 5,
  'setting-the-secret': USUAL_SECONDS_PROVING,
  'writing-the-copies': 30,
  'waiting-for-approvals': null,
  done: null,
} as const satisfies Readonly<Record<string, number | null>>;
