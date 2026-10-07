/**
 * **THE COMPANY STATE IS BELIEVED FROM THE SEAT THE ACCOUNT'S DEPLOY SEATED,
 * WHOEVER HOLDS THE ACCOUNT LATER.**
 *
 * The account here is the compiled account, run by the simulator with every
 * assert live: founded by F, seated with B and C, then F removed and D put into
 * the slot F left - the first slot. What the person's wallet reads is read by
 * the wallet's own reader over that account's state now and its deploy; the
 * run is read for approval by the page's own reader, and the approval is
 * checked by the worker's own check against the account's ledger as it is.
 *
 * **WHAT THIS DOES NOT SHOW:** no proof is made and no indexer or network is
 * reached. The first three cases give the directory as a device would hold it
 * once replayed; the last replays it from the seats' own filings, on this
 * server against its own read of the account and on the device against its
 * wallet's, over one state of the account.
 */
import { describe, expect, it } from 'vitest';
import {
  createConstructorContext, ContractMaintenanceAuthority as RuntimeMaintenanceAuthority, ContractState as RuntimeContractState,
} from '@midnight-ntwrk/compact-runtime';
import { ContractMaintenanceAuthority, ContractState } from '@midnightntwrk/ledger-v9';
import { schnorr } from '@noble/curves/secp256k1.js';
import { Contract, pureCircuits } from '../../contracts/managed/contract/index.js';
import { witnesses } from '../../contracts/src/witnesses.js';
import { AccountSimulator, COMPANY_LABEL, change, leafOfDevice, privateStateFor } from '../../contracts/test/simulator.js';
import { companyLabelOf, type AccountAddress } from 'midnight-identity/profile/company-label';
import { holdersOnChain } from '../../apps/wallet/src/chain/company-label-on-chain.js';
import { runRebuiltHere, RunNotReadHere, type CompanyRecordsHere } from '../../packages/web-shared/src/run-rebuilt-here.js';
import { refuseWhatThisDeviceDidNotMake, type AccountLedgerView } from '../../packages/web-shared/src/what-this-device-made.js';
import { directoryHere, foundingSeatHere, type DirectoryHere } from '../../packages/web-shared/src/vault-page-doors.js';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry } from 'midnight-identity/profile/records-key';
import { ledger as readAccountLedger } from '../../contracts/managed/contract/index.js';
import { MemoryStore } from '../core/store.js';
import type { SealedAccount } from '../core/types.js';
import type { DirectoryFiling } from '../midnight/seat-directory.js';
import { directoryChainFromTheContract, directoryOf, type AccountHolds } from './seat-directory-route.js';
import { fromHex, newSigningKeypair, newSymmetricKey, newWrappingKeypair, toHex, type Hex } from '../core/crypto.js';
import { sealRecord } from '../core/sealed-records.js';
import { signRunFiling } from '../core/run-filing.js';
import { newStateBlinding, sealState } from '../core/account.js';
import { openStateRecord, signedFoundingState } from '../core/founding-state.js';
import { runLegOf } from '../core/run-legs.js';
import { signCompanyFiling } from '../midnight/sealed-record-wire.js';
import { buildRun } from '../midnight/payout-tree.js';
import { sealPayKeyTo } from '../midnight/run-keys.js';
import { payKeyCommitmentOf, payKeyPayloadOf } from '../midnight/pay-key-commitment.js';
import type { PayrollRun, RosterEmployee, SealedRun } from '../core/types.js';
import { payeeFor } from '../testing/payees.js';
import { vaultDetails } from '../testing/vault-details.js';
import { TEST_TOKEN, registryWithTestPrivateForms } from '../testing/assets.js';

const [F, B, C, D] = [privateStateFor(1), privateStateFor(2), privateStateFor(3), privateStateFor(4)];
const ACCOUNT = 'dbe119a304f8e7ea882353435c1d536cf2faf4298236a9aae77670e750af65c8' as AccountAddress;
const LABEL = companyLabelOf(COMPANY_LABEL);
const CO = 'acc_founded';
const KEY = newSymmetricKey();
const NOW = 1_800_000_000;
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);
const VAULT = new Uint8Array(32).fill(0xa1);
const LEG = runLegOf(TEST_TOKEN, 'shielded');
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const bytesOf = (s: { serialize(): Uint8Array }): string => hex(s.serialize());

