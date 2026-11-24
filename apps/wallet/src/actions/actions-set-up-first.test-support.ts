/*
 * The wallet actions that act on something the company holds only once it is set up for them: a person waiting for a
 * seat, a seat taken on the chain, a seat to change the role of or let go, a seated person's invitation, a vault to set a
 * spending policy for, and the upkeep after an admission. Each run sets up its own, first, through the functions the product does it with on the devices that do it, then runs the action, so each
 * size of the company acts on a record of its own.
 */
import { MidnightCommitments } from '../../../../src/midnight/commitments.js';
import { aJoinersWallet, aWalletSecret, type AJoinersWallet } from '../../../../src/testing/a-joiners-wallet.js';
import { writesOver } from '../../../../src/testing/writes-over-a-send.js';
import { throughAView } from '../../../../src/testing/anchor-doors-through-a-view.js';
import { ACME, acmeReads, ORIGIN } from '../../../../src/server/a-company-of-two-seats.test-support.js';
import { ADA, anchorDoorsOf, sendAs } from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import { inviteHere } from '../../../../packages/web-shared/src/invitation-on-device.js';
import { acceptAsSignerHere, openInvitationHere } from '../../../../packages/web-shared/src/invitation-taken-on-device.js';
import { newSeatKeys } from '../../../../packages/web-shared/src/accept-seat.js';
import { anchorTheRecordsHere } from '../../../../packages/web-shared/src/records-anchored-here.js';
import { tokenOfLink } from '../../../../src/core/invitation.js';
import { NIGHT } from '../../../../src/core/assets.js';
import { addSignerByAddressIn } from '../../../../src/core/proposal-filing.js';
import type { PendingSignerPayload, SealedProposal } from '../../../../src/core/types.js';
import { openFromInbox } from '../../../../src/core/sealed-records.js';
import { BO, CO, committeeKeyOfLeaf, CY, KEY, store, theInviteeTakesTheSeatHere } from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import { addressOfWallet, aCompanyOf, runIntent, runUpkeep, type Company, type CompanySize, type IntentCount } from './company-harness.test-support.js';
import { AS_MONEY_GROWS_ACTION_PINS, AS_MONEY_GROWS_CARRIED_PINS, SET_UP_ACTION_PINS, SET_UP_CARRIED_PINS } from './action-count-pins.test-support.js';
import { expect, it } from 'vitest';
import { carriedNotAsHeldIn, countedAtBothSizes, differences, filedRunsOn, readsOf, runsOn, writesOverAnOldRead } from './action-counts.test-support.js';
import { askedOtherThan, heldBy, policiesHeld, type CompanyHeld } from './asked-by-kind.test-support.js';
import { noteRan, runsOfThisCountFile } from './actions-each-count-file-runs.test-support.js';

/** A person invited to a seat by link, who accepted it from their own wallet and waits for the company to seat them. */
export interface SignerWaiting { readonly id: string; readonly name: string; readonly fingerprint: string; readonly leaf: string; readonly wallet: AJoinersWallet }

let waiting = 0;
/*
 * A person invited to a seat by the founding seat, by link, as the function the product invites with; the person opens
 * the link and accepts it with their own wallet's key for the company and the address it signs; then the company's
 * records are anchored, so no action finds them unanchored.
 */
const signerWaitingIn = async (): Promise<SignerWaiting> => {
  waiting += 1;
  const person = `usr_waiting${waiting}`;
  const name = `Waiting ${waiting}`;
  const made = await inviteHere(ACME, ADA, 'signer', { name, role: 'approver', person }, ORIGIN, writesOver(sendAs(ADA.person)));
  const wallet = aJoinersWallet(aWalletSecret(), 70 + waiting, MidnightCommitments);
  const seat = await acceptAsSignerHere(await openInvitationHere(made.link, sendAs(null)), MidnightCommitments, {
    newKeys: newSeatKeys, seal: async () => {}, promote: async () => {},
  }, sendAs(person), person, async () => wallet.walletKey, wallet.seatAddress);
  await anchorTheRecordsHere(throughAView(anchorDoorsOf(ADA)));
  const sealed = store.getAccount(CO)!.pendingSigners.find((p) => p.id === seat.signerId)!.sealed;
  return { id: seat.signerId!, name, fingerprint: seat.fingerprint, wallet, leaf: openFromInbox<PendingSignerPayload>(sealed, CO, KEY as never).leafCommitment.toLowerCase() };
};

