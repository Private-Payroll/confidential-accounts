/*
 * The screen that asks whether a page may read the companies behind the keys this wallet saved under an account name: who is asking and who they say the person is, any new company or company key asked in the same answer, what is being agreed to, and what stops the press.
 */
import type { ReactNode } from 'react';
import { emptyProfile, originsFor } from 'midnight-identity/profile/model';
import { CompanyOnChain } from './company-on-chain.js';
import { seenElsewhere } from './approve-seen-elsewhere.js';
import { displayNameOf } from '../accounts/subwallets.js';
import { loadSubwallets } from '../accounts/storage.js';
import { Button, Section } from 'vaults-ui';
import { StatusAlert } from '../components/status.js';
import { whyNotThisWallet } from '../lib/signed-in-here.js';
import { FACT_TEXT, FINGERPRINT_TEXT } from './approve-text.js';
import { ConsentRefused } from './approve-consent-refused.js';
import type { AskedScreen } from './approve-shape.js';
import type { KeyringRequest } from 'midnight-identity/profile/request';

type Keyring = AskedScreen<KeyringRequest>;

function keyringWhoAsks(v: Keyring & { readonly holder: number | null }): ReactNode {
  const { secret, request, holder } = v;
  return (
    <Section
      list={false} box={false} aria-label="Who is asking, and who they say you are"
      title="Who is asking, and who they say you are"
      description="One of these your browser saw for itself. The other is what the page says."
    >
      <p className="m-0 text-sm text-muted-foreground">This page really came from</p>
      <p className={`m-0 font-mono break-all text-foreground ${FACT_TEXT}`} data-observed-origin>
        {request.requester.origin}
      </p>
      <p className="m-0 text-sm text-muted-foreground" style={{ marginTop: '0.75rem' }}>
        The wallet address the page says you signed in to it with
      </p>
      {request.signedInAs !== null ? (
        <>
          <p className={`m-0 font-mono break-all text-foreground ${FACT_TEXT}`} data-signed-in-as>
            {request.signedInAs}
          </p>
          {holder !== null && (
            <p className="m-0 text-sm text-muted-foreground" data-signed-in-holder>
              {`That is ${displayNameOf(holder, loadSubwallets(secret).names)}, in this wallet.`}
            </p>
          )}
        </>
      ) : (
        <p className="m-0 text-sm text-muted-foreground" data-signed-in-unknown>
          The page does not say. It may be a tab that did not sign you in itself, such as one
          you reloaded. Keys that are already saved there only open with the wallet that saved
          them; nothing new is saved from such a tab until it signs you in.
        </p>
      )}
      <p className="m-0 text-sm text-muted-foreground" style={{ marginTop: '0.75rem' }}>
        The account name the page gives you there
      </p>
      <p className={`m-0 font-mono break-all text-foreground ${FACT_TEXT}`} data-keyring-person>
        {request.person}
      </p>
      <p className="m-0 text-sm text-muted-foreground" data-keyring-person-unchecked>
        The key is made from this wallet and that name. Any page can give any name, and this
        wallet cannot check that it is yours - only show it to you.
      </p>
    </Section>
  );
}

function keyringNewCompany(v: Keyring): ReactNode {
  const { request, say } = v;
  return (
    <Section
      list={false} box={false} aria-label="And the keys to a new company"
      title="And the keys to a new company"
      description="The page is setting up a company, and you are its founding signer."
    >
      <p className="m-0 text-sm text-foreground" data-new-company>
        This wallet makes up the new company&rsquo;s label itself, when you press the button, makes your seat
        in it, signs the company&rsquo;s first roster and state with that seat and keeps the seat in your saved
        keys. The page gets the label and the signed records, never your seat&rsquo;s keys, and does not choose
        the label. Every other signer&rsquo;s wallet works out their own keys from the same label later.
      </p>
      {request.founding !== undefined && (
        <p className="m-0 text-sm text-foreground" data-shown-from="page" data-founding>
          {say('ask.keyring.founding', { name: request.founding.name, signer: request.founding.signer.name, role: request.founding.signer.role })}
        </p>
      )}
      <p className="m-0 text-sm text-muted-foreground" data-new-company-no-fingerprint>
        The company has no account on the chain yet, so there is no fingerprint to compare. Give the keys only
        if you are setting this company up yourself, on this page, now.
      </p>
      <p className="m-0 text-sm text-muted-foreground" data-committee-key-given>
        The answer also carries the public half of the key you will sit on the company&rsquo;s committee with, so
        the company can list it. The half that signs never leaves this wallet.
      </p>
    </Section>
  );
}

function keyringCompanyKey(v: Keyring): ReactNode {
  const { request, companyCheck } = v;
  return (
    request.company !== null && (
      <Section
        list={false} box={false} aria-label="And the key to one company's records"
        title="And the key to one company's records"
        description="Asked for in the same answer, so the page knows both came from one wallet."
      >
        <CompanyOnChain
          label={request.company} account={request.account} check={companyCheck}
          fingerprintClass={FINGERPRINT_TEXT}
          compareWith="the person who invited you to this company gave you themselves, and not through this page"
        />
        <p className="m-0 text-sm text-muted-foreground">
          That company&rsquo;s key is what your payslip key there is worked out from. This wallet
          cannot check that the company belongs to that page; it can only show you both.
        </p>
        <p className="m-0 text-sm text-muted-foreground" data-committee-key-given>
          The answer also carries the public half of the key you sit on that company&rsquo;s vault
          committee with, so the company can list it. The half that signs never leaves this wallet.
        </p>
      </Section>
    )
  );
}

