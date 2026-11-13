/**
 * **SET THE COMPANY'S RECOVERY WINDOW, OR ADD THIS SEAT'S SIGNATURE TO IT.** The page names a length (`seconds`). If a
 * change of the window to that length is gathering signatures, this seat signs it and files it again with its
 * signature added; any seat may. Otherwise this seat starts a change to that length, which only a seat whose role files
 * policy (an admin, or a seat with no role set) may. The change comes into force once signatures of seats the chain holds
 * reach the seat bar; each signer's device holds recoveries to it once its own upkeep has read it. It ends with the
 * upkeep, which keeps the window read beside the records it checked.
 */
import type { ActIntent } from 'midnight-identity/profile/request';
import { sign, signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import {
  durationSaid, RECOVERY_WINDOW_RANGE, RECOVERY_WINDOW_RECORD, sealRecoveryWindow, windowMessage, windowSecondsRefusal, type WindowChange,
} from '../../../../src/midnight/recovery-window-record.js';
import { quorumOf } from '../../../../src/midnight/seat-quorum.js';
import { CompanyKeyBeingChanged } from '../../../../packages/web-shared/src/company-key-here.js';
import { mayFileHere } from '../../../../packages/web-shared/src/may-file-here.js';
import { recoveryWindowHere, type WindowRead } from '../../../../packages/web-shared/src/recovery-window-here.js';
import { readersIn } from '../../../../packages/web-shared/src/vault-page-doors.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { companyReachFor, keptReach, type CompanyChain, type CompanyReach } from './company-reach.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';
import { companyRecordFiledHere } from './company-record-filed.js';
import { said } from './proposal-kinds.js';

export interface SetRecoveryWindowReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A test's company reach in place of the one read from the page and the chain. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
}

