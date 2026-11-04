/**
 * **A RECOVERY OF THE COMPANY'S RECORDS, RAISED, APPROVED AND CARRIED OUT FROM
 * THE PERSON'S OWN WALLET, WITH NOTHING ASKED OF THE COMPANY'S SERVICE.**
 *
 * The recovery itself is `raiseRecoveryHere`, `approveRecoveryHere` and
 * `carryOutRecoveryHere`. This file runs them in one window under one passkey:
 * the company, this seat and who holds the account are read from the chain at
 * the indexer this wallet names; where the company's records stand is read
 * from the heads this device kept and the chain; and every call goes straight
 * to the chain from the person's own wallet, which pays its fee in DUST
 * (`sentFromTheOwnWallet`). The two choices that asks of the person - going on
 * without the service, and paying the fee - are lines in the window the passkey
 * approves. A recovery opens from its file, handed in parts, and its standing
 * is read from the chain, never from a list.
 *
 * What it refuses: a call that is not the one call the step makes, to the
 * company's account; any coin moved, by the call or by what the wallet adds to
 * pay for it; and anything the recovery's own checks refuse. Nothing here asks
 * the page to call the service or to relay anything.
 */
import type { Identity } from 'midnight-identity/keys/derivation';
import type { ActIntent } from 'midnight-identity/profile/request';
import { readAccountAddress, readCompanyLabel, type AccountAddress, type CompanyLabel } from 'midnight-identity/profile/company-label';
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import type { Hex } from '../../../../src/core/crypto.js';
import { ApprovalNotOwed } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import type { RoundOnChain, SignerMaterial } from '../../../../packages/web-shared/src/governed-call-builder.js';
import { standingNow, type ProposalFile } from '../../../../packages/web-shared/src/governance-from-the-chain.js';
import { anchorsOnChainAt } from '../../../../packages/web-shared/src/records-anchored-here.js';
import {
  approveRecoveryHere, carryOutRecoveryHere, raiseRecoveryHere, recoveryFileOf, recoveryPartsOf, RecoveryNotCarriedOut, type RecoveryDoors,
  type RecoveryParts,
} from '../../../../packages/web-shared/src/records-recovered-here.js';
import type { CheckedHeadsStore, HeadersKeptStore } from '../../../../packages/web-shared/src/tree-kept-here.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import {
  FeeRefused, sentFromTheOwnWallet, type Handed, type OwnWalletDoors,
} from '../chain/sent-straight-to-the-chain.js';
import type { CompanyChain } from './company-reach.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type Held, type ShownLine, type StepContext, type Words } from './definition.js';
import { ActionStopped } from './run.js';

export {
  moreThanTheFeeRefusal, notOneCallRefusal, ownWalletFrom, type OwnWalletDoors, type OwnWalletFacade,
} from '../chain/sent-straight-to-the-chain.js';

/** What a recovery asks of this wallet: the chain, its builder, the heads it kept, and the person's own wallet to pay. */
export interface RecoveryReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  readonly kept: () => { readonly checked: CheckedHeadsStore; readonly headers: HeadersKeptStore };
  readonly ownWallet: (identity: Identity, account: number) => OwnWalletDoors;
  readonly now: () => number;
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  /** How often, and for how long, the chain is watched for a call sent. */
  readonly watch?: { readonly everyMs?: number; readonly withinMs?: number };
}

/** The company, this seat and who holds the account, read from the chain and this wallet's saved keys alone. */
interface ChainOnlyReach {
  readonly accountId: string;
  readonly label: CompanyLabel;
  readonly account: AccountAddress;
  readonly material: SignerMaterial;
  readonly holders: () => Promise<AccountHoldersRead>;
  readonly builder: VaultBuilderClient;
  readonly chain: CompanyChain;
}

