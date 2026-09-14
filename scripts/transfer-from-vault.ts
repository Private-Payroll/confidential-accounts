/**
 * **A COMPANY PAYING ITS OWN ADDRESS OUT OF ITS OWN VAULT, PUBLICLY.** `C255`,
 *
 *
 * Run it with `TRANSFER-FROM-VAULT.command`. What that door passes and refuses
 * is at the bottom of this file; where it sits in the sequence is
 * `docs/command-order.md`.
 *
 * ------------------------------------------------------------------------
 * **IT IS A TRANSFER AND NOT A PAYROLL RUN, AND THAT IS NOT A DETAIL.**
 *
 * `payrollPayee` refuses a public payee at the type level, deliberately: **an
 * employee never consents to being disclosed and must never be asked to.** A
 * company paying an address it owns is the case the choice exists for, and it
 * goes through `transferOf` — the one door a transfer is made at, carrying its
 * own three refusals.
 *
 * **NOTHING ABOUT BEING A TRANSFER RELAXES GOVERNANCE**, and that is
 * `recordPayment`'s doing rather than this file's: the account checks the
 * proposal id, the payment window, approval AT THE VAULT'S THRESHOLD, that the
 * leaf is in the approved root and that it has not already been paid. **It has
 * never known what a payroll is** — the recipient is opaque bytes inside
 * `details` — so nothing about the kind of movement can reach it.
 *
 * ------------------------------------------------------------------------
 * **WHAT THIS RUN DOES TODAY: EVERYTHING THAT NEEDS NOTHING BUT DISK, AND THEN
 * IT STOPS.**
 *
 * It touches no network, starts no proof server, needs no wallet and spends
 * nothing. It builds the transfer, builds the payment the chain would be asked
 * to authorise, and checks it before a fee rather than after five proofs.
 *
 * **THE CHECK THAT USED TO STOP IT IS THE COLOUR, AND IT IS KEPT.** The token a
 * deposit puts into a vault is the ledger's `nativeToken().raw`; the token a
 * payment commits to comes from `transferFacts`, which asks `ledgerTokenOf`.
 * `payoutUnshielded` uses its `token` argument for both `unshieldedBalanceGte`
 * and `sendUnshielded`, so if the two ever disagree again the vault refuses the
 * payment after it has been proposed, approved twice and paid for. The two
 * values are compared here, on this machine, every run, for that reason.
 *
 * **A PASS HERE IS NOT A PAYMENT.** It says the payment this client would build
 * names the money the vault holds. Nothing has been proposed, approved or paid.
 *
 * ------------------------------------------------------------------------
 * **AND THE CHAIN HALF IS NOT WRITTEN, WHICH IS A POSITION RATHER THAN AN
 * OMISSION.** `V-174` carries both sides of it and marks neither correct.
 *
 * Three things it would need are not reachable from an instrument, and each is
 * named where a reader meets it rather than stubbed:
 *
 *   · **the account's payout seeds.** `buildRun` derives every leaf and every
 *     secret from the seed at the run's epoch, which lives in the account's
 *     sealed state and belongs to the company, not to this script.
 *   · **two signers who can approve.** An approval's witness is a signer's own
 *     secret key, which never leaves their device. That is the scheme, not a
 *     gap in it.
 *   · **the payroll roster**, which is what `transferOf` checks a public payee
 *     against. This instrument holds none — see `NO_ROSTER_HERE`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertVaultName, vaultRegistryFile, parseVaultRegistry, type VaultEntry, theVault,} from '../src/midnight/vault-record.js';
import { theNetwork } from '../src/midnight/network.js';
import { payeeOf, shortPayee, type Payee } from '../src/midnight/payee-address.js';
import { transferOf, transferFacts, entryKindOf, privacyOf } from '../src/core/movement.js';
import type { Hex } from '../src/core/crypto.js';
import { explainNodeError } from './node-errors.js';
import { serialiseWholeDetailed, describeDropped } from './error-report.js';
import { createScreen, phaseClock, describeError } from './deploy-report.js';

/* ------------------------------------------------------------------ */

const ROOT = process.cwd();
const STATE_DIR = join(ROOT, '.midnight');
const NETWORK = theNetwork();
const ACCOUNT_RECORD = join(STATE_DIR, `${NETWORK}-contract.json`);

const VAULT_NAME = (process.env.VAULT_NAME ?? '').trim();
const TRANSFER_TO = (process.env.TRANSFER_TO ?? '').trim();
const TRANSFER_AMOUNT = (process.env.TRANSFER_AMOUNT ?? '').trim();
const TRANSFER_REFERENCE = (process.env.TRANSFER_REFERENCE ?? '').trim();