/* Each seat's own filing key, as its wallet signed it into the company's directory. */
const signing = { F: newSigningKeypair(), B: newSigningKeypair(), C: newSigningKeypair(), D: newSigningKeypair() };
const blinding = newStateBlinding();
const STATE = signedFoundingState(CO, sealState({ entries: [] }, blinding, KEY, 0), signing.F.secret);
const PAY_KEY = openStateRecord(STATE, KEY).blinding.payRecordKey as Hex;

const person = (id: string, n: string): RosterEmployee => ({
  id, accountId: CO, name: `Person ${id}`, status: 'active', address: payeeFor(n.repeat(32), 'undeployed'),
} as unknown as RosterEmployee);
const PEOPLE = [person('p1', 'a1'), person('p2', 'a2')];

const sealedRun = (): SealedRun => {
  const run = {
    id: 'run_bbbbbbbbbbb1', accountId: CO, period: '2026-09', status: 'proposed',
    employees: PEOPLE.map((p, i) => ({ id: p.id, name: p.name, wrappingPublicKey: null, asset: TEST_TOKEN, amount: BigInt(100 + i), form: 'shielded' })),
    totals: {}, proposalIds: { [LEG]: 'prp_1' }, skips: undefined, repeats: undefined,
    payout: { [LEG]: {
      root: '00'.repeat(32), payees: 2n, opensAt: OPENS, closesAt: CLOSES, vault: hex(VAULT), required: 0n,
      leaves: [], facts: [], runId: `run_bbbbbbbbbbb1:${LEG}`, epoch: 0,
    } },
  } as unknown as PayrollRun;
  const { employees, totals, proposalIds, payout, skips, repeats } = run;
  /* Filed by B's seat, which holds the account throughout. */
  return signRunFiling(CO, {
    id: run.id, accountId: CO, period: run.period, status: run.status, payslips: [], keyEpoch: 0, proposalIds: ['prp_1'],
    sealed: sealRecord('payroll', CO, { employees, totals, proposalIds, payout, skips, repeats }, KEY),
  } as never, signing.B.secret) as unknown as SealedRun;
};

/** A proposal over `payload` raised by `by` and approved by `approvers`, with the device that carries its salt. */
const approved = async (sim: AccountSimulator, by: typeof F, payload: Uint8Array, seed: number, approvers: Array<typeof F>) => {
  const c = change(0n, seed);
  await sim.as(sim.applying(by, c)).propose(payload);
  const id = sim.proposalId(payload, c.salt);
  for (const a of approvers) await sim.as(a).approve(id);
  return { id, by: sim.applying(by, c) };
};

/**
 * The account founded by F with B and C, the pay-record key committed, then F
 * removed by two of three and D seated in the slot F left by the two left.
 */
const founderReplaced = async (): Promise<AccountSimulator> => {
  const sim = await AccountSimulator.liveAccount([F, B, C], 2n);
  sim.at(NOW);
  const commitment = fromHex(payKeyCommitmentOf(PAY_KEY));
  const round = await approved(sim, F, fromHex(payKeyPayloadOf(toHex(commitment))), 601, [F, B]);
  await sim.as(round.by).sealPayKey(sealPayKeyTo(PAY_KEY, newWrappingKeypair().publicKey).map(fromHex), commitment, round.id);
  await sim.adoptVault(VAULT, [F, B], 602);
  const removal = await approved(sim, F, pureCircuits.removeSignerPayload(sim.leafOf(F)), 611, [F, B]);
  await sim.as(removal.by).removeSigner(sim.leafOf(F), removal.id);
  const seating = await approved(sim, B, pureCircuits.signerAddPayload(sim.leafOf(D)), 612, [B, C]);
  await sim.as(seating.by).addSigner(sim.leafOf(D), seating.id, true);
  return sim;
};

/* Each seat's committee key, as the chain lists it; F's is the one the account's deploy was held by. */
const committeeOf = (n: number) => ({ tag: 'schnorr', value: Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(n))).toString('hex') });
const COMMITTEES = { F: committeeOf(51), B: committeeOf(52), C: committeeOf(53), D: committeeOf(54) };

