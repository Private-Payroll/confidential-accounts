// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newSigningKeypair, newWrappingKeypair, type Hex } from '../../../../src/core/crypto.js';
import type { Asset, AssetRegistry } from '../../../../src/core/assets.js';
import { SealedNotePool } from '../../../../src/midnight/vault-pool.js';
import { HttpSealedPoolStore, pageWireSend } from 'vaults-web-shared/http-sealed-pool-store.js';

/*
 * A VAULT'S PRIVATE MONEY THROUGH THE ADAPTER, WITH THE SHARED READER AND THE
 * POOL AS THEY ARE. The keyring, the service and the page's vault worker are
 * stood in for. The pool is the product's own: sealed and wrapped to the
 * signer with `SealedNotePool`, filed signed through `HttpSealedPoolStore` to
 * a stand-in of the service's records route, and read back the same way, so
 * what is opened is opened with this signer's own secrets and believed only
 * when a signer on the roster filed it. `deviceVaultHoldings` compares it with
 * the chain's notes as it does for the legacy page's payments.
 */
const VAULT = 'ab'.repeat(32);
const TOKEN = 'c1'.repeat(32);
const OTHER_TOKEN = 'c2'.repeat(32);
const SIGNING = newSigningKeypair();
const WRAPPING = newWrappingKeypair();
const kr = vi.hoisted(() => ({
  signedIn: 'u1' as string | null,
  keys: null as Record<string, string> | null,
  roster: null as unknown,
  view: null as unknown,
  filed: null as unknown,
  asked: [] as string[],
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
  api: async (path: string) => {
    kr.asked.push(path);
    if (path === '/api/accounts/c1') return { id: 'c1' };
    if (path === `/api/accounts/c1/vaults/${VAULT}/chain`) {
      if (kr.view instanceof Error) throw kr.view;
      return kr.view;
    }
    throw new Error(`no answer for ${path}`);
  },
}));
vi.mock('./vault-builder.js', () => ({
  theVaultBuilder: async () => ({
    /* A note's commitment, worked out from the note alone, as the worker does. */
    commitments: async (i: { vault: string; coin: { nonce: string; token: string; value: string } }) => ({ output: '', held: `h${i.vault.slice(0, 2)}${i.coin.nonce.slice(2)}` }),
    paymentsFit: async () => ({ of: 'fits' }),
  }),
}));

const commitmentOf = (nonce: string) => `h${VAULT.slice(0, 2)}${nonce.slice(2)}`;
const asset = (code: string, decimals: number, shielded: string | null): Asset => ({
  code, name: code, kind: 'token', decimals, chain: 'midnight', ledger: { shielded, unshielded: null }, enabled: true, sortOrder: code.length,
} as unknown as Asset);
const registryOf = (list: Asset[]): AssetRegistry => ({
  all: () => list, enabled: () => list, find: (c) => list.find((a) => a.code === c) ?? null, require: (c) => list.find((a) => a.code === c)!,
});
const REGISTRY = registryOf([asset('TDUST', 6, TOKEN), asset('OTHER', 2, OTHER_TOKEN), asset('GBP', 2, null)]);

/** The service's records route: a filing is kept as it arrived, and the newest is handed back. */
const stubRecords = () => vi.stubGlobal('fetch', async (path: string, init: { method: string; body?: string }) => {
  const body = (b: unknown, status = 200) => ({ status, json: async () => b });
  if (init.method === 'PUT') {
    const wire = JSON.parse(init.body!);
    kr.filed = wire;
    return body({ filed: true, record: 'pool', version: wire.version, digest: wire.digest }, 201);
  }
  if (path === `/api/vaults/${VAULT}/records/pool`) return body({ record: 'pool', filed: kr.filed });
  return body({ error: 'no such route' }, 404);
});

/** The pool filed by `filer` and wrapped to `to`, holding `notes`. */
async function filePool(notes: Array<{ nonce: Hex; token: Hex; value: bigint }>, filer = SIGNING, to = WRAPPING.publicKey) {
  const store = new HttpSealedPoolStore('pool', pageWireSend(() => 'u1'), filer.secret, async () => new Set([filer.publicKey]));
  await new SealedNotePool(store, { signerId: 's1', wrappingSecret: WRAPPING.secret }, async () => [{ id: 's1', wrappingPublicKey: to }]).create(VAULT, { notes });
}

const NOTES = [
  { nonce: '01'.repeat(32) as Hex, token: TOKEN as Hex, value: 1_250_000n },
  { nonce: '02'.repeat(32) as Hex, token: TOKEN as Hex, value: 250_000n },
  { nonce: '03'.repeat(32) as Hex, token: 'c9'.repeat(32) as Hex, value: 7n },
  { nonce: '04'.repeat(32) as Hex, token: OTHER_TOKEN as Hex, value: 12_345n },
];
const chainHolding = (notes: typeof NOTES) => ({ onChain: true, notesFromThisBuild: true, notes: notes.map((n) => commitmentOf(n.nonce)) });

