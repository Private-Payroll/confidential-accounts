import { useEffect, useRef, useState } from 'react';
import { NETWORK } from 'midnight-identity/network';
import type { Hex } from '../core/crypto.js';
import type { Account, Proposal } from '../core/types.js';
import * as keyring from './keyring.js';
import {
  approveOnDevice, governedCallServiceFor, raiseRetryOnDevice, raiseRunOnDevice, sendRaiseFromDevice, unpaidToRetry,
  type GovernedCallDoors, type GovernedStage, type RaiseDoors,
} from './governed-call-on-device.js';
import { startVaultBuilder, type VaultBuilderClient } from './vault-worker-client.js';
import { SealedNotePool } from '../midnight/vault-pool.js';
import { deviceVaultHoldings } from './device-vault-holdings.js';
import { deviceRecordsFor, rosterOf, vaultServiceFor } from './vault-page-doors.js';

/**
 * **RAISING A RUN'S LEG AND APPROVING A PROPOSAL, FROM THIS DEVICE.**
 *
 * The raise and the approval are built and proved in this page's background
 * thread with this signer's own keys, and the company's service pays the fee
 * and sends them. The screen says which step it is on, because a proof takes a
 * while and a person who sees nothing presses again.
 */

const STAGE_WORDS: Record<GovernedStage, string> = {
  'checking-the-vault': 'checking on this device that the vault can pay it',
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

/**
 * **WHAT THE VAULT HOLDS PRIVATELY, READ HERE.** The pool is opened with this
 * signer's own key, compared with the notes the chain holds for the vault, and
 * walked through the payments in the page's background thread. None of it is
 * sent anywhere.
 */
const holdingsFor = (
  account: Account, me: { signerId: string; signingSecret: Hex; wrappingSecret: Hex }, builder: VaultBuilderClient,
) => {
  const roster = rosterOf(account);
  const records = deviceRecordsFor(me.signingSecret, roster.filers, () => keyring.currentUser()?.id ?? null);
  const pool = new SealedNotePool(records('pool'), { signerId: me.signerId, wrappingSecret: me.wrappingSecret }, roster.signers);
  const wire = (n: { nonce: Hex; token: Hex; value: bigint; createdIn?: Hex }) => ({
    nonce: n.nonce, token: n.token, value: n.value.toString(), ...(n.createdIn === undefined ? {} : { createdIn: n.createdIn }),
  });
  return deviceVaultHoldings({
    chain: (vault) => vaultServiceFor(keyring.api, account.id).chain(vault),
    pool: async (vault) => (await pool.load(vault)).notes,
    heldCommitmentOf: async (vault, note) => (await builder.commitments({ vault, coin: wire(note) })).held,
    paymentsFit: (notes, payments) => builder.paymentsFit({
      notes: notes.map(wire), payments: payments.map((p) => ({ token: p.token, amount: p.amount.toString() })),
    }),
  });
};

/** One approval, from this device: the signature made with the keyring, the approval proved in the background thread. */
export async function approveFromThisDevice(
  account: Account, proposal: Proposal, me: { signerId: string; signingSecret: Hex }, viewingKey: Hex,
  progress: (s: GovernedStage) => void,
): Promise<void> {
  await approveOnDevice(await doorsFor(account, progress), {
    round: proposal, signerId: me.signerId, signature: keyring.signApproval(proposal, me), viewingKey,
  });
}

/** A proposal written down and not yet sent: sent again from this device, with the vault checked here first. */
export async function sendRunFromThisDevice(
  account: Account, me: { signerId: string; signingSecret: Hex; wrappingSecret: Hex },
  runId: string, asset: string, viewingKey: Hex, progress: (s: GovernedStage) => void,
): Promise<void> {
  const doors = await doorsFor(account, progress);
  await sendRaiseFromDevice({ ...doors, holdings: holdingsFor(account, me, await theBuilder()) }, { runId, viewingKey, asset });
}

const DAY = 86_400;
const nowInSeconds = () => Math.floor(Date.now() / 1000);

/** This company's vaults, as the service lists them. */
const vaultsOf = async (account: Account): Promise<string[]> =>
  ((await keyring.api(`/api/accounts/${encodeURIComponent(account.id)}/vaults`)) as Array<{ vault: string }>).map((v) => v.vault);

const seconds = (day: string, endOfDay: boolean): string =>
  String(Math.floor(new Date(`${day}T${endOfDay ? '23:59:59' : '00:00:00'}Z`).getTime() / 1000));

/**
 * **THE VAULT THAT WILL PAY AND THE WINDOW IT MAY PAY IN**, the two things a
 * leg or a retry is raised with that nothing else can supply. The vault is
 * folded into what the signers approve, so it is chosen from the company's own
 * list and never typed.
 */
function VaultAndWindow({ listVaults, busy, stage, go, goWords, onCancel, attr }: {
  listVaults: () => Promise<string[]>; busy: boolean; stage: GovernedStage | null;
  go: (choice: { vault: string; opensAt: string; closesAt: string }) => void; goWords: string;
  onCancel: () => void; attr: string;
}) {
  const [vaults, setVaults] = useState<string[] | null>(null);
  const [vault, setVault] = useState('');
  const [opens, setOpens] = useState(() => new Date(nowInSeconds() * 1000).toISOString().slice(0, 10));
  const [closes, setCloses] = useState(() => new Date((nowInSeconds() + 14 * DAY) * 1000).toISOString().slice(0, 10));
  const loading = useRef(false);
  useEffect(() => {
    if (vaults !== null || loading.current) return;
    loading.current = true;
    listVaults().then(setVaults, () => setVaults([])).finally(() => { loading.current = false; });
  }, [vaults, listVaults]);

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
        <button className="btn sm pri" disabled={busy || vault === '' || opens >= closes}
          onClick={() => go({ vault, opensAt: seconds(opens, false), closesAt: seconds(closes, true) })}
          {...{ [attr]: true }}>{goWords}</button>
        <button className="btn sm ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      <div className="hint">The vault and the window are part of what every signer approves, and cannot be changed
        afterwards. The proposal is built and proved on this device; the company pays the network fee.</div>
    </div>
  );
}

