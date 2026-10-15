import { describe, it, expect } from 'vitest';
import * as L from '@midnightntwrk/ledger-v9';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { identityFromWords, newWords } from 'midnight-identity';
import { committeeKeyFor, committeeSigningKeyFor } from 'midnight-identity/profile/committee-key';
import {
  committeeJoinFor, committeeSignaturesFor, joinedBy, superAdminChangeBytes, SUPER_ADMIN_CHANGE_TAG, type ChainRead,
} from 'midnight-identity/profile/committee-sign';
import { parseAsk, REQUEST_SCHEMA, type CommitteeRequest, type SuperAdminChangeOnTheWire } from 'midnight-identity/profile/request';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';
import {
  approveFromAFile, fileCheckedAgainstTheChain, joinFromAFile, joiningKeys, PROPOSAL_FILE_FORMAT, proposalFileRead, proposalFileText, raiseFromTheChain,
  resumeFromAFile, signatureListRefusal,
  type FromTheChainDoors, type JoiningSignature, type ProposalFile, type SuperAdminChangeApproved,
  type SuperAdminChangeProgress, type SuperAdminChangeRaised, type SuperAdminContractStanding, type SuperAdminDoors,
  type SuperAdminSignature, type SuperAdminsAskedFor,
} from './governance-from-the-chain.js';
import { governancePayloadOf } from './governed-call-builder.js';
import { EVERY_SUPER_ADMIN_NEEDED, ONE_SUPER_ADMIN_LEFT, type SuperAdminShown } from './committee-here.js';

/*
 * A change of the company's super admins, carried from one device to the next
 * as a file: raised by a super admin, signed by every key it adds with that
 * key, approved by each super admin's wallet in one press, and sent - the
 * account first - once every contract's update has its committee's threshold.
 * The chain here is a map of contract states served as the person's own
 * wallet's indexer serves them; the wallets are real wallets' own presses; the
 * company's service only sends, and here applies an update only when the
 * signatures on it verify under that contract's committee, as the chain does.
 */
const LABEL = `co_${'c1'.repeat(32)}` as CompanyLabel;
const ACCOUNT = 'a0'.repeat(32);
const ADOPTED = 'b1'.repeat(32);
const RETIRED = 'b2'.repeat(32);
const CREATED = 'b3'.repeat(32);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

type Key = { tag: string; value: string };
const person = () => identityFromWords(newWords().join(' '));
const alice = person();
const bob = person();
const carol = person();
const olga = person();
const stranger = person();
const keyOf = (who: ReturnType<typeof person>): Key => {
  const k = committeeKeyFor(who, LABEL) as unknown as Key;
  return { tag: k.tag, value: k.value.toLowerCase() };
};
const [A, B, C, O, S] = [alice, bob, carol, olga, stranger].map(keyOf) as [Key, Key, Key, Key, Key];

interface Contract { committee: Key[]; threshold: number; counter: bigint; view?: Record<string, unknown> }

/** The company on the chain: Alice and Bob hold the account and two vaults at two; a vault it created is still held by Olga alone. */
const companyOnChain = (): Record<string, Contract> => ({
  [ACCOUNT]: { committee: [A, B], threshold: 2, counter: 3n, view: { vaults: [bytes(ADOPTED)], retiredAt: [[bytes(RETIRED), 1n]] } },
  [ADOPTED]: { committee: [A, B], threshold: 2, counter: 1n },
  [RETIRED]: { committee: [A, B], threshold: 2, counter: 5n },
  [CREATED]: { committee: [O], threshold: 1, counter: 0n },
});

/** The update the chain checks a signature against: the wallet's own construction, made here independently. */
const updateData = (address: string, to: { committee: Key[]; threshold: number }, counter: bigint) =>
  new L.MaintenanceUpdate(address, [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority(to.committee as never, to.threshold, counter + 1n)) as never], counter).dataToSign;

/** The chain as a person's own wallet reads it at its indexer: every vault here is pinned to the company's account. */
let seenByTheWallets: () => ChainRead = () => new Map();

/** The chain, and the company's service, which applies an update only when its signatures verify as the chain checks them. */
function world(contracts = companyOnChain()) {
  seenByTheWallets = () => new Map(Object.entries(contracts).map(([address, c]) => [address, {
    of: 'read' as const, committee: c.committee, threshold: c.threshold, counter: c.counter, pinnedTo: address === ACCOUNT ? null : ACCOUNT,
  }]));
  const sends: Array<{ address: string; indexes: number[]; change?: { company: string; salt: string; joined: number } }> = [];
  const drop = new Set<string>();
  const stateOf = (address: string) => {
    const c = contracts[address]!;
    return { maintenanceAuthority: { committee: c.committee.map((k) => ({ ...k })), threshold: c.threshold, counter: c.counter }, data: c.view ?? {} };
  };
  const readers = {
    runtimeState: { deserialize: (b: Uint8Array) => stateOf(hex(b)) },
    accountLedger: (data: unknown) => data,
  };
  const chain = { contractState: async (address: string) => (contracts[address] === undefined ? null : { serialize: () => bytes(address) }) };
  const service: NonNullable<SuperAdminDoors['service']> = {
    send: async (update) => {
      sends.push({
        address: update.address, indexes: update.signatures.map((s) => s.index),
        ...(update.change === undefined ? {} : { change: { company: update.change.company, salt: update.change.salt, joined: update.change.joined.length } }),
      });
      if (drop.has(update.address)) return { state: 'sent' };
      const c = contracts[update.address]!;
      if (update.counter !== c.counter.toString()) throw new Error('the counter moved');
      const data = updateData(update.address, update.to as { committee: Key[]; threshold: number }, c.counter);
      const good = update.signatures.filter((s, i, all) => (i === 0 || s.index > all[i - 1]!.index)
        && L.verifySignature(c.committee[s.index] as never, data, s.signature as never));
      if (good.length !== update.signatures.length || good.length < c.threshold) throw new Error('the chain refused it');
      contracts[update.address] = { ...c, committee: update.to.committee.map((k) => ({ ...k })), threshold: update.to.threshold, counter: c.counter + 1n };
      return { state: 'sent' };
    },
  };
  return { contracts, sends, drop, readers, chain, service };
}

