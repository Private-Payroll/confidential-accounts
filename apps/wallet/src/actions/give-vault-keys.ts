import { recordsKeyAnswerFor, type RecordsKeyAnswer } from 'midnight-identity/profile/records-key';
import type { RecordsKeyRequest } from 'midnight-identity/profile/request';
import {
  ownEntryFiled,
  vaultKeysOfferedAndFolded,
  type HeldForTheSeat
} from '../../../../packages/web-shared/src/vault-keys-given.js';
import { withOwedEntry, withoutOwedEntry } from '../../../../packages/web-shared/src/keyring-blob.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { signingPublicKeyOf } from '../../../../src/core/crypto.js';
import { companyReachFor, enteredFor, keptReach, type CompanyChain, type CompanyReach } from './company-reach.js';
import { pinHeldFor } from './company-pin.js';
import {
  StepRefused,
  type ActionDefinition,
  type ActionStep,
  type ShownLine,
  type StepContext,
  type Words
} from './definition.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps, type UpkeepReach } from './upkeep.js';

/*
 * GIVE YOUR VAULT KEYS, IN THE WALLET. The wallet signs this seat's records key
 * and its directory entry itself, for the seat its own keys hold and the chain
 * seats; keeps the entry in the person's saved keys before it is filed, so an
 * entry the page did not file is filed on a later press; files it, offers the
 * company the seat's vault keys unless the roster already holds them and the
 * entry as signed, and folds the offers into the roster - each filing
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
}

/**
 * What giving the keys leaves the steps after it: the company as read, the records key the wallet signed, and what the
 * roster read held for this seat before it.
 */
export interface KeysGiven {
  readonly reach: CompanyReach;
  readonly signed: RecordsKeyAnswer;
  readonly held: HeldForTheSeat;
}

