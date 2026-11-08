/**
 * A SIGNER WHO FILES THE VAULT'S SECRET WRAPPED TO EVERYONE BUT THEMSELVES, THEN LEAVES, STILL HOLDS IT.
 *
 * Any seat may file a version of the vault's nonce-secret record, and what it says about who can open it and which
 * removal count it is good for is the filer's own word. Here a signer about to be removed files the same secret wrapped
 * to everyone but themselves and good for the next removal, and is then removed. The rotation and the deposit gate
 * read only the chain: a removal counted since the secret was set owes a new secret and refuses the deposit, on every
 * device, whatever a version says. The chain's reads stand in over one stand-in chain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toHex, type Hex } from '../../../src/core/crypto.js';
import { MemorySealedPoolStore, SealedNotePool, type SealedPool } from '../../../src/midnight/vault-pool.js';
import { admitToNonceSecret, newNonceSecret, openNonceSecrets, recordsKeypairFrom, refileNonceSecret, rotateNonceSecret, startNonceSecret } from '../../../src/midnight/company-nonce-secret.js';
import { sealSecretCopy } from '../../../src/midnight/sealed-secret-copy.js';
import type { WireRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { RunKept } from './vault-doors.js';
import { VaultSecretBeingChanged, depositCoinOnThisDevice, recordsReaderOf } from './deposit-on-device.js';

const chain = vi.hoisted(() => ({
  commitment: '', written: '', secret: '', copiesTo: [] as string[], removals: 0, stayers: [] as string[], raised: [] as string[],
  /** The account's removal count when the run that set the vault's secret was raised. */
  setAt: 0,
}));
/** The stand-in commitment to a secret: its own bytes turned round, never the secret itself. */
const commitmentOf = vi.hoisted(() => (secret: string) => `c${secret.split('').reverse().join('').slice(1)}`);

vi.mock('./company-key-here.js', async (orig) => ({ ...(await orig<object>()), removalWaitsHere: async () => ({ state: 'not-needed' }) }));
vi.mock('./vault-read-here.js', async (orig) => ({
  ...(await orig<object>()),
  theVaultReadForItsStart: async () => ({ view: { onChain: true, state: 'S', nonceCommitment: chain.commitment }, refusal: null }),
}));
vi.mock('./removals-on-the-chain.js', () => ({ removalsOnTheChainHere: async () => chain.removals }));
vi.mock('./vault-secret-run-record.js', async (orig) => ({ ...(await orig<object>()), heldSecretsOf: async () => [] }));
vi.mock('./vault-start-steps.js', async (orig) => ({
  ...(await orig<object>()),
  standingNow: async (_d: unknown, _v: unknown, run: { secret: string }) => ({ run: { commitment: commitmentOf(run.secret) }, standing: { secret: { rootIsThisRuns: true, run: null } } }),
}));
vi.mock('./vault-secret-run.js', async (orig) => ({
  ...(await orig<object>()),
  readersNow: async () => chain.stayers,
  raiseASecretRunHere: async (_d: unknown, _v: string, secret: string) => { chain.raised.push(secret); throw new Error('raised'); },
}));

const { vaultSecretsRotatedHere } = await import('./vault-secret-rotated-here.js');

const VAULT = 'ab'.repeat(32) as Hex;
const TOKEN = 'aa'.repeat(32) as Hex;
const keyOf = (n: number) => new Uint8Array(32).fill(0x40 + n);
const ADA = keyOf(1); const BO = keyOf(2); const LEE = keyOf(3); const DEE = keyOf(4);
const pk = (k: Uint8Array) => recordsKeypairFrom(k).publicKey.toLowerCase();

const storesFor = () => {
  const s = new Map<WireRecord, MemorySealedPoolStore>();
  return (r: WireRecord) => s.get(r) ?? s.set(r, new MemorySealedPoolStore()).get(r)!;
};