/** A committee ask as a page sends it, read by the wallet's own parser. */
const askOf = (fields: Record<string, unknown>): CommitteeRequest => parseAsk({
  schema: REQUEST_SCHEMA, kind: 'committee', requester: { name: 'payroll', rdns: 'example.payroll' }, purpose: 'Change the super admins.',
  nonce: 'n', expiresAt: Date.now() + 60_000, ...fields,
}, 'https://pay.example', Date.now()) as CommitteeRequest;

/**
 * A person's own wallet: the key it gives for the company, its one press over
 * every contract's update, and a joining key's signature - each the wallet's
 * own parser and press, over the chain as the wallet reads it.
 */
const walletOf = (who: ReturnType<typeof person>, over: Partial<SuperAdminDoors['wallet']> = {}): SuperAdminDoors['wallet'] => ({
  key: async () => keyOf(who),
  signUpdates: async (ask) => {
    const request = askOf({
      company: ask.company, account: ask.account, change: ask.change, salt: ask.salt, changeBytes: hex(ask.bytes),
      joined: ask.joined, contracts: ask.contracts,
    });
    const signed = committeeSignaturesFor(L as never, who, request, seenByTheWallets(), Date.now());
    return { signer: signed.signer as Key, signatures: signed.signatures };
  },
  signJoin: async (ask) => {
    const request = askOf({ company: ask.company, account: ask.account, change: ask.change, salt: ask.salt, changeBytes: hex(ask.bytes), joining: true });
    const signed = committeeJoinFor(L as never, who, request, seenByTheWallets(), Date.now());
    return { signer: signed.signer as Key, signature: signed.signature };
  },
  ...over,
});

/** A joining signature as a wallet makes it: the ledger's own signer, with the key the wallet gives for the company. */
const joinSignatureOf = (who: ReturnType<typeof person>, b: Uint8Array): string =>
  (L.signData(committeeSigningKeyFor(who, LABEL) as never, b) as unknown as Key).value;

type World = ReturnType<typeof world>;
const doorsOf = (w: World, who: ReturnType<typeof person>, over: Partial<SuperAdminDoors> = {}): SuperAdminDoors => ({
  readers: w.readers, chain: w.chain, ledger: L as unknown as SuperAdminDoors['ledger'],
  createdByTheCompany: [CREATED],
  seats: [{ seat: 's'.repeat(64), person: 'alice', committeeKey: A }] as SuperAdminDoors['seats'],
  wallet: walletOf(who), service: w.service,
  watch: { everyMs: 1, withinMs: 2, sleep: async () => undefined },
  random: (n) => new Uint8Array(n).fill(7),
  ...over,
});
/* Bob holds no seat, no records and no session with the service: only his wallet and its indexer. */
const noSeat = (w: World, over: Partial<SuperAdminDoors> = {}) => doorsOf(w, bob, { seats: [], createdByTheCompany: [], service: undefined, ...over });

/** Carol joins: Alice and Bob stay, at two. */
const ADD_CAROL: SuperAdminsAskedFor['change'] = { kind: 'super-admins', committee: [A, B, C], threshold: 2 };
const raise = (w: World, change: SuperAdminsAskedFor['change'] = ADD_CAROL): Promise<SuperAdminChangeRaised> =>
  raiseFromTheChain(doorsOf(w, alice), { change, company: LABEL, account: ACCOUNT, summary: 'Carol joins the super admins' });
const PEOPLE = [alice, bob, carol, olga, stranger];
/** Every key the change adds to any contract signs it with its own key, each on its own device. */
async function joinedByAll(w: World, file: ProposalFile, joining: readonly Key[]): Promise<ProposalFile> {
  let f = file;
  for (const k of joining) f = await joinFromAFile(doorsOf(w, PEOPLE.find((p) => keyOf(p).value === k.value)!), f);
  return f;
}
const statesOf = (p: SuperAdminChangeProgress): Array<SuperAdminContractStanding['state']> => p.contracts.map((c) => c.state);

