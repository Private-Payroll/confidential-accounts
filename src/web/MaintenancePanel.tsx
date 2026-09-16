import { useCallback, useEffect, useState } from 'react';
import type { Account } from '../core/types.js';
import * as keyring from './keyring.js';
import { WALLET_ORIGIN } from './Auth.js';
import { whyNotHandOver } from './handover-check.js';

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
  holder: string | null;
  thisService?: boolean;
  onTheCompanysCommittee: boolean;
  you: boolean;
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

/** Who holds a seat, in words: a signer's name, or the plain fact that nobody on this company gave that key. */
export function seatWords(seat: SeatView, signers: Account['signers']): string {
  if (seat.thisService) return 'this service\'s temporary key';
  const name = seat.holder === null ? null : signers.find((s) => s.userId === seat.holder)?.name ?? null;
  const who = name ?? (seat.holder === null ? 'a key nobody now on this company gave' : 'a signer of this company');
  return `${who}${seat.you ? ' (you)' : ''}${seat.onTheCompanysCommittee ? '' : ' - not on the company\'s committee'}`;
}

export function MaintenancePanel({ account, api = keyring.api, walletKey }: {
  account: Account;
  api?: Api;
  /** The committee key this person's wallet gives for this company. */
  walletKey?: () => Promise<Key>;
}) {
  const [view, setView] = useState<AuthorityScreen | null>(null);
  const [err, setErr] = useState('');
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setView(await api(`/api/accounts/${account.id}/authority`) as AuthorityScreen);
  }, [account.id, api]);
  useEffect(() => { void refresh().catch((e) => setErr(String(e?.message ?? e))); }, [refresh]);

  const askWallet = walletKey
    ?? (async () => (await keyring.companyKeysForVaults(account.id, WALLET_ORIGIN)).committeeKey);

  const handOver = async () => {
    setBusy(true); setErr(''); setSaid('');
    try {
      const fresh = await api(`/api/accounts/${account.id}/authority`) as AuthorityScreen;
      const active = account.signers.filter((s) => s.status === 'active').length;
      const refused = whyNotHandOver(fresh, await askWallet(), active);
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
                      {seatWords(s, account.signers)} <span className="sub">{short(s.key.value)}</span>
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

            <button className="btn" disabled data-change-authority>Change who holds these rules</button>
            <div className="hint" data-change-why>{view.change.why}</div>
          </>
        )}
      </div>
    </div>
  );
}