function keyringSeenElsewhere(v: Keyring & { readonly elsewhere: readonly string[] }): ReactNode {
  const { request, companyOnChain, elsewhere } = v;
  return (
    elsewhere.length > 0 && request.company !== null && seenElsewhere({ company: request.company, account: request.account, asking: request.requester.origin, elsewhere, companyOnChain, withExplanation: false })
  );
}

function keyringAgreeing(v: Keyring): ReactNode {
  const { request } = v;
  return (
    <Section
      list={false} box={false} aria-label="What you are agreeing to"
      title="What you are agreeing to"
      description="Reading, for every company there. Your vote on payments stays in this wallet."
    >
      <p className="m-0 text-base text-foreground" data-keyring-question>
        {`Do you want ${request.requester.origin} to read the companies the keys this wallet saved under that account name hold?`}
      </p>
      <p className="m-0 text-sm text-muted-foreground" data-keyring-power>
        This wallet opens those keys itself and tells that page which companies you hold a seat on,
        with the keys that read each one's records - every company you belong to on that site, not
        only one. The keys that approve payments, and the key your saved keys open with, stay in this
        wallet. From the moment you press the button, whoever runs that page can read those records
        whenever it is open. This wallet cannot watch it happen and cannot tell you afterwards what was read.
      </p>
    </Section>
  );
}

function keyringHowLong(): ReactNode {
  return (
    <Section
      list={false} box={false} aria-label="How long they have it"
      title="How long they have it"
      description="The honest answer, which is not “until you say stop”."
    >
      <p className="m-0 text-sm text-muted-foreground">
        Their page holds what it is given while it is open. But nothing stops them keeping their own
        copy, and nothing here could tell. Treat what can be read as given for good.
      </p>
    </Section>
  );
}

function keyringWhichKeys(): ReactNode {
  return (
    <Section
      list={false} box={false} aria-label="Which keys this reads"
      title="Which keys this reads"
      description="Opened with this wallet and the account name above, not with the web address."
    >
      <p className="m-0 text-sm text-muted-foreground" data-keyring-whose>
        It reads whatever is saved under that account name by this wallet, wherever that is kept -
        which is why the page asking matters as much as the name. It reads the same on every device
        and again if you rebuild this wallet from its recovery pieces. Another wallet opens nothing
        this one saved.
      </p>
    </Section>
  );
}

export function keyringView(v: Keyring): ReactNode {
  const { port, now, setChannelState, channel, profile, problem, thisWallet, request, companyOnChain, openedCompanyRead, consent, addressesHeld, releaseKeyring, say, whoIsAsking } = v;
  const holder = request.signedInAs === null ? null : addressesHeld.get(request.signedInAs) ?? null;
  const notHeld = request.signedInAs !== null && holder === null;
  /* With no address named there is nothing to compare, and this browser's own
   * note of which wallet answered that page's last sign-in is what is left. */
  const notThisWallet = request.signedInAs === null
    ? whyNotThisWallet(port, request.requester.origin, thisWallet) : null;
  const elsewhere = request.company === null ? [] : originsFor(profile ?? emptyProfile(now()), request.company, request.account)
    .filter((origin) => origin !== request.requester.origin);

  return (
    <>
      {/* **THE HEADLINE IS BUILT FROM THE OBSERVED ORIGIN**, for the unlock's reason. */}
      <h1 data-headline>{`Let ${request.requester.origin} read your companies with the keys saved under the account name it gives`}</h1>

      {keyringWhoAsks({ ...v, holder })}

      {request.drawLabel && (
        keyringNewCompany(v)
      )}

      {request.companyIfOnChain === true && <p className="m-0 text-sm" data-also-company>{say('ask.keyring.also-company')}</p>}
      {keyringCompanyKey(v)}

      {whoIsAsking}

      {keyringSeenElsewhere({ ...v, elsewhere })}

      {/* **NOT "THE ABILITY TO READ".** The keys saved for a person hold the
        * secrets they approve payments with, for every company they belong to
        * on that site, and the screen says so. */}
      {keyringAgreeing(v)}

      {keyringHowLong()}

      {keyringWhichKeys()}

      {notHeld && (
        <StatusAlert tone="danger" title="None of this wallet's addresses is the one that page signed in with">
          <p className="m-0" data-not-signed-in-here>
            {`The page at ${request.requester.origin} says you signed in to it as an address no account in `}
            this wallet has, so this is not the wallet you signed in with. This wallet would not open
            what the wallet you signed in with saved there, and anything it saved there could only ever
            be opened by this one. Open the wallet you signed in with.
          </p>
          <p className="m-0">Nothing has been given.</p>
        </StatusAlert>
      )}

      {notThisWallet !== null && (
        <StatusAlert tone="danger" title="Another wallet answered this page's last sign-in">
          <p className="m-0" data-not-this-wallet>{notThisWallet}</p>
          <p className="m-0">Nothing has been given.</p>
        </StatusAlert>
      )}

      {problem !== null && (
        <StatusAlert tone="danger" title="Nothing has been given">
          <p className="m-0" data-keyring-problem>{problem}</p>
        </StatusAlert>
      )}

      <StatusAlert tone="warning" role={null} title="What is given, is given">
        <p className="m-0">
          You can refuse the next time they ask. That is the whole of what stopping means: whoever is
          behind that page keeps everything they have already opened and anything they copied while it
          was open, and nothing can take back what was read.
        </p>
      </StatusAlert>

      <div className="flex flex-wrap gap-2">
        <Button
          size="lg"
          type="button"
          variant="default"
          onClick={releaseKeyring}
          disabled={!consent.ok || notHeld || notThisWallet !== null || (request.company !== null && !companyOnChain && !openedCompanyRead)}
          data-approve
          data-keyring
        >
          {`Let ${request.requester.origin} read them`}
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