describe('A CHANGE OF THE SUPER ADMINS, RAISED, JOINED, APPROVED AND FINISHED FROM THE CHAIN', () => {
  it('a half-changed company is finished from another super admin\'s device', async () => {
    const w = world();
    const { file, joining } = await raise(w);
    /* RED WHEN: the keys that must sign as joining keys are read from the committee the file says it replaces, not from each contract's committee on the chain. */
    expect(joining).toEqual([A, B, C]);
    /* RED WHEN: a contract the account lists as adopted or retired, or the company's records say it created, is left out of the change. */
    expect((file.change as SuperAdminChangeOnTheWire).contracts.map((c) => c.address)).toEqual([ACCOUNT, ADOPTED, RETIRED, CREATED]);
    const joined = await joinedByAll(w, proposalFileRead(proposalFileText(file)), joining);
    const carols: JoiningSignature = joined.joined!.find((j) => j.key.value === C.value)!;
    /* RED WHEN: a joining key's signature is over anything but the change's own bytes, which begin with their own tag. */
    expect(joinedBy(L as never, superAdminChangeBytes(LABEL, ACCOUNT, file.salt, file.change as SuperAdminChangeOnTheWire), C, carols.signature)).toBe(true);
    expect(Buffer.from(superAdminChangeBytes(LABEL, ACCOUNT, file.salt, file.change as SuperAdminChangeOnTheWire)).subarray(4, 4 + SUPER_ADMIN_CHANGE_TAG.length).toString()).toBe(SUPER_ADMIN_CHANGE_TAG);
    const byAlice: SuperAdminChangeApproved = await approveFromAFile(doorsOf(w, alice), joined);
    /* One of two signatures on the account and the two vaults Alice holds; Olga's vault has none. */
    expect(byAlice.contracts.map((c) => [c.state, c.have])).toEqual([['waiting', 1], ['waiting', 1], ['waiting', 1], ['waiting', 0]]);
    const byOlga = await approveFromAFile(doorsOf(w, olga), byAlice.file);
    expect(byOlga.asked).toBe(true);
    /* RED WHEN: a change is sent before every contract still to move has its committee's threshold of signatures. */
    expect(w.sends).toEqual([]);
    /* The service sends the account's change, and drops the first vault's. */
    w.drop.add(ADOPTED);
    const byBob = await approveFromAFile(doorsOf(w, bob), byOlga.file);
    expect(w.sends.map((s) => s.address)).toEqual([ACCOUNT, ADOPTED]);
    expect(byBob.done).toBe(false);
    /* RED WHEN: a send is believed because the service answered, and not because the contract's counter moved on the chain. */
    expect(statesOf(byBob)).toEqual(['sent', 'not-shown', 'ready', 'ready']);
    expect(w.contracts[ACCOUNT]!.committee).toEqual([A, B, C]);
    expect(w.contracts[ADOPTED]!.committee).toEqual([A, B]);
    /* Another super admin's device, from the file it holds: every contract left is sent, and the company reads current. */
    w.drop.clear();
    /* RED WHEN: a device holding the file cannot send what is left of a half-changed company. */
    const finished = await resumeFromAFile(doorsOf(w, alice), byBob.file);
    expect(finished.done).toBe(true);
    expect(w.sends.map((s) => s.address)).toEqual([ACCOUNT, ADOPTED, ADOPTED, RETIRED, CREATED]);
    /* RED WHEN: a send leaves out the change and its joining signatures - the service then cannot refuse an update whose joins are not all signed. */
    for (const sent of w.sends) expect(sent.change).toEqual({ company: LABEL, salt: file.salt, joined: 3 });
    for (const a of [ACCOUNT, ADOPTED, RETIRED, CREATED]) expect(w.contracts[a]!.committee).toEqual([A, B, C]);
    expect(finished.seen.behind).toEqual([]);
  });

  it('a change that already landed is never sent again: the chain\'s counter says so', async () => {
    const w = world();
    const { file, joining } = await raise(w);
    let f = await joinedByAll(w, file, joining);
    for (const who of [alice, olga, bob]) f = (await approveFromAFile(doorsOf(w, who, { service: undefined }), f)).file;
    /* Another device sent every update, and the chain shows each contract moved on to the new committee. */
    for (const a of [ACCOUNT, ADOPTED, RETIRED, CREATED]) {
      const c = w.contracts[a]!;
      w.contracts[a] = { ...c, committee: [A, B, C], threshold: 2, counter: c.counter + 1n };
    }
    /* RED WHEN: a contract that already reads current is sent again, or taken as still to move. */
    const again = await resumeFromAFile(doorsOf(w, bob), f);
    expect(again.done).toBe(true);
    expect(w.sends).toEqual([]);
  });

  it('a super admin with no seat signs by file, and another device counts the signatures', async () => {
    const w = world();
    const { file, joining } = await raise(w);
    const joined = await joinedByAll(w, file, joining);
    /* RED WHEN: Bob's approval needs a seat, the company's records or the service. */
    const byBob = await approveFromAFile(noSeat(w), joined);
    expect(byBob.asked).toBe(true);
    expect(byBob.held).toMatch(/not every contract still to move has enough/);
    expect(byBob.contracts[3]!.why).toMatch(/not one this device can confirm as the company's/);
    /* RED WHEN: a vault only the company's records name is signed from a device that does not hold them. */
    expect((await approveFromAFile(doorsOf(w, olga, { createdByTheCompany: [], service: undefined }), joined)).asked).toBe(false);
    const counted = await resumeFromAFile(doorsOf(w, alice, { service: undefined }), byBob.file);
    /* RED WHEN: a signature carried by file is not counted on another device. */
    expect(counted.contracts.map((c) => c.have)).toEqual([1, 1, 1, 0]);
    /* RED WHEN: a committee key no seat proves is not shown as a super admin, or a seat's name is not shown beside the key it proves. */
    expect(counted.seen.shown.map((s: SuperAdminShown) => s.seat?.person ?? null)).toEqual(['alice', null]);
    expect(counted.seen.iAmOne).toBe(true);
    /* With every signature in, Bob's device sends what it can confirm, the account first, and leaves the rest to a device that holds the records. */
    const byOlga = (await approveFromAFile(doorsOf(w, olga, { service: undefined }), byBob.file)).file;
    const withAlice = (await approveFromAFile(doorsOf(w, alice, { service: undefined }), byOlga)).file;
    const sentByBob = await resumeFromAFile(noSeat(w, { service: w.service }), withAlice);
    /* RED WHEN: a vault only the company's records name is sent from a device that does not hold them. */
    expect(w.sends.map((x) => x.address)).toEqual([ACCOUNT, ADOPTED, RETIRED]);
    expect(sentByBob.held).toMatch(/a device holding the company's records sends it/);
    expect((await resumeFromAFile(doorsOf(w, alice), withAlice)).done).toBe(true);
  });

  it('a signature from a key not on that contract\'s committee never counts, and a key holds standing only where it sits', async () => {
    const w = world();
    const { file, joining } = await raise(w);
    const joined = await joinedByAll(w, file, joining);
    const change = joined.change as SuperAdminChangeOnTheWire;
    const sign = (who: ReturnType<typeof person>, address: string, counter: bigint) =>
      L.signData(committeeSigningKeyFor(who, LABEL) as never, updateData(address, { committee: [...change.committee], threshold: change.threshold }, counter)) as unknown as Key;
    const forged: SuperAdminSignature[] = [
      /* The stranger's signature, put at Bob's place on the vault. */
      { address: ADOPTED, counter: '1', index: 1, signature: sign(stranger, ADOPTED, 1n) },
      /* Bob's signature on the vault, put under the account. */
      { address: ACCOUNT, counter: '3', index: 1, signature: sign(bob, ADOPTED, 1n) },
      /* Bob's signature on the retired vault at a counter it no longer holds. */
      { address: RETIRED, counter: '4', index: 1, signature: sign(bob, RETIRED, 4n) },
      /* Alice's signature on Olga's vault, which Alice does not hold. */
      { address: CREATED, counter: '0', index: 0, signature: sign(alice, CREATED, 0n) },
    ];
    const got = await resumeFromAFile(doorsOf(w, alice), { ...joined, signatures: forged });
    /* RED WHEN: a signature counts where it does not verify under that contract's committee on the chain, at its counter. */
    expect(got.contracts.map((c) => c.have)).toEqual([0, 0, 0, 0]);
    expect(w.sends).toEqual([]);
    /* Olga is on no committee of the account, and holds her vault: her press signs that vault alone, and it counts. */
    const asked: string[][] = [];
    const byOlga = await approveFromAFile(doorsOf(w, olga, {
      wallet: walletOf(olga, { signUpdates: async (ask) => { asked.push(ask.contracts.map((c) => c.address)); return walletOf(olga).signUpdates(ask); } }),
    }), joined);
    /* RED WHEN: standing to sign a contract's update is read from anything but that contract's committee on the chain. */
    expect(asked).toEqual([[CREATED]]);
    expect(byOlga.contracts.map((c) => c.have)).toEqual([0, 0, 0, 1]);
    /* RED WHEN: a wallet holding no place on any contract still to move is asked to sign. */
    const byStranger = await approveFromAFile(doorsOf(w, stranger, {
      wallet: walletOf(stranger, { signUpdates: async () => { throw new Error('the stranger\'s wallet was asked'); } }),
    }), joined);
    expect(byStranger.asked).toBe(false);
  });

  it('a sparse signature list is refused, from a file and from the service alike', async () => {
    const w = world();
    const { file, joining } = await raise(w);
    const joined = await joinedByAll(w, file, joining);
    const one = (await approveFromAFile(doorsOf(w, alice), joined)).file.signatures!;
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [one[0]!, , one[1]!] as unknown as SuperAdminSignature[];
    /* RED WHEN: a list with a gap in it is read as a list of signatures. */
    expect(signatureListRefusal(sparse)).toMatch(/gap/);
    expect(signatureListRefusal(one)).toBeNull();
    /* RED WHEN: an entry that is not a signature is read as one, from a list or from a file. */
    expect(signatureListRefusal([one[0]!, { ...one[1]!, index: -1 }])).toMatch(/not a signature/);
    expect(() => proposalFileRead(JSON.stringify({ ...joined, signatures: [one[0], { ...one[1], signature: null }] }))).toThrow(/signature in the file cannot be read/);
    /* Bob's signatures come from the service with a gap in them. */
    const bobs = (await approveFromAFile(noSeat(w), joined)).file.signatures!;
    const fromService = [bobs[0]!, , bobs[1]!] as unknown as SuperAdminSignature[];
    const got = await resumeFromAFile(doorsOf(w, alice, { service: { ...w.service, collected: async () => fromService } }), { ...joined, signatures: one });
    /* RED WHEN: any signature of a list from the service with a gap in it is counted. */
    expect(got.contracts.map((c) => c.have)).toEqual([1, 1, 1, 0]);
    /* Handed over whole, the same signatures count, and with Olga's the change is sent. */
    const byOlga = (await approveFromAFile(doorsOf(w, olga, { service: undefined }), { ...joined, signatures: one })).file;
    const done = await resumeFromAFile(doorsOf(w, alice, { service: { ...w.service, collected: async () => bobs } }), byOlga);
    expect(done.done).toBe(true);
    /* RED WHEN: a list handed to the service is out of order. */
    expect(w.sends.map((s) => s.indexes)).toEqual([[0, 1], [0, 1], [0, 1], [0]]);
  });

  it('no vault\'s update is sent before the account reads current', async () => {
    const w = world();
    const { file, joining } = await raise(w);
    let f = await joinedByAll(w, file, joining);
    for (const who of [alice, olga]) f = (await approveFromAFile(doorsOf(w, who), f)).file;
    w.drop.add(ACCOUNT);
    const byBob = await approveFromAFile(doorsOf(w, bob), f);
    /* RED WHEN: a vault's change is sent while the account does not read as changed at the wallet's indexer. */
    expect(w.sends.map((s) => s.address)).toEqual([ACCOUNT]);
    expect(byBob.contracts[0]!.state).toBe('not-shown');
    expect(byBob.held).toMatch(/does not show on the chain yet/);
    w.drop.clear();
    const done = await resumeFromAFile(doorsOf(w, bob), byBob.file);
    expect(w.sends.map((s) => s.address)).toEqual([ACCOUNT, ACCOUNT, ADOPTED, RETIRED, CREATED]);
    expect(done.done).toBe(true);
  });

  it('a proposal adding a key that has not signed the change is never signed by a wallet, counted ready or sent', async () => {
    const w = world();
    const { file, joining } = await raise(w);
    /* RED WHEN: a wallet is asked to sign any contract's update while a key the change adds has not signed the change itself. */
    await expect(approveFromAFile(doorsOf(w, alice, { wallet: walletOf(alice, { signUpdates: async () => { throw new Error('the wallet was asked'); } }) }), file))
      .rejects.toThrow(/have not signed the change with their own key/);
    /* Every key joins; each wallet's ask then carries the change's bytes and every joining signature, so the wallet can check them itself. */
    const joined = await joinedByAll(w, file, joining);
    const asks: Array<Parameters<SuperAdminDoors['wallet']['signUpdates']>[0]> = [];
    let f = joined;
    for (const who of [alice, olga, bob]) {
      const wallet = walletOf(who, { signUpdates: async (ask) => { asks.push(ask); return walletOf(who).signUpdates(ask); } });
      f = (await approveFromAFile(doorsOf(w, who, { service: undefined, wallet }), f)).file;
    }
    /* RED WHEN: the wallet's ask does not carry the change's exact bytes and the joining keys' signatures over them. */
    expect(asks.length).toBe(3);
    for (const ask of asks) {
      expect(hex(ask.bytes)).toBe(hex(superAdminChangeBytes(LABEL, ACCOUNT, file.salt, file.change as SuperAdminChangeOnTheWire)));
      expect(ask.joined).toEqual(joined.joined);
      /* RED WHEN: the ask leaves out what the wallet rebuilds the bytes from: the salt and the change whole. */
      expect(hex(superAdminChangeBytes(ask.company, ask.account, ask.salt, ask.change))).toBe(hex(ask.bytes));
    }
    /* RED WHEN: a wallet asked to sign with a joining signature missing signs anyway, trusting the device that asked. */
    const lastAsk = asks[0]! as Parameters<SuperAdminDoors['wallet']['signUpdates']>[0];
    await expect(walletOf(alice).signUpdates({ ...lastAsk, joined: [] })).rejects.toThrow(/has not signed the change with its own key/);
    /* The same signed updates, in a file stripped of its joining signatures. */
    const got = await resumeFromAFile(doorsOf(w, alice), { ...f, joined: [] });
    /* RED WHEN: a change is sent, or a contract counted ready, before every key it adds has signed it with its own key. */
    expect(w.sends).toEqual([]);
    expect(got.joinsMissing).toEqual([A, B, C]);
    expect(got.held).toMatch(/joining keys have not signed the change with their own key/);
    expect(statesOf(got)).toEqual(['waiting', 'waiting', 'waiting', 'waiting']);
    /* RED WHEN: the joining keys' own signatures do not release the same file. */
    const done = await resumeFromAFile(doorsOf(w, alice), f);
    expect(done.done).toBe(true);
  });

  it('a joining key\'s signature over other bytes is refused', async () => {
    const w = world();
    const { file } = await raise(w);
    const change = file.change as SuperAdminChangeOnTheWire;
    const carolSigns = (b: Uint8Array) => joinSignatureOf(carol, b);
    const other = superAdminChangeBytes(LABEL, ACCOUNT, file.salt, { ...change, threshold: 3 });
    const right = superAdminChangeBytes(LABEL, ACCOUNT, file.salt, change);
    /* RED WHEN: a joining signature over another change is believed. */
    await expect(resumeFromAFile(doorsOf(w, alice), { ...file, joined: [{ key: C, signature: carolSigns(other) }] }))
      .rejects.toThrow(/is not its signature over this change/);
    /* RED WHEN: a key the change does not add can stand in for one it does. */
    await expect(resumeFromAFile(doorsOf(w, alice), { ...file, joined: [{ key: O, signature: joinSignatureOf(olga, right) }] }))
      .rejects.toThrow(/from a key the change does not add/);
    /* RED WHEN: a joining signature is checked over the raw bytes rather than as the ledger checks a signature, so a real wallet's signature is refused and another scheme's believed. */
    await expect(resumeFromAFile(doorsOf(w, alice), { ...file, joined: [{ key: C, signature: hex(schnorr.sign(right, bytes(committeeSigningKeyFor(carol, LABEL).value))) }] }))
      .rejects.toThrow(/is not its signature over this change/);
    expect(joinedBy(L as never, right, C, carolSigns(right))).toBe(true);
    /* RED WHEN: a wallet's joining signature is added without being checked over the change's bytes. */
    await expect(joinFromAFile(doorsOf(w, carol, { wallet: walletOf(carol, { signJoin: async () => ({ signer: C, signature: carolSigns(other) }) }) }), file))
      .rejects.toThrow(/did not sign this change/);
    /* RED WHEN: a key the change does not add is asked to sign as a joining key. */
    await expect(joinFromAFile(doorsOf(w, olga), file)).rejects.toThrow(/not one this change adds/);
    /* RED WHEN: a change altered after it was raised is read under the identity it was raised with. */
    await expect(resumeFromAFile(doorsOf(w, alice), { ...file, change: { ...change, threshold: 3 } }))
      .rejects.toThrow(/not the one its identity names/);
    /* RED WHEN: a key already on a contract's committee on the chain is asked to join it, or a key a contract lacks is not. */
    expect(joiningKeys(change.committee, [{ committee: [A, B] }])).toEqual([C]);
    expect(joiningKeys(change.committee, [{ committee: [A, B] }, { committee: [O] }])).toEqual([A, B, C]);
  });

  it('a joining key\'s own wallet signs the change, the device\'s check takes it, and the wallet refuses a key the change does not install', async () => {
    const w = world();
    const { file } = await raise(w);
    /* Carol's own wallet, through its own parser and press, over the chain as it reads it. */
    const joined = await joinFromAFile(doorsOf(w, carol), file);
    const carolJoined = joined.joined!.find((j) => j.key.value === C.value)!;
    /* RED WHEN: the wallet's joining signature is not one the device's check (`joinedBy`) takes over the change's bytes. */
    expect(joinedBy(L as never, superAdminChangeBytes(LABEL, ACCOUNT, file.salt, file.change as SuperAdminChangeOnTheWire), C, carolJoined.signature)).toBe(true);
    /* RED WHEN: a wallet signs as a joining key for a key the change does not install. */
    const ask = { company: LABEL, account: ACCOUNT as never, salt: file.salt, change: file.change as SuperAdminChangeOnTheWire,
      bytes: superAdminChangeBytes(LABEL, ACCOUNT, file.salt, file.change as SuperAdminChangeOnTheWire) };
    await expect(walletOf(stranger).signJoin(ask)).rejects.toThrow(/not one this change installs/);
    /* RED WHEN: the wallet signs bytes it did not rebuild from the change. */
    await expect(walletOf(carol).signJoin({ ...ask, bytes: superAdminChangeBytes(LABEL, ACCOUNT, file.salt, { ...ask.change, threshold: 3 }) }))
      .rejects.toThrow(/not the change it asks/);
  });

  it('a signers\' proposal never carries or counts it, and the account never holds it open', async () => {
    const w = world();
    const { file } = await raise(w);
    const builder = new Proxy({}, { get: () => { throw new Error('the account was asked'); } });
    const signerDoors = { accountId: LABEL, account: ACCOUNT, material: {}, indexer: { indexerUri: '', indexerWsUri: '' }, builder, send: {} } as unknown as FromTheChainDoors;
    /* RED WHEN: a change of the super admins is approved, checked or raised as a proposal on the account. */
    await expect(approveFromAFile(signerDoors, file, async () => undefined)).rejects.toThrow(/never held open, approved or counted on the company's account/);
    await expect(fileCheckedAgainstTheChain(signerDoors, file)).rejects.toThrow(/never held open, approved or counted/);
    await expect(raiseFromTheChain(signerDoors as never, { change: ADD_CAROL, company: LABEL, account: ACCOUNT, summary: '' })).rejects.toThrow(/never held open/);
    /* RED WHEN: the account's own functions make a payload for a change of the super admins. */
    expect(() => governancePayloadOf({ accountPure: {} as never }, { kind: 'super-admins' } as never)).toThrow(/never raised, approved or counted on the company's account/);
    /* RED WHEN: a signers' proposal file carries the super admins' signatures and is read. */
    const { joined: _j, signatures: _s, ...plain } = file;
    const signers: ProposalFile = { ...plain, change: { kind: 'threshold', threshold: '2' } };
    expect(() => proposalFileRead(proposalFileText({ ...signers, signatures: [] }))).toThrow(/never carries or counts them/);
    expect(() => proposalFileRead(proposalFileText(signers))).not.toThrow();
    /* RED WHEN: a super admin's wallet alone raises a signers' proposal. */
    await expect(raiseFromTheChain(doorsOf(w, alice) as never, { change: { kind: 'threshold', threshold: '2' }, summary: '' })).rejects.toThrow(/a signer's own keys raise and approve/);
  });

  it('only a super admin raises one, the one install rule applies, and a lone key is warned of, never refused', async () => {
    const w = world();
    /* RED WHEN: a key not on the account's committee raises a change of the super admins. */
    await expect(raiseFromTheChain(doorsOf(w, olga), { change: ADD_CAROL, company: LABEL, account: ACCOUNT, summary: '' })).rejects.toThrow(/not one of its super admins/);
    /* RED WHEN: a committee the install rule refuses is raised. */
    await expect(raise(w, { ...ADD_CAROL, threshold: 4 })).rejects.toThrow(/can never be met/);
    const lone = await raise(w, { kind: 'super-admins', committee: [A], threshold: 1 });
    /* RED WHEN: one key left is refused, or passes without a word. */
    expect(lone.warnings).toContain(ONE_SUPER_ADMIN_LEFT);
    /* Olga's vault is put under Alice's key, so Alice's key joins it. */
    expect(lone.joining).toEqual([A]);
    /* RED WHEN: a device shows a lone super admin's key without the warning. */
    const w1 = world({ ...companyOnChain(), [ACCOUNT]: { ...companyOnChain()[ACCOUNT]!, committee: [A], threshold: 1 } });
    const seen = await resumeFromAFile(doorsOf(w1, alice), (await raise(w1)).file);
    expect(seen.seen.warning).toBe(ONE_SUPER_ADMIN_LEFT);
    /* RED WHEN: a committee that needs every one of its keys is shown or raised without the warning, or is refused. */
    const all = await raise(w, { ...ADD_CAROL, threshold: 3 });
    expect(all.warnings).toContain(EVERY_SUPER_ADMIN_NEEDED);
    expect((await resumeFromAFile(doorsOf(w, alice), all.file)).seen.warning).toBe(EVERY_SUPER_ADMIN_NEEDED);
    expect((await raise(w)).warnings).toEqual([]);
  });

  it('the keys that must join are read from each contract on the chain, so a removed key is never put back unsigned', async () => {
    const w = world();
    const noRecords = { createdByTheCompany: [] as string[] };
    const { file, joining } = await raiseFromTheChain(doorsOf(w, alice, noRecords), { change: ADD_CAROL, company: LABEL, account: ACCOUNT, summary: '' });
    expect(joining).toEqual([C]);
    const joined = await joinFromAFile(doorsOf(w, carol, noRecords), file);
    /* After the change was raised, another change takes Bob off the adopted vault. */
    w.contracts[ADOPTED] = { committee: [A], threshold: 1, counter: 2n };
    /* RED WHEN: a key a contract's committee on the chain does not hold is put back on it without that key's own signature. */
    expect((await resumeFromAFile(doorsOf(w, alice, noRecords), joined)).joinsMissing).toEqual([B]);
    await expect(approveFromAFile(doorsOf(w, alice, noRecords), joined)).rejects.toThrow(/joining key has not signed/);
    let f = await joinFromAFile(doorsOf(w, bob, noRecords), joined);
    for (const who of [alice, bob]) f = (await approveFromAFile(doorsOf(w, who, noRecords), f)).file;
    for (const a of [ACCOUNT, ADOPTED, RETIRED]) expect(w.contracts[a]!.committee).toEqual([A, B, C]);
  });

  it('a file that misstates who holds the account is refused before any wallet is asked, whatever its counter', async () => {
    const w = world();
    const crafted = (from: Key[], counter: string): ProposalFile => {
      const change: SuperAdminChangeOnTheWire = {
        kind: 'super-admins', from: { committee: from, threshold: 2 }, committee: [A, B, S], threshold: 2,
        contracts: [
          { contract: 'account', address: ACCOUNT, counter }, { contract: 'vault', address: ADOPTED, counter: '1' },
          { contract: 'vault', address: RETIRED, counter: '5' }, { contract: 'vault', address: CREATED, counter: '0' },
        ],
      };
      const salt = '07'.repeat(32);
      return {
        format: PROPOSAL_FILE_FORMAT, company: LABEL, account: ACCOUNT, change, salt, summary: '', joined: [], signatures: [],
        chainId: hex(sha256(superAdminChangeBytes(LABEL, ACCOUNT, salt, change))),
      };
    };
    const never = { wallet: walletOf(bob, { signUpdates: async () => { throw new Error('the wallet was asked'); } }) };
    /* Alice's file says her second key already holds the account, at a counter one above the chain's. */
    /* RED WHEN: the committee a file says it replaces is checked against the chain only while the account sits at the file's counter. */
    await expect(approveFromAFile(doorsOf(w, bob, never), crafted([A, B, S], '4'))).rejects.toThrow(/not held by the committee this change says it replaces/);
    /* RED WHEN: a file whose committee it replaces is not the account's committee on the chain is read at all. */
    await expect(resumeFromAFile(doorsOf(w, bob), crafted([A, B, S], '3'))).rejects.toThrow(/not held by the committee this change says it replaces/);
    /* Told truthfully, the same change waits for her second key's own signature, and no wallet is asked before it. */
    const told = crafted([A, B], '3');
    /* Every key it installs joins the vault Olga alone holds; her second key joins every contract. */
    expect((await resumeFromAFile(doorsOf(w, bob), told)).joinsMissing).toEqual([A, B, S]);
    await expect(approveFromAFile(doorsOf(w, bob, never), told)).rejects.toThrow(/joining keys? ha(s|ve) not signed/);
    /* A stale file: a newer change took Bob off the account after it was raised. */
    const { file } = await raise(w);
    w.contracts[ACCOUNT] = { ...w.contracts[ACCOUNT]!, committee: [A], threshold: 1, counter: 4n };
    await expect(resumeFromAFile(doorsOf(w, alice), file)).rejects.toThrow(/not held by the committee this change says it replaces/);
  });

  it('a change file that leaves out a contract of the company is refused on the device, before its wallet is asked or anything is sent', async () => {
    const w = world();
    /* Alice raises from a device that does not hold the company's records, so the vault only they name is left out. */
    const noRecords = { createdByTheCompany: [] };
    const { file, joining } = await raiseFromTheChain(doorsOf(w, alice, noRecords), { change: ADD_CAROL, company: LABEL, account: ACCOUNT, summary: '' });
    expect((file.change as SuperAdminChangeOnTheWire).contracts.map((c) => c.address)).toEqual([ACCOUNT, ADOPTED, RETIRED]);
    let f = file;
    for (const k of joining) f = await joinFromAFile(doorsOf(w, PEOPLE.find((p) => keyOf(p).value === k.value)!, noRecords), f);
    f = (await approveFromAFile(doorsOf(w, alice, noRecords), f)).file;
    const sendsBefore = w.sends.length;
    /* Bob's device holds the company's records, which name a vault the change leaves out, still held by another committee.
     * RED WHEN: a device signs or sends a change that leaves out a contract, and only reports it. */
    let asked = false;
    const bobs = doorsOf(w, bob, { wallet: walletOf(bob, { signUpdates: async () => { asked = true; throw new Error('the wallet was asked'); } }) });
    await expect(approveFromAFile(bobs, f)).rejects.toThrow(new RegExp(`leaves out vault ${CREATED}`));
    await expect(resumeFromAFile(doorsOf(w, bob), f)).rejects.toThrow(new RegExp(`leaves out vault ${CREATED}`));
    await expect(joinFromAFile(doorsOf(w, carol), file)).rejects.toThrow(new RegExp(`leaves out vault ${CREATED}`));
    expect(asked).toBe(false);
    expect(w.sends).toHaveLength(sendsBefore);
  });

  /** A change taken all the way: every joining key signs, then every super admin, and the last press sends. */
  const landed = async (w: World, change: SuperAdminsAskedFor['change'], approvers: ReturnType<typeof person>[]): Promise<ProposalFile> => {
    const { file, joining } = await raise(w, change);
    let f = await joinedByAll(w, file, joining);
    for (const who of approvers) f = (await approveFromAFile(doorsOf(w, who), f)).file;
    return f;
  };
  const REMOVE_CAROL: SuperAdminsAskedFor['change'] = { kind: 'super-admins', committee: [A, B], threshold: 2 };

  it('a change that ran is never signed or sent again after the account came back to the committee it replaced', async () => {
    const w = world();
    /* Carol is added, then taken off: the account is back at Alice and Bob, two counters on. */
    const added = await landed(w, ADD_CAROL, [alice, olga, bob]);
    await landed(w, REMOVE_CAROL, [alice, bob]);
    expect(w.contracts[ACCOUNT]).toMatchObject({ committee: [A, B], counter: 5n });
    const sends = w.sends.length;
    /* RED WHEN: the old change, with Carol's old joining signature, is taken again by a device because the account holds its `from` once more. */
    await expect(approveFromAFile(doorsOf(w, alice), added)).rejects.toThrow(/not held by the committee this change says it replaces, at the counter/);
    await expect(resumeFromAFile(doorsOf(w, alice), added)).rejects.toThrow(/not held by the committee this change says it replaces, at the counter/);
    /* RED WHEN: a wallet signs it, trusting the page that shows it again. */
    const change = added.change as SuperAdminChangeOnTheWire;
    await expect(walletOf(alice).signUpdates({
      company: LABEL, account: ACCOUNT as never, salt: added.salt, change, bytes: superAdminChangeBytes(LABEL, ACCOUNT, added.salt, change),
      joined: added.joined!, contracts: [{ contract: 'account', address: ACCOUNT, counter: '5' }],
    })).rejects.toThrow(/raised when the account was at counter 3/);
    expect(w.sends.length).toBe(sends);
    expect(w.contracts[ACCOUNT]!.committee).toEqual([A, B]);
  });

  it('every change names every contract of the company, so an update held back from an earlier change can no longer land', async () => {
    const w = world();
    /* Carol is added; the service sends the account's update and holds the adopted vault's back. */
    const { file, joining } = await raise(w);
    let f = await joinedByAll(w, file, joining);
    w.drop.add(ADOPTED);
    for (const who of [alice, olga, bob]) f = (await approveFromAFile(doorsOf(w, who), f)).file;
    w.drop.clear();
    expect(w.contracts[ADOPTED]).toMatchObject({ committee: [A, B], counter: 1n });
    const heldBack = f.signatures!.filter((s) => s.address === ADOPTED && s.counter === '1')
      .sort((a, b) => a.index - b.index).map((s) => ({ index: s.index, signature: s.signature }));
    expect(heldBack.length).toBeGreaterThanOrEqual(2);
    /* Carol is taken off. The adopted vault already holds Alice and Bob, and is named all the same. */
    const removal = await raise(w, REMOVE_CAROL);
    /* RED WHEN: a contract already holding the committee a change installs is left out of it. */
    expect((removal.file.change as SuperAdminChangeOnTheWire).contracts.map((c) => c.address)).toEqual([ACCOUNT, ADOPTED, RETIRED, CREATED]);
    let r = await joinedByAll(w, removal.file, removal.joining);
    let last: SuperAdminChangeApproved | null = null;
    for (const who of [alice, olga, bob]) { last = await approveFromAFile(doorsOf(w, who), r); r = last.file; }
    expect(last!.done).toBe(true);
    expect(w.contracts[ADOPTED]).toMatchObject({ committee: [A, B], counter: 2n });
    /* RED WHEN: the update held back from the earlier change still lands on the vault, putting Carol back on it. */
    await expect(w.service.send({
      address: ADOPTED, counter: '1', to: { committee: [A, B, C], threshold: 2 }, signatures: heldBack,
      change: { company: LABEL, salt: removal.file.salt, change: removal.file.change as SuperAdminChangeOnTheWire, joined: [] },
    })).rejects.toThrow();
    expect(w.contracts[ADOPTED]!.committee).toEqual([A, B]);
  });

  it('a raise is refused when any contract of the company cannot be read on the chain', async () => {
    const w = world(Object.fromEntries(Object.entries(companyOnChain()).filter(([a]) => a !== ADOPTED)));
    /* RED WHEN: a contract the chain cannot be asked about is left out of the change with a warning, not refused. */
    await expect(raise(w)).rejects.toThrow(/could not be asked who holds vault/);
  });
});
