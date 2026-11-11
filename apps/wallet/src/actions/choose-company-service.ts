/**
 * **THE COMPANY'S CHOICE OF SERVICE, FILED FROM THE PERSON'S OWN WALLET, BEHIND ONE PASSKEY.** The page names one of
 * three: our service, the company's own service at the secure site address it names, or none. The address is refused
 * before anything is read or filed, exactly as every reader refuses it (`serviceAddressRefusal`): https only, a site's
 * name and nothing more, never a number, this device, a sign-in or a path.
 *
 * The wallet reads the versions already filed as every act reads them (`companyServiceFiledHere`), and refuses to
 * file over a record it cannot read whole, except where filing the next version is what resolves it: the newest
 * version served was never entered, a version this seat cannot open stands below the bar, or the choice agreed is no
 * longer agreed by the signers seated now. It then files the next version, sealed to every signer it believes seated
 * now and once to the company's key it seals under now, signed by this seat, and enters it in the company's records;
 * the upkeep's last step anchors it. Nothing is filed while the company's keys seal nothing new (a removed signer's
 * key not yet changed). A version is only this seat asking: the choice is in force once as many different seated
 * signers as a change of policy needs have each filed it, unchanged, one version after another (`serviceInForce`).
 * Filing a different choice starts the count again from this seat and leaves the choice in force where it was until
 * the new one reaches the bar. Filing the same choice again counts this seat once. A signer seated after the choice was
 * filed reads it with the company's key, and nobody files it again for it.
 *
 * The page is told whether the choice this seat filed is in force, how many seats have filed it in a row, and how
 * many it needs. Nothing here moves money.
 */
import type { ActIntent } from 'midnight-identity/profile/request';
import { canonical, signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import {
  COMPANY_SERVICE_RECORD, companyServiceOf, openCompanyService, sealCompanyService, serviceAddressRefusal, serviceAsked,
  type CompanyService, type ServiceAsked, type ServiceOpener,
} from '../../../../src/midnight/company-service-record.js';
import { companyRecordEntry } from '../../../../src/midnight/record-manifest.js';
import { verifiedCompanyFiler, type SealedCompanyRecord } from '../../../../src/midnight/sealed-record-wire.js';
import { VaultPoolVersionAlreadyFiled } from '../../../../src/midnight/vault-pool.js';
import { HttpCompanyRecordStore } from '../../../../packages/web-shared/src/http-sealed-pool-store.js';
import { mayFileHere } from '../../../../packages/web-shared/src/may-file-here.js';
import { readersIn, type DirectoryHere } from '../../../../packages/web-shared/src/vault-page-doors.js';
import { CompanyKeyBeingChanged } from '../../../../packages/web-shared/src/company-key-here.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import {
  companyReachFor, companyServiceFiledHere, enteredFor, keptReach, type CompanyChain, type CompanyReach, type ServiceFiled, type ServiceUnread,
} from './company-reach.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { ActionStopped } from './run.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/** What the wallet reads the company with: its own chain and builder, and its pause. */
export interface ChooseCompanyServiceReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Stands in for the wallet's own read of the company, in tests. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
}

