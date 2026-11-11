/**
 * **GIVE OR TAKE AWAY A READ GRANT, SIGNED IN THIS SEAT'S WALLET.** The page names the recipient's wrapping key, the
 * person id or server label the service knows it by, and its reader role (limited or accountant), or names a recipient
 * to take a grant away from. This wallet signs the change with its seat's filing key and files it as the next version
 * of the company's grants (`grantsChangeFiledHere`): it comes into force once signers at the seat bar have each signed
 * it in their own wallets. Once in force it hands the service the plain list of readers with the signatures, and when
 * it takes anything away it repairs the company's key at once (`rotateTheCompanyKeyHere`) and wraps the grants that
 * stay to the new key (`grantsWrappedAgainHere`); a step that cannot is carried out by the next act of any signer who
 * stays, whose upkeep does both.
 */
import type { ActIntent } from 'midnight-identity/profile/request';
import type { Hex } from '../../../../src/core/crypto.js';
import { isReaderRole } from '../../../../src/core/roles.js';
import { grantEntryOf } from '../../../../src/midnight/grants-record.js';
import { companyRecordEntry } from '../../../../src/midnight/record-manifest.js';
import { VaultPoolVersionAlreadyFiled } from '../../../../src/midnight/vault-pool.js';
import { rotateTheCompanyKeyHere } from '../../../../packages/web-shared/src/company-key-here.js';
import { HttpCompanyRecordStore } from '../../../../packages/web-shared/src/http-sealed-pool-store.js';
import { grantsServedBy } from '../../../../packages/web-shared/src/purpose-wraps.js';
import {
  grantsChangeFiledHere, grantsWrappedAgainHere, GrantsNotFiled, type GrantsAsked, type GrantsChangeFiled, type GrantsFilingDoors,
} from '../../../../packages/web-shared/src/grants-filed-here.js';
import { recordsEnteredFor, manifestServiceFor } from '../../../../packages/web-shared/src/record-entered-here.js';
import type { WireSend } from '../../../../packages/web-shared/src/http-sealed-pool-store.js';
import { deviceSignerFrom, readersIn } from '../../../../packages/web-shared/src/vault-page-doors.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { companyReachFor, keptReach, type CompanyChain, type CompanyReach } from './company-reach.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { ActionStopped } from './run.js';
import { rotationDoorsIn, UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/** What the act reaches: the chain and the worker every seat act reads with. */
export interface GrantReadReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  /** A test's reach in place of the wallet's own (`companyReachFor`). */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
}

/** Where the change stands once filed: in force, or waiting for the other signers' wallets. */
export const GRANT_READ_STATE = { inForce: 'in-force', waiting: 'waiting-for-signers' } as const;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({ key: `act.grant-read.why.${key}`, ...(values === undefined ? {} : { values }) });
const said = (e: unknown): string => String((e as Error)?.message ?? e);
const HEX64 = /^[0-9a-f]{64}$/u;
const NAME = /^[A-Za-z0-9._:@-]{1,128}$/u;

/** The change the page asks: a grant to give, or a recipient to take one away from; or why the ask is not one. */
export const grantAskedOf = (intent: ActIntent): GrantsAsked | Words => {
  const f = intent.fields;
  const recipient = String(f['recipient'] ?? '').toLowerCase();
  if (!HEX64.test(recipient)) return why('not-a-key');
  if (f['away'] !== undefined) return f['away'] === 'yes' ? { takeAway: recipient } : why('not-a-choice');
  const role = f['role'];
  if (!isReaderRole(role)) return why('not-a-reader-role');
  const person = f['person'] ?? '';
  if (!NAME.test(person)) return why('not-a-person');
  return { give: grantEntryOf({ recipient, person, role }) };
};

/** What filing and reading the grants needs, from this wallet's own reach: the grants served, the directory, this seat's keys and its filing. */
export const grantsFilingDoorsIn = (r: CompanyReach, api: CompanyReach['api'], send: WireSend): GrantsFilingDoors => {
  const directory = r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const me = deviceSignerFrom(r.leaf, r.companyKey);
  const secret = r.seat.signingSecret as Hex;
  return {
    accountId: r.accountId, versions: grantsServedBy(api, r.accountId), directory,
    me: { signerId: me.signerId, wrappingSecret: me.wrappingSecret as Hex }, signingSecret: secret, keys: r.companyKeys,
    seats: () => readersIn(directory).signers(),
    file: async (rec) => {
      await new HttpCompanyRecordStore(r.accountId, send, secret, r.judges.filingJudgeFor(r.accountId, r.label, r.account, r.companyKeys, r.roster)).put(rec);
      await recordsEnteredFor(manifestServiceFor(api), r.accountId, secret).enter([companyRecordEntry(rec)]);
    },
  };
};

