// @vitest-environment jsdom
import { seatOpenedFor } from '../../../../src/testing/directory-seats.js';
import { enteredHere } from '../../../../src/testing/records-entered.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newSigningKeypair, newWrappingKeypair, type Hex } from '../../../../src/core/crypto.js';
import type { Asset, AssetRegistry } from '../../../../src/core/assets.js';
import { SealedNotePool } from '../../../../src/midnight/vault-pool.js';
import { directoryEntryMade } from '../../../../src/midnight/seat-directory.js';
import { recordsKeypairFrom } from '../../../../src/midnight/company-nonce-secret.js';
import { HttpSealedPoolStore, pageWireSend } from 'vaults-web-shared/http-sealed-pool-store.js';
import { identityFromSecret } from 'midnight-identity';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { signDirectoryEntry, signRecordsKey } from 'midnight-identity/profile/records-key';
import type { CompanyLabel } from 'midnight-identity/profile/company-label';

/*
 * A VAULT'S PRIVATE MONEY THROUGH THE ADAPTER, WITH THE SHARED READER AND THE
 * POOL AS THEY ARE. The keyring, the service and the page's vault worker are
 * stood in for. The pool is the product's own: sealed and wrapped to the
 * signer with `SealedNotePool`, filed signed through `HttpSealedPoolStore` to
 * a stand-in of the service's records route, and read back the same way, so
 * what is opened is opened with this signer's own secrets and believed only
 * when a seat the company's directory names filed it, checked against who
 * holds the company as the person's own wallet reads it (stood in), with an
 * entry signed by a real wallet's committee key. `deviceVaultHoldings` compares it with
 * the chain's notes as it does for the legacy page's payments.
 */