/** Where the choice this seat filed stands, as the action tells the page. */
export const CHOOSE_SERVICE_STATE = { inForce: 'in-force', waiting: 'waiting-for-signers' } as const;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.choose-company-service.why.${key}`, ...(values === undefined ? {} : { values }),
});
const said = (e: unknown): string => String((e as Error)?.message ?? e);

/** The choice the page named, or why it names none a company can make; the address is judged as every reader judges it. */
export const choiceOf = (intent: ActIntent): CompanyService | Words => {
  const f = intent.fields;
  const service = f['service'];
  if (service === 'own') {
    const refused = serviceAddressRefusal(f['at']);
    if (refused !== null) return why('not-an-address', { says: refused });
  } else if (f['at'] !== undefined) {
    return why('address-without-own');
  }
  const choice = companyServiceOf(service === 'own' ? { service, at: f['at'] } : { service });
  return choice ?? why('not-a-choice');
};

/** The choice in plain words, as the window shows it before the passkey. */
const shownChoice = (intent: ActIntent): ShownLine => {
  const service = intent.fields['service'] ?? '';
  if (service === 'ours' || service === 'none') return { key: `act.choose-company-service.shown.${service}`, from: 'page' };
  if (service === 'own') return { key: 'act.choose-company-service.shown.own', values: { at: intent.fields['at'] ?? '' }, from: 'page' };
  return { key: 'act.choose-company-service.shown.not-a-choice', values: { service }, from: 'page' };
};

/** Whether a version opens, for this seat, as exactly `choice`. */
const asks = (rec: SealedCompanyRecord, opener: ServiceOpener, choice: CompanyService): boolean => {
  try {
    return canonical(openCompanyService(rec, opener)) === canonical(choice);
  } catch {
    return false;
  }
};

/**
 * Files `choice` as the next version after every version served, sealed to every signer this device believes seated
 * now and to the company's key it seals under now, signed by this seat, and entered in the company's records. Refused
 * before anything is filed unless this seat is believed seated and its role files the company's policy records, since a
 * version no reader believes would leave the choice unread for every seat, and while the company's keys seal nothing new. When the newest version served is this seat's own asking the same choice and no entry
 * names it (its filing was not entered), it is entered again instead, so the version every seat stops at is the one
 * that resolves it. Returns what the newest versions ask once this one is counted.
 */
async function filedHere(r: CompanyReach, choice: CompanyService, filed: ServiceFiled): Promise<ServiceAsked> {
  const read = r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  let once: Promise<DirectoryHere> | null = null;
  const directory = (): Promise<DirectoryHere> => (once ??= read());
  const signingSecret = r.seat.signingSecret as Hex;
  const not = await mayFileHere(directory, signingPublicKeyOf(signingSecret), COMPANY_SERVICE_RECORD.kind);
  if (not !== null) throw new StepRefused(why(not.why === 'role' ? 'role-may-not-file' : 'seat-not-believed'));
  const signers = await readersIn(directory).signers();
  if (!signers.some((s) => s.id.toLowerCase() === r.leaf.toLowerCase())) throw new StepRefused(why('seat-not-believed'));
  const filer = signingPublicKeyOf(signingSecret).toLowerCase() as Hex;
  const own = filed.unentered;
  if (own !== undefined && verifiedCompanyFiler(own)?.toLowerCase() === filer && asks(own, r.opener, choice)) {
    try {
      await enteredFor(r).enter([companyRecordEntry(own)]);
    } catch (e) {
      if (e instanceof ActionStopped) throw e;
      throw new StepRefused(why('not-entered', { says: said(e) }), codeOfError(e));
    }
    return serviceAsked([...filed.versions, { version: own.version, filer, choice }], filed.needed)!;
  }
  let sealing: ReturnType<CompanyReach['companyKeys']['sealing']>;
  try {
    sealing = r.companyKeys.sealing();
  } catch (e) {
    if (e instanceof CompanyKeyBeingChanged) throw new StepRefused(why('key-being-changed', { says: said(e).replace(/\.\s*Nothing was sealed\..*$/su, '') }), codeOfError(e));
    throw e;
  }
  const rec = sealCompanyService({ company: r.accountId, version: filed.highest + 1, sealing, choice, signers });
  const store = new HttpCompanyRecordStore(r.accountId, r.send, signingSecret, r.judges.filingJudgeFor(r.accountId, r.label, r.account, r.companyKeys, r.roster));
  try {
    await store.put(rec);
  } catch (e) {
    if (e instanceof ActionStopped) throw e;
    if (e instanceof VaultPoolVersionAlreadyFiled) throw new StepRefused(why('filed-meanwhile'), codeOfError(e));
    throw new StepRefused(why('not-filed', { says: said(e) }), codeOfError(e));
  }
  try {
    await enteredFor(r).enter([companyRecordEntry(rec)]);
  } catch (e) {
    if (e instanceof ActionStopped) throw e;
    throw new StepRefused(why('not-entered', { says: said(e) }), codeOfError(e));
  }
  return serviceAsked([...filed.versions, { version: rec.version, filer, choice }], filed.needed)!;
}

/**
 * **CHOOSING THE COMPANY'S SERVICE, IN THE WALLET**: one window and one passkey. The wallet reads the company and this
 * seat, does what the company owes first (the upkeep), files this seat's choice and ends with the upkeep's anchor.
 */
export function chooseCompanyServiceAction(reach: ChooseCompanyServiceReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.choose-company-service.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [
      shownChoice(intent),
      { key: 'act.choose-company-service.shown.bar', from: 'action' },
      { key: 'act.choose-company-service.shown.sealed', from: 'action' },
      ...upkeepShown(),
      { key: 'act.choose-company-service.shown.nothing-else', from: 'action' },
    ],
    checks: [
      { key: 'act.choose-company-service.check.address' },
      { key: 'act.choose-company-service.check.seat' },
      { key: 'act.choose-company-service.check.read' },
      UPKEEP_CHECK,
    ],
    check: async (intent) => {
      if ((intent.fields['record'] ?? '') === '') return why('not-a-company');
      const choice = choiceOf(intent);
      return 'key' in choice ? choice : null;
    },
    steps: (intent) => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const seat: ActionStep = {
        title: { key: 'act.choose-company-service.step.seat' },
        run: async (ctx) => { await read.at(ctx); },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      const file: ActionStep = {
        title: { key: 'act.choose-company-service.step.file' },
        run: async (ctx) => {
          const choice = choiceOf(intent);
          if ('key' in choice) throw new StepRefused(choice);
          const r = await read.at(ctx);
          const got = await companyServiceFiledHere(r);
          const filed = 'unread' in got ? got.fileOver : got;
          if (filed === undefined) throw new StepRefused(why('unread', { says: (got as ServiceUnread).unread }));
          const asked = await filedHere(r, choice, filed);
          ctx.tell({
            state: asked.by >= asked.needed ? CHOOSE_SERVICE_STATE.inForce : CHOOSE_SERVICE_STATE.waiting,
            filed: asked.by, needed: asked.needed,
          });
        },
      };
      return [seat, upkeep.first, file, upkeep.last];
    },
  } satisfies ActionDefinition);
}
