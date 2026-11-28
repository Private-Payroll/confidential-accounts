/**
 * **A VAULT'S NOTES REBUILT ON THIS DEVICE** from the chain and the company's
 * records (`vaultNotesHere`), and the coins this device keeps for a vault
 * handed to another signer as a file and taken from one
 * (`coinsToHandOverHere`, `coinsHandedOverHere`).
 */
import { type SeatRights } from '../../../src/core/vault-approvers.js';
import type { Hex } from '../../../src/core/crypto.js';
import {
  SealedNotePool,
  assertNoSignerWouldLoseAccess,
  isALostPoolRace,
  openPool,
  passedOverAbove,
  sealPool,
  type FiledPoolVersion,
  type PassedOverVersion,
  type PoolSigner
} from '../../../src/midnight/vault-pool.js';
import type { Note } from '../../../src/midnight/vault-notes.js';
import { attemptsFromJournalVersions, noteKey } from '../../../src/midnight/vault-journal.js';
import {
  coinsFileRead,
  coinsFileText,
  type CoinKept,
  type CoinsFileCompany,
  type CoinsKeptHere
} from './vault-coins-kept-here.js';
import { openNonceSecrets, recordsKeypairFrom } from '../../../src/midnight/company-nonce-secret.js';
import { ownCopyOpened } from '../../../src/midnight/sealed-secret-copy.js';
import { signingPublicKeyOf } from '../../../src/core/crypto.js';
import { mayFile } from '../../../src/midnight/seat-directory.js';
import { seatNotBelievedHere, type DirectoryRead } from './vault-page-doors.js';
import { versionsBelievedOf } from './http-sealed-pool-store.js';
import type { Role } from '../../../src/core/types.js';
import { fileThePoolTheChainHolds, type DeviceRecords, type DeviceSigner } from './deposit-on-device.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import { type VaultRebuildAsked, type VaultRebuilt } from './vault-worker-client.js';
import { type ChainHereDoors, type VaultChainView } from './vault-doors.js';
import { NOT_PINNED_WHY, NO_VAULT_YET, readHere, vaultStandingHere } from './vault-read-here.js';
import { creatingTransactionOfOutput } from './vault-step-reads.js';
import type { UnnamedNotesKeptStore } from './tree-kept-here.js';

/**
 * **WHAT A REBUILD OF A VAULT'S NOTES NEEDS**: the vault read on this device at
 * the wallet's indexer, this signer's keys and the company's records through
 * the one check every reader uses, the worker that rebuilds, and the coins this
 * device keeps. Every payment's and deposit's doors carry all of it.
 */
export interface RebuildDoors extends ChainHereDoors {
  readonly builder: Pick<
    VaultBuilderClient,
    'vaultOnChain' | 'commitments' | 'creatingTransaction' | 'eventsOf' | 'createdBy'
  > &
    Partial<Pick<VaultBuilderClient, 'vaultRebuilt'>>;
  readonly me: DeviceSigner;
  readonly records: DeviceRecords;
  readonly signers: () => Promise<readonly PoolSigner[]>;
  readonly kept?: CoinsKeptHere;
  /**
   * This device's own seat as its believed directory holds it (`seatHereIn`), or null when the directory holds no seat
   * of this device's that it believes. The rebuild files a vault record only where that seat's role may file it
   * (`mayFile`); a seat this device cannot name files nothing, and what was found is returned in memory. Left out, the
   * rebuild is a read: it files nothing at all, whoever's seat it is, and says that what it found is owed a filing (the
   * page's read of a vault's private money, which signs nothing). A seat action in the wallet passes it to file.
   */
  readonly seatHere?: () => Promise<{ readonly role: Role | null; readonly retired: unknown } | null>;
  /**
   * The chain notes this device already looked for in every version of the records and found named by none, kept in
   * the device's own store of the company (`unnamedKeptIn`). Left out, a note nobody's records name is looked for
   * again at every read.
   */
  readonly unnamed?: UnnamedNotes;
}

/** The unnamed notes kept for one company: each note (as `vault:note`) with what it was last looked for in (`lookedForText`). */
interface UnnamedNotes {
  lookedIn(notes: readonly string[]): Promise<readonly (string | null)[]>;
  keep(notes: readonly string[], lookedIn: string): Promise<void>;
}

/** The unnamed notes the device's stores of a view's company keep, for the rebuild's doors; nothing when it keeps none. */
export const unnamedKeptIn = (view: {
  readonly company: string;
  readonly stores: { readonly unnamed?: UnnamedNotesKeptStore };
}): Pick<RebuildDoors, 'unnamed'> => {
  const store = view.stores.unnamed;
  return store === undefined
    ? {}
    : {
        unnamed: {
          lookedIn: (notes) => store.lookedIn(view.company, notes),
          keep: (notes, lookedIn) => store.keep(view.company, notes, lookedIn)
        }
      };
};

/**
 * This device's own seat in the directory it believes, with its role, its retirement and the rights the directory
 * believes it holds, found by the key it files with, or null when it holds none
 * or holds one this device does not believe (`seatNotBelievedHere`: not attested by its own wallet, retired, or not on
 * the chain now) - the one rule every reader of a seat keeps.
 */
