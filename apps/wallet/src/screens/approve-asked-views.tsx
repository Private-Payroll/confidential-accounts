/*
 * The screens for the asks that hand off to a screen of their own: an action, a committee change, a records key, a retired company creation, a join code, addresses and balances, and a balance.
 * Each passes the screen's channel, consent and wallet choice on.
 */
import type { ReactNode } from 'react';
import { pinCompanyAccount, pinnedAccountOf } from 'midnight-identity/profile/model';
import { save } from 'midnight-identity/profile/store';
import type { Ask } from 'midnight-identity/profile/request';
import { ApproveBalance } from './approve-balance.js';
import { recordAsk } from '../lib/ask-record.js';
import { ApproveCommittee } from './approve-committee.js';
import { ApproveRecordsKey } from './approve-records-key.js';
import { ApproveJoinCode } from './approve-join-code.js';
import { ownJoinKeysOf } from './join-code-reader-key.js';
import { ApproveAddressesAndBalances } from './approve-addresses-and-balances.js';
import { actionFor } from '../actions/registry.js';
import { ActionRunner } from '../actions/runner-screen.js';
/* This wallet's own receiving addresses, which a join code's screen is given:
 * `../accounts/derived.ts`. */
import { receivingAddressesOf } from '../accounts/derived.js';
import { NETWORK } from 'midnight-identity/network';
import { StatusAlert } from '../components/status.js';
import { FINGERPRINT_TEXT } from './approve-text.js';
import { isPayingAsk } from './approve-slot.js';
import { alsoUsedBy } from '../accounts/slot-choice.js';
import type { Profile } from 'midnight-identity/profile/model';
import { PaysFromAccount, PaysWhenPicked } from './approve-pays-from.js';
import type { AskedScreen } from './approve-shape.js';

/** For an ask that pays: the account picked before the passkey, checked against the wallet open now. Null for any other ask. */

/** The other sites that already hold the paying account's address, read from this wallet's record once it is open. */
const sharedWith = (profile: Profile | null, account: number, request: Ask): readonly string[] =>
  (profile === null ? [] : alsoUsedBy(profile, account, request.requester.origin));

/*
 * An action runs on a screen of its own in the wallet, as the send screen does, and not in a dialog pushed over the
 * page that asked.
 */
export function actView(v: AskedScreen<Extract<Ask, { kind: 'act' }>>): ReactNode {
  const { identity, secret, now, framing, setChannelState, channel, subwallet, thisWallet, profile, request, consent, walletRecord, say, atOnce } = v;
  const action = actionFor(request.intent.name);
  if (action === null) {
    return (
      <StatusAlert tone="danger" title={say('ask.act.not-run-title')}>
        <p className="m-0" data-act-not-run>{say('ask.act.not-run')}</p>
      </StatusAlert>
    );
  }
  const decline = (): void => { channel?.refuse('declined'); setChannelState({ of: 'waiting' }); };
  const runner = (account: number, paying: boolean): ReactNode => (
    <ActionRunner
      request={request} action={action} channel={channel} identity={identity} secret={secret} consent={consent} framing={framing}
      atOnce={atOnce} now={now} wallet={walletRecord} account={account}
      {...(paying ? { payingFrom: <PaysFromAccount secret={secret} account={account} shared={sharedWith(profile, account, request)} /> } : {})}
      onDecline={decline}
    />
  );
  if (!isPayingAsk(request)) return runner(subwallet, false);
  return <PaysWhenPicked request={request} thisWallet={thisWallet} secret={secret} onDecline={decline} render={(account) => runner(account, true)} />;
}

export function committeeView(v: AskedScreen<Extract<Ask, { kind: 'committee' }>>): ReactNode {
  const { identity, readLabel, readChain, setChannelState, channel, request, consent, whoIsAsking } = v;
  return (
    <ApproveCommittee
      request={request}
      identity={identity}
      channel={channel}
      consent={consent}
      whoIsAsking={whoIsAsking}
      onDecline={() => { channel?.refuse('declined'); setChannelState({ of: 'waiting' }); }}
      readLabel={readLabel}
      {...(readChain === undefined ? {} : { readChain })}
    />
  );
}

