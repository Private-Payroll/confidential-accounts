/**
 * **GIVE OR TAKE AWAY A READ GRANT, SIGNED IN THIS SEAT'S WALLET.** To give, the page hands over the reader's join
 * code and a reader role (limited or accountant): the code is the reader's own wallet's signature over the key it
 * derives for this company and the person id the service knows the reader by, and the reader's fingerprint is shown
 * here to compare with the one the reader reads out; a code naming a reader already in force replaces them, which this
 * window says, and the person confirms, before anything is signed. To take away, the page names the recipient's key.
 * This wallet signs the change with its seat's filing key and files it as the next version
 * of the company's grants (`grantsChangeFiledHere`): it comes into force once signers at the seat bar have each signed
 * it in their own wallets. Once in force it hands the service the plain list of readers with the signatures, and when
 * it takes anything away it repairs the company's key at once (`rotateTheCompanyKeyHere`) and wraps the grants that
 * stay to the new key (`grantsWrappedAgainHere`); a step that cannot is carried out by the next act of any signer who
 * stays, whose upkeep does both.
 */
import type { ActIntent } from 'midnight-identity/profile/request';
import type { Hex } from '../../../../src/core/crypto.js';
import { readJoinCode, type JoinCode, type ReaderParts } from 'midnight-identity/profile/join-code';
import { readCompanyLabel } from 'midnight-identity/profile/company-label';
import { readerCodeFingerprint } from 'midnight-identity/profile/fingerprint';
import { isReaderRole } from '../../../../src/core/roles.js';
import { grantEntryOf, type GrantEntry } from '../../../../src/midnight/grants-record.js';
import { canonical } from '../../../../src/core/crypto.js';
import { companyRecordEntry } from '../../../../src/midnight/record-manifest.js';
import { VaultPoolVersionAlreadyFiled } from '../../../../src/midnight/vault-pool.js';
import { rotateTheCompanyKeyHere } from '../../../../packages/web-shared/src/company-key-here.js';
import { HttpCompanyRecordStore } from '../../../../packages/web-shared/src/http-sealed-pool-store.js';
import { grantsHere, grantsServedBy } from '../../../../packages/web-shared/src/purpose-wraps.js';
import {
  grantsChangeFiledHere, grantsWrappedAgainHere, GrantsNotFiled, type GrantsAsked, type GrantsChangeFiled, type GrantsFilingDoors,
} from '../../../../packages/web-shared/src/grants-filed-here.js';
import type { WireSend } from '../../../../packages/web-shared/src/http-sealed-pool-store.js';
import { deviceSignerFrom, readersIn } from '../../../../packages/web-shared/src/vault-page-doors.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { companyReachFor, enteredFor, keptReach, type CompanyChain, type CompanyReach } from './company-reach.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { ActionStopped } from './run.js';
import { rotationDoorsIn, UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/** What the act reaches: the chain and the worker every seat act reads with. */
export interface GrantReadReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  /** A test's reach in place of the wallet's own (`companyReachFor`). */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
  /** The entries of the grants in force as the seat reads them; replaceable so a test can name them. */
  readonly inForceFor?: (r: CompanyReach) => Promise<readonly GrantEntry[]>;
}

/** Where the change stands once filed: in force, or waiting for the other signers' wallets. */
export const GRANT_READ_STATE = { inForce: 'in-force', waiting: 'waiting-for-signers' } as const;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({ key: `act.grant-read.why.${key}`, ...(values === undefined ? {} : { values }) });
const said = (e: unknown): string => String((e as Error)?.message ?? e);
const HEX64 = /^[0-9a-f]{64}$/u;
const CODE_REFUSED = { 'not-a-code': 'not-a-code', 'not-signed': 'code-not-signed', 'another-company': 'code-another-company' } as const;

const isReaderCode = (code: JoinCode): code is JoinCode & { readonly parts: ReaderParts } => code.parts.kind === 'reader';

/**
 * The reader's code the page hands over, read for the company the ask names: signed over exactly what it carries by
 * the wallet it names, made for this company, and a reader's. Anything else is refused with why, so no key reaches a
 * grant unless a reader's own wallet signed it for this company.
 */