export const seatHereIn = async (
  directory: DirectoryRead,
  signingSecret: Hex
): Promise<{ readonly role: Role | null; readonly retired: unknown; readonly rights?: SeatRights } | null> => {
  const me = signingPublicKeyOf(signingSecret).toLowerCase();
  const here = await directory();
  const mine = here.dir.seats.find((x) => x.signingKey.toLowerCase() === me);
  return mine === undefined || seatNotBelievedHere(here, mine) !== null ? null : mine;
};

type VaultRecordKind = 'pool' | 'deposit-journal' | 'payment-journal';

/** The vault records this device's seat may file: none for a seat it cannot name, a retired one, or a role that files none. */
async function filableHere(doors: RebuildDoors, said: string[]): Promise<ReadonlySet<VaultRecordKind>> {
  if (doors.seatHere === undefined) return new Set();
  let seat: { readonly role: Role | null; readonly retired: unknown } | null = null;
  try {
    seat = await doors.seatHere();
  } catch (e) {
    said.push(`this device's own seat was not read from the company's directory: ${failedSaying(e)}`);
  }
  if (seat === null || seat.retired !== null) return new Set();
  const kinds = mayFile(seat);
  return new Set((['pool', 'deposit-journal', 'payment-journal'] as const).filter((k) => kinds.includes(k)));
}

/**
 * The vault's notes as this device rebuilt them. `as-filed`: the record already
 * held every note the vault holds, and is what the vault's steps are planned
 * from. `filed`: a new version was filed holding them. `not-filed`: the notes
 * found are in `notes` and nothing was filed (this seat may not file, or the
 * record could not be read or written); a step is never planned from them.
 * `not-read`: the vault could not be read. `said` is every record withheld or
 * not believed, every line not read and every note not named, in words.
 * `leaver` is the part of it a leaving seat's filings left: what the chain
 * contradicts in them, which a balance read shows as its answer.
 * `unsealed` is, as codes, every way a record was left not sealed to every
 * signer the directory seats: the words in `said` are for a person, and
 * nothing reads them to decide anything.
 */
export const NOT_SEALED = Object.freeze({
  signersNotRead: 'signers-not-read',
  notFiledHere: 'not-filed-here',
  notFiledFailed: 'not-filed-failed'
} as const);
export type NotSealed = (typeof NOT_SEALED)[keyof typeof NOT_SEALED];

export type NotesHere = (
  | {
      readonly of: 'as-filed' | 'filed' | 'not-filed';
      readonly notes: readonly Note[];
      readonly unexplained: number;
      readonly said: readonly string[];
    }
  | { readonly of: 'not-read'; readonly said: readonly string[] }
) & { readonly leaver?: readonly string[]; readonly unsealed?: readonly NotSealed[] };

const REBUILD_ATTEMPTS = 5;

/** What a note was looked for in, and by whom: the signer, and the newest versions of the vault's pool, journals and nonce secrets it read. */
interface LookedForIn {
  readonly signer: string;
  readonly pool: number;
  readonly deposits: number;
  readonly payments: number;
  readonly nonceSecret: number;
}

/**
 * What a note was looked for in, as it is kept, so a note nobody's records name (a stranger's deposit) is not looked
 * for again by the same signer in the same records, and is looked for again once a version is filed, a secret is given
 * or another signer looks.
 */
const lookedForText = (at: LookedForIn): string =>
  `${at.signer}:${at.pool}:${at.deposits}:${at.payments}:${at.nonceSecret}`;

/** Whether every one of `notes` was kept as looked for already in `lookedIn`; with nothing kept on this device, none was. */
const everyLookedIn = async (
  unnamed: UnnamedNotes | undefined,
  notes: readonly string[],
  lookedIn: string
): Promise<boolean> =>
  unnamed !== undefined && notes.length > 0 && (await unnamed.lookedIn(notes)).every((kept) => kept === lookedIn);

const newestOf = (versions: readonly { readonly version: number }[]): number =>
  versions.reduce((n, v) => Math.max(n, v.version), 0);

const sameNote = (a: Note, b: Note): boolean =>
  a.nonce.toLowerCase() === b.nonce.toLowerCase() &&
  a.token.toLowerCase() === b.token.toLowerCase() &&
  a.value === b.value;
const noteText = (n: Note): string =>
  `${n.nonce.toLowerCase()}:${n.token.toLowerCase()}:${n.value}:${n.createdIn ?? ''}`;
const coinWire = (c: { readonly nonce: string; readonly token: string; readonly value: bigint | string }) => ({
  nonce: String(c.nonce).toLowerCase(),
  token: c.token,
  value: String(c.value)
});
const failedSaying = (e: unknown): string => (e as Error)?.message ?? String(e);

/**
 * **THE REBUILD, READ AGAIN WITH THIS SIGNER'S OWN SEALED COPY WHEN IT HOLDS A SECRET THE RECORDS DO NOT.** The copy of
 * the secret the vault holds now is read off the chain's state already in hand (no call to the service) and opened
 * only here. When it is not among the records' secrets (they gave none, a change of secret is not filed yet, or the
 * copy holds a secret that is not the vault's), the rebuild is made again with it as `copySecret`: the worker names
 * with it first, and walks back from it to every earlier one, only when it is the secret the vault holds now, and says
 * so when it is not. A copy that does not open is said and left out.
 */