/** The asset. One, today, and the door says so rather than offering a choice. */
const ASSET = 'NIGHT';

/**
 * **THIS INSTRUMENT HOLDS NO PAYROLL ROSTER, AND THE CHECK THAT NEEDS ONE IS
 * THEREFORE NOT MADE HERE.**
 *
 * `transferOf` refuses a PUBLIC transfer to an address that is on the payroll
 * roster, because no employee is ever disclosed publicly, and it takes the
 * roster as a required argument precisely so that a default cannot make the
 * check quietly stop happening.
 *
 * **An empty list is not a roster and this is not a default — it is a statement
 * that this instrument cannot make the check**, printed where the operator
 * reads it. The check belongs to the product, which holds the roster; this door
 * is for a company's own account address on a test network.
 *
 * `V-173` is the row.
 */
const NO_ROSTER_HERE: ReadonlyArray<Payee> = [];

/* ------------------------------------------------------------------ *
 * the report
 * ------------------------------------------------------------------ */

/** The vault's address, forbidden from every line from the moment it is read. */
let vaultAddress: string | null = null;

const say = createScreen(() => (vaultAddress
  ? [{ what: "the vault's address", value: vaultAddress }]
  : []));

const clock = phaseClock(say);
const note = (s: string) => say(`  ${s}`);
const good = (s: string) => say(`  \x1b[32m✓\x1b[0m ${s}`);
const stop = (s: string) => say(`  \x1b[33m■\x1b[0m ${s}`);

/* ------------------------------------------------------------------ *
 * what is decided before anything else
 * ------------------------------------------------------------------ */

/** The amount, in the asset's smallest unit. `fund-vault.ts`'s rule, and its reason. */
export function transferAmountFromText(text: string): bigint {
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    throw new Error(
      'no amount was given. TRANSFER-FROM-VAULT.command asks how much and passes the answer ' +
      'here.\nThere is deliberately no default: a default amount is a number nobody chose, ' +
      'moving money nobody decided to move.');
  }
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(
      `"${trimmed}" is not an amount this door will take. Digits and nothing else: no point, ` +
      'no separators, no sign.\nAMOUNTS HERE ARE IN THE SMALLEST UNIT, which is what the ' +
      'contract takes and what the chain publishes. Nothing here converts between units, ' +
      'because how many decimal places NIGHT has has never been measured against the chain ' +
      'by this project (V-169).');
  }
  const amount = BigInt(trimmed);
  if (amount <= 0n) throw new Error('a transfer has to move a positive amount');
  return amount;
}

/**
 * The address the money goes to, and it must be a PUBLIC one.
 *
 * A `shield-addr` is refused by name rather than accepted and paid privately:
 * this door pays out of a vault's PUBLIC balance through `payoutUnshielded`,
 * and a private payment is a different circuit, a different key space and a
 * different set of things that must be true (`V-94` — there is no private money
 * anywhere in this project to pay with).
 */
export function publicPayeeFromText(bech32: string): Payee {
  const payee = payeeOf(bech32, NETWORK as never);
  if (payee.kind === 'unshielded') return payee;
  throw new Error(
    'that is a private address, and this door pays out of a vault\'s public balance.\n' +
    'A private payment is a different circuit and there is no private money in this project ' +
    'to make one with (V-94). Give the public address of an account this company owns — the ' +
    'one that begins mn_addr_.');
}

/**
 * **THE ONE COMPARISON THIS DOOR EXISTS TO MAKE, AS A FUNCTION SO SOMETHING CAN
 * DRIVE IT.** `V-168`.
 *
 * A guard that lives inside `main()` is a guard nothing executes, and this one
 * is the only thing between an operator and five proofs spent discovering a
 * fact that is already written down. Exported, pure, and tested.
 */