const VAULT = 'ab'.repeat(32);
const TOKEN = 'c1'.repeat(32);
const OTHER_TOKEN = 'c2'.repeat(32);
const SIGNING = newSigningKeypair();
const WRAPPING = newWrappingKeypair();
const kr = vi.hoisted(() => ({
  /* The company's seat directory as the service serves it, and the seats the person's own wallet reads seated now. */
  filings: [] as unknown[],
  seated: [] as string[],
  committee: [] as unknown[],
  signedIn: 'u1' as string | null,
  keys: null as Record<string, string> | null,
  roster: null as unknown,
  view: null as unknown,
  /* What the wallet's ask of who holds the company does instead of answering, when a test says so. */
  holdersFail: null as Error | null,
  filed: null as unknown,
  /* The signing secret of the seat that filed the pool, which entered it in the company's records. */
  filedBy: null as string | null,
  asked: [] as string[],
  /* The company key this tab's wallet released, and the seat this signer's own key material makes. */
  companyKey: null as string | null,
  released: 0,
  ownSeat: '',
  /* The indexer the person's own wallet names, and every read of the vault this device's worker made. */
  indexer: null as { indexerUri: string; indexerWsUri: string } | null,
  readHere: [] as string[],
  /* Whether the account adopted the vault, as the wallet reads it, and the notes the vault worker's rebuild names. */
  adopted: false,
  refusePut: false,
  rebuilt: null as Array<{ nonce: string; token: string; value: string; held: string; output: string }> | null,
}));
vi.mock('./filing-judge.js', async (real) => ({
  ...(await real<typeof import('./filing-judge.js')>()),
  /* The company's keys as its directory gives them (`companyKeysFor`), stood in for by the one key of a company never changed. */
  companyKeysFor: async () => ({ epoch: 0, newest: 0, key: '5e'.repeat(32), keyAt: () => '5e'.repeat(32), sealing: () => ({ key: '5e'.repeat(32), epoch: 0 }) }),
}));
vi.mock('vaults-web-shared/keyring.js', async (real) => ({
  ...(await real<typeof import('vaults-web-shared/keyring.js')>()),
  currentUser: () => (kr.signedIn === null ? null : { id: kr.signedIn }),
  forgetLocally: () => {},
  resumeSession: async () => null,
  canOpenCompanies: () => true,
  reopenSavedKeys: async () => {},
  pendingSeatsFor: () => [],
  keysFor: () => kr.keys,
  openAccount: () => kr.roster,
  companyKeyReleasedFor: () => kr.companyKey,
  /* The wallet window that releases the company key: counted, and it releases the key when opened. */
  companyKeysForVaults: async () => { kr.released += 1; kr.companyKey = '11'.repeat(32); return { companyKey: kr.companyKey }; },
  /* The company's viewing key, which opens every directory entry's proof here. */
  viewingKeyFor: () => '5e'.repeat(32),
  holdersFromTheWallet: async () => {
    if (kr.holdersFail !== null) throw kr.holdersFail;
    return {
    holders: { committee: kr.committee, threshold: 1, seats: kr.seated, approvals: 1, adoptedVaults: kr.adopted ? [VAULT] : [], founding: SEAT, foundingCommittee: [{ tag: 'schnorr', value: '11'.repeat(32) }], account: 'c0'.repeat(32) },
    vault: null,
    /* The indexer the wallet reads through: the vault is read there on this device, and nowhere else. */
    indexer: kr.indexer,
    };
  },
  api: async (path: string, init?: RequestInit) => {
    kr.asked.push(path);
    if (path === '/api/accounts/c1') return { id: 'c1', companyLabel: `co_${'c1'.repeat(32)}`, contractAddress: 'c0'.repeat(32) };
    if (path === '/api/accounts/c1/directory') return { filings: kr.filings };
    /* The company's records: the pool filed, entered by the seat that filed it, and the chain holding no anchor yet. */
    if (path.startsWith('/api/accounts/c1/manifest/tree/pending?root=')) {
      if (kr.filed === null || kr.filedBy === null) return { entries: [] };
      const { fromWire } = await import('../../../../src/midnight/sealed-record-wire.js');
      const { signManifestEntry, vaultRecordEntry } = await import('../../../../src/midnight/record-manifest.js');
      const pool = fromWire(kr.filed, { vault: 'ab'.repeat(32), record: 'pool' }).sealed;
      return { entries: [signManifestEntry('c1', vaultRecordEntry('pool', pool), kr.filedBy as never)] };
    }
    /* Nothing anchored: every record proven absent from the empty tree. */
    if (path === '/api/accounts/c1/manifest/tree/proofs') {
      const b = JSON.parse(String(init?.body)) as { records: unknown[]; kinds: unknown[] };
      return { records: b.records.map(() => null), kinds: b.kinds.map(() => []), older: [], proof: { siblings: [] } };
    }
    if (path === '/api/accounts/c1/call-state') return { account: 'c0'.repeat(32), accountState: '00'.repeat(32), parameters: '', blockHash: 'b' };
    throw new Error(`no answer for ${path}`);
  },
}));
vi.mock('./vault-builder.js', () => ({
  theVaultBuilder: async () => ({
    /* A note's commitment, worked out from the note alone, as the worker does. */
    commitments: async (i: { vault: string; coin: { nonce: string; token: string; value: string } }) => ({ output: '', held: `h${i.vault.slice(0, 2)}${i.coin.nonce.slice(2)}` }),
    paymentsFit: async () => ({ of: 'fits' }),
    ownSeat: async () => kr.ownSeat,
    /* The leaf each directory entry's opening makes, as the worker works it out with the account's own compiled `signerLeaf`. */
    seatOpenings: async (input: { openings: readonly { publicKey: string; scope: string; blinding: string }[] }) => {
      const { leafOfTheContract } = await import('../../../../src/testing/directory-seats.js');
      return { openings: input.openings.map((o) => ({ leaf: leafOfTheContract(o as never), tag: null })) };
    },
    /* The account's own heads, and its history at the wallet's indexer: the stand-in chain holds no anchor. */
    anchorHeads: async (i: { after: unknown[] }) => ({ after: i.after.map(() => '00'.repeat(32)), seats: i.after.map(() => null) }),
    /* A chain holding no anchor: no head landed, and who holds the account named for an anchor nobody here sends. */
    anchorsOnChain: async () => ({ landed: [], now: { approvals: 1, signerRoot: '00'.repeat(32), signers: ['00'.repeat(32)] }, seatsNow: ['00'.repeat(32)] }),
    /* The vault as this device's worker reads it, at the indexer it is handed: the stand-in chain. */
    /* The vault worker's rebuild of the vault's notes, naming what a test says the records name. */
    vaultRebuilt: async () => {
      if (kr.rebuilt === null) throw new Error('no rebuild stood in here');
      return { held: kr.rebuilt, unexplained: [], copy: null, said: [] };
    },
    vaultOnChain: async (i: { vault: string; indexer: { indexerUri: string } }) => {
      kr.readHere.push(`${i.vault} at ${i.indexer.indexerUri}`);
      if (kr.view instanceof Error) throw kr.view;
      return kr.view;
    },
  }),
}));

