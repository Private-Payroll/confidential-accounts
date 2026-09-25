import { useCallback, useEffect, useState } from 'react';
import type { Account } from '../core/types.js';
import * as keyring from './keyring.js';
import { WALLET_ORIGIN } from './Auth.js';
import { holderOf, whyNotHandOver, type Roster } from './handover-check.js';
import {
  NothingToSign, signCommitteeChangeOnDevice, type CommitteeChangeDoors, type CommitteeChangeView,
} from './committee-change-on-device.js';

export { whyNotHandOver };

/**
 * **WHO CAN CHANGE THIS COMPANY'S RULES, AS THE CHAIN SAYS, FOR ITS ACCOUNT AND
 * EVERY VAULT.**
 *
 * Every contract a company has carries a list of keys and a number: how many of
 * those keys must sign before the contract's rules - which proofs it accepts -
 * can be replaced. On the company account that decides every vault's payouts,
 * because a vault pays out on the account's approval. The company sees one list,
 * its committee: one key per signer, at the company's own threshold. Underneath,
 * each contract holds its own copy, and this screen reads every copy off the
 * chain each time it is opened.
 *
 * **WHAT IT DOES NOT SAY.** The chain checks only signatures. Nothing here says
 * the chain requires the company's approval for a change; it requires enough of
 * these keys.
 */
interface SeatView {
  key: { tag: string; value: string };
  /** Always null now: the service keeps no record of whose each key is, and the roster names the holder here. */
  holder?: string | null;
  thisService?: boolean;
  onTheCompanysCommittee: boolean;
}
interface ContractView {
  contract: 'account' | 'vault';
  address: string;
  read: string;
  seats: SeatView[];
  threshold: number | null;
  changes: string | null;
  shape: string | null;
  heldByTheCompany: boolean;
  seatsOutsideTheCommittee: number;
  why: string;
}
export interface AuthorityScreen {
  company: { address: string; threshold: number; signerCount: number } | null;
  committee: { committee: { tag: string; value: string }[]; threshold: number } | null;
  why: string | null;
  everySignerNeeded: string | null;
  contracts: ContractView[];
  handover: { possible: boolean; why: string | null; permanent?: string };
  change: { possible: boolean; why: string };
}

type Api = (path: string, opts?: RequestInit) => Promise<any>;
type Key = { tag: string; value: string };

const short = (hex: string) => `${hex.slice(0, 8)}…${hex.slice(-6)}`;

/**
 * Who holds a seat, in words: the name the company's own roster gives the key,
 * or the plain fact that no seated signer's roster entry names it.
 */
export function seatWords(seat: SeatView, roster: Roster, me: { signerId: string }): string {
  if (seat.thisService) return 'this service\'s temporary key';
  const holder = holderOf(seat.key, roster);
  const who = holder?.name ?? 'a key nobody now on this company gave';
  const you = holder !== null && holder.signerId === me.signerId;
  return `${who}${you ? ' (you)' : ''}${seat.onTheCompanysCommittee ? '' : ' - not on the company\'s committee'}`;
}

