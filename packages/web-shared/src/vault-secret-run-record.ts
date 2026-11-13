/**
 * **A VAULT'S SECRET RUN AS THE COMPANY'S PROPOSALS HOLD IT**, for its first secret and for one replacing it: the record
 * a raise seals (`secretRunRound`), what a signer's device opens from a record (`startRecordOpened`,
 * `runSecretOfTheRecord`), a record still standing for the same secret (`secretRunStillStanding`), another run still
 * standing for another secret (`noOtherRunStanding`), and each record written down as carried out once the vault takes
 * money under its secret (`secretWrittenDown`).
 *
 * A run's record holds every reader's sealed copy of the new secret, each sealed to that reader's own records key, and
 * the commitment the run replaces. A signer opens only their own copy, so every signer's device can make the run again,
 * check it is the one the chain holds, approve it and carry it, without the secret ever being filed in the company's
 * records before the chain holds it.
 */
import type { Hex, Sealed } from '../../../src/core/crypto.js';
import { parseCanonical, unseal } from '../../../src/core/crypto.js';
import { keyOf, type KeysHeld } from '../../../src/core/company-key.js';
import type { SealedProposal } from '../../../src/core/types.js';
import type { SecretRunOnTheWire } from './vault-worker-client.js';
import {
  VAULT_SECRET, proposalFilingRefusal, raiseByOf, raiseMayStillLandAt, sealVaultSecretProposal,
} from '../../../src/core/proposal-filing.js';
import { openRecord } from '../../../src/core/sealed-records.js';
import { ownCopyOpened } from '../../../src/midnight/sealed-secret-copy.js';
import type { CreateVaultDoors } from './vault-doors.js';
import { VaultStartOwed } from './vault-start-stops.js';
import { readTheSecretBack, type RunSecret } from './vault-pool-opened.js';
import { ownChainSecret, recordSecretsOf } from './vault-secret-to-spend.js';
import { theVaultReadForItsStart } from './vault-read-here.js';
import {
  type StartRound, type StartStanding, ZERO_HEX, carriedOutWrittenDown, raiseMayStillLand, standingNow,
} from './vault-start-steps.js';

const HEX64 = /^[0-9a-f]{64}$/u;

/** The summary each secret run's record is sealed with: setting a new vault up, or replacing its secret. */
export const FIRST_SECRET_SUMMARY = 'Finish setting up a new vault';
export const NEW_SECRET_SUMMARY = 'Replace the vault\'s secret';

/** True for a run that sets a vault's first secret: it replaces no commitment. */
export const replacesNothing = (previous: string | undefined): boolean => previous === undefined || /^0*$/u.test(previous);

/**
 * A vault's secret run, as its record is sealed: its root, payee count and window, the commitment it replaces when it
 * replaces one, and every reader's sealed copy of the secret, never the secret or the run's nonce. Its public parts, the
 * nonce among them, go to the service only to write it down once the secret is set, when the call that set it has
 * disclosed every one of them.
 */
export const secretRunRound = (
  doors: CreateVaultDoors, vault: Hex, run: SecretRunOnTheWire,
  round: { readonly proposal: string; readonly payload: string; readonly named: string; readonly salt: string; readonly opensAt: string; readonly closesAt: string },
  summary: string,
): StartRound => {
  const first = replacesNothing(run.previous);
  const previous = first ? {} : { previous: String(run.previous).toLowerCase() as Hex };
  return {
    what: first ? 'raising its first secret' : 'raising its new secret', called: first ? 'first secret run' : 'secret run',
    chainId: round.proposal, digest: round.payload, salt: round.salt, named: round.named,
    parts: {
      root: String(run.root).toLowerCase(), opensAt: String(round.opensAt), closesAt: String(round.closesAt), salt: String(run.salt).toLowerCase(),
      nonce: String(run.nonce).toLowerCase(), copiesRoot: String(run.copiesRoot).toLowerCase(), count: String(run.count), ...previous,
    },
    seal: (key) => sealVaultSecretProposal({
      accountId: doors.proposals.accountId, viewingKey: key, summary,
      run: {
        vault, root: run.root as Hex, payees: String(run.payees), opensAt: String(round.opensAt), closesAt: String(round.closesAt), ...previous,
        copies: run.copies.map((c) => ({ reader: String(c.reader).toLowerCase() as Hex, parts: c.parts.map((p) => String(p).toLowerCase() as Hex) })),
      },
      change: { asset: run.asset, amount: 0n, batchDigest: ZERO_HEX as Hex, salt: round.salt as Hex },
      proposedBy: doors.me.signerId,
    }),
  };
};

