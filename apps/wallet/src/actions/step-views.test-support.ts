/*
 * A step's views and its gate for a step context a test makes by hand, over the step's own calls, as the runner
 * gives them to every step it runs.
 */
import type { AccountHoldersRead } from 'midnight-identity/profile/records-key';
import { companyViewFor, viewHeldOver, type ViewHeld } from '../../../../packages/web-shared/src/company-view.js';
import { creationSource, invitationSource, serviceSource, type AnsweredCall, type ServiceCall } from '../../../../packages/web-shared/src/records-source.js';
import type { OwnChainReads } from '../../../../packages/web-shared/src/company-view-doors.js';
import { treeKeptInMemory } from '../../../../packages/web-shared/src/tree-kept-here.js';
import type { StepContext } from './definition.js';
import { serviceCallOver, StepViews, type WalletView } from './step-views.js';
import { ownChainReadsOf } from '../chain/view-doors.js';
import type { CompanyChain } from './company-reach.js';
import type { AccountAddress } from 'midnight-identity/profile/company-label';

/**
 * **A STEP CONTEXT A TEST MAKES BY HAND, AS THE RUNNER WOULD GIVE IT.** `ctx` names the runner's calls for the step
 * (`call`, a stand-in for the page): the step is given the views, the gate and the asks built over them
 * (`viewsOfTheStep`), and never the call itself, as no step is. What `ctx` stands in for itself is kept.
 */
export const stepOverItsCall = <T extends { readonly call: AnsweredCall }>(ctx: T): Omit<T, 'call'> & ReturnType<typeof viewsOfTheStep> => {
  const { call, ...rest } = ctx;
  const step = { ...viewsOfTheStep(call), ...rest };
  callsOfSteps.set(step, call);
  return step;
};

/* The call each hand-made step was built over, for the test that made it: never on the step itself. */
const callsOfSteps = new WeakMap<object, AnsweredCall>();

/** The call a hand-made step (`stepOverItsCall`) was built over: what a test stands in for a door with, as the runner would. */
export const callOf = (step: object): AnsweredCall => {
  const call = callsOfSteps.get(step);
  if (call === undefined) throw new Error('this step was not made by stepOverItsCall, so no call stands under it');
  return call;
};

/** The views, the gate and the asks of one hand-made step, over the runner's calls for it (`call`). */
export const viewsOfTheStep = (call: AnsweredCall): Pick<StepContext, 'viewFor' | 'sendStraight' | 'movesWhoHolds' | 'invitations' | 'creation'> => {
  const views = new StepViews({ inTurn: serviceCallOver(call), direct: serviceCallOver(call) });
  return {
    viewFor: views.viewFor,
    movesWhoHolds: views.movesWhoHolds,
    invitations: invitationSource(call),
    creation: creationSource(call),
    sendStraight: async (send, into) => {
      await views.check(into);
      let handed = false;
      try {
        return await send({ ready: () => views.check(into), handedOver: () => { handed = true; } });
      } finally {
        if (handed) views.sent();
      }
    },
  };
};

const nothingRead = (): never => { throw new Error('this test reads nothing of the company through a view'); };

/** A view's reads of the company on the chain, for a test that makes none: each throws. */
export const NO_OWN_CHAIN_READS: OwnChainReads = Object.freeze({
  callState: async () => nothingRead(), vaultChain: async () => nothingRead(), payoutState: async () => nothingRead(),
  authority: async () => nothingRead(), committeeChange: async () => nothingRead(), vaultKeys: async () => nothingRead(),
});
/* A view that was never opened: it can be ended, and every read or write through it throws. */
const unopened = new Proxy({ ended: null, end: () => undefined } as Record<string | symbol, unknown>, {
  get: (kept, name) => (name in kept ? kept[name] : nothingRead),
}) as unknown as WalletView;

/** The step's view for a company a test stands in by hand, which reads nothing through one. */
export const NO_VIEW_OPENED: ViewHeld<AccountHoldersRead> = Object.freeze({ current: () => unopened, again: () => unopened });

type Api = (path: string, init?: RequestInit) => Promise<any>;

/* What a test's stand-in holders leave out, filled in so the view's check can compare them. */
const NOTHING_HELD: Omit<AccountHoldersRead, 'account'> = {
  seats: [], approvals: 1, adoptedVaults: [], threshold: 1, committee: [], vaultThresholds: [], policyBar: null, seatBar: 1, founding: '', foundingCommittee: [],
};

/*
 * A test's own service, with the reads the view's check makes answered here: no filings, and every record at version 0,
 * unless the test answers the newest versions itself (`newest`).
 */
const checkedReadsOver = (api: Api, newest: boolean): ServiceCall => async (path, init) => {
  if (/^\/api\/accounts\/[^/]+\/directory$/u.test(path) && (init?.method ?? 'GET') === 'GET') return { filings: [] };
  if (newest || !/^\/api\/accounts\/[^/]+\/manifest\/newest$/u.test(path)) return api(path, init);
  const asked = (JSON.parse(String(init?.body ?? '{}')) as { records?: unknown[] }).records ?? [];
  return { versions: asked.map(() => 0) };
};

const notRead = (what: string) => (): Promise<never> => Promise.reject(new Error(`this test's view of the company reads no ${what}`));

/**
 * A stand-in reach given the step's view over its own `api`: the view itself, over the service's routes as the test answers
 * them, so what a step reads and writes through its view reaches the test's service, checked as a step's would be. With
 * `newest`, the test's service answers the newest versions of the records the view asks about.
 */
export const viewOverItsApi = <R extends { readonly accountId: string; readonly api: Api; readonly holders?: () => Promise<unknown> }>(r: R, o: { readonly newest?: true } = {}) => {
  /* The reach the test is handed: a test that swaps its `api` or `holders` afterwards is read through the swapped one. */
  const reach: R & { stepView?: ViewHeld<AccountHoldersRead> } = { ...r };
  /* The account's call state, read through the stand-in reach's own chain when it has one, as the wallet's view reads it. */
  const own = reach as { readonly chain?: Pick<CompanyChain, 'callState'>; readonly account?: AccountAddress };
  const holders = async (): Promise<AccountHoldersRead> =>
    ({ ...NOTHING_HELD, account: '' as AccountHoldersRead['account'], ...((await reach.holders?.().catch(() => null)) ?? {}) });
  const stepView = viewHeldOver((from) => companyViewFor(serviceSource(checkedReadsOver((path, init) => reach.api(path, init), o.newest === true), r.accountId), {
    holders, onChain: notRead('anchors'), builder: { anchorHeads: notRead('heads') }, kept: () => treeKeptInMemory(),
    chain: { ...NO_OWN_CHAIN_READS, callState: () => (own.chain === undefined ? nothingRead() : ownChainReadsOf(own.chain, own.account!).callState()) },
  }, notRead('held records'), from));
  return Object.assign(reach, { stepView });
};

/**
 * `call`, with what a view of the company reads before its first answer answered as a company with no directory filed
 * yet and no record entered: for a test whose service stands in only for what the step itself reads.
 */
export const firstReadsAnswered = (call: AnsweredCall): AnsweredCall => async (method, path, body) => {
  if (method === 'GET' && /^\/api\/accounts\/[^/]+\/directory$/u.test(path)) return { status: 200, body: { filings: [] } };
  if (method === 'POST' && /^\/api\/accounts\/[^/]+\/manifest\/newest$/u.test(path)) {
    return { status: 200, body: { versions: (JSON.parse(body ?? '{}') as { records?: unknown[] }).records?.map(() => 0) ?? [] } };
  }
  return call(method, path, body);
};
