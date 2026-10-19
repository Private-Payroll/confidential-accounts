import { describe, it, expect } from 'vitest';
import type { Hex } from '../../../src/core/crypto.js';
import {
  vaultFundableHere, depositIntoCompanyVault, depositPubliclyIntoCompanyVault, mergeNotesInCompanyVault,
  payPubliclyFromCompanyVault, payPrivatelyFromCompanyVault, vaultNotesHere, openCompanyVaultPool, checkWhatThisBrowserSent, createCompanyVaultByHandover,
  VaultNotReadHere, VaultNotTheCompanys, VaultStartOwed, VaultHandoverOwed,
} from './vault-operation.js';
import type { VaultOnChainOnTheWire } from './vault-worker-client.js';

/*
 * Whether money may go in or out of a vault is one answer, read on this device from the chain at the wallet's indexer and
 * the person's own wallet. These tests give the answer a stand-in wallet and indexer and nothing else: a door the answer
 * reaches for beyond them is a door it should not use.
 */
const VAULT = 'b1'.repeat(32) as Hex;
const ACCOUNT = 'ac'.repeat(32);
const OTHER_ACCOUNT = 'ad'.repeat(32);
const INDEXER = { indexerUri: 'https://indexer.example/api/v3/graphql', indexerWsUri: 'wss://indexer.example/api/v3/graphql/ws' };

type Chain = Extract<VaultOnChainOnTheWire, { onChain: true }>;
/** The vault as this device's worker reads it: this build's layout and circuits, and its account's, pinned to the company's account, started, empty. */
const startedVault = (over: Partial<Chain> = {}): VaultOnChainOnTheWire => ({
  onChain: true, state: 'AAAA', notes: [], notesFromThisBuild: true, everCreated: [], account: ACCOUNT, started: true,
  circuits: null, accountCircuits: null, ...over,
});

interface Stand {
  /** What the worker reads at the wallet's indexer, or what makes that read fail. */
  chain?: VaultOnChainOnTheWire | Error;
  /** The vaults the account has adopted as the person's wallet reads it, or the failure of that read. */
  adopted?: readonly string[] | Error;
  /** The wallet names no indexer. */
  noIndexer?: boolean;
  /** What the company's service would say of the vault's chain; it must never be what decides. */
  served?: Record<string, unknown>;
}

/** The doors every reader of the answer has, and a count of how often the service was asked. */
const doorsFor = (stand: Stand = {}) => {
  const asked = { service: 0, reads: 0 };
  const inputs: unknown[] = [];
  const doors = {
    account: ACCOUNT,
    indexer: async () => (stand.noIndexer === true ? null : INDEXER),
    onChain: async () => {
      if (stand.adopted instanceof Error) throw stand.adopted;
      return { holders: { adoptedVaults: stand.adopted ?? [VAULT] } };
    },
    builder: {
      vaultOnChain: async (input: unknown) => {
        asked.reads += 1;
        inputs.push(input);
        const chain = stand.chain ?? startedVault();
        if (chain instanceof Error) throw chain;
        return chain;
      },
    },
    service: {
      chain: async () => { asked.service += 1; return { vault: VAULT, onChain: true, ...stand.served }; },
    },
    sleep: async () => {}, waitMs: 3, everyMs: 1,
  };
  return { doors: doors as never, asked, inputs };
};

const NOT_PINNED = /^this vault is not pinned to your company's account, or its state is not a vault's, as the chain shows it, so money in it would be paid out on somebody else's approvals; no money goes in or out of it\.$/;
const ACCOUNT_UNREAD = /^this vault's state could not be read as a vault's, so which account it is pinned to and whether it is started are not known; no money goes in or out of it\.$/;
const NOT_STARTED = /^this vault has not been started: its first secret is not set, or not every signer's sealed copy is written\.$/;
const NOT_ON_CHAIN = 'the chain shows no vault at this address yet.';
const NOT_ADOPTED = /^this vault is not one your company's account has adopted, as your own wallet read the chain, so nothing is put into or paid from it\. Nothing was sent\.$/;