/** Runs the wallet action `name` as the founding seat's wallet, on the company's own fields and `more`. */
const byTheFoundingSeat = (company: Company, name: string, more: Readonly<Record<string, string>>): Promise<IntentCount> =>
  runIntent(name, { name, fields: { ...company.fields, ...more } } as never, company, ADA.person);

/** A person invited to a seat by address, whose seat the chain holds, waiting to be admitted. */
export interface SeatTaken { readonly id: string; readonly name: string; readonly person: string; readonly leaf: string }

let seated = 0;
/*
 * A person invited to a seat by address by the founding seat's wallet, which raises the proposal to seat them; a second
 * seat's wallet approves it, as the company asks two approvals; the person's own wallet takes the seat with the link's
 * token; each through the wallet action that does it.
 */
const seatTakenIn = async (company: Company): Promise<SeatTaken> => {
  seated += 1;
  const name = `seated${seated}`;
  const person = name;
  const before = new Set(store.listProposals(CO).map((p) => p.id));
  await byTheFoundingSeat(company, 'invite', { kind: 'signer', personName: name, role: 'approver', address: addressOfWallet(company.wallet(person)) });
  const raised = store.listProposals(CO).find((p) => !before.has(p.id)) as SealedProposal;
  const shown = addSignerByAddressIn(raised as never, CO, KEY as never)!;
  const token = tokenOfLink(company.lastLink())!;
  await runIntent('approve-proposal', { name: 'approve-proposal', fields: {
    ...company.fields, proposal: raised.id, kind: 'add-signer', personName: name, role: shown.invited.terms.role,
    address: shown.invited.terms.invite!.address, scope: shown.invited.terms.invite!.scope, coinKey: shown.coinPublicKey!,
  } } as never, company, BO.person);
  await runIntent('seat-invited', { name: 'seat-invited', fields: { ...company.fields, token } } as never, company, person);
  const leaf = (await acmeReads.invitedSeats([String(raised.chainId)]))[String(raised.chainId).toLowerCase()]!;
  return { id: company.wallet(person).kept.accounts[CO]!.signerId, name, person, leaf };
};

/*
 * A seat taken as `seatTakenIn` takes it, admitted by the founding seat's wallet; then the new signer's wallet answers its
 * first records-key ask, as a signer admitted does, and the founding seat's upkeep gives the new seat each vault's secret,
 * so the company it leaves is whole. The counts of the admission and of that upkeep are handed back.
 */
const seatAdmittedIn = async (company: Company): Promise<SeatTaken & { readonly admitted: IntentCount; readonly upkeep: IntentCount }> => {
  const s = await seatTakenIn(company);
  const admitted = await byTheFoundingSeat(company, 'admit-signer', { signer: s.id, personName: s.name });
  await runIntent('give-vault-keys', { name: 'give-vault-keys', fields: company.fields } as never, company, s.person);
  return { ...s, admitted, upkeep: await runUpkeep(company, ADA.person) };
};

/*
 * The upkeep a seat's wallet runs after a signer is admitted, counted as the action it is: it gives the new seat each
 * vault's secret, a write to each vault's own record, so its writes are one for each vault and its reads are the same at
 * every size.
 */
export const UPKEEP_AFTER_AN_ADMISSION = 'upkeep-after-an-admission';

const VAULT_RECORD_FILED = 'PUT /api/vaults/:vault/records/:kind/:version';

/*
 * A count whose writes to the vaults' own records are counted for each vault the company holds: the upkeep's job is the
 * same records for every vault, so what is held the same at every size is how many it files for each, and one more or
 * fewer for any vault still shows.
 */
