import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addressFingerprint } from 'midnight-identity/profile/fingerprint';
import { FileStore } from './store-file.js';
import { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } from './ledger.js';
import { AccountService } from './account.js';
import { PayrollService, RecordingInviteDelivery } from './payroll.js';
import { sealHandover } from './invite-handover.js';
import { openRecord, sealRecord } from './sealed-records.js';
import { newWrappingKeypair, toHex, fromHex, type Hex } from './crypto.js';
import { assets, privateForm } from './assets.js';
import {
  entryKindOf, payrollPayee, privacyOf, transferFacts, transferOf,
} from './movement.js';
import { payeeFor, unshieldedPayeeFor } from '../testing/payees.js';
import { vaultDetails } from '../testing/vault-details.js';
import { registryWithTestPrivateForms, aVaultHolding } from '../testing/assets.js';
import { buildRun } from '../midnight/payout-tree.js';
import type { PaymentFacts } from '../midnight/payout-tree.js';
import { payeeOf, recipientOf, type Payee } from '../midnight/payee-address.js';
import { acceptedCodes } from '../web/accepted-address.js';
import type { PayoutSeed, RunIdentity } from '../midnight/run-keys.js';
import type { User } from './types.js';

/**
 * **A PERSON CAN BE RECORDED AS A PUBLIC PAYEE, AND A PAYROLL RUN REFUSES ONE.**
 *
 * Two rules that look like one and are not, which is why they are pinned in one
 * file where a reader can see them side by side:
 *
 *   **THE DOOR IS OPEN.** A public address can be handed over, admitted, read
 *   back out of the seal and paid, through the same decode a private one goes
 *   through. Nobody is asked which kind it is; the string says.
 *
 *   **AND THE PAYROLL PATH REFUSES IT.** A public payment publishes the
 *   recipient's address and the amount, and an employee never consents to
 *   being disclosed. So a payroll run cannot contain a public payee, refused in
 *   the code rather than warned about, with no flag anywhere that relaxes it.
 *
 * **THE SECOND RULE IS WHAT MAKES THE FIRST ONE SAFE.** Widening the door
 * without it would ship the exact failure it exists to prevent, so the tests
 * below that DELETE the refusal in spirit — a run drawn, a run's money built —
 * are the ones worth reading first.
 */

const NETWORK = 'undeployed' as const;

/**
 * A ROSTER ADDRESS AS THE OLD CODE WROTE IT, FROZEN AS TEXT.
 *
 * A literal rather than a derivation, because the property under test is that a
 * record sealed BEFORE this change still reads. A fixture recomputed by today's
 * code cannot fail the way yesterday's record could.
 */
const OLD_SHIELDED = 'mn_shield-addr_undeployed15xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp'
  + '5xs6rgdp5xslh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alh7capsjjp';

const harness = () => {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-s12-')), 'db.json'));
  const registry = registryWithTestPrivateForms();
  const accounts = new AccountService(
    store, new SimulatedLedger(SimulatedCommitments), SimulatedCommitments, registry, aVaultHolding());
  const invites = new RecordingInviteDelivery();
  const payroll = new PayrollService(
    store, accounts, new SimulatedProofSystem(), registry, NETWORK, invites);
  return { store, accounts, payroll, invites };
};

const signIn = (store: { putUser: (u: User) => void }, email: string | null, id: string) => {
  store.putUser({
    id, email, name: email ?? '', keyBundle: null,
    keyBundleVersion: 0, identityPublicKey: null, walletKey: null,
    createdAt: '2026-08-29T00:00:00.000Z',
  } as unknown as User);
  return id;
};

/** The invitee's own device sealing what it hands over. Either kind of address. */
const handedOver = (
  h: ReturnType<typeof harness>, token: string,
  parts: { address: Payee; wrappingPublicKey?: Hex; confirmation?: string | null },
) => {
  const invite = h.store.getInvite(token)!;
  const account = h.store.getAccount(invite.accountId)!;
  return sealHandover({
    wrappingPublicKey: parts.wrappingPublicKey ?? newWrappingKeypair().publicKey,
    address: parts.address.bech32,
    confirmation: parts.confirmation ?? null,
  }, account.inboxPublicKey);
};

const SIGNERS = [
  { name: 'Ada', role: 'admin' as const },
  { name: 'Blake', role: 'approver' as const },
  { name: 'Cleo', role: 'approver' as const },
];