/** The change filed, in this act's words when it is not. */
async function filedHere(r: CompanyReach, asked: GrantsAsked): Promise<GrantsChangeFiled> {
  try {
    return await grantsChangeFiledHere(grantsFilingDoorsIn(r, r.api, r.send), asked);
  } catch (e) {
    if (e instanceof ActionStopped) throw e;
    if (e instanceof VaultPoolVersionAlreadyFiled) throw new StepRefused(why('filed-meanwhile'), codeOfError(e));
    if (e instanceof GrantsNotFiled) throw new StepRefused(why('not-filed', { says: said(e) }), codeOfError(e));
    throw new StepRefused(why('not-filed', { says: said(e) }), codeOfError(e));
  }
}

/** Once a taking-away is in force: the company's key repaired and the grants that stay wrapped to it; true when both were done here. */
async function keyChangedAfter(ctx: StepContext, read: ReturnType<typeof keptReach>): Promise<boolean> {
  try {
    const r = await read.at(ctx);
    const rotated = await rotateTheCompanyKeyHere(await rotationDoorsIn(r, r.api));
    if (rotated.state !== 'rotated' && rotated.state !== 'rotated-elsewhere') return false;
    read.renew();
    const now = await read.at(ctx);
    return (await grantsWrappedAgainHere(grantsFilingDoorsIn(now, now.api, now.send))).state !== 'not-wrapped';
  } catch (e) {
    if (e instanceof ActionStopped) throw e;
    /* Not done here is said to the page; the next act of a signer who stays repairs the key and wraps the grants in its upkeep. */
    return false;
  }
}

/** The readers in force handed to the service, which keeps them only as the signatures reach the bar; true when it kept them. */
async function readersHandedIn(r: CompanyReach, filed: GrantsChangeFiled): Promise<boolean> {
  try {
    await r.api(`/api/accounts/${encodeURIComponent(r.accountId)}/readers`, { method: 'POST', body: JSON.stringify(filed.readers) });
    return true;
  } catch (e) {
    if (e instanceof ActionStopped) throw e;
    /* A list not kept is said to the page; any signer files the same change again from their wallet to hand it in. */
    return false;
  }
}

const shownAsk = (intent: ActIntent): ShownLine => {
  const asked = grantAskedOf(intent);
  if ('key' in asked) return { key: 'act.grant-read.shown.not-a-grant', from: 'page' };
  return 'give' in asked
    ? { key: `act.grant-read.shown.give.${asked.give.role}`, values: { person: asked.give.person, recipient: asked.give.recipient }, from: 'page' }
    : { key: 'act.grant-read.shown.take-away', values: { recipient: asked.takeAway }, from: 'page' };
};

/** **THE WALLET ACT THAT SIGNS A CHANGE OF THE COMPANY'S READ GRANTS.** */
export function grantReadAction(reach: GrantReadReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.grant-read.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [
      shownAsk(intent),
      { key: 'act.grant-read.shown.bar', from: 'action' },
      { key: 'act.grant-read.shown.reads', from: 'action' },
      ...upkeepShown(),
      { key: 'act.grant-read.shown.service-told', from: 'action' },
      { key: 'act.grant-read.shown.nothing-else', from: 'action' },
    ],
    checks: [{ key: 'act.grant-read.check.ask' }, { key: 'act.grant-read.check.seat' }, UPKEEP_CHECK],
    check: async (intent) => {
      if ((intent.fields['record'] ?? '') === '') return why('not-a-company');
      const asked = grantAskedOf(intent);
      return 'key' in asked ? asked : null;
    },
    steps: (intent) => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const seat: ActionStep = { title: { key: 'act.grant-read.step.seat' }, run: async (ctx) => { await read.at(ctx); } };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      const file: ActionStep = {
        title: { key: 'act.grant-read.step.file' },
        run: async (ctx) => {
          const asked = grantAskedOf(intent);
          if ('key' in asked) throw new StepRefused(asked);
          const r = await read.at(ctx);
          const filed = await filedHere(r, asked);
          if (filed.state === 'waiting-for-signers') {
            ctx.tell({ state: GRANT_READ_STATE.waiting, filed: filed.by, needed: filed.needed });
            return;
          }
          if (!(await readersHandedIn(r, filed))) ctx.show({ key: 'act.grant-read.left.readers-not-kept' });
          if (filed.takesAway && !(await keyChangedAfter(ctx, read))) ctx.show({ key: 'act.grant-read.left.key-not-changed' });
          ctx.tell({ state: GRANT_READ_STATE.inForce, filed: filed.by, needed: filed.needed });
        },
      };
      return [seat, upkeep.first, file, upkeep.last];
    },
  } satisfies ActionDefinition);
}