/**
 * **A LEG OF A RUN, RAISED FROM THIS DEVICE**, with the vault that will pay it
 * and the window it may be paid in.
 */
export function RaiseLeg({ account, me, runId, asset, viewingKey, act, busy }: {
  account: Account; me: { signerId: string; signingSecret: Hex; wrappingSecret: Hex };
  runId: string; asset: string; viewingKey: Hex;
  act: (fn: () => Promise<void>) => Promise<void>; busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<GovernedStage | null>(null);

  const raise = (choice: { vault: string; opensAt: string; closesAt: string }) => act(async () => {
    try {
      const doors = await doorsFor(account, setStage);
      await raiseRunOnDevice({ ...doors, holdings: holdingsFor(account, me, await theBuilder()) }, {
        runId, viewingKey, asset, ...choice,
      });
    } finally {
      setStage(null);
    }
  });

  if (!open) {
    return <button className="btn sm pri" disabled={busy} onClick={() => setOpen(true)} data-raise-leg>
      Submit {asset} for approval</button>;
  }
  return <VaultAndWindow listVaults={() => vaultsOf(account)} busy={busy} stage={stage}
    go={(choice) => { void raise(choice); }} goWords="Raise from this device" onCancel={() => setOpen(false)}
    attr="data-raise-send" />;
}

/**
 * **RETRY THE PEOPLE A STOPPED RUN DID NOT PAY.** Offered only when the run's
 * payment view says who was paid and has proved its people are this run's, the
 * run's window has closed, and nothing sent can still pay them; it names only
 * those people. Their payments are checked
 * against the vault on this device before the company is asked to write the
 * retry down, and the retry is built, proved and sent here.
 */
export function RetryUnpaid({ account, me, runId, asset, viewingKey, view, act, busy, doors, listVaults }: {
  account: Account; me: { signerId: string; signingSecret: Hex; wrappingSecret: Hex };
  runId: string; asset?: string; viewingKey: Hex;
  view: Parameters<typeof unpaidToRetry>[0];
  act: (fn: () => Promise<void>) => Promise<void>; busy: boolean;
  /** The device's doors. This page's own when not given. */
  doors?: (progress: (s: GovernedStage) => void) => Promise<RaiseDoors>;
  listVaults?: () => Promise<string[]>;
}) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<GovernedStage | null>(null);
  const indices = unpaidToRetry(view);
  if (indices.length === 0) return null;

  const retry = (choice: { vault: string; opensAt: string; closesAt: string }) => act(async () => {
    try {
      const d = doors ? await doors(setStage)
        : { ...(await doorsFor(account, setStage)), holdings: holdingsFor(account, me, await theBuilder()) };
      await raiseRetryOnDevice(d, { runId, viewingKey, ...(asset === undefined ? {} : { asset }), indices, ...choice });
    } finally {
      setStage(null);
    }
  });

  return (
    <div className="stack" data-retry-unpaid style={{ marginTop: 14 }}>
      <div className="hint">
        {indices.length} {indices.length === 1 ? 'person' : 'people'} on this run {indices.length === 1 ? 'is' : 'are'} not
        paid (#{indices.map((i) => i + 1).join(', #')}) and this run's window has closed. The retry pays only them,
        each with the same payment as before, and the account refuses a payment already made, so nobody is paid twice.
        A retry is its own approval round, with its own fees.
      </div>
      {!open
        ? <div><button className="btn sm pri" disabled={busy} onClick={() => setOpen(true)} data-retry-open>
          Retry the unpaid</button></div>
        : <VaultAndWindow listVaults={listVaults ?? (() => vaultsOf(account))} busy={busy} stage={stage}
          go={(choice) => { void retry(choice); }} goWords="Retry from this device" onCancel={() => setOpen(false)}
          attr="data-retry-send" />}
    </div>
  );
}
