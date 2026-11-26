/*
 * What the approval screen holds while a page asks: the channel the ask arrives on, the opened record, the wallet chosen, the picks and typed details, and the rows built from what the page wants.
 * It listens on the window it is given and reads the stored record; it sends nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { check } from 'midnight-identity/profile/definition';
import type { AttributeDefinition } from 'midnight-identity/profile/definition';
import { emptyProfile, selfAssert } from 'midnight-identity/profile/model';
import type { Profile } from 'midnight-identity/profile/model';
import { drewTheLabelFor } from 'midnight-identity/profile/model';
import { readCompanyLabel } from 'midnight-identity/profile/company-label';
import type { WalletRecord } from '../actions/definition.js';
import { load, save } from 'midnight-identity/profile/store';
import type { Opened } from 'midnight-identity/profile/seal';
import type { Ask, Wanting } from 'midnight-identity/profile/request';
import { framingOf, listen } from 'midnight-identity/profile/channel';
import type { ActingChannel, ChannelState, ChannelWindow } from 'midnight-identity/profile/channel';
import { checkedChannel } from '../keyring/nothing-secret-crosses.js';
import { accountCarriesTheLabel, useCompanyCheck } from './company-on-chain.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { useConsent } from '../framing.js';
import { recordChannelState, recordedChannel } from '../lib/ask-record.js';
import { ownedAddressFor } from '../accounts/owned-address.js';
/* Which wallet a company is OFFERED, which is a rule and a default
 * rather than a refusal: `../accounts/slot-choice.ts`. */
import { chooseSlot } from '../accounts/slot-choice.js';
import { loadSubwallets } from '../accounts/subwallet-record.js';
import { NETWORK } from 'midnight-identity/network';
import { fingerprintOf } from 'midnight-identity/recovery/pieces';
import { toBase64Url } from 'midnight-identity/passkey/bytes';
import { rowsFor } from './approve-rows.js';
import { isPayingAsk } from './approve-slot.js';
import type { ApproveInputs } from './approve-inputs.js';

export function useApproveState(a: ApproveInputs) {
  const { identity, secret, port, view, now, embedder } = a;
  /*
   * **EVERY PRESS THAT SENDS SOMETHING IS GATED ON WHAT CAN BE SEEN.** In a
   * window of its own this is always yes. In a frame it is the visibility guard:
   * a press on a wallet shown too small, on a hidden tab, or on a request that
   * has only just appeared is refused, on the button, with the reason beside it. What is measured is the
   * frame's size, whether the tab is showing, and how long this request has been
   * on screen; what is NOT measured is anything the page around draws over the
   * frame, fades it with, or moves it by - `framing.ts` says why. A disabled
   * button fires no press in React, by click or by key.
   */
  const framing = useMemo(
    () => framingOf(view ?? (window as unknown as ChannelWindow), embedder), [view, embedder]);
  const [channelState, setChannelState] = useState<ChannelState>({ of: 'waiting' });
  const [channel, setChannel] = useState<ActingChannel | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [subwallet, setSubwallet] = useState<number>(() => loadSubwallets(secret).lastUsed);
  /**
   * **WHETHER THE PERSON HAS TOUCHED THE PICKER.**
   *
   * The offered wallet is a DEFAULT, and a default that overwrites a deliberate
   * choice is not one. This is the only thing that stops the effect below
   * putting the fresh slot back after somebody has picked a used one on
   * purpose — which the scope says they are entitled to do.
   */
  const [choseWallet, setChoseWallet] = useState(false);
  const [picked, setPicked] = useState<Record<string, string>>({});
  /**
   * **A DERIVED ROW IS DECLINED HERE AND NOT IN `picked`.**
   *
   * `picked` maps an attribute to the id of a `Held` record, and a derived
   * value has none: there is nothing held. Putting a sentinel id in there would
   * be a value that looks like a record id and is not one, which is exactly the
   * shape every owner-line rule in this project is about. So the two questions
   * are two states — *which held value* and *is this computed one refused* —
   * and neither can be mistaken for the other.
   */
  const [refused, setRefused] = useState<Record<string, true>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  /* The company the keyring answer carried, as that answer carried it: the label is the wallet's own draw when the
   * page is setting a company up, so this is the only place the person can read it. */
  const [givenCompany, setGivenCompany] = useState<{ readonly company: CompanyLabel; readonly account: AccountAddress | null } | null>(null);
  /** This wallet, by the fingerprint of the secret that is answering - not by the slot it sits in. */
  const thisWallet = useMemo(() => toBase64Url(fingerprintOf(secret)), [secret]);

  /* Read through a ref so that the store can never restart the conversation below. */
  const portNow = useRef(port);
  portNow.current = port;
  useEffect(() => {
    const target = view ?? (window as unknown as ChannelWindow);
    /* What arrived and what was sent is written down, so a wait that never ended can be told apart later. */
    const opened2 = listen(target, now, (state) => {
      recordChannelState(portNow.current, state, now());
      setChannelState(state);
    }, embedder);
    /* Every message this window sends the page is checked first for a secret of the saved keys it opened. */
    setChannel(checkedChannel(opened2));
    return () => opened2.stop();
  }, [view, now, embedder]);
  /* A request to pay, and only that, has every message it sends written down too. */
  const payingChannel = useMemo(
    () => (channel === null ? null : recordedChannel(channel, portNow.current, now)), [channel, now]);
  /* A request to pay holds the wallet it is being paid from while a press runs and once it is answered. */
  const [walletLocked, setWalletLocked] = useState(false);

  useEffect(() => {
    let alive = true;
    void load(port, identity).then((state) => {
      if (!alive) return;
      setOpened(state);
      setProfile(state.of === 'profile' ? state.profile : emptyProfile(now()));
    });
    return () => { alive = false; };
  }, [identity, port, now]);
  return { framing, channelState, setChannelState, channel, profile, setProfile, opened, subwallet, setSubwallet, choseWallet, setChoseWallet, picked, setPicked, refused, setRefused, typed, setTyped, problem, setProblem, sentAt, setSentAt, givenCompany, setGivenCompany, thisWallet, portNow, payingChannel, walletLocked, setWalletLocked };
}
export type ApproveState = ReturnType<typeof useApproveState>;