async function rebuiltWithOwnCopy(
  me: DeviceSigner,
  rebuild: (input: VaultRebuildAsked) => Promise<VaultRebuilt>,
  vault: Hex,
  asked: Omit<VaultRebuildAsked, 'copyFor' | 'copySecret'>,
  secrets: readonly string[],
  said: string[]
): Promise<{ readonly rebuilt: VaultRebuilt; readonly copySecret?: string }> {
  const reader = recordsKeypairFrom(me.companyKey).publicKey;
  const rebuilt = await rebuild({ ...asked, copyFor: reader });
  if (rebuilt.copy === null) return { rebuilt };
  const own = ownCopyOpened(me.companyKey, vault, [{ reader, parts: rebuilt.copy }]);
  if (own === null)
    said.push(
      "this signer's sealed copy of the vault's secret on the chain does not open with this signer's records key"
    );
  if (own === null || secrets.includes(own)) return { rebuilt };
  return { rebuilt: await rebuild({ ...asked, copySecret: own }), copySecret: own };
}

/** A leaving seat's versions the chain vouches for, filed again first, as every read of this vault does, by a seat that may file them. */
async function leaversVersionsFiledAgain(
  doors: RebuildDoors,
  vault: Hex,
  {
    filable,
    notFiledBecause,
    onChain,
    held
  }: {
    readonly filable: Awaited<ReturnType<typeof filableHere>>;
    readonly notFiledBecause: string;
    readonly onChain: Set<string>;
    readonly held: (n: {
      readonly nonce: string;
      readonly token: string;
      readonly value: bigint | string;
    }) => Promise<string>;
  },
  said: string[],
  leaver: string[]
): Promise<void> {
  if (filable.size < 3) said.push(`${notFiledBecause}; what a seat that left filed is not filed again from here`);
  else
    try {
      const filedAgain = await fileThePoolTheChainHolds({
        vault,
        me: doors.me,
        records: doors.records,
        signers: doors.signers,
        held: async (n) => onChain.has(await held(n))
      });
      said.push(...filedAgain.said);
      leaver.push(...filedAgain.said);
    } catch (e) {
      said.push(`what a seat that left filed could not be checked against the chain: ${failedSaying(e)}`);
    }
}

/** A step the payment journal names, as the vault worker is handed one. */
const stepWire = (a: {
  spent: Note | { nonce: string; token: string; value: bigint };
  further?: readonly { nonce: string; token: string; value: bigint }[];
  amount: bigint;
  merge?: boolean;
}) => ({
  spent: coinWire(a.spent),
  amount: a.amount.toString(),
  ...(a.further === undefined || a.further.length === 0 ? {} : { further: a.further.map(coinWire) }),
  ...(a.merge === true ? { merge: true } : {})
});

/**
 * The second pass, only for a note the first left unnamed: every version of the pool and of each journal the company's
 * records believe, and the walk of every amount deposited and paid, asked of the vault worker. Each journal's newest
 * version as the first pass read it (`newestRead`) is kept even when every version could not be listed. `whole` is
 * false when any version was not read, not believed or did not open: what such a pass left unnamed may yet be named.
 */
async function rebuiltFromEveryVersion(
  doors: RebuildDoors,
  vault: Hex,
  said: string[],
  rebuild: (input: VaultRebuildAsked) => Promise<VaultRebuilt>,
  {
    asked,
    secrets,
    copySecret,
    loaded,
    kept,
    newestRead,
    journals
  }: {
    readonly asked: Omit<VaultRebuildAsked, 'copyFor' | 'copySecret'>;
    readonly secrets: string[];
    readonly copySecret: string | undefined;
    readonly loaded: Awaited<ReturnType<SealedNotePool['load']>> | null;
    readonly kept: readonly CoinKept[];
    readonly newestRead: { readonly deposits: FiledPoolVersion[]; readonly payments: FiledPoolVersion[] };
    readonly journals: (
      deposits: readonly (FiledPoolVersion | PassedOverVersion)[],
      payments: readonly (FiledPoolVersion | PassedOverVersion)[]
    ) => Promise<ReturnType<typeof attemptsFromJournalVersions>>;
  }
): Promise<{ readonly rebuilt: VaultRebuilt; readonly whole: boolean }> {
  let whole = true;
  const every = async (record: 'pool' | 'deposit-journal' | 'payment-journal'): Promise<FiledPoolVersion[]> => {
    try {
      /* A version the company's records do not believe is said and left out; every other version is still read. */
      const listed = await versionsBelievedOf(doors.records(record), vault);
      if (listed.refused.length > 0) whole = false;
      for (const r of listed.refused)
        said.push(
          `version ${r.version} of this vault's ${record} is not believed, because ${r.why}, so it is left out and every other version is read`
        );
      return listed.versions.filter((v): v is FiledPoolVersion => v.neverEntered !== true);
    } catch (e) {
      said.push(`every version of this vault's ${record} was not read: ${failedSaying(e)}`);
      whole = false;
      return [];
    }
  };
  const versions: Array<{ version: number; notes: readonly ReturnType<typeof coinWire>[] }> = [];
  for (const v of await every('pool')) {
    try {
      const page = openPool(v.sealed, doors.me.signerId, doors.me.wrappingSecret, { record: 'pool' }) as {
        notes?: unknown;
      };
      if (Array.isArray(page.notes)) versions.push({ version: v.version, notes: (page.notes as Note[]).map(coinWire) });
    } catch (e) {
      said.push(`version ${v.version} of this vault's pool does not open for this signer: ${failedSaying(e)}`);
      whole = false;
    }
  }
  if (loaded !== null && !versions.some((v) => v.version === loaded!.readAt.version)) versions.push(asked.versions[0]!);
  /* Each journal's newest version read above is kept even when every version could not be listed, as the pool's is. */
  const withNewest = (all: FiledPoolVersion[], read: FiledPoolVersion[]) => [
    ...all,
    ...read.filter((n) => !all.some((v) => v.version === n.version))
  ];
  const all = await journals(
    withNewest(await every('deposit-journal'), newestRead.deposits),
    withNewest(await every('payment-journal'), newestRead.payments)
  );
  if (all.unread.length > 0) whole = false;
  const amounts = new Map<string, { token: string; value: string }>();
  for (const c of [...all.deposits.map(coinWire), ...versions.flatMap((v) => v.notes), ...kept])
    amounts.set(`${c.token}:${c.value}`, { token: c.token, value: c.value });
  const rebuilt = await rebuild({
    ...asked,
    secrets,
    versions,
    ...(copySecret === undefined ? {} : { copySecret }),
    attempted: { deposits: all.deposits.map(coinWire), payments: all.payments.map(stepWire) },
    walk: {
      deposited: [...amounts.values()],
      paid: all.payments
        .filter((p) => p.merge !== true)
        .map((p) => ({ token: p.spent.token, amount: p.amount.toString() }))
    }
  });
  return { rebuilt, whole };
}