/** The chain's sealed copy of the secret it holds now, for one reader, as a worker reads it. */
const copyOnTheChain = (reader: string) => ({
  commitment: chain.commitment,
  parts: chain.copiesTo.includes(reader.toLowerCase())
    ? sealSecretCopy({ vault: VAULT, secret: chain.secret as Hex, reader: reader as Hex }).map((p) => toHex(p)) : null,
});

/** The stand-in chain's removal count before it set the vault's secret, as a worker reads it off the chain's history. */
const secretSet = () => chain.setAt;

/** A signer's device (Ada's unless said): their records, an empty wallet, and the chain as their worker reads it. */
const adasDevice = (records: ReturnType<typeof storesFor>, key = ADA) => ({
  me: { signerId: 'ada', wrappingSecret: '01'.repeat(32), companyKey: key },
  account: 'ac'.repeat(32),
  indexer: async () => ({ indexerUri: 'https://indexer.example', indexerWsUri: 'wss://indexer.example' }),
  records,
  secretKeptHere: {
    keep: async () => undefined, held: async () => null, drop: async () => undefined,
    keepRun: async () => undefined, runsHeld: async (): Promise<RunKept[]> => [],
  },
  material: { signingSecret: '11'.repeat(32) },
  directory: async () => ({ dir: { seats: [] } }),
  leaving: async () => new Set<string>(),
  builder: {
    secretSetAt: async () => secretSet(),
    secretIsTheVaults: async (i: { secret: string }) => commitmentOf(i.secret) === chain.commitment,
    ownChainCopy: async (i: { reader: string }) => copyOnTheChain(i.reader),
  },
}) as never;

/**
 * The vault's secret set on the chain with its copies sealed to `onTheChain`, and filed for `filedTo`; then Lee, still
 * seated, files the same secret wrapped to Ada and Bo only, good for one removal more than the chain has counted.
 */
const leeFilesHimselfOut = async (records: ReturnType<typeof storesFor>, onTheChain: Uint8Array[], filedTo: Uint8Array[]) => {
  const store = records('nonce-secret');
  const first = startNonceSecret(VAULT, onTheChain.map((k) => recordsReaderOf(k)), 0);
  await store.put(VAULT, first);
  const s1 = openNonceSecrets(first, VAULT, recordsKeypairFrom(ADA)).secrets[0]!;
  Object.assign(chain, { commitment: commitmentOf(s1), written: commitmentOf(s1), secret: s1, copiesTo: onTheChain.map(pk) });
  if (filedTo.length > onTheChain.length) {
    await store.put(VAULT, admitToNonceSecret(first, VAULT, recordsKeypairFrom(ADA), filedTo.filter((k) => !onTheChain.includes(k)).map((k) => recordsReaderOf(k))));
  }
  const his = refileNonceSecret((await store.get(VAULT))!, VAULT, recordsKeypairFrom(LEE), (await store.get(VAULT))!.version + 1, 1);
  const out: SealedPool = { ...his, wrapped: his.wrapped.filter((w) => w.signerId !== pk(LEE)) };
  await store.put(VAULT, out);
  Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO)] });
  return s1;
};

const depositFrom = async (records: ReturnType<typeof storesFor>, key = ADA) => {
  const w = recordsKeypairFrom(key);
  const me = { signerId: 'ada', wrappingSecret: w.secret, companyKey: key };
  const signers = async () => [{ id: 'ada', wrappingPublicKey: w.publicKey }];
  await new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: me.wrappingSecret }, signers).create(VAULT, { notes: [] });
  return depositCoinOnThisDevice({
    vault: VAULT, money: { token: TOKEN, value: 5n }, me, signers, records,
    chain: {
      everCreated: new Set(), outputCommitmentOf: () => 'none', heldNow: () => false, removals: chain.removals,
      secretIsTheVaults: (s) => commitmentOf(s) === chain.commitment,
      secretSet: async () => secretSet(),
    },
  });
};

beforeEach(() => { Object.assign(chain, { removals: 0, stayers: [pk(ADA), pk(BO), pk(LEE)], raised: [], setAt: 0 }); });

