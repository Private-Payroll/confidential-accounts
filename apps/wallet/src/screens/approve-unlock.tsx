/*
 * The screen that asks whether a page may open a company's records: who is asking and which company, what is being agreed to, how long the page keeps the key, and what stops the press.
 * It refuses the press when another wallet answered that page's last sign-in or the company's account has not been read.
 */
import type { ReactNode } from 'react';
import { emptyProfile, originsFor } from 'midnight-identity/profile/model';
import { CompanyOnChain } from './company-on-chain.js';
import { seenElsewhere } from './approve-seen-elsewhere.js';
import { Button, Section } from 'vaults-ui';
import { StatusAlert } from '../components/status.js';
import { whyNotThisWallet } from '../lib/signed-in-here.js';
import { FACT_TEXT, FINGERPRINT_TEXT } from './approve-text.js';
import { ConsentRefused } from './approve-consent-refused.js';
import type { AskedScreen } from './approve-shape.js';
import type { UnlockRequest } from 'midnight-identity/profile/request';

type Unlock = AskedScreen<UnlockRequest>;

export function unlockFacts(v: Unlock): ReactNode {
  const { request, companyCheck } = v;
  return (
    <Section
      list={false} box={false} aria-label="What is being opened, and who is asking"
      title="What is being opened, and who is asking"
      description="One of these your browser saw for itself. The other is what the page says."
    >
      <p className="m-0 text-sm text-muted-foreground">This page really came from</p>
      <p
        className={`m-0 font-mono break-all text-foreground ${FACT_TEXT}`}
        data-observed-origin
      >
        {request.requester.origin}
      </p>
      <p className="m-0 text-sm text-muted-foreground" style={{ marginTop: '0.75rem' }}>
        The company whose records it wants to open, as the page names it
      </p>
      {/*
        * **THE THING A PERSON CAN ACTUALLY COMPARE**, rendered twenty
        * characters wide from the company's label and its account together,
        * and only once this wallet has read the account and found the label
        * on it. `profile/fingerprint.ts` carries the arithmetic for the
        * width and the reason it covers both.
        */}
      <CompanyOnChain
        label={request.company} account={request.account} check={companyCheck}
        fingerprintClass={FINGERPRINT_TEXT}
        compareWith="the person who invited you to this company gave you themselves, and not through this page"
      />
      <p className="m-0 text-sm text-muted-foreground" style={{ marginTop: '0.75rem' }}>
        This wallet cannot check that the company belongs to the page asking. It can only
        show you both. If you do not recognise the company, do not give the key.
      </p>
    </Section>
  );
}

export function unlockAgreeing(v: Unlock): ReactNode {
  const { request } = v;
  return (
    <Section
      list={false} box={false} aria-label="What you are agreeing to"
      title="What you are agreeing to"
      description="This is not a fact about you. It is the ability to read."
    >
      <p className="m-0 text-base text-foreground" data-unlock-question>
        {`Do you want ${request.requester.origin} to be able to open the records this `}
        company keeps for you?
      </p>
      <p className="m-0 text-sm text-muted-foreground">
        {`From the moment you press the button, ${request.requester.origin} can open `}
        those records whenever their page is running. This wallet cannot watch it
        happen and cannot tell you afterwards how often it did.
      </p>
      <p className="m-0 text-sm text-muted-foreground" data-unlock-held-addresses>
        It also lets this page check whether a payslip was paid to one of your wallets. It
        does not tell the page any of your addresses.
      </p>
    </Section>
  );
}

function unlockHowLong(): ReactNode {
  return (
    <Section
      list={false} box={false} aria-label="How long they have it"
      title="How long they have it"
      description="The honest answer, which is not “until you say stop”."
    >
      <p className="m-0 text-sm text-muted-foreground">
        Their page holds the key while it is open, and this wallet never stores it. But
        nothing stops them keeping their own copy, and nothing here could tell. Treat
        this as given for good.
      </p>
    </Section>
  );
}

function unlockNotPerWallet(): ReactNode {
  return (
    <Section
      list={false} box={false} aria-label="It does not matter which of this wallet's addresses you use, or which page asked"
      title="It does not matter which of this wallet's addresses you use, or which page asked"
      description="The key belongs to the company and to this wallet, not to this website."
    >
      <p className="m-0 text-sm text-muted-foreground" data-not-per-wallet>
        This is one key, for this company and no other: no other company can be opened
        with it, and no other key of yours opens theirs. It is the same key on every
        device you sign in on, the same key again if you ever have to rebuild this
        wallet from your recovery pieces, and — this is the part that matters — the
        same key if you one day open these records somewhere that is not this website
        at all. That last one is what stops these records being ours rather than yours.
        It is made from this wallet, though: another wallet held in this browser gives a
        different key for the same company.
      </p>
    </Section>
  );
}

