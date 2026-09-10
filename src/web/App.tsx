import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  newSigningKeypair, newWrappingKeypair, newBlinding, reviveBigints, type Hex,
} from '../core/crypto.js';
import { fromHex } from '../core/crypto.js';
import { payslipKeypairFrom } from '../core/payslip-key-derive.js';
import type { CommitmentScheme } from '../core/ledger.js';
import type { RunPayments } from '../midnight/run-status.js';
import { openAccount as openSealedAccount, type CreatedAccount, type SignerSecrets } from '../core/account.js';
import { openRecord } from '../core/sealed-records.js';
import { seatOnThisDevice, type SeatOnThisDevice } from '../core/signer-leaf.js';
import { acceptSeatOnThisDevice } from './accept-seat.js';
import { assets, formatAmount, parseAmount, subtotals, type Asset, type AssetId } from '../core/assets.js';
import type {
  Account, Attestation, Installation, Invite, PayrollRun, PluginEvent, PluginManifest,
  Proposal, RosterEmployee, SealedAccount, SealedProposal, SealedRun, ShieldedEntry,
  ShieldedState, Signer,
} from '../core/types.js';
import * as keyring from './keyring.js';
import { shownError } from './shown-error.js';
import { LedgerMark } from './ledger-mark.js';
import type { Marked } from '../core/provenance.js';
import { AuthScreen, AccountPicker, WALLET_ORIGIN } from './Auth.js';
import { WalletWaiting } from './wallet-waiting.js';
import { JoinScreen, joinTokenFromLocation } from './Join.js';
/* X12 §2 — the drop box is opened HERE, on this machine, because computing the
 * code on ours would mean holding the address. */
import { acceptedCodes, type Accepted } from './accepted-address.js';
import { ProvingStrip } from './proving-strip.js';

/**
 * Key generation happens here, in the invitee's browser, using the same module
 * the server uses. Only public halves are ever sent. That is the whole reason
 * an employer cannot read an employee's payslip.
 */

/* ------------------------------------------------------------------ */
/* client                                                              */
/* ------------------------------------------------------------------ */

/**
 * Transport. The session token and key custody live in keyring.ts, so there is no
 * path that reaches the API unauthenticated by accident.
 *
 * Every response is passed through `reviveBigints` on the way in. Amounts are
 * bigints, `canonical` writes one as `{"$n":"500000"}` so it survives JSON
 * without being rounded into a float, and a plain parse leaves that tagged
 * object sitting where a number belongs — which arithmetic turns into `NaN` or
 * a string concatenation rather than an error. Doing it once here means no
 * screen has to remember which of its fields are money.
 */
const api = async <T,>(path: string, opts?: RequestInit): Promise<T> =>
  reviveBigints(await keyring.api(path, opts)) as T;

/* ------------------------------------------------------------------ */
/* money                                                               */
/* ------------------------------------------------------------------ */

/**
 * THE ONLY WAY AN AMOUNT REACHES THE SCREEN.
 *
 * The asset travels with the value and is never optional: 500000 is five
 * thousand pounds, half a USDC or a rounding error in ether, and nothing in the
 * number says which. `formatAmount` puts the point where the registry says it
 * goes — every place the asset has, trailing zeros included — so a column of
 * figures cannot be misread by a factor of ten, and the code is printed beside
 * it so two currencies in one column cannot be read as one.
 */
const money = (value: bigint, code: AssetId): string =>
  `${formatAmount(value, assets.require(code))} ${code}`;

/**
 * What a person typed, checked against the asset before it goes on the wire.
 *
 * The server parses the decimal string with the asset's decimals and refuses
 * anything that would have to be rounded. Doing the same here means "5.005" in
 * a GBP box is refused with the registry's own sentence while the person is
 * still looking at the box, and it normalises on the way out, so an amount has
 * one spelling on the wire.
 */
const decimal = (text: string, asset: Asset): string => formatAmount(parseAmount(text, asset), asset);

/** Whether the box holds something this asset can accept. Drives disabled states. */
const isAmount = (text: string, asset: Asset): boolean => {
  try { parseAmount(text, asset); return true; } catch { return false; }
};

/** Where an asset picker starts. Registry order, not a favourite. */
const defaultAsset = (): AssetId => (assets.enabled()[0] ?? assets.all()[0]).code;

/**
 * Asset choice, always from the registry.
 *
 * A hardcoded list here is how a currency gets added in a migration and stays
 * invisible in the product — and how a disabled one keeps being offered.
 */
function AssetSelect({ value, onChange, disabled }: {
  value: AssetId; onChange: (code: AssetId) => void; disabled?: boolean;
}) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>
      {assets.enabled().map(a => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
    </select>
  );
}

/**
 * A figure that has a subtotal per asset: a treasury balance, a run total.
 *
 * One line per asset, because there is deliberately no helper anywhere that
 * collapses them. Adding 5,000 GBP to 5,000 USDC and showing 10,000 is not an
 * approximation, it is meaningless — so a screen with nowhere to put a second
 * line is a screen that changes, not a total that gets summed.
 */
function PerAsset({ amounts, empty = '—' }: { amounts: Record<AssetId, bigint>; empty?: string }) {
  const rows = Object.entries(amounts).sort(([a], [b]) => a.localeCompare(b));
  if (rows.length === 0) return <>{empty}</>;
  return <>{rows.map(([code, value]) => <div key={code}>{money(value, code)}</div>)}</>;
}

/* ------------------------------------------------------------------ */