/** A record of one of a vault's start rounds or secret runs, as this device opens it. */
interface StartRecordOpened {
  readonly kind: string;
  readonly vault: string;
  /** A run's window. */
  readonly window?: { readonly opensAt: bigint; readonly closesAt: bigint };
  /** The commitment a secret run replaces; absent for a first secret. */
  readonly previous?: Hex;
  /** Every reader's sealed copy of a secret run's secret; absent in a record sealed before runs carried them. */
  readonly copies?: readonly { readonly reader: Hex; readonly parts: readonly Hex[] }[];
  /** For the adoption of a vault the company retired, the proposal that retired it, which the adoption is made from. */
  readonly again?: Hex;
}

const copiesIn = (x: unknown): StartRecordOpened['copies'] | null => {
  if (!Array.isArray(x)) return null;
  const copies = x.map((c: { reader?: unknown; parts?: unknown }) => (typeof c?.reader === 'string' && HEX64.test(c.reader) && Array.isArray(c.parts)
    && c.parts.length === 4 && c.parts.every((p) => typeof p === 'string' && HEX64.test(p))
    ? { reader: c.reader as Hex, parts: c.parts as Hex[] } : null));
  return copies.every((c) => c !== null) ? copies as { reader: Hex; parts: Hex[] }[] : null;
};

/**
 * A record of one of a vault's start rounds, opened with the company's keys: its kind, its vault and, for a run, its
 * window, the commitment it replaces and its sealed copies. Null for a record this device cannot open, or whose
 * `previous` or copies are not of the shape a raise seals.
 */
export const startRecordOpened = (keys: KeysHeld, rec: SealedProposal): StartRecordOpened | null => {
  try {
    const key = keyOf(keys, rec.keyEpoch);
    const envelope = openRecord<{ kind: string; sealedPayload: Sealed }>('proposals', rec.accountId, rec.sealed, key);
    const body = parseCanonical<{ vault?: unknown; opensAt?: unknown; closesAt?: unknown; previous?: unknown; copies?: unknown; again?: unknown }>(unseal(envelope.sealedPayload, key));
    if (typeof body.vault !== 'string') return null;
    const digits = (x: unknown): x is string => typeof x === 'string' && /^[0-9]{1,20}$/u.test(x);
    const window = digits(body.opensAt) && digits(body.closesAt) ? { opensAt: BigInt(body.opensAt), closesAt: BigInt(body.closesAt) } : undefined;
    if (body.previous !== undefined && (typeof body.previous !== 'string' || !HEX64.test(body.previous))) return null;
    if (body.again !== undefined && (typeof body.again !== 'string' || !HEX64.test(body.again))) return null;
    const copies = body.copies === undefined ? undefined : copiesIn(body.copies);
    if (copies === null) return null;
    return {
      kind: envelope.kind, vault: body.vault.toLowerCase(), ...(window === undefined ? {} : { window }),
      ...(body.previous === undefined ? {} : { previous: body.previous as Hex }), ...(copies === undefined ? {} : { copies }),
      ...(body.again === undefined ? {} : { again: body.again as Hex }),
    };
  } catch {
    /* A record this device cannot open is no record of a start round to it: it is passed over, as one of another kind is. */
    return null;
  }
};

/**
 * Every secret this device holds for the vault: the company's records' (oldest first), then this signer's own copy on
 * the chain of the secret whose copies were last all written, the one a replacement carries (`earlier`). Empty when
 * neither gives one; the run then names, when it is carried, that this device does not hold the secret it must
 * carry, and sends nothing.
 */