const filedForEachVault = (c: IntentCount, vaults: number): IntentCount => ({
  ...c,
  steps: c.steps.map((s) => {
    const { [VAULT_RECORD_FILED]: filed, ...routes } = s.routes;
    return filed === undefined ? s : { ...s, routes, asks: { ...s.asks, 'vault records filed for each vault': filed / vaults } };
  }),
});

const COMPANY_RECORD_FILED = 'PUT /api/accounts/:record/records/:kind/:id/:version';
const POLICY_FILED = /\/records\/spending-policy\/[^/]+\/\d+$/u;

/*
 * A count whose writes of the spending policies sealed again are counted for each policy the company holds: an upkeep
 * after an admission seals every policy again to the signer admitted, one version of each, so what is held the same at
 * every size is how many it files for each, and one more or fewer for any policy still shows.
 */
const filedForEachPolicy = (c: IntentCount, policies: number): IntentCount => ({
  ...c,
  steps: c.steps.map((s) => {
    const filed = c.log.filter((l) => l.step === s.step && l.method === 'PUT' && POLICY_FILED.test(l.path.split('?')[0]!)).length;
    if (filed === 0) return s;
    const others = (s.routes[COMPANY_RECORD_FILED] ?? 0) - filed;
    const routes = Object.fromEntries(Object.entries(s.routes).filter(([r]) => r !== COMPANY_RECORD_FILED));
    return {
      ...s, routes: others === 0 ? routes : { ...routes, [COMPANY_RECORD_FILED]: others },
      asks: { ...s.asks, 'spending policies filed for each policy': filed / policies },
    };
  }),
});

/** One upkeep counted: when, the size the company grows to first (none to stay), how it runs, and its writes' rule. */
interface UpkeepCounted {
  readonly label: string;
  /* The action the upkeep counted is, as the grants of what a read may grow with name it. */
  readonly action: string;
  readonly size: CompanySize | null;
  readonly upkeep: () => Promise<IntentCount>;
  /* Why the vaults' own records the run wrote are not what the upkeep's job holds, or null: given the vaults held and added. */
  readonly writes: (filed: number, vaults: { readonly held: number; readonly added: number }) => string | null;
  /* Whether its reads are held to the upkeep counted before it. */
  readonly heldToTheOneBefore: boolean;
}

/*
 * Counts upkeep runs on `company` one after another, each after the company grows to its size, and holds each one's
 * writes of the vaults' own records to its rule; and each one held to the one before reads the same, and asks the same
 * records of each kind or one more for each one more the company holds where that read is meant to.
 */
function upkeepsHeldAsTheyGrow(company: Company, counts: readonly UpkeepCounted[]): void {
  const counted: { readonly count: IntentCount; readonly held: CompanyHeld; readonly vaults: number }[] = [];
  for (const [i, c] of counts.entries()) {
    it(`the upkeep is counted, step by step, ${c.label}`, async () => {
      const vaultsBefore = company.vaults().length;
      if (c.size !== null) await company.growTo(c.size);
      const count = await c.upkeep();
      noteRan(c.action);
      const vaults = { held: company.vaults().length, added: company.vaults().length - vaultsBefore };
      counted.push({ count, held: await heldBy(company), vaults: vaults.held });
      /* RED WHEN: the upkeep writes the vaults' own records other than as many for each vault as its job holds. */
      expect(c.writes(count.steps.reduce((n, s) => n + (s.routes[VAULT_RECORD_FILED] ?? 0), 0), vaults)).toBeNull();
      /* RED WHEN: a step writes a record again from an answer it read before its own earlier write of it, or an answer carries other than what the service holds. */
      expect([...writesOverAnOldRead(count.log), ...carriedNotAsHeldIn(count.log)]).toEqual([]);
      if (!c.heldToTheOneBefore) return;
      const was = counted[i - 1]!;
      /* RED WHEN: a read of any step is made a different number of times than at the size before, the vaults' own records written for each vault aside. */
      expect(differences('upkeep', readsOf(filedForEachVault(was.count, was.vaults)), readsOf(filedForEachVault(count, vaults.held)), [counts[i - 1]!.label, c.label])).toEqual([]);
      /* RED WHEN: a read that names its records asks more or fewer of a kind than at the size before, other than one more for each one more the company holds where that read is meant to. */
      expect(askedOtherThan(c.action, was.count, count, [was.held, counted[i]!.held], [counts[i - 1]!.label, c.label])).toEqual([]);
    });
  }
}