export function useWhatIsAsked(a: ApproveInputs & ApproveState) {
  const { identity, secret, registry, readLabel, framing, channelState, profile, subwallet, setSubwallet, choseWallet, setPicked } = a;
  const request: Ask | null = channelState.of === 'request' ? channelState.request : null;
  /*
   * **THE COMPANY AN UNLOCK OR A KEYRING ASK NAMES, READ OFF ITS ACCOUNT BY
   * THIS WALLET** (`company-on-chain.tsx`). A key for a company is given only
   * once the account the page names has been read and carries the label the
   * page names. An ask to start a company names neither, and reads nothing.
   */
  const labelAsked = request !== null && (request.kind === 'unlock' || request.kind === 'keyring')
    ? request.company : null;
  const accountAsked = request !== null && (request.kind === 'unlock' || request.kind === 'keyring')
    ? request.account : null;
  const companyCheck = useCompanyCheck(labelAsked, accountAsked, readLabel);
  const companyOnChain = accountCarriesTheLabel(companyCheck, labelAsked);
  /* A company named beside opening the saved keys: once the check has read, the keys open, with its key only if it carries. */
  const openedCompanyRead = request !== null && request.kind === 'keyring' && request.companyIfOnChain === true
    && companyCheck.of !== 'checking';
  /* The dwell is timed from the moment THIS request is on screen, not from when
   * the screen mounted: a page that holds its request back until the wait has
   * run out would otherwise put a pressable button up the instant it arrives. */
  const consent = useConsent(framing, request);
  /* A SIGN-IN HAS NO ROWS BECAUSE ITS TYPE HAS NO `wants`, not because this
   * filtered an empty list out of one. `request.ts` is where that is decided.
   *
   * **AND A JOIN HAS ROWS FOR THE SAME REASON, WHICH IS WHY THIS IS NOW
   * A TEST ON THE TYPE AND NOT ON ONE KIND'S NAME.** `Wanting` is the two kinds
   * that carry `wants`; everything below reads this and not `request.kind`, so
   * a join walks the disclosure's own path through the rows, the pre-tick, the
   * missing-required line and the render rather than a copy of it. */
  const wanting: Wanting | null = request !== null
    && (request.kind === 'disclosure' || request.kind === 'join') ? request : null;
  /**
   * **THE CHOSEN WALLET, AS ONE VALUE, DERIVED ONCE PER CHOICE.**
   *
   * Every derived row on this screen comes out of this object, so changing the
   * picker changes every address shown and every address sent, together. There
   * is no path where the row says one slot and the signature names another.
   */
  const owned = useMemo(
    () => ownedAddressFor(identity, subwallet, loadSubwallets(secret).names, NETWORK),
    [identity, subwallet, secret]);

  const rows = useMemo(
    () => (wanting === null || profile === null
      ? [] : rowsFor(wanting, registry, profile, owned)),
    [wanting, profile, registry, owned]);

  /**
   * **THE WALLET THIS SCREEN OPENS ON, AND THE WHOLE RULE.**
   * `../accounts/slot-choice.ts` decides it; this is only where it is applied.
   *
   * It runs when the ask and the profile are both here, because the answer
   * depends on WHO is asking — a company that already has a slot keeps it, and
   * anybody new is offered one no site has used. **It never runs again once the
   * person has touched the picker**, which is what makes it a default rather
   * than a refusal.
   *
   * **IT NEVER RUNS FOR AN ASK THAT PAYS**, which pays from the account picked
   * in the window before the passkey (`paying-pick.ts`) and reads nothing here.
   */
  useEffect(() => {
    if (choseWallet || request === null || profile === null || isPayingAsk(request)) return;
    setSubwallet(chooseSlot(profile, request.requester.origin).account);
  }, [choseWallet, request, profile]);

  /* A REMEMBERED GRANT PRE-TICKS AND NEVER SKIPS. §6. */
  useEffect(() => {
    if (wanting === null || request === null || profile === null) return;
    const grant = profile.grants.find(
      (g) => g.recipient.origin === request.requester.origin && g.subwallet === subwallet);
    if (!grant) return;
    const pre: Record<string, string> = {};
    for (const row of rows) {
      const match = row.options.find((held) => grant.values.includes(held.id));
      if (match) pre[row.attribute] = match.id;
    }
    setPicked((current) => ({ ...pre, ...current }));
  }, [wanting, request, profile, subwallet, rows]);
  return { request, companyCheck, companyOnChain, openedCompanyRead, consent, wanting, owned, rows };
}
export type WhatIsAsked = ReturnType<typeof useWhatIsAsked>;

