/*
 * Who is asking, and which of the person's wallets the answer is about.
 * The first names the page by what the browser saw and by what the page calls itself; the second offers the wallets and says why one is offered.
 */
import type { ReactNode } from 'react';
import type { Ask } from 'midnight-identity/profile/request';
import { unshieldedAddressFor } from '../chain/unshielded.js';
/* Which wallet a company is OFFERED, which is a rule and a default
 * rather than a refusal: `../accounts/slot-choice.ts`. */
import { alsoUsedBy, chooseSlot } from '../accounts/slot-choice.js';
import { WALLET_ACCOUNTS, displayNameOf } from '../accounts/subwallets.js';
import { loadSubwallets } from '../accounts/storage.js';
import { Card, CardContent, CardHeader, CardTitle, Label, Section } from 'vaults-ui';
import { StatusAlert } from '../components/status.js';
import { CLAIM_TEXT } from './approve-text.js';
import type { ScreenAsking } from './approve-shape.js';

/**
 * The page that asked never draws this screen: it is wallet chrome on the wallet's own origin, in a tab the page opened
 * but cannot reach into. The origin the browser observed is shown beside the name the page calls itself.
 * Everything the asking party supplies (its name, its `rdns`, its purpose, and each want's attribute and reason)
 * reaches the screen as a React text node and never as markup, so a company cannot style, order or word what
 * the person sees on the screen that approves it.
 */
export function askingParts(v: ScreenAsking<Ask>) {
  const { identity, secret, profile, subwallet, setSubwallet, choseWallet, setChoseWallet, request } = v;
  const names = loadSubwallets(secret).names;

  /*
   * WHO IS ASKING, AND WHERE THEY ACTUALLY CAME FROM. §5.3.
   * The name is what they call themselves. The origin is what the browser
   * saw, and the two are labelled differently on purpose — a name that
   * stood in for an identity is the owner-line rule.
   *
   * **ONE ELEMENT, RENDERED BY BOTH KINDS.** Two copies of this card
   * would be two places for the observed origin to stop being shown, and only
   * one of them would be the one a test happened to open.
   */
  const whoIsAsking = (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={3}>
          Who is asking
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="m-0">
          {'They call themselves '}
          <strong className={CLAIM_TEXT} data-requester-name>
            {request.requester.name}
          </strong>
          .
        </p>
        <p className="m-0">
          {'This page actually came from '}
          <strong className="font-mono" data-requester-origin>
            {request.requester.origin}
          </strong>
          {'. Your browser told this wallet that, not the request — anything that could '}
          name its own address could name somebody else&rsquo;s.
        </p>
        <p className="m-0 text-sm text-muted-foreground" data-purpose>
          {`Why they say they want it: ${request.purpose}`}
        </p>
      </CardContent>
    </Card>
  );

  /*
   * **BOTH KINDS ARE SIGNED BY A WALLET AND THE PERSON CHOOSES WHICH.** The
   * picker is one element rendered by both branches rather than two that have
   * to be kept saying the same thing; the sentence under it differs because
   * what the wallet is FOR differs, and that sentence is the only difference.
   */
  /*
   * **WHICH WALLET IS OFFERED, AND WHO ELSE ALREADY HAS IT.**
   *
   * Two sentences, and they are two different facts. The first says WHY this
   * one is proposed. The second appears only when the wallet in the box is one
   * another site already has, and it is the whole of what the rule asked for:
   * **an inconsistent warning teaches people that silence means it is fine**,
   * so this one says exactly what sharing costs and does not editorialise. It
   * never refuses — reusing an address costs linkability, and linkability is
   * the person's to spend.
   */
  const choice = profile === null ? null : chooseSlot(profile, request.requester.origin);
  const shared = profile === null ? [] : alsoUsedBy(profile, subwallet, request.requester.origin);

  const whyThisWallet = (): string => {
    if (choseWallet || choice === null) return '';
    if (choice.because === 'already-theirs') {
      return 'This is the wallet you used with them before, so what they already hold goes ' + 'on working.';
    }
    if (choice.because === 'unused') {
      return 'This one has not been given to anybody, which is why it is the one offered.';
    }
    return (
      'Every wallet here has already been given to somebody, so whichever you choose ' +
      'is one another site can recognise.'
    );
  };

  const whichWallet = (title: string, description: string, locked = false): ReactNode => (
    <Section list={false} box={false} aria-label={title} title={title} description={description}>
      <Label htmlFor="approve-subwallet" className="mb-2">
        Wallet
      </Label>
      <select
        id="approve-subwallet"
        value={String(subwallet)}
        disabled={locked}
        onChange={(e) => {
          setChoseWallet(true);
          setSubwallet(Number(e.target.value));
        }}
        className="block w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground"
      >
        {WALLET_ACCOUNTS.map((account) => (
          <option key={account} value={String(account)}>
            {displayNameOf(account, names)}
          </option>
        ))}
      </select>
      <p className="m-0 font-mono text-sm text-muted-foreground" data-address>
        {unshieldedAddressFor(identity, subwallet)}
      </p>
      {whyThisWallet() !== '' && (
        <p className="m-0 text-sm text-muted-foreground" data-why-wallet={choice?.because}>
          {whyThisWallet()}
        </p>
      )}
      {shared.length > 0 && (
        <StatusAlert tone="warning" title="Another site already has this wallet's address">
          <div data-wallet-shared>
            {/* EACH ONE ON ITS OWN LINE — the same rule as the unlock screen's
             * warning, and for the same reason: a value a person is being
             * asked to recognise, wrapped mid-string, is unreadable. */}
            {shared.map((origin) => (
              <p className="m-0 font-mono text-foreground" key={origin}>
                {origin}
              </p>
            ))}
          </div>
          <p className="m-0">
            If you use this wallet here too, both of them are paying the same address, and they could learn you work for
            both by comparing notes. That is sometimes exactly what you want. Choosing a different wallet above is what
            keeps them apart — and it keeps them apart from each other, not from us: it is one wallet signing in either
            way.
          </p>
        </StatusAlert>
      )}
    </Section>
  );
  return { whoIsAsking, whichWallet };
}