/**
 * The notes the vault's record holds once the chain is read: each recorded note the chain still holds, or one it does
 * not show made and spent, then every note the rebuild found held that the record does not name, with the transaction
 * that made it where the chain says.
 */
async function notesTheChainHolds(
  doors: RebuildDoors,
  vault: Hex,
  view: VaultChainView,
  {
    poolNotes,
    rebuilt,
    onChain,
    held
  }: {
    readonly poolNotes: readonly Note[];
    readonly rebuilt: VaultRebuilt;
    readonly onChain: Set<string>;
    readonly held: (n: {
      readonly nonce: string;
      readonly token: string;
      readonly value: bigint | string;
    }) => Promise<string>;
  }
): Promise<Note[]> {
  const rebuiltHeld = new Map(rebuilt.held.map((h) => [h.nonce.toLowerCase(), h]));
  const next: Note[] = [];
  let again: Set<string> | 'keep-every-note' | null = null;
  for (const n of poolNotes) {
    const h = rebuiltHeld.get(n.nonce.toLowerCase());
    if (h !== undefined && sameNote(n, { nonce: h.nonce, token: h.token, value: BigInt(h.value) } as Note)) {
      next.push(n);
      continue;
    }
    if (onChain.has(await held(n))) {
      next.push(n);
      continue;
    }
    /* Made and spent only when the history shows it made and a second read, after that history, still shows it gone. */
    const { output } = await doors.builder.commitments({ vault, coin: coinWire(n) });
    const made = (view.everCreated ?? []).some(
      (c) => c.toLowerCase().replace(/^0x/u, '') === output.toLowerCase().replace(/^0x/u, '')
    );
    if (made && again === null) {
      /* A second read that fails or holds no notes confirms nothing: every pool note is then kept. */
      try {
        const read = await readHere(doors, vault);
        again =
          read.onChain && Array.isArray(read.notes)
            ? new Set(read.notes.map((x) => x.toLowerCase()))
            : 'keep-every-note';
      } catch {
        again = 'keep-every-note';
      }
    }
    if (!made || again === 'keep-every-note' || again!.has(await held(n))) next.push(n);
  }
  for (const h of rebuilt.held) {
    if (next.some((n) => n.nonce.toLowerCase() === h.nonce.toLowerCase())) continue;
    const found = await creatingTransactionOfOutput(doors, vault, h.output, null, 'a note this vault holds');
    next.push({
      nonce: h.nonce,
      token: h.token,
      value: BigInt(h.value),
      ...(found.state === 'found' ? { createdIn: found.createdIn } : {})
    } as Note);
  }
  return next;
}