describe('WHETHER MONEY MAY GO IN OR OUT OF A VAULT, AS THIS DEVICE READS IT', () => {
  it('A VAULT THE COMPANY\'S ACCOUNT ADOPTED, PINNED TO IT AND STARTED IS FUNDABLE FROM THE CHAIN THE WALLET READS ALONE', async () => {
    const { doors, asked } = doorsFor();
    const answer = await vaultFundableHere(doors, VAULT);
    /* RED WHEN: a vault adopted, pinned to the company's account and started is not answered as fundable, or the answer is not the one with the vault's state and notes. */
    expect(answer).toMatchObject({ of: 'fundable', view: { vault: VAULT, onChain: true, state: 'AAAA', notes: [], everCreated: [] } });
    /* RED WHEN: the answer asks the company's service for any part of itself. */
    expect(asked).toEqual({ service: 0, reads: 1 });
  });

  it('A VAULT THE CHAIN DOES NOT SHOW, ONE NOT ADOPTED, ONE PINNED ELSEWHERE, ONE NOT STARTED AND ONE THAT CANNOT BE READ EACH GET THEIR OWN STATE AND SENTENCE', async () => {
    /* RED WHEN: a vault the indexer holds no state for is answered as anything but not on the chain. */
    expect(await vaultFundableHere(doorsFor({ chain: { onChain: false } }).doors, VAULT)).toEqual({ of: 'not-on-chain', why: NOT_ON_CHAIN });
    /* RED WHEN: a vault missing from the account's adopted vaults, as the wallet reads them, is answered as fundable or as a failed read. */
    const unadopted = await vaultFundableHere(doorsFor({ adopted: [OTHER_ACCOUNT] }).doors, VAULT);
    expect(unadopted.of).toBe('not-adopted');
    expect((unadopted as { why: string }).why).toMatch(NOT_ADOPTED);
    /* RED WHEN: the account the vault is pinned to is not compared with the company's - its money would be paid out on somebody else's approvals. */
    const elsewhere = await vaultFundableHere(doorsFor({ chain: startedVault({ account: OTHER_ACCOUNT }) }).doors, VAULT);
    expect(elsewhere).toMatchObject({ of: 'pinned-elsewhere', view: { vault: VAULT } });
    expect((elsewhere as { why: string }).why).toMatch(NOT_PINNED);
    /* RED WHEN: a vault whose first secret or sealed copies are missing is answered as fundable. */
    const unstarted = await vaultFundableHere(doorsFor({ chain: startedVault({ started: false }) }).doors, VAULT);
    expect(unstarted).toMatchObject({ of: 'not-started', view: { vault: VAULT } });
    expect((unstarted as { why: string }).why).toMatch(NOT_STARTED);
    /* RED WHEN: a read that failed, a wallet that cannot say who holds the company or one that names no indexer is answered as a vault that is not the company's. */
    const failed = await vaultFundableHere(doorsFor({ chain: new Error('the indexer did not answer') }).doors, VAULT);
    expect(failed.of).toBe('unreadable');
    expect((failed as { why: string }).why).toMatch(/could not read the vault from the chain \(the indexer did not answer\)/);
    const silent = await vaultFundableHere(doorsFor({ adopted: new Error('the wallet is locked') }).doors, VAULT);
    expect(silent.of).toBe('unreadable');
    expect((silent as { why: string }).why).toMatch(/^your wallet could not say who holds this vault's company \(the wallet is locked\)\./);
    const noIndexer = await vaultFundableHere(doorsFor({ noIndexer: true }).doors, VAULT);
    expect(noIndexer.of).toBe('unreadable');
    expect((noIndexer as { why: string }).why).toMatch(/did not say which indexer it reads the chain through/);
  });

  it('A READ OF THE VAULT THAT CANNOT BE RELIED ON IS UNREADABLE, BEFORE IT IS PINNED ELSEWHERE OR NOT STARTED', async () => {
    /* A state that is not a vault's reads, at the worker, with no account and not started (`vault-on-chain-here.test.ts`). */
    const noAccount = await vaultFundableHere(doorsFor({ chain: startedVault({ account: null, started: false }) }).doors, VAULT);
    /* RED WHEN: a read that threw (no account, not started) is answered as pinned elsewhere or not started. */
    expect(noAccount.of).toBe('unreadable');
    /* RED WHEN: the answer for a state that is not a vault's says the vault is pinned to somebody else's account, which it does not know. */
    expect((noAccount as { why: string }).why).toMatch(ACCOUNT_UNREAD);
    expect((noAccount as { why: string }).why).not.toMatch(NOT_PINNED);
    /* A ledger not laid out as this build's vault is: which notes it holds, and whether it is started, are not known. */
    const layout = await vaultFundableHere(doorsFor({
      chain: startedVault({ notesFromThisBuild: false, notesWhy: 'a field is missing', account: OTHER_ACCOUNT, started: false }),
    }).doors, VAULT);
    /* RED WHEN: a vault whose ledger is not this build's is answered by its account or its start flag, or as fundable. */
    expect(layout.of).toBe('unreadable');
    expect((layout as { why: string }).why).toMatch(/not laid out the way this version of the product reads one.*\(a field is missing\)/);
    const layoutAlone = await vaultFundableHere(doorsFor({ chain: startedVault({ notesFromThisBuild: false }) }).doors, VAULT);
    expect(layoutAlone.of).toBe('unreadable');
  });

  it('A VAULT BOTH NOT ADOPTED AND NOT LAID OUT AS THIS BUILD READS ONE, OR WHOSE STATE COULD NOT BE READ AS A VAULT\'S, IS UNREADABLE AND THE WALLET IS NOT ASKED', async () => {
    const layoutOver = { notesFromThisBuild: false, notesWhy: 'a field is missing' };
    for (const chain of [startedVault(layoutOver), startedVault({ account: null, started: false })]) {
      let asked = 0;
      const { doors } = doorsFor({ chain, adopted: [] });
      const counted = { ...(doors as object), onChain: async () => { asked += 1; return { holders: { adoptedVaults: [] } }; } } as never;
      const answer = await vaultFundableHere(counted, VAULT);
      /* RED WHEN: the adoption is judged before the read, so a vault that cannot be read is answered as not adopted. */
      expect(answer.of).toBe('unreadable');
      /* RED WHEN: the wallet is asked who holds the company for a vault whose read already cannot be relied on. */
      expect(asked).toBe(0);
    }
    /* RED WHEN: the vault both unadopted and wrongly laid out is answered with the adoption's sentence. */
    const both = await vaultFundableHere(doorsFor({ chain: startedVault(layoutOver), adopted: [] }).doors, VAULT);
    expect((both as { why: string }).why).toMatch(/not laid out the way this version of the product reads one.*\(a field is missing\)/);
  });

  it('A SERVICE THAT SAYS THE VAULT IS FUNDABLE DOES NOT MAKE AN UNSTARTED, UNADOPTED OR UNREADABLE ONE FUNDABLE', async () => {
    const served = { fundable: true, why: null, started: true, heldByCommittee: true, state: 'AAAA', notes: [], everCreated: [] };
    const started = doorsFor({ chain: startedVault({ started: false }), served });
    /* RED WHEN: the answer takes the start flag, or any verdict, from the company's service instead of the worker's read. */
    expect((await vaultFundableHere(started.doors, VAULT)).of).toBe('not-started');
    expect((await vaultFundableHere(doorsFor({ adopted: [], served }).doors, VAULT)).of).toBe('not-adopted');
    expect((await vaultFundableHere(doorsFor({ chain: new Error('down'), served }).doors, VAULT)).of).toBe('unreadable');
    expect([started.asked.service]).toEqual([0]);
  });
});

/** The four doors that move money and what each says when the answer is not fundable: today's words. */
const NOTE = { nonce: 'aa'.repeat(32), token: 'bb'.repeat(32), value: '5' };
const gates: ReadonlyArray<readonly [string, (doors: never) => Promise<unknown>, (reason: string) => RegExp, (reason: string) => RegExp]> = [
  ['a private deposit', (doors) => depositIntoCompanyVault(doors, VAULT, { token: 'bb'.repeat(32), value: 5n } as never),
    (reason) => new RegExp(`^${reason}$`, 'u'), (reason) => new RegExp(`^${reason}$`, 'u')],
  ['a public deposit', (doors) => depositPubliclyIntoCompanyVault(
    { ...(doors as object), service: { ...(doors as { service: object }).service, depositPublicly: async () => ({ txRef: 'r', transactionHash: null }) } } as never,
    VAULT, { token: 'bb'.repeat(32), value: 5n }),
  (reason) => new RegExp(`^${reason}$`, 'u'), (reason) => new RegExp(`^${reason}$`, 'u')],
  ['a private payment step', (doors) => mergeNotesInCompanyVault(doors, { vault: VAULT, notes: [NOTE, { ...NOTE, nonce: 'cc'.repeat(32) }] } as never),
    (reason) => new RegExp(`^the chain, as this device read it, does not show this vault, so its record is not opened here and nothing is paid out of it\\. Nothing was sent\\. Reason: ${reason}$`, 'u'),
    (reason) => new RegExp(`^No payment can be made out of this vault yet, so none was prepared or recorded\\. Nothing was sent\\. Reason: ${reason}$`, 'u')],
  ['a private payment', (doors) => payPrivatelyFromCompanyVault(doors, {
    order: { vault: VAULT, opensAt: '0', closesAt: '99999999999' } as never,
    payment: { kind: 'shielded', paid: false } as never,
  }),
  (reason) => new RegExp(`^the chain, as this device read it, does not show this vault, so its record is not opened here and nothing is paid out of it\\. Nothing was sent\\. Reason: ${reason}$`, 'u'),
  (reason) => new RegExp(`^No payment can be made out of this vault yet, so none was prepared or recorded\\. Nothing was sent\\. Reason: ${reason}$`, 'u')],
  ['a public payment', (doors) => payPubliclyFromCompanyVault(doors, {
    order: { vault: VAULT, opensAt: '0', closesAt: '99999999999' } as never,
    payment: { kind: 'unshielded', paid: false } as never,
  }),
  (reason) => new RegExp(`^the chain, as this device read it, does not show this vault, so nothing is paid out of it\\. Nothing was sent\\. Reason: ${reason}$`, 'u'),
  (reason) => new RegExp(`^No payment can be made out of this vault yet, so none was prepared or recorded\\. Nothing was sent\\. Reason: ${reason}$`, 'u')],
];
const escaped = (re: RegExp): string => re.source.replace(/^\^/u, '').replace(/\$$/u, '');

describe('EVERY DOOR THAT MOVES MONEY REFUSES ON THE ONE ANSWER, IN ITS OWN WORDS', () => {
  for (const [name, door, absent, refused] of gates) {
    it(`${name.toUpperCase()} IS REFUSED FOR A VAULT THE CHAIN DOES NOT SHOW, ONE PINNED ELSEWHERE, ONE NOT STARTED AND ONE THAT CANNOT BE READ AS A VAULT, BEFORE ANYTHING IS BUILT OR ASKED`, async () => {
      /* RED WHEN: this door decides for itself, or past the answer, or after it has built, chosen a coin, asked the wallet or written a line. */
      await expect(door(doorsFor({ chain: { onChain: false } }).doors)).rejects.toThrow(absent(NOT_ON_CHAIN.replace(/\./gu, '\\.')));
      await expect(door(doorsFor({ chain: startedVault({ account: OTHER_ACCOUNT }) }).doors)).rejects.toThrow(refused(escaped(NOT_PINNED)));
      await expect(door(doorsFor({ chain: startedVault({ started: false }) }).doors)).rejects.toThrow(refused(escaped(NOT_STARTED)));
      /* RED WHEN: a read that threw is taken as a vault pinned to nothing and refused in other words, or let through. */
      await expect(door(doorsFor({ chain: startedVault({ account: null, started: false }) }).doors)).rejects.toThrow(refused(escaped(NOT_PINNED)));
      /* RED WHEN: a vault both unadopted and wrongly laid out is refused as one not adopted - a class that tells the page to adopt it. */
      const both = await door(doorsFor({ chain: startedVault({ notesFromThisBuild: false, notesWhy: 'a field is missing' }), adopted: [] }).doors).catch((e: unknown) => e);
      expect(both).not.toBeInstanceOf(VaultNotTheCompanys);
      expect((both as Error).message).toMatch(/not laid out the way this version of the product reads one/);
      /* A ledger of another layout is refused, with the product's own sentence. */
      await expect(door(doorsFor({ chain: startedVault({ notesFromThisBuild: false, notesWhy: 'a field is missing' }) }).doors))
        .rejects.toThrow(/not laid out the way this version of the product reads one/);
    });

    it(`${name.toUpperCase()} STILL ENDS IN THE READ ERROR THAT STOPPED IT, AS ITS OWN CLASS`, async () => {
      /* RED WHEN: a wallet that cannot say who holds the company, or a vault not adopted, is turned into a plain refusal - the page can no longer tell it from a vault that is not ready. */
      const silent = await door(doorsFor({ adopted: new Error('the wallet is locked') }).doors).catch((e: unknown) => e);
      expect(silent).toBeInstanceOf(VaultNotTheCompanys);
      expect((silent as VaultNotTheCompanys).kind).toBe('wallet-silent');
      const unadopted = await door(doorsFor({ adopted: [] }).doors).catch((e: unknown) => e);
      expect(unadopted).toBeInstanceOf(VaultNotTheCompanys);
      expect((unadopted as VaultNotTheCompanys).kind).toBe('not-adopted');
      expect((unadopted as Error).message).toMatch(NOT_ADOPTED);
      /* RED WHEN: a read that fails on this device escapes as anything but `VaultNotReadHere`, which says the service is not asked in its place. */
      const failed = await door(doorsFor({ chain: new Error('the indexer did not answer') }).doors).catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(VaultNotReadHere);
      expect((failed as Error).message).toMatch(/could not read the vault from the chain \(the indexer did not answer\)\. The company's service is not asked in its place\. Nothing was sent\.$/);
    });
  }
});

describe('THE READS THAT SHARE THE ONE READ KEEP THEIR CLASSES AND WORDS', () => {
  const poolDoors = (stand: Stand) => ({ ...doorsFor(stand).doors as object } as never);
  const nothingToCheck = async () => {};

  it('THE READ A START IS CARRIED ON FROM TURNS A VAULT NOT READ OR NOT ADOPTED INTO A SETTING UP THAT DID NOT FINISH, AND STAYS A PLAIN REFUSAL FOR ONE NOT PINNED', async () => {
    /* RED WHEN: a vault not adopted, or one this device could not read, stops a start as anything but `VaultStartOwed`, which names the vault. */
    const unadopted = await openCompanyVaultPool(poolDoors({ adopted: [] }), VAULT, nothingToCheck).catch((e: unknown) => e);
    expect(unadopted).toBeInstanceOf(VaultStartOwed);
    expect((unadopted as VaultStartOwed).vault).toBe(VAULT);
    expect((unadopted as Error).message).toMatch(/this vault is not one your company's account has adopted/);
    const unread = await openCompanyVaultPool(poolDoors({ chain: new Error('the indexer did not answer') }), VAULT, nothingToCheck).catch((e: unknown) => e);
    expect(unread).toBeInstanceOf(VaultStartOwed);
    expect((unread as Error).message).toMatch(/could not read the vault from the chain \(the indexer did not answer\)/);
    /* RED WHEN: a vault pinned to another account, or to nothing, is let into the pool, or refused as a start that can be finished. */
    for (const chain of [startedVault({ account: OTHER_ACCOUNT }), startedVault({ account: null, started: false })]) {
      const e = await openCompanyVaultPool(poolDoors({ chain }), VAULT, nothingToCheck).catch((x: unknown) => x);
      expect(e).not.toBeInstanceOf(VaultStartOwed);
      expect((e as Error).message).toMatch(NOT_PINNED);
    }
    /* RED WHEN: a vault not laid out as this build's, or whose account could not be read, is let into the pool because the start read works out pinned alone. */
    const cannotBeRelied: ReadonlyArray<readonly [VaultOnChainOnTheWire, RegExp]> = [
      [startedVault({ notesFromThisBuild: false, notesWhy: 'a field is missing' }), /not laid out the way this version of the product reads one/],
      [startedVault({ account: null }), NOT_PINNED],
    ];
    for (const [chain, words] of cannotBeRelied) {
      const e = await openCompanyVaultPool(poolDoors({ chain, adopted: [] }), VAULT, nothingToCheck).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(VaultNotTheCompanys);
      expect((e as Error).message).toMatch(words);
    }
    /* RED WHEN: the vault the chain does not show yet is refused in other words than the chain's. */
    const absent = await openCompanyVaultPool(poolDoors({ chain: { onChain: false } }), VAULT, nothingToCheck).catch((e: unknown) => e);
    expect((absent as Error).message).toBe(NOT_ON_CHAIN);
  });

  it('A CHECK OF WHAT THIS BROWSER SENT SAYS THE CHAIN SHOWS NO VAULT IN THE CHAIN\'S OWN WORDS, WITHOUT ASKING WHO HOLDS IT', async () => {
    /* RED WHEN: the read for a vault the chain does not show carries other words, or a reason that is not the chain's. */
    const { doors } = doorsFor({ chain: { onChain: false }, adopted: new Error('never asked') });
    const e = await checkWhatThisBrowserSent(doors, VAULT).catch((x: unknown) => x);
    expect((e as Error).message).toBe(NOT_ON_CHAIN);
    expect(e).not.toBeInstanceOf(VaultNotTheCompanys);
  });

  it('THE OLD HAND-OVER FAILS IN ITS OWN WORDS WHATEVER THE SERVICE SAYS, AS A HAND-OVER NOT YET HELD', async () => {
    /* The service's chain answer no longer carries a verdict; an older service that still sends one is not believed. */
    const { doors } = doorsFor({ served: { why: 'a sentence from an older service', fundable: false, authority: { committee: [], threshold: 1, counter: '0', shape: 'committee' } } });
    const e = await createCompanyVaultByHandover(doors, VAULT).catch((x: unknown) => x);
    /* RED WHEN: a hand-over the page cannot carry out is refused as anything but `VaultHandoverOwed`, or in the service's sentence. */
    expect(e).toBeInstanceOf(VaultHandoverOwed);
    expect((e as Error).message).toMatch(/: the chain shows an authority this device cannot hand over\. No money can be put into it until it is\./);
    expect((e as Error).message).not.toMatch(/older service/);
  });
});

describe('A VAULT OR AN ACCOUNT WHOSE CIRCUITS ARE NOT THIS APP\'S TAKES AND PAYS OUT NO MONEY', () => {
  const vaultNot = { why: "no money goes in or out of this vault: its 'deposit' circuit is not the one this app's build compiled, so it would accept proofs this product never made. Nothing was sent.", circuit: 'deposit' };
  const accountNot = { why: "no money goes in or out of this vault, because the company's account it pays out on is not the one this app was built for: its 'setPolicy' circuit is not the one this app's build compiled, so it would accept proofs this product never made. Nothing was sent.", circuit: 'setPolicy' };
  const CHANGED = / If the company's super admins moved it to a newer build, it stays refused on this device until this device runs that build\.$/;

  it('THE ANSWER IS NOT-THIS-BUILD, NAMING THE CONTRACT AND THE CIRCUIT, FOR THE VAULT AND FOR ITS ACCOUNT', async () => {
    const vault = await vaultFundableHere(doorsFor({ chain: startedVault({ circuits: vaultNot }) }).doors, VAULT);
    /* RED WHEN: a vault whose deposit circuit is not this app's is answered fundable, or as anything a screen cannot tell from an unreadable one. */
    expect(vault).toMatchObject({ of: 'not-this-build', contract: 'vault', circuit: 'deposit', view: { vault: VAULT } });
    expect((vault as { why: string }).why.startsWith(vaultNot.why)).toBe(true);
    expect((vault as { why: string }).why).toMatch(CHANGED);
    const account = await vaultFundableHere(doorsFor({ chain: startedVault({ accountCircuits: accountNot }) }).doors, VAULT);
    /* RED WHEN: the account's circuits are not part of the answer - its vault then pays out on approvals its own circuits never asked for. */
    expect(account).toMatchObject({ of: 'not-this-build', contract: 'account', circuit: 'setPolicy' });
  });

  it('A VAULT NOT OF THIS BUILD THAT IS ALSO PINNED ELSEWHERE AND NOT STARTED IS ANSWERED NOT-THIS-BUILD, WITH THE NEWER-BUILD SENTENCE', async () => {
    for (const over of [{ circuits: vaultNot }, { accountCircuits: accountNot }]) {
      const answer = await vaultFundableHere(doorsFor({ chain: startedVault({ ...over, account: OTHER_ACCOUNT, started: false }) }).doors, VAULT);
      /* RED WHEN: a vault whose circuits are not this app's is answered pinned elsewhere or not started, which tell a screen nothing about updating the app. */
      expect(answer.of).toBe('not-this-build');
      /* RED WHEN: the refusal does not say that a vault moved to a newer build stays refused until this device runs it. */
      expect((answer as { why: string }).why).toMatch(CHANGED);
    }
  });

  it('A READ THAT DOES NOT SAY WHETHER THE CIRCUITS ARE THIS APP\'S IS REFUSED, NEVER PASSED', async () => {
    const { circuits: _v, ...noVaultWord } = startedVault() as Chain;
    const { accountCircuits: _a, ...noAccountWord } = startedVault() as Chain;
    /* RED WHEN: a read with no word on the vault's circuits is taken as this build's. */
    expect(await vaultFundableHere(doorsFor({ chain: noVaultWord as never }).doors, VAULT)).toMatchObject({ of: 'not-this-build', contract: 'vault', circuit: null });
    /* RED WHEN: a read with no word on the account's circuits is taken as this build's. */
    expect(await vaultFundableHere(doorsFor({ chain: noAccountWord as never }).doors, VAULT)).toMatchObject({ of: 'not-this-build', contract: 'account', circuit: null });
  });

  it('THE READ FOR MONEY NAMES THE COMPANY\'S ACCOUNT; THE READ A START IS CARRIED ON FROM NAMES NONE AND IS NOT REFUSED FOR CIRCUITS', async () => {
    const money = doorsFor();
    await vaultFundableHere(money.doors, VAULT);
    /* RED WHEN: the read money waits on does not ask the worker to check the company's account. */
    expect(money.inputs).toEqual([{ vault: VAULT, account: ACCOUNT, indexer: INDEXER }]);
    const start = doorsFor({ chain: startedVault({ circuits: vaultNot }) });
    const e = await openCompanyVaultPool(start.doors, VAULT, async () => {}).catch((x: unknown) => x);
    /* RED WHEN: a start reads the account, or is refused on the circuits, which only the money doors judge. */
    expect(start.inputs[0]).toEqual({ vault: VAULT, indexer: INDEXER });
    expect(String((e as Error)?.message ?? '')).not.toMatch(/circuit is not the one this app's build compiled/);
    const rebuild = doorsFor({ chain: startedVault({ circuits: vaultNot }) });
    const notes = await vaultNotesHere(rebuild.doors, VAULT);
    /* RED WHEN: a rebuild of the vault's notes reads the account, or is refused on the circuits, which only the money doors judge. */
    expect(rebuild.inputs[0]).toEqual({ vault: VAULT, indexer: INDEXER });
    expect(JSON.stringify(notes)).not.toMatch(/circuit is not the one this app's build compiled|whether the vault's circuits/);
  });

  for (const [name, door, , refused] of gates) {
    it(`${name.toUpperCase()} IS REFUSED FOR A VAULT OR AN ACCOUNT NOT OF THIS BUILD, BEFORE ANYTHING IS BUILT OR ASKED`, async () => {
      const escapedWhy = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      /* RED WHEN: this door moves money into or out of a vault whose circuits, or whose account's, are not this app's. */
      await expect(door(doorsFor({ chain: startedVault({ circuits: vaultNot }) }).doors)).rejects.toThrow(refused(`${escapedWhy(vaultNot.why)}.*`));
      await expect(door(doorsFor({ chain: startedVault({ accountCircuits: accountNot }) }).doors)).rejects.toThrow(refused(`${escapedWhy(accountNot.why)}.*`));
    });
  }
});