const HEX64 = /^[0-9a-f]{64}$/u;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.recovery.why.${key}`, ...(values === undefined ? {} : { values }),
});
const said = (e: unknown): string => String((e as Error)?.message ?? e).replace(/\.\s*$/u, '');

/**
 * **THE COMPANY AND THIS SEAT, FROM THE CHAIN AND THE SAVED KEYS ONLY**: the
 * seat the saved keys hold for the company is one the account holds on the
 * chain now. Refused, with words, otherwise. Nothing is asked of the service.
 */
async function chainOnlyReachFor(ctx: StepContext, reach: RecoveryReach): Promise<ChainOnlyReach> {
  const refuse = (key: string): never => { throw new StepRefused(why(key)); };
  const accountId = ctx.intent.fields['record'] ?? refuse('not-a-company');
  const label = readCompanyLabel(ctx.intent.fields['company']) ?? refuse('not-a-company');
  const account = readAccountAddress(ctx.intent.fields['account']) ?? refuse('not-a-company');
  if (ctx.keyring === null) return refuse('no-saved-keys');
  const seat = ctx.keyring.open().read().accounts[accountId] ?? refuse('no-seat');
  const scope = typeof seat.scope === 'string' && HEX64.test(seat.scope) ? seat.scope as Hex : refuse('no-seat');
  const chain = reach.chain();
  const builder = reach.builder();
  const holders = async (): Promise<AccountHoldersRead> => {
    const now = await chain.holders(account, label);
    if ('key' in now) throw new StepRefused(now);
    return now;
  };
  const material: SignerMaterial = { signingSecret: seat.signingSecret as Hex, blinding: seat.blinding as Hex, scope };
  const leaf = (await builder.ownSeat(material)).toLowerCase();
  if (!(await holders()).seats.some((s) => s.toLowerCase() === leaf)) refuse('seat-not-held');
  return { accountId, label, account, material, holders, builder, chain };
}

/** The approvals a recovery is carried out at, as the account counts them: the higher of its hold, its threshold and its seat bar. */
const neededFor = (round: RoundOnChain, held: AccountHoldersRead): number => Math.max(round.needed ?? 0, held.approvals, held.seatBar);

/** What one window of a recovery carries from step to step. */
interface Recovering {
  r: ChainOnlyReach | null;
  file: ProposalFile | null;
}

/** The fields a recovery's file is handed in; `proposal` is its identity on the chain. */
const FILE_FIELDS = ['proposal', 'salt', 'latest', 'lastRecovery', 'resumesFrom', 'root', 'seq'] as const;
const DIGITS = /^(?:0|[1-9][0-9]{0,15})$/u;

/** A recovery's file made again from the parts the page handed in, or null when a part is missing or not one. */
const fileFrom = (intent: ActIntent): ProposalFile | null => {
  const f = intent.fields;
  if (FILE_FIELDS.some((k) => f[k] === undefined || f[k] === '')) return null;
  if (!['proposal', 'salt', 'lastRecovery', 'resumesFrom', 'root'].every((k) => HEX64.test(f[k]!)) || !DIGITS.test(f['seq']!) || !DIGITS.test(f['latest']!)) return null;
  return recoveryFileOf({
    company: f['record']!, account: f['account']!, chainId: f['proposal']!, salt: f['salt']!, latest: f['latest']!, lastRecovery: f['lastRecovery']!,
    resumesFrom: { seq: Number(f['seq']), head: f['resumesFrom']!, root: f['root']! },
  });
};

/**
 * A step that sends one call: the recovery's doors over this wallet, the call held to `circuit`, and the outcome of
 * the send. The call always goes straight to the chain from the person's own wallet (`sentFromTheOwnWallet`), and
 * the action is told when it leaves, so a stop after it says it may be on the chain.
 */
function doorsFor(ctx: StepContext, r: ChainOnlyReach, reach: RecoveryReach, circuit: string, handed: Handed): RecoveryDoors {
  const account = ctx.held.account;
  const kept = reach.kept();
  return {
    accountId: r.accountId, account: r.account, material: r.material, indexer: r.chain.indexer, builder: r.builder,
    onChain: () => anchorsOnChainAt(r.builder, r.account, r.chain.indexer),
    checked: kept.checked, headers: kept.headers,
    send: {
      ownWallet: {
        send: async (tx: string) => {
          if (account === undefined) throw new StepRefused(why('no-account'));
          const own = reach.ownWallet(ctx.held.identity, account);
          try {
            await sentFromTheOwnWallet(own, tx, { kind: 'account-call', contract: r.account, circuit }, reach.now, () => !ctx.signal.aborted, handed, {
              handedOver: () => ctx.sentByTheWallet?.(),
            });
          } finally {
            await own.stop?.().catch(() => undefined);
          }
        },
        /* The person chose this in the window, under the passkey: it is never asked again. */
        chosen: async () => true,
      },
    },
    watch: { sleep: (ms: number) => reach.pause(ms, ctx.signal), ...reach.watch },
    now: () => new Date(reach.now()),
  };
}

/** A recovery's step that failed, as the words the window shows: refused before anything was sent, or perhaps sent. */
const refusedAs = (e: unknown, handed: Handed, notDone: string): never => {
  if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
  const code = codeOfError(e);
  if (handed.noDust === true) throw new StepRefused(why('no-dust'), code);
  if (e instanceof RecoveryNotCarriedOut) throw new StepRefused(why('still-open', { says: said(e) }), code);
  throw new StepRefused(why(handed.over && !(e instanceof FeeRefused) ? 'may-be-sent' : notDone, { says: said(e) }), code);
};

/** The parts of the recovery's file, all public, so the page can make the file again to save and hand on. */
const partsTold = (file: ProposalFile): Record<string, string | number> => {
  const p: RecoveryParts = recoveryPartsOf(file);
  return {
    proposal: p.chainId, salt: p.salt, latest: p.latest, lastRecovery: p.lastRecovery,
    resumesFrom: p.resumesFrom.head, root: p.resumesFrom.root, seq: p.resumesFrom.seq,
  };
};

const seatStep = (reach: RecoveryReach, here: Recovering, title: Words): ActionStep => ({
  title,
  run: async (ctx) => {
    if (ctx.held.account === undefined) throw new StepRefused(why('no-account'));
    here.r = await chainOnlyReachFor(ctx, reach);
  },
});

/**
 * **CARRIES THE RECOVERY OUT WHEN THE CHAIN COUNTS ITS APPROVALS, OR SAYS IT
 * WAITS**: where it stands is read from the chain; a recovery the chain does
 * not hold open is refused, and one short of its approvals sends nothing.
 */
const carryStep = (reach: RecoveryReach, here: Recovering, title: Words, told: () => Record<string, string | number>): ActionStep => ({
  title,
  run: async (ctx) => {
    const r = here.r!;
    const file = here.file;
    if (file === null) throw new StepRefused(why('not-a-recovery'));
    const handed: Handed = { over: false };
    const doors = doorsFor(ctx, r, reach, 'recoverAnchor', handed);
    const round = await standingNow(doors, file.chainId);
    if (round.held === 'never') throw new StepRefused(why('not-raised'));
    if (round.held !== 'open') throw new StepRefused(why('closed'));
    /* The account refuses any change raised before the latest removal: carried out now, it would only spend a fee. */
    if (round.outrun === true) throw new StepRefused(why('outrun'));
    const needed = neededFor(round, await r.holders());
    const count = { approvals: round.approvals, needed, ...told() };
    if (round.approvals < needed) {
      ctx.tell({ state: 'waiting-for-approvals', ...count });
      return;
    }
    try {
      await carryOutRecoveryHere(doors, file, { withoutTheService: true });
    } catch (e) {
      refusedAs(e, handed, 'not-carried');
    }
    ctx.tell({ state: 'carried-out', ...count });
  },
});

/** The lines every recovery window shows: the two choices the passkey approves, and that nothing else is sent. */
const choicesShown = (): ShownLine[] => [
  { key: 'act.recovery.shown.without-the-service', from: 'action' },
  { key: 'act.recovery.shown.own-wallet', from: 'action' },
  { key: 'act.recovery.shown.carry', from: 'action' },
  { key: 'act.recovery.shown.nothing-else', from: 'action' },
];

/** The lines a recovery opened from its file shows, from the parts the page handed in. */
const fileShown = (intent: ActIntent): ShownLine[] => {
  const latest = Number(intent.fields['latest'] ?? '');
  return [
    { key: 'act.recovery.shown.file', values: { proposal: intent.fields['proposal'] ?? '', seq: intent.fields['seq'] ?? '' }, from: 'page' },
    { key: 'act.recovery.shown.until', values: { until: Number.isSafeInteger(latest) ? new Date(latest * 1000).toISOString() : '' }, from: 'page' },
  ];
};

const STEPS = ['raise', 'carry'] as const;

/** What a recovery checks after the passkey, in every window it runs in. */
const RECOVERY_CHECKS: readonly Words[] = Object.freeze([
  { key: 'act.recovery.check.seat' },
  { key: 'act.recovery.check.standing' },
  { key: 'act.recovery.check.fee-only' },
]);

/**
 * **HOW MANY BATCHES THE RECOVERY GIVES UP, READ BEFORE THE PASSKEY**: the
 * anchors the chain holds after the batch it resumes from - for a raise, the
 * last one this wallet checked - read at the indexer this wallet names. Every
 * one of them is one this wallet has not checked; whether another signer's
 * device could is not known here. Said as unread when it cannot be read; the
 * steps read it all again before anything is sent.
 */
async function givenUpShown(reach: RecoveryReach | undefined, intent: ActIntent): Promise<ShownLine> {
  const unread: ShownLine = { key: 'act.recovery.shown.given-up-unread', from: 'wallet' };
  const account = readAccountAddress(intent.fields['account']);
  const record = intent.fields['record'];
  if (reach === undefined || account === null || record === undefined || record === '') return unread;
  try {
    let from: { readonly head: string; readonly seq: number };
    if (intent.fields['step'] === 'raise') {
      const kept = await reach.kept().checked.read(record);
      if (kept === null) return unread;
      from = { head: kept.latest.head, seq: kept.latest.seq };
    } else {
      const head = intent.fields['resumesFrom'];
      const seq = Number(intent.fields['seq']);
      if (head === undefined || !HEX64.test(head) || !Number.isSafeInteger(seq)) return unread;
      from = { head, seq };
    }
    const { landed } = await anchorsOnChainAt(reach.builder(), account, reach.chain().indexer);
    const at = landed.findIndex((l) => l.head.toLowerCase() === from.head.toLowerCase());
    if (at < 0) return unread;
    return { key: 'act.recovery.shown.given-up', values: { count: landed.length - 1 - at, seq: from.seq }, from: 'wallet' };
  } catch {
    return unread;
  }
}

/** Refused before the window opens: no wallet account to pay the fee, a step this action does not take, or a file not whole. */
const checkOf = (intent: ActIntent, held: Pick<Held, 'account'>): Words | null => {
  const step = intent.fields['step'] ?? '';
  if (!(STEPS as readonly string[]).includes(step) || !DIGITS.test(intent.fields['latest'] ?? '')) return why('not-a-recovery');
  if (step === 'carry' && fileFrom(intent) === null) return why('not-a-recovery');
  if (held.account === undefined) return why('no-account');
  return null;
};

/**
 * **THE RECOVERY ACTION: RAISE ONE, OR CARRY ONE OUT FROM ITS FILE.** A raise
 * resumes from the last head this device checked and is to be carried out
 * before `latest` (seconds); it is carried out in the same window when the
 * chain already counts its approvals. The outcome is where the chain says it
 * stands, and the parts of its file.
 */
export function recoveryAction(reach: RecoveryReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.recovery.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [
      ...(intent.fields['step'] === 'raise'
        ? [
          { key: 'act.recovery.shown.raise', from: 'action' as const },
          { key: 'act.recovery.shown.until', values: { until: new Date(Number(intent.fields['latest'] ?? 0) * 1000).toISOString() }, from: 'page' as const },
        ]
        : fileShown(intent)),
      await givenUpShown(reach, intent),
      ...choicesShown(),
    ],
    checks: RECOVERY_CHECKS,
    check: async (intent, held) => checkOf(intent, held),
    steps: (intent) => {
      const here: Recovering = { r: null, file: intent.fields['step'] === 'carry' ? fileFrom(intent) : null };
      const told = () => (here.file === null ? {} : partsTold(here.file));
      const seat = seatStep(reach, here, { key: 'act.recovery.step.seat' });
      const carry = carryStep(reach, here, { key: 'act.recovery.step.carry' }, told);
      if (intent.fields['step'] !== 'raise') return [seat, carry];
      const raise: ActionStep = {
        title: { key: 'act.recovery.step.raise' },
        run: async (ctx) => {
          const handed: Handed = { over: false };
          try {
            const { file } = await raiseRecoveryHere(doorsFor(ctx, here.r!, reach, 'propose', handed), {
              latest: new Date(Number(intent.fields['latest']) * 1000), withoutTheService: true,
            });
            here.file = file;
          } catch (e) {
            refusedAs(e, handed, 'not-raised-here');
          }
          /* Told now, so the page keeps the file's salt even when carrying it out is refused: nothing else holds it. */
          ctx.tell(partsTold(here.file!));
        },
      };
      return [seat, raise, carry];
    },
  } satisfies ActionDefinition);
}

/**
 * **THE RECOVERY KIND OF THE ONE APPROVAL**: the file the page hands in parts,
 * approved from this seat - unless the chain already counts its approval -
 * and carried out in the same window when the chain then counts every approval
 * it needs. It runs on the chain and the person's own wallet only, with none
 * of the company's records steps.
 */
export function recoveryKind(reach: RecoveryReach | undefined) {
  return Object.freeze({
    chainOnly: true as const,
    fields: FILE_FIELDS,
    checks: RECOVERY_CHECKS,
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [...fileShown(intent), await givenUpShown(reach, intent), ...choicesShown()],
    check: (intent: ActIntent): Words | null => (fileFrom(intent) === null ? why('not-a-recovery') : null),
    steps: (intent: ActIntent): readonly ActionStep[] => {
      if (reach === undefined) {
        return [{ title: { key: 'act.recovery.step.seat' }, run: async () => { throw new StepRefused(why('no-own-wallet')); } }];
      }
      const here: Recovering = { r: null, file: fileFrom(intent) };
      const approve: ActionStep = {
        title: { key: 'act.recovery.step.approve' },
        run: async (ctx) => {
          if (here.file === null) throw new StepRefused(why('not-a-recovery'));
          const handed: Handed = { over: false };
          const doors = doorsFor(ctx, here.r!, reach, 'approve', handed);
          /* A recovery the chain already counts at its bar is carried out, never approved again: an approval then pays a fee for nothing. */
          const round = await standingNow(doors, here.file.chainId);
          /* An approval of a recovery a removal outran can never be carried out: it would only spend a fee. */
          if (round.held === 'open' && round.outrun === true) throw new StepRefused(why('outrun'));
          if (round.held === 'open' && round.approvals >= neededFor(round, await here.r!.holders())) return;
          try {
            await approveRecoveryHere(doors, here.file, { withoutTheService: true });
          } catch (e) {
            if (!(e instanceof ApprovalNotOwed && e.why === 'counted')) refusedAs(e, handed, 'not-approved');
          }
        },
      };
      return [seatStep(reach, here, { key: 'act.recovery.step.seat' }), approve, carryStep(reach, here, { key: 'act.recovery.step.carry' }, () => ({}))];
    },
  });
}