export async function heldSecretsOf(doors: Pick<CreateVaultDoors, 'me' | 'records'> & Partial<Pick<CreateVaultDoors, 'builder'>>, vault: Hex): Promise<readonly Hex[]> {
  const filed = await recordSecretsOf(doors, vault);
  const own = await ownCopyLastWritten(doors, vault);
  return own === null || filed.includes(own) ? filed : [...filed, own];
}

/** This signer's own copy on the chain of the secret whose copies were last all written; null when there is none here. */
const ownCopyLastWritten = async (doors: Partial<Pick<CreateVaultDoors, 'builder'>> & Pick<CreateVaultDoors, 'me' | 'records'>, vault: Hex): Promise<Hex | null> => {
  if (doors.builder?.ownChainCopy === undefined) return null;
  try {
    const { view } = await theVaultReadForItsStart(doors as CreateVaultDoors, vault);
    return view.state === undefined ? null : (await ownChainSecret(doors as CreateVaultDoors, vault, view.state, 'copies-written')).secret;
  } catch {
    /* A chain that cannot be read gives no copy: the records' secrets stand alone, and the carry names what it lacks. */
    return null;
  }
};

/**
 * **THE SECRET A RUN SETS, AS THIS DEVICE OPENS IT FROM THE RUN'S OWN RECORD**: from this signer's own sealed copy
 * there, with the readers the record seals to and the commitment it replaces, and the secrets the company's records
 * hold for the vault, one of which a replacement carries. A record sealed before runs carried copies is a first
 * secret's, whose secret is read back from the company's records as before. Null when no copy is sealed to this
 * signer or theirs does not open: a run this device cannot approve. Any other failure is thrown.
 */
export async function runSecretOfTheRecord(doors: CreateVaultDoors, vault: Hex, opened: StartRecordOpened): Promise<RunSecret | null> {
  if (opened.copies === undefined) {
    if (!replacesNothing(opened.previous)) throw new Error('the run\'s record holds no sealed copy of its secret');
    return readTheSecretBack(doors, vault);
  }
  const secret = ownCopyOpened(doors.me.companyKey, vault, opened.copies);
  if (secret === null) return null;
  return {
    secret, readers: opened.copies.map((c) => c.reader), ...(opened.previous === undefined ? {} : { previous: opened.previous }),
    earlier: await heldSecretsOf(doors, vault),
  };
}

/**
 * **A SECRET RUN THIS DEVICE MAY STILL ACT ON**: open on the account, inside its window, and raised after the last
 * removal the account counted. The one rule every step that approves, carries or relies on a run reads.
 */
export const runLive = (run: { readonly open: boolean; readonly inWindow: boolean; readonly beforeARemoval: boolean } | null | undefined): boolean =>
  run != null && run.open && run.inWindow && !run.beforeARemoval;

/** A step of checking the company's open proposals; any failure refuses, naming that they could not be checked. */
async function proposalsChecked<T>(vault: Hex, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (e) {
    throw new VaultStartOwed(vault, `the company's proposals could not be checked against the chain, so no secret run was raised (${(e as Error)?.message ?? e}). Nothing was sent.`);
  }
}

/** Where a secret run stands at the block `at` was read at, with `secret` and a run's `window`: the run's identity over that window. */
const standingOver = async (
  doors: CreateVaultDoors, vault: Hex, at: StartStanding, secret: RunSecret, window: { readonly opensAt: bigint; readonly closesAt: bigint },
) => {
  const read = (await doors.builder.startStanding({
    vault, account: at.chain.account, accountState: at.chain.accountState, vaultState: at.chain.vaultState, now: at.now.toString(),
    secret: secret.secret, readers: secret.readers, ...(secret.previous === undefined ? {} : { previous: secret.previous }),
    window: { opensAt: window.opensAt.toString(), closesAt: window.closesAt.toString() },
  })).standing.secret;
  /* Asked with a secret, the worker always reads where its run stands; an answer without it is no answer. */
  if (read === undefined) throw new Error('the chain\'s answer did not say where that run stands');
  return read;
};

/** The run is set, or the account holds it under `id` (over any window, not only the run it reports): its raise landed. */
export const landedOrSet = (n: StartStanding, id: string): boolean => n.standing.secret?.set === true
  || [...(n.standing.secret?.landed ?? []), n.standing.secret?.run?.proposal ?? ''].some((x) => x.toLowerCase() === id.toLowerCase());