describe('the door, the refusal, and the record', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  const company = async () => {
    const made = await h.accounts.create('Acme', SIGNERS, 2);
    return made;
  };

  /* ──────────────────────────────────────────────────────────────────────
   * §1 THE DOOR
   * ────────────────────────────────────────────────────────────────────── */

  it('§1 A PUBLIC ADDRESS IS HANDED OVER, ADMITTED AND READ BACK, WITH ITS KIND NEVER ASKED FOR', async () => {
    /*
     * **THE WHOLE DOOR, THROUGH THE ORDINARY INVITE FLOW.** Nothing here names
     * a kind: the company invites somebody, a device hands over a string, and
     * `admit` decodes it. The kind on the record came out of the type segment
     * the platform put in the address.
     */
    const { account, viewingKey } = await company();
    const vendor = unshieldedPayeeFor('c3'.repeat(32), NETWORK);

    const { sentTo } = h.payroll.invite(account.id, {
      name: 'Bright Supplies', email: 'pay@bright.example', title: 'Vendor',
      asset: 'NIGHT', baseAmount: 1_000_000n,
    }, viewingKey, 'usr_operator');
    const token = h.invites.tokenFor(sentTo!);

    h.payroll.acceptInvite(
      token, handedOver(h, token, { address: vendor }),
      signIn(h.store, sentTo, 'usr_vendor'));

    const admitted = h.payroll.admit(
      h.store.listEmployees(account.id)[0].id, viewingKey, 'usr_admin');

    expect(admitted.status).toBe('active');
    expect(admitted.address!.kind).toBe('unshielded');
    expect(admitted.address!.bech32).toBe(vendor.bech32);

    /* And it survives the seal: `open` re-parses rather than reviving JSON. */
    const again = h.payroll.person(admitted.id, viewingKey)!;
    expect(again.address!.kind).toBe('unshielded');
    expect(again.address!.bech32).toBe(vendor.bech32);
  });

  it('§1 A COMPANY RECORDS ITS OWN PUBLIC ADDRESS THROUGH THE SAME DOOR', async () => {
    /*
     * **A WITHDRAWAL, AT THE POINT IT WAS BLOCKED.** A withdrawal is a
     * one-payee run to the company's own address, and the door's refusal of
     * public addresses was the only thing in its way. This is that block
     * coming off: a member records the company's own public address and it is
     * admitted.
     *
     * **WHAT IT DOES NOT SHOW IS THAT A WITHDRAWAL IS BUILDABLE**, and the
     * test reports why rather than forcing it. The entry this produces is a
     * roster EMPLOYEE — a name, a salary, a payslip key, a place in every
     * future run — and §2 refuses every run that draws it. The company's own
     * address belongs in a payee book and not on the roster.
     */
    const { account, viewingKey } = await company();
    const me = signIn(h.store, 'founder@acme.example', 'usr_founder');
    (h.store as any).putAccount({
      ...h.accounts.require(account.id), memberUserIds: [me],
    });

    const own = unshieldedPayeeFor('d4'.repeat(32), NETWORK);
    const entry = h.payroll.addSelfAsPayee(account.id, me, {
      name: 'Acme operating account', email: null, title: 'Company',
      asset: 'NIGHT', baseAmount: 1n,
    }, viewingKey, { wrappingPublicKey: newWrappingKeypair().publicKey, address: own });

    expect(entry.status).toBe('active');
    expect(entry.address!.kind).toBe('unshielded');
    expect(privacyOf(entry.address!)).toBe('public');
  });

  /* ──────────────────────────────────────────────────────────────────────
   * §2 THE REFUSAL
   * ────────────────────────────────────────────────────────────────────── */

  const withPublicPayee = async () => {
    const { account, viewingKey } = await company();
    const me = signIn(h.store, 'founder@acme.example', 'usr_founder');
    (h.store as any).putAccount({
      ...h.accounts.require(account.id), memberUserIds: [me],
    });
    const entry = h.payroll.addSelfAsPayee(account.id, me, {
      name: 'Robin', email: null, title: 'Contractor',
      asset: 'NIGHT', baseAmount: 500_000n,
    }, viewingKey, {
      wrappingPublicKey: newWrappingKeypair().publicKey,
      address: unshieldedPayeeFor('e5'.repeat(32), NETWORK),
    });
    return { account, viewingKey, entry };
  };

  it('§2 A RUN DRAWN FROM A ROSTER HOLDING A PUBLIC PAYEE IS REFUSED, AND IT NAMES THEM', async () => {
    const { account, viewingKey } = await withPublicPayee();
    await expect(h.payroll.createRunFromRoster(account.id, '2026-08', viewingKey))
      .rejects.toThrow(
        /Robin is set up to be paid publicly[\s\S]*a payroll run will not accept a public address/);
  });

  it('§2 AND AT THE LINE NOTHING REACHES THE CHAIN WITHOUT, WHICH IS WHERE IT IS LOAD BEARING', async () => {
    /*
     * **THE REFUSAL AT THE DRAW IS FOR THE PERSON; THIS ONE IS FOR THE MONEY.**
     * A run raised while everybody was private, whose roster then changes, must
     * not build payment facts for a public payee. That is the state
     * `paymentFactsFor` is the last thing standing in front of.
     *
     * The address is swapped through `putPerson`, which is how the neighbouring
     * test reaches a roster state `admit` cannot produce. The point is not that
     * the product can produce it; it is that the refusal does not depend on the
     * product being unable to.
     */
    const { account, viewingKey } = await company();
    const a = h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'NIGHT', baseAmount: 100_00n,
    }, viewingKey);
    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-08', viewingKey);

    const person = h.payroll.person(a.employee.id, viewingKey)!;
    (h.payroll as any).putPerson(
      { ...person, address: unshieldedPayeeFor('f6'.repeat(32), NETWORK) }, viewingKey);

    expect(() => h.payroll.paymentFactsFor(run.id, viewingKey))
      .toThrow(/Dana is set up to be paid publicly[\s\S]*will not accept a public address/);
  });

  it('§2 A PRIVATE PAYEE PASSES THROUGH UNCHANGED, SO THE REFUSAL IS NOT A WALL', async () => {
    const { account, viewingKey } = await company();
    h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-08', viewingKey);
    const facts = h.payroll.paymentFactsFor(run.id, viewingKey);
    expect(facts).toHaveLength(1);
    expect(facts[0].payee.kind).toBe('shielded');

    /* And the same function, called directly, hands the payee back rather than
     * merely permitting it — which is what lets the caller's own type narrow. */
    const payee = payeeFor('a1'.repeat(32), NETWORK);
    expect(payrollPayee('Dana', payee)).toBe(payee);
  });

  it('§2 IT IS A REFUSAL AND NOT A WARNING, AND IT SAYS WHAT TO DO INSTEAD', () => {
    /*
     * A warning is a decision handed to an operator at the worst moment, and
     * this one is wrong for every customer. So the message must not read as a
     * question, and it must leave somebody with a next step rather than a wall.
     */
    let says = '';
    try {
      payrollPayee('Robin', unshieldedPayeeFor('e5'.repeat(32), NETWORK));
    } catch (e) { says = (e as Error).message; }

    expect(says).toContain('a payroll run will not accept a public address');
    /* And it does NOT claim payroll already settles privately. No asset has a
     * private form today, so that sentence would be the overclaim this whole
     * round exists to avoid, printed where a customer would believe it. */
    expect(says).not.toMatch(/payroll is always private|nobody can see|confidential/i);
    expect(says).toContain('one-off transfer');
    /* Not a confirmation. */
    expect(says).not.toMatch(/are you sure|continue anyway|confirm|override/i);
    /* Not written in the platform's vocabulary. Product-copy pass. */
    expect(says).not.toMatch(/shielded|unshielded|note|wallet|mint|gas/i);
    /* And no em dash: this product must not read as machine written. */
    expect(says).not.toContain('—');
  });

  it('§2 NO FLAG RELAXES IT, PINNED ON THE SHAPE RATHER THAN ON GOOD INTENTIONS', () => {
    /*
     * **A RULE WITH A SWITCH BESIDE IT IS THE RULE NOT EXISTING**, and the
     * switch always arrives as a test-mode option somebody needs for one
     * afternoon. There is nowhere to put one: this takes a name and a payee.
     *
     * The arity is the pin. An options argument, a boolean, an environment
     * read behind the signature — the first two fail here, and the third has no
     * place to be passed from.
     */
    expect(payrollPayee.length).toBe(2);
  });

  /* ──────────────────────────────────────────────────────────────────────
   * §3 THE RECORD — A TRANSFER IS FILED AS A TRANSFER
   * ────────────────────────────────────────────────────────────────────── */

  const publicTransfer = () => transferOf({
    accountId: 'acct_1',
    payee: unshieldedPayeeFor('c3'.repeat(32), NETWORK),
    asset: 'NIGHT',
    amount: 250_000n,
    privacy: 'public',
    reference: 'Bright Supplies, August',
    createdBy: 'usr_founder',
    employees: [],
    at: new Date('2026-08-29T09:00:00.000Z'),
  });

  it('§3 A TRANSFER IS A TRANSFER IN THE RECORD, AND THERE IS NOTHING TO SET IT TO', () => {
    /*
     * The misfiling this exists to prevent is a transfer written into the log
     * as a payroll, where an auditor reading it in a year sees somebody's
     * salary. `movement` is a literal, so there is no assignment that could do
     * it, and `entryKindOf` is the only bridge to the ledger's vocabulary.
     */
    const t = publicTransfer();
    expect(t.movement).toBe('transfer');
    expect(entryKindOf(t.movement)).toBe('transfer');
    expect(entryKindOf('payroll')).toBe('payroll');
    expect(t.privacy).toBe('public');
    expect(t.reference).toBe('Bright Supplies, August');
    expect(t.proposalId).toBeNull();
  });

  it('§3 A TRANSFER NEVER APPEARS IN PAYROLL HISTORY', async () => {
    const { account, viewingKey } = await company();
    h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
    await h.payroll.createRunFromRoster(account.id, '2026-08', viewingKey);
    publicTransfer();

    /* Payroll history is runs. A transfer is not one, and cannot become one:
     * §2's refusal is what stops a public payee reaching a run at all. */
    const runs = h.store.listRuns(account.id);
    expect(runs).toHaveLength(1);
    expect(runs.map(r => r.id).some(id => id.startsWith('trf_'))).toBe(false);
  });

  it('§3 THE TOGGLE CANNOT DISAGREE WITH THE ADDRESS', () => {
    /*
     * The failure worth naming is the quiet correction: the person believes
     * they chose private, the money settles in public, and every screen agreed
     * with them the whole way. So a disagreement is refused and both sides are
     * named, because a message saying only "invalid" leaves them to guess which
     * of the two they got wrong.
     */
    expect(() => transferOf({
      accountId: 'acct_1',
      payee: unshieldedPayeeFor('c3'.repeat(32), NETWORK),
      asset: 'NIGHT', amount: 1n, privacy: 'private',
      reference: 'r', createdBy: 'usr_founder', employees: [],
    })).toThrow(/set to private and the address is a public one/);
  });

  it('§3 PRIVATE IS REFUSED FOR AN ASSET WITH NO PRIVATE FORM, AND THE REASON IS THE MESSAGE', () => {
    /*
     * The shape to avoid is an interface implying an operation the settlement
     * cannot perform, and offering private money that does not exist yet is
     * exactly that. The reason travels in the refusal so the screen has
     * something true to show rather than a red border.
     */
    expect(() => transferOf({
      accountId: 'acct_1',
      payee: payeeFor('a1'.repeat(32), NETWORK),
      asset: 'NIGHT', amount: 1n, privacy: 'private',
      reference: 'r', createdBy: 'usr_founder', employees: [],
    })).toThrow(/NIGHT can only be sent publicly today/);
  });

  it('§3 WHETHER AN ASSET HAS A PRIVATE FORM IS A FUNCTION, AND IT ANSWERS FOR EVERY ASSET', () => {
    /*
     * A function rather than a list at a call site, because the answer changes
     * for every asset at once on the day the converter is deployed. **It is
     * read off the row**, established rather than assumed: an asset with a
     * private token has one to send and an asset without has not. NIGHT is
     * unshielded by definition and is no for ever; the rest are held on another
     * chain or on none, and are no until a converter exists.
     */
    for (const asset of assets.all()) {
      const form = privateForm(asset);
      /* RED WHEN the answer stops following the row it is read off. */
      expect(form.of, asset.code).toBe(asset.ledger.shielded === null ? 'not-yet' : 'available');
      if (form.of === 'not-yet') {
        expect(form.why).toContain(asset.code);
        expect(form.why).not.toContain('—');
        expect(form.why).not.toMatch(/shielded|unshielded|token|wrap/i);
      }
    }
    /*
     * **EXACTLY ONE ASSET ANSWERS YES AND IT IS A TEST ONE.** RED WHEN a real
     * asset starts answering `available`, which is a screen offering a private
     * payment the settlement cannot make - the thing the privacy rule is about.
     */
    expect(assets.all().filter(a => privateForm(a).of === 'available').map(a => a.code))
      .toEqual(['TESTUSD']);
    /*
     * **AND THE ANSWER IS THE ROW'S, NOT A NAME'S.** Every asset above has the
     * same answer whether it is read off the row or off a list naming the one
     * test asset, so the loop above cannot tell them apart. The same assets
     * with their private form changed can. RED WHEN: whether an asset has a
     * private form is decided by anything but its own row - a list of codes, a
     * test asset named, or a second field beside the ledger identity.
     */
    for (const asset of assets.all()) {
      const gained = { ...asset, ledger: { ...asset.ledger, shielded: 'e1'.repeat(32) } };
      const lost = { ...asset, ledger: { ...asset.ledger, shielded: null } };
      expect(privateForm(gained).of, `${asset.code} with a private token`).toBe('available');
      expect(privateForm(lost).of, `${asset.code} without one`).toBe('not-yet');
    }
    expect(privateForm(assets.require('NIGHT'))).toEqual({
      of: 'not-yet',
      why: "NIGHT can only be sent publicly today, which puts the recipient's address and "
        + 'the amount on a record anyone can read. There is no private form of NIGHT yet. '
        + 'This choice turns on when there is.',
    });
    /* **AND IT SAYS WHAT THE AVAILABLE SIDE COSTS.** A reason that only says
     * private is coming leaves a customer reading public as the ordinary
     * temporary option, with nothing telling them what it publishes. It also
     * promises nothing: no converter is deployed. */
    for (const asset of assets.all()) {
      const form = privateForm(asset);
      if (form.of === 'not-yet') {
        expect(form.why).not.toMatch(/being built|will open later|coming soon/i);
      }
    }
  });

  it('§3 A PUBLIC TRANSFER TO SOMEBODY ON THE ROSTER IS REFUSED, WHICH IS THE OTHER HALF OF THE RULE', () => {
    /*
     * **`payrollPayee` IS WRITTEN ON THE SHAPE OF A RUN AND THE RULE IS ABOUT
     * WHO THE PAYEE IS.**
     *
     * A bonus, an expense or a correction raised as a one-off transfer to an
     * employee's own address publishes them, with every check in the round
     * passing. So the roster is a required argument here and there is no
     * default that could quietly stop the check being made.
     */
    const employee = unshieldedPayeeFor('c3'.repeat(32), NETWORK);
    expect(() => transferOf({
      accountId: 'acct_1', payee: employee, asset: 'NIGHT', amount: 1n,
      privacy: 'public', reference: 'August bonus', createdBy: 'usr_founder',
      employees: [employee],
    })).toThrow(/this address is on the payroll roster[\s\S]*pay them through payroll instead/);

    /* Somebody who is not on the roster is paid publicly without objection,
     * because that is the company's own money going where it chose. */
    expect(transferOf({
      accountId: 'acct_1', payee: unshieldedPayeeFor('99'.repeat(32), NETWORK),
      asset: 'NIGHT', amount: 1n, privacy: 'public', reference: 'Vendor',
      createdBy: 'usr_founder', employees: [employee],
    }).privacy).toBe('public');
  });

  it('§3 A TRANSFER CANNOT BE MINTED NAMING AN APPROVAL ROUND IT DOES NOT HAVE', () => {
    /*
     * `proposalId` was settable at construction, so a transfer could be made
     * already pointing at somebody else's approved round. The chain refuses
     * that settlement on the root check and no money moves; the RECORD still
     * attributes the transfer to a round that never authorised it, in exactly
     * the document an auditor reads.
     */
    expect(publicTransfer().proposalId).toBeNull();
    /*
     * **PINNED BY THE TYPECHECKER RATHER THAN BY THIS ASSERTION.** If
     * `proposalId` ever returns to `TransferSpec`, the directive below stops
     * suppressing anything and `tsc` fails on the unused suppression — which
     * is a stronger pin than a test, because both configs run before the suite.
     */
    const made = transferOf({
      accountId: 'acct_1', payee: unshieldedPayeeFor('99'.repeat(32), NETWORK),
      asset: 'NIGHT', amount: 1n, privacy: 'public', reference: 'Vendor',
      createdBy: 'usr_founder', employees: [],
      // @ts-expect-error a transfer cannot be minted already naming an approval round
      proposalId: 'prop_someone_elses',
    });
    expect(made.proposalId).toBeNull();
  });

  it('§3 PRIVATE OR PUBLIC IS READ OFF THE ADDRESS AND NEVER ASKED FOR', () => {
    expect(privacyOf(payeeFor('a1'.repeat(32), NETWORK))).toBe('private');
    expect(privacyOf(unshieldedPayeeFor('c3'.repeat(32), NETWORK))).toBe('public');
  });

  /* ──────────────────────────────────────────────────────────────────────
   * §4 A ROSTER SEALED BEFORE PUBLIC PAYEES EXISTED STILL READS
   * ────────────────────────────────────────────────────────────────────── */

  it('§4 A ROSTER SEALED BEFORE PUBLIC PAYEES EXISTED STILL READS, AND STILL PAYS', async () => {
    /*
     * **THE FIXTURE IS TEXT FROM BEFORE THE CHANGE, NOT A VALUE TODAY'S CODE
     * DERIVED.** `open` used to call `payeeAddress`, which refused anything but
     * a `shield-addr`; it calls `payeeOf` now. A `shield-addr` through `payeeOf`
     * returns the shielded kind because the kind comes from the type segment,
     * and the seal already carries the bech32 and the network this line
     * re-parses. Pinned rather than asserted.
     */
    const { account, viewingKey } = await company();
    const a = h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);

    const raw = h.store.getEmployee(a.employee.id)!;
    const secrets = openRecord<any>('payroll', raw.accountId, raw.sealed, viewingKey);
    h.store.putEmployee({
      ...raw,
      sealed: sealRecord('payroll', raw.accountId, {
        ...secrets,
        /* Exactly the JSON the old roster wrote, address and all. */
        address: {
          kind: 'shielded',
          bech32: OLD_SHIELDED,
          network: NETWORK,
          coinPublicKey: 'a1'.repeat(32),
          encryptionPublicKey: 'fb'.repeat(32),
        },
      }, viewingKey),
    });

    const again = h.payroll.person(a.employee.id, viewingKey)!;
    expect(again.address!.kind).toBe('shielded');
    expect(again.address!.bech32).toBe(OLD_SHIELDED);

    /* And it is still payable: the refusal above does not catch a record from
     * before the refusal existed. */
    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-08', viewingKey);
    expect(h.payroll.paymentFactsFor(run.id, viewingKey)[0].payee.bech32).toBe(OLD_SHIELDED);
  });

  /* ──────────────────────────────────────────────────────────────────────
   * §5 THE FINGERPRINT, ESTABLISHED FOR BOTH KINDS
   * ────────────────────────────────────────────────────────────────────── */

  it('§5 A PUBLIC ADDRESS HAS A STABLE FINGERPRINT, AND IT IS NOT THE PRIVATE ONE', () => {
    /*
     * This is ESTABLISHED here rather than assumed to carry over.
     * `addressFingerprint` hashes the address string, so it is kind-agnostic
     * by construction and `Identity/` does not change. **That is the claim, and
     * this is the pin.**
     *
     * The two addresses below are built from DIFFERENT bytes and would be
     * different fingerprints whatever the function did; the assertion that
     * carries weight is that a public address produces one at all, produces the
     * same one twice, and produces the code shape everything downstream
     * compares.
     */
    const vendor = unshieldedPayeeFor('c3'.repeat(32), NETWORK);
    const employee = payeeFor('a1'.repeat(32), NETWORK);

    const once = addressFingerprint(vendor.bech32);
    expect(addressFingerprint(vendor.bech32)).toBe(once);
    expect(once).toBeTruthy();
    expect(once).not.toBe(addressFingerprint(employee.bech32));

    /* Case does not change it: the function lowercases, and a customer reading
     * a code off a screen types it however they like. */
    expect(addressFingerprint(vendor.bech32.toUpperCase())).toBe(once);
  });

  it('§5 AND IT ROUND-TRIPS THROUGH THE ADMIN SCREEN AND THROUGH `admit`', async () => {
    /*
     * The code the payee's own device showed them travels sealed inside the
     * handover; `admit` recomputes it from the address that actually arrived,
     * and the admin's own machine recomputes it from the same ciphertext
     * (`accepted-address.ts`). **All three now agree on a public address**,
     * which is what "established for the other kind" has to mean.
     */
    const { account, viewingKey } = await company();
    const vendor = unshieldedPayeeFor('c3'.repeat(32), NETWORK);
    const code = addressFingerprint(vendor.bech32);

    const { sentTo } = h.payroll.invite(account.id, {
      name: 'Bright Supplies', email: 'pay@bright.example', title: 'Vendor',
      asset: 'NIGHT', baseAmount: 1_000_000n,
    }, viewingKey, 'usr_operator');
    const token = h.invites.tokenFor(sentTo!);
    h.payroll.acceptInvite(
      token, handedOver(h, token, { address: vendor, confirmation: code }),
      signIn(h.store, sentTo, 'usr_vendor'));

    const employeeId = h.store.listEmployees(account.id)[0].id;

    /* The admin's machine, from ciphertext, with no key on our side. */
    const seen = acceptedCodes(h.payroll.handoverBlob(employeeId), account.id, viewingKey);
    expect(seen).toEqual({ of: 'opened', ours: code, theirs: code, agree: true });

    /* And `admit` makes the same comparison before it writes the roster. */
    expect(h.payroll.admit(employeeId, viewingKey, 'usr_admin').address!.bech32)
      .toBe(vendor.bech32);
  });

  it('§5 A PUBLIC HANDOVER WHOSE CODE DOES NOT MATCH IS REFUSED, LIKE A PRIVATE ONE', async () => {
    const { account, viewingKey } = await company();
    const vendor = unshieldedPayeeFor('c3'.repeat(32), NETWORK);

    const { sentTo } = h.payroll.invite(account.id, {
      name: 'Bright Supplies', email: 'pay@bright.example', title: 'Vendor',
      asset: 'NIGHT', baseAmount: 1_000_000n,
    }, viewingKey, 'usr_operator');
    const token = h.invites.tokenFor(sentTo!);
    h.payroll.acceptInvite(
      token,
      handedOver(h, token, {
        address: vendor,
        /* The code of somebody else's address. */
        confirmation: addressFingerprint(unshieldedPayeeFor('11'.repeat(32), NETWORK).bech32),
      }),
      signIn(h.store, sentTo, 'usr_vendor'));

    expect(() => h.payroll.admit(
      h.store.listEmployees(account.id)[0].id, viewingKey, 'usr_admin'))
      .toThrow(/is not the code of the address that arrived/);
  });

  /* ──────────────────────────────────────────────────────────────────────
   * §5b THE OBSTACLE TO A WITHDRAWAL, DRIVEN RATHER THAN REASONED ABOUT
   * ────────────────────────────────────────────────────────────────────── */

  it('§5b THE ROSTER TREATS A PUBLIC PAYEE AS A PERSON, AND ONE MEMBER GETS ONE ENTRY', async () => {
    /*
     * **CAN A COMPANY'S OWN ADDRESS GO THROUGH THIS DOOR, WHEN SOMETHING
     * DOWNSTREAM ASSUMES A PAYEE IS A PERSON? THIS IS THE ANSWER, RUN RATHER
     * THAN READ.**
     *
     * `admit`'s one-payable-entry-per-person cap keys on the sign-in
     * that set the address. **A member who is already a payee cannot record a
     * second address**, so a founder on payroll cannot also record the
     * company's own account, and the refusal is correct: for a PERSON, two
     * payable entries are two salaries.
     *
     * **So the company's own address is not a roster entry**, and a payee book
     * is where it belongs. Reported here rather than forced past.
     */
    const { account, viewingKey } = await company();
    const me = signIn(h.store, 'founder@acme.example', 'usr_founder');
    (h.store as any).putAccount({
      ...h.accounts.require(account.id), memberUserIds: [me],
    });
    const wrappingPublicKey = newWrappingKeypair().publicKey;

    h.payroll.addSelfAsPayee(account.id, me, {
      name: 'The Founder', email: null, title: 'Founder',
      asset: 'GBP', baseAmount: 5_000_00n,
    }, viewingKey, { wrappingPublicKey, address: payeeFor('a1'.repeat(32), NETWORK) });

    expect(() => h.payroll.addSelfAsPayee(account.id, me, {
      name: 'Acme operating account', email: null, title: 'Company',
      asset: 'NIGHT', baseAmount: 1n,
    }, viewingKey, {
      wrappingPublicKey, address: unshieldedPayeeFor('d4'.repeat(32), NETWORK),
    })).toThrow(/is already payable on this account/);
  });

  it('§5b AND ONE PERSON IS ONE ADDRESS: THERE IS NO PATH THAT EDITS THE ONE ON FILE', async () => {
    /*
     * **THE TWO-FINGERPRINTS-ONE-PERSON HAZARD, ANSWERED BY WHAT THE CODE DOES
     * TODAY.** A payslip is matched by fingerprint, and one person with two
     * addresses is two fingerprints. **The roster cannot hold two**: `admit` is
     * the only line in this service that writes `address`, and the cap above
     * refuses a second payable entry for the same sign-in.
     *
     * **THE COST, STATED RATHER THAN DESIGNED AROUND: changing how somebody is
     * paid is a re-admission and not an edit.** They are marked a leaver and
     * invited again, and their payslips before and after sit under two
     * fingerprints. No second-address feature is built here.
     *
     * The refusal's own message points at an operation that does not exist,
     * which is a wording defect rather than a behaviour one.
     */
    const { account, viewingKey } = await company();
    const a = h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
    const before = h.payroll.person(a.employee.id, viewingKey)!.address!.bech32;

    /* `setStatus` is the only other writer of a roster entry, and it carries
     * the address through untouched rather than taking a new one. */
    h.payroll.setStatus(a.employee.id, 'leaver', viewingKey);
    h.payroll.setStatus(a.employee.id, 'active', viewingKey);
    expect(h.payroll.person(a.employee.id, viewingKey)!.address!.bech32).toBe(before);
  });

  /* ──────────────────────────────────────────────────────────────────────
   * §6 AND IT IS PAID BY THE PUBLIC DOOR, BECAUSE THE ADDRESS SAID SO
   * ────────────────────────────────────────────────────────────────────── */

  it('§6 A RUN BUILT FOR A PUBLIC PAYEE COMMITS UNDER THE PUBLIC DERIVATION', () => {
    /*
     * **THE LAST STEP OF "ADMITTED, READ BACK AND PAID", OFFLINE.** `buildRun`
     * indexes the vault's two details circuits by the PAYEE's own kind, and
     * nothing chooses. So the proof that a roster address reaches the right
     * door is that its leaf matches the public derivation and not the private
     * one, against the compiled contract's own circuits.
     *
     * The hazard is that both derivations take 32 bytes and neither can tell
     * which key space they came from. The two below are the SAME bytes in the
     * two spaces, which is why the leaves differing means the separation held
     * rather than that the inputs differed.
     */
    const bytes = 'c3'.repeat(32);
    const vendor = unshieldedPayeeFor(bytes, NETWORK);
    const facts: PaymentFacts[] = [{
      payee: vendor,
      token: '00'.repeat(32),
      amount: 250_000n,
    }];
    const seeds: PayoutSeed[] = [{ epoch: 0, seed: '77'.repeat(32) }];
    const identity: RunIdentity = { accountId: 'acct_1', runId: 'run_s12', epoch: 0 };

    const run = buildRun(seeds, identity, facts, vaultDetails);
    const args = run.payeeArgs(0);

    expect(recipientOf(args.payee)).toBe(bytes);
    expect(args.details).toBe(toHex(vaultDetails.unshielded(
      fromHex(recipientOf(vendor)), fromHex(facts[0].token), facts[0].amount,
      fromHex(args.blinding))));
    expect(args.details).not.toBe(toHex(vaultDetails.shielded(
      fromHex(bytes), fromHex(facts[0].token), facts[0].amount, fromHex(args.blinding))));
  });

  it('§6 AND THE ADDRESS ON THE ROSTER IS THE ONE THAT DECIDES', async () => {
    /* End to end at the client: what `admit` wrote is what `payeeOf` reads, and
     * what `payeeOf` reads is what picks the door. No field in between. */
    const { account, viewingKey } = await company();
    const me = signIn(h.store, 'founder@acme.example', 'usr_founder');
    (h.store as any).putAccount({
      ...h.accounts.require(account.id), memberUserIds: [me],
    });
    const own = unshieldedPayeeFor('d4'.repeat(32), NETWORK);
    const entry = h.payroll.addSelfAsPayee(account.id, me, {
      name: 'Acme operating account', email: null, title: 'Company',
      asset: 'NIGHT', baseAmount: 1n,
    }, viewingKey, { wrappingPublicKey: newWrappingKeypair().publicKey, address: own });

    const stored = h.payroll.person(entry.id, viewingKey)!.address!;
    expect(stored).toEqual(payeeOf(own.bech32, NETWORK));
    expect(privacyOf(stored)).toBe('public');
  });

  it('§6 A TRANSFER BECOMES A ONE-PAYEE RUN, ON CIRCUITS THAT ALREADY EXIST', () => {
    /*
     * Verified at the client. `recordPayment` never checks who the recipient
     * is, so a transfer needs no circuit of its own: it is a run with one
     * payee. `transferFacts` is the one call that turns the record into what
     * `buildRun` takes, so a screen assembles no fields of its own.
     */
    const t = publicTransfer();
    const facts = transferFacts(t);
    expect(facts.payee).toBe(t.payee);
    expect(facts.amount).toBe(250_000n);

    const run = buildRun(
      [{ epoch: 0, seed: '77'.repeat(32) }],
      { accountId: t.accountId, runId: t.id, epoch: 0 },
      [facts], vaultDetails);
    expect(run.facts).toHaveLength(1);
    expect(run.payeeArgs(0).payee.kind).toBe('unshielded');
  });
});