export function assertColoursAgree(leafToken: string, ledgerToken: string): void {
  if (leafToken.toLowerCase() === ledgerToken.toLowerCase()) return;
  throw new Error(
    'THIS PAYMENT WOULD BE REFUSED BY THE VAULT, AND IT IS REFUSED HERE INSTEAD.\n\n' +
    'The two colours above are the same thing said by two parts of this system, and they do ' +
    'not agree. The colour a deposit puts into a vault is the ledger\'s own token type for ' +
    'NIGHT. The colour above it is the one this payment would commit to. `payoutUnshielded` ' +
    'uses that one argument for both the balance question and the send, so it would ask a vault ' +
    'that holds one colour to pay out of another.\n\n' +
    'NOTHING IS AT RISK AND NOTHING IS LOST. The vault\'s money is on chain in a balance ' +
    'anybody can read, and it becomes payable the moment the client and the ledger agree. The ' +
    'vault cannot be retired while it holds the colour either.\n\n' +
    'IT IS REFUSED BEFORE A FEE DELIBERATELY. The circuit\'s own assert would catch this after ' +
    'a proposal had been raised, approved twice and paid for.\n\n' +
    'A transfer\'s asset code becomes a ledger token in `ledgerTokenOf` in ' +
    'src/core/assets.ts, and `transferFacts` in src/core/movement.ts is what calls it. A ' +
    'disagreement here means one of those two has changed. Do not fix it by changing ' +
    '`assetIdBytes`: that is what the account\'s balance map is keyed by, and repointing it ' +
    'would move every balance to a new key.');
}

/** The company's vaults on this network, or a refusal — never a guess. */
function vaultFromRegistry(name: string): VaultEntry {
  const file = vaultRegistryFile(STATE_DIR, NETWORK);
  if (!existsSync(file)) {
    throw new Error(
      `no vault has ever been deployed on ${NETWORK}: ${file.replace(ROOT + '/', '')} does not ` +
      'exist. DEPLOY-VAULT.command is what creates one.');
  }
  const registry = parseVaultRegistry(JSON.parse(readFileSync(file, 'utf8')), NETWORK);
  /*
   * **THE NAME BECOMES A VAULT IN ONE PLACE, AND A RETIRED VAULT IS REFUSED
   * THERE.** Every door needs an address and the record is the only place an
   * address is, so the lookup is the thing every path has in common -- which is
   * why the refusal lives inside it rather than being remembered here.
   */
  return theVault(registry, name);
}

/** The vault must carry the circuit this door would call. The early check. */
export function assertVaultCanPayPublicly(entry: VaultEntry): void {
  const circuits = Array.isArray(entry.circuits) ? entry.circuits : [];
  if (circuits.includes('payoutUnshielded')) return;
  throw new Error(
    `the record for the vault "${entry.name}" does not list \`payoutUnshielded\`, so this vault ` +
    'cannot make a public payment.\n' +
    `  it has: ${circuits.length ? circuits.join(', ') : '(none recorded)'}\n` +
    'A vault deployed before the public path existed carries four circuits, and its state does ' +
    'not decode against the compiled reader either. DEPLOY-VAULT.command deploys one that ' +
    'carries all seven.');
}

/** `C266`, the same comparison `fund-vault.ts` makes and for the same reason. */
export function assertVaultIsMarriedToTheDeployedAccount(entry: VaultEntry): void {
  if (!existsSync(ACCOUNT_RECORD)) {
    throw new Error(
      `no account is deployed on ${NETWORK}: ${ACCOUNT_RECORD.replace(ROOT + '/', '')} does not ` +
      'exist.\nEvery payment out of a vault is the vault calling its account across the ' +
      'contract boundary, so there is nothing here that could authorise one. ' +
      'DEPLOY-PREVIEW.command deploys it.');
  }
  const record = JSON.parse(readFileSync(ACCOUNT_RECORD, 'utf8'));
  const deployed = String(record?.contractAddress ?? '').trim().toLowerCase();
  const pinned = String(entry.accountAddress ?? '').trim().toLowerCase();
  if (deployed && pinned && deployed === pinned) return;
  throw new Error(
    `the vault "${entry.name}" is married to an account that is not the one deployed on ` +
    `${NETWORK}.\nA vault pins its account at construction and can never be redirected (V-37), ` +
    'and the account\'s own deploy overwrites its record without comparing them (C266). Every ' +
    'payment is a cross-contract call to the account this vault was built against, so this ' +
    'payment would be authorised by a contract this company no longer uses.\n' +
    'NEITHER ADDRESS IS PRINTED HERE (C236).');
}

/* ------------------------------------------------------------------ *
 * the run
 * ------------------------------------------------------------------ */