export function useRowEntry(a: ApproveInputs & ApproveState & WhatIsAsked) {
  const { identity, registry, port, now, profile, setProfile, picked, setPicked, refused, setTyped, setProblem, rows } = a;
  const fill = useCallback((definition: AttributeDefinition, text: string): void => {
    if (profile === null) return;
    const outcome = check(definition, text);
    if (!outcome.ok) { setProblem(outcome.says); return; }
    try {
      const next = selfAssert(profile, registry, definition.name, text, '', now());
      const added = next.held[next.held.length - 1]!;
      setProfile(next);
      setPicked((current) => ({ ...current, [definition.name]: added.id }));
      setTyped((current) => ({ ...current, [definition.name]: '' }));
      setProblem(null);
      void save(port, identity, next).catch(() => setProblem('That could not be saved.'));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That could not be added.');
    }
  }, [profile, registry, port, identity, now]);

  /*
   * A derived row is missing when it was refused or could not be worked
   * out, and never because nothing was picked: there is no list to pick from.
   */
  const missingRequired = rows.filter((row) => row.required && (
    row.derived !== null
      ? !(row.derived.ok && refused[row.attribute] !== true)
      : picked[row.attribute] === undefined));
  return { fill, missingRequired };
}
export type RowEntry = ReturnType<typeof useRowEntry>;

export function useWalletRecord(a: ApproveInputs & ApproveState) {
  const { profile } = a;
  /*
   * THIS WALLET'S OWN RECORD OF THE LABELS IT DREW, for an action: read from the
   * record as it stands when asked. The account a company is pinned to is not
   * here: it is kept in the person's saved keys, which the action opens.
   */
  const profileNow = useRef(profile);
  profileNow.current = profile;
  const walletRecord = useMemo((): WalletRecord => ({
    drewTheLabel: (label) => {
      const p = profileNow.current;
      const company = readCompanyLabel(label);
      return p !== null && company !== null && drewTheLabelFor(p, company);
    },
  }), []);
  return { walletRecord };
}
export type WalletKept = ReturnType<typeof useWalletRecord>;
