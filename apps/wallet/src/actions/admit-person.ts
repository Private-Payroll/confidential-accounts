import type { ActIntent } from 'midnight-identity/profile/request';
import { NETWORK } from 'midnight-identity/network';
import { typedAddressIsShielded } from 'midnight-identity/profile/address-claim';
import { tidyFingerprint } from 'midnight-identity/profile/fingerprint';
import { assets as theAssets, type AssetRegistry } from '../../../../src/core/assets.js';
import type { NetworkName } from '../../../../src/midnight/network.js';
import { InvitationRefused, type InvitationSend } from '../../../../packages/web-shared/src/invitation-on-device.js';
import { admitHere, PersonNotChanged, readPeopleHere, type PeopleDevice, type PersonHere } from '../../../../packages/web-shared/src/people-on-device.js';
import { admitVendorHere, readVendorsHere, VendorNotChanged, type VendorHere } from '../../../../packages/web-shared/src/vendors-on-device.js';
import { signedClaimRefusal } from '../../../../packages/web-shared/src/signed-claim-refusal.js';
import { FiledNotEntered, type Filed, type RecordsEntered } from '../../../../packages/web-shared/src/record-entered-here.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { withCompanyKeys } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { companyReachFor, enteredFor, keptReach, type CompanyChain, type CompanyReach } from './company-reach.js';
import { StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { ActionStopped } from './run.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/*
 * ADMITTING AN EMPLOYEE OR A VENDOR, IN THE WALLET. The person's own wallet handed over its signed code, sealed to the
 * company; this wallet opens it with the company's keys, holds it to the fingerprint the person read out from their
 * own wallet, or, for someone added at a public address, to their wallet's signed claim of that address, and files
 * their record active with its own seat. The person is found as this device believes them, never as the service
 * lists them, and the name the page showed is held to their record. Nothing is admitted on the service's word.
 */

/** What the admit action reads the company with: the wallet's own chain and builder. */
export interface AdmitPersonReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  readonly network?: NetworkName;
  readonly assets?: AssetRegistry;
  /** Stands in for the wallet's own read of the company, in tests. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
}

/** Where the admission got to, as the action tells the page. */
export const ADMIT_PERSON_STATE = { admitted: 'admitted', alreadyAdmitted: 'already-admitted' } as const;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.admit-person.why.${key}`, ...(values === undefined ? {} : { values }),
});
const said = (e: unknown): string => String((e as Error)?.message ?? e);
const KINDS = ['employee', 'vendor'] as const;

/**
 * The shared people and vendor code's view of the company, built from the wallet's own read of it: the company's keys
 * the seat opened, this seat's signing secret to sign each filing, its records to enter them in, the person signed
 * in on the page, whom a filing names as the one who admitted, and the check of a wallet's signed claim of an address,
 * run here with the ledger the wallet loads (`signedClaimRefusal`). Refuses when the page said nobody is signed in.
 */
export async function peopleDeviceFor(
  ctx: StepContext, r: CompanyReach, network: NetworkName, registry: AssetRegistry, refuse: (key: string) => never,
  entered: RecordsEntered = enteredFor(r),
): Promise<PeopleDevice> {
  const signedInAs = ctx.person ?? refuse('no-person');
  const send: InvitationSend = (path, init) => ctx.call(init.method, path, init.body);
  return {
    company: withCompanyKeys({ id: r.accountId, name: (await r.roster()).name, label: r.label, account: r.account, keyEpoch: r.companyKeys.epoch }, r.companyKeys),
    signingSecret: r.seat.signingSecret,
    signedInAs,
    send,
    directory: r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster),
    network,
    claimRefusal: signedClaimRefusal,
    registry,
    entered,
  };
}

/** How many times one filing's entry is sent before the act waits for its anchor to send it again. */
const ENTRY_TRIES = 3;

/**
 * The company's records as an act enters its filings in them, sending an entry the service did not take again before
 * giving up on it. A filing is already filed when its entry is sent, so an entry still not taken is held here, never
 * thrown, and `settled` sends it once more at the act's end, after the anchor has sent this seat's kept entries again:
 * it says why the entry is still not taken, or null once every entry is.
 */
export function enteredUntilTaken(base: RecordsEntered) {
  const waiting: (readonly Filed[])[] = [];
  const sent = async (filed: readonly Filed[]): Promise<string | null> => {
    let why = '';
    for (let i = 0; i < ENTRY_TRIES; i += 1) {
      try {
        await base.enter(filed);
        return null;
      } catch (e) {
        if (!(e instanceof FiledNotEntered)) throw e;
        why = e.why;
      }
    }
    return why;
  };
  return {
    entered: { enter: async (filed: readonly Filed[]) => { if ((await sent(filed)) !== null) waiting.push(filed); } } as RecordsEntered,
    waiting: (): boolean => waiting.length > 0,
    settled: async (): Promise<string | null> => {
      while (waiting.length > 0) {
        const why = await sent(waiting[0]!);
        if (why !== null) return why;
        waiting.shift();
      }
      return null;
    },
  };
}

/** What an act holds back until its filings are entered: the entries still waiting, and the state it then tells. */
export interface HeldUntilEntered { readonly entries: ReturnType<typeof enteredUntilTaken>; readonly state: string }

/**
 * The upkeep's last step, then the act's own filings entered: the anchor runs first, since it sends this seat's kept
 * entries again, and the state is told only once every entry is taken. An entry still not taken is refused with the
 * words `refused` gives, saying whether the anchor was made; a refusal of the upkeep itself is told after the state.
 */
export async function upkeepThenEntered(
  ctx: StepContext, last: ActionStep, held: HeldUntilEntered | null, refused: (anchored: boolean, says: string) => Words,
): Promise<void> {
  let failed: unknown = null;
  try {
    await last.run(ctx);
  } catch (e) {
    if (held === null || e instanceof ActionStopped) throw e;
    failed = e;
  }
  if (held === null) return;
  const why = await held.entries.settled();
  if (why !== null) throw new StepRefused(refused(failed === null, why));
  ctx.tell({ state: held.state });
  if (failed !== null) throw failed;
}

/** The employee or vendor the page named, as this device believes them; refuses one it does not, or cannot find. */
export async function personNamedHere(
  d: PeopleDevice, kind: 'employee' | 'vendor', id: string, refuse: (key: string) => never,
): Promise<{ readonly kind: 'employee'; readonly here: PersonHere } | { readonly kind: 'vendor'; readonly here: VendorHere }> {
  if (kind === 'employee') {
    const read = await readPeopleHere(d);
    if (read.notBelieved.includes(id)) return refuse('not-believed');
    const here = [...read.people, ...read.notPayable.map((n) => n.here)].find((p) => p.person.id === id);
    return here === undefined ? refuse('not-found') : { kind, here };
  }
  const read = await readVendorsHere(d);
  if (read.notBelieved.includes(id)) return refuse('not-believed');
  const here = [...read.vendors, ...read.notPayable.map((n) => n.here)].find((v) => v.vendor.id === id);
  return here === undefined ? refuse('not-found') : { kind, here };
}

/** The action that admits, with this wallet's seat, an employee or vendor whose wallet handed over its code. */
export function admitPersonAction(reach: AdmitPersonReach): ActionDefinition {
  const network = reach.network ?? (NETWORK as NetworkName);
  const registry = reach.assets ?? theAssets;
  const refuse = (key: string): never => { throw new StepRefused(why(key)); };
  return Object.freeze({
    headline: 'act.admit-person.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => {
      const f = intent.fields;
      return [
        { key: 'act.admit-person.shown.kind', values: { kind: f['kind'] ?? '' }, from: 'page' },
        { key: 'act.admit-person.shown.name', values: { name: f['personName'] ?? '' }, from: 'page' },
        f['fingerprint'] === undefined
          ? { key: 'act.admit-person.shown.by-claim', from: 'action' }
          : { key: 'act.admit-person.shown.fingerprint', values: { fingerprint: f['fingerprint'] }, from: 'page' },
        { key: 'act.admit-person.shown.checks', from: 'action' },
        { key: 'act.admit-person.shown.admit', from: 'action' },
        ...upkeepShown(),
        { key: 'act.admit-person.shown.nothing-else', from: 'action' },
      ];
    },
    checks: [
      { key: 'act.admit-person.check.seat' },
      { key: 'act.admit-person.check.record' },
      { key: 'act.admit-person.check.handed-over' },
      UPKEEP_CHECK,
    ],
    check: async (intent) => {
      const f = intent.fields;
      if (!KINDS.includes(f['kind'] as never) || (f['person'] ?? '') === '' || (f['personName'] ?? '') === '') return why('not-a-person');
      if (f['fingerprint'] !== undefined && tidyFingerprint(f['fingerprint']) === null) return why('not-a-fingerprint');
      return null;
    },
    steps: (intent) => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const seat: ActionStep = {
        title: { key: 'act.admit-person.step.seat' },
        run: async (ctx) => { await read.at(ctx); },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      let held: HeldUntilEntered | null = null;
      const admit: ActionStep = {
        title: { key: 'act.admit-person.step.admit' },
        run: async (ctx) => {
          const f = intent.fields;
          const kind = f['kind'] as 'employee' | 'vendor';
          if (!KINDS.includes(kind)) refuse('not-a-person');
          const fingerprint = f['fingerprint'];
          const r = await read.at(ctx);
          const entries = enteredUntilTaken(enteredFor(r));
          const d = await peopleDeviceFor(ctx, r, network, registry, refuse, entries.entered);
          try {
            const found = await personNamedHere(d, kind, f['person']!, refuse);
            const rec = found.kind === 'employee' ? found.here.person : found.here.vendor;
            if (rec.name !== f['personName']) refuse('not-as-shown');
            const done = found.kind === 'employee' ? found.here.person.status === 'active' : (found.here.vendor.payeeCode ?? null) !== null;
            if (done) {
              ctx.tell({ state: ADMIT_PERSON_STATE.alreadyAdmitted });
              return;
            }
            const typed = rec.invitedAddress ?? null;
            const byClaim = typed !== null && !typedAddressIsShielded(typed);
            if (byClaim && fingerprint !== undefined) refuse('fingerprint-not-checked');
            if (!byClaim && fingerprint === undefined) refuse('no-fingerprint');
            if (found.kind === 'employee') await admitHere(d, found.here, fingerprint ?? '');
            else await admitVendorHere(d, found.here, fingerprint ?? '');
          } catch (e) {
            if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
            if (e instanceof FiledNotEntered) throw new StepRefused(why('filed-not-entered', { says: said(e) }));
            if (e instanceof PersonNotChanged || e instanceof VendorNotChanged) throw new StepRefused(why('not-admitted', { says: said(e) }));
            if (e instanceof InvitationRefused) throw new StepRefused(why('not-filed', { says: said(e) }));
            throw new StepRefused(why('not-admitted', { says: said(e) }));
          }
          read.renew();
          if (entries.waiting()) {
            held = { entries, state: ADMIT_PERSON_STATE.admitted };
            return;
          }
          ctx.tell({ state: ADMIT_PERSON_STATE.admitted });
        },
      };
      const last: ActionStep = {
        ...upkeep.last,
        run: (ctx) => upkeepThenEntered(ctx, upkeep.last, held, (anchored, says) => (anchored
          ? why('filed-not-entered', { says }) : why('filed-not-entered-nor-anchored', { says }))),
      };
      return [upkeep.first, seat, admit, last];
    },
  } satisfies ActionDefinition);
}