export function MaintenancePanel({
  account, me, api = keyring.api, walletKey, roster = async () => account, signInWallet,
}: {
  account: Account;
  /** This person's own seat, so the screen can say which seat is theirs. */
  me: { signerId: string };
  api?: Api;
  /** The committee key this person's wallet gives for this company. */
  walletKey?: () => Promise<Key>;
  /** The company's sealed roster, opened on this device afresh. The account as this page opened it when not given. */
  roster?: () => Promise<Roster & { policy?: { threshold: number } }>;
  /** Asks this person's wallet to sign a committee change. The wallet in its own window when not given. */
  signInWallet?: CommitteeChangeDoors['askWallet'];
}) {
  const [view, setView] = useState<AuthorityScreen | null>(null);
  const [owed, setOwed] = useState<CommitteeChangeView | null>(null);
  const [err, setErr] = useState('');
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const screen = await api(`/api/accounts/${account.id}/authority`) as AuthorityScreen;
    setView(screen);
    setOwed(screen.change.possible
      ? await api(`/api/accounts/${account.id}/committee-change`) as CommitteeChangeView
      : null);
  }, [account.id, api]);
  useEffect(() => { void refresh().catch((e) => setErr(String(e?.message ?? e))); }, [refresh]);

  const askWallet = walletKey
    ?? (async () => (await keyring.companyKeysForVaults(account.id, WALLET_ORIGIN)).committeeKey);

  const askToSign = signInWallet
    ?? ((ask) => keyring.signCommitteeChangeFromTheWallet(WALLET_ORIGIN, ask));

  /*
   * **THIS PERSON SIGNS THE CHANGE ON EVERY CONTRACT THEY HOLD A SEAT ON, IN
   * THEIR OWN WALLET.** The committee the service names is checked against the
   * roster this device opened before the wallet is asked; the service puts the
   * signatures together and sends each change once enough have signed.
   */
  const signChange = async () => {
    setBusy(true); setErr(''); setSaid('');
    try {
      const { results } = await signCommitteeChangeOnDevice({
        view: async () => await api(`/api/accounts/${account.id}/committee-change`) as CommitteeChangeView,
        walletKey: askWallet,
        roster,
        askWallet: askToSign,
        send: async (body) => await api(`/api/accounts/${account.id}/committee-change/signatures`, {
          method: 'POST', body: JSON.stringify(body),
        }),
      }, me);
      const sent = results.filter((r) => r.state === 'sent').length;
      const waiting = results.filter((r) => r.state === 'waiting');
      const refused = results.filter((r) => r.state === 'refused');
      const parts = [
        sent > 0 ? `${sent} change${sent === 1 ? ' was' : 's were'} signed by enough of the signers and sent. Each takes effect once the chain shows it below.` : '',
        waiting.length > 0 ? `${waiting.length} change${waiting.length === 1 ? ' waits' : 's wait'} for more signers: `
          + waiting.map((w) => `${String(w.have)} of ${String(w.required)} signed`).join(', ') + '.' : '',
      ].filter((p) => p !== '');
      if (parts.length > 0) setSaid(`Your signatures were handed over. ${parts.join(' ')}`);
      if (refused.length > 0) {
        setErr(`${refused.length === results.length ? 'No change could be used' : 'Some changes could not be used'}: `
          + refused.map((r) => String(r.error)).join(' '));
      }
    } catch (e: any) {
      if (e instanceof NothingToSign) setSaid(`${e.message.charAt(0).toUpperCase()}${e.message.slice(1)}`);
      else setErr(`Signing the change did not finish: ${String(e?.message ?? e)}`);
    } finally {
      setBusy(false);
      await refresh().catch(() => {});
    }
  };

  const handOver = async () => {
    setBusy(true); setErr(''); setSaid('');
    try {
      const fresh = await api(`/api/accounts/${account.id}/authority`) as AuthorityScreen;
      const refused = whyNotHandOver(fresh, await askWallet(), await roster(), me);
      if (refused !== null) throw new Error(refused);
      /* The committee checked here is the one sent, and the service installs only that one. */
      const r = await api(`/api/accounts/${account.id}/authority/handover`, {
        method: 'POST', body: JSON.stringify({ committee: fresh.committee }),
      });
      setSaid(`Sent (${r.txRef}). The account is held by the committee once the chain shows it below.`);
    } catch (e: any) {
      setErr(`Handing the account over did not finish: ${String(e?.message ?? e)}`);
    } finally {
      setBusy(false);
      await refresh().catch(() => {});
    }
  };

  return (
    <div className="card" data-maintenance-authority>
      <div className="hd"><h3>Who can change this company's rules</h3>
        <span className="sub">read from the chain, for the account and every vault</span></div>
      <div className="bd">
        {err && <div className="err">{err}</div>}
        {said && <div className="hint">{said}</div>}
        {view === null ? <div className="hint">Reading who holds this company's rules…</div> : (
          <>
            <div className="hint">
              Whoever holds enough of the keys listed for a contract can replace the rules it follows. On the company
              account, that decides what every vault pays out. The chain checks only their signatures.
            </div>
            {view.everySignerNeeded && <div className="err" data-every-signer-needed>{view.everySignerNeeded}</div>}
            {view.committee === null
              ? <div className="hint" data-no-committee>{view.why}</div>
              : (
                <div className="field">
                  <label>The company's committee</label>
                  <div data-committee>{view.committee.committee.length} key{view.committee.committee.length === 1 ? '' : 's'}, one per
                    signer; {view.committee.threshold} of them must sign any change.</div>
                </div>
              )}

            {view.contracts.map((c) => (
              <div key={c.address} className="field" data-contract={c.contract} data-held={String(c.heldByTheCompany)}>
                <label>{c.contract === 'account' ? 'Company account' : 'Vault'} {short(c.address)}</label>
                <div>{c.heldByTheCompany ? 'Held by the company\'s committee' : 'Not held by the company\'s committee'}
                  {c.threshold !== null && ` - ${c.threshold} of ${c.seats.length} must sign; changed ${c.changes} time${c.changes === '1' ? '' : 's'}`}</div>
                <ul>
                  {c.seats.map((s) => (
                    <li key={s.key.value} data-seat-outside={String(!s.onTheCompanysCommittee)}>
                      {seatWords(s, account, me)} <span className="sub">{short(s.key.value)}</span>
                    </li>
                  ))}
                </ul>
                {!c.heldByTheCompany && <div className="hint">{c.why}</div>}
              </div>
            ))}

            {view.handover.possible
              ? (
                <>
                  {view.handover.permanent && <div className="hint" data-handover-permanent>{view.handover.permanent}</div>}
                  <button className="btn pri" disabled={busy} onClick={handOver} data-hand-over-account>
                    Hand the account to the company's committee
                  </button>
                </>
              )
              : view.handover.why && !view.contracts[0]?.heldByTheCompany && <div className="hint">{view.handover.why}</div>}

            {owed !== null && owed.contracts.length > 0 && (
              <div className="field" data-change-owed>
                <label>Waiting for signatures</label>
                <ul>
                  {owed.contracts.map((c) => (
                    <li key={c.address} data-owed-contract={c.contract}>
                      {c.contract === 'account' ? 'Company account' : 'Vault'} {short(c.address)}: {c.signedSeats.length} of {c.required} signed
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <button className="btn" disabled={busy || !view.change.possible} onClick={signChange} data-change-authority>
              Sign the change in your wallet
            </button>
            <div className="hint" data-change-why>{view.change.why}</div>
          </>
        )}
      </div>
    </div>
  );
}