export function recordsKeyView(v: AskedScreen<Extract<Ask, { kind: 'records-key' }>>): ReactNode {
  const { identity, port, readLabel, setChannelState, channel, profile, setProfile, request, consent, atOnce, readable, whoIsAsking } = v;
  return (
    <ApproveRecordsKey
      request={request}
      identity={identity}
      channel={channel}
      consent={consent}
      whoIsAsking={whoIsAsking}
      onDecline={() => { channel?.refuse('declined'); setChannelState({ of: 'waiting' }); }}
      readLabel={readLabel}
      answerAtOnce={atOnce && readable}
      pinned={profile === null ? null : pinnedAccountOf(profile, request.company)}
      onPin={async (account, at) => {
        if (profile === null) throw new Error('This wallet\'s record is not open, so nothing has been signed.');
        /* Called only by the person's press confirming the company's fingerprint matches the one their inviter gave
         * them, here or in the locked wallet's window: the account is kept as the company's once, and nothing is
         * signed until it has been. */
        const next = pinCompanyAccount(profile, { company: request.company, account, from: 'invited', at }, at);
        try {
          await save(port, identity, next);
        } catch {
          throw new Error('This wallet could not keep the company\'s account, so nothing has been signed. Try again.');
        }
        setProfile(next);
      }}
    />
  );
}

export function creationView(v: AskedScreen<Extract<Ask, { kind: 'creation' }>>): ReactNode {
  const { say } = v;
  /* **A PAGE-BUILT DEPLOY IS NOT SIGNED HERE ANY MORE.** Finishing a company is one action this wallet runs whole,
   * building the deploy and its second step itself (`actions/finish-company.ts`); an old page that still sends the
   * deploy it built is refused, and nothing is signed. */
  return (
    <StatusAlert tone="danger" title={say('ask.creation.retired-title')}>
      <p className="m-0" data-creation-retired>{say('ask.creation.retired')}</p>
    </StatusAlert>
  );
}

export function joinCodeView(v: AskedScreen<Extract<Ask, { kind: 'join-code' }>>): ReactNode {
  const { identity, readLabel, setChannelState, channel, request, consent, atOnce, whoIsAsking } = v;
  return (
    <ApproveJoinCode
      request={request}
      identity={identity}
      channel={channel}
      consent={consent}
      whoIsAsking={whoIsAsking}
      onDecline={() => { channel?.refuse('declined'); setChannelState({ of: 'waiting' }); }}
      receives={receivingAddressesOf(identity, NETWORK)}
      {...ownJoinKeysOf(identity, request)}
      fingerprintClass={FINGERPRINT_TEXT}
      readLabel={readLabel}
      answerAtOnce={atOnce}
    />
  );
}

export function addressesView(v: AskedScreen<Extract<Ask, { kind: 'addresses-and-balances' }>>): ReactNode {
  const { identity, now, setChannelState, channel, walletLocked, setWalletLocked, request, consent, owned, atOnce, slotQuiet, whoIsAsking, whichWallet } = v;
  return (
    <ApproveAddressesAndBalances
      request={request}
      identity={identity}
      owned={owned}
      channel={channel}
      consent={consent}
      whoIsAsking={whoIsAsking}
      whichWallet={whichWallet(
        'Which of your wallets',
        'The page sees this wallet\'s private address and balances, and nothing about your other wallets.', walletLocked)}
      onDecline={() => { channel?.refuse('declined'); setChannelState({ of: 'waiting' }); }}
      onBusy={setWalletLocked}
      now={now}
      answerAtOnce={atOnce && slotQuiet}
    />
  );
}

export function balanceView(v: AskedScreen<Extract<Ask, { kind: 'balance' }>>): ReactNode {
  const { secret, setChannelState, thisWallet, payingChannel, request } = v;
  /* A payment pays from the account picked for it, in the wallet picked, and from nothing else. */
  const decline = (): void => { payingChannel?.refuse('declined'); setChannelState({ of: 'waiting' }); };
  return <PaysWhenPicked request={request} thisWallet={thisWallet} secret={secret} onDecline={decline} render={(account) => balanceFrom(v, account)} />;
}

function balanceFrom(v: AskedScreen<Extract<Ask, { kind: 'balance' }>>, account: number): ReactNode {
  const { identity, secret, now, readLabel, setChannelState, profile, portNow, payingChannel, setWalletLocked, request, consent, atOnce, whoIsAsking } = v;
  const shared = sharedWith(profile, account, request);
  return (
    <ApproveBalance
      request={request}
      identity={identity}
      account={account}
      channel={payingChannel}
      consent={consent}
      whoIsAsking={whoIsAsking}
      whichWallet={<PaysFromAccount secret={secret} account={account} shared={shared} />}
      onDecline={(why) => { payingChannel?.refuse(why ?? 'declined'); setChannelState({ of: 'waiting' }); }}
      onStage={(shown) => recordAsk(portNow.current, 'shown', shown, now())}
      onBusy={setWalletLocked}
      readLabel={readLabel}
      answerAtOnce={atOnce && profile !== null && shared.length === 0}
    />
  );
}