/** The notes found, filed as the vault's record only when they change it and this device's seat may file it; what was not filed is said. */
async function filedIfItChanges(
  doors: RebuildDoors,
  vault: Hex,
  said: string[],
  unsealed: NotSealed[],
  {
    pool,
    loaded,
    poolNotes,
    next,
    readers,
    filable,
    notFiledBecause,
    unexplained
  }: {
    readonly pool: SealedNotePool;
    readonly loaded: Awaited<ReturnType<SealedNotePool['load']>> | null;
    readonly poolNotes: readonly Note[];
    readonly next: Note[];
    readonly readers: Awaited<ReturnType<typeof readersMissing>>;
    readonly filable: Awaited<ReturnType<typeof filableHere>>;
    readonly notFiledBecause: string;
    readonly unexplained: number;
  }
): Promise<NotesHere | 'lost-a-race'> {
  const before = new Set(poolNotes.map(noteText));
  const changed = next.length !== poolNotes.length || next.some((n) => !before.has(noteText(n)));
  if (!changed) {
    if (loaded !== null && readers.length > 0)
      await sealedToEverySigner(doors, vault, pool, loaded, readers, filable, said, unsealed);
    return { of: loaded === null ? 'not-filed' : 'as-filed', notes: poolNotes, unexplained: unexplained, said };
  }
  if (loaded === null) {
    said.push("the notes found are not filed, because this vault's record of its notes could not be read to build on");
    return { of: 'not-filed', notes: next, unexplained: unexplained, said };
  }
  if (!filable.has('pool')) {
    said.push(notFiledBecause);
    return { of: 'not-filed', notes: next, unexplained: unexplained, said };
  }
  try {
    await pool.save(vault, { notes: next }, loaded.readAt);
  } catch (e) {
    if (isALostPoolRace(e)) return 'lost-a-race';
    said.push(`the notes found were not filed: ${failedSaying(e)}`);
    return { of: 'not-filed', notes: next, unexplained: unexplained, said };
  }
  if (readers.length > 0) await sealedToEverySigner(doors, vault, null, null, readers, filable, said, unsealed);
  return { of: 'filed', notes: next, unexplained: unexplained, said };
}

/**
 * The vault's nonce secrets, opened from the company's records with this signer's records key, and the version they were
 * read at (0 for none); none, and said, when they cannot be.
 */
async function nonceSecretsHere(
  doors: RebuildDoors,
  vault: Hex,
  said: string[]
): Promise<{ readonly secrets: string[]; readonly version: number }> {
  try {
    const filed = await doors.records('nonce-secret').get(vault);
    if (filed !== null)
      return {
        secrets: [...openNonceSecrets(filed, vault, recordsKeypairFrom(doors.me.companyKey)).secrets],
        version: filed.version
      };
    said.push("the company's records hold no nonce secret for this vault");
  } catch (e) {
    said.push(`the vault's nonce secret was not read from the company's records: ${failedSaying(e)}`);
  }
  return { secrets: [], version: 0 };
}

/** The coins this device keeps for the vault; none, and said, when they cannot be read. */
async function coinsKeptFor(doors: RebuildDoors, vault: Hex, said: string[]): Promise<readonly CoinKept[]> {
  let kept: readonly CoinKept[] = [];
  try {
    kept = (await doors.kept?.coins(vault)) ?? [];
  } catch (e) {
    said.push(`the coins this device keeps for this vault were not read: ${failedSaying(e)}`);
  }
  return kept;
}

/** The vault's record of its notes as filed, or null, and said, when it cannot be read. */
async function poolRecordHere(
  pool: SealedNotePool,
  vault: Hex,
  said: string[]
): Promise<Awaited<ReturnType<SealedNotePool['load']>> | null> {
  let loaded: Awaited<ReturnType<SealedNotePool['load']>> | null = null;
  try {
    loaded = await pool.load(vault);
  } catch (e) {
    said.push(`this vault's record of its notes was not read: ${failedSaying(e)}`);
  }
  return loaded;
}

/** The newest version of one of the vault's journals as the company's records hold it; none, and said, when it cannot be read. */
async function newestJournalOf(
  doors: RebuildDoors,
  vault: Hex,
  record: 'deposit-journal' | 'payment-journal',
  said: string[]
): Promise<FiledPoolVersion[]> {
  try {
    const rec = await doors.records(record).get(vault);
    return rec === null ? [] : [{ version: rec.version, sealed: rec }];
  } catch (e) {
    said.push(
      `this vault's ${record === 'deposit-journal' ? 'deposit' : 'payment'} journal was not read: ${failedSaying(e)}`
    );
    return [];
  }
}

/**
 * The attempts the vault's journals hold, read from the versions given. A version this signer cannot open is said; the
 * deposits read are kept on this device only where the chain made their coin (`everCreated`), as a coin handed over is.
 */
async function journalsRead(
  doors: RebuildDoors,
  vault: Hex,
  {
    deposits,
    payments,
    everCreated
  }: {
    readonly deposits: readonly (FiledPoolVersion | PassedOverVersion)[];
    readonly payments: readonly (FiledPoolVersion | PassedOverVersion)[];
    readonly everCreated: VaultChainView['everCreated'];
  },
  said: string[]
) {
  const read = attemptsFromJournalVersions({
    deposits,
    payments,
    opener: { id: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }
  });
  for (const u of read.unread)
    said.push(
      `version ${u.version} of this vault's ${u.record === 'deposit-journal' ? 'deposit' : 'payment'} journal: ${u.why}`
    );
  if (read.deposits.length > 0 && doors.kept !== undefined) {
    try {
      /* Kept on this device only where the chain made the coin, as a coin handed over is. */
      const made = new Set((everCreated ?? []).map((c) => c.toLowerCase().replace(/^0x/u, '')));
      const chainMade: (typeof read.deposits)[number][] = [];
      for (const c of read.deposits) {
        if (
          made.has(
            (await doors.builder.commitments({ vault, coin: coinWire(c) })).output.toLowerCase().replace(/^0x/u, '')
          )
        )
          chainMade.push(c);
      }
      await doors.kept.keep(vault, chainMade);
    } catch (e) {
      said.push(failedSaying(e));
    }
  }
  return read;
}