async function main() {
  say('────────────────────────────────────────────────────────────');
  say(`  A transfer out of a vault on ${NETWORK}`);
  say('────────────────────────────────────────────────────────────');
  say();
  say('  NOTHING IS SUBMITTED, PROVED OR SPENT BY THIS RUN. It reads two local');
  say('  records, builds the payment the chain would be asked to authorise, and');
  say('  stops at the first thing that is missing.');

  /* -------------------------------------------------- 1 */
  clock.begin(1, 4, 'Which vault, and whether it can pay at all');

  if (!VAULT_NAME) {
    throw new Error(
      'no vault name was given. TRANSFER-FROM-VAULT.command asks which vault and passes the ' +
      'answer here. There is deliberately no default.');
  }
  assertVaultName(VAULT_NAME);
  const entry = vaultFromRegistry(VAULT_NAME);
  vaultAddress = entry.contractAddress;
  good(`vault "${VAULT_NAME}", deployed ${entry.deployedAt}`);
  note('  its address is NOT printed, here or anywhere — C236');

  assertVaultCanPayPublicly(entry);
  good('the record says this vault carries payoutUnshielded');
  assertVaultIsMarriedToTheDeployedAccount(entry);
  good('this vault is married to the account that is deployed on this network — C266');

  /* -------------------------------------------------- 2 */
  clock.begin(2, 4, 'Who is paid, how much, and what the company is calling it');

  const payee = publicPayeeFromText(TRANSFER_TO);
  good(`paying ${shortPayee(payee)} — a public address on ${NETWORK}`);
  note('  A PUBLIC PAYMENT PUTS THE ADDRESS AND THE AMOUNT ON A RECORD ANYONE CAN READ.');
  note('  That is the whole reason this is a transfer and not a payroll run: a company can');
  note('  choose it for its own money, and an employee is never asked to.');

  const amount = transferAmountFromText(TRANSFER_AMOUNT);
  good(`${amount.toLocaleString()} of ${ASSET}, in ${ASSET}'s smallest unit`);

  if (!TRANSFER_REFERENCE) {
    throw new Error(
      'this transfer has no reference. Give it one, so it can be recognised later: a payment ' +
      'in a company\'s records with no name on it is the one an auditor asks about.');
  }

  say();
  say('  \x1b[33mTHE ROSTER CHECK THIS INSTRUMENT CANNOT MAKE\x1b[0m');
  say('    A public transfer is refused when it is addressed to somebody on the payroll');
  say('    roster, because no employee is ever disclosed publicly. That check needs the');
  say('    roster, the roster lives in the product, and this instrument holds none.');
  say('    SO IT IS NOT MADE HERE. This door is for a company\'s own account address on a');
  say('    test network, and the operator is what stands in for the check. V-173.');
  say();

  const transfer = transferOf({
    accountId: `vault:${VAULT_NAME}`,
    payee,
    asset: ASSET,
    amount,
    /*
     * READ OFF THE ADDRESS AND THEN PASSED BACK IN, so `transferOf`'s own
     * refusal still fires if the two ever disagree. It cannot here — both come
     * from the same decode — and the check is kept rather than skipped because
     * the failure it catches is a person believing they chose private while the
     * money settles in public.
     */
    privacy: privacyOf(payee),
    reference: TRANSFER_REFERENCE,
    createdBy: 'the operator at TRANSFER-FROM-VAULT.command',
    employees: NO_ROSTER_HERE,
  });
  good(`transfer ${transfer.id} built through transferOf, the one door a transfer is made at`);
  note(`  it will be filed as a "${entryKindOf(transfer.movement)}", never as a payroll line`);
  note(`  reference: ${transfer.reference}`);
  note('  its approval round is null until one is raised — a transfer cannot be minted already');
  note('  naming somebody else\'s approved round');
  note('  \x1b[33mAND IT IS NOT SAVED ANYWHERE.\x1b[0m This door persists nothing. That identifier');
  note('  belongs to this run and will never be seen again; a second run of the same intent');
  note('  prints a different one. Do not write it down as a reference for anything.');

  /* -------------------------------------------------- 3 */
  clock.begin(3, 4, 'The colour this payment would move, against the colour the vault holds');

  const facts = transferFacts(transfer);
  const { nativeToken } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
  const held = (nativeToken() as any).raw as Hex;

  note(`the leaf would commit to  ${facts.token}`);
  note(`a deposit puts in         ${held}`);

  assertColoursAgree(facts.token, held);

  good('the colour this payment would move is the colour a deposit puts in');

  /* -------------------------------------------------- 4 */
  clock.begin(4, 4, 'What the chain would be asked to do, and what is not here to ask it');

  say();
  say('  \x1b[33mAND THE FEE FOR ALL OF IT COMES FROM OUTSIDE THE VAULT\x1b[0m');
  say('    Fees are paid out of what NIGHT earns while a wallet holds it, and NIGHT stops');
  say('    earning the moment it goes into a vault. So the proposal, both approvals and the');
  say('    payment itself are paid for by the wallet, out of what the NIGHT still in the');
  say('    wallet has earned. A company with everything in the vault cannot pay for any of');
  say('    it, and nothing it holds can restore that on its own. V-171.');
  say();
  say('  \x1b[1mTHE SEQUENCE THIS PAYMENT GOES THROUGH, AND NOTHING ABOUT IT IS RELAXED\x1b[0m');
  say('    1. propose      the run, on the ACCOUNT: a root over one leaf, one payee, and the');
  say('                    window it may be paid between.');
  say('    2. approve      by one signer, then by a second. AT THE VAULT\'S THRESHOLD, which');
  say('                    the account holds per vault, not at the account\'s own.');
  say('    3. payoutUnshielded  on the VAULT, which calls the account\'s recordPayment across');
  say('                    the contract boundary: the proposal id, the window, the approval');
  say('                    count, that the leaf is in the approved root, and that it has not');
  say('                    already been paid.');
  say('    THE ACCOUNT NEVER LEARNS THIS IS A TRANSFER. The recipient is opaque bytes inside');
  say('    the leaf, so nothing about the kind of movement can reach the rules.');
  say();

  stop('THREE THINGS THIS INSTRUMENT DOES NOT HOLD, AND WILL NOT INVENT');
  say('    THE ACCOUNT\'S PAYOUT SEEDS. Every leaf and every secret of a run is derived from');
  say('    the seed at the run\'s epoch, which lives in the account\'s sealed state. A run');
  say('    built from a seed this script made up would produce a root no signer can rebuild');
  say('    and a payment nothing can match.');
  say();
  say('    TWO SIGNERS WHO CAN APPROVE. An approval\'s witness is a signer\'s own secret key,');
  say('    and it never leaves their device. That is the scheme rather than a gap in it, and');
  say('    it is why no script can approve on anybody\'s behalf.');
  say();
  say('    A PAYROLL ROSTER, for the check named above.');
  say();
  say('  Nothing was submitted, proved or spent.');
}