const FIRST: CompanySize = { people: 3, vendors: 2, vaults: 2, proposals: 1 };

/* Two of the vaults' own records written for each vault the company holds. */
const twoForEachVault = (filed: number, vaults: { readonly held: number }): string | null =>
  (filed === 2 * vaults.held ? null : `${filed} vault records written for ${vaults.held} vaults, where two for each are written`);

/*
 * Counts the upkeep after an admission at the company's first size, then after it grows by vaults alone, then after it
 * grows by people alone: a write for each person or vendor cannot pass as one for each vault when only vaults grow, and
 * none for each vault can hide a write for each person when only people grow. Two vault records are written for each vault
 * at every size. Call it where the file's tests are declared, once, with the file's own address: its entry in the list
 * of what each count file runs names the upkeep after an admission.
 */
export function upkeepAfterAnAdmissionCountedByWhatGrows(url: string): void {
  onlyThese(runsOfThisCountFile(url), [UPKEEP_AFTER_AN_ADMISSION]);
  const company = aCompanyOf(FIRST);
  const upkeep = async (): Promise<IntentCount> => (await seatAdmittedIn(company)).upkeep;
  upkeepsHeldAsTheyGrow(company, [
    { label: 'at the first size', action: UPKEEP_AFTER_AN_ADMISSION, size: null, upkeep, writes: twoForEachVault, heldToTheOneBefore: false },
    { label: 'with twice the vaults', action: UPKEEP_AFTER_AN_ADMISSION, size: { ...FIRST, vaults: 4 }, upkeep, writes: twoForEachVault, heldToTheOneBefore: true },
    { label: 'with twice the people as well', action: UPKEEP_AFTER_AN_ADMISSION, size: { ...FIRST, vaults: 4, people: 6 }, upkeep, writes: twoForEachVault, heldToTheOneBefore: true },
  ]);
}

/*
 * The vaults' own records the first upkeep after growth writes for each vault the growth added: none, as each vault is
 * started with a copy of its secret for every seat the roster holds, the seat admitted after the company was made too.
 */
const GIVEN_FOR_EACH_VAULT_ADDED = 0;

/*
 * Counts the first upkeep after the company grows, as an action of its own: each runs before every count that follows
 * growth, uncounted there. A signer is admitted first, so a seat the company was not made with is held by its vaults. It is
 * counted after the company grows to twice its first size and again after it grows to four times it: its reads are the
 * same at both, and it writes the vaults' own records only for the vaults the growth added, as many for each. The
 * upkeeps after growth are the one a seat's wallet runs at the start and end of its acts, counted as giving vault keys.
 * Call it where the file's tests are declared, once, with the file's own address, whose entry names both.
 */
export function upkeepAfterGrowthCounted(url: string): void {
  onlyThese(runsOfThisCountFile(url), [UPKEEP_AFTER_AN_ADMISSION, 'give-vault-keys']);
  const company = aCompanyOf(FIRST);
  const upkeep = (): Promise<IntentCount> => runUpkeep(company, ADA.person);
  const forEachAdded = (filed: number, vaults: { readonly added: number }): string | null => (filed === GIVEN_FOR_EACH_VAULT_ADDED * vaults.added ? null
    : `${filed} vault records written for ${vaults.added} vaults added, where ${GIVEN_FOR_EACH_VAULT_ADDED} for each are written`);
  upkeepsHeldAsTheyGrow(company, [
    { label: 'after a signer is admitted', action: UPKEEP_AFTER_AN_ADMISSION, size: null, upkeep: async () => (await seatAdmittedIn(company)).upkeep, writes: twoForEachVault, heldToTheOneBefore: false },
    { label: 'first after the company grows to twice its first size', action: 'give-vault-keys', size: { people: 6, vendors: 4, vaults: 4, proposals: 2 }, upkeep, writes: forEachAdded, heldToTheOneBefore: false },
    { label: 'first after it grows to four times it', action: 'give-vault-keys', size: { people: 12, vendors: 8, vaults: 8, proposals: 3 }, upkeep, writes: forEachAdded, heldToTheOneBefore: true },
  ]);
}