const commitmentOf = (nonce: string) => `h${VAULT.slice(0, 2)}${nonce.slice(2)}`;
/** A row for a token: private where `shielded` is given (its token), else a public-only token named by `publicToken`. */
const asset = (symbol: string, decimals: number, shielded: string | null, publicToken = '00'.repeat(32)): Asset => ({
  code: shielded ?? publicToken, symbol, name: symbol, decimals,
  ledger: { shielded, unshielded: shielded === null ? publicToken : null }, enabled: true, sortOrder: symbol.length,
});
const registryOf = (list: Asset[]): AssetRegistry => ({
  all: () => list, enabled: () => list, find: (c) => list.find((a) => a.code === c) ?? null, require: (c) => list.find((a) => a.code === c)!,
});
const REGISTRY = registryOf([asset('TDUST', 6, TOKEN), asset('OTHER', 2, OTHER_TOKEN), asset('NIGHT', 6, null)]);

/** The service's records route: a filing is kept as it arrived, and the newest is handed back. */
const stubRecords = () => vi.stubGlobal('fetch', async (path: string, init: { method: string; body?: string }) => {
  const body = (b: unknown, status = 200) => ({ status, json: async () => b });
  if (init.method === 'PUT') {
    if (kr.refusePut) return body({ error: 'a viewer files no vault record' }, 403);
    const wire = JSON.parse(init.body!);
    kr.filed = wire;
    return body({ filed: true, record: 'pool', version: wire.version, digest: wire.digest }, 201);
  }
  if (path === `/api/vaults/${VAULT}/records/pool`) return body({ record: 'pool', filed: kr.filed });
  return body({ error: 'no such route' }, 404);
});

/* Priya's seat, and her entry in the directory, signed by her own wallet's committee key. */
const LABEL = `co_${'c1'.repeat(32)}` as CompanyLabel;
const PRIYA = identityFromSecret(new Uint8Array(32).fill(1));
const COMMITTEE_KEY = committeeKeyFor(PRIYA, LABEL) as { tag: string; value: string };
/* Her seat, made for her wallet's key, and the opening her entry carries. */
const { seat: SEAT, opening: OPENING } = seatOpenedFor(COMMITTEE_KEY, 1);
/* Its proof sealed under the company's viewing key, which this device unwraps. */
const ENTRY = directoryEntryMade({
  company: 'c1', person: 'u1', committeeKey: COMMITTEE_KEY, opening: OPENING, signingSecret: SIGNING.secret, viewingKey: '5e'.repeat(32) as Hex,
  signed: signDirectoryEntry(PRIYA, LABEL, 'c0'.repeat(32) as never, new Uint8Array(32).fill(0x11), SIGNING.publicKey, SEAT),
});
/* Her records key for her seat, as her wallet signed it in the same press: the roster carries it. */
const ATTESTED = signRecordsKey(PRIYA, LABEL, 'c0'.repeat(32) as never, new Uint8Array(32).fill(0x11), SEAT);
const VAULT_KEYS = { committeeKey: COMMITTEE_KEY, recordsKey: ATTESTED.recordsKey, recordsKeySeat: SEAT, recordsKeyStatement: ATTESTED.signature };