const initials = (s: string) => s.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
const monthName = (period: string) =>
  new Date(period + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const nextPeriod = (runs: Array<{ period: string }>) => {
  const used = new Set(runs.map(r => r.period));
  const d = new Date('2026-07-01');
  for (let i = 0; i < 24; i++) {
    const p = d.toISOString().slice(0, 7);
    if (!used.has(p)) return p;
    d.setMonth(d.getMonth() + 1);
  }
  return '2026-07';
};

/* ------------------------------------------------------------------ */
/* records the server holds as ciphertext                              */
/* ------------------------------------------------------------------ */

/** The numbers on a run. Everything else about it is operational. */
type RunSecrets = Pick<PayrollRun, 'employees' | 'totals' | 'proposalIds'>;
/** Everything on a proposal that says who, what or how much. */
type ProposalSecrets = Omit<Proposal,
  'id' | 'accountId' | 'status' | 'createdAt' | 'executedAt' | 'digest' | 'txRef' | 'chainId'>;

/**
 * A run as this device reads it.
 *
 * The per-asset subtotals, the recipients and the map saying which proposal
 * settles which asset are all inside the envelope, so the store cannot see that
 * this company pays anybody in ether. `proposalIds` outside the envelope is a
 * flat list with no assets in it, and it is dropped here in favour of the
 * sealed map — two copies of one list, one of them lossy, is the shape this
 * project keeps having to unpick.
 */
const openRun = (rec: SealedRun, viewingKey: Hex): PayrollRun & Marked => {
  const { sealed, keyEpoch, proposalIds: _flat, ...operational } = rec;
  return {
    ...operational,
    ...openRecord<RunSecrets>('payroll', rec.accountId, sealed, viewingKey),
    /*
     * **CARRIED DELIBERATELY AND NOT BY A SPREAD.** The marker rides in on
     * `operational` today, which means it would survive until somebody
     * destructured one more field out of the record and it would then vanish
     * with no error anywhere - and a marker that vanishes reads as *not
     * known*, which is the one answer this screen must never invent.
     */
    wiring: rec.wiring ?? null,
  };
};

/**
 * A proposal as this device reads it. The summary, who raised it and the
 * per-signer approval list are inside the envelope — the chain records
 * approvals as nullifiers precisely so nobody can tell who approved what.
 */
const openProposal = (rec: SealedProposal, viewingKey: Hex): Proposal & Marked => {
  const { sealed, keyEpoch, approvalCount, wiring: _outside, ...open } = rec;
  return {
    ...open,
    ...openRecord<ProposalSecrets>('proposals', rec.accountId, sealed, viewingKey),
    /*
     * **TAKEN OFF THE RECORD AND PUT BACK LAST, SO THE ENVELOPE CANNOT WIN.**
     *
     * The sealed half is spread after the outer fields, so any copy of this
     * that ever found its way inside would override the one the record carries
     * in the clear - and the clear one is the only copy the decision about
     * what to show can read, because that decision is taken before a key
     * exists. One marker, on the outside, and this line is what keeps it the
     * one that survives an open.
     */
    wiring: rec.wiring ?? null,
  };
};

/**
 * Somebody whose payslips this browser can open.
 *
 * The demo hands back a wrapping secret per person so the employee view can be
 * walked; a real account never does, because the company does not hold it.
 */
interface EmployeeIdentity {
  employeeId: string; name: string; title?: string; wrappingSecret?: Hex;
}

/**
 * **A SESSION CANNOT BE BUILT WITHOUT `seat`, AND `seat` CANNOT BE BUILT
 * WITHOUT THE LEAF CHECK.**
 *
 * `S33` put a money-safety refusal in this file and no test in this repository
 * imports it, so what stood in for rule 11 was a source pin over this file's
 * text — and a source pin cannot see semantics: its own round's test-coverage pass
 * defeated the first version three ways with the text intact, and `S34` found a
 * fourth without looking, because `loadDemo` built a session here without ever
 * entering `openAccount`, which is the only function the pin counted calls in.
 *
 * `SeatOnThisDevice` is branded with a symbol `src/core/signer-leaf.ts` does not
 * export, so `seatOnThisDevice` — which refuses a mismatch — is the only thing
 * in the program that can produce one. **A door into this product that skips
 * the check does not render wrong; it does not compile.** The pin is deleted
 * rather than left beside this, because two guards where one is weaker teaches a
 * reader to trust the weaker one.
 */
interface Session {
  account: Account; viewingKey: Hex; secrets: SignerSecrets[]; employees: EmployeeIdentity[];
  seat: SeatOnThisDevice;
}

/** Runs one mutation, then reloads everything the screens read. */
type Act = (fn: () => Promise<void>) => Promise<void>;

/**
 * A roster row as the LISTING answers it.
 *
 * `handedOver` is not on `RosterEmployee` on purpose — that type is what gets
 * SEALED, so a derived fact stored in it would be frozen into the envelope and
 * able to disagree with the store. The route computes it beside each row.
 */
type Roster = RosterEmployee & { handedOver?: boolean };

/**
 * **THE LINK AN ADMIN SENDS, AND THE TOKEN IS IN THE FRAGMENT.** `X11` §1,
 * `docs/scope-invitations.md` §4.
 *
 * A fragment is never sent to a server: it is not in the request line, so it is
 * not in an access log, and it is not in a `Referer` when the page loads
 * anything afterwards. A path segment is all three, and the token is both the
 * lookup and the key to the offer — so it stays out of every log it can.
 *
 * `https://app.example/join/${token}` — the placeholder domain the signer
 * invites still render — is what this replaces: it named a host nobody owns and
 * put the token in a path.
 */
const joinLink = (token: string): string =>
  `${window.location.origin}/join#${encodeURIComponent(token)}`;

type Page = 'dashboard' | 'payroll' | 'people' | 'approvals' | 'vault' | 'apps'
  | 'disclosures' | 'settings';

/* ------------------------------------------------------------------ */

/**
 * THE PAGE IS GIVEN ITS COMMITMENT SCHEME. IT DOES NOT CHOOSE ONE.
 *
 * It used to import `SimulatedCommitments` at module scope and compute an
 * invited signer's leaf from it (`:2125` below), with no argument anywhere to
 * change — so of the four places the simulation was selected, this was the only
 * one that was not a wiring decision at all. A leaf is only ever checked against
 * the scheme that made it, so a page holding a different scheme from the ledger
 * behind it writes leaves nobody can prove, and nothing says so at the time.
 *
 * Both entry points pass the scheme that came out of `src/wiring/selection.ts`
 * beside the ledger they built, which is what makes them the same one.
 */
/**
 * **THE APPLICATION, AND THE WALLET BESIDE IT RATHER THAN INSIDE ANY SCREEN.**
 *
 * The wallet is shown in a frame, and a frame that is moved or unmounted takes
 * the wallet document with it. Every screen below is swapped by a gate - signing
 * in, choosing a company, the company itself, an invitation - and an ask can
 * outlive the screen that started it. So the frame is rendered here, once, where
 * no gate reaches it.
 */
/** What a sign-out that the server did not confirm leaves true, and what changes it. */
export const SIGN_OUT_DID_NOT_END =
  'signing out did not finish on the server, so this browser may still be signed in, and '
  + 'reloading this page would pick that session up again. Reload, and sign out again from there.';
/** The same, when the sign-in this browser now holds is somebody else's, from another tab. */
export const SIGN_OUT_ANOTHER_PERSON =
  'this browser is now signed in as somebody else, from another tab, so this tab did not sign '
  + 'it out. Signing out from that tab does.';

export default function App({ commitments }: { commitments: CommitmentScheme }) {
  /*
   * **THIS APPLICATION IS THE TOP OF THE TAB OR IT IS NOTHING.** It shows the
   * person's wallet inside itself, and the wallet answers it because it is this
   * origin - so this page inside somebody else's would put a stranger around
   * both, able to draw over each. A `frame-ancestors` header says the same thing
   * wherever the host sends one; this says it in every browser and on every
   * host, because it is in the page.
   */
  if (typeof window !== 'undefined' && window.top !== window.self) {
    return (
      <div className="authwrap" data-framed-refusal>
        <div className="authcard">
          <div className="authmark">CA</div>
          <h1>Open this page on its own</h1>
          <p className="authsub">
            This page has been put inside another page, so it shows nothing here. Open it in a
            tab of its own.
          </p>
        </div>
      </div>
    );
  }
  return (
    <>
      <Screens commitments={commitments} />
      <WalletWaiting />
    </>
  );
}

function Screens({ commitments }: { commitments: CommitmentScheme }) {
  const [user, setUser] = useState<keyring.Me | null>(null);
  /**
   * **TRUE UNTIL THIS BROWSER'S SESSION HAS BEEN ASKED ABOUT.** A reload no longer
   * signs anybody out, so the sign-in screen is not shown until the server has
   * said there is nobody to pick up - otherwise a signed-in person watches a
   * sign-in button flash past on every reload.
   */
  const [resuming, setResuming] = useState(true);
  /** A company created on this tab whose keys are not sealed yet. */
  const [awaitingSetup, setAwaitingSetup] = useState<string | null>(null);
  const [myAccounts, setMyAccounts] = useState<Array<{
    id: string; name: string; signers: number; threshold: number;
  } & Marked> | null>(null);
  const [s, setS] = useState<Session | null>(null);
  const [page, setPage] = useState<Page>('dashboard');
  const [identity, setIdentity] = useState(0);       // index into secrets
  const [asEmployee, setAsEmployee] = useState<number | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const [state, setState] = useState<ShieldedState | null>(null);
  const [runs, setRuns] = useState<Array<PayrollRun & Marked>>([]);
  const [people, setPeople] = useState<Roster[]>([]);
  const [proposals, setProposals] = useState<Array<Proposal & Marked>>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  /* Null on every page that is not an invitation. */
  const [joinToken] = useState(() => joinTokenFromLocation(window.location));

  const load = useCallback(async (sess: Session) => {
    const id = sess.account.id;
    const key = sess.viewingKey;
    // The account is refetched too. It was captured once at seed time before,
    // so a newly invited signer never appeared until a full reload.
    const [acct, st, rs, pe, pr] = await Promise.all([
      api<SealedAccount>(`/api/accounts/${id}`),
      api<ShieldedState>(`/api/accounts/${id}/state?viewingKey=${key}`),
      api<SealedRun[]>(`/api/accounts/${id}/runs`),
      // The roster is sealed, so the server needs the key to read one back. A
      // route that could list employees without it would be a route that proves
      // we can read them.
      api<RosterEmployee[]>(`/api/accounts/${id}/people?viewingKey=${key}`),
      api<SealedProposal[]>(`/api/accounts/${id}/proposals`),
    ]);
    // The account arrives sealed. Opening it is this device's job now.
    setS(prev => (prev ? { ...prev, account: openSealedAccount(acct, key) } : prev));
    setState(st); setPeople(pe);
    // Runs and proposals arrive sealed for the same reason, and the amounts
    // inside them come back as real bigints because `openRecord` parses with
    // `parseCanonical`.
    setProposals(pr.map(p => openProposal(p, key)));
    setRuns(rs.map(r => openRun(r, key)).sort((a, b) => b.period.localeCompare(a.period)));
  }, []);

  /**
   * After sign in, and after anything that changes which accounts you are on.
   *
   * The list arrives sealed. `signers` and `threshold` come from the record
   * itself because the contract publishes both anyway; the NAME has to be
   * decrypted here, and cannot be shown at all for an account whose keys are not
   * on this device. That is the honest state and it now has words on screen.
   */
  const refreshAccounts = useCallback(async () => {
    const sealed = await api<SealedAccount[]>('/api/accounts');
    setMyAccounts(sealed.map(rec => {
      const open = keyring.openAccount(rec);
      return {
        id: rec.id,
        name: open?.name ?? `Locked - ${keyring.lockedCompanyReason(rec.id)}`,
        signers: rec.signerCount,
        threshold: rec.threshold,
        /* Which ledger opened this company. Absent means nothing recorded it,
         * and the picker says so rather than leaving the row looking settled. */
        wiring: rec.wiring ?? null,
      };
    }));
  }, []);

  const onAuthed = useCallback(async (u: keyring.Me) => {
    setUser(u); setBusy(true);
    try { await refreshAccounts(); }
    catch (e: any) { setErr(shownError(e, 'signing in')); } finally { setBusy(false); }
  }, [refreshAccounts]);

  /* The sign-in a reload left behind. Nobody, or a server that cannot be
   * reached, ends in the sign-in screen; a sign-in against an unreachable
   * server then says so in its own words. */
  useEffect(() => {
    if (joinToken) { setResuming(false); return undefined; }
    let alive = true;
    keyring.resumeSession()
      .then((u) => { if (alive && u) void onAuthed(u); })
      .catch((e: any) => { if (alive) setErr(shownError(e, 'picking up your session')); })
      .finally(() => { if (alive) setResuming(false); });
    return () => { alive = false; };
  }, [joinToken, onAuthed]);

  /**
   * Opens an account the user is already on. The viewing key is derived here,
   * on this device, by unwrapping it with a secret from the keyring. Nothing that
   * decrypts is fetched.
   */
  const openAccount = useCallback(async (id: string) => {
    setErr(''); setBusy(true);
    try {
      const sealed = await api<SealedAccount>(`/api/accounts/${id}`);
      /*
       * **A SEAT THIS DEVICE PUBLISHED AND DID NOT FINISH SEALING IS FINISHED
       * HERE, BEFORE ANYTHING ASKS FOR ITS KEYS.**
       *
       * The material was made durable before the leaf was sent, so this is a
       * move rather than a rescue: it matches the pending entry to a seat by
       * its signing public key and promotes it. Nothing to do is the ordinary
       * case and costs no write.
       */
      await keyring.finishPendingSeat(id, sealed);
      const keys = keyring.keysFor(id);
      if (!keys) throw new Error(keyring.lockedCompanyRefusal(id));
      const viewingKey = keyring.viewingKeyFor(sealed);
      // Sealed on the way out of the server, opened here. The server holds the
      // ciphertext and never the key, which is the claim the product makes.
      const account = openSealedAccount(sealed, viewingKey);
      // The roster needs the viewing key, and it carries no employee secret:
      // outside the demo, nobody here holds the key that opens a payslip.
      const roster = await api<RosterEmployee[]>(
        `/api/accounts/${id}/people?viewingKey=${viewingKey}`).catch(() => []);
      const employees: EmployeeIdentity[] =
        roster.map(p => ({ employeeId: p.id, name: p.name, title: p.title }));
      // `SignerSecrets` carries the signer's name; the keyring holds only keys, so
      // it comes from the roster we have just opened.
      const mine = account.signers.find(x => x.id === keys.signerId);
      /*
       * **THE STORED LEAF, AGAINST THE ONE THIS DEVICE COMPUTES.** `C325`, and
       * this is the only frame in the product where both exist.
       *
       * `Signer.leafCommitment` is published into the on-chain signer tree by
       * whoever seats this person, and `requireSigner()` recomputes it from
       * THIS machine's witnesses on every circuit. Nothing compared the two.
       * The seat is what decides who may approve a payment on an M-of-N
       * account, so a machine that cannot reproduce its own leaf is a vote the
       * threshold counts and can never collect.
       *
       * The check is HERE and not at the seat because no seating call site can
       * reach a device: `grantAccess` runs on an existing signer's machine and
       * the invitee's blinding never leaves the invitee's (decision 0003).
       * `src/core/signer-leaf.ts` carries the argument in full, and
       * the earlier position that put it at
       * the seat is corrected.
       *
       * Only `disagrees` refuses. A null leaf and a machine with no key
       * material are two different states with two different remedies, and
       * `refFor` and the branch above already speak for them.
       */
      const seat = seatOnThisDevice(mine, keys, commitments);
      const sess: Session = {
        account, viewingKey, employees, seat,
        secrets: [{
          ...keys, name: mine?.name ?? 'You',
          /* Absent on a bundle sealed before `S34`, and absent means the
           * scheme's default — which is what those seats were written under.
           */
          scope: keys.scope ?? commitments.allVaults(),
        }],
      };
      setS(sess); await load(sess);
    } catch (e: any) { setErr(shownError(e, 'opening a company')); } finally { setBusy(false); }
  }, [load, commitments]);

  /**
   * **ASKING THE WALLET TO OPEN A COMPANY.**
   *
   * The other half of `PI1`'s sign-in. Nothing here decides anything: which
   * company may be opened comes from the server, the key comes from the
   * wallet after a person presses a button on the wallet's own screen, and
   * `openAccount` below is the same path a password sign-in takes from there.
   *
   * `refreshAccounts` runs in between so the list is re-read with a keyring
   * that can now open it — before this, every name on that list said *locked*.
   */
  const unlockWithWallet = useCallback(async (id: string) => {
    setErr(''); setBusy(true);
    try {
      /* The same refusal the sign-in button makes, for the same reason: with no
       * origin configured this would open `undefined/#/approve`, which is this
       * site's own page, and post an ask to it. */
      if (!WALLET_ORIGIN) {
        throw new Error(
          'this build does not know where your wallet is served from, so it cannot open '
          + 'it. VITE_WALLET_ORIGIN has to be set when the site is built.');
      }
      await keyring.unlockWithWallet(id, WALLET_ORIGIN);
      await refreshAccounts();
    } catch (e: any) { setErr(shownError(e, 'unlocking a company with a wallet')); setBusy(false); return; }
    setBusy(false);
    await openAccount(id);
  }, [refreshAccounts, openAccount]);

  const createAccount = useCallback(async (name: string) => {
    setErr(''); setBusy(true);
    try {
      const created = await api<CreatedAccount>('/api/accounts', {
        method: 'POST',
        body: JSON.stringify({ name, signers: [{ name: user!.name, role: 'admin' }], threshold: 1 }),
      });
      // The secrets come back once and are never sent again. Sealing them into
      // the keyring here is what makes the account usable from a second device.
      const mine = created.secrets[0];
      await keyring.rememberAccount(created.account.id, {
        signerId: mine.signerId, signingSecret: mine.signingSecret,
        wrappingSecret: mine.wrappingSecret, blinding: mine.blinding,
        /* The scope this seat's leaf was made under, carried from the response
         * rather than defaulted here. */
        scope: mine.scope,
      });
      await refreshAccounts();
      await openAccount(created.account.id);
    } catch (e: any) { setErr(shownError(e, 'creating a company')); } finally { setBusy(false); }
  }, [user, refreshAccounts, openAccount]);

  const loadDemo = useCallback(async () => {
    setErr(''); setBusy(true);
    try {
      const seeded = await api<CreatedAccount & { employees: EmployeeIdentity[] }>(
        '/api/demo/seed', { method: 'POST' });
      const mine = seeded.secrets[0];
      await keyring.rememberAccount(seeded.account.id, {
        signerId: mine.signerId, signingSecret: mine.signingSecret,
        wrappingSecret: mine.wrappingSecret, blinding: mine.blinding, scope: mine.scope,
      });
      await refreshAccounts();
      // The demo hands over every signer's secrets so the approval flow can be
      // walked alone. A real account only ever holds your own.
      /*
       * **AND THE LEAF CHECK RUNS HERE TOO, WHICH IT DID NOT BEFORE.**
       *
       * This door built a session without going near `openAccount`, so the
       * source pin that counted call sites inside `openAccount` was green while
       * a whole second way into the product skipped the refusal. That is the
       * fourth defeat the pin's own comment said would be found. It is not
       * possible to write now: `Session.seat` has one constructor and it is the
       * check.
       */
      const seat = seatOnThisDevice(
        seeded.account.signers.find(x => x.id === mine.signerId), mine, commitments);
      const sess: Session = {
        account: seeded.account, viewingKey: seeded.viewingKey,
        secrets: seeded.secrets, employees: seeded.employees, seat,
      };
      setS(sess); await load(sess);
    } catch (e: any) { setErr(shownError(e, 'loading the demo data')); } finally { setBusy(false); }
  }, [refreshAccounts, load]);

  /**
   * **STARTING A COMPANY FROM A WALLET SESSION.**
   *
   * `createAccount` above cannot serve this and the difference is an ORDER,
   * not a branch: it seals the founder's secrets into the keyring immediately,
   * which needs a key, and on a wallet session there is none until the company
   * exists and its address can be asked for. **Three steps, and the second
   * cannot precede the first.** `keyring.createCompanyWithWallet` is where
   * that order lives, so it is one call here and not three.
   *
   * The same origin refusal the two wallet buttons beside it make, for the same
   * reason: with none configured this would open `undefined/#/approve`, which
   * is this site's own page, and post an ask to it.
   */
  const createWithWallet = useCallback(async (name: string) => {
    setErr(''); setBusy(true);
    try {
      if (!WALLET_ORIGIN) {
        throw new Error(
          'this build does not know where your wallet is served from, so it cannot open '
          + 'it. VITE_WALLET_ORIGIN has to be set when the site is built.');
      }
      const { accountId } = await keyring.createCompanyWithWallet(
        { name, signers: [{ name: user!.name || 'You', role: 'admin' }], threshold: 1 },
        WALLET_ORIGIN);
      setAwaitingSetup(keyring.companyAwaitingSetup());
      await refreshAccounts();
      setBusy(false);
      await openAccount(accountId);
      return;
    } catch (e: any) {
      /* Kept, deliberately: the company may exist with its keys unsealed, and
       * the screen has to be able to offer to finish it. */
      setAwaitingSetup(keyring.companyAwaitingSetup());
      setErr(shownError(e, 'creating a company with a wallet'));
    }
    setBusy(false);
  }, [user, refreshAccounts, openAccount]);

  /** Steps 2 and 3 again, for a person who declined their wallet the first time. */
  const finishSetup = useCallback(async () => {
    setErr(''); setBusy(true);
    try {
      if (!WALLET_ORIGIN) throw new Error('this build does not know where your wallet is.');
      const { accountId } = await keyring.finishCompanyCreation(WALLET_ORIGIN);
      setAwaitingSetup(keyring.companyAwaitingSetup());
      await refreshAccounts();
      setBusy(false);
      await openAccount(accountId);
      return;
    } catch (e: any) {
      setAwaitingSetup(keyring.companyAwaitingSetup());
      setErr(shownError(e, 'finishing a company that was left half-created'));
    }
    setBusy(false);
  }, [refreshAccounts, openAccount]);

  /* Set when a sign-out did not end the sign-in on the server, and shown on the
   * sign-in screen that follows it. */
  const [signOutNotice, setSignOutNotice] = useState('');
  const signOut = useCallback(async () => {
    // Awaited so the server has actually ended the session before the screen
    // says it has. S-3: this used to clear the tab and nothing else.
    const { ended, anotherPerson } = await keyring.signOut();
    setSignOutNotice(ended ? '' : anotherPerson ? SIGN_OUT_ANOTHER_PERSON : SIGN_OUT_DID_NOT_END);
    setUser(null); setMyAccounts(null); setS(null); setState(null); setPage('dashboard');
  }, []);

  // Declared above the gates below. Hooks cannot sit after an early return.
  const pending = useMemo(
    () => proposals.filter(p => p.status === 'open' || p.status === 'approved'), [proposals]);

  /* ---------------- gates ---------------- */

  /*
   * **THE INVITATION SCREEN IS ABOVE EVERY OTHER GATE, INCLUDING SIGN-IN.**
   *
   *
   * It is public: the person opening it has no account yet, and seeing the
   * offer before accepting it is the whole reason `GET /api/invites/:token/offer`
   * exists. Putting it below the sign-in gate would show a stranger a login
   * form and no explanation of why they are there.
   *
   * The token is read from the FRAGMENT and never from the path — `Join.tsx`
   * has the reasoning. Read once at render rather than watched, because this
   * page is opened by following a link and nothing inside it navigates.
   */
  if (joinToken) return <JoinScreen token={joinToken} />;

  /*
   * MOUNTED ONCE, ABOVE EVERY GATE. Every wallet ask in `keyring.ts`
   * announces itself to this, whichever screen started it, so no screen has to
   * remember to draw a wait of its own.
   */
  if (!user && resuming) {
    return (
      <div className="authwrap" data-resuming>
        <div className="authcard">
          <div className="authmark">CA</div>
          <p className="authsub">Checking whether this browser is still signed in…</p>
        </div>
      </div>
    );
  }
  if (!user) {
    return <AuthScreen onDone={onAuthed} notice={signOutNotice} />;
  }

  if (!s || !state) {
    return <>
      <AccountPicker
        user={user} accounts={myAccounts ?? []} busy={busy} err={err}
        onOpen={openAccount} onUnlock={unlockWithWallet}
        onCreate={createAccount} onCreateWithWallet={createWithWallet}
        onFinishSetup={finishSetup} awaitingSetup={awaitingSetup}
        onDemo={loadDemo} onSignOut={signOut} />
    </>;
  }

  const act = async (fn: () => Promise<void>) => {
    setErr(''); setBusy(true);
    try { await fn(); if (s) await load(s); }
    catch (e: any) { setErr(shownError(e, 'this screen')); } finally { setBusy(false); }
  };

  const me = s.secrets[Math.min(identity, s.secrets.length - 1)];
  const meSigner = s.account.signers.find(x => x.id === me.signerId);

  /* ---------------- employee portal ---------------- */
  if (asEmployee !== null) {
    return <EmployeePortal
      session={s} runs={runs} employee={s.employees[asEmployee]}
      onExit={() => setAsEmployee(null)} />;
  }

  const nav = (id: Page, ico: string, label: string, badge?: number) => (
    <button className={'nav' + (page === id ? ' on' : '')}
      onClick={() => { setPage(id); setOpenRunId(null); }}>
      <span className="ico">{ico}</span>{label}
      {badge ? <span className="badge">{badge}</span> : null}
    </button>
  );

  const titles: Record<Page, [string, string]> = {
    dashboard:   ['Dashboard', 'Northwind Ltd'],
    payroll:     ['Payroll', 'Runs and settlement'],
    people:      ['People', `${people.filter(p => p.status === 'active').length} active`],
    approvals:   ['Approvals', `${pending.length} awaiting signature`],
    vault:       ['Vault', 'Where the money is, and who has been paid from it'],
    apps: ['Apps', 'Extensions installed on this account'],
    disclosures: ['Disclosures', 'Proofs issued to third parties'],
    settings:    ['Settings', 'Signers, policy and visibility'],
  };

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <div className="mark">N</div>
          <div><b>Northwind Ltd</b><small>Confidential Accounts</small></div>
        </div>

        <div className="navlabel">Manage</div>
        {nav('dashboard', '◈', 'Dashboard')}
        {nav('payroll', '▤', 'Payroll')}
        {nav('people', '☰', 'People')}
        {nav('approvals', '✓', 'Approvals', pending.length)}

        {nav('vault', '▣', 'Vault')}
        {nav('apps', '◱', 'Apps')}

        <div className="navlabel">Compliance</div>
        {nav('disclosures', '◇', 'Disclosures')}
        {nav('settings', '⚙', 'Settings')}

        <div className="sidefoot">
          <div className="navlabel" style={{ padding: '0 8px 6px' }}>View as employee</div>
          <select value="" onChange={e => e.target.value && setAsEmployee(Number(e.target.value))}>
            <option value="">Choose a person…</option>
            {s.employees.map((e, i) => <option key={e.employeeId} value={i}>{e.name}</option>)}
          </select>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <h1>{titles[page][0]}</h1>
            <div className="sub">{titles[page][1]}</div>
          </div>
          <div className="spacer" />
          <div className="who">
            <div className="avatar">{initials(meSigner?.name ?? me.name)}</div>
            <div>
              <select value={identity} onChange={e => setIdentity(Number(e.target.value))}
                style={{ border: 'none', background: 'none', padding: '2px 0', fontWeight: 600, width: 'auto' }}>
                {s.secrets.map((x, i) => {
                  const sg = s.account.signers.find(y => y.id === x.signerId);
                  return <option key={x.signerId} value={i}>{sg?.name ?? x.name}</option>;
                })}
              </select>
              <div className="sub" style={{ textTransform: 'capitalize' }}>{meSigner?.role ?? ''}</div>
            </div>
            <button className="signout" onClick={() => { setS(null); setState(null); }}>Accounts</button>
            <button className="signout" onClick={signOut}>Sign out</button>
          </div>
        </header>

        {/*
          * **PINNED UNDER THE HEADER AND ACROSS THE WHOLE APPLICATION, NOT
          * INSIDE THE SCREEN THAT STARTED THE WORK.**
          *
          * Proving an approval takes over two minutes on this device, measured,
          * and it runs on a thread that is not this one - so the person is free
          * to go and look at anything they like while it happens. A progress
          * indicator that lived on the approvals screen would be an indicator
          * they have to stay on one page to see, which gives back the only
          * thing moving the work off this thread bought.
          *
          * It renders nothing at all when nothing is in flight.
          */}
        <ProvingStrip />

        <div className="content">
          {err && <div className="err">{err}</div>}

          {page === 'dashboard' && <Dashboard
            state={state} runs={runs} people={people} pending={pending}
            onGo={setPage} />}

          {page === 'payroll' && (openRunId
            ? <RunDetail
                run={runs.find(r => r.id === openRunId)} proposals={proposals}
                account={s.account} session={s} me={me} busy={busy}
                onBack={() => setOpenRunId(null)} act={act} />
            : <PayrollList runs={runs} people={people} busy={busy} session={s}
                onOpen={setOpenRunId} act={act} />)}

          {page === 'people' && <People people={people} session={s} busy={busy} act={act} />}

          {page === 'approvals' && <Approvals
            pending={pending} account={s.account} session={s} me={me} busy={busy}
            runs={runs} act={act} />}

          {page === 'vault' && <Vault />}

          {page === 'apps' && <Apps session={s} me={me} busy={busy} act={act} />}

          {page === 'disclosures' && <Disclosures runs={runs} session={s} busy={busy} act={act} />}

          {/* `me` is here since `R5`: proposing a vault's threshold is an act by
              a named signer, exactly as every other governance round is. */}
          {page === 'settings' && <Settings account={s.account} state={state} session={s} me={me}
            busy={busy} act={act} commitments={commitments} />}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* who has been paid                                                   */
/* ------------------------------------------------------------------ */

/**
 * **WHO HAS BEEN PAID ON THIS RUN, AND WHERE THAT ANSWER CAME FROM.**
 *
 * A run is paid one payee at a time, so at any moment some people have their
 * money and some do not. **The number that matters is not how many — it is
 * which ones**, and a run shown as finished while two people are unpaid is
 * worse than one that visibly failed, because nobody goes looking.
 *
 * ── THE RULE THIS SCREEN IS BUILT ON ─────────────────────────────────────
 *
 * **THERE ARE THREE ANSWERS HERE AND ONLY TWO OF THEM ARE ABOUT PEOPLE.**
 * *These were paid*, *these were not*, and *nobody can tell you*. The third is
 * not a number and is never drawn as one: no zero, no empty list, no progress
 * bar sitting at nought. A list of unpaid people, shown on the strength of a
 * question nobody answered, is the failure this whole screen exists to prevent.
 *
 * The service answers in a shape that makes that impossible to get wrong: when
 * it cannot say, there is no count in the body to draw.
 */
function RunPaymentsCard({ runId, viewingKey }: { runId: string; viewingKey: string }) {
  const [view, setView] = useState<RunPayments | null>(null);
  const [failed, setFailed] = useState('');

  useEffect(() => {
    let live = true;
    setView(null); setFailed('');
    /* The key travels in the body: it decrypts this company's records, and a
     * web address is written down by every machine between here and the
     * service. */
    api<RunPayments>(`/api/runs/${runId}/payments`,
      { method: 'POST', body: JSON.stringify({ viewingKey }) })
      .then(v => { if (live) setView(v); })
      .catch(e => { if (live) setFailed(shownError(e, 'who has been paid on this run')); });
    return () => { live = false; };
  }, [runId, viewingKey]);

  /*
   * **THE PROVENANCE LINE APPEARS ONLY WHERE SOMETHING WAS ACTUALLY READ.**
   * A heading saying *read from the account's record* sitting above a body
   * saying the question was not answered is a claim about a read that did not
   * happen — and it is the reading somebody takes at speed, which is the only
   * speed this card is ever read at.
   */
  const head = (from?: string) => (
    <div className="hd"><h3>Who has been paid</h3>
      {from && <span className="sub">{from}</span>}</div>
  );

  if (failed) {
    return <div className="card">{head()}<div className="bd"><div className="err">{failed}</div></div></div>;
  }
  if (!view) {
    return <div className="card">{head()}<div className="bd">
      <div className="empty">Asking…</div></div></div>;
  }

  /*
   * **THE UNANSWERED CASE, AND IT IS DELIBERATELY NOT A TABLE WITH NOTHING IN
   * IT.** An empty table of payees reads as *nobody has been paid*. A sentence
   * saying the question was not answered reads as what it is.
   */
  if (!view.answered) {
    return (
      <div className="card">{head()}<div className="bd">
        <div className="empty">
          <b>Nobody can be told yet.</b>
          <div style={{ marginTop: 8 }}>{view.why}</div>
        </div>
        {view.payees > 0 && <div className="hint" style={{ marginTop: 14 }}>
          This run has {view.payees} {view.payees === 1 ? 'payee' : 'payees'} on it.{' '}
          <b>That number is from this company's own record of the run, and says nothing about
          whether any of them has been paid.</b>
        </div>}
      </div></div>
    );
  }

  const st = view.status;
  const total = st.paid.length + st.outstanding.length + st.skipped.length;
  const chip = (state: string) => state === 'paid' ? 'ok'
    : state === 'skipped' ? 'off'
    : state === 'failed' ? 'no' : 'pend';
  const everyone = [...st.paid, ...st.failed,
    ...st.outstanding.filter(p => p.state === 'unsent'), ...st.skipped]
    .sort((a, b) => a.index - b.index);

  return (
    <div className="card">{head("read from the account's own record of completed payments")}
      <div className="bd">
        {/*
          * **THE DISCLAIMER GOES ABOVE THE NUMBERS, NOT BESIDE THEM.**
          * An unverified view is a list of payments that may belong to another
          * payroll entirely — a stale run, an edited spreadsheet, last month's
          * file — and every name and every state below it would then be about
          * somebody else. It is not a footnote to the figures; it is a
          * condition on reading them at all.
          */}
        {!st.verified && <div className="hint" style={{ marginBottom: 14 }}>
          <b>Not checked against the approved run.</b> These payees have not been proved to be
          this run's, so everything below may describe a different payroll. Treat it as a
          working note rather than an answer.
        </div>}

        <div className="stats" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
          <div className="stat"><div className="k">Paid</div>
            <div className="v">{st.paid.length}</div>
            <div className="m">of {total}</div></div>
          <div className="stat"><div className="k">Outstanding</div>
            <div className="v">{st.outstanding.length}</div>
            {/* **NAMED SEPARATELY FROM OUTSTANDING, ALWAYS.** Somebody reading
                "3 outstanding" fills the gap themselves — usually with "the
                leavers" — and the person whose payment was refused four times
                waits another month. */}
            <div className="m">{st.failed.length} of them refused</div></div>
          <div className="stat"><div className="k">Not being paid</div>
            <div className="v">{st.skipped.length}</div>
            <div className="m">decided here, not on chain</div></div>
          <div className="stat"><div className="k">Window</div>
            <div className="v" style={{ fontSize: 20 }}>{st.phase}</div>
            <div className="m">{st.stranded.length > 0
              ? `${st.stranded.length} still owed` : '—'}</div></div>
        </div>

        {/*
          * The one state nobody may miss: the window has closed with people
          * still owed, and nothing can pay them from this run any more.
          */}
        {st.stranded.length > 0 && <div className="err" style={{ marginTop: 14 }}>
          The payment window has closed with {st.stranded.length}{' '}
          {st.stranded.length === 1 ? 'person' : 'people'} still owed. They cannot be paid from
          this run at all now — they need a new one.
        </div>}
      </div>

      <div className="bd tight">
        <table>
          <thead><tr>
            <th>#</th><th>State</th><th>Why</th>
          </tr></thead>
          <tbody>
            {everyone.map(p => (
              <tr key={p.index}>
                <td className="name">{p.index + 1}</td>
                <td><span className={`chip ${chip(p.state)}`}>{p.state}</span></td>
                <td>
                  {/* **A SKIP CARRIES A NAME AND A REASON OR IT IS NOT A
                      RECORD.** An unpaid person with nobody's name on the
                      decision is the report saying "somebody decided
                      something". */}
                  {p.state === 'skipped' && p.skipDecision &&
                    <span className="sub">{p.skipDecision.reason} — {p.skipDecision.by}</span>}
                  {p.state === 'failed' && p.attempts &&
                    <span className="sub">{p.attempts.tries}{' '}
                      {p.attempts.tries === 1 ? 'try' : 'tries'}
                      {p.attempts.lastError ? ` — ${p.attempts.lastError}` : ''}</span>}
                  {p.state === 'unsent' && <span className="sub">not attempted</span>}
                  {p.state === 'paid' && <span className="sub">recorded by the account</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bd">
        <div className="hint">{view.sentence}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* vault                                                               */
/* ------------------------------------------------------------------ */

/**
 * **THE VAULT SURFACE, BUILT FOR THE END STATE.**
 *
 * An account is an authority over a vault, not a holder of money: the vault is
 * where the money actually sits and it is the thing that pays people. Every
 * control that surface will carry is on this screen now, disabled, each with
 * the reason it cannot be used — because a control that is missing is a control
 * nobody can ask about, and the questions people ask about this screen are the
 * ones worth answering before it goes live.
 *
 * **NOT ONE OF THESE IS A PLACEHOLDER FOR A FEATURE THAT MERELY HAS NOT BEEN
 * TYPED.** Each reason below is a thing that is genuinely not settled, and two
 * of them are reasons not to ship the button rather than reasons it is late.
 */
function Vault() {
  return (
    <div className="stack">
      <div className="card">
        <div className="hd"><h3>This account's vaults</h3>
          <span className="sub">a vault is taken on by a round every signer approves</span></div>
        <div className="bd">
          <div className="empty">
            <b>No vault is listed here.</b>
            <div style={{ marginTop: 8 }}>
              This service keeps no record of which vaults an account has taken on, and this
              screen asks nothing — there is no read here to show you the result of. The
              account's own published list is deliberately not the answer either: it can be
              missing exactly the funded vault that is still paying people out, so a screen
              built on it would be confidently short.
            </div>
          </div>
          <div className="hint" style={{ marginTop: 14 }}>
            Taking on a vault is a round every signer approves, and this product raises no such
            round yet. There is a limitation to fix before it can: the device that opens a round
            is currently the only one able to close it, and opening a second round from that
            device destroys the first one's only key — no error, and the fee already spent. Once
            that is fixed, several rounds can be open at once, which the account itself has
            always allowed.
          </div>
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="hd"><h3>Deploy a vault</h3>
            <span className="sub">publishes a contract and fixes who may maintain it</span></div>
          <div className="bd">
            <div className="field"><label>Name</label>
              <input disabled placeholder="Payroll" /></div>
            <div className="field"><label>Who may maintain it afterwards</label>
              <select disabled><option>One key, held here</option></select></div>
            <button className="btn pri" disabled>Deploy</button>
            <div className="hint" style={{ marginTop: 14 }}>
              <b>Not available yet.</b> Deploying a vault fixes, permanently, who may maintain
              it. A maintenance key that nobody actually holds is accepted by every check this
              product makes today, and the vault it produces can never be changed again by
              anyone. That is not a control to put behind a button while it is still true.
            </div>
          </div>
        </div>

        <div className="card">
          <div className="hd"><h3>What a vault holds</h3>
            <span className="sub">read from the chain, checked against this device's record</span></div>
          <div className="bd">
            <div className="field"><label>Vault</label>
              <select disabled><option>No vault</option></select></div>
            <button className="btn" disabled>Read the balance</button>
            <div className="hint" style={{ marginTop: 14 }}>
              <b>Not available yet.</b> A vault's balance is the chain's answer reconciled
              against this device's own record of the notes the vault holds. There are three
              outcomes and only one is a number: the two agree, they disagree, or the chain
              could not be reached. When it is built, this will say which of the three happened
              — and it will never fall back to the last number it saw.
            </div>
          </div>
        </div>

        <div className="card">
          <div className="hd"><h3>Put money in</h3>
            <span className="sub">a call into the vault, never a transfer to it</span></div>
          <div className="bd">
            <div className="two">
              <div className="field"><label>Asset</label>
                <select disabled><option>GBP</option></select></div>
              <div className="field"><label>Amount</label><input disabled placeholder="0.00" /></div>
            </div>
            <button className="btn pri" disabled>Fund</button>
            {/*
              * **THE DISTINCTION IN THIS SENTENCE IS THE WHOLE DEFENCE, AND IT
              * IS THE ONE THING ON THIS PAGE THAT MUST NOT BE LOOSENED.**
              * Funding is a call: the vault takes the money in and records
              * holding it, in one transaction. A plain send to a vault's
              * address does the first half only — the money arrives, the vault
              * has no record of it, and every later payment refuses to spend
              * it. It is then on chain, owned by the vault, and spendable by
              * nobody, permanently, and no contract can refuse the send that
              * caused it. That is why no vault address is shown anywhere in
              * this product, and why this card says CALL and not TRANSFER.
              */}
            <div className="hint" style={{ marginTop: 14 }}>
              <b>Not available yet.</b> Money is put into a vault by calling it, not by sending
              to it: the vault has to take the money in and record that it holds it, in one
              step. A plain send to a vault leaves money it can never spend — permanently, with
              no way to recover it and nothing able to refuse it — which is why this product
              never shows a vault address to paste into a wallet.
            </div>
          </div>
        </div>

        <div className="card">
          <div className="hd"><h3>Pay a run from a vault</h3>
            <span className="sub">one payee at a time, against an approved round</span></div>
          <div className="bd">
            <div className="field"><label>Run</label>
              <select disabled><option>No payable run</option></select></div>
            <button className="btn pri" disabled>Pay</button>
            <div className="hint" style={{ marginTop: 14 }}>
              <b>Not available yet.</b> A vault pays against the payout root a run was approved
              on, inside the window its signers approved, and this product writes neither yet.
              A run raised without them collects real signatures and can never be paid, which is
              why the control that would raise one is disabled on the payroll screen too.
            </div>
          </div>
        </div>
      </div>

      {/*
        * **NOT DRAWN AT ALL, AND SAYING SO IS THE POINT.** A spending cap that
        * cannot be lifted does not restrain one payment, it stops every payment
        * that vault will ever make. Nothing in this product will offer to set
        * one until there is an answer to how it is lifted again.
        */}
      <div className="card">
        <div className="hd"><h3>Spending limits</h3>
          <span className="sub">deliberately not offered</span></div>
        <div className="bd">
          <div className="hint">
            <b>There is no control here on purpose.</b> A limit that could be set and not lifted
            again would not cap one payment — it would stop every payment that vault would ever
            make, permanently, with no way back. Until setting one can be undone, offering it
            would be offering to freeze a payroll.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* dashboard                                                           */
/* ------------------------------------------------------------------ */

function Dashboard({ state, runs, people, pending, onGo }: {
  state: ShieldedState; runs: PayrollRun[]; people: RosterEmployee[];
  pending: Proposal[]; onGo: (page: Page) => void;
}) {
  const active = people.filter(p => p.status === 'active');
  /*
   * The wage bill, PER ASSET. There is no one figure to show here: a company
   * paying some people in pounds and some in USDC has two monthly totals, and
   * one number covering both would be a number with no unit.
   */
  const monthly = subtotals(active.map(p => ({ asset: p.asset, amount: p.baseAmount })));
  const settled = runs.filter(r => r.status === 'settled');
  const upcoming = nextPeriod(runs);

  /*
   * **THE TREASURY TILE STOOD HERE AND IS DELETED.**
   *
   * It rendered `state.balances` with a runway line underneath. The account
   * keeps no balance — the field is gone, not empty — so there is nothing here
   * to read. Deleted rather than shown empty or disabled: this feature was
   * removed on purpose, and a placeholder would say it is coming back.
   */
  return (
    <>
      <div className="stats">
        <div className="stat">
          <div className="k">Monthly payroll</div>
          <div className="v" style={{ fontSize: 20 }}><PerAsset amounts={monthly} empty="nobody active" /></div>
          <div className="m">{active.length} people</div>
        </div>
        <div className="stat">
          <div className="k">Awaiting approval</div><div className="v">{pending.length}</div>
          <div className="m">{pending.length ? 'needs your signature' : 'nothing pending'}</div>
        </div>
        <div className="stat">
          <div className="k">Runs settled</div><div className="v">{settled.length}</div>
          <div className="m">last {settled[0] ? monthName(settled[0].period) : 'none'}</div>
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="hd"><h3>Next payroll</h3><span className="sub">{monthName(upcoming)}</span></div>
          <div className="bd">
            <div className="row"><span>Recipients</span><span className="r">{active.length}</span></div>
            {/* A subtotal per asset, one row each. Never one line summing them. */}
            {Object.entries(monthly).sort(([a], [b]) => a.localeCompare(b)).map(([code, amount]) => (
              <div className="row" key={code}>
                <span>Gross total, {code}</span><span className="r">{money(amount, code)}</span>
              </div>
            ))}
            {/* THE SETTLEMENT ROW STOOD HERE — "One aggregate transfer per
                asset". Nothing transfers anything: the account has no send
                operation and the circuit that closed a round is deleted.
                Deleted rather than reworded, because any wording of
                it is a claim about a payment this system cannot make. */}
            <div style={{ marginTop: 16 }}>
              <button className="btn pri" onClick={() => onGo('payroll')}>Go to payroll</button>
            </div>
            <div className="hint" style={{ marginTop: 14 }}>
              Individual salaries are shielded.
            </div>
          </div>
        </div>

        <div className="card">
          <div className="hd"><h3>Recent activity</h3></div>
          <div className="bd tight">
            <table>
              <tbody>
                {state.entries.slice(0, 6).map((e: ShieldedEntry) => (
                  <tr key={e.id}>
                    <td>
                      <div className="name">{e.counterparty}</div>
                      <div className="sub2">{e.memo || e.kind}</div>
                    </td>
                    {/* Each line carries the asset that moved; the log is one
                        sequence across all of them, so the code is not optional. */}
                    {/* THE INCOMING BRANCH STOOD HERE — a `deposit` entry drawn
                        in the positive colour with a leading `+`. Nothing can
                        write one: the account's deposit is deleted, so
                        every entry this log can hold is a payment out. */}
                    <td className="num">−{money(e.amount, e.asset)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* payroll                                                             */
/* ------------------------------------------------------------------ */

function PayrollList({ runs, people, busy, session, onOpen, act }: {
  runs: Array<PayrollRun & Marked>; people: Roster[]; busy: boolean; session: Session;
  onOpen: (id: string) => void; act: Act;
}) {
  const active = people.filter(p => p.status === 'active');
  const upcoming = nextPeriod(runs);

  /*
   * **THE TWO PENDING STATES, SPLIT THE WAY THE SERVICE SPLITS THEM.**
   * `A-2`. Somebody who has handed nothing over is waiting on THEM; somebody
   * whose drop box is full is waiting on an admin HERE. The run refuses in two
   * different sentences and this screen must not collapse what it refuses in
   * two into one line, because the second group is the one somebody in this
   * room can clear this afternoon.
   */
  const pendingThem = people.filter(p => p.status === 'pending' && !p.handedOver);
  const pendingUs = people.filter(p => p.status === 'pending' && p.handedOver);
  const skipped = [...pendingThem, ...pendingUs];

  const [reason, setReason] = useState('');
  const [read, setRead] = useState(false);

  /*
   * **NO `by` IN THIS BODY.** Whose decision it was comes from the signed-in caller on
   * the server, not from anything this screen can put in a request. A name a
   * client supplies is a claim, and the record this produces is permanent.
   */
  const create = (skipPending?: { employeeIds: string[]; reason: string }) =>
    act(async () => {
      // The run is drawn from the sealed roster, so the server needs the key to
      // read the salaries it is drawing from. No amount is sent: each person is
      // paid what their own record says, in the asset their record names.
      await api(`/api/accounts/${session.account.id}/runs`, {
        method: 'POST',
        body: JSON.stringify({ period: upcoming, viewingKey: session.viewingKey, skipPending }),
      });
      setReason(''); setRead(false);
    });

  return (
    <div className="card">
      <div className="hd">
        <h3>Payroll runs</h3>
        <span className="sub">{runs.length} total</span>
        <div className="spacer" />
        <button className="btn pri" onClick={() => create()} disabled={busy || !active.length}>
          Run {monthName(upcoming)}
        </button>
      </div>
      {skipped.length > 0 && (
        /*
         * **THE CONFIRMATION, AND ITS DEFAULT IS REFUSE.**
         *
         * The button above sends NO acknowledgement, so pressing it while
         * anybody is pending is refused by the service and the refusal names
         * them. This panel is the second press, and everything it asks for is
         * something the record needs afterwards: **the names, so nobody is
         * dropped unread; a person, because a payroll decision with no name on
         * it is nobody's; and a reason, because a blank one is the report saying
         * "somebody decided something".**
         *
         * **THE NAMES ARE SENT, NOT A FLAG.** The service compares them against
         * who it is actually about and refuses if the two lists differ — so a
         * confirmation given before somebody else's invitation went out cannot
         * quietly cover them too.
         */
        <div className="bd">
          <div className="field">
            <label>Not everyone will be paid this month</label>
            <div className="hint">
              A run pays the people who are set up.
              {' '}{skipped.length === 1 ? 'One person is not' : `${skipped.length} people are not`},
              {' '}so this run leaves {skipped.length === 1 ? 'that person' : 'them'} out — and
              nobody is left out of a payroll run without somebody putting their name to it.
            </div>
          </div>
          {pendingThem.length > 0 && (
            <div className="hint">
              <strong>Waiting on them:</strong> {pendingThem.map(p => p.name).join(', ')} —
              {' '}{pendingThem.length === 1 ? 'has' : 'have'} not set up yet. Nothing here moves
              this along; they hold the invitation.
            </div>
          )}
          {pendingUs.length > 0 && (
            <div className="hint">
              <strong>Waiting on you:</strong> {pendingUs.map(p => p.name).join(', ')} —
              {' '}{pendingUs.length === 1 ? 'has' : 'have'} handed over and
              {' '}{pendingUs.length === 1 ? 'is' : 'are'} waiting to be admitted. Admitting them
              on the People screen puts them on this run instead.
            </div>
          )}
          <div className="field">
            <label>Why are they being left out?</label>
            <input value={reason} onChange={e => setReason(e.currentTarget.value)}
              placeholder="Paying everyone else on time; these two join next month" />
          </div>
          <label className="hint" style={{ display: 'block' }}>
            <input type="checkbox" checked={read}
              onChange={e => setRead(e.currentTarget.checked)} />
            {' '}I have read the names above and this run goes ahead without them.
          </label>
          <button className="btn" disabled={busy || !active.length || !read || !reason.trim()}
            onClick={() => create({
              employeeIds: skipped.map(p => p.id), reason: reason.trim(),
            })}>
            Run {monthName(upcoming)} without {skipped.length === 1 ? 'them' : `those ${skipped.length}`}
          </button>
        </div>
      )}
      <div className="bd tight">
        {runs.length === 0
          ? <div className="empty"><b>No runs yet</b>Create one to pay your team.</div>
          : <table>
              <thead><tr>
                {/* "Totals", plural: a run has a subtotal per asset and never one figure. */}
                <th>Period</th><th>Recipients</th><th className="num">Totals</th>
                <th>Status</th><th>Ledger</th><th>Settled</th>
              </tr></thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id} className="click" onClick={() => onOpen(r.id)}>
                    <td className="name">{monthName(r.period)}</td>
                    <td>{r.employees.length}</td>
                    <td className="num"><PerAsset amounts={r.totals} /></td>
                    <td><span className={'chip ' + (r.status === 'settled' ? 'ok' : r.status === 'proposed' ? 'pend' : 'off')}>
                      {r.status}</span></td>
                    {/*
                      * A settled run and a rehearsed one carry the same word in
                      * the column to the left, which is exactly the confusion
                      * this one removes: `settled` says the governance round reached its
                      * threshold, and says nothing about whether a chain was
                      * ever involved.
                      */}
                    <td><LedgerMark of={r} /></td>
                    <td className="sub2">{r.settledAt ? new Date(r.settledAt).toLocaleDateString('en-GB') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>}
      </div>
    </div>
  );
}

/**
 * One run, and ONE APPROVAL ROUND PER SETTLEMENT ASSET.
 *
 * The screen used to assume a run had one total and one proposal, and offered
 * one Submit / Approve / Settle button for the pair. `execute` moves one asset
 * per round, so a run paying some people in pounds and some in USDC is
 * two rounds against the same run — each proposed, approved and settled on its
 * own, and the run is done only when every leg is. Every action below is
 * therefore per leg, and the leg names its asset.
 */
function RunDetail({ run, proposals, account, session, me, busy, onBack, act }: {
  run: (PayrollRun & Marked) | undefined; proposals: Array<Proposal & Marked>; account: Account;
  session: Session; me: SignerSecrets; busy: boolean; onBack: () => void; act: Act;
}) {
  if (!run) return null;
  const need = account.policy.threshold;
  const legs = Object.keys(run.totals).sort();
  const proposalFor = (asset: AssetId): (Proposal & Marked) | undefined => {
    const id = run.proposalIds[asset];
    return id ? proposals.find(p => p.id === id) : undefined;
  };

  /*
   * **`submit` STOOD HERE AND IS GONE WITH THE CONTROL IT DROVE.** `C375`,
   *
   *
   * It POSTed `{viewingKey, proposedBy, asset}` to `/api/runs/:id/propose`,
   * which raised a governance round carrying a payload hash no vault can ever
   * reproduce — approved, paid for, and unpayable for ever. **That route now
   * raises a real run and takes three more fields for it: a vault, and the two
   * ends of the window.** The old handler sent none of them, so restoring it
   * would produce a refusal rather than a round; it stays deleted rather than
   * kept beside a disabled button, because a handler that looks finished is how
   * a control gets quietly re-enabled by somebody who assumes it works.
   *
   * **THE BUTTON STAYS, DISABLED, WITH ITS REASON.** The request that replaces
   * it carries a payout root, a payment window and a vault. Two of those three
   * now exist: the route builds the root from this run's own payees and the
   * company's own payout seed, and the window is a number somebody picks. **The
   * vault is the one this screen cannot supply**, because there is nowhere for a
   * company to record which vault pays its payroll, and a run raised at the
   * wrong 32 bytes is approved and then presentable by nobody.
   */
  /*
   * **THE SIGNATURE, NOT THE KEY.** The digest is the proposal's own and
   * is already public; `signApproval` is in the keyring because this screen is
   * not allowed to reach a secret.
   */
  const approve = (proposal: Proposal) => act(async () => {
    await api(`/api/proposals/${proposal.id}/approve`, {
      method: 'POST',
      body: JSON.stringify({
        signerId: me.signerId,
        signature: keyring.signApproval(proposal, me),
        viewingKey: session.viewingKey,
      }),
    });
  });
  /*
   * **THE SETTLE CONTROL STOOD HERE AND IS DELETED.**
   *
   * It posted to `/api/runs/:id/settle`, which spent the account's own balance.
   * The balance, that route and `PayrollService.settle` are all deleted. A leg
   * at its threshold now shows its approval count and stops there.
   */

  const settledLegs = legs.filter(a => proposalFor(a)?.status === 'executed');

  return (
    <div className="stack">
      <div className="inline">
        <button className="btn ghost sm" onClick={onBack}>← All runs</button>
        <div className="spacer" />
        {/*
          * **THE SCREEN THE DECISION IS TAKEN ON SAYS IT TOO, AND NOT ONLY THE
          * LIST THAT LED HERE.** The list is where a company works out what
          * exists; this is where somebody looks at *legs settled 1 of 1* and
          * concludes people have been paid. A mark on the list and none here
          * is a mark that has been scrolled past by the time it matters.
          */}
        <LedgerMark of={run} />
        <span className="sub">{legs.length === 1
          ? 'one settlement asset'
          : `${legs.length} settlement assets, ${legs.join(', ')}`}</span>
      </div>

      <div className="stats" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 0 }}>
        <div className="stat"><div className="k">Period</div><div className="v" style={{ fontSize: 20 }}>{monthName(run.period)}</div></div>
        <div className="stat">
          <div className="k">Gross totals</div>
          <div className="v" style={{ fontSize: 20 }}><PerAsset amounts={run.totals} /></div>
        </div>
        <div className="stat">
          <div className="k">Legs settled</div>
          <div className="v" style={{ fontSize: 20 }}>{settledLegs.length} of {legs.length}</div>
          <div className="prog" style={{ marginTop: 8 }}>
            <i style={{ width: `${legs.length ? settledLegs.length / legs.length * 100 : 0}%` }} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="hd"><h3>Settlement</h3>
          <span className="sub">one approval round per asset</span></div>
        <div className="bd tight">
          <table>
            <thead><tr>
              <th>Asset</th><th className="num">Subtotal</th><th>Recipients</th>
              <th>Approvals</th><th></th>
            </tr></thead>
            <tbody>
              {legs.map(asset => {
                const proposal = proposalFor(asset);
                const approvals = proposal?.approvals.length ?? 0;
                const mine = proposal?.approvals.some(a => a.signerId === me.signerId) ?? false;
                const paid = run.employees.filter(e => e.asset === asset).length;
                return (
                  <tr key={asset}>
                    <td className="name">{asset}</td>
                    <td className="num">{money(run.totals[asset]!, asset)}</td>
                    <td>{paid}</td>
                    <td>{proposal ? `${approvals} of ${need}` : 'not proposed'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {/* **STILL DISABLED, AND THE REASON HAS CHANGED — WHICH IS
                          WHY IT IS REWRITTEN RATHER THAN LEFT.** The three
                          values a run is raised against are no longer all
                          missing: the payout root is now derived from this
                          run's own payees and the company's own seed, and the
                          window is a number somebody chooses. **What this
                          screen still has no way to collect is the vault** —
                          the contract that will pay the run — and a run raised
                          without one is approved, paid for, and presentable by
                          nobody. Shown with its reason rather than hidden, so
                          the gap is visible to whoever is looking at the run. */}
                      {!proposal && <button className="btn sm pri" disabled
                        title={'A run is submitted against a payout root, a payment window and '
                          + 'the vault that will pay it. This screen has no way to name a vault '
                          + 'yet, and the vault is folded into what the signers approve — so a '
                          + 'run raised without one collects real signatures and can never be '
                          + 'paid by anybody.'}>
                        Submit {asset} for approval</button>}
                      {proposal && proposal.status === 'executed' && <span className="chip ok">settled</span>}
                      {proposal && proposal.status !== 'executed' && approvals < need &&
                        <button className="btn sm pri" onClick={() => approve(proposal)} disabled={busy || mine}>
                          {mine ? 'You have signed' : `Approve as ${me.name}`}</button>}
                      {/* Nothing here at the threshold: the Settle control was
                          deleted with the account's balance. The
                          approvals column already says the round is at its bar. */}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <RunPaymentsCard runId={run.id} viewingKey={session.viewingKey} />

      <div className="card">
        <div className="hd"><h3>Recipients</h3><span className="sub">visible to signers only</span></div>
        <div className="bd tight">
          <table>
            <thead><tr><th>Name</th><th className="num">Gross</th><th>Payslip</th></tr></thead>
            <tbody>
              {run.employees.map(e => (
                <tr key={e.id}>
                  <td className="name">{e.name}</td>
                  {/* Each person is paid in one asset, and a run may hold several,
                      so the code belongs on the line rather than in the header. */}
                  <td className="num">{money(e.amount, e.asset)}</td>
                  <td><span className="chip off">sealed to recipient</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {legs.map(asset => {
        const proposal = proposalFor(asset);
        if (!proposal) return null;
        return (
          <div className="card" key={asset}>
            <div className="hd"><h3>Approval trail</h3><span className="sub">{asset} leg</span></div>
            <div className="bd">
              {proposal.approvals.length === 0 && <div className="empty" style={{ padding: 20 }}>No signatures yet.</div>}
              {proposal.approvals.map(a => {
                const sg = account.signers.find(x => x.id === a.signerId);
                return (
                  <div className="row" key={a.signerId}>
                    <span><span className="name">{sg?.name}</span><span className="sub2">{new Date(a.at).toLocaleString('en-GB')}</span></span>
                    <span className="r mono">{a.signature.slice(0, 26)}…</span>
                  </div>
                );
              })}
              <div className="hint" style={{ marginTop: 12 }}>
                Each signature is ed25519 over the proposal digest and is checked against the registered signing key.
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* people                                                              */
/* ------------------------------------------------------------------ */

function People({ people, session, busy, act }: {
  people: Roster[]; session: Session; busy: boolean; act: Act;
}) {
  /*
   * **THE LINK, HELD FOR THIS SESSION ONLY.** `X11` §1,
   * `docs/scope-invitations.md` §4.
   *
   * *"The admin is hiring this person. They already hold their email in their
   * own systems."* — Decision 1, 22 Aug. **We never learn the employee's email
   * address and we send nothing**, so what this screen produces is a link the
   * admin copies and sends down whatever channel they already use.
   *
   * It is held in a `useState` and nowhere else, exactly as the SIGNER link
   * beside it is: **the invite-list routes strip the token deliberately** and
   * that is not a gap to fix — a listing that served tokens made every open
   * invitation a bearer credential any member could spend. So navigating away
   * loses the link, which is a real cost and the honest one, and the screen
   * says so rather than rendering a dead box.
   */
  const [links, setLinks] = useState<Record<string, string>>({});
  /**
   * **X12 §2 — THE TWO CODES, PER WAITING PERSON.**
   * `docs/how-money-can-be-lost.md` `C21`, `docs/scope-invitations.md` §5.
   *
   * Keyed by employee id, filled in by the effect below, and **held nowhere
   * else**: what it holds is derived from a sealed blob and this session's
   * viewing key, so it belongs to this tab and dies with it. An entry is
   * `null` while its box is still being fetched.
   */
  const [codes, setCodes] = useState<Record<string, Accepted | null>>({});
  // The asset is part of the form, not a constant: what somebody is paid in is
  // a property of that person, and the registry decides what may be chosen.
  const [form, setForm] = useState({ name: '', email: '', title: '', salary: '', asset: defaultAsset() });
  const [open, setOpen] = useState(false);
  /*
   * **NO EMAIL FIELD, AND THAT IS `C24`.**
   *
   * The route has no `email` parameter and must not gain one: the address on
   * the record is read off the caller's own sign-in inside the service, which
   * is the whole of what stops this door minting a payable entry under somebody
   * else's name. A box here would be a value the server throws away — or, worse,
   * one somebody later wires through.
   */
  /*
   * **NO `address` FIELD, AND THAT IS `X8` AND `C153`.** `X7` §1 took the
   * founder's own receiving address as PASTED TEXT, because the wallet had no
   * way to hand one over. It has one now, so **the box is gone and there is
   * nothing in this state to put an address into** — which is the same shape as
   * the missing `email` beside it: a value this screen never holds cannot be
   * wired through by somebody later.
   */
  const [self, setSelf] = useState({ name: '', title: '', salary: '', asset: defaultAsset() });
  const [openSelf, setOpenSelf] = useState(false);

  const asset = assets.require(form.asset);
  const selfAsset = assets.require(self.asset);

  /*
   * THE OPERATOR-SIDE "OPEN INVITE AS THEM" BUTTON IS GONE, AND IT COULD NOT
   * HAVE WORKED. Removed 17 Aug, found by audit.
   *
   * It read tokens out of `GET /api/accounts/:id/invites`, which both builds
   * now strip the token from — so the map filled with `undefined` and every
   * row's button was permanently disabled beside a panel telling the operator
   * to press it. The identical regression on the SIGNER screen was found and
   * fixed in this same slice; this screen was not looked at.
   *
   * **And fixing it the same way would have been wrong.** An employee's invite
   * is the whole of "the payee's key comes from the payee" (`A-10`): if an
   * operator can open it, the operator sets the address, which is the money
   * hole the token exists to close. A signer's token may come back to the
   * raiser because a signer who accepts still sees nothing until an approved
   * proposal commits to their leaf; an employee's handover has no second gate.
   * So this belongs on the invitee's own screen — `A-7` — and until the mailer
   * exists (`A-12`) nobody reaches it, which is the honest state to show.
   */

  const add = () => act(async () => {
    /*
     * `salary` goes as a DECIMAL STRING with the asset beside it, never as a
     * JSON number. `decimal` refuses more decimal places than the asset has, so
     * "5500.005" in a GBP box is a sentence here rather than a payslip that is
     * quietly a half-penny short — and an 18-decimal asset would not survive
     * the trip as a number at all.
     */
    /*
     * **THE TOKEN COMES BACK HERE, ONCE, AND IT IS THE ONLY TIME IT IS EVER
     * VISIBLE.**
     *
     * `invite()` has always returned it to its caller and this screen has
     * always thrown it away, which is why nobody has ever been hired: the token
     * reached nothing. It is not a widening — the raiser is the one party who
     * may hold it, and the listing routes still strip it for everybody else.
     */
    const raised = await api<{ employee: { id: string }; raw: string }>(
      `/api/accounts/${session.account.id}/people`, {
        method: 'POST',
        body: JSON.stringify({
          name: form.name, email: form.email, title: form.title,
          asset: asset.code, salary: decimal(form.salary, asset),
          viewingKey: session.viewingKey,
        }),
      });
    setLinks(x => ({ ...x, [raised.employee.id]: joinLink(raised.raw) }));
    setForm({ name: '', email: '', title: '', salary: '', asset: form.asset }); setOpen(false);
  });

  /**
   * **X12 §2 — FETCH THE SEALED BOX, OPEN IT HERE, WORK OUT THE CODE HERE.**
   * `docs/scope-invitations.md` §5.
   *
   * It runs for people who are waiting to be admitted and for nobody else:
   * before a handover there is nothing to open, and after `admit` the box is
   * emptied by design — the comparison belongs at the moment somebody is about
   * to become payable, which is the moment it can still change the outcome.
   *
   * **THE VIEWING KEY DOES NOT LEAVE THIS TAB.** The route serves ciphertext
   * and has nowhere to put a key; everything readable is computed on this
   * machine.
   */
  const waiting = people
    .filter(p => p.status === 'pending' && p.handedOver)
    .map(p => p.id)
    .join(',');
  useEffect(() => {
    let alive = true;
    const ids = waiting === '' ? [] : waiting.split(',');
    void (async () => {
      for (const id of ids) {
        try {
          const got = await api<{ inbox: Parameters<typeof acceptedCodes>[0] }>(
            `/api/employees/${id}/handover`);
          if (!alive) return;
          setCodes(c => ({ ...c, [id]: acceptedCodes(got.inbox, session.account.id,
            session.viewingKey) }));
        } catch (e) {
          if (!alive) return;
          /* A box that cannot be FETCHED is not a box that cannot be opened,
           * and saying "unreadable" for a dropped request would send an admin
           * looking for an attacker who is not there. */
          setCodes(c => ({ ...c, [id]: { of: 'unreadable', says: shownError(e,
            'reading what somebody handed over') } }));
        }
      }
    })();
    return () => { alive = false; };
  }, [waiting, session.account.id, session.viewingKey]);

  /**
   * **X12 §3 — TAKING AN INVITATION BACK.** `docs/scope-invitations.md` §8.
   *
   * *"A hire falls through after the link is sent and today there is no way to
   * take it back."* This is that way. It does ONE thing — the link stops
   * working, everywhere it is read — and withdrawing the PERSON stays the
   * separate control it already was, on the same row. The lifecycle §8
   * describes is deliberately not rebuilt here.
   */
  const revoke = (p: Roster) => act(async () => {
    await api(`/api/employees/${p.id}/invite/revoke`, { method: 'POST' });
    setLinks(x => {
      const next = { ...x };
      delete next[p.id];
      return next;
    });
  });

  /*
   * **THE STEP THAT MAKES SOMEBODY PAYABLE, WITH A CONTROL BEHIND IT AT
   * LAST.**
   *
   * `POST /api/employees/:id/admit` has existed and worked for rounds and **a
   * search of `src/web` for that path returned nothing**, while a run stopped
   * and told the admin, in its own words, that somebody *"is waiting to be
   * admitted by an admin"* — advice nobody could act on.
   *
   * **X12 §2 — AND THE FINGERPRINT IS HERE NOW.** `C21`,
   * `docs/scope-invitations.md` §5. `X11` left it out deliberately and said
   * why; what changed is not the argument but the shape, and the shape is
   * settled 24 Aug: **nobody transcribes anything by ear.** The invitee copies a
   * code their wallet computed, pastes it into the join screen, and it travels
   * sealed with the address. This screen holds it beside the code THIS machine
   * works out from the address that arrived — see the waiting panel above.
   *
   * `X11`'s own sentence about the channel still stands and is on the screen
   * rather than in this comment: two matching codes say nothing about whether
   * the right person was invited, and what settles that is reading the code
   * back through a channel where a wrong person would be noticed.
   *
   * **AND IT NEEDED NO MIGRATION, WHICH IS WHAT `X11` BOUGHT.** `admit` already
   * wrote the accepted address onto the sealed roster entry; the comparison
   * reads the drop box that was already there, one step earlier.
   */
  const admit = (p: Roster) => act(async () => {
    await api(`/api/employees/${p.id}/admit`, {
      method: 'POST',
      body: JSON.stringify({ viewingKey: session.viewingKey }),
    });
  });

  /*
   * **A MEMBER MAKES THEMSELVES PAYABLE.** `X7` §1, `C24`, `A-12`.
   *
   * A founder paying themselves is not an employee being invited: there is no
   * third party, no token, nothing to deliver and nobody to impersonate, so
   * there is nothing here for an invitation to protect. `POST
   * /api/accounts/:id/self-payee` is the door and `addSelfAsPayee` walks the
   * ordinary raise-accept-admit inside one call.
   *
   * ── THE KEYPAIR IS DERIVED FROM THE WALLET, NEVER MINTED HERE ────────────
   *
   * `newWrappingKeypair()` on this line would be thirty-two
   * random bytes handed to the server as a public key and kept nowhere: **the
   * founder's own payslips would be sealed to a secret this tab forgets on
   * reload, and nothing — not another device, not a recovery, not us — could
   * ever work it out again.** Every test of the sealing would still pass, which
   * is why the rule is the shape of the call and not a comment.
   *
   * So the secret is `payslipKeypairFrom(companyKey)`, exactly what the seed
   * derives for a seeded employee, and the company key is the one **this
   * wallet released for THIS company** — `companyKeyReleasedFor` answers null
   * for a password-derived key and for another company's, and this refuses by
   * name rather than expanding whatever it was handed.
   *
   * ── THE ADDRESS COMES FROM THE WALLET, AND THE BOX IS GONE ──────────────
   *
   * `X7` asked for the founder's own address *from the same
   * wallet* and the wallet could not give one, so this screen took it as pasted
   * text — safe on this one door because the caller and the payee are the same
   * person by construction, and **a precedent that must not spread to any door
   * where they are not.**
   *
   * The wallet's `X8` round added the attribute. So the person presses a
   * button, their wallet shows them which of their own wallets it is about and
   * what is being asked for, and what comes back is a SIGNED disclosure. **This
   * page judges none of it** — the server does, in `wallet-payee.ts`, because a
   * button that forwarded whatever came back would be the pasted box with the
   * box hidden.
   *
   * `V-78` option 3 — an operator supplying somebody else's address — stays
   * impossible, and is now impossible on both doors for the same reason rather
   * than on one by construction: the value is produced by the payee's own keys.
   */
  const addSelf = () => act(async () => {
    const companyKey = keyring.companyKeyReleasedFor(session.account.id);
    if (!companyKey) {
      throw new Error(
        'your payslip key is worked out from the key your wallet releases for this company, '
        + 'and this tab does not hold one — open the company with your wallet and try again. '
        + 'Nothing here will invent a key instead: one that is invented is one nothing can '
        + 'work out again, and your payslips would be sealed to it.');
    }
    /* Derived, not minted. The secret is never sent and never stored: only the
     * public half goes, and the secret is recomputed from the wallet whenever
     * a payslip is opened. */
    const wrapping = payslipKeypairFrom(fromHex(companyKey));
    /* The wallet opens, the person chooses which of their own wallets this
     * company is about, and presses. Nothing is sent until they do. */
    const disclosure = await keyring.payeeDisclosureFromWallet(
      session.account.id, WALLET_ORIGIN);
    await api(`/api/accounts/${session.account.id}/self-payee`, {
      method: 'POST',
      body: JSON.stringify({
        name: self.name, title: self.title,
        asset: selfAsset.code, salary: decimal(self.salary, selfAsset),
        viewingKey: session.viewingKey,
        wrappingPublicKey: wrapping.publicKey,
        disclosure,
      }),
    });
    setSelf({ name: '', title: '', salary: '', asset: self.asset });
    setOpenSelf(false);
  });

  /*
   * AN EXPLICIT STATUS RATHER THAN A TOGGLE. There are three statuses and the
   * toggle knew two: pressing it on a `pending` person sent `active`, which is
   * how somebody with no address at all becomes payable.
   *
   * Withdrawing a pending person is also the ONLY exit from an invitation that
   * can never be admitted — `C28` — so it has to be reachable from the row it
   * is about, not only from a message telling an admin it exists.
   */
  const setStatus = (p: RosterEmployee, status: 'active' | 'leaver') => act(async () => {
    // The record is sealed, so changing a status means opening and resealing it:
    // the key travels with the change.
    await api(`/api/people/${p.id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, viewingKey: session.viewingKey }),
    });
  });

  return (
    <div className="stack">
      {open && (
        <div className="card">
          <div className="hd"><h3>Add someone to payroll</h3></div>
          <div className="bd">
            <div className="two">
              <div className="field"><label>Full name</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Rae Solomon" /></div>
              <div className="field"><label>Email</label>
                <input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="rae@northwind.co" /></div>
            </div>
            <div className="two">
              <div className="field"><label>Title</label>
                <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="Engineer" /></div>
              <div className="field"><label>Paid in</label>
                <AssetSelect value={form.asset} onChange={code => setForm({ ...form, asset: code })} /></div>
            </div>
            <div className="field">
              <label>Monthly gross ({asset.code}, {asset.decimals} decimal places)</label>
              <input value={form.salary} onChange={e => setForm({ ...form, salary: e.target.value })}
                placeholder={formatAmount(5500n * 10n ** BigInt(asset.decimals), asset)} />
            </div>
            <div className="inline">
              <button className="btn pri" onClick={add}
                disabled={busy || !form.name || !form.email || !form.title || !isAmount(form.salary, asset)}>
                Create the link</button>
              <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
            </div>
            <div className="hint" style={{ marginTop: 14 }}>
              <strong>Nothing is sent from here.</strong> You get a link, once, and you send it to them
              yourself — so their email address never reaches this service at all. No key is generated
              here either: the key that opens their payslips is worked out on their own device from
              their wallet and this company's address on the chain, and only the public half comes
              back. If we generated it, we could read their payslip.
            </div>
          </div>
        </div>
      )}

      {openSelf && (
        <div className="card">
          <div className="hd"><h3>Add yourself to payroll</h3>
            <span className="sub">no invitation, because there is nobody to invite</span></div>
          <div className="bd">
            <div className="two">
              <div className="field"><label>Your full name</label>
                <input value={self.name} onChange={e => setSelf({ ...self, name: e.target.value })}
                  placeholder="Your name as it goes on a payslip" /></div>
              <div className="field"><label>Your title</label>
                <input value={self.title} onChange={e => setSelf({ ...self, title: e.target.value })}
                  placeholder="Founder" /></div>
            </div>
            <div className="two">
              <div className="field"><label>Paid in</label>
                <AssetSelect value={self.asset} onChange={code => setSelf({ ...self, asset: code })} /></div>
              <div className="field">
                <label>Monthly gross ({selfAsset.code}, {selfAsset.decimals} decimal places)</label>
                <input value={self.salary} onChange={e => setSelf({ ...self, salary: e.target.value })}
                  placeholder={formatAmount(5500n * 10n ** BigInt(selfAsset.decimals), selfAsset)} /></div>
            </div>
            <div className="inline">
              <button className="btn pri" onClick={addSelf}
                disabled={busy || !self.name || !self.title
                  || !isAmount(self.salary, selfAsset)}>Add me to payroll</button>
              <button className="btn ghost" onClick={() => setOpenSelf(false)}>Cancel</button>
            </div>
            <div className="hint" style={{ marginTop: 14 }}>
              We are not asking for your email or your address, and there is nowhere here to
              type either. Pressing the button opens your wallet, which shows you which of your
              own wallets this company would be paying and asks you to approve it — and what
              comes back is signed by that wallet, so nobody can put somebody else's address on
              your record and nobody can put yours on theirs.
              The key that opens your payslips is worked out from the key your wallet released
              for this company — it is never generated here, never sent, and never stored, so any
              device holding your wallet can open every payslip you are ever issued.
            </div>
          </div>
        </div>
      )}

      {people.some(p => p.status === 'pending') && (
        <div className="card">
          <div className="hd"><h3>Waiting</h3>
            {/*
              * **THIS SENTENCE WAS TRUE AND IS NOT ANY MORE.** One
              * pending person used to refuse the whole run; now the run refuses
              * once, names them, and goes ahead if somebody confirms it by name.
              * Leaving the old sentence up would tell an admin the company is
              * frozen when it is not, which is the same person deciding not to
              * try.
              */}
            <span className="sub">nobody here is paid until they are admitted, and a run can
              go ahead without them if somebody confirms it by name</span></div>
          <div className="bd">
            {/*
              * TWO STATES, NAMED SEPARATELY, because a run already refuses in two
              * different sentences and an admin could not tell which was which.
              * Somebody who has handed nothing over is waiting on THEM; somebody
              * whose drop box is full is waiting on US.
              */}
            {people.filter(p => p.status === 'pending' && !p.handedOver).map(p => (
              <div key={p.id} style={{ marginBottom: 16 }}>
                <div className="field" style={{ marginBottom: 6 }}>
                  <label>{p.name} — not set up yet</label>
                  {links[p.id]
                    ? <input readOnly value={links[p.id]} onFocus={e => e.currentTarget.select()} />
                    : <div className="hint">
                        Invited, and the link is not shown again. Send it from wherever you copied
                        it, or withdraw this invitation and raise a new one.
                      </div>}
                </div>
                {links[p.id] && (
                  <div className="hint">
                    <strong>Copy this now — it is shown once and never again.</strong> Send it to
                    {' '}{p.name} yourself, however you already talk to them. We do not send it and
                    we never learn their email address. Anyone holding this link can accept the
                    offer, so treat it like a key.
                  </div>
                )}
                {/*
                  * **X12 §3 — TAKING IT BACK, FROM THE ROW IT IS ABOUT.**
                  * `docs/scope-invitations.md` §8.
                  *
                  * A hire falls through after the link has been sent, and until
                  * now the link kept working: whoever held it could still set
                  * the address a salary is paid to, for as long as they kept
                  * it. The control is here rather than in a settings page
                  * because this row is the only place the invitation is
                  * visible at all.
                  */}
                <div className="inline">
                  <button className="btn sm ghost" disabled={busy} onClick={() => revoke(p)}>
                    Revoke this link
                  </button>
                  <span className="sub2">
                    Stops the link working, for good. {p.name} stays on this list until you
                    withdraw them.
                  </span>
                </div>
              </div>
            ))}

            {people.filter(p => p.status === 'pending' && p.handedOver).map(p => {
              const seen = codes[p.id];
              return (
                <div key={p.id} style={{ marginBottom: 16 }}>
                  <div className="inline">
                    <div style={{ flex: 1 }}>
                      <div className="name">{p.name} has accepted</div>
                      <div className="sub2">
                        Their address is sealed to this company and nobody is paid until you
                        admit them.
                      </div>
                    </div>
                    <button className="btn pri" disabled={busy} onClick={() => admit(p)}>
                      Admit {(p.name ?? '').split(' ')[0]}
                    </button>
                  </div>
                  {/*
                    * **X12 §2 — TWO CODES, ONE GLANCE.** `C21`,
                    * `docs/scope-invitations.md` §5.
                    *
                    * The left one was read off {p.name}'s own wallet screen and
                    * typed into the page they accepted on. The right one is
                    * worked out HERE, on this machine, from the address that
                    * actually arrived — the sealed box is opened in this
                    * browser and the address never reaches our service, which
                    * is the whole reason the comparison is worth making at all.
                    */}
                  {seen === undefined && (
                    <div className="hint">Opening what they handed over…</div>
                  )}
                  {seen?.of === 'unreadable' && (
                    <div className="hint" data-codes="unreadable">
                      <strong>What they handed over could not be opened here.</strong>{' '}
                      {seen.says} Admitting is still possible and still does every check it
                      has ever done — what is missing is this comparison, so confirm the
                      address with {p.name} some other way before you do.
                    </div>
                  )}
                  {seen?.of === 'opened' && (
                    <div className="hint" data-codes={seen.agree === null ? 'none'
                      : seen.agree ? 'same' : 'different'}>
                      <div className="inline" style={{ gap: 24, marginBottom: 6 }}>
                        <div>
                          <div className="sub2">The code {p.name} read off their wallet</div>
                          <div className="code" data-code="theirs">
                            {seen.theirs ?? 'none was given'}
                          </div>
                        </div>
                        <div>
                          <div className="sub2">The code this machine works out</div>
                          <div className="code" data-code="ours">{seen.ours}</div>
                        </div>
                      </div>
                      {seen.agree === false && (
                        <p style={{ margin: '0 0 6px' }}>
                          <strong>These are not the same code.</strong> The address that
                          reached this company is not the one {p.name}&rsquo;s wallet showed
                          them. Do not admit this — ask them to accept again, and if it
                          happens twice, something between their wallet and us is changing
                          the answer.
                        </p>
                      )}
                      {seen.agree === null && (
                        <p style={{ margin: '0 0 6px' }}>
                          This acceptance carries no code, so there is nothing to compare.
                          Confirm the address with {p.name} some other way before admitting.
                        </p>
                      )}
                      {/*
                        * **AND THE SCREEN IS HONEST ABOUT WHAT THIS PROVES.**
                        * `C138` does the same thing on the unlock screen: it
                        * says what it cannot check, in one sentence, where the
                        * check is. A control that is trusted for more than it
                        * does is worse than no control, and this one has a
                        * precise limit — `C21`'s own attacker passes it.
                        */}
                      <p style={{ margin: 0 }}>
                        Two matching codes mean the address that arrived is the one their
                        wallet showed them &mdash; so nothing in between substituted it.
                        <strong> They do not mean the right person was invited.</strong>{' '}
                        Somebody accepting their own invitation would show a matching code
                        too. What settles that is reading this code back to {p.name} through
                        a channel where the wrong person would be noticed.
                      </p>
                    </div>
                  )}
                </div>
              );
            })}

            {/*
              * **THE SECOND HALF OF THE SAME CORRECTION, AND IT IS THE ONE THAT
              * TOLD AN ADMIN TO DESTROY SOMETHING.**
              *
              * It read *"A pending person blocks the whole run, not just their
              * own line. Withdraw anyone who is stuck"* — and that was true and
              * is not any more. Worse than stale: the remedy it recommended was
              * to withdraw the invitation, which throws away the roster entry
              * and the link, when the correct action is now two clicks away on
              * the Payroll screen. **A false sentence whose call to action is
              * destructive costs more than one that is merely wrong.**
              */}
            <div className="hint">
              A pending person is not paid, but they no longer stop anybody else being paid: the
              run says who it would leave out and goes ahead once somebody confirms it by name.
              Withdrawing is for an invitation that can never be admitted at all — it throws away
              the entry and the link, so it is not the way to get a payroll out.
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="hd">
          <h3>People</h3>
          <span className="sub">{people.filter(p => p.status === 'active').length} active</span>
          <div className="spacer" />
          {!openSelf && <button className="btn ghost" onClick={() => setOpenSelf(true)}>Add yourself</button>}
          {!open && <button className="btn pri" onClick={() => setOpen(true)}>Invite employee</button>}
          {/*
            * `C21` — **THE EMAIL BOX IS STILL HERE AND THIS ROUND LEAVES IT.**
            * `X11` says so by name: `C21` closes by DELETION, and that deletion
            * touches the hire form, the roster and `C24`'s defence — `admit`'s
            * only positive check compares a redeemer's sign-in against the
            * email typed here. Removing the box without replacing that check
            * would take out the one thing standing between a stolen token and a
            * salary. Named and left.
            */}
        </div>
        <div className="bd tight">
          <table>
            <thead><tr>
              <th>Name</th><th>Title</th><th>Started</th><th className="num">Monthly</th><th>Status</th><th></th>
            </tr></thead>
            <tbody>
              {people.map(p => (
                <tr key={p.id}>
                  <td>
                    <div className="name">{p.name}</div>
                    <div className="sub2">{p.email}</div>
                  </td>
                  <td>{p.title}</td>
                  <td className="sub2">{new Date(p.startDate).toLocaleDateString('en-GB')}</td>
                  {/* One asset per person, and the column holds a mix of them,
                      so the code goes on every row. */}
                  <td className="num">{money(p.baseAmount, p.asset)}</td>
                  <td><span className={'chip ' + (p.status === 'active' ? 'ok' : p.status === 'pending' ? 'pend' : 'off')}>
                    {p.status === 'pending' ? (p.handedOver ? 'accepted' : 'invited') : p.status}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    {p.status === 'active'
                      ? <button className="btn sm ghost" onClick={() => setStatus(p, 'leaver')} disabled={busy}>
                          Mark leaver
                        </button>
                      : p.status === 'pending'
                        ? <>
                            {p.handedOver && (
                              <button className="btn sm pri" onClick={() => admit(p)} disabled={busy}
                                style={{ marginRight: 6 }}>
                                Admit
                              </button>
                            )}
                            <button className="btn sm ghost" onClick={() => setStatus(p, 'leaver')} disabled={busy}>
                              Withdraw
                            </button>
                          </>
                        : <button className="btn sm ghost" onClick={() => setStatus(p, 'active')} disabled={busy}>
                            Reinstate
                          </button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* approvals                                                           */
/* ------------------------------------------------------------------ */

/**
 * Everything awaiting signature. SEVERAL ROUNDS MAY BE OPEN AT ONCE — a
 * two-asset payroll raises one per asset — so nothing here may assume that the
 * open proposal is the open proposal.
 */
function Approvals({ pending, account, session, me, busy, runs, act }: {
  pending: Array<Proposal & Marked>; account: Account; session: Session; me: SignerSecrets;
  busy: boolean; runs: Array<PayrollRun & Marked>; act: Act;
}) {
  /**
   * Which run leg a proposal settles, if it settles one at all.
   *
   * A run holds a proposal per asset, so finding the run is not enough: the
   * settle call has to name the asset, or a run with two legs open cannot say
   * which of them is being executed. A proposal raised by a plug-in belongs to
   * no run and has no leg, which is why this returns null rather than throwing.
   */
  const legOf = (p: Proposal & Marked): { run: PayrollRun & Marked; asset: AssetId } | null => {
    for (const run of runs) {
      const found = Object.entries(run.proposalIds).find(([, id]) => id === p.id);
      if (found) return { run, asset: found[0] };
    }
    return null;
  };

  /* `C121` — see the note on the other approve button. The key stays here. */
  const approve = (p: Proposal) => act(async () => {
    await api(`/api/proposals/${p.id}/approve`, {
      method: 'POST',
      body: JSON.stringify({
        signerId: me.signerId,
        signature: keyring.signApproval(p, me),
        viewingKey: session.viewingKey,
      }),
    });
  });
  // The Settle control was deleted here too, with the account's balance.

  if (!pending.length) {
    return <div className="card"><div className="empty"><b>Nothing to approve</b>You are all caught up.</div></div>;
  }

  return (
    <div className="stack">
      {pending.map(p => {
        const mine = p.approvals.some(a => a.signerId === me.signerId);
        const need = account.policy.threshold;
        const ready = p.approvals.length >= need;
        const leg = legOf(p);
        return (
          <div className="card" key={p.id}>
            <div className="hd">
              <h3>{p.summary}</h3>
              <span className={'chip ' + (ready ? 'ok' : 'pend')}>{p.status}</span>
              {/* A signature is the money decision, so the governance round says which
                  ledger raised it on the screen the signature is given on. */}
              <LedgerMark of={p} />
              {/* Which leg this is. Two rounds on one run are told apart by asset
                  and by nothing else, so the summary alone is not enough. */}
              {leg && <span className="chip off">{leg.asset} leg of {monthName(leg.run.period)}</span>}
              <div className="spacer" />
              {!ready && <button className="btn pri" onClick={() => approve(p)} disabled={busy || mine}>
                {mine ? 'You have signed' : `Approve as ${me.name}`}
              </button>}
            </div>
            <div className="bd">
              <div className="row"><span>Requested by</span>
                <span className="r">{account.signers.find(x => x.id === p.proposedBy)?.name}</span></div>
              <div className="row"><span>Signatures</span>
                <span className="r inline" style={{ justifyContent: 'flex-end' }}>
                  <span className="prog"><i style={{ width: `${Math.min(100, p.approvals.length / need * 100)}%` }} /></span>
                  {p.approvals.length} of {need}
                </span></div>
              <div className="row"><span>Amount</span>
                <span className="r"><span className="chip off">shielded</span></span></div>
              <div className="hint" style={{ marginTop: 12 }}>
                The amount is inside the sealed payload and never appears in the clear. Whether this round has
                enough signatures is the contract&rsquo;s answer, not ours &mdash; we only show it. The amount is
                opened here for one thing: your company&rsquo;s own spending ceilings, which this service applies
                and the chain knows nothing about.
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* apps                                                                */
/* ------------------------------------------------------------------ */

const SCOPE_TEXT: Record<string, string> = {
  'state:read': 'Read your balance and every transaction line',
  'state:read:totals': 'Read totals only, never individual lines',
  'people:read': 'Read your employee roster',
  'runs:read': 'Read payroll run history',
  'proposal:create': 'Propose transactions for your signers to approve',
  'disclosure:issue': 'Issue attestations to third parties',
};

const CATEGORY_LABEL: Record<string, string> = {
  offramp: 'Payouts and offramp', treasury: 'Treasury', interop: 'Interoperability',
  compliance: 'Compliance', accounting: 'Accounting', identity: 'Identity',
};

function Apps({ session, me, busy, act }: {
  session: Session; me: SignerSecrets; busy: boolean; act: Act;
}) {
  const [tab, setTab] = useState<'browse' | 'installed' | 'activity'>('browse');
  const [catalogue, setCatalogue] = useState<PluginManifest[]>([]);
  const [installed, setInstalled] = useState<Installation[]>([]);
  const [events, setEvents] = useState<PluginEvent[]>([]);
  const [installing, setInstalling] = useState<PluginManifest | null>(null);
  /*
   * The allowance is a CEILING PER ASSET, so the asset is part of the grant and
   * not a detail of it. A ceiling of 5,000 is a sensible monthly payroll limit
   * in pounds and a fortune in ether, and the plug-in must not be the one that
   * decides which — so the asset is chosen here, with the numbers.
   *
   * One asset is granted at install time. The wire shape is a map, so a second
   * can be added later without any of this changing; an asset with no entry
   * cannot be spent at all, which is the honest default.
   */
  const [allowance, setAllowance] = useState({ asset: defaultAsset(), perProposal: '5000', perPeriod: '20000' });
  const [scopes, setScopes] = useState<string[]>([]);
  const [demoOut, setDemoOut] = useState<string>('');

  const allowanceAsset = assets.require(allowance.asset);

  const refresh = useCallback(async () => {
    const [cat, ins, ev] = await Promise.all([
      api<PluginManifest[]>('/api/plugins/catalogue'),
      api<Installation[]>(`/api/accounts/${session.account.id}/plugins`),
      api<PluginEvent[]>(`/api/accounts/${session.account.id}/plugin-events`),
    ]);
    setCatalogue(cat); setInstalled(ins); setEvents(ev);
  }, [session.account.id]);

  useEffect(() => { refresh().catch(() => {}); }, [refresh]);

  const begin = (m: PluginManifest) => { setInstalling(m); setScopes(m.scopes); };

  const confirm = () => act(async () => {
    if (!installing) return;
    await api(`/api/accounts/${session.account.id}/plugins`, {
      method: 'POST',
      body: JSON.stringify({
        pluginId: installing.id, scopes,
        allowance: installing.requestsSpend
          ? {
              // Keyed by asset code, so a ceiling and the spend it governs are
              // in the same currency by construction — there is no way to reach
              // a ceiling except through the asset it was set for.
              limits: {
                [allowanceAsset.code]: {
                  perProposal: decimal(allowance.perProposal, allowanceAsset),
                  perPeriod: decimal(allowance.perPeriod, allowanceAsset),
                },
              },
              periodDays: 30,
            }
          : null,
        /*
         * **NO SEAT IN THIS BODY.** Which seat installed a plug-in decides
         * which ceiling its rounds are judged against, so it comes from the
         * signed-in caller on the server. The viewing key is what lets the
         * server work out which seat that is.
         */
        viewingKey: session.viewingKey,
      }),
    });
    setInstalling(null); await refresh();
  });

  const setStatus = (i: Installation, status: Installation['status']) => act(async () => {
    await api(`/api/installations/${i.id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
    await refresh();
  });

  /** What a plug-in may spend, and therefore what the demo button proposes. */
  const spendableAsset = (i: Installation): Asset =>
    assets.require(Object.keys(i.allowance?.limits ?? {})[0] ?? defaultAsset());

  /** Runs the plug-in against its own token, exactly as a third party would. */
  const exercise = (i: Installation, what: 'read' | 'people' | 'propose') => act(async () => {
    setDemoOut('');
    const asset = spendableAsset(i);
    try {
      if (what === 'read') {
        // A totals-scoped plug-in used to get a balance per asset. There are no
        // balances, so the entry count is the whole of what a totals
        // scope can honestly be given, and this renders exactly that.
        const r = await api<{ entries?: ShieldedEntry[]; entryCount?: number }>(
          `/api/plugin/state?token=${i.token}&viewingKey=${session.viewingKey}`);
        setDemoOut(`state: ${r.entries?.length ?? r.entryCount ?? 0} entries`);
      } else if (what === 'people') {
        const r = await api<Array<{ id: string }>>(`/api/plugin/people?token=${i.token}`);
        setDemoOut(`roster: ${r.length} people`);
      } else {
        const r = await api<Proposal>('/api/plugin/propose', {
          method: 'POST',
          body: JSON.stringify({
            token: i.token, viewingKey: session.viewingKey, summary: 'Proposed by ' + i.pluginId,
            // The plug-in names the asset, which is safe because the ceiling is
            // looked up BY it: an asset it was not granted has no ceiling to
            // reach and is refused outright.
            asset: asset.code, amount: decimal('3000', asset),
            /*
             * **NO SEAT IN THIS BODY.** A plug-in's round is raised under the
             * seat that installed the plug-in and granted its allowance, which
             * the server looks up from the capability token. A seat this screen
             * could put in a request would be a seat any caller could put in a
             * request, and the seat selects the ceiling the approval is judged
             * against.
             */
            recipient: 'Counterparty',
          }),
        });
        setDemoOut(`proposed ${r.id}, status ${r.status}. It cannot execute, only your signers can.`);
      }
    } catch (e: any) { setDemoOut('refused: ' + e.message); }
    await refresh();
  });

  const byId = (id: string): { name: string } => catalogue.find(c => c.id === id) ?? { name: id };
  const isInstalled = (id: string) => installed.some(i => i.pluginId === id);
  const groups = [...new Set(catalogue.map(c => c.category))];

  return (
    <div className="stack">
      <div className="inline">
        <button className={'btn sm' + (tab === 'browse' ? ' pri' : '')} onClick={() => setTab('browse')}>Browse</button>
        <button className={'btn sm' + (tab === 'installed' ? ' pri' : '')} onClick={() => setTab('installed')}>
          Installed {installed.length ? `(${installed.length})` : ''}</button>
        <button className={'btn sm' + (tab === 'activity' ? ' pri' : '')} onClick={() => setTab('activity')}>Activity</button>
      </div>

      {installing && (
        <div className="card">
          <div className="hd"><h3>Install {installing.name}</h3>
            <span className="chip pend">review permissions</span></div>
          <div className="bd">
            <p style={{ color: 'var(--dim)', marginBottom: 14 }}>{installing.summary}</p>
            <div className="navlabel" style={{ padding: '0 0 8px' }}>This app is asking to</div>
            {installing.scopes.map((sc: string) => (
              <label key={sc} className="row" style={{ cursor: 'pointer', alignItems: 'center' }}>
                <span className="inline">
                  <input type="checkbox" style={{ width: 16 }} checked={scopes.includes(sc)}
                    onChange={e => setScopes(x => e.target.checked ? [...x, sc] : x.filter(y => y !== sc))} />
                  <span>{SCOPE_TEXT[sc] ?? sc}</span>
                </span>
                <span className="r mono faint">{sc}</span>
              </label>
            ))}

            {installing.requestsSpend && (
              <>
                <div className="navlabel" style={{ padding: '16px 0 8px' }}>Spending allowance</div>
                <div className="field"><label>In</label>
                  <AssetSelect value={allowance.asset} onChange={code => setAllowance({ ...allowance, asset: code })} /></div>
                <div className="two">
                  <div className="field"><label>Max per proposal ({allowanceAsset.code})</label>
                    <input value={allowance.perProposal} onChange={e => setAllowance({ ...allowance, perProposal: e.target.value })} /></div>
                  <div className="field"><label>Max per 30 days ({allowanceAsset.code})</label>
                    <input value={allowance.perPeriod} onChange={e => setAllowance({ ...allowance, perPeriod: e.target.value })} /></div>
                </div>
                <div className="hint" style={{ marginTop: 6 }}>
                  The ceiling is looked up by the asset being spent, so this app can propose
                  {' '}{allowanceAsset.code} and nothing else. An asset it was never granted is refused outright.
                </div>
              </>
            )}

            <div className="hint" style={{ margin: '6px 0 16px' }}>
              This app can propose. It can never execute. Releasing funds always needs
              {' '}{session.account.policy.threshold} signatures from your team, and it never receives your viewing key.
            </div>
            <div className="inline">
              <button className="btn pri" onClick={confirm}
                disabled={busy || !scopes.length || (installing.requestsSpend
                  && !(isAmount(allowance.perProposal, allowanceAsset) && isAmount(allowance.perPeriod, allowanceAsset)))}>
                Install</button>
              <button className="btn ghost" onClick={() => setInstalling(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {tab === 'browse' && groups.map(g => (
        <div className="card" key={g}>
          <div className="hd"><h3>{CATEGORY_LABEL[g] ?? g}</h3></div>
          <div className="bd tight">
            <table>
              <tbody>
                {catalogue.filter(c => c.category === g).map(c => (
                  <tr key={c.id}>
                    <td style={{ width: '42%' }}>
                      <div className="name">{c.name}</div>
                      <div className="sub2">{c.publisher} · v{c.version}</div>
                    </td>
                    <td style={{ color: 'var(--dim)', fontSize: 13.5 }}>{c.summary}</td>
                    <td style={{ width: 120 }}>
                      <span className={'chip ' + (c.verification === 'first-party' ? 'ok' : c.verification === 'verified' ? '' : 'off')}>
                        {c.verification}</span>
                    </td>
                    <td style={{ textAlign: 'right', width: 110 }}>
                      {isInstalled(c.id)
                        ? <span className="chip ok">installed</span>
                        : <button className="btn sm" onClick={() => begin(c)} disabled={busy}>Install</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {tab === 'installed' && (
        installed.length === 0
          ? <div className="card"><div className="empty"><b>Nothing installed</b>Browse the catalogue to add one.</div></div>
          : <>
            {demoOut && <div className="card"><div className="bd"><span className="mono">{demoOut}</span></div></div>}
            {installed.map(i => {
              const m = byId(i.pluginId);
              return (
                <div className="card" key={i.id}>
                  <div className="hd">
                    <h3>{m.name}</h3>
                    <span className={'chip ' + (i.status === 'active' ? 'ok' : 'pend')}>{i.status}</span>
                    <div className="spacer" />
                    <button className="btn sm ghost" onClick={() => setStatus(i, i.status === 'active' ? 'suspended' : 'active')} disabled={busy}>
                      {i.status === 'active' ? 'Suspend' : 'Resume'}</button>
                    <button className="btn sm ghost" onClick={() => setStatus(i, 'removed')} disabled={busy}>Remove</button>
                  </div>
                  <div className="bd">
                    <div className="navlabel" style={{ padding: '0 0 6px' }}>Granted</div>
                    {i.grantedScopes.map(sc => (
                      <div className="row" key={sc}><span>{SCOPE_TEXT[sc] ?? sc}</span>
                        <span className="r mono faint">{sc}</span></div>
                    ))}
                    {/* One row per asset. There is no combined allowance to show:
                        a ceiling only means something in the currency it was set in. */}
                    {i.allowance && Object.entries(i.allowance.limits)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([code, limit]) => limit && (
                        <div className="row" key={code}><span>Spending allowance, {code}</span>
                          <span className="r">
                            {money(limit.perProposal, code)} per proposal, {money(limit.perPeriod, code)} per{' '}
                            {i.allowance!.periodDays} days
                          </span></div>
                      ))}
                    <div className="row"><span>Capability token</span>
                      <span className="r mono faint">{i.token.slice(0, 20)}…</span></div>

                    <div className="inline" style={{ marginTop: 14 }}>
                      <span className="faint" style={{ marginRight: 4 }}>Run it:</span>
                      <button className="btn sm" onClick={() => exercise(i, 'read')} disabled={busy}>Read state</button>
                      <button className="btn sm" onClick={() => exercise(i, 'people')} disabled={busy}>Read roster</button>
                      {/* The figure is stated in the asset this installation may
                          spend, because 3,000 of something else is a different sum. */}
                      <button className="btn sm" onClick={() => exercise(i, 'propose')} disabled={busy}>
                        Propose {money(parseAmount('3000', spendableAsset(i)), spendableAsset(i).code)}</button>
                    </div>
                    <div className="hint" style={{ marginTop: 12 }}>
                      These call the same API a third party would, using this installation's token.
                      Anything outside the grant is refused and recorded.
                    </div>
                  </div>
                </div>
              );
            })}
          </>
      )}

      {tab === 'activity' && (
        <div className="card">
          <div className="hd"><h3>Plug-in activity</h3>
            <span className="sub">{events.filter(e => !e.allowed).length} refused</span></div>
          <div className="bd tight">
            {events.length === 0
              ? <div className="empty"><b>Nothing yet</b>Install an app and run it.</div>
              : <table>
                  <thead><tr><th>App</th><th>Action</th><th>Detail</th><th>Result</th><th>When</th></tr></thead>
                  <tbody>
                    {events.slice(0, 25).map(e => (
                      <tr key={e.id}>
                        <td className="name">{byId(e.pluginId).name}</td>
                        <td>{e.action}</td>
                        <td className="sub2" style={{ maxWidth: 340 }}>{e.detail}</td>
                        <td><span className={'chip ' + (e.allowed ? 'ok' : 'no')}>{e.allowed ? 'allowed' : 'refused'}</span></td>
                        <td className="sub2">{new Date(e.at).toLocaleTimeString('en-GB')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* disclosures                                                         */
/* ------------------------------------------------------------------ */

function Disclosures({ runs, session, busy, act }: {
  runs: PayrollRun[]; session: Session; busy: boolean; act: Act;
}) {
  const [issued, setIssued] = useState<Array<Attestation & { valid: boolean }>>([]);
  const [solvency, setSolvency] = useState({ asset: defaultAsset(), threshold: '250000' });

  const solvencyAsset = assets.require(solvency.asset);

  /**
   * Attests ONE SUBTOTAL of a run. A run has one per asset and never one total,
   * so the asset is part of the statement rather than context around it — "the
   * total was 500000" is five thousand pounds, half a USDC, or a rounding error
   * in ether, and an auditor could not check it.
   */
  const attestRun = (run: PayrollRun, asset: AssetId) => act(async () => {
    const a = await api<Attestation>(
      `/api/runs/${run.id}/attest?asset=${asset}&viewingKey=${session.viewingKey}`, { method: 'POST' });
    const v = await api<{ valid: boolean }>(`/api/attestations/${a.id}/verify`);
    setIssued(x => [{ ...a, valid: v.valid }, ...x]);
  });

  /*
   * **`attestSolvency` STOOD HERE AND IS GONE.** `T-234`, `S47`.
   *
   * It POSTed to `/api/accounts/:id/attest-solvency`, which refuses
   * unconditionally (`src/core/payroll.ts:2232`) because the account holds no
   * balance to prove a threshold against (`C292`). A handler wired to a button
   * that can only ever produce an error is not a feature waiting on a server;
   * it is the screen claiming a capability. The card below keeps its fields and
   * its button, disabled, with the reason on them — rule 22b — because proving
   * what a VAULT holds is a real statement and this is where it will be made.
   *
   * It is not preserved as dead code: the request it made is three lines and
   * the round that builds vault solvency is writing a different one, against a
   * different commitment.
   */

  const settled = runs.filter(r => r.status === 'settled');

  return (
    <div className="stack">
      <div className="grid2">
        <div className="card">
          <div className="hd"><h3>Prove a payroll total</h3><span className="sub">for an accountant or tax authority</span></div>
          <div className="bd">
            {/* "Settle a run first." STOOD HERE and named a door that no
                longer exists: `C292` deleted settlement, so no run can reach
                `settled` and this list is empty for every company. Rule 19 —
                a refusal names a door that resolves it, and there is none to
                name.

                **AND "No settled runs." REPLACED IT AND WAS STILL WRONG.**
                `T-234`, `S47`. It reads as *this company has not settled one
                yet*, which is a statement about the company. The truth is a
                statement about the product: `run.status` is assigned in
                exactly two places in `src/` — `'draft'` and `'proposed'` — and
                **`'settled'` is assigned nowhere**, so no company can ever
                have one and the control below can never appear. Rule 22b:
                shown with its reason, never hidden. */}
            {settled.length === 0 && (
              <div className="empty" style={{ padding: 20 }}>
                <b>Not available yet</b>
                A payroll total is proved from a run a vault has paid. Nothing settles a run
                today — the account is an authority over a vault, not a holder of money, and
                the vault payment path is not built. No company has a settled run, and this
                is not waiting on anything you can do here.
              </div>
            )}
            {/* One row per asset the run settled in — each subtotal is its own
                statement, and there is no combined one to prove. */}
            {settled.slice(0, 4).flatMap(r =>
              Object.keys(r.totals).sort().map(asset => (
                <div className="row" key={`${r.id}:${asset}`}>
                  <span>{monthName(r.period)}, {asset}
                    <span className="sub2">
                      {money(r.totals[asset]!, asset)} across{' '}
                      {r.employees.filter(e => e.asset === asset).length} recipients
                    </span></span>
                  <span className="r"><button className="btn sm" onClick={() => attestRun(r, asset)} disabled={busy}>
                    Issue proof</button></span>
                </div>
              )))}
          </div>
        </div>

        <div className="card">
          <div className="hd"><h3>Prove solvency</h3><span className="sub">without revealing the balance</span></div>
          <div className="bd">
            <div className="two">
              {/* Shown, and inert. Rule 22b: the end state, with its reason. */}
              <div className="field"><label>Asset</label>
                <AssetSelect value={solvency.asset} disabled
                  onChange={code => setSolvency({ ...solvency, asset: code })} /></div>
              <div className="field"><label>Prove the vault holds at least ({solvencyAsset.code})</label>
                <input value={solvency.threshold} disabled
                  onChange={e => setSolvency({ ...solvency, threshold: e.target.value })} /></div>
            </div>
            {/* **THIS BUTTON WAS LIVE AND ALWAYS ERRORED.** `T-234`, `S47`.
                `attestSolvency` refuses unconditionally (`payroll.ts:2232`)
                because the account holds no balance at all (`C292`) — so an
                enabled primary control here is `C178`'s species exactly: a
                control that appears to be a capability and is not. Disabled
                with its reason rather than removed, per rule 22b, because
                proving what a VAULT holds is a real statement and this is
                where it will be made. */}
            <button className="btn pri" disabled>Issue proof</button>
            <div className="hint" style={{ marginTop: 14 }}>
              <b>Not available yet.</b> This account holds no balance to prove a threshold
              against — it is an authority over a vault, not a holder of money. Proving what a
              vault holds is a different statement over a different commitment, and it is not
              built.
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="hd"><h3>Issued this session</h3></div>
        <div className="bd tight">
          {issued.length === 0
            ? <div className="empty"><b>No disclosures yet</b>Issue one above and it appears here.</div>
            : <table>
                <thead><tr><th>Statement</th><th>Circuit</th><th>Expires</th><th>Verified</th></tr></thead>
                <tbody>
                  {issued.map(a => (
                    <tr key={a.id}>
                      <td style={{ maxWidth: 430 }}>{a.statement}</td>
                      <td className="mono">{a.circuit}</td>
                      <td className="sub2">{new Date(a.expiresAt).toLocaleDateString('en-GB')}</td>
                      <td><span className={'chip ' + (a.valid ? 'ok' : 'no')}>{a.valid ? 'valid' : 'invalid'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

/**
 * What `/api/public` shows: everything an outside observer can see.
 *
 * **`settlements` STOOD HERE AND IS GONE WITH THE FIELD BEHIND IT.** `C313`,
 * It was `Array<{ ref, accountId, asset, amount, memo, at }>` and it was
 * unconditionally empty from `C292` onward, because nothing settles at the
 * account. The card below still has its row — rule 22b — and the row now says
 * why there is nothing in it instead of showing a zero that reads as a result.
 */
interface PublicView {
  proposals: unknown[];
}

/**
 * **WHAT THE CHAIN SAYS ABOUT THIS ACCOUNT'S APPROVAL RULES.**
 *
 * The shape of `LedgerStatus`, narrowed to the two fields this screen renders.
 * Both are public on chain by design (decision 0003), so showing them is the
 * product rather than a leak.
 *
 * `vaultThresholds` holds ONLY the vaults somebody deliberately gave their own
 * rule. Absence means inherit, so an empty array is not "no data" — it is the
 * true and complete statement that every vault is judged by the account's own
 * threshold.
 */
interface LedgerView {
  threshold: number;
  vaultThresholds: Array<{ vault: string; threshold: number }>;
  signerCount: number;
}

/*
 * **A BLANK BOX IS NOT A ZERO, AND `Number('')` IS.**
 *
 * `Number('')` is `0`, so a predicate written as `Number(v) < 1` calls an empty
 * field a refused threshold and shows a person the zero refusal before they
 * have typed anything. These two read the text and answer about the text.
 */
const zeroish = (v: string): boolean => v.trim() !== '' && !(Number(v) >= 1);
const overSeated = (v: string, seats: number): boolean =>
  v.trim() !== '' && Number(v) > seats;

function Settings({ account, state, session, me, busy, act, commitments }: {
  account: Account; state: ShieldedState; session: Session; me: SignerSecrets;
  busy: boolean; act: Act;
  /** Handed down from `App`, which is handed it by the entry point. Never imported. */
  commitments: CommitmentScheme;
}) {
  const [pub, setPub] = useState<PublicView | null>(null);
  const [chain, setChain] = useState<LedgerView | null>(null);
  const [vaultForm, setVaultForm] = useState({ vault: '', threshold: '2' });
  const [form, setForm] = useState({ name: '', email: '', role: 'approver' });
  const [open, setOpen] = useState(false);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [openInvites, setOpenInvites] = useState<Invite[]>([]);

  useEffect(() => { api<PublicView>('/api/public').then(setPub).catch(() => {}); }, [state, account]);

  /*
   * **ONE READ, AND IT IS THE LEDGER'S.** `null` while it has not
   * answered, and the card below says so rather than rendering
   * `account.policy.threshold` in the meantime — our copy is a number to
   * render on a screen that is ABOUT our copy, and this card is about the
   * chain's.
   */
  const loadChain = useCallback(async () => {
    setChain(await api<LedgerView>(`/api/accounts/${account.id}/ledger`));
  }, [account.id]);
  useEffect(() => { loadChain().catch(() => setChain(null)); }, [loadChain, state]);

  /*
   * Tokens raised in THIS session, held here because the listing no longer
   * serves them. Navigating away loses the link, which is a real cost and the
   * honest one: the alternative was every member being able to read every open
   * invite, which is what made an invite a bearer credential anybody could spend.
   */
  const [raised, setRaised] = useState<Record<string, string>>({});
  const inviteKey = (i: Invite) => i.subjectId ?? `${i.name}|${i.role}|${i.createdAt}`;

  const loadInvites = useCallback(async () => {
    const list = await api<Invite[]>(`/api/accounts/${account.id}/invites`);
    setOpenInvites(list.filter(i => i.kind === 'signer' && !i.acceptedAt));
  }, [account.id]);

  useEffect(() => { loadInvites().catch(() => {}); }, [loadInvites, account]);

  const invite = () => act(async () => {
    /*
     * THE TOKEN COMES BACK HERE AND NOWHERE ELSE, AND IT IS SHOWN ONCE. A-12.
     *
     * This used to read tokens out of `GET /accounts/:id/invites`, which served
     * them to any MEMBER — the check is membership, not role, so a viewer seat
     * could read every open invite. That listing stopped serving them and this
     * screen was not updated, so the join link rendered `/join/undefined` and a
     * company could not enrol a second signer: a regression, and one that leaves
     * a company on one device, which is `C11`.
     *
     * A SIGNER token is different from an EMPLOYEE one and that is why this is
     * allowed to come back at all: a signer who accepts still sees nothing until
     * `grantAccess`, which needs an approved proposal committing to their exact
     * leaf. An employee's handover has no second gate, which is why its token is
     * delivered and never returned.
     */
    const created = await api<Invite>(`/api/accounts/${account.id}/invites/signer`, {
      method: 'POST', body: JSON.stringify(form),
    });
    setForm({ name: '', email: '', role: 'approver' }); setOpen(false);
    /*
     * Keyed by the SUBJECT, and by a name+role fallback rather than a
     * millisecond timestamp — two invites raised in the same millisecond would
     * otherwise render one person's token against the other's name.
     */
    setRaised(x => ({ ...x, [inviteKey(created)]: created.token }));
    await loadInvites();
  });

  /**
   * Stands in for the invitee opening the link on their own device.
   *
   * Three secrets are generated here and ONLY PUBLIC HALVES LEAVE — including
   * the blinding factor, which stays. It is the one that is easy to lose track
   * of, because nothing visibly breaks without it until the signer tries to
   * prove membership on chain. It is as precious as the signing key, it belongs
   * in the keyring beside it, and since M-106 the server has no field to put it
   * in even if this code tried to send it.
   */
  const acceptInvite = (inv: Invite) => act(async () => {
    /*
     * **THE SEQUENCE IS IN `accept-seat.ts` AND A TEST DRIVES IT.** `C329`,
     *
     *
     * It was thirty lines here, in a file no test imports, and the two things
     * that matter about it are both invisible from outside: that the material
     * is sealed BEFORE the leaf is published, and that the leaf is derived the
     * way the contract reads it. What is left here is the four doors.
     */
    const accepted = await acceptSeatOnThisDevice(inv.accountId, commitments, {
      newKeys: () => {
        const sk = newSigningKeypair();
        const wk = newWrappingKeypair();
        return {
          signingSecret: sk.secret, signingPublicKey: sk.publicKey,
          wrappingSecret: wk.secret, wrappingPublicKey: wk.publicKey,
          blinding: newBlinding(),
        };
      },
      seal: (seat) => keyring.sealPendingSeat(seat),
      publish: (payload) => api<Signer>(`/api/invites/${inv.token}/accept-signer`, {
        method: 'POST',
        /*
         * THE BLINDING DOES NOT TRAVEL. M-106, and this line is where the
         * promise is either kept or broken.
         *
         * It briefly did: M-99's removal re-seated every surviving signer at a
         * new generation, and their new leaves cannot be computed without their
         * blindings, so each invitee had to send theirs to be held in the
         * account's sealed inbox. Slots re-seat nobody. Decision 0003 says a
         * blinding lives on one device and nowhere else, and `SeatDoors`
         * has no parameter for one.
         */
        body: JSON.stringify(payload),
      }),
      promote: (pk, signerId) => keyring.promotePendingSeat(pk, signerId),
    });
    setTokens(x => ({ ...x, [accepted.signerId]: accepted.wrappingSecret }));
    await loadInvites();
  });

  const grant = (sg: Signer) => act(async () => {
    await api(`/api/accounts/${account.id}/grant`, {
      method: 'POST', body: JSON.stringify({ viewingKey: session.viewingKey, signerId: sg.id }),
    });
  });

  const pendingSigners = account.signers.filter(x => x.status === 'pending');

  return (
    <div className="stack">
      {open && (
        <div className="card">
          <div className="hd"><h3>Invite a signer</h3></div>
          <div className="bd">
            <div className="two">
              <div className="field"><label>Name</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Rae Solomon" /></div>
              <div className="field"><label>Email</label>
                <input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="rae@northwind.co" /></div>
            </div>
            <div className="field"><label>Role</label>
              <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
                <option value="admin">Admin</option><option value="approver">Approver</option>
                <option value="initiator">Initiator</option><option value="viewer">Viewer</option>
              </select></div>
            <div className="inline">
              <button className="btn pri" onClick={invite} disabled={busy || !form.name || !form.email}>Create invite</button>
              <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {openInvites.length > 0 && (
        <div className="card">
          <div className="hd"><h3>Open invites</h3><span className="sub">{openInvites.length} not yet accepted</span></div>
          <div className="bd">
            {openInvites.map(inv => {
              /*
               * The link is only here if THIS session raised it. The listing no
               * longer carries tokens, so an invite raised on another device, or
               * before a refresh, shows as outstanding and nothing more — which
               * is the honest state rather than a broken link.
               */
              const token = raised[inviteKey(inv)];
              return (
                <div key={inviteKey(inv)} style={{ marginBottom: 16 }}>
                  <div className="field" style={{ marginBottom: 8 }}>
                    <label>{inv.name}, {inv.role}</label>
                    {token
                      ? <input readOnly value={`https://app.example/join/${token}`} />
                      : <div className="hint">
                          Raised, and the link is not shown again. Send it from wherever you
                          copied it, or withdraw this invite and raise a new one.
                        </div>}
                  </div>
                  {token && (
                    <button className="btn" onClick={() => acceptInvite({ ...inv, token })} disabled={busy}>
                      Open this invite as {(inv.name ?? '').split(' ')[0]}
                    </button>
                  )}
                </div>
              );
            })}
            <div className="hint">
              The link carries no secret and grants nothing. Opening it generates a keypair in that person's
              browser and sends back only the public halves.
            </div>
          </div>
        </div>
      )}

      {pendingSigners.length > 0 && (
        <div className="card">
          <div className="hd"><h3>Waiting for access</h3>
            <span className="sub">{pendingSigners.length} pending</span></div>
          <div className="bd tight">
            <table>
              <thead><tr><th>Name</th><th>Role</th><th>Can see</th><th></th></tr></thead>
              <tbody>
                {pendingSigners.map(sg => (
                  <tr key={sg.id}>
                    <td className="name">{sg.name}</td>
                    <td style={{ textTransform: 'capitalize' }}>{sg.role}</td>
                    <td><span className="chip no">nothing</span></td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn sm pri" onClick={() => grant(sg)} disabled={busy}>Grant access</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="bd" style={{ borderTop: '1px solid var(--line)' }}>
            <div className="hint">
              Granting re-wraps the viewing key to their public key. Only someone who already holds the key
              can do this, so the server cannot grant access on its own and neither can an administrator
              who has been removed.
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="hd"><h3>Signers</h3>
          <span className="sub">{account.policy.threshold} of {account.signers.filter(x => x.status === 'active').length} required to release funds</span>
          <div className="spacer" />
          {!open && <button className="btn pri" onClick={() => setOpen(true)}>Invite signer</button>}
        </div>
        <div className="bd tight">
          <table>
            <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Signing key</th></tr></thead>
            <tbody>
              {account.signers.map(sg => (
                <tr key={sg.id}>
                  <td className="name">{sg.name}</td>
                  <td style={{ textTransform: 'capitalize' }}>{sg.role}</td>
                  <td><span className={'chip ' + (sg.status === 'active' ? 'ok' : 'pend')}>{sg.status}</span></td>
                  <td className="mono sub2">{sg.signingPublicKey.slice(0, 26)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/*
        * **PER-VAULT APPROVAL THRESHOLDS, READ FROM THE CHAIN.** `R5`, `C172`.
        *
        * **THE VISIBILITY IS THE POINT.** This card is the whole argument for
        * deleting the server-held exception `R4` removed: the rule a company
        * uses to move small amounts faster is a number every signer can read
        * off the contract, changed only by a round every signer approves — not
        * a figure in our database that we apply on their behalf.
        *
        * It renders `LedgerStatus` and never `account.policy`. There is no
        * stored copy of any of this, so there is nothing here that can be
        * stale in the direction that matters.
        */}
      <div className="card">
        <div className="hd">
          <h3>Vault thresholds</h3>
          <span className="sub">on chain, and changed only by a round every signer approves</span>
        </div>
        <div className="bd">
          {!chain ? (
            <div className="hint">
              We have not been able to read the chain\u2019s answer yet, so this card is showing
              nothing rather than showing our own copy of the numbers.
            </div>
          ) : (
            <>
              <div className="row">
                <span>This account\u2019s own threshold</span>
                <span className="r">{chain.threshold} of {chain.signerCount}</span>
              </div>
              {chain.vaultThresholds.length === 0 ? (
                <div className="hint" style={{ marginTop: 12 }}>
                  No vault has its own threshold. Every vault inherits the account\u2019s number
                  above \u2014 that is what the contract does when it holds no entry for a vault,
                  so a new vault needs no setup and this list holds only deliberate exceptions.
                </div>
              ) : (
                <table style={{ marginTop: 12 }}>
                  <thead><tr><th>Vault</th><th>Approvals required</th></tr></thead>
                  <tbody>
                    {chain.vaultThresholds.map(v => (
                      <tr key={v.vault}>
                        <td className="mono sub2">{v.vault.slice(0, 26)}\u2026</td>
                        <td>{v.threshold} of {chain.signerCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div className="two" style={{ marginTop: 16 }}>
                <div className="field"><label>Vault address</label>
                  <input value={vaultForm.vault} placeholder="64 hex characters"
                    onChange={e => setVaultForm({ ...vaultForm, vault: e.target.value.trim() })} /></div>
                <div className="field"><label>Approvals required</label>
                  <input value={vaultForm.threshold}
                    onChange={e => setVaultForm({ ...vaultForm, threshold: e.target.value })} /></div>
              </div>
              {/*
                * **THE REFUSALS ARE SHOWN BEFORE THE BUTTON IS PRESSED, NOT
                * AFTER A SIGNATURE.** `R5`, trap 1.
                *
                * Zero would authorise anything out of that vault; a number
                * above the seats could never be met, and a vault nobody can
                * approve a payment from is a vault whose money stays there
                * until a governed round lowers the number again. The server
                * refuses both and the contract refuses the first \u2014 this is
                * the same refusal said early enough to be useful, and it is
                * disabling the control rather than describing the rule.
                */}
              {zeroish(vaultForm.threshold) && (
                <div className="hint">
                  A threshold of zero would authorise anything out of that vault. The contract
                  refuses it and so do we.
                </div>
              )}
              {overSeated(vaultForm.threshold, chain.signerCount) && (
                <div className="hint">
                  This company has {chain.signerCount} seated signers, so nobody could ever
                  approve a payment out of that vault. Its money would stay there until another
                  round lowered the number. This is our own refusal \u2014 the contract would
                  accept it.
                </div>
              )}
              <div className="inline">
                <button className="btn pri"
                  disabled={busy
                    || !/^[0-9a-f]{64}$/.test(vaultForm.vault)
                    || zeroish(vaultForm.threshold)
                    || overSeated(vaultForm.threshold, chain.signerCount)}
                  onClick={() => act(async () => {
                    await api(`/api/accounts/${account.id}/vault-threshold/propose`, {
                      method: 'POST',
                      body: JSON.stringify({
                        viewingKey: session.viewingKey,
                        vault: vaultForm.vault,
                        newThreshold: Number(vaultForm.threshold),
                        /*
                         * **NO SEAT IN THIS BODY EITHER.** Who is raising the
                         * round comes from the signed-in caller on the server.
                         * A seat a client supplies is a claim, and this approval
                         * is judged against the ceiling of that seat's role.
                         */
                      }),
                    });
                    await loadChain();
                  })}>Propose this threshold</button>
              </div>
              <div className="hint" style={{ marginTop: 10 }}>
                Proposing opens a round. It is approved like any other, at this account\u2019s own
                threshold \u2014 a vault\u2019s own lower number never authorises changing itself.
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="hd">
          <h3>On-chain visibility</h3>
          <span className="sub">everything anyone outside this company can see</span>
        </div>
        <div className="bd">
          <div className="grid2">
            <div>
              {/* **SHOWN DISABLED WITH ITS REASON, NEVER HIDDEN.** Rule 22b,
                  `C313`. This row printed a count and a list of settlements
                  until `S29`, and both were unconditionally empty from `C292`
                  onward — a zero beside the words "everything anyone outside
                  this company can see" reads as a demonstration that passed,
                  and it was an absence nobody had decided on. The hint under it
                  said "one aggregate figure per run, per asset", which is a
                  claim about a thing this account has never published. */}
              <div className="row off">
                <span>Settlements</span><span className="r sub2">not published</span>
              </div>
              <div className="hint" style={{ marginTop: 12 }}>
                The account is an authority over a vault, not a holder of money, so it settles
                nothing and publishes no settlement. What an observer sees when a vault pays a
                run is decided by the round that builds vault payroll, and is deliberately not
                shown here in advance of it.
              </div>
            </div>
            <div>
              {/* Safe to stringify: the public face of a proposal carries an id,
                  a digest, a count and ciphertext, and no amount at all. */}
              <pre>{JSON.stringify(pub ? pub.proposals[pub.proposals.length - 1] ?? {} : {}, null, 2)}</pre>
              <div className="hint" style={{ marginTop: 10 }}>
                A payroll proposal as the world sees it. No name, no salary.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* employee portal                                                     */
/* ------------------------------------------------------------------ */

/** One person's line on a run, opened with their own key and nobody else's. */
interface SlipView {
  runId: string; period: string; status: string; settledAt: string | null;
  payslip: { employeeId: string; name: string; asset: AssetId; amount: bigint; period: string };
}

function EmployeePortal({ session, runs, employee, onExit }: {
  session: Session; runs: PayrollRun[]; employee: EmployeeIdentity; onExit: () => void;
}) {
  const [slips, setSlips] = useState<SlipView[]>([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      const out: SlipView[] = [];
      for (const r of runs.filter(x => x.status === 'settled')) {
        try {
          out.push(await api<SlipView>(
            `/api/runs/${r.id}/employee/${employee.employeeId}?secret=${employee.wrappingSecret}`));
        } catch { /* not on that run, or this browser holds no key for them */ }
      }
      setSlips(out);
    })();
  }, [runs, employee]);

  const tryOther = async () => {
    setErr('');
    const other = session.employees.find(e => e.employeeId !== employee.employeeId);
    const run = runs.find(r => r.status === 'settled');
    if (!other || !run) { setErr('Nothing settled yet to try this against.'); return; }
    try {
      await api(`/api/runs/${run.id}/employee/${other.employeeId}?secret=${employee.wrappingSecret}`);
      setErr('That should not have worked.');
    } catch (e: any) {
      /* A refusal a person READS is a refusal the report keeps, even when the
       * refusal is the thing being demonstrated. `C159`. */
      setErr(`Blocked: ${shownError(e, 'the payslip demonstration')}`);
    }
  };

  /*
   * Paid to date, PER ASSET. Somebody paid in pounds and then in USDC has been
   * paid two amounts, not one sum — `subtotals` is the only adding this app
   * does, and it only ever adds within an asset.
   */
  const paid = subtotals(slips.map(s => ({ asset: s.payslip.asset, amount: s.payslip.amount })));

  return (
    <div className="app" style={{ gridTemplateColumns: '1fr' }}>
      <div className="main">
        <header className="topbar">
          <div className="brand" style={{ padding: 0 }}>
            <div className="mark">N</div>
            <div><b>Northwind Ltd</b><small>Employee portal</small></div>
          </div>
          <div className="spacer" />
          <div className="who">
            <div className="avatar">{initials(employee.name)}</div>
            <div><div style={{ fontWeight: 600 }}>{employee.name}</div>
              <div className="sub">{employee.title}</div></div>
            <button className="btn ghost sm" onClick={onExit} style={{ marginLeft: 10 }}>Exit</button>
          </div>
        </header>

        <div className="content" style={{ maxWidth: 900, width: '100%', margin: '0 auto' }}>
          <div className="stats" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
            <div className="stat"><div className="k">Payslips</div><div className="v">{slips.length}</div></div>
            <div className="stat"><div className="k">Paid to date</div>
              <div className="v" style={{ fontSize: 20 }}><PerAsset amounts={paid} empty="nothing yet" /></div></div>
            <div className="stat"><div className="k">Last payment</div>
              <div className="v" style={{ fontSize: 19 }}>{slips[0] ? monthName(slips[0].period) : '—'}</div></div>
          </div>

          <div className="card">
            <div className="hd"><h3>Your payslips</h3></div>
            <div className="bd tight">
              {slips.length === 0
                ? <div className="empty"><b>Nothing yet</b>Your first payslip appears once payroll settles.</div>
                : <table>
                    <thead><tr><th>Period</th><th className="num">Gross</th><th>Paid</th></tr></thead>
                    <tbody>
                      {slips.map(s => (
                        <tr key={s.runId}>
                          <td className="name">{monthName(s.period)}</td>
                          <td className="num">{money(s.payslip.amount, s.payslip.asset)}</td>
                          <td className="sub2">{s.settledAt ? new Date(s.settledAt).toLocaleDateString('en-GB') : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>}
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="hd"><h3>What you cannot see</h3></div>
            <div className="bd">
              <p style={{ color: 'var(--dim)', marginBottom: 12 }}>
                Colleagues' salaries and the company headcount are sealed to keys you do not hold.
                This is enforced by the cryptography, not by this screen hiding things.
              </p>
              <button className="btn" onClick={tryOther}>Try opening a colleague's payslip</button>
              {err && <div className="err" style={{ marginTop: 13, marginBottom: 0 }}>{err}</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