/**
 * **THE ONE REBUILD OF A VAULT'S NOTES ON A SIGNER'S DEVICE: EVERY NOTE THE
 * VAULT HOLDS, REACHED FROM THIS DEVICE AND FILED SO EVERY SIGNER'S DEVICE
 * REACHES IT.**
 *
 * Read the vault at the wallet's indexer (or take `view`, read just before by
 * the caller), file again what a leaving seat's versions the chain vouches for
 * (`fileThePoolTheChainHolds`), and compare the record with the chain. When
 * they agree and every signer can open the vault's records, that is the
 * answer. Otherwise, in this order:
 *
 * 1. The newest pool, both journals' newest versions, the nonce secrets (with
 *    this signer's sealed copy on the chain of the one the vault holds now,
 *    first when the records hold no secret or not that one, and every earlier
 *    secret the vault links to it) and the coins this device keeps are
 *    reconciled with the chain and its split journal in the vault worker.
 *    Every record is read through the one check; one withheld or not believed
 *    is said and the rest are still read, and nothing withheld is read as empty.
 * 2. Only when a chain note is still unnamed: every filed version of the three
 *    records (never one a device passes over; one the company's records do not
 *    believe is said and left out, where the store lists them, `versionsBelieved`),
 *    each journal's newest version read above among them, and the walk over the company's
 *    own amounts. A note the slow path cannot name is remembered for the page
 *    session.
 * 3. The notes are what the chain holds: every note of the record the chain
 *    still holds, every note the rebuild names (with its creating transaction),
 *    and a note the chain no longer holds only until a second read shows it made
 *    and spent - a note held but not in the history yet is the indexer behind.
 * 4. Filed as the next version only when that changes anything, the record
 *    was believed and this device's seat may file it (`seatHere`, `mayFile`);
 *    a lost race reads the chain and the records again. The newest pool and
 *    journals are filed again, unchanged, sealed to every signer the directory
 *    seats, when one of them cannot open them, by a seat that may file them. A
 *    seat that may not file files nothing, the leaving seat's versions
 *    included, and returns what it found in memory.
 *
 * It never throws: what it cannot do is returned and said, so a payment or a
 * deposit it runs inside goes on from the record as filed.
 */
export async function vaultNotesHere(doors: RebuildDoors, vault: Hex, view?: VaultChainView): Promise<NotesHere> {
  const said: string[] = [];
  const leaver: string[] = [];
  const unsealed: NotSealed[] = [];
  try {
    for (let attempt = 1; ; attempt += 1) {
      const done = await rebuiltOnce(doors, vault, attempt === 1 ? view : undefined, said, leaver, unsealed);
      if (done !== 'lost-a-race') return { ...done, leaver, unsealed };
      if (attempt === REBUILD_ATTEMPTS) {
        said.push(
          `another device filed this vault's record first on all ${REBUILD_ATTEMPTS} attempts, so nothing was filed from here`
        );
        return { of: 'not-read', said, leaver, unsealed };
      }
    }
  } catch (e) {
    said.push(failedSaying(e));
    return { of: 'not-read', said, leaver, unsealed };
  }
}