describe('a signer who files the vault\'s secret wrapped to everyone but themselves, then leaves', () => {
  it('STILL OWES A NEW SECRET AND STOPS EVERY DEPOSIT, WHEN THE CHAIN SEALED THE SECRET TO THEM', async () => {
    const records = storesFor();
    await leeFilesHimselfOut(records, [ADA, BO, LEE], [ADA, BO, LEE]);
    const [hook] = await vaultSecretsRotatedHere(adasDevice(records), [VAULT], 'finish');
    expect(hook, 'RED WHEN: the vault\'s secret is kept after a removal because the leaver\'s own filing says they cannot open it')
      .toMatchObject({ state: 'owed' });
    await expect(depositFrom(records), 'RED WHEN: a deposit is made under a secret the leaver holds')
      .rejects.toBeInstanceOf(VaultSecretBeingChanged);
  });

  it('STILL OWES A NEW SECRET AND STOPS EVERY DEPOSIT, WHEN ONLY AN EARLIER RECORD GAVE THEM THE SECRET', async () => {
    const records = storesFor();
    await leeFilesHimselfOut(records, [ADA, BO], [ADA, BO, LEE]);
    const [hook] = await vaultSecretsRotatedHere(adasDevice(records), [VAULT], 'finish');
    expect(hook, 'RED WHEN: a secret an earlier record gave the leaver is kept because the newest record leaves them out')
      .toMatchObject({ state: 'owed' });
    const [press] = await vaultSecretsRotatedHere(adasDevice(records), [VAULT], 'raise');
    expect([press!.state, chain.raised.length], 'RED WHEN: a press finds nothing owed and raises no new secret').toEqual(['not-rotated', 1]);
    await expect(depositFrom(records), 'RED WHEN: a deposit is made under a secret the leaver holds')
      .rejects.toBeInstanceOf(VaultSecretBeingChanged);
  });

  it('STILL OWES A NEW SECRET AND STOPS EVERY DEPOSIT, WHEN ONLY THE CHAIN\'S SEALED COPIES SHOW THEY WERE GIVEN THE SECRET', async () => {
    const records = storesFor();
    const store = records('nonce-secret');
    const first = startNonceSecret(VAULT, [ADA, BO, LEE].map((k) => recordsReaderOf(k)), 0);
    await store.put(VAULT, first);
    const s2 = newNonceSecret();
    await store.put(VAULT, rotateNonceSecret(first, VAULT, recordsKeypairFrom(LEE),
      { remaining: [ADA, BO].map((k) => recordsReaderOf(k)), leaving: [recordsReaderOf(LEE)] }, s2, 1));
    Object.assign(chain, { commitment: commitmentOf(s2), written: commitmentOf(s2), secret: s2, copiesTo: [pk(ADA), pk(BO), pk(LEE)] });
    Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO)] });
    const [hook] = await vaultSecretsRotatedHere(adasDevice(records), [VAULT], 'finish');
    expect(hook, 'RED WHEN: a secret the chain sealed to the leaver is kept because no record of it names them')
      .toMatchObject({ state: 'owed' });
    await expect(depositFrom(records), 'RED WHEN: a deposit is made under a secret the chain sealed to the leaver')
      .rejects.toBeInstanceOf(VaultSecretBeingChanged);
  });

  it('STILL OWES A NEW SECRET AND STOPS EVERY DEPOSIT ON A DEVICE ADMITTED BY THE LEAVER\'S OWN VERSION, WHICH CANNOT OPEN THE RECORD THAT GAVE THEM THE SECRET', async () => {
    const records = storesFor();
    const store = records('nonce-secret');
    const first = startNonceSecret(VAULT, [ADA, BO].map((k) => recordsReaderOf(k)), 0);
    await store.put(VAULT, first);
    const s1 = openNonceSecrets(first, VAULT, recordsKeypairFrom(ADA)).secrets[0]!;
    Object.assign(chain, { commitment: commitmentOf(s1), written: commitmentOf(s1), secret: s1, copiesTo: [pk(ADA), pk(BO)] });
    /* Lee is given the secret by a record alone, then files it good for one removal more and admits Dee, leaving himself out. */
    const given = admitToNonceSecret(first, VAULT, recordsKeypairFrom(ADA), [recordsReaderOf(LEE)]);
    await store.put(VAULT, given);
    const counted = refileNonceSecret(given, VAULT, recordsKeypairFrom(LEE), 3, 1);
    await store.put(VAULT, counted);
    const his = admitToNonceSecret(counted, VAULT, recordsKeypairFrom(LEE), [recordsReaderOf(DEE)]);
    await store.put(VAULT, { ...his, wrapped: his.wrapped.filter((w) => w.signerId !== pk(LEE)) });
    Object.assign(chain, { removals: 1, stayers: [pk(ADA), pk(BO), pk(DEE)] });
    const [hook] = await vaultSecretsRotatedHere(adasDevice(records, DEE), [VAULT], 'finish');
    expect(hook, 'RED WHEN: a device that cannot open the record that gave the leaver the secret finds nothing owed')
      .toMatchObject({ state: 'owed' });
    await expect(depositFrom(records, DEE), 'RED WHEN: a device admitted by the leaver deposits under a secret the leaver holds')
      .rejects.toBeInstanceOf(VaultSecretBeingChanged);
  });

  it('A SEAT\'S VERSION NAMING A KEY NO SEAT HOLDS STOPS NOTHING WHILE THE CHAIN HAS COUNTED NO REMOVAL SINCE THE SECRET WAS SET', async () => {
    const records = storesFor();
    const store = records('nonce-secret');
    const first = startNonceSecret(VAULT, [ADA, BO, LEE].map((k) => recordsReaderOf(k)), 0);
    await store.put(VAULT, first);
    const s1 = openNonceSecrets(first, VAULT, recordsKeypairFrom(ADA)).secrets[0]!;
    Object.assign(chain, { commitment: commitmentOf(s1), written: commitmentOf(s1), secret: s1, copiesTo: [pk(ADA), pk(BO), pk(LEE)] });
    /* One signer left before this secret's run was raised; none since. */
    Object.assign(chain, { removals: 1, setAt: 1 });
    const bos = refileNonceSecret(first, VAULT, recordsKeypairFrom(BO), 2, 1);
    await store.put(VAULT, { ...bos, wrapped: [...bos.wrapped, { ...bos.wrapped[0]!, signerId: pk(keyOf(9)) }] });
    const [hook] = await vaultSecretsRotatedHere(adasDevice(records), [VAULT], 'finish');
    expect(hook, 'RED WHEN: any seat can hold up a vault by filing a version wrapped to a key no seat holds').toMatchObject({ state: 'not-owed' });
    const made = await depositFrom(records).catch((e: Error) => e);
    expect(made instanceof Error ? made.message : made.epoch, 'RED WHEN: a seat\'s stray version stops every deposit').toBe(1);
  });

  it('A REMOVAL AFTER THE SECRET WAS SET OWES A NEW SECRET AND STOPS THE DEPOSIT EVEN WHEN NO RECORD AND NO COPY GAVE THE LEAVER THE SECRET', async () => {
    const records = storesFor();
    const store = records('nonce-secret');
    const first = startNonceSecret(VAULT, [ADA, BO].map((k) => recordsReaderOf(k)), 1);
    await store.put(VAULT, first);
    const s1 = openNonceSecrets(first, VAULT, recordsKeypairFrom(ADA)).secrets[0]!;
    Object.assign(chain, { commitment: commitmentOf(s1), written: commitmentOf(s1), secret: s1, copiesTo: [pk(ADA), pk(BO)], removals: 1, stayers: [pk(ADA), pk(BO)] });
    const [hook] = await vaultSecretsRotatedHere(adasDevice(records), [VAULT], 'finish');
    expect(hook, 'RED WHEN: a secret set before a removal is kept on the records\' word that the leaver never held it').toMatchObject({ state: 'owed' });
    await expect(depositFrom(records), 'RED WHEN: a deposit is made under a secret set before a removal')
      .rejects.toBeInstanceOf(VaultSecretBeingChanged);
  });
});
