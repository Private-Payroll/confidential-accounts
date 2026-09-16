import { useCallback, useEffect, useRef, useState } from 'react';
import { NETWORK } from 'midnight-identity/network';
import type { Hex } from '../core/crypto.js';
import type { Account } from '../core/types.js';
import { assets, ledgerFormOf, ledgerTokenOf, parseAmount } from '../core/assets.js';
import * as keyring from './keyring.js';
import { WALLET_ORIGIN } from './Auth.js';
import {
  createCompanyVault, depositIntoCompanyVault, openCompanyVaultPool,
  VaultHandoverOwed, type VaultStage,
} from './vault-operation.js';
import {
  browserTemporaryKeys, deviceRecordsFor, deviceSignerFrom, giveVaultKeys, rosterOf, vaultServiceFor,
} from './vault-page-doors.js';
import { startVaultBuilder, type VaultBuilderClient } from './vault-worker-client.js';

/**
 * **A COMPANY'S VAULTS, CREATED AND FUNDED FROM THIS SCREEN.**
 *
 * Every step is one press and runs on this device: the vault is built and
 * proved here, handed to the company's committee straight after it lands, its
 * note pool is opened here, and money goes in from the signer's own wallet. The
 * company's service only pays the network fee and refuses anything that is not
 * exactly one of those.
 *
 * **WHAT THIS SCREEN SAYS ABOUT A VAULT IS WHAT THE CHAIN SAYS.** A vault whose
 * handover has not landed is shown as exactly that, with its address, and it
 * takes no money until the chain says the company's committee holds it.
 *
 * **NO VAULT ADDRESS IS OFFERED TO COPY.** Money is put in by calling the vault
 * from here, never by sending to its address: a plain send leaves money the
 * vault has no record of and can never spend.
 */
type VaultRow = { vault: Hex; deployedAt: string; state: string; why: string | null };

const STATE_WORDS: Record<string, string> = {
  'held-by-committee': 'Held by the company\'s committee',
  'handover-owed': 'Not finished: still held by the key it was created with',
  'not-on-chain-yet': 'Sent, not yet on the chain',
  'not-fundable': 'Held by the committee, but changed in a way this service cannot vouch for: no money goes in',
  unknown: 'The chain could not be asked',
};

const shieldedAssets = () => assets.enabled().filter((a) => ledgerFormOf(a, 'shielded').of === 'token');