async function rebuiltOnce(
  doors: RebuildDoors,
  vault: Hex,
  given: VaultChainView | undefined,
  said: string[],
  leaver: string[],
  unsealed: NotSealed[]
): Promise<NotesHere | 'lost-a-race'> {
  let view = given;
  if (view === undefined) {
    const standing = await vaultStandingHere(doors, vault);
    if (!standing.onChain) return { of: 'not-read', said: [...said, standing.view.why ?? NO_VAULT_YET] };
    if (standing.unread !== null) return { of: 'not-read', said: [...said, standing.unread.says] };
    if (!standing.pinned) return { of: 'not-read', said: [...said, NOT_PINNED_WHY] };
    view = standing.view;
  }
  if (view.onChain !== true || !Array.isArray(view.notes)) {
    return {
      of: 'not-read',
      said: [...said, view.notesWhy ?? 'the chain was read and did not say which notes this vault holds']
    };
  }
  const chainNotes = view.notes.map((n) => n.toLowerCase());
  const onChain = new Set(chainNotes);
  const heldOf = new Map<string, string>();
  const held = async (n: {
    readonly nonce: string;
    readonly token: string;
    readonly value: bigint | string;
  }): Promise<string> => {
    const key = noteKey(n);
    if (!heldOf.has(key))
      heldOf.set(key, (await doors.builder.commitments({ vault, coin: coinWire(n) })).held.toLowerCase());
    return heldOf.get(key)!;
  };

  /* What this seat may file, asked once, before anything is filed: a seat that may not file files nothing. */
  const filable = await filableHere(doors, said);
  const notFiledBecause =
    doors.seatHere === undefined
      ? "a read files nothing, so what was found is not filed from here; it is owed a filing by a seat action in a signer's wallet"
      : "this device's seat may not file this vault's records (its role files none, or this device does not believe " +
        'the seat), so what was found is not filed from this device';

  await leaversVersionsFiledAgain(doors, vault, { filable, notFiledBecause, onChain, held }, said, leaver);

  const pool = new SealedNotePool(
    doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret },
    doors.signers
  );
  const loaded = await poolRecordHere(pool, vault, said);
  const poolNotes: readonly Note[] = loaded?.notes ?? [];
  const recorded = new Set<string>();
  for (const n of poolNotes) recorded.add(await held(n));
  const unnamed = chainNotes.filter((c) => !recorded.has(c));
  const notHeld = poolNotes.filter((n) => !onChain.has(heldOf.get(noteKey(n))!));
  const readers = await readersMissing(doors, vault, said, unsealed);

  if (loaded !== null && unnamed.length === 0 && notHeld.length === 0) {
    if (readers.length > 0) await sealedToEverySigner(doors, vault, pool, loaded, readers, filable, said, unsealed);
    return { of: 'as-filed', notes: poolNotes, unexplained: 0, said };
  }
  if (doors.builder.vaultRebuilt === undefined) {
    said.push("this page cannot rebuild the vault's notes; reload it to use the current build");
    return { of: 'not-filed', notes: poolNotes, unexplained: unnamed.length, said };
  }

  if (view.nonceCommitment === undefined || view.splitJournal === undefined) {
    said.push(
      "the read of the chain did not give the vault's secret commitment and split journal, so its notes are not rebuilt; " +
        'a journal not read is not an empty one'
    );
    return { of: 'not-read', said };
  }

  /* ---- 1: the newest of each record, the secrets, the coins kept here ---- */
  const { secrets, version: nonceSecret } = await nonceSecretsHere(doors, vault, said);
  const journals = (
    deposits: readonly (FiledPoolVersion | PassedOverVersion)[],
    payments: readonly (FiledPoolVersion | PassedOverVersion)[]
  ) => journalsRead(doors, vault, { deposits, payments, everCreated: view.everCreated }, said);
  const kept = await coinsKeptFor(doors, vault, said);
  const newestRead = {
    deposits: await newestJournalOf(doors, vault, 'deposit-journal', said),
    payments: await newestJournalOf(doors, vault, 'payment-journal', said)
  };
  const newest = await journals(newestRead.deposits, newestRead.payments);
  const asked = {
    vault,
    ...(view.state === undefined ? {} : { state: view.state }),
    chain: {
      notes: chainNotes,
      everCreated: view.everCreated ?? [],
      ...(view.nonceCommitment === undefined ? {} : { nonceCommitment: view.nonceCommitment }),
      ...(view.splitJournal === undefined ? {} : { splitJournal: view.splitJournal })
    },
    secrets,
    versions: loaded === null ? [] : [{ version: loaded.readAt.version, notes: poolNotes.map(coinWire) }],
    attempted: { deposits: newest.deposits.map(coinWire), payments: newest.payments.map(stepWire) },
    named: kept
  };
  const first = await rebuiltWithOwnCopy(doors.me, (i) => doors.builder.vaultRebuilt!(i), vault, asked, secrets, said);
  let rebuilt = first.rebuilt;

  /* ---- 2: every version and the walk, only for a note still unnamed and not looked for in these same records ---- */
  const at: LookedForIn = {
    signer: doors.me.signerId,
    pool: loaded?.readAt.version ?? 0,
    deposits: newestOf(newestRead.deposits),
    payments: newestOf(newestRead.payments),
    nonceSecret
  };
  const [lookedFor, lookedIn] = [rebuilt.unexplained.map((note) => `${vault}:${note}`), lookedForText(at)];
  if (rebuilt.unexplained.length > 0 && !(await everyLookedIn(doors.unnamed, lookedFor, lookedIn))) {
    const slow = await rebuiltFromEveryVersion(doors, vault, said, (i) => doors.builder.vaultRebuilt!(i), {
      asked,
      secrets,
      copySecret: first.copySecret,
      loaded,
      kept,
      newestRead,
      journals
    });
    rebuilt = slow.rebuilt;
    /*
     * Kept only for the notes a slow pass that read every version still leaves unnamed. A note it named stays unkept, so
     * every later read looks for it again until a pool version names it; a pass that missed a version keeps nothing.
     */
    if (rebuilt.unexplained.length > 0 && slow.whole)
      await doors.unnamed?.keep(
        rebuilt.unexplained.map((note) => `${vault}:${note}`),
        lookedIn
      );
  }
  said.push(...rebuilt.said);
  if (rebuilt.unexplained.length > 0) {
    said.push(
      `the chain holds ${rebuilt.unexplained.length} note(s) for this vault that no record this device can read names. They are ` +
        "the vault's and stay on the chain; they are named once a record that names them can be read here"
    );
  }

  /* ---- 3: the notes the chain holds ---- */
  const next = await notesTheChainHolds(doors, vault, view, { poolNotes, rebuilt, onChain, held });

  /* ---- 4: filed only when it changes anything ---- */
  return filedIfItChanges(doors, vault, said, unsealed, {
    pool,
    loaded,
    poolNotes,
    next,
    readers,
    filable,
    notFiledBecause,
    unexplained: rebuilt.unexplained.length
  });
}

/**
 * Which of the vault's records - the pool and the two journals, each as the
 * one check gives its newest version - a signer the directory seats cannot
 * open, because it was last filed before they were seated. When the signers
 * cannot be read, that is said and coded in `unsealed`.
 */