/**
 * An unlock is not a sign-in with a key attached. A sign-in and a disclosure end in a statement about the past that a
 * recipient can check; an unlock ends in something that keeps working: the site can read from now on, and nobody
 * can watch it or take it back. So the screen says what they will be able to do, for how long, and that it does not
 * come back, rather than how the key is made.
 * It has no wallet picker, on purpose. The key is a function of the account and the origin (`releaseFor`, in
 * `midnight-identity/profile/unlock`), not of a wallet slot, so a picker would claim a separation the mechanism does
 * not provide; the screen says the wallet does not matter and offers no control that implies it does.
 * There is no box to tick and no silent unlock: a release is one press, here or in the locked wallet's window, or it
 * does not happen. A site that could obtain a key without a person present could read a company whenever it liked.
 */
export function unlockView(v: Unlock): ReactNode {
  const { port, now, setChannelState, channel, profile, thisWallet, request, companyOnChain, consent, release, whoIsAsking } = v;
  /*
   * **WHERE ELSE THIS COMPANY'S KEY HAS ALREADY GONE.**
   *
   * A convenience and never an ingredient: `originsFor` reads the history and
   * nothing reads it back into a key. **An empty list is not a refusal** — a
   * company legitimately moves host, and that is the whole reason the key
   * stopped depending on one. Losing every row costs this warning and cannot
   * cost access.
   */
  const elsewhere = originsFor(profile ?? emptyProfile(now()), request.company, request.account)
    .filter((origin) => origin !== request.requester.origin);
  /* Read at render, from this browser's own record of which wallet signed in to this page. */
  const notThisWallet = whyNotThisWallet(port, request.requester.origin, thisWallet);

  return (
    <>
      {/*
        * **THE HEADLINE IS BUILT FROM THE OBSERVED ORIGIN.** It used
        * to be built from `request.requester.name` — the one field on the
        * whole ask that the ASKER chose — which is how a page served from
        * `payroll-b.example` came to sit under a wallet headline reading
        * *"Let Payroll A open your records"*. The name is still shown, in the
        * card below, labelled as what they call themselves.
        */}
      <h1 data-headline>{`Let ${request.requester.origin} open a company’s records`}</h1>

      {/*
        * **THE TWO FACTS, TOGETHER, AND NEITHER SMALLER THAN A NAME.**
        * One of them your browser observed; the other the
        * page claims, and the screen says which is which rather than
        * presenting both as though the wallet checked them.
        */}
      {unlockFacts(v)}

      {whoIsAsking}

      {elsewhere.length > 0 && (
        seenElsewhere({ company: request.company, account: request.account, asking: request.requester.origin, elsewhere, companyOnChain, withExplanation: true })
      )}

      {unlockAgreeing(v)}

      {unlockHowLong()}

      {/*
        * SAID BECAUSE IT IS TRUE AND BECAUSE IT IS THE REASON THIS IS SAFE
        * ENOUGH TO DO AT ALL. One key per site, and the same key for ever —
        * which is also why a recovery gets the records back.
        */}
      {unlockNotPerWallet()}

      {notThisWallet !== null && (
        <StatusAlert tone="danger" title="Another wallet answered this page's last sign-in">
          <p className="m-0" data-not-this-wallet>{notThisWallet}</p>
          <p className="m-0">No key has been given.</p>
        </StatusAlert>
      )}

      {/* §6 — NO REVOCATION LANGUAGE, ANYWHERE. */}
      <StatusAlert tone="warning" role={null} title="What is given, is given">
        <p className="m-0">
          You can refuse the next time they ask. That is the whole of what stopping
          means: whoever is behind that page keeps everything they have already opened
          and anything they copied while it was open, and nothing can take back a key.
        </p>
      </StatusAlert>

      <div className="flex flex-wrap gap-2">
        {/* THE BUTTON IS THE HEADLINE'S RULE AGAIN. The rule names the button
          * as well as the `<h1>`: a person who skims reads those two and
          * nothing else, so neither may be written in the asker's own words. */}
        {/* Disabled for a wallet that did not answer this page's last sign-in: a
          * disabled button fires no press in React, by click or by key, so this is
          * the gate and `release` has no second copy of it. */}
        <Button size="lg" type="button" variant="default" onClick={release} disabled={!consent.ok || notThisWallet !== null || !companyOnChain} data-approve data-unlock>
          {`Give ${request.requester.origin} the key`}
        </Button>
        <Button
          size="lg"
          type="button"
          variant="ghost"
          data-decline
          onClick={() => { channel?.refuse('declined'); setChannelState({ of: 'waiting' }); }}
        >
          Do not give a key
        </Button>
        <ConsentRefused consent={consent} />
      </div>
    </>
  );
}