/** Each action that acts on something set up for it first, as run at one size. */
export const setUpRunsOn = (company: Company): Readonly<Record<string, (at: 0 | 1) => Promise<IntentCount>>> => {
  /*
   * A removal of the third seat raised by the founding seat, once, before the first removal counted: a removal raised
   * reads the rounds of the removals open in a call of its own, made once any is open, so every count starts with one open.
   */
  let raised: Promise<IntentCount> | null = null;
  const removalOpen = (): Promise<IntentCount> => (raised ??= byTheFoundingSeat(company, 'remove-signer', { leaf: CY.seat }));
  return Object.freeze({
    [UPKEEP_AFTER_AN_ADMISSION]: async () => filedForEachPolicy(filedForEachVault((await seatAdmittedIn(company)).upkeep, company.vaults().length), policiesHeld()),
    'withdraw-waiting-signer': async () => {
      const w = await signerWaitingIn();
      return byTheFoundingSeat(company, 'withdraw-waiting-signer', { signer: w.id, personName: w.name });
    },
    'admit-signer': async () => (await seatAdmittedIn(company)).admitted,
    'remove-signer': async () => {
      const s = await seatAdmittedIn(company);
      await removalOpen();
      return byTheFoundingSeat(company, 'remove-signer', { leaf: s.leaf });
    },
    'change-role': async () => {
      const s = await seatAdmittedIn(company);
      await removalOpen();
      return byTheFoundingSeat(company, 'change-role', { leaf: s.leaf, role: 'admin', address: addressOfWallet(company.wallet(s.person)), personName: s.name });
    },
    /*
     * A spending policy for one of the company's vaults, in Night: the first vault at the first size, the last at twice it,
     * neither of which the company sets a policy on as it grows (it sets one for each vault after the first, in order, and
     * holds fewer than its vaults less one).
     */
    'set-spending-policy': (at: 0 | 1) => byTheFoundingSeat(company, 'set-spending-policy', {
      vault: company.vaults()[at === 0 ? 0 : company.vaults().length - 1]!, token: NIGHT, bands: '100:1,500:2,900:2,1000:3', periodLimit: '1000', periodStart: '0', periodLength: '2592000',
    }),
    'raise-waiting-signer': async () => {
      const w = await signerWaitingIn();
      return byTheFoundingSeat(company, 'raise-waiting-signer', { signer: w.id, personName: w.name, readOut: w.fingerprint });
    },
    /*
     * A run for the employees admitted, drawn on the device, from the first vault in Night paid in public, for a month of
     * its own at each size: a payee is admitted first, so each run pays someone.
     */
    'raise-run': async (at: 0 | 1) => {
      const p = await company.payeeWaiting();
      await byTheFoundingSeat(company, 'admit-person', { kind: 'employee', person: p.id, personName: p.name, fingerprint: p.fingerprint });
      const now = Math.floor(Date.now() / 1000);
      return byTheFoundingSeat(company, 'raise-run', {
        period: ['2027-01', '2027-02'][at]!, vault: company.vaults()[0]!, token: NIGHT, form: 'public', opensAt: String(now + 3600), closesAt: String(now + 86_400),
      });
    },
  });
};

/*
 * Makes a company of the first size and counts the actions of the ones set up for first that the count file at `url`
 * lists, in their order, at its first size and at twice it (`sizes`, where an action needs a company of other sizes), as
 * `countedAtBothSizes` counts them; each count file of these actions counts some of them, on a company of its own, so
 * each runs whole in one sitting. Call it where the file's tests are declared, once.
 */