export const readerCodeOf = (intent: ActIntent): (JoinCode & { readonly parts: ReaderParts }) | Words => {
  const label = readCompanyLabel(intent.fields['company']);
  if (label === null) return why('not-a-company');
  const code = readJoinCode(String(intent.fields['code'] ?? ''), label);
  if (typeof code === 'string') return why(CODE_REFUSED[code]);
  return isReaderCode(code) ? code : why('not-a-reader-code');
};

/** The change the page asks: a grant to give from a reader's code, or a recipient to take one away from; or why the ask is not one. */
export const grantAskedOf = (intent: ActIntent): GrantsAsked | Words => {
  const f = intent.fields;
  if (f['away'] !== undefined) {
    if (f['code'] !== undefined) return why('not-a-choice');
    const recipient = String(f['recipient'] ?? '').toLowerCase();
    if (!HEX64.test(recipient)) return why('not-a-key');
    return f['away'] === 'yes' ? { takeAway: recipient } : why('not-a-choice');
  }
  if (f['recipient'] !== undefined) return why('key-from-the-code');
  const role = f['role'];
  if (!isReaderRole(role)) return why('not-a-reader-role');
  const code = readerCodeOf(intent);
  if ('key' in code) return code;
  return { give: grantEntryOf({ recipient: code.parts.readerKey, person: code.person, role }) };
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
      await enteredFor(r, api).enter([companyRecordEntry(rec)]);
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

/**
 * The readers in force a give takes away: an entry under the same key or naming the same person that is not this very
 * grant. The change drops each of them (`grantsChangeFiledHere`), so a give that names a reader already in force
 * replaces them, and once it is in force the company's key is changed.
 */
export const readersReplacedBy = (inForce: readonly GrantEntry[], give: GrantEntry): readonly GrantEntry[] =>
  inForce.filter((e) => (e.recipient === give.recipient || e.person === give.person) && canonical(e) !== canonical(give));

/**
 * Before anything is signed: when the give replaces a reader in force, the person is shown whom it replaces and that
 * the company's key will change, and the act goes on only once they confirm it in this window.
 */
export async function confirmWhatAGiveReplaces(ctx: Pick<StepContext, 'confirm'>, inForce: readonly GrantEntry[], give: GrantEntry): Promise<void> {
  const replaced = readersReplacedBy(inForce, give);
  if (replaced.length === 0) return;
  await ctx.confirm([
    ...replaced.map((e) => ({ key: 'act.grant-read.confirm.replaces', values: { person: e.person, recipient: e.recipient, role: e.role } })),
    { key: 'act.grant-read.confirm.key-changes' },
  ]);
}

/** The entries of the grants in force as this seat believes them; refused with the read's own words when they cannot be read. */
async function inForceHere(r: CompanyReach): Promise<readonly GrantEntry[]> {
  try {
    return (await grantsHere(grantsFilingDoorsIn(r, r.api, r.send))).inForce?.grants.entries ?? [];
  } catch (e) {
    if (e instanceof ActionStopped) throw e;
    throw new StepRefused(why('not-filed', { says: said(e) }), codeOfError(e));
  }
}

const shownAsk = (intent: ActIntent): ShownLine => {
  const asked = grantAskedOf(intent);
  if ('key' in asked) return { key: 'act.grant-read.shown.not-a-grant', from: 'page' };
  if (!('give' in asked)) return { key: 'act.grant-read.shown.take-away', values: { recipient: asked.takeAway }, from: 'page' };
  const code = readerCodeOf(intent);
  const fingerprint = 'key' in code ? '' : readerCodeFingerprint(code);
  return {
    key: `act.grant-read.shown.give.${asked.give.role}`, values: { person: asked.give.person, recipient: asked.give.recipient, fingerprint }, from: 'page',
  };
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
      const seat: ActionStep = {
        title: { key: 'act.grant-read.step.seat' },
        run: async (ctx) => {
          const r = await read.at(ctx);
          const asked = grantAskedOf(intent);
          if ('give' in asked) await confirmWhatAGiveReplaces(ctx, await (reach.inForceFor ?? inForceHere)(r), asked.give);
        },
      };
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
