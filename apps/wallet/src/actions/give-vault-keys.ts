import {
  INVITATION_REFUSAL, recordsKeyAnswerFor, whyTheInvitationDoesNotNameIt, type LeafOf, type RecordsKeyAnswer,
} from 'midnight-identity/profile/records-key';
import { companyFingerprint } from 'midnight-identity/profile/fingerprint';
import { readAccountAddress, readCompanyLabel } from 'midnight-identity/profile/company-label';
import type { RecordsKeyRequest } from 'midnight-identity/profile/request';
import { ownEntryFiled, vaultKeysOfferedAndFolded } from '../../../../packages/web-shared/src/vault-keys-given.js';
import { withOwedEntry, withoutOwedEntry } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { signingPublicKeyOf } from '../../../../src/core/crypto.js';
import { seatInviterIn } from '../../../../src/core/proposal-filing.js';
import type { Inviter } from '../../../../src/core/invitation.js';
import type { SealedProposal } from '../../../../src/core/types.js';
import { liveLeafReader, type LeafReader } from '../chain/seat-leaf.js';
import { companyReachFor, enteredFor, keptReach, type CompanyChain, type CompanyReach } from './company-reach.js';
import { StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps, type UpkeepReach } from './upkeep.js';

/*
 * GIVE YOUR VAULT KEYS, IN THE WALLET. The wallet signs this seat's records key
 * and its directory entry itself, for the seat its own keys hold and the chain
 * seats; keeps the entry in the person's saved keys before it is filed, so an
 * entry the page did not file is filed on a later press; files it, offers the
 * company the seat's vault keys and folds them into the roster - each filing
 * signed here with the seat's own key and sent through the page, and each read
 * the service answers judged against the chain and the directory first. The
 * action starts with what the company is owed of this seat and ends by filing
 * each vault's records again and anchoring (`upkeepSteps`).
 */

/** Where the action reads the chain and builds what it proves; the wallet's own, or a test's. */
export interface VaultKeysReach extends UpkeepReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  readonly now: () => number;
  /** How the inviter's opening is turned into its seat; the account's own `signerLeaf` unless a test answers. */
  readonly leafOf?: LeafReader;
}

/** What giving the keys leaves the steps after it: the company as read, and the records key the wallet signed. */
export interface KeysGiven {
  readonly reach: CompanyReach;
  readonly signed: RecordsKeyAnswer;
}

/** The steps that give this seat's vault keys, and a way for the steps after them to read what they gave. */
/*
 * **WHO INVITED THIS SEAT, FOR A WALLET THAT HAS KEPT NO ACCOUNT FOR THE COMPANY YET.** The invitation the saved keys
 * carry, else the one the company's proposals carry for this seat, preferring one whose inviter the network seats. It is
 * a claim: `whyTheInvitationDoesNotNameIt` believes it only against the network's seats and the inviter's own opening.
 */
const inviterOf = async (r: CompanyReach, onTheChain: readonly string[]): Promise<Inviter | undefined> => {
  const seated = (x: Inviter | null | undefined): x is Inviter =>
    x != null && typeof x.statement?.seat === 'string' && onTheChain.some((s) => s.toLowerCase() === x.statement.seat.toLowerCase());
  const kept = (r.seat as { readonly invitedBy?: Inviter }).invitedBy;
  if (seated(kept)) return kept;
  let carried: Inviter | null = null;
  try {
    const listed: unknown = await r.api(`/api/accounts/${encodeURIComponent(r.accountId)}/proposals`);
    carried = seatInviterIn(Array.isArray(listed) ? listed as SealedProposal[] : [], r.accountId, r.companyKeys, r.leaf);
  } catch {
    carried = null;
  }
  if (seated(carried)) return carried;
  return kept ?? carried ?? undefined;
};