export function setUpActionsCounted(
  url: string,
  sizes: { readonly first: CompanySize; readonly grown: CompanySize } = { first: { people: 3, vendors: 2, vaults: 2, proposals: 1 }, grown: { people: 6, vendors: 4, vaults: 4, proposals: 2 } },
): void {
  const names = runsOfThisCountFile(url);
  const company = aCompanyOf(sizes.first);
  const every = setUpRunsOn(company);
  const runs = Object.fromEntries(Object.entries(every).filter(([n]) => names.includes(n)));
  if (Object.keys(runs).length !== names.length) throw new Error(`no action set up for first is named ${names.filter((n) => !Object.hasOwn(every, n)).join(', ')}`);
  const only = [...Object.keys(every), ...COUNTED_ON_THEIR_OWN];
  countedAtBothSizes(company, runs, sizes.grown, { reads: SET_UP_ACTION_PINS, carried: SET_UP_CARRIED_PINS }, [
    { name: 'SET_UP_ACTION_PINS', about: 'The actions that act on something set up for them first, on the company at its first size.', of: 'reads', only },
    { name: 'SET_UP_CARRIED_PINS', about: 'The records the service\'s answers to each step of an action set up for first carried, on the company at its first size.', of: 'carried', only },
  ]);
}

/*
 * A person invited by link who accepted with their own wallet, raised for a seat by the founding seat's wallet and
 * approved by the second seat's wallet, each through the wallet action that does it, so the seat waits for them to take
 * it. The proposal's id on the chain is handed back with them.
 */
const approvedByLinkIn = async (company: Company): Promise<SignerWaiting & { readonly chainId: string }> => {
  const w = await signerWaitingIn();
  const before = new Set(store.listProposals(CO).map((p) => p.id));
  await byTheFoundingSeat(company, 'raise-waiting-signer', { signer: w.id, personName: w.name, readOut: w.fingerprint });
  const raised = store.listProposals(CO).find((p) => !before.has(p.id))!;
  const approved = await runIntent('approve-proposal', { name: 'approve-proposal', fields: {
    ...company.fields, proposal: raised.id, kind: 'add-signer', personName: w.name, role: 'approver', leaf: w.leaf,
  } } as never, company, BO.person);
  if (approved.told['state'] !== 'waiting-for-the-invitee') throw new Error(`the seat raised for ${w.name} was ${String(approved.told['state'])}, not approved for them to take`);
  return { ...w, chainId: String(raised.chainId) };
};

/* Refuses a count file's entry that names other actions than the ones its count function runs. */
const onlyThese = (listed: readonly string[], counted: readonly string[]): void => {
  if (listed.length !== counted.length || listed.some((n) => !counted.includes(n))) {
    throw new Error(`this count runs ${counted.join(', ')}, and its file's entry lists ${listed.join(', ')}`);
  }
};

/** The actions counted each on a company of their own, by a count function of their own, not by `setUpRunsOn`. */
export const COUNTED_ON_THEIR_OWN: readonly string[] = ['reissue-invitation'];

/*
 * Counts issuing a seated person's invitation again on a company of its own, at its first size and at twice its people,
 * vendors and vaults: the two people it is issued for are approved as `approvedByLinkIn` approves them, and take their seats
 * from their own wallets on the chain, both before the first count, since no proposal can be raised once either is seated:
 * their wallets are not ones this harness runs, so they never file their own directory entry. So the company grows by no
 * open proposal, and nothing is counted on it after. Call it where the file's tests are declared, once, with the file's
 * own address, whose entry names issuing an invitation again.
 */