async function load() {
  vi.resetModules();
  return import('./vault-private-money.js');
}
beforeEach(() => {
  kr.signedIn = 'u1'; kr.filed = null; kr.asked = [];
  kr.keys = { signerId: 's1', signingSecret: SIGNING.secret, wrappingSecret: WRAPPING.secret, blinding: 'cc'.repeat(32) };
  kr.roster = { id: 'c1', signers: [{ id: 's1', userId: 'u1', name: 'Priya', status: 'active', signingPublicKey: SIGNING.publicKey, wrappingPublicKey: WRAPPING.publicKey }] };
  kr.view = chainHolding(NOTES);
  stubRecords();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('a vault\'s private money, read on this device', () => {
  /* RED WHEN: the notes of one token are not summed, a note of another token is counted, an amount is made with another asset's decimals or code, is not private, the amounts are not in the registry's order, or a currency it holds none of is listed. */
  it('sums the notes of each private token, as private amounts of that asset, and lists only what it holds', async () => {
    await filePool(NOTES);
    const { readVaultPrivateMoney } = await load();
    /* The kit's own module as the adapter reached it, after the reset. */
    const { formatTokenAmount, visibilityOf } = await import('vaults-ui/format/token-amount');
    const answer = await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY);
    expect(answer?.amounts.map((a) => [a.code, visibilityOf(a), formatTokenAmount(a, 'en')])).toEqual([['TDUST', 'private', '1.5'], ['OTHER', 'private', '123.45']]);
    const without = await readVaultPrivateMoney('u1', 'c1', VAULT, registryOf([asset('TDUST', 6, TOKEN), asset('GBP', 2, null), asset('NONE', 2, 'c8'.repeat(32))]));
    expect(without?.amounts.map((a) => a.code)).toEqual(['TDUST']);
  });

  /* RED WHEN: the chain is not asked for the vault named, through the company's own vault route. */
  it('asks the chain about the vault it was given, through the company\'s route', async () => {
    await filePool(NOTES);
    const { readVaultPrivateMoney } = await load();
    await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY);
    expect(kr.asked).toContain(`/api/accounts/c1/vaults/${VAULT}/chain`);
  });

  /* RED WHEN: a pool the chain contradicts, either way, is summed; or a chain that cannot be read, or read off a ledger of another shape, is taken as holding the pool's notes. */
  it('reads nothing when the pool and the chain disagree, or the chain cannot say', async () => {
    await filePool(NOTES);
    const { readVaultPrivateMoney } = await load();
    for (const [name, view] of [
      ['chain holds fewer', chainHolding(NOTES.slice(1))],
      ['chain holds more', { ...chainHolding(NOTES), notes: [...chainHolding(NOTES).notes, 'hffff'] }],
      ['another shape', { ...chainHolding(NOTES), notesFromThisBuild: false }],
      ['not on the chain', { onChain: false }],
      ['the service fails', new Error('down')],
    ] as const) {
      kr.view = view;
      expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY), name).toBeNull();
    }
  });

  /* RED WHEN: a vault with no pool filed is read as holding nothing. */
  it('reads nothing, rather than nothing held, for a vault with no pool', async () => {
    kr.view = chainHolding([]);
    const { readVaultPrivateMoney } = await load();
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY)).toBeNull();
  });

  /* RED WHEN: the pool is opened with anything but this signer's own wrapping secret, or a pool filed by a key the roster does not hold is believed. */
  it('opens the pool only with this signer\'s own secrets, and believes only a signer on the roster', async () => {
    await filePool(NOTES);
    const { readVaultPrivateMoney } = await load();
    kr.keys = { ...kr.keys!, wrappingSecret: newWrappingKeypair().secret };
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY), 'another wrapping secret').toBeNull();
    kr.keys = { ...kr.keys!, wrappingSecret: WRAPPING.secret };
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY), 'the same pool, with this signer\'s own secret').not.toBeNull();
    kr.filed = null;
    await filePool(NOTES, newSigningKeypair());
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY), 'filed by a stranger').toBeNull();
  });

  /* RED WHEN: somebody else signed in, or no keys for the company on this device, reads anything; or two assets naming one private token are read as either. */
  it('reads nothing for another person, without this company\'s keys, or when two assets name one token', async () => {
    await filePool(NOTES);
    const { readVaultPrivateMoney } = await load();
    kr.signedIn = 'u2';
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY), 'another person').toBeNull();
    kr.signedIn = 'u1';
    kr.keys = null;
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, REGISTRY), 'no keys').toBeNull();
    kr.keys = { signerId: 's1', signingSecret: SIGNING.secret, wrappingSecret: WRAPPING.secret, blinding: 'cc'.repeat(32) };
    expect(await readVaultPrivateMoney('u1', 'c1', VAULT, registryOf([asset('A', 6, TOKEN), asset('B', 6, TOKEN.toUpperCase())])), 'one token twice').toBeNull();
  });
});