/**
 * The company's proposals open for this vault's secret runs that this device opens and believes, with their window.
 * Throws as the service's read did; each caller says what it was reading for.
 */
async function secretRecordsOpen(doors: CreateVaultDoors, vault: Hex) {
  const p = doors.proposals;
  const open = (await p.service.sealedProposals(p.accountId)).filter((r) => r.accountId === p.accountId && (r.status === 'open' || r.status === 'approved'));
  return open.flatMap((rec) => {
    const opened = proposalFilingRefusal(p.accountId, rec) !== null ? null : startRecordOpened(p.companyKeys, rec);
    return opened === null || opened.kind !== VAULT_SECRET || opened.vault !== vault.toLowerCase() || opened.window === undefined
      ? [] : [{ rec, opened, window: opened.window }];
  });
}

/**
 * **A SECRET RUN RAISED BEFORE FOR THIS SECRET, STILL STANDING**: the window of a record of this vault and this secret
 * whose run the chain holds open in its window, raised after the last removal (`live`: nothing is raised, the press
 * carries on with that run, whichever run the chain lists first); or of one written down, never seen on the chain,
 * whose raise may still land (`raiseMayStillLand`), so the press sends it again under its own record instead of raising
 * a second run over a new window. One whose raise can no longer land, or that the chain shows landed and not standing,
 * is passed over and never withdrawn, whoever wrote it down: a new run is raised over a new window, so a signer who has
 * left cannot hold the vault's secret up by leaving a record behind. Null when none stands. `onChain` is the run the
 * chain reports, left as it is.
 */
export async function secretRunStillStanding(
  doors: CreateVaultDoors, vault: Hex, at: StartStanding, secret: RunSecret, onChain: string | null,
): Promise<{ readonly window: { readonly opensAt: bigint; readonly closesAt: bigint }; readonly live: boolean } | null> {
  const first = replacesNothing(secret.previous);
  const called = first ? 'first secret run' : 'secret run';
  let open: Awaited<ReturnType<typeof secretRecordsOpen>>;
  try {
    open = await secretRecordsOpen(doors, vault);
  } catch (e) {
    throw new VaultStartOwed(vault, `the company's proposals could not be read, so raising its ${first ? 'first' : 'new'} secret was not sent (${(e as Error)?.message ?? e}).`);
  }
  for (const { rec, window } of open) {
    /* A record whose run is not this secret's names another raise, and is passed over below. */
    const s = await proposalsChecked(vault, () => standingOver(doors, vault, at, secret, window));
    const raise = s.raise;
    if (raise === undefined || raise.proposal.toLowerCase() !== String(rec.chainId).toLowerCase()
      || raise.payload.toLowerCase() !== String(rec.digest).toLowerCase()) continue;
    const r = s.run;
    if (r != null && r.proposal.toLowerCase() === raise.proposal.toLowerCase() && runLive(r)) return { window, live: true };
    if (rec.raisedAt || String(rec.chainId).toLowerCase() === onChain?.toLowerCase()) continue;
    const heldNow = async (): Promise<boolean> => landedOrSet(await standingNow(doors, vault, secret), String(rec.chainId));
    if (await raiseMayStillLand(doors, vault, rec, called, heldNow)) return { window, live: false };
  }
  return null;
}

/**
 * **NO FRESH SECRET OVER ANOTHER SIGNER'S RUN THAT MAY STILL SET ONE.** Before a run is raised, each open record of a
 * run for this vault that seals a copy to this signer, for a secret other than `secret`, is opened from that copy and
 * read on the chain: one the chain holds open in its window, raised after the last removal, or one whose raise may
 * still land, refuses the raise and names it, so the signers approve that run instead of racing it. Cleared when that
 * run is carried, when its window closes, or when its raise can no longer land (`raiseByOf`): it is then passed over.
 */
