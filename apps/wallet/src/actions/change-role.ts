/**
 * **A SIGNER'S ROLE CHANGED FROM THE WALLET: THE SEAT REMOVED, THEN THE PERSON INVITED BY ADDRESS AT THE NEW ROLE.** No
 * change to the company's directory gives a seat another role, so the change is the two ordinary acts, each approved
 * as it always is. The first step decides from the chain and the company's directory which comes next
 * (`roleChangeStageOf`); the steps of both acts follow it as this act's own, and only the ones of the act decided on
 * run, so the runner stops, times and counts every one of them. While the chain holds the seat it raises the seat's
 * removal, saying what the removal does on the chain to what is already raised and to every vault's secret; once the
 * removal is carried out, pressed again in the same wallet, it invites the address at the new role. It refuses a
 * reader role, the role the seat already holds, an address the company's list of signers ties to another wallet than
 * the seat's, and a removal that needs fewer approvals than the ones in force. What the first press confirmed (the
 * seat, the address's coin key, the role, the invitation link's token) is kept in the saved keys, the second press
 * invites only that, and only from the wallet that kept it, and once that invitation is filed what was kept is taken
 * out. The person takes the new seat from their own wallet, which sets the removed seat's keys aside.
 */
import type { ActIntent } from 'midnight-identity/profile/request';
import type { Hex } from '../../../../src/core/crypto.js';
import { NETWORK } from 'midnight-identity/network';
import { checkShieldedAddress } from 'midnight-identity/wallet/address-shape';
import type { NetworkName } from '../../../../src/midnight/network.js';
import { HEX64 } from '../../../../src/midnight/directory-change-shape.js';
import { isSignerRole } from '../../../../src/core/roles.js';
import { refusalSaid, removalThresholdRefusal } from '../../../../src/core/vault-approvers.js';
import { withRoleChangeDone, withRoleChangeKept } from '../../../../packages/web-shared/src/keyring-blob.js';
import {
  addressTieOf, keptRoleChangeRefusal, roleAskedRefusal, roleChangeStageOf,
} from '../../../../packages/web-shared/src/role-change-on-device.js';
import { companyReachFor, keptReach, type CompanyReach } from './company-reach.js';
import { StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { inviteAction, type InviteReach } from './invite.js';
import { removeSignerAction, type RemoveSignerReach } from './remove-signer.js';
import { rosterForARemovalHere } from './roster-for-a-removal.js';

/** What changing a role reaches: what the removal and the invitation each reach. */
export type ChangeRoleReach = RemoveSignerReach & InviteReach;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.change-role.why.${key}`, ...(values === undefined ? {} : { values }),
});

/** What the page asked: the company, the seat, the new role, the address of the wallet that holds the seat, the person's name, and the invitation's token. */
interface Asked {
  readonly record: string;
  readonly company: string;
  readonly account: string;
  readonly token: string;
  readonly leaf: string;
  readonly role: string;
  readonly address: string;
  readonly name: string;
}

/** The page's ask, with every field the removal and the invitation are given, or why it is not a change of role. */
const askedOf = (intent: ActIntent): Asked | Words => {
  const f = intent.fields;
  const { record, company, account, token } = f;
  if (record === undefined || company === undefined || account === undefined) return why('not-a-company');
  const leaf = (f['leaf'] ?? '').toLowerCase();
  const address = (f['address'] ?? '').trim();
  const name = (f['personName'] ?? '').trim();
  if (!HEX64.test(leaf) || address === '' || name === '' || token === undefined || !HEX64.test(token)) return why('not-a-change-of-role');
  return { record, company, account, token, leaf, role: f['role'] ?? '', address, name };
};

/** The coin key of the address given, or why it is not an address on this network. */
const coinOf = (address: string, network: NetworkName): string | Words => {
  try {
    return String(checkShieldedAddress(address, network).coinPublicKey).toLowerCase();
  } catch {
    return why('not-an-address');
  }
};

/** The removal's own intent, keeping the approvals in force: a change of role asks for no other number of approvals. */
const removalIntent = (intent: ActIntent, a: Asked): ActIntent => ({
  ...intent, name: 'remove-signer',
  fields: { record: a.record, company: a.company, account: a.account, leaf: a.leaf, threshold: '0' },
});

/** The invitation's own intent: a signer invited by address at the new role on every vault, under the page's token. */
const invitationIntent = (intent: ActIntent, a: Asked): ActIntent => ({
  ...intent, name: 'invite',
  fields: {
    record: a.record, company: a.company, account: a.account, token: a.token,
    kind: 'signer', role: a.role, address: a.address, personName: a.name,
  },
});

/** The act a role change runs next: the seat's removal, or the person's invitation at the new role. */
type Stage = 'remove' | 'invite';

/** What the removal does beyond the seat, shown before the change and confirmed before the removal is raised. */
const REMOVAL_DOES: readonly Words[] = [
  { key: 'act.remove-signer.shown.retirement' }, { key: 'act.remove-signer.shown.other-changes' },
  { key: 'act.remove-signer.shown.open-runs' }, { key: 'act.remove-signer.shown.checks' }, { key: 'act.remove-signer.shown.vault-secrets' },
];

/**
 * Reads the seat's role and the chain, refuses what this change cannot be, and has the person confirm it. Returns the
 * act that comes next, once that act's own check lets it through.
 */
async function nextActHere(ctx: StepContext, r: CompanyReach, intent: ActIntent, a: Asked, reach: ChangeRoleReach): Promise<Stage> {
  const [here, held] = await Promise.all([r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster)(), r.holders()]);
  const stage = roleChangeStageOf(here.dir.seats, held.seats, a.leaf);
  ctx.tell({ stage });
  if (stage === 'removal-under-way') throw new StepRefused(why('removal-under-way', { leaf: a.leaf }));
  const seat = here.dir.seats.find((x) => x.seat.toLowerCase() === a.leaf);
  const refused = roleAskedRefusal(a.role, stage === 'remove' ? seat?.role : undefined);
  if (refused !== null) throw new StepRefused(why('refused', { says: `${refusalSaid(refused)}.` }));
  const role = a.role;
  /* roleAskedRefusal refuses every role that is not a signer's, so this only narrows the type. */
  if (!isSignerRole(role)) throw new StepRefused(why('not-a-change-of-role'));
  const coin = coinOf(a.address, reach.network ?? (NETWORK as NetworkName));
  if (typeof coin !== 'string') throw new StepRefused(coin);
  if (ctx.keyring === null) throw new StepRefused(why('no-saved-keys'));
  if (stage === 'invite') {
    const kept = keptRoleChangeRefusal(ctx.keyring.open().read(), r.accountId, a.leaf, coin, role, a.token);
    if (kept !== null) throw new StepRefused(why(kept, { leaf: a.leaf }));
    await ctx.confirm([{ key: 'act.change-role.confirm.invite', values: { leaf: a.leaf, role, name: a.name, address: a.address } }]);
    const no = await inviteAction(reach).check(invitationIntent(intent, a), ctx.held);
    if (no !== null) throw new StepRefused(no);
    return stage;
  }
  const fewer = removalThresholdRefusal({ seats: held.seats, approvals: held.approvals, policyBar: held.policyBar }, a.leaf as Hex, 0);
  if (fewer !== null) throw new StepRefused(why('fewer-approvals-first'));
  const roster = await rosterForARemovalHere(r, a.leaf);
  const tie = addressTieOf(roster.signers.find((x) => String(x.leafCommitment ?? '').toLowerCase() === a.leaf)?.coinPublicKey, coin);
  if (tie !== 'tied' && tie !== 'untied') throw new StepRefused(why('refused', { says: `${refusalSaid(tie)}.` }));
  await ctx.confirm([
    { key: 'act.change-role.confirm.remove', values: { leaf: a.leaf, role, name: a.name, address: a.address } },
    ...(tie === 'untied' ? [{ key: 'act.change-role.confirm.address-untied', values: { address: a.address } }] : []),
    ...REMOVAL_DOES,
  ]);
  const no = await removeSignerAction(reach).check(removalIntent(intent, a), ctx.held);
  if (no !== null) throw new StepRefused(no);
  await ctx.keyring.keep((k) => withRoleChangeKept(k, r.accountId, a.leaf, coin, role, a.token));
  return stage;
}

/**
 * A step of the act `stage` names, as this act's own: it runs only when the change was decided to be at that stage,
 * and is listed as not needed otherwise.
 */
const atStage = (stage: Stage, decided: () => Stage | null, step: ActionStep): ActionStep => ({
  title: step.title,
  notNeeded: (told) => told['stage'] !== stage || (step.notNeeded?.(told) ?? false),
  run: async (ctx) => { if (decided() === stage) await step.run(ctx); },
});

/**
 * **CHANGE A SIGNER'S ROLE**: the seat's removal while the chain holds it, then, pressed again in the same wallet once
 * the removal is carried out, the person's invitation by address at the new role. Registered with no page asking for it.
 */
export function changeRoleAction(reach: ChangeRoleReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.change-role.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [
      { key: 'act.change-role.shown.seat', values: { leaf: intent.fields['leaf'] ?? '' }, from: 'page' },
      { key: 'act.change-role.shown.role', values: { role: intent.fields['role'] ?? '' }, from: 'page' },
      { key: 'act.change-role.shown.address', values: { address: intent.fields['address'] ?? '', name: intent.fields['personName'] ?? '' }, from: 'page' },
      { key: 'act.change-role.shown.two-acts', from: 'action' },
      ...REMOVAL_DOES.map((w): ShownLine => ({ ...w, from: 'action' })),
      { key: 'act.change-role.shown.nothing-else', from: 'action' },
    ],
    checks: [{ key: 'act.change-role.check.stage' }, { key: 'act.change-role.check.role' }, { key: 'act.change-role.check.address' }],
    check: async (intent: ActIntent) => {
      const a = askedOf(intent);
      return 'key' in a ? a : null;
    },
    steps: (intent: ActIntent): readonly ActionStep[] => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const a = askedOf(intent);
      let stage: Stage | null = null;
      let accountId = '';
      const decide: ActionStep = {
        title: { key: 'act.change-role.step.decide' },
        run: async (ctx) => {
          if ('key' in a) throw new StepRefused(a);
          const r = await read.at(ctx);
          stage = await nextActHere(ctx, r, intent, a, reach);
          accountId = r.accountId;
        },
      };
      if ('key' in a) return [decide];
      const decided = (): Stage | null => stage;
      const done: ActionStep = {
        title: { key: 'act.change-role.step.done' },
        notNeeded: (told) => told['stage'] !== 'invite',
        run: async (ctx) => {
          if (stage === 'invite' && ctx.keyring !== null) await ctx.keyring.keep((k) => withRoleChangeDone(k, accountId, a.leaf));
        },
      };
      return [
        decide,
        ...removeSignerAction(reach).steps(removalIntent(intent, a)).map((s) => atStage('remove', decided, s)),
        ...inviteAction(reach).steps(invitationIntent(intent, a)).map((s) => atStage('invite', decided, s)),
        done,
      ];
    },
  } satisfies ActionDefinition);
}
