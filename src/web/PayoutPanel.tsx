import { useRef, useState } from 'react';
import { NETWORK } from 'midnight-identity/network';
import type { Hex } from '../core/crypto.js';
import type { Account, PayrollRun } from '../core/types.js';
import { assets, formatAmount } from '../core/assets.js';
import type { PrivatePaymentOnTheWire, PrivatePaymentOrderOnTheWire } from '../midnight/private-payment-wire.js';
import * as keyring from './keyring.js';
import { WALLET_ORIGIN } from './Auth.js';
import {
  PaymentLandedUnrecorded, PaymentNotAsBuilt, PaymentNotYetSeen, payPrivatelyFromCompanyVault, type VaultStage,
} from './vault-operation.js';
import { deviceRecordsFor, deviceSignerFrom, privatePaymentsFor, rosterOf, vaultServiceFor } from './vault-page-doors.js';
import { startVaultBuilder, type VaultBuilderClient } from './vault-worker-client.js';

/**
 * **PAYING A PERSON PRIVATELY OUT OF THE COMPANY'S VAULT, ONE AT A TIME, AGAINST
 * A ROUND THE COMPANY APPROVED.**
 *
 * What this screen is handed is what the service rebuilt from that round: who
 * is paid, in what and how much. The vault's record of what it holds is opened
 * on this device with this signer's own key, the note to spend is chosen here,
 * and the payment is built and proved here. The company's service pays only
 * the network fee.
 *
 * **WHAT IT SHOWS AS PAID IS WHAT THE COMPANY'S ACCOUNT RECORDS**, read again
 * after every payment. A payment that may have been sent and has not been seen
 * to land is said to be exactly that, and while this panel stays open the
 * person is not offered to be paid again; a second tab, a reload or another
 * signer is not told, and the account refuses a second payment to the same
 * person whoever sends it.
 */
export function PayoutPanel({ account, me, viewingKey, runs }: {
  account: Account;
  me: { signerId: string; signingSecret: Hex; wrappingSecret: Hex };
  viewingKey: Hex;
  runs: readonly PayrollRun[];
}) {
  const payable = runs.flatMap((run) => Object.keys(run.payout ?? {}).sort()
    .filter((asset) => run.proposalIds[asset] !== undefined)
    .map((asset) => ({ key: `${run.id}:${asset}`, run, asset })));
  const [chosen, setChosen] = useState('');
  const [order, setOrder] = useState<PrivatePaymentOrderOnTheWire | null>(null);
  const [stage, setStage] = useState<VaultStage | null>(null);
  const [err, setErr] = useState('');
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<ReadonlySet<number>>(new Set());
  const builderRef = useRef<Promise<VaultBuilderClient> | null>(null);
  const service = vaultServiceFor(keyring.api, account.id);
  const leg = payable.find((p) => p.key === chosen);

  const builder = () => {
    builderRef.current ??= startVaultBuilder(NETWORK);
    builderRef.current.catch(() => { builderRef.current = null; });
    return builderRef.current;
  };

  const load = async (key: string) => {
    setChosen(key); setOrder(null); setErr(''); setSaid('');
    const found = payable.find((p) => p.key === key);
    if (!found) return;
    try {
      setOrder(await privatePaymentsFor(keyring.api, found.run.id, viewingKey, found.asset));
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  };

  const pay = (payment: PrivatePaymentOnTheWire) => async () => {
    if (!order || !leg) return;
    setBusy(true); setErr(''); setSaid('');
    try {
      const released = await keyring.companyKeysForVaults(account.id, WALLET_ORIGIN);
      const roster = rosterOf(account);
      const signedInAs = () => keyring.currentUser()?.id ?? null;
      const { recordsKeypairFrom } = await import('../midnight/company-nonce-secret.js');
      const { fromHex } = await import('../core/crypto.js');
      const done = await payPrivatelyFromCompanyVault({
        sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
        progress: setStage,
        service,
        me: deviceSignerFrom(me, released.companyKey),
        myRecordsKey: recordsKeypairFrom(fromHex(released.companyKey)).publicKey,
        signers: roster.signers,
        records: deviceRecordsFor(me.signingSecret, roster.filers, signedInAs),
        builder: await builder(),
      }, { order, payment });
      setSaid(`Paid privately (${done.txRef}). The chain holds the payment and the vault's record is updated.`);
    } catch (e: any) {
      const mayHaveMoved = e instanceof PaymentNotYetSeen || e instanceof PaymentNotAsBuilt || e instanceof PaymentLandedUnrecorded;
      if (mayHaveMoved) setWaiting(new Set([...waiting, payment.index]));
      setErr(mayHaveMoved ? e.message : `The payment did not finish: ${String(e?.message ?? e)}`);
    } finally {
      setBusy(false); setStage(null);
      await load(chosen).catch(() => {});
    }
  };

  const money = (amount: string) => (leg ? `${formatAmount(BigInt(amount), assets.require(leg.asset))} ${leg.asset}` : amount);

  return (
    <div className="card" data-payout-panel>
      <div className="hd"><h3>Pay a run from a vault</h3>
        <span className="sub">one person at a time, privately, against an approved round</span></div>
      <div className="bd">
        {err && <div className="err" data-payout-error>{err}</div>}
        {said && <div className="hint" data-payout-said>{said}</div>}
        {stage && <div className="hint" data-payout-stage>Now: {stage}…</div>}
        <div className="field"><label>Run</label>
          <select value={chosen} onChange={(e) => { void load(e.target.value); }} disabled={busy} data-payout-run>
            <option value="">{payable.length === 0 ? 'No run has been raised yet' : 'Choose a run'}</option>
            {payable.map((p) => <option key={p.key} value={p.key}>{p.run.period} — {p.asset}</option>)}
          </select></div>
        {order && (
          <table data-payout-people>
            <thead><tr><th>Person</th><th className="num">Amount</th><th></th></tr></thead>
            <tbody>
              {order.payments.map((p) => (
                <tr key={p.index} data-payout-person={p.paid === true ? 'paid' : 'owed'}>
                  <td className="name">{leg?.run.employees.filter((e) => e.asset === leg.asset)[p.index]?.name
                    ?? `Person ${p.index + 1}`}</td>
                  <td className="num">{money(p.amount)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {p.paid === true && <span className="chip ok">paid</span>}
                    {p.paid !== true && waiting.has(p.index) && <span className="chip">sent, waiting for the chain</span>}
                    {p.paid !== true && !waiting.has(p.index) && (
                      <button className="btn sm pri" disabled={busy} onClick={pay(p)} data-pay-privately>
                        Pay privately</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="hint" style={{ marginTop: 14 }}>
          A run is paid only once its signers have approved it and inside the window they approved. Each payment
          spends one of the vault's notes, and whatever it does not pay out goes back to the vault as a new note.
          The amount and the person paid are not written on the chain in the open. What the chain does show: that
          this vault made a payment against this approved round, how many payments the vault has made, whether a
          payment left change, which of the vault's earlier notes the payment spent (and so which deposit or earlier
          payment the money came from), and a record of each payment that anyone who already knows its details could
          match.
          The company pays the network fee.
        </div>
      </div>
    </div>
  );
}