export async function noOtherRunStanding(doors: CreateVaultDoors, vault: Hex, at: StartStanding, secret: RunSecret): Promise<void> {
  const nowMs = doors.clock?.() ?? Date.now();
  let open: Awaited<ReturnType<typeof secretRecordsOpen>>;
  try {
    open = await secretRecordsOpen(doors, vault);
  } catch (e) {
    throw new VaultStartOwed(vault, `the company's proposals could not be read, so no secret run was raised (${(e as Error)?.message ?? e}). Nothing was sent.`);
  }
  for (const { rec, opened, window } of open) {
    if (opened.copies === undefined) continue;
    /* A run with no copy of its secret this signer opens is not one this device can approve, so it holds nothing up here. */
    const other = await proposalsChecked(vault, () => runSecretOfTheRecord(doors, vault, opened));
    if (other === null || other.secret === secret.secret.toLowerCase()) continue;
    const s = await proposalsChecked(vault, () => standingOver(doors, vault, at, other, window));
    if (s.set || s.raise?.proposal.toLowerCase() !== String(rec.chainId).toLowerCase()) continue;
    const landed = s.landed.some((x) => x.toLowerCase() === String(rec.chainId).toLowerCase());
    const until = new Date(Number(window.closesAt) * 1000).toISOString();
    if (landed && runLive(s.run)) {
      throw new VaultStartOwed(vault, `the company's proposals hold ${rec.id}, another run setting a new secret for this vault, open on the `
        + `chain until ${until}, so no other is raised beside it. Nothing was sent. Approve or carry that one; once it is carried, or its `
        + 'time has passed, pressing again raises this one.');
    }
    const raiseBy = raiseByOf(rec.createdAt);
    if (!landed && raiseMayStillLandAt(raiseBy, nowMs)) {
      throw new VaultStartOwed(vault, `the company's proposals hold ${rec.id}, another run setting a new secret for this vault, whose raise `
        + `may still reach the chain until ${new Date(Number(raiseBy) * 1000).toISOString()}, so no other is raised beside it. Nothing was `
        + 'sent. Approve it once the chain holds it, or press again after that time.');
    }
  }
}

/**
 * **THE VAULT'S SECRET RUN, WRITTEN DOWN AS CARRIED OUT ONCE THE CHAIN SHOWS THE VAULT TAKES MONEY UNDER ITS SECRET**:
 * the secret set and every signer's sealed copy written, so a run whose copies are still owed is never written down as
 * done. Each record the company's proposals still hold open that this device opens to a secret run of this vault, over
 * a window whose run for the secret the vault now holds has the record's identity, is asked of the service as carried
 * out, with the run's public parts, which the service makes the run again from and checks against its own read of the
 * vault. A record the service refuses (a run raised for the same secret over another window, still open or run out)
 * does not stop the others being asked; a record of the same secret passed over for a new window is closed with them,
 * as the service finds the vault holding the secret it names. Null when every one was written down or none is open; otherwise a sentence
 * naming each that was not, and why.
 */
export async function secretWrittenDown(doors: CreateVaultDoors, vault: Hex, at: StartStanding, secret: RunSecret): Promise<string | null> {
  const run = at.run;
  if (doors.proposals.carried === undefined || run === undefined || at.standing.secret?.started !== true) return null;
  const first = replacesNothing(secret.previous);
  let open: Awaited<ReturnType<typeof secretRecordsOpen>>;
  try {
    open = await secretRecordsOpen(doors, vault);
  } catch (e) {
    return `The vault's ${first ? 'first secret run' : 'secret run'} is carried out on the chain, and the company's proposals could not be read to write it down: `
      + `${String((e as Error)?.message ?? e).replace(/\.$/u, '')}. Pressing again writes it down.`;
  }
  const refused: string[] = [];
  for (const { rec, window } of open) {
    const raise = (await standingOver(doors, vault, at, secret, window).catch(() => {
      /* Not made again with this secret: another secret's record, not written down here. */
      return undefined;
    }))?.raise;
    if (raise === undefined || raise.proposal.toLowerCase() !== String(rec.chainId).toLowerCase()) continue;
    const no = await carriedOutWrittenDown(doors, vault, secretRunRound(doors, vault, run, raise, first ? FIRST_SECRET_SUMMARY : NEW_SECRET_SUMMARY));
    if (no !== null) refused.push(`${rec.id}: ${no}`);
  }
  return refused.length === 0 ? null : refused.join(' ');
}