export function VaultPanel({ account, me }: {
  account: Account;
  me: { signerId: string; signingSecret: Hex; wrappingSecret: Hex };
}) {
  const [rows, setRows] = useState<VaultRow[] | null>(null);
  const [committee, setCommittee] = useState<{ ready: boolean; why: string | null; mine: boolean } | null>(null);
  const [stage, setStage] = useState<VaultStage | null>(null);
  const [err, setErr] = useState('');
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const [asset, setAsset] = useState(() => shieldedAssets()[0]?.code ?? '');
  const [amount, setAmount] = useState('');
  const builderRef = useRef<Promise<VaultBuilderClient> | null>(null);
  const service = vaultServiceFor(keyring.api, account.id);

  const builder = () => {
    builderRef.current ??= startVaultBuilder(NETWORK);
    builderRef.current.catch(() => { builderRef.current = null; });
    return builderRef.current;
  };

  const refresh = useCallback(async () => {
    const [list, keys] = await Promise.all([
      keyring.api(`/api/accounts/${account.id}/vaults`),
      keyring.api(`/api/accounts/${account.id}/vault-keys`),
    ]);
    setRows(list.rows);
    setCommittee({ ready: keys.committee !== null, why: keys.why, mine: keys.mine !== null });
  }, [account.id]);

  useEffect(() => { void refresh().catch((e) => setErr(String(e?.message ?? e))); }, [refresh]);

  /** Every press: the company's keys from the wallet first, and this signer's public vault keys given once. */
  const withKeys = async () => {
    const released = await keyring.companyKeysForVaults(account.id, WALLET_ORIGIN);
    await giveVaultKeys(keyring.api, account.id, {
      committeeKey: released.committeeKey, companyKey: released.companyKey, signingSecret: me.signingSecret,
    });
    const roster = rosterOf(account);
    const signedInAs = () => keyring.currentUser()?.id ?? null;
    return {
      company: released.company,
      device: deviceSignerFrom(me, released.companyKey),
      records: deviceRecordsFor(me.signingSecret, roster.filers, signedInAs),
      signers: roster.signers,
      myRecordsKey: (await import('../midnight/company-nonce-secret.js')).recordsKeypairFrom(
        (await import('../core/crypto.js')).fromHex(released.companyKey)).publicKey,
    };
  };

  const pacing = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), progress: setStage };

  const run = (what: string, go: () => Promise<string>) => async () => {
    setBusy(true); setErr(''); setSaid('');
    try {
      setSaid(await go());
    } catch (e: any) {
      setErr(e instanceof VaultHandoverOwed ? e.message : `${what} did not finish: ${String(e?.message ?? e)}`);
    } finally {
      setBusy(false); setStage(null);
      await refresh().catch(() => {});
    }
  };

  const giveKeys = run('Giving your vault keys', async () => {
    await withKeys();
    return 'Your wallet gave its keys for this company\'s vaults.';
  });

  const create = run('Creating the vault', async () => {
    const k = await withKeys();
    const done = await createCompanyVault({
      ...pacing, account: k.company, service, builder: await builder(), keys: browserTemporaryKeys(),
    });
    return `The vault is created and held by the company's committee (${done.vault}).`;
  });

  const finish = (vault: Hex) => run('Handing the vault over', async () => {
    const k = await withKeys();
    await createCompanyVault({
      ...pacing, account: k.company, service, builder: await builder(), keys: browserTemporaryKeys(),
    }, vault);
    return 'The vault is now held by the company\'s committee.';
  });

  const openPool = (vault: Hex) => run('Opening the vault', async () => {
    const k = await withKeys();
    await openCompanyVaultPool({
      ...pacing, service, me: k.device, myRecordsKey: k.myRecordsKey, signers: k.signers, records: k.records,
    }, vault);
    return 'The vault\'s record of what it holds is open. Money can go in.';
  });

  const deposit = (vault: Hex) => run('Putting money in', async () => {
    const chosen = assets.require(asset);
    const value = parseAmount(amount, chosen);
    if (value <= 0n) throw new Error('an amount of nothing is not a deposit.');
    const money = { token: ledgerTokenOf(chosen.code, 'shielded') as Hex, value };
    const k = await withKeys();
    const done = await depositIntoCompanyVault({
      ...pacing, service, me: k.device, myRecordsKey: k.myRecordsKey, signers: k.signers, records: k.records,
      company: k.company, builder: await builder(),
      pay: (ask) => keyring.payIntoAVaultFromTheWallet(WALLET_ORIGIN, ask),
    }, vault, money);
    setAmount('');
    return `${amount} ${chosen.code} is in the vault (${done.txRef}).`;
  });

  return (
    <div className="card">
      <div className="hd"><h3>This company's vaults</h3>
        <span className="sub">created, handed to the company's committee and funded from this device</span></div>
      <div className="bd">
        {err && <div className="err" data-vault-error>{err}</div>}
        {said && <div className="hint" data-vault-said>{said}</div>}
        {stage && <div className="hint" data-vault-stage>Now: {stage}…</div>}

        {committee === null ? <div className="hint">Reading this company's vaults…</div> : (
          <>
            {!committee.mine && (
              <div className="field">
                <div className="hint">Your wallet has not given its keys for this company's vaults yet.
                  A vault is only created once every signer has.</div>
                <button className="btn" disabled={busy} onClick={giveKeys} data-give-vault-keys>Give my vault keys</button>
              </div>
            )}
            {!committee.ready && committee.why && <div className="hint" data-no-committee>{committee.why}</div>}

            {(rows ?? []).length === 0
              ? <div className="empty"><b>This company has no vault yet.</b></div>
              : (rows ?? []).map((row) => (
                <div key={row.vault} className="field" data-vault-row={row.state}>
                  <label>Vault created {new Date(row.deployedAt).toLocaleString()}</label>
                  <div data-vault-state>{STATE_WORDS[row.state] ?? row.state}</div>
                  {row.why && row.state !== 'held-by-committee' && <div className="hint">{row.why}</div>}
                  {row.state === 'handover-owed' && (
                    <button className="btn pri" disabled={busy} onClick={finish(row.vault)} data-finish-handover>
                      Finish handing it to the committee
                    </button>
                  )}
                  {row.state === 'held-by-committee' && (
                    <>
                      <button className="btn" disabled={busy} onClick={openPool(row.vault)} data-open-pool>
                        Open its record of what it holds
                      </button>
                      <div className="two">
                        <div className="field"><label>Asset</label>
                          <select value={asset} onChange={(e) => setAsset(e.target.value)} disabled={busy}>
                            {shieldedAssets().map((a) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
                          </select></div>
                        <div className="field"><label>Amount</label>
                          <input value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} placeholder="0.00" /></div>
                      </div>
                      <button className="btn pri" disabled={busy || amount.trim() === '' || asset === ''} onClick={deposit(row.vault)} data-deposit>
                        Put money in from my wallet
                      </button>
                    </>
                  )}
                </div>
              ))}

            <button className="btn pri" disabled={busy || !committee.ready} onClick={create} data-create-vault>
              Create a vault
            </button>
            <div className="hint" style={{ marginTop: 14 }}>
              A vault is created with a key made on this device, and handed to the company's committee as soon as
              the chain has it; until then it takes no money. Money goes in from your own wallet, which shows you
              exactly what leaves it. The company pays the network fee. Nobody is ever shown a vault address to send
              to: money sent to one is money the vault can never spend.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
