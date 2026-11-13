import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import type { CompanyKeyHere } from 'vaults-web-shared/company-key-here.js';
import { api } from 'vaults-web-shared/keyring.js';
import { chooseServiceInTheWallet, serviceOutcomeOf, SERVICE_STATE, type ServiceAsked } from 'vaults-web-shared/proposal-in-the-wallet.js';
import { companyServiceFiledHere, serviceOpenerOfSigner, type ServiceReach } from 'vaults-web-shared/company-service-here.js';
import type { ActOutcome } from 'vaults-web-shared/wallet-act.js';
import { canonical } from '../../../../src/core/crypto.js';
import {
  companyServiceOf, serviceAddressRefusal, serviceAsked, serviceInForce, type CompanyService, type ServiceVersion,
} from '../../../../src/midnight/company-service-record.js';
import { namedFor } from './create-vault.js';
import { keyringFor } from './keyring-person.js';
import { ACT_REFUSAL, refusalOf, SEAT_REFUSALS, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { seatAndRecordsHere } from './vault-private-money.js';

export { SERVICE_STATE };

export const SERVICE_READ = { read: 'read', unread: 'unread', refused: 'refused' } as const;

/** One signer who has filed the choice being asked for: the seat they hold, and whether it is this device's own. */
export interface ServiceFiler {
  readonly seat: string;
  readonly you: boolean;
}

/** What the page shows of the company's choice: the one in force, the one being asked for and who has filed it, or why none can be read. */
export type ServiceHeld =
  | {
    readonly of: typeof SERVICE_READ.read;
    readonly inForce: CompanyService;
    readonly unchosen: string | null;
    readonly asked: { readonly choice: CompanyService; readonly filers: readonly ServiceFiler[]; readonly needed: number } | null;
  }
  | { readonly of: typeof SERVICE_READ.unread; readonly why: string; readonly canFileOver: boolean }
  | { readonly of: typeof SERVICE_READ.refused; readonly why: ActRefusal };

/** The filers of the newest choice asked for, as `serviceAsked` counts them: every seat that filed that same choice since it last changed. */
function filersOf(versions: readonly ServiceVersion[]): readonly string[] {
  let said: string | null = null;
  let by = new Set<string>();
  for (const v of [...versions].sort((a, b) => a.version - b.version)) {
    if (v.filer === null) continue;
    const now = canonical(v.choice);
    if (said === null || now !== said) { said = now; by = new Set(); }
    by.add(v.filer.toLowerCase());
  }
  return [...by];
}

type ServiceRead = Awaited<ReturnType<typeof companyServiceFiledHere>>;
/** Whether the shared read could not read the company's service, which it says with why. */
const wasUnread = (got: ServiceRead): got is Extract<ServiceRead, { readonly unread: string }> => typeof (got as { readonly unread?: unknown }).unread === 'string';

/** Reads the company's choice of service as the wallet reads it, from the page's own seat and the company's directory. */
export async function readService(personId: string, companyId: string): Promise<ServiceHeld> {
  try {
    const here = await seatAndRecordsHere(personId, companyId);
    if (typeof here === 'string') return { of: SERVICE_READ.refused, why: here };
    const companyKeys: CompanyKeyHere = here.viewingKey;
    const reach: ServiceReach = {
      accountId: companyId, api: (path) => api(path), judges: { directoryHereFor: () => here.directory }, label: here.company, account: here.account,
      companyKeys, roster: async () => here.opened,
      opener: serviceOpenerOfSigner(companyId, here.mine, companyKeys),
    };
    const got = await companyServiceFiledHere(reach);
    if (wasUnread(got)) return { of: SERVICE_READ.unread, why: got.unread, canFileOver: got.fileOver !== undefined };
    const seats = (await here.directory()).dir.seats;
    const own = seats.find((s) => s.seat === here.leaf)?.signingKey.toLowerCase();
    const inForce = serviceInForce(got.versions, got.needed);
    const asked = serviceAsked(got.versions, got.needed);
    return {
      of: SERVICE_READ.read, inForce: inForce.choice, unchosen: inForce.unchosen ?? null,
      asked: asked === null ? null : {
        choice: asked.choice, needed: asked.needed,
        filers: filersOf(got.versions).map((key) => ({ seat: seats.find((s) => s.signingKey.toLowerCase() === key)?.seat ?? key, you: key === own })),
      },
    };
  } catch (e) {
    return { of: SERVICE_READ.refused, why: refusalOf(e) };
  }
}

/* What the wallet's act can stop with, as the page tells it. Each is worded in `locales/pages/service`, as `service.why.` and the code. */
export const SERVICE_WHY = {
  seat: 'seat', notAsAsked: 'not-as-asked', mayNotFile: 'may-not-file', seatNotBelieved: 'seat-not-believed', keyBeingChanged: 'key-being-changed',
  filedMeanwhile: 'filed-meanwhile', notFiled: 'not-filed', notEntered: 'not-entered', unread: 'unread', stopped: 'stopped', other: 'other',
} as const;
export type ServiceWhy = (typeof SERVICE_WHY)[keyof typeof SERVICE_WHY];

const WHY_OF_CODE: Readonly<Record<string, ServiceWhy>> = {
  ...Object.fromEntries(SEAT_REFUSALS.map((c) => [c, SERVICE_WHY.seat] as const)),
  'not-an-address': SERVICE_WHY.notAsAsked, 'address-without-own': SERVICE_WHY.notAsAsked, 'not-a-choice': SERVICE_WHY.notAsAsked,
  'role-may-not-file': SERVICE_WHY.mayNotFile, 'seat-not-believed': SERVICE_WHY.seatNotBelieved, 'key-being-changed': SERVICE_WHY.keyBeingChanged,
  'filed-meanwhile': SERVICE_WHY.filedMeanwhile, 'not-filed': SERVICE_WHY.notFiled, 'not-entered': SERVICE_WHY.notEntered, unread: SERVICE_WHY.unread,
};

/** Stops after which the choice may already be filed, so the page reads it again and says so. */
const PARTLY: ReadonlySet<ServiceWhy> = new Set<ServiceWhy>([SERVICE_WHY.notEntered, SERVICE_WHY.stopped, SERVICE_WHY.other]);

const CODE = /^act\.choose-company-service\.why\.([a-z-]+)$/u;

function serviceWhyOf(refused: string | undefined): ServiceWhy {
  if (refused === undefined) return SERVICE_WHY.stopped;
  const code = CODE.exec(refused)?.[1];
  return code !== undefined && Object.prototype.hasOwnProperty.call(WHY_OF_CODE, code) ? WHY_OF_CODE[code]! : SERVICE_WHY.other;
}

export const SERVICE_ACTED = { done: 'done', stopped: 'stopped', refused: 'refused', problem: 'problem' } as const;

/** What is wrong with a choice asked of the page, before the wallet is asked: no such choice, or an address that cannot be one. */
export const SERVICE_PROBLEM = { notAChoice: 'not-a-choice', notAnAddress: 'not-an-address' } as const;
type ServiceProblem = (typeof SERVICE_PROBLEM)[keyof typeof SERVICE_PROBLEM];

/** The three services a company can choose, by the wallet's word for each, compared and sent, never shown. */
export const SERVICE_CHOICE = { ours: 'ours', own: 'own', none: 'none' } as const;

export type ServiceActed =
  | { readonly of: typeof SERVICE_ACTED.done; readonly state: string | null; readonly filed: number | null; readonly needed: number | null }
  | { readonly of: typeof SERVICE_ACTED.stopped; readonly why: ServiceWhy; readonly partial: boolean; readonly handedOver: boolean }
  | { readonly of: typeof SERVICE_ACTED.refused; readonly why: ActRefusal }
  | { readonly of: typeof SERVICE_ACTED.problem; readonly problem: ServiceProblem };

function actedOf(ended: ActOutcome): ServiceActed {
  if (ended.of === SERVICE_ACTED.done) return { of: SERVICE_ACTED.done, ...serviceOutcomeOf(ended) };
  const why = serviceWhyOf(ended.refused);
  return { of: SERVICE_ACTED.stopped, why, partial: PARTLY.has(why), handedOver: ended.relayed > 0 || ended.unconfirmed > 0 };
}

/** The wallet's own refusals of a choice, held here first so a page that is asked for nonsense never opens the wallet. */
function problemWith(asked: ServiceAsked): ServiceProblem | null {
  if (asked.service === SERVICE_CHOICE.own) return serviceAddressRefusal(asked.at) === null ? null : SERVICE_PROBLEM.notAnAddress;
  return companyServiceOf({ service: asked.service }) === null ? SERVICE_PROBLEM.notAChoice : null;
}

async function namedBefore(personId: string, companyId: string): Promise<{ record: string; company: CompanyLabel; account: AccountAddress } | ActRefusal> {
  if (ACCOUNT_ORIGIN === '') return ACT_REFUSAL.notSetUp;
  if (!(await keyringFor(personId))) return ACT_REFUSAL.notSignedIn;
  const named = await namedFor(companyId);
  return named === null ? ACT_REFUSAL.didNotFinish : { record: named.record, company: named.company as CompanyLabel, account: named.account as AccountAddress };
}

/** Files the company's choice of service through the wallet. The page then reads it again; what it shows is that read, not this act's count. */
export async function chooseService(
  personId: string, companyId: string, asked: ServiceAsked, onStep?: (step: number, steps: number) => void,
): Promise<ServiceActed> {
  const wrong = problemWith(asked);
  if (wrong !== null) return { of: SERVICE_ACTED.problem, problem: wrong };
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return { of: SERVICE_ACTED.refused, why: named };
    const step = onStep === undefined ? {} : { onStep: (at: { step: number; steps: number }) => onStep(at.step, at.steps) };
    return actedOf(await chooseServiceInTheWallet({ ...named, ...asked }, ACCOUNT_ORIGIN, step));
  } catch (e) {
    return { of: SERVICE_ACTED.refused, why: refusalOf(e) };
  }
}