/** The steps that give this seat's vault keys, and a way for the steps after them to read what they gave. */
export function vaultKeysSteps(
  reach: VaultKeysReach,
  why: (key: string, values?: Readonly<Record<string, string | number>>) => Words,
  titles: string
) {
  const read = keptReach((ctx) => companyReachFor(ctx, reach.chain(), reach.builder(), (k) => why(k)));
  let given: KeysGiven | null = null;
  const refuse = (key: string): never => {
    throw new StepRefused(why(key));
  };

  /** The company as this run read it: read once, in the run's first step that needs it, and reached as the step running. */
  const company = (ctx: StepContext): Promise<CompanyReach> => read.at(ctx);

  const sign = async (ctx: StepContext): Promise<KeysGiven> => {
    const r = await company(ctx);
    if (given !== null) return given;
    const roster = await r.roster();
    const own = roster.signers.find((s) => s.id === r.seat.signerId && s.status === 'active');
    const named = own?.leafCommitment ?? null;
    if (named === null) refuse('no-seat-on-the-roster');
    if (named!.toLowerCase() !== r.leaf) refuse('not-your-seat');
    const holders = await r.holders();
    const seats = { committee: holders.committee, threshold: holders.threshold, seats: holders.seats };
    const request = {
      schema: 'midnight-identity/disclosure-request/v1',
      kind: 'records-key',
      requester: ctx.asker,
      purpose: '',
      nonce: 'act',
      expiresAt: 0,
      company: r.label,
      account: r.account,
      seat: r.leaf,
      signingKey: signingPublicKeyOf(r.seat.signingSecret).toLowerCase()
    } as unknown as RecordsKeyRequest;
    /* The reach's head held the page's account to the pin for the label; the records key is signed for that pin alone. */
    const pinned = pinHeldFor(ctx, r.label, r.account) ?? refuse('account-not-kept');
    let signed: RecordsKeyAnswer;
    try {
      signed = recordsKeyAnswerFor(ctx.held.identity, request, seats, reach.now(), undefined, pinned.account);
    } catch (e) {
      throw new StepRefused(why('records-key-refused', { says: (e as Error).message }));
    }
    given = { reach: r, signed, held: own! };
    return given;
  };

  const entered: ActionStep = {
    title: { key: `${titles}.step.entry` },
    run: async (ctx) => {
      const { reach: r, signed } = await sign(ctx);
      const person = ctx.person ?? refuse('no-person');
      if (signed.entry === undefined) refuse('records-key-refused');
      const owed = {
        person,
        company: r.label,
        signed: { committeeKey: signed.committeeKey, entry: signed.entry! },
        ...(r.seat.opening === undefined ? {} : { opening: r.seat.opening }),
        ...(r.seat.invited === undefined ? {} : { invited: r.seat.invited })
      };
      await ctx.keyring!.keep((k) => withOwedEntry(k, r.accountId, owed as never));
      const filed = await ownEntryFiled(
        r.accountId,
        {
          read: () => ctx.keyring!.open().read().directoryEntriesOwed?.[r.accountId] ?? null,
          settle: () => ctx.keyring!.keep((k) => withoutOwedEntry(k, r.accountId))
        },
        { signingSecret: r.seat.signingSecret, companyKeys: r.companyKeys },
        async () => (await r.holders()).founding ?? null,
        r.stepView
      );
      if (typeof filed === 'object') {
        throw new StepRefused(
          why('entry-not-filed', { says: 'notYet' in filed ? filed.notYet : filed.waitingForItsInvitation })
        );
      }
    }
  };

  const offered: ActionStep = {
    title: { key: `${titles}.step.offer` },
    run: async (ctx) => {
      /*
       * The answer the wallet signed and what the roster held for this seat are kept from the step before; the company
       * is this step's own read of it. Keys and an entry the roster already holds as signed are not offered again.
       */
      const { signed, held } = await sign(ctx);
      const r = await company(ctx);
      await vaultKeysOfferedAndFolded({
        accountId: r.accountId,
        label: r.label,
        account: r.account,
        signerId: r.seat.signerId,
        signingSecret: r.seat.signingSecret,
        companyKey: r.companyKey,
        companyKeys: r.companyKeys,
        committeeKey: signed.committeeKey as never,
        recordsKey: signed.statement,
        entry: signed.entry!,
        held,
        reads: r.judges.rosterReadsFor(r.accountId, r.label, r.account),
        entered: enteredFor(r),
        view: r.stepView
      });
    }
  };

  /** Forgets what was read, so the next step reads the company again: after the company's key changed, every seal is under the new key. */
  const renew = (): void => {
    read.renew();
    given = null;
  };

  return { steps: [entered, offered] as readonly ActionStep[], given: sign, company, renew };
}

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.give-vault-keys.why.${key}`,
  ...(values === undefined ? {} : { values })
});

/** The lines the window shows before the passkey: the company as the page names it, and what the action does. */
export const vaultKeysShown = (
  intent: { readonly fields: Readonly<Record<string, string>> },
  at: string
): ShownLine[] => [
  { key: `${at}.shown.company`, values: { label: String(intent.fields['company'] ?? '') }, from: 'page' },
  { key: `${at}.shown.company-check`, from: 'action' },
  { key: `${at}.shown.keys`, from: 'action' }
];

export function giveVaultKeysAction(reach: VaultKeysReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.give-vault-keys.headline',
    shown: async (intent) => [
      ...vaultKeysShown(intent, 'act.give-vault-keys'),
      ...upkeepShown(),
      { key: 'act.give-vault-keys.shown.nothing-else', from: 'action' as const }
    ],
    checks: [
      { key: 'act.give-vault-keys.check.seat' },
      { key: 'act.give-vault-keys.check.roster' },
      { key: 'act.give-vault-keys.check.signed' },
      UPKEEP_CHECK
    ],
    check: async (intent) => (intent.fields['record'] === undefined ? why('not-a-company') : null),
    steps: () => {
      const keys = vaultKeysSteps(reach, why, 'act.give-vault-keys');
      const upkeep = upkeepSteps({ reach: keys.company, renew: keys.renew }, reach);
      return [upkeep.first, ...keys.steps, upkeep.last];
    }
  } satisfies ActionDefinition);
}