/** The state F's deploy left: the account's constructor over F's one seat and the company's label, held by F's committee key alone. */
const deployOf = async (): Promise<string> => {
  const made = (await new Contract(witnesses).initialState(
    createConstructorContext(F, '0'.repeat(64)), leafOfDevice(F), COMPANY_LABEL)).currentContractState as { serialize(): Uint8Array };
  const state = ContractState.deserialize(made.serialize());
  state.maintenanceAuthority = new ContractMaintenanceAuthority([COMMITTEES.F] as never, 1, 0n);
  return hex(state.serialize());
};

/**
 * The directory as a device holds it: every seat's entry, the founding signer's kept after it left, and what the wallet
 * read. `forged` puts an entry for F's seat under another committee key in place of F's own.
 */
const directory = (sim: AccountSimulator, holders: DirectoryHere['holders'], forged = false): DirectoryHere => ({
  dir: { company: CO, version: 4, seats: ([['F', F], ['B', B], ['C', C], ['D', D]] as const).map(([n, d], i) => ({
    seat: hex(sim.leafOf(d)), person: n, signingKey: signing[n].publicKey, wrappingKey: `${i + 1}b`.repeat(32) as Hex,
    committeeKey: forged && n === 'F' ? committeeOf(59) : COMMITTEES[n], role: 'admin' as const, retired: null,
  })) },
  /* B's committee key is on the committee as B's own seating put it there: B files the company's runs. */
  holders: { ...holders, committee: [...holders.committee, COMMITTEES.B] }, another: new Set(),
});

const recordsOver = (here: DirectoryHere, state: unknown): CompanyRecordsHere => ({
  directory: async () => here,
  people: async () => ({ people: PEOPLE.map((p) => ({ person: p, version: 1, handedOver: true })), notBelieved: [], notPayable: [] }),
  state: async (id) => (id === '0' ? state as never : null),
  runs: async () => [sealedRun()],
  registry: registryWithTestPrivateForms(),
});

const gateDeps = {
  runPayload: pureCircuits.runPayload, vaultDetails,
  payKeyCommitmentOf: pureCircuits.payKeyCommitmentOf, payKeyCommitmentKey: pureCircuits.payKeyCommitmentKey,
};