async function readersMissing(
  doors: RebuildDoors,
  vault: Hex,
  said: string[],
  unsealed: NotSealed[]
): Promise<Array<'pool' | 'deposit-journal' | 'payment-journal'>> {
  let ids: string[];
  try {
    ids = (await doors.signers()).map((x) => x.id);
  } catch (e) {
    said.push(
      `who the company's signers are was not read, so no record was sealed to more of them: ${failedSaying(e)}`
    );
    unsealed.push(NOT_SEALED.signersNotRead);
    return [];
  }
  const out: Array<'pool' | 'deposit-journal' | 'payment-journal'> = [];
  for (const record of ['pool', 'deposit-journal', 'payment-journal'] as const) {
    try {
      const rec = await doors.records(record).get(vault);
      if (rec !== null && ids.some((id) => !rec.wrapped.some((w) => w.signerId === id))) out.push(record);
    } catch {
      /* A record not read is said where it is read for its notes. */
    }
  }
  return out;
}

/**
 * **THE NEWEST POOL AND JOURNALS, FILED AGAIN UNCHANGED, SEALED TO EVERY SIGNER
 * THE DIRECTORY SEATS**, so a signer seated after their last version opens
 * them. Only a seat that reads them and may file does it; a refusal is said, and
 * coded in `unsealed`.
 * `pool` and `loaded` are given only when the pool itself still needs it.
 */
async function sealedToEverySigner(
  doors: RebuildDoors,
  vault: Hex,
  pool: SealedNotePool | null,
  loaded: Awaited<ReturnType<SealedNotePool['load']>> | null,
  records: ReadonlyArray<VaultRecordKind>,
  filable: ReadonlySet<VaultRecordKind>,
  said: string[],
  unsealed: NotSealed[]
): Promise<void> {
  for (const record of records) {
    if (!filable.has(record)) {
      said.push(
        `this vault's ${record} is not filed again for a signer who cannot open it yet: ` +
          (doors.seatHere === undefined
            ? "a read files nothing, and a seat action in a signer's wallet owes it"
            : "this device's seat may not file it")
      );
      unsealed.push(NOT_SEALED.notFiledHere);
      continue;
    }
    try {
      if (record === 'pool') {
        if (pool !== null && loaded !== null) await pool.save(vault, { notes: loaded.notes }, loaded.readAt);
        continue;
      }
      const store = doors.records(record);
      const rec = await store.get(vault);
      if (rec === null) continue;
      const page = openPool(rec, doors.me.signerId, doors.me.wrappingSecret, {
        record,
        unlabelled: store.unlabelledRecordsFiled === true ? 'accept' : 'refuse'
      });
      const to = await doors.signers();
      assertNoSignerWouldLoseAccess(
        rec.wrapped.map((w) => w.signerId),
        to.map((x) => x.id),
        `this vault's ${record}`
      );
      passedOverAbove(store, vault, record, rec.version);
      await store.put(vault, sealPool(vault, page, to, rec.version + 1, record));
    } catch (e) {
      if (isALostPoolRace(e)) continue;
      said.push(`this vault's ${record} was not filed again for a signer who cannot open it yet: ${failedSaying(e)}`);
      unsealed.push(NOT_SEALED.notFiledFailed);
    }
  }
}

/**
 * **THE COINS THIS DEVICE KEEPS FOR A VAULT, AS A FILE FOR ANOTHER SIGNER**
 * (`coinsFileText`), sealed for the company's signers: the signer saves it and
 * hands it over themselves; nothing is sent to the company's service.
 */
export async function coinsToHandOverHere(
  doors: Pick<RebuildDoors, 'kept'>,
  vault: Hex,
  company: CoinsFileCompany
): Promise<string> {
  return coinsFileText(vault, (await doors.kept?.coins(vault)) ?? [], company);
}

/**
 * **COINS ANOTHER SIGNER HANDED OVER AS A FILE**, opened with the company's
 * key (a file sealed for another company opens nothing), kept on this device only
 * where the chain, read at the wallet's indexer, made each one for this vault:
 * a coin the chain never made - a forged or mistyped one - is refused and kept
 * nowhere. Kept coins are then read by every rebuild of the vault's notes.
 */
export async function coinsHandedOverHere(
  doors: RebuildDoors,
  vault: Hex,
  text: string,
  company: CoinsFileCompany
): Promise<{ readonly kept: number; readonly refused: number }> {
  const coins = coinsFileRead(text, vault, company);
  if (doors.kept === undefined)
    throw new Error('this device keeps no coins, so the file was not taken. Nothing was kept.');
  const read = await readHere(doors, vault);
  if (!read.onChain)
    throw new Error(
      `the chain, as this device read it, does not show this vault, so no coin was kept. ${NO_VAULT_YET}`
    );
  const made = new Set(read.everCreated.map((c) => c.toLowerCase().replace(/^0x/u, '')));
  const taken: CoinKept[] = [];
  for (const c of coins) {
    const { output } = await doors.builder.commitments({ vault, coin: c });
    if (made.has(output.toLowerCase().replace(/^0x/u, ''))) taken.push(c);
  }
  await doors.kept.keep(vault, taken);
  return { kept: taken.length, refused: coins.length - taken.length };
}