/* The records key Priya's wallet gives for the company: her directory entry names it, and the pool is wrapped to it under her seat. */
const COMPANY_KEY = '11'.repeat(32);
const RECORDS = recordsKeypairFrom(new Uint8Array(32).fill(0x11));

/** The pool filed by `filer`, wrapped under `seat` to `to`, holding `notes`. */
async function filePool(notes: Array<{ nonce: Hex; token: Hex; value: bigint }>, filer = SIGNING, to = RECORDS.publicKey, seat = SEAT) {
  const store = new HttpSealedPoolStore('pool', pageWireSend(() => 'u1'), filer.secret, async () => () => null, enteredHere());
  kr.filedBy = filer.secret;
  await new SealedNotePool(store, { signerId: seat, wrappingSecret: RECORDS.secret }, async () => [{ id: seat, wrappingPublicKey: to }]).create(VAULT, { notes });
}

const NOTES = [
  { nonce: '01'.repeat(32) as Hex, token: TOKEN as Hex, value: 1_250_000n },
  { nonce: '02'.repeat(32) as Hex, token: TOKEN as Hex, value: 250_000n },
  { nonce: '03'.repeat(32) as Hex, token: 'c9'.repeat(32) as Hex, value: 7n },
  { nonce: '04'.repeat(32) as Hex, token: OTHER_TOKEN as Hex, value: 12_345n },
];
const chainHolding = (notes: typeof NOTES) => ({ onChain: true, notesFromThisBuild: true, notes: notes.map((n) => commitmentOf(n.nonce)) });

/** What a read found, when it found amounts. */
function heldOf(answer: Awaited<ReturnType<typeof import('./vault-private-money.js').readVaultPrivateMoney>>) {
  if (answer.of !== 'held') throw new Error(`the read found ${answer.of}, not amounts`);
  return answer;
}
const COULD_NOT = (why: string) => ({ of: 'unreadable', why });