/** The inviter in the shape the records-key check reads, or none when its keys are not the wallet's kind. */
const invitedByOf = (inviter: Inviter | undefined): RecordsKeyRequest['invitedBy'] =>
  inviter === undefined || inviter.committeeKey.tag !== 'schnorr' || inviter.opening?.walletKey?.tag !== 'schnorr' ? undefined
    : {
      committeeKey: { tag: 'schnorr', value: inviter.committeeKey.value }, statement: inviter.statement,
      opening: { ...inviter.opening, walletKey: { tag: 'schnorr', value: inviter.opening.walletKey.value } },
    } as RecordsKeyRequest['invitedBy'];

/** The seat the inviter's own opening makes, for that opening alone; one that cannot be worked out proves nothing. */
const openingLeafOf = async (opening: NonNullable<RecordsKeyRequest['invitedBy']>['opening'], read: LeafReader): Promise<LeafOf> => {
  const leaf = await read(opening).then((l) => l.toLowerCase(), () => null);
  return (o) => (o.publicKey === opening.publicKey && o.blinding === opening.blinding && o.scope === opening.scope ? leaf : null);
};


export function vaultKeysSteps(reach: VaultKeysReach, why: (key: string, values?: Readonly<Record<string, string | number>>) => Words, titles: string) {
  const read = keptReach((ctx) => companyReachFor(ctx, reach.chain(), reach.builder(), (k) => why(k)));
  let given: KeysGiven | null = null;
  const refuse = (key: string): never => { throw new StepRefused(why(key)); };

  /** The company as this run read it: read once, in the run's first step that needs it, and reached as the step running. */
  const company = (ctx: StepContext): Promise<CompanyReach> => read.at(ctx);

  const sign = async (ctx: StepContext): Promise<KeysGiven> => {
    const r = await company(ctx);
    if (given !== null) return given;
    const roster = await r.roster();
    const named = roster.signers.find((s) => s.id === r.seat.signerId && s.status === 'active')?.leafCommitment ?? null;
    if (named === null) refuse('no-seat-on-the-roster');
    if (named!.toLowerCase() !== r.leaf) refuse('not-your-seat');
    const holders = await r.holders();
    const seats = { committee: holders.committee, threshold: holders.threshold, seats: holders.seats };
    let request = {
      schema: 'midnight-identity/disclosure-request/v1', kind: 'records-key', requester: ctx.asker, purpose: '', nonce: 'act',
      expiresAt: 0, company: r.label, account: r.account, seat: r.leaf, signingKey: signingPublicKeyOf(r.seat.signingSecret).toLowerCase(),
    } as unknown as RecordsKeyRequest;
    let pinned = ctx.held.wallet?.pinnedFor(r.label)?.account ?? null;
    let leafOf: LeafOf | null = null;
    if (pinned === null) {
      const invitedBy = invitedByOf(await inviterOf(r, holders.seats));
      leafOf = invitedBy === undefined ? null : await openingLeafOf(invitedBy.opening, reach.leafOf ?? liveLeafReader);
      request = { ...request, ...(invitedBy === undefined ? {} : { invitedBy }) } as RecordsKeyRequest;
      const notNamed = whyTheInvitationDoesNotNameIt(request, seats, leafOf);
      if (notNamed !== null) throw new StepRefused(why('records-key-refused', { says: INVITATION_REFUSAL[notNamed] }));
      if (ctx.held.wallet === undefined) refuse('no-record');
      try {
        await ctx.held.wallet!.pin(r.label, r.account, 'invited');
      } catch {
        refuse('account-not-kept');
      }
      pinned = r.account;
    }
    let signed: RecordsKeyAnswer;
    try {
      signed = recordsKeyAnswerFor(ctx.held.identity, request, seats, reach.now(), undefined, pinned as never, leafOf);
    } catch (e) {
      throw new StepRefused(why('records-key-refused', { says: (e as Error).message }));
    }
    given = { reach: r, signed };
    return given;
  };

  const entered: ActionStep = {
    title: { key: `${titles}.step.entry` },
    run: async (ctx) => {
      const { reach: r, signed } = await sign(ctx);
      const person = ctx.person ?? refuse('no-person');
      if (signed.entry === undefined) refuse('records-key-refused');
      const owed = {
        person, company: r.label, signed: { committeeKey: signed.committeeKey, entry: signed.entry! },
        ...(r.seat.opening === undefined ? {} : { opening: r.seat.opening }),
        ...(r.seat.invited === undefined ? {} : { invited: r.seat.invited }),
      };
      await ctx.keyring!.keep((k) => withOwedEntry(k, r.accountId, owed as never));
      const filed = await ownEntryFiled(r.api, r.accountId, {
        read: () => ctx.keyring!.open().read().directoryEntriesOwed?.[r.accountId] ?? null,
        settle: () => ctx.keyring!.keep((k) => withoutOwedEntry(k, r.accountId)),
      }, { signingSecret: r.seat.signingSecret, companyKeys: r.companyKeys }, async () => (await r.holders()).founding ?? null);
      if (typeof filed === 'object') {
        throw new StepRefused(why('entry-not-filed', { says: 'notYet' in filed ? filed.notYet : filed.waitingForItsInvitation }));
      }
    },
  };

  const offered: ActionStep = {
    title: { key: `${titles}.step.offer` },
    run: async (ctx) => {
      const { reach: r, signed } = await sign(ctx);
      await vaultKeysOfferedAndFolded({
        api: r.api, accountId: r.accountId, label: r.label, account: r.account, signerId: r.seat.signerId,
        signingSecret: r.seat.signingSecret, companyKey: r.companyKey, companyKeys: r.companyKeys,
        committeeKey: signed.committeeKey as never, recordsKey: signed.statement, entry: signed.entry!,
        reads: r.judges.rosterReadsFor(r.accountId, r.label, r.account), entered: enteredFor(r),
      });
    },
  };

  /** Forgets what was read, so the next step reads the company again: after the company's key changed, every seal is under the new key. */
  const renew = (): void => { read.renew(); given = null; };

  return { steps: [entered, offered] as readonly ActionStep[], given: sign, company, renew };
}

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.give-vault-keys.why.${key}`, ...(values === undefined ? {} : { values }),
});

/** The lines the window shows before the passkey: the company as the page names it, and what the action does. */
export const vaultKeysShown = (intent: { readonly fields: Readonly<Record<string, string>> }, at: string): ShownLine[] => {
  const label = readCompanyLabel(intent.fields['company']);
  const account = readAccountAddress(intent.fields['account']);
  return [
    { key: `${at}.shown.company`, values: { label: String(intent.fields['company'] ?? '') }, from: 'page' },
    { key: `${at}.shown.company-check`, from: 'action' },
    ...(label === null || account === null ? [] : [{
      key: `${at}.shown.pin`, values: { account, fingerprint: companyFingerprint(label, account) }, from: 'page' as const,
    }]),
    { key: `${at}.shown.keys`, from: 'action' },
  ];
};


export function giveVaultKeysAction(reach: VaultKeysReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.give-vault-keys.headline',
    shown: async (intent) => [
      ...vaultKeysShown(intent, 'act.give-vault-keys'), ...upkeepShown(), { key: 'act.give-vault-keys.shown.nothing-else', from: 'action' as const },
    ],
    checks: [
      { key: 'act.give-vault-keys.check.seat' },
      { key: 'act.give-vault-keys.check.roster' },
      { key: 'act.give-vault-keys.check.signed' },
      UPKEEP_CHECK,
    ],
    check: async (intent, held) => (held.wallet === undefined ? why('no-record') : intent.fields['record'] === undefined ? why('not-a-company') : null),
    steps: () => {
      const keys = vaultKeysSteps(reach, why, 'act.give-vault-keys');
      const upkeep = upkeepSteps({ reach: keys.company, renew: keys.renew }, reach);
      return [upkeep.first, ...keys.steps, upkeep.last];
    },
  } satisfies ActionDefinition);
}