export function reissueCounted(url: string): void {
  onlyThese(runsOfThisCountFile(url), COUNTED_ON_THEIR_OWN);
  const company = aCompanyOf({ people: 3, vendors: 2, vaults: 2, proposals: 1 });
  const seated: SignerWaiting[] = [];
  const reissued = async (at: 0 | 1): Promise<IntentCount> => {
    if (seated.length === 0) {
      const approved = [await approvedByLinkIn(company), await approvedByLinkIn(company)];
      for (const s of approved) {
        committeeKeyOfLeaf.set(s.leaf, s.wallet.walletKey as never);
        theInviteeTakesTheSeatHere(s.chainId, s.wallet.holds, s.leaf);
        seated.push(s);
      }
    }
    const s = seated[at]!;
    /* The founding seat's upkeep first, uncounted, gives the seats each vault the company has grown by since. */
    await runUpkeep(company, ADA.person);
    return byTheFoundingSeat(company, 'reissue-invitation', { leaf: s.leaf, personName: s.name });
  };
  const only = [...Object.keys(setUpRunsOn(company)), ...COUNTED_ON_THEIR_OWN];
  countedAtBothSizes(company, { 'reissue-invitation': reissued }, { people: 6, vendors: 4, vaults: 4, proposals: 1 }, { reads: SET_UP_ACTION_PINS, carried: SET_UP_CARRIED_PINS }, [
    { name: 'SET_UP_ACTION_PINS', about: 'The actions that act on something set up for them first, on the company at its first size.', of: 'reads', only },
    { name: 'SET_UP_CARRIED_PINS', about: 'The records the service\'s answers to each step of an action set up for first carried, on the company at its first size.', of: 'carried', only },
  ]);
}

/*
 * The company the counts as money grows run on: a run raised and paid, a one-off payment open and a spending policy set at
 * its first size, and twice each at its grown size, its vendors, vaults and open changes held as they were. Its people are
 * only the payees admitted: a run is drawn only when everyone on the roster is admitted, so no person is left invited.
 */
const MONEY_FIRST: CompanySize = { people: 0, vendors: 2, vaults: 4, proposals: 1, runs: 1, payments: 1, oneOffs: 1, policies: 1 };
const MONEY_GROWN: CompanySize = { ...MONEY_FIRST, runs: 2, payments: 2, oneOffs: 2, policies: 2 };
/** Every action a count file counts as the company's money grows: the tables of these counts hold a row for each. */
export const COUNTED_AS_MONEY_GROWS: readonly string[] = [
  'give-vault-keys', 'invite', 'change-threshold', 'admit-person', 'change-person', UPKEEP_AFTER_AN_ADMISSION, 'withdraw-waiting-signer',
  'admit-signer', 'raise-waiting-signer', 'remove-signer', 'change-role', 'set-spending-policy', 'raise-run',
];

/**
 * Counts the actions the count file at `url` lists, each run as the files that count it at other sizes run it, on a company
 * whose money grows (`MONEY_FIRST`, then `MONEY_GROWN`), as `countedAtBothSizes` counts them, into the tables of the
 * counts as money grows. Call it where the file's tests are declared, once.
 */
export function asMoneyGrowsCounted(url: string): void {
  const names = runsOfThisCountFile(url);
  const company = aCompanyOf(MONEY_FIRST);
  const every = { ...runsOn(company), ...filedRunsOn(company), ...setUpRunsOn(company) };
  const missing = names.filter((n) => !Object.hasOwn(every, n) || !COUNTED_AS_MONEY_GROWS.includes(n));
  if (missing.length > 0) throw new Error(`no action counted as money grows is named ${missing.join(', ')}`);
  const only = COUNTED_AS_MONEY_GROWS;
  countedAtBothSizes(company, Object.fromEntries(names.map((n) => [n, every[n]!])), MONEY_GROWN, { reads: AS_MONEY_GROWS_ACTION_PINS, carried: AS_MONEY_GROWS_CARRIED_PINS }, [
    { name: 'AS_MONEY_GROWS_ACTION_PINS', about: 'The actions counted as the company grows its runs, paid runs and one-off payments, on the company at its first size.', of: 'reads', only },
    { name: 'AS_MONEY_GROWS_CARRIED_PINS', about: 'The records the service\'s answers to each step of an action counted as the company grows its runs, paid runs and one-off payments carried, on the company at its first size.', of: 'carried', only },
  ]);
}