async function load() {
  vi.resetModules();
  return import('./vault-private-money.js');
}
beforeEach(() => {
  kr.signedIn = 'u1'; kr.released = 0; kr.filed = null; kr.asked = []; kr.companyKey = COMPANY_KEY; kr.ownSeat = SEAT; kr.readHere = []; kr.adopted = false; kr.rebuilt = null; kr.refusePut = false; kr.holdersFail = null;
  kr.indexer = { indexerUri: 'https://indexer.wallet.example/api/v3/graphql', indexerWsUri: 'wss://indexer.wallet.example/api/v3/graphql/ws' };
  kr.filings = [{ company: 'c1', version: 1, change: { kind: 'claim', entry: ENTRY } }];
  kr.seated = [SEAT];
  kr.committee = [COMMITTEE_KEY];
  kr.keys = { signerId: 's1', signingSecret: SIGNING.secret, wrappingSecret: WRAPPING.secret, blinding: 'cc'.repeat(32) };
  kr.roster = { id: 'c1', signers: [{ id: 's1', userId: 'u1', name: 'Priya', status: 'active', signingPublicKey: SIGNING.publicKey, wrappingPublicKey: WRAPPING.publicKey, vaultKeys: VAULT_KEYS }] };
  kr.view = chainHolding(NOTES);
  stubRecords();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('a vault\'s private money, read on this device', () => {
  /* RED WHEN: the notes of one token are not summed, a note of another token is counted, an amount is made with another asset's decimals or symbol, or with the token where its symbol goes, is not private, the amounts are not in the registry's order, or a currency it holds none of is listed. */
  it('sums the notes of each private token, as private amounts of that asset, and lists only what it holds', async () => {
    await filePool(NOTES);
    const { readVaultPrivateMoney } = await load();
    /* The kit's own module as the adapter reached it, after the reset. */
    const { formatTokenAmount, visibilityOf } = await import('vaults-ui/format/token-amount');
    const answer = await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY);
    expect(heldOf(answer).amounts.map((a) => [a.symbol, visibilityOf(a), formatTokenAmount(a, 'en')])).toEqual([['TDUST', 'private', '1.5'], ['OTHER', 'private', '123.45']]);
    const without = await readVaultPrivateMoney('u1', 'c1', VAULT, registryOf([asset('TDUST', 6, TOKEN), asset('NIGHT', 6, null), asset('NONE', 2, 'c8'.repeat(32))]));
    expect(heldOf(without).amounts.map((a) => a.symbol)).toEqual(['TDUST']);
  });

  /* RED WHEN: a vault holding money in a token the app's list of assets does not name shows that money as nothing, or adds it to another token, or is not counted, or counts a token twice for two notes of it, or counts a token it holds none of. */
  it('counts the tokens it holds that no asset names, one for each token, and shows no figure for them', async () => {
    const extra = { nonce: '05'.repeat(32) as Hex, token: 'c9'.repeat(32) as Hex, value: 3n };
    const zero = { nonce: '06'.repeat(32) as Hex, token: 'ca'.repeat(32) as Hex, value: 0n };
    const notes = [...NOTES, extra, zero];
    kr.view = chainHolding(notes);
    await filePool(notes);
    const { readVaultPrivateMoney } = await load();
    const answer = heldOf(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY));
    expect(answer.unrecognised).toBe(1);
    expect(answer.amounts.map((a) => a.symbol)).toEqual(['TDUST', 'OTHER']);
    /* Naming that token in the list of assets makes it an amount and leaves nothing to count. */
    const named = heldOf(await readVaultPrivateMoney('u1', 'c1', VAULT, registryOf([asset('TDUST', 6, TOKEN), asset('OTHER', 2, OTHER_TOKEN), asset('NINE', 0, 'c9'.repeat(32))])));
    expect(named.unrecognised).toBe(0);
    expect(named.amounts.map((a) => a.symbol)).toEqual(['TDUST', 'OTHER', 'NINE']);
  });

  /* RED WHEN: the chain is not asked for the vault named, through the company's own vault route. */
  it('reads the vault it was given on this device, at the indexer the person\'s own wallet names, and never asks the service', async () => {
    await filePool(NOTES);
    const { readVaultPrivateMoney } = await load();
    expect((await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY)).of).toBe('held');
    /* RED WHEN: the vault's notes are read from the service's route, or from any indexer but the wallet's, or for another vault. */
    expect(kr.readHere.length).toBeGreaterThan(0);
    expect(new Set(kr.readHere)).toEqual(new Set([`${VAULT} at ${kr.indexer!.indexerUri}`]));
    expect(kr.asked.filter((p) => p.endsWith('/chain'))).toEqual([]);
    /* RED WHEN: a wallet that names no indexer has the vault read somewhere else, or its money shown as read. */
    kr.indexer = null;
    kr.readHere = [];
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY)).toEqual(COULD_NOT('chain'));
    expect(kr.readHere).toEqual([]);
  });

  /* RED WHEN: a pool the chain contradicts is summed or shown as a failed read; or a chain that cannot be read, or is read off a ledger of another shape, is taken as holding the pool's notes, or either is shown for the other. */
  it('says the record is not believed when it claims a note the chain does not hold, and says why it could not read when the chain cannot say', async () => {
    await filePool(NOTES);
    const { readVaultPrivateMoney } = await load();
    for (const [name, view, found] of [
      ['chain holds fewer', chainHolding(NOTES.slice(1)), { of: 'not-believed' }],
      ['another shape', { ...chainHolding(NOTES), notesFromThisBuild: false }, COULD_NOT('layout')],
      ['not on the chain', { onChain: false }, COULD_NOT('chain')],
      ['the service fails', new Error('down'), COULD_NOT('chain')],
    ] as const) {
      kr.view = view;
      expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY), name).toEqual(found);
    }
  });

  /* RED WHEN: a wallet that did not answer the ask of who holds the company is shown as a network that could not be reached, or as a record not believed. */
  it('says the wallet did not answer when its ask of who holds the company is declined, closed or silent', async () => {
    await filePool(NOTES);
    const { readVaultPrivateMoney } = await load();
    /* The wallet's refusal as the adapter, loaded afresh, knows it. */
    const { WalletClosed } = await import('vaults-web-shared/wallet-sign-in.js');
    for (const refusal of [{ of: 'declined' }, { of: 'window-gone' }, { of: 'silent' }] as const) {
      kr.holdersFail = new WalletClosed(refusal, 'the wallet did not answer');
      expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY), refusal.of).toEqual(COULD_NOT('wallet-refused'));
    }
    /* A wallet window is not opened to ask again: the read only reports. */
    expect(kr.released).toBe(0);
  });

  /* RED WHEN: a note the chain holds and nothing on this device names - anyone's deposit - stops the read: one stranger would hide a funded vault's money. */
  it('reads the pool\'s notes when the chain also holds a note nothing here names, and does not count that note', async () => {
    await filePool(NOTES);
    const { readVaultPrivateMoney } = await load();
    kr.view = { ...chainHolding(NOTES), notes: [...chainHolding(NOTES).notes, 'hffff'] };
    const { visibilityOf: _v, formatTokenAmount } = await import('vaults-ui/format/token-amount');
    const answer = await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY);
    expect(heldOf(answer).amounts.map((a) => [a.symbol, formatTokenAmount(a, 'en')])).toEqual([['TDUST', '1.5'], ['OTHER', '123.45']]);
  });

  /* RED WHEN: a note the chain holds that the vault's records name, and this device's pool does not hold, is not counted: a deposit made from another signer's device is out of reach here. */
  it('counts a note the vault\'s records name that this device\'s pool does not hold, and still counts nothing nothing names', async () => {
    await filePool(NOTES);
    const { readVaultPrivateMoney } = await load();
    const other = { nonce: 'f1'.repeat(32), token: TOKEN, value: '500000' };
    kr.adopted = true;
    kr.rebuilt = [...NOTES, other].map((n) => ({ nonce: n.nonce, token: n.token, value: String(n.value), held: commitmentOf(n.nonce), output: '' }));
    kr.view = { ...chainHolding(NOTES), notes: [...chainHolding(NOTES).notes, commitmentOf(other.nonce), 'hffff'], account: 'c0'.repeat(32), started: true, everCreated: [], nonceCommitment: '5c'.repeat(32), splitJournal: [] };
    const { formatTokenAmount } = await import('vaults-ui/format/token-amount');
    /* A seat that may not file the vault's record still counts what the rebuild found; nothing is filed. */
    kr.refusePut = true;
    const counted = await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY);
    expect(heldOf(counted).amounts.map((a) => [a.symbol, formatTokenAmount(a, 'en')])).toEqual([['TDUST', '2'], ['OTHER', '123.45']]);
    expect((kr.filed as { version: number }).version).toBe(1);
    /* A seat that may file files it for every signer's device. */
    kr.refusePut = false;
    const answer = await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY);
    expect(heldOf(answer).amounts.map((a) => [a.symbol, formatTokenAmount(a, 'en')])).toEqual([['TDUST', '2'], ['OTHER', '123.45']]);
    expect((kr.filed as { version: number }).version).toBe(2);
  });

  /* RED WHEN: a vault whose pool was never opened and whose chain holds no note is shown as a failed read, or as holding an amount of zero in each token. */
  it('says nothing is held yet for a vault whose pool was never opened and which holds no note', async () => {
    kr.view = chainHolding([]);
    const { readVaultPrivateMoney } = await load();
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY)).toEqual({ of: 'nothing-yet' });
  });

  /* RED WHEN: a vault with no pool on this device, whose chain holds a note, is shown as holding nothing yet: money may be there that this device cannot see. */
  it('says it could not read, never nothing held, when the chain holds a note and this device has no record of the vault\'s notes', async () => {
    kr.view = chainHolding(NOTES.slice(0, 1));
    const { readVaultPrivateMoney } = await load();
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY)).toEqual(COULD_NOT('record'));
  });

  /* RED WHEN: a pool filed by a key no seat of the company holds, or by a seat no longer seated, is believed, or is shown as a failed read instead of a record not believed. */
  it('says the record was not believed when a stranger or a seat no longer seated filed it', async () => {
    const { readVaultPrivateMoney } = await load();
    await filePool(NOTES, newSigningKeypair());
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY), 'filed by a stranger').toEqual({ of: 'not-believed' });
    kr.filed = null;
    await filePool(NOTES);
    kr.seated = [];
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY), 'filed by a seat no longer seated').toEqual({ of: 'not-believed' });
  });

  /* RED WHEN: the pool is opened with anything but the records key this signer's wallet released, under their own seat - the roster's wrapping secret, another company key or another seat - or a pool filed by a key no directory entry names, or by a seat no longer seated, is believed. */
  it('opens the pool only with the records key this signer\'s wallet released, under their own seat, and believes only a seat the directory names and the chain holds now', async () => {
    await filePool(NOTES);
    const { readVaultPrivateMoney } = await load();
    kr.companyKey = '22'.repeat(32);
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY), 'another company key').toEqual(COULD_NOT('other'));
    kr.companyKey = null;
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY), 'no company key released in this tab').toEqual(COULD_NOT('no-keys'));
    /* RED WHEN: reading a vault's money opens a wallet window to release the company key. */
    expect(kr.released, 'a read opened a wallet window').toBe(0);
    kr.companyKey = COMPANY_KEY;
    kr.ownSeat = '6b'.repeat(32);
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY), 'another seat').toEqual(COULD_NOT('other'));
    kr.ownSeat = SEAT;
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY), 'the same pool, with this signer\'s own records key').toMatchObject({ of: 'held' });
    /* A pool wrapped to the roster's key, as before this change, does not open. */
    kr.filed = null;
    await filePool(NOTES, SIGNING, WRAPPING.publicKey, 's1');
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY), 'wrapped to the roster key').toEqual(COULD_NOT('other'));
  });

  /* RED WHEN: a read asks the wallet to release the company key, or a deposit that may ask does not, or the seat it gives is not this signer's own. */
  it('gives this signer\'s seat and records with the company key this tab holds, asking the wallet for it only when the caller may', async () => {
    const { seatAndRecordsHere } = await load();
    kr.companyKey = null;
    let asked = 0;
    expect(await seatAndRecordsHere('u1', 'c1'), 'a read with no company key').toBe('no-keys-here');
    const here = await seatAndRecordsHere('u1', 'c1', async () => { asked += 1; kr.companyKey = COMPANY_KEY; });
    expect(asked).toBe(1);
    expect(typeof here === 'string' ? here : [here.mine.signerId, here.company, here.account, here.companyKey]).toEqual([SEAT.toLowerCase(), LABEL, 'c0'.repeat(32), COMPANY_KEY]);
    expect(await seatAndRecordsHere('u1', 'c1', async () => { asked += 1; }), 'a key already held is not asked for again').not.toBe('no-keys-here');
    expect(asked).toBe(1);
    kr.signedIn = 'u2';
    expect(await seatAndRecordsHere('u1', 'c1', async () => { asked += 1; }), 'another person').toBe('not-signed-in');
    expect(asked).toBe(1);
  });

  /* RED WHEN: somebody else signed in, or no keys for the company on this device, reads anything, or no keys is shown as a record not believed; or two assets naming one private token are read as either. */
  it('reads nothing for another person, says no keys without this company\'s keys, and reads nothing when two assets name one token', async () => {
    await filePool(NOTES);
    const { readVaultPrivateMoney } = await load();
    kr.signedIn = 'u2';
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY), 'another person').toEqual(COULD_NOT('other'));
    kr.signedIn = 'u1';
    kr.keys = null;
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY), 'no keys').toEqual(COULD_NOT('no-keys'));
    kr.keys = { signerId: 's1', signingSecret: SIGNING.secret, wrappingSecret: WRAPPING.secret, blinding: 'cc'.repeat(32) };
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, registryOf([asset('A', 6, TOKEN), asset('B', 6, TOKEN.toUpperCase())])), 'one token twice').toEqual(COULD_NOT('other'));
  });
});
