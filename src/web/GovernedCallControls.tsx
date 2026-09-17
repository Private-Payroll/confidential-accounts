import { useRef, useState } from 'react';
import { NETWORK } from 'midnight-identity/network';
import type { Hex } from '../core/crypto.js';
import type { Account, Proposal } from '../core/types.js';
import * as keyring from './keyring.js';
import {
  approveOnDevice, governedCallServiceFor, raiseRunOnDevice, sendRaiseFromDevice,
  type GovernedCallDoors, type GovernedStage,
} from './governed-call-on-device.js';
import { startVaultBuilder, type VaultBuilderClient } from './vault-worker-client.js';

/**
 * **RAISING A RUN'S LEG AND APPROVING A PROPOSAL, FROM THIS DEVICE.**
 *
 * The raise and the approval are built and proved in this page's background
 * thread with this signer's own keys, and the company's service pays the fee
 * and sends them. The screen says which step it is on, because a proof takes a
 * while and a person who sees nothing presses again.
 */

const STAGE_WORDS: Record<GovernedStage, string> = {
  'writing-down': 'writing the proposal down',
  'reading-the-chain': 'reading the company account from the chain',
  building: 'building and proving on this device',
  sending: 'sending',
  'waiting-for-the-chain': 'waiting for the chain to show it',
};
export const stageWords = (stage: GovernedStage): string => STAGE_WORDS[stage];

let started: Promise<VaultBuilderClient> | null = null;
/** The background thread, started once for the page and started again only if it failed to start. */
const theBuilder = (): Promise<VaultBuilderClient> => {
  started ??= startVaultBuilder(NETWORK);
  started.catch(() => { started = null; });
  return started;
};

const doorsFor = async (account: Account, progress: (s: GovernedStage) => void): Promise<GovernedCallDoors> => ({
  service: governedCallServiceFor(keyring.api),
  builder: await theBuilder(),
  material: keyring.signerMaterialFor(account.id),
  accountId: account.id,
  progress,
});

/** One approval, from this device: the signature made with the keyring, the approval proved in the background thread. */
export async function approveFromThisDevice(
  account: Account, proposal: Proposal, me: { signerId: string; signingSecret: Hex }, viewingKey: Hex,
  progress: (s: GovernedStage) => void,
): Promise<void> {
  await approveOnDevice(await doorsFor(account, progress), {
    round: proposal, signerId: me.signerId, signature: keyring.signApproval(proposal, me), viewingKey,
  });
}

/** A proposal written down and not yet sent: sent again from this device. */
export async function sendRunFromThisDevice(
  account: Account, runId: string, asset: string, viewingKey: Hex, progress: (s: GovernedStage) => void,
): Promise<void> {
  await sendRaiseFromDevice(await doorsFor(account, progress), { runId, viewingKey, asset });
}

const DAY = 86_400;
const nowInSeconds = () => Math.floor(Date.now() / 1000);

/**
 * **THE THREE THINGS A LEG IS RAISED WITH THAT NOTHING ELSE CAN SUPPLY**: the
 * vault that will pay it, chosen from the company's own, and the window it may
 * be paid in. The vault is folded into what the signers approve, so it is
 * chosen from a list and never typed.
 */
export function RaiseLeg({ account, runId, asset, viewingKey, act, busy }: {
  account: Account; runId: string; asset: string; viewingKey: Hex;
  act: (fn: () => Promise<void>) => Promise<void>; busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [vaults, setVaults] = useState<string[] | null>(null);
  const [vault, setVault] = useState('');
  const [opens, setOpens] = useState(() => new Date(nowInSeconds() * 1000).toISOString().slice(0, 10));
  const [closes, setCloses] = useState(() => new Date((nowInSeconds() + 14 * DAY) * 1000).toISOString().slice(0, 10));
  const [stage, setStage] = useState<GovernedStage | null>(null);
  const loading = useRef(false);

  const show = async () => {
    setOpen(true);
    if (vaults !== null || loading.current) return;
    loading.current = true;
    try {
      const listed = await keyring.api(`/api/accounts/${encodeURIComponent(account.id)}/vaults`) as Array<{ vault: string }>;
      setVaults(listed.map((v) => v.vault));
    } catch {
      setVaults([]);
    } finally {
      loading.current = false;
    }
  };

  const seconds = (day: string, endOfDay: boolean): string =>
    String(Math.floor(new Date(`${day}T${endOfDay ? '23:59:59' : '00:00:00'}Z`).getTime() / 1000));

  const raise = () => act(async () => {
    try {
      await raiseRunOnDevice(await doorsFor(account, setStage), {
        runId, viewingKey, asset, vault, opensAt: seconds(opens, false), closesAt: seconds(closes, true),
      });
    } finally {
      setStage(null);
    }
  });

  if (!open) {
    return <button className="btn sm pri" disabled={busy} onClick={() => { void show(); }} data-raise-leg>
      Submit {asset} for approval</button>;
  }
  return (
    <div className="stack" data-raise-form style={{ textAlign: 'left' }}>
      <div className="field"><label>Paid from vault</label>
        <select value={vault} onChange={(e) => setVault(e.target.value)} disabled={busy} data-raise-vault>
          <option value="">{vaults === null ? 'Reading this company’s vaults…'
            : vaults.length === 0 ? 'This company has no vault yet' : 'Choose the vault that will pay'}</option>
          {(vaults ?? []).map((v) => <option key={v} value={v}>{`${v.slice(0, 10)}…${v.slice(-6)}`}</option>)}
        </select></div>
      <div className="inline">
        <div className="field"><label>Payable from</label>
          <input type="date" value={opens} onChange={(e) => setOpens(e.target.value)} disabled={busy} /></div>
        <div className="field"><label>until</label>
          <input type="date" value={closes} onChange={(e) => setCloses(e.target.value)} disabled={busy} /></div>
      </div>
      {stage && <div className="hint" data-raise-stage>Now: {stageWords(stage)}…</div>}
      <div className="inline">
        <button className="btn sm pri" disabled={busy || vault === '' || opens >= closes} onClick={() => { void raise(); }}
          data-raise-send>Raise from this device</button>
        <button className="btn sm ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <div className="hint">The vault and the window are part of what every signer approves, and cannot be changed
        afterwards. The proposal is built and proved on this device; the company pays the network fee.</div>
    </div>
  );
}