describe('THE FOUNDING SEAT IS THE DEPLOY\'S, WHOEVER HOLDS THE FIRST SLOT LATER', () => {
  it('A FOUNDER REMOVED AND A NEW SEAT IN THE FIRST SLOT LEAVE A RUN\'S APPROVAL WORKING', async () => {
    const sim = await founderReplaced();
    /* The chain as it is: F holds nothing, D holds the first slot. */
    expect(sim.slotOf(D)).toBe(0n);
    expect(sim.ledger.signers.findPathForLeaf(sim.leafOf(F))).toBeUndefined();
    const read = await holdersOnChain(ACCOUNT, LABEL, async () => bytesOf(sim.contractStateForCall as never), deployOf);
    if (read.of !== 'read') throw new Error(`the wallet did not read the account: ${JSON.stringify(read)}`);
    const here = directory(sim, { ...read.holders, account: ACCOUNT });

    /* RED WHEN: the first state is believed only while its signer holds the account, or from whoever holds the first slot. */
    const made = await runRebuiltHere(recordsOver(here, STATE), CO, 'prp_1', KEY);
    expect(made.payKey).toBe(PAY_KEY);

    /* The run raised as the device rebuilt it, held open by the chain, approved by D in the founding signer's slot. */
    const built = buildRun([...made.seeds], made.identity, [...made.facts], vaultDetails, { key: made.payKey as Hex, records: [...made.records] }, made.asset);
    const payload = pureCircuits.runPayload(fromHex(built.tree.root), built.tree.payees, OPENS, CLOSES, 0n);
    const c = change(0n, 621);
    await sim.as(sim.applying(B, c)).proposeRun({ root: fromHex(built.tree.root), payees: built.tree.payees, from: OPENS, until: CLOSES, vault: VAULT });
    const id = hex(sim.proposalId(payload, c.salt, VAULT));
    /* RED WHEN: the worker's check refuses, after the founding signer left, the run this device made again. */
    expect(() => refuseWhatThisDeviceDidNotMake(gateDeps, { chainId: id, digest: hex(payload), made }, sim.ledger as unknown as AccountLedgerView))
      .not.toThrow();
    await sim.as(D).approve(fromHex(id));
    expect(sim.ledger.approvalCounts.lookup(fromHex(id))).toBe(1n);
  });

  it('A STATE SIGNED BY THE SEAT IN THE FIRST SLOT NOW IS REFUSED', async () => {
    const sim = await founderReplaced();
    const read = await holdersOnChain(ACCOUNT, LABEL, async () => bytesOf(sim.contractStateForCall as never), deployOf);
    if (read.of !== 'read') throw new Error('the wallet did not read the account');
    const { filedBy: _f, ...unsigned } = STATE;
    /* D holds the first slot and the account: a first state it signed is the one a slot-0 anchor would have believed. */
    const byD = signCompanyFiling(unsigned, signing.D.secret);
    /* RED WHEN: the seat holding the first slot now makes a first state believed. */
    await expect(runRebuiltHere(recordsOver(directory(sim, { ...read.holders, account: ACCOUNT }), byD), CO, 'prp_1', KEY))
      .rejects.toThrow(RunNotReadHere);
    await expect(runRebuiltHere(recordsOver(directory(sim, { ...read.holders, account: ACCOUNT }), byD), CO, 'prp_1', KEY))
      .rejects.toThrow(/signed by a seat other than the founding signer's/);
  });

  it('AN ENTRY FOR THE FOUNDING SEAT UNDER ANY COMMITTEE KEY BUT THE ONE THE DEPLOY WAS HELD BY DOES NOT SPEAK FOR IT', async () => {
    const sim = await founderReplaced();
    const read = await holdersOnChain(ACCOUNT, LABEL, async () => bytesOf(sim.contractStateForCall as never), deployOf);
    if (read.of !== 'read') throw new Error('the wallet did not read the account');
    /* RED WHEN: whoever files a claim for the founding seat first, under a key they made, makes a first state they signed believed. */
    await expect(runRebuiltHere(recordsOver(directory(sim, { ...read.holders, account: ACCOUNT }, true), STATE), CO, 'prp_1', KEY))
      .rejects.toThrow(/not signed by the committee key the company's account was deployed with/);
  });
});

describe('THE DIRECTORY REPLAYED FROM THE SEATS\' FILINGS NAMES THE FOUNDING SIGNER AT THE LEAF THE ACCOUNT\'S DEPLOY SEATED', () => {
  /* Each seat's wallet, and the committee key it holds the account by for this company. */
  const wallets = { F: identityFromSecret(new Uint8Array(32).fill(81)), B: identityFromSecret(new Uint8Array(32).fill(82)), C: identityFromSecret(new Uint8Array(32).fill(83)) };
  const committee = (n: keyof typeof wallets) => committeeKeyFor(wallets[n], LABEL) as { tag: string; value: string };

  /** One state of the account, as the chain's indexer serves it: the simulator's account, held by its three seats' committee keys. */
  const served = (sim: AccountSimulator) => {
    const state = RuntimeContractState.deserialize((sim.contractStateForCall as { serialize(): Uint8Array }).serialize());
    state.maintenanceAuthority = new RuntimeMaintenanceAuthority([committee('F'), committee('B'), committee('C')] as never, 2, 0n);
    return state;
  };
  /** The state F's deploy left, held by F's committee key alone. */
  const deployed = async (): Promise<string> => {
    const made = (await new Contract(witnesses).initialState(
      createConstructorContext(F, '0'.repeat(64)), leafOfDevice(F), COMPANY_LABEL)).currentContractState as { serialize(): Uint8Array };
    const state = ContractState.deserialize(made.serialize());
    state.maintenanceAuthority = new ContractMaintenanceAuthority([committee('F')] as never, 1, 0n);
    return hex(state.serialize());
  };

  it('THIS SERVER\'S OWN READ OF THE ACCOUNT KEEPS EACH SEAT\'S CLAIM, AND THE DEVICE BELIEVES THE FIRST STATE FROM THE SAME LEAF', async () => {
    const sim = await AccountSimulator.liveAccount([F, B, C], 2n);
    sim.at(NOW);
    const store = new MemoryStore();
    store.putAccount({
      id: CO, createdAt: 'now', keyEpoch: 0, threshold: 2, signerCount: 3, memberUserIds: ['f', 'b', 'c'], pendingSigners: [], wrappedKeys: [],
      inboxPublicKey: '00'.repeat(32), sealedPolicy: { iv: '', tag: '', body: '' }, companyLabel: LABEL as never, contractAddress: ACCOUNT,
    } as unknown as SealedAccount);
    /* Each seat's own wallet signs its claim to the leaf the chain holds for it. */
    ([['F', F], ['B', B], ['C', C]] as const).forEach(([n, device], i) => {
      const filing: DirectoryFiling = { company: CO, version: i + 1, change: { kind: 'claim', entry: {
        person: n.toLowerCase(), committeeKey: committee(n),
        statement: signDirectoryEntry(wallets[n], LABEL, ACCOUNT, new Uint8Array(32).fill(90 + i), signing[n].publicKey, hex(sim.leafOf(device))),
      } } } as DirectoryFiling;
      expect(store.fileDirectory(CO, filing)).toBe(true);
    });

    /* This server's own read, over the account's state as the indexer serves it: what the server's check S is made against. */
    const asked: string[] = [];
    const chain = directoryChainFromTheContract({
      addressOf: async (id) => (id === CO ? ACCOUNT : null),
      contractState: async (address) => { asked.push(address); return served(sim); },
      readLedger: (data) => readAccountLedger(data as never) as unknown as AccountHolds,
    });
    const now = await directoryOf(store, chain, CO);
    /* RED WHEN: the server's read names a committee other than the one the account's state is held by. */
    expect(now.chain?.seats.committee).toEqual([committee('F'), committee('B'), committee('C')].map((k) => ({ tag: k.tag, value: k.value.toLowerCase() })));
    expect(now.chain?.seats.threshold).toBe(2);
    expect(now.chain?.approvals).toBe(2);
    expect(asked).toEqual([ACCOUNT]);
    /* RED WHEN: the server's read does not hold the seats the account's signers' set holds, so it keeps no claim at all. */
    const atF = now.dir.seats.find((x) => x.person === 'f');
    expect(atF?.seat).toBe(hex(sim.leafOf(F)));
    expect(now.dir.seats.map((x) => x.person).sort()).toEqual(['b', 'c', 'f']);
    /* A seat the account does not hold is not kept: RED WHEN the read answers for every seat asked about. */
    expect((await chain(CO, ['77'.repeat(32), hex(sim.leafOf(B))]))?.seats.seats).toEqual([hex(sim.leafOf(B))]);

    /* The device: the same filings replayed against its wallet's read of the same state, and the deploy. */
    const read = await holdersOnChain(ACCOUNT, LABEL, async () => hex(served(sim).serialize()), deployed);
    if (read.of !== 'read') throw new Error(`the wallet did not read the account: ${JSON.stringify(read)}`);
    const here = await directoryHere({
      accountId: CO, label: LABEL, filings: async () => store.directoryFilingsOf(CO),
      holders: async () => ({ ...read.holders, account: ACCOUNT }), attested: async () => [],
    });
    const founding = foundingSeatHere(here);
    /* RED WHEN: the seat the device takes the first state from is not the leaf the deploy seated, which the server keeps the founding signer's claim at. */
    expect(typeof founding === 'string' ? founding : founding.seat).toBe(hex(sim.leafOf(F)));
    expect(typeof founding === 'string' ? founding : founding.signingKey).toBe(signing.F.publicKey);
    expect(atF?.signingKey).toBe(signing.F.publicKey);
    /* And the first state F's seat signed is the one read: its pay-record key is the company's. */
    const records: CompanyRecordsHere = { ...recordsOver(here, STATE), runs: async () => [] };
    await expect(runRebuiltHere(records, CO, 'prp_1', KEY)).rejects.toThrow(/No payroll run of this company raised this proposal/);
    const { signedStateHere } = await import('../../packages/web-shared/src/run-rebuilt-here.js');
    expect((await signedStateHere(recordsOver(here, STATE), CO, KEY)).payKey).toBe(PAY_KEY);

    /* RED WHEN: a state that will not open with this device's key is read as if it had opened. */
    await expect(signedStateHere(recordsOver(here, STATE), CO, newSymmetricKey()))
      .rejects.toThrow(/cannot open the company's state with the key it holds/);
    /* RED WHEN: a first state F's seat signed with no pay-record key in it gives nonces made with no key. */
    const keyless = signedFoundingState(CO, sealState({ entries: [] }, { ...blinding, payRecordKey: undefined } as never, KEY, 0), signing.F.secret);
    await expect(signedStateHere(recordsOver(here, keyless), CO, KEY)).rejects.toThrow(/carries no pay-record key/);
  });
});
