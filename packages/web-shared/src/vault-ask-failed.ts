/**
 * **WHY AN ASK OF THE VAULT WORKER FAILED**, as one error class and the words each kind of failure is said in. Every
 * ask the page makes of the worker refuses with it.
 */
import { PROOF_CEILING_MS } from './proof-ceiling.js';

/**
 * Why an ask of the vault worker failed: the worker said nothing for the time
 * limit, it stopped, it sent an answer the page could not read, a new worker did
 * not start, or the worker answered with a refusal of its own.
 */
export type VaultAskFailure = 'took-too-long' | 'stopped' | 'unreadable-answer' | 'did-not-start' | 'answered';

/**
 * **EVERY FAILED ASK OF THE VAULT WORKER, ONE CLASS.** `reason` says which kind
 * of failure it was. When the worker answered with a refusal, the message is the
 * worker's own, `name` and `workerName` are the name of the worker's error, and
 * `kind` is how proving material was refused when that was the refusal. The
 * message never says whether anything was sent: that is for the step that
 * asked, which alone knows whether it sent anything before.
 */
export class VaultAskFailed extends Error {
  readonly ask: string;
  readonly reason: VaultAskFailure;
  readonly workerName?: string;
  readonly kind?: string;
  constructor(ask: string, reason: VaultAskFailure, message: string, said: { name?: string; kind?: string } = {}) {
    super(message);
    this.ask = ask;
    this.reason = reason;
    this.name = said.name ?? 'VaultAskFailed';
    if (said.name !== undefined) this.workerName = said.name;
    if (said.kind !== undefined) this.kind = said.kind;
  }
}

const MINUTES = Math.round(PROOF_CEILING_MS / 60_000);
const WORKER = 'the part of this page that builds and proves vault transactions';
export const FAILED_BECAUSE: Record<Exclude<VaultAskFailure, 'answered'>, string> = {
  'took-too-long': `${WORKER} said nothing for ${MINUTES} minutes, so this page stopped it. Try again with this page open `
    + 'in front and other heavy work closed.',
  stopped: `${WORKER} stopped before it answered. Try again; if it happens again, reload the page.`,
  'unreadable-answer': `${WORKER} sent an answer this page could not read, so this page stopped it. Try again; if it `
    + 'happens again, reload the page.',
  'did-not-start': 'the part of this page that builds vault transactions did not start.',
};