/** What the act tells the page: the change in force, or still gathering signatures. */
export const WINDOW_STATE = { inForce: 'in-force', waiting: 'waiting-for-signers' } as const;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.set-recovery-window.why.${key}`, ...(values === undefined ? {} : { values }),
});

/** The length the page names, in seconds, or why it is not one the window's range allows. */
export const secondsOf = (intent: ActIntent): number | Words => {
  const text = intent.fields['seconds'] ?? '';
  const seconds = /^[1-9][0-9]{0,15}$/u.test(text) ? Number(text) : Number.NaN;
  return windowSecondsRefusal(seconds) === null ? seconds
    : why('outside-the-range', { shortest: durationSaid(RECOVERY_WINDOW_RANGE.shortest), longest: durationSaid(RECOVERY_WINDOW_RANGE.longest) });
};

/** The change this seat files: the waiting change to the same length with its signature added, else a new change it starts. */
const changeFiled = (read: WindowRead, seconds: number, mine: { readonly publicKey: Hex; readonly signature: (message: string) => Hex }, company: string): {
  readonly change: WindowChange; readonly starts: boolean;
} => {
  const waiting = read.waiting;
  if (waiting !== null && waiting.seconds === seconds) {
    const others = waiting.change.signatures.filter((s) => s.publicKey.toLowerCase() !== mine.publicKey);
    const signature = mine.signature(windowMessage(company, waiting.change));
    return { change: { sequence: waiting.sequence, seconds, signatures: [...others, { publicKey: mine.publicKey, signature }] }, starts: false };
  }
  const sequence = (read.inForce?.sequence ?? 0) + 1;
  return { change: { sequence, seconds, signatures: [{ publicKey: mine.publicKey, signature: mine.signature(windowMessage(company, { sequence, seconds })) }] }, starts: true };
};

/** Files `change` as the next version, sealed to every seat this device believes and to the company's key, and enters it. */
async function filedHere(r: CompanyReach, read: WindowRead, change: WindowChange): Promise<void> {
  let sealing: ReturnType<CompanyReach['companyKeys']['sealing']>;
  try {
    sealing = r.companyKeys.sealing();
  } catch (e) {
    if (e instanceof CompanyKeyBeingChanged) throw new StepRefused(why('key-being-changed', { says: said(e).replace(/\.\s*Nothing was sealed\..*$/su, '') }), codeOfError(e));
    throw e;
  }
  const seats = await readersIn(async () => read.here).signers();
  if (!seats.some((s) => s.id.toLowerCase() === r.leaf.toLowerCase())) throw new StepRefused(why('seat-not-believed'));
  const rec = sealRecoveryWindow({ company: r.accountId, version: read.highest + 1, sealing, change, seats });
  await companyRecordFiledHere(r, rec, why);
}

/** The file step: reads the window whole, then signs and files this seat's change, and tells how many have signed it. */
async function fileTheWindow(ctx: StepContext, r: CompanyReach, seconds: number): Promise<void> {
  const read = await recoveryWindowHere(r);
  if ('unread' in read) throw new StepRefused(why('unread', { says: read.unread }));
  const signingSecret = r.seat.signingSecret as Hex;
  const publicKey = signingPublicKeyOf(signingSecret).toLowerCase() as Hex;
  const bar = Number(read.here.holders.seatBar);
  if (read.inForce?.seconds === seconds && read.waiting === null) {
    ctx.tell({ state: WINDOW_STATE.inForce, signed: bar, needed: bar });
    return;
  }
  const { change, starts } = changeFiled(read, seconds, { publicKey, signature: (m) => sign(m, signingSecret) }, r.accountId);
  if (starts) {
    const not = await mayFileHere(async () => read.here, publicKey, RECOVERY_WINDOW_RECORD.kind);
    if (not !== null) throw new StepRefused(why(not.why === 'role' ? 'role-may-not-start' : 'seat-not-believed'));
  }
  await filedHere(r, read, change);
  const n = quorumOf(read.here.dir.seats, windowMessage(r.accountId, change), change.signatures, (seat) => read.here.holders.seats.includes(seat.seat));
  const signed = typeof n === 'number' ? n : 0;
  ctx.tell({ state: signed >= bar ? WINDOW_STATE.inForce : WINDOW_STATE.waiting, signed, needed: bar });
}

/** The act: read the company and the seat, the upkeep's first step, file, the upkeep's last step. */
export function setRecoveryWindowAction(reach: SetRecoveryWindowReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.set-recovery-window.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => {
      const seconds = secondsOf(intent);
      return [
        typeof seconds === 'number'
          ? { key: 'act.set-recovery-window.shown.length', values: { length: durationSaid(seconds) }, from: 'page' as const }
          : { key: 'act.set-recovery-window.shown.not-a-length', from: 'page' as const },
        { key: 'act.set-recovery-window.shown.bar', from: 'action' },
        { key: 'act.set-recovery-window.shown.devices', from: 'action' },
        ...upkeepShown(),
        { key: 'act.set-recovery-window.shown.nothing-else', from: 'action' },
      ];
    },
    checks: [
      { key: 'act.set-recovery-window.check.range', values: { shortest: durationSaid(RECOVERY_WINDOW_RANGE.shortest), longest: durationSaid(RECOVERY_WINDOW_RANGE.longest) } },
      { key: 'act.set-recovery-window.check.seat' },
      { key: 'act.set-recovery-window.check.read' },
      UPKEEP_CHECK,
    ],
    check: async (intent) => {
      if ((intent.fields['record'] ?? '') === '') return why('not-a-company');
      const seconds = secondsOf(intent);
      return typeof seconds === 'number' ? null : seconds;
    },
    steps: (intent) => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const seat: ActionStep = { title: { key: 'act.set-recovery-window.step.seat' }, run: async (ctx) => { await read.at(ctx); } };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      const file: ActionStep = {
        title: { key: 'act.set-recovery-window.step.file' },
        run: async (ctx) => {
          const seconds = secondsOf(intent);
          if (typeof seconds !== 'number') throw new StepRefused(seconds);
          await fileTheWindow(ctx, await read.at(ctx), seconds);
        },
      };
      return [seat, upkeep.first, file, upkeep.last];
    },
  } satisfies ActionDefinition);
}