/* ------------------------------------------------------------------ *
 * the refusal
 * ------------------------------------------------------------------ */

function fail(e: any): never {
  const redact = (text: string): string => (vaultAddress
    ? text.split(vaultAddress).join('[the vault\x27s address, withheld — C236]')
    : text);
  const out = (text: string) => console.log(redact(text));

  out('');
  out(`\x1b[31m\x1b[1m  Stopped during: ${clock.stage}\x1b[0m`);
  out(describeError(e, explainNodeError).split('\n').map((l) => '  ' + l).join('\n'));

  clock.print('stopped');

  console.log();
  console.log('  \x1b[1mThe error object, whole — bounded, and it says what it dropped\x1b[0m');
  const serialised = serialiseWholeDetailed(e);
  out(serialised.text.split('\n').map((l) => '    ' + l).join('\n'));
  console.log();
  for (const line of describeDropped(serialised.dropped)) console.log(`    ${line}`);

  console.log();
  console.log('  \x1b[1mNothing was submitted, proved or spent.\x1b[0m This door reaches no network.');
  process.exit(1);
}

/** Guarded, so a test can import the checks without the run happening. */
const RUN_DIRECTLY = typeof process.argv[1] === 'string'
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (RUN_DIRECTLY) main().then(() => process.exit(0), fail);

/* ------------------------------------------------------------------ *
 * THE `.command` THIS NEEDS, NAMED AND WRITTEN BESIDE IT
 * ------------------------------------------------------------------ */

/*
 * **`TRANSFER-FROM-VAULT.command`.**
 *
 * WHAT IT PASSES:
 *
 *     MIDNIGHT_NETWORK_ID   ACCEPTED AND NEVER DECIDING. The network is the one
 *                           this build is compiled for; naming a different one
 *                           here is refused, and naming none is the ordinary case.
 *     VAULT_NAME            the vault, by name. NO DEFAULT.
 *     TRANSFER_TO           the public address the company owns. NO DEFAULT.
 *     TRANSFER_AMOUNT       digits, in the asset's smallest unit. NO DEFAULT.
 *     TRANSFER_REFERENCE    what the company calls this payment. NO DEFAULT.
 *
 * WHAT IT REFUSES BEFORE RUNNING ANYTHING: a missing or malformed vault name, a
 * missing address, an amount that is not digits, an empty reference.
 *
 * WHAT IT MUST NOT DO: start a proof server, touch Docker, or print an address
 * out of the registry. **This door reaches no network at all today**, and its
 * report says so rather than leaving a reader to assume a refusal was a
 * network failure.
 *
 * ITS REPORT: `REPORT-TRANSFER-FROM-VAULT.txt`, ANSI stripped.
 */
