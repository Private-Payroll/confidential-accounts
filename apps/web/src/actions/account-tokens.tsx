import { useEffect, useRef, useState } from 'react';
import { Wallet01Icon } from '@hugeicons/core-free-icons';
import {
  Alert, AlertDescription, AlertTitle, AMOUNT_KIND, Amount, Button, EmptyState, formatTimeAgo, Item, ItemContent, ItemTitle, RadioGroup, RadioGroupItem, Section, Spinner,
  useLanguage, useText,
} from 'vaults-ui';
import { ActRefused } from '../act-refused.js';
import {
  ACCOUNT_BALANCES, askForAccountBalances, SIDE, VISIBILITY, type AccountBalances, type SideHeld, type TokenHeld,
} from '../adapters/account-balances.js';
import { ACT_REFUSAL, type ActRefusal } from '../adapters/refusals.js';


/** The row a caller gets back when it lets the person choose: the side the token is held on, and the token. */
export interface TokenChosen {
  readonly side: TokenHeld['visibility'];
  readonly token: TokenHeld;
}

/**
 * A WALLET WINDOW, NAMED BEFORE IT OPENS: what it is for, and the button to press in the wallet. The account's tokens
 * use it here; the Deposit panel uses it for the Pay window and the company-records window, so a person is told the
 * same way before each window opens.
 */
export function WalletWindowNamed({ what, press }: { what: string; press: string }) {
  const t = useText();
  return <p className="text-sm text-muted-foreground" data-wallet-window-named>{t('walletWindow.named', { what, press })}</p>;
}


/** The refusals whose words already say what happened, whatever was being asked; every other refusal is said here, for a read that pays nothing. */
const SAID_ANYWHERE: readonly ActRefusal[] = [
  ACT_REFUSAL.notSetUp, ACT_REFUSAL.notSignedIn, ACT_REFUSAL.anotherPerson, ACT_REFUSAL.declined, ACT_REFUSAL.gaveUp,
];

function Refused({ why }: { why: ActRefusal }) {
  const t = useText();
  if (SAID_ANYWHERE.includes(why)) return <ActRefused why={why} />;
  return (
    <Alert data-refusal={why}>
      <AlertTitle>{t('act.refused.title')}</AlertTitle>
      <AlertDescription>{t('accountTokens.refused')}</AlertDescription>
    </Alert>
  );
}


const rowId = ({ visibility, code }: TokenHeld): string => visibility + code;

function TokenRow({ token, choosing }: { token: TokenHeld; choosing: boolean }) {
  const t = useText();
  const says = token.visibility === VISIBILITY.public
    ? t('accountTokens.chooseRow.public', { name: token.name })
    : t('accountTokens.chooseRow.private', { name: token.name });
  return (
    <Item variant="outline" size="sm" data-token-row={token.code} data-token-side={token.visibility}>
      {choosing ? <RadioGroupItem value={rowId(token)} aria-label={says} data-token-choice /> : null}
      <ItemContent><ItemTitle>{token.name}</ItemTitle></ItemContent>
      <ItemContent><Amount value={token.amount} kind={AMOUNT_KIND.held} /></ItemContent>
    </Item>
  );
}

function SideShown({ title, side, choosing }: { title: string; side: SideHeld; choosing: boolean }) {
  const t = useText();
  const language = useLanguage();
  const read = side.of === SIDE.read ? side : null;
  return (
    <Section
      list={false} box={false} title={title} count={read === null ? undefined : read.tokens.length}
      description={read === null ? undefined : t('accountTokens.readAt', { when: formatTimeAgo(new Date(read.at), new Date(), language) })}
      data-side-shown={read === null ? SIDE.notKnown : SIDE.read}
    >
      <div className="flex flex-col gap-2">
        {read === null ? <p className="text-sm text-muted-foreground" data-side-not-known>{t('accountTokens.notKnown')}</p> : (
          <>
            {read.tokens.length === 0 ? <div data-side-none><EmptyState icon={Wallet01Icon}>{t('accountTokens.none')}</EmptyState></div> : null}
            {read.tokens.map((token) => <TokenRow key={rowId(token)} token={token} choosing={choosing} />)}
            {read.cannotPutIn === 0 ? null : <p className="text-sm text-muted-foreground" data-cannot-put-in={read.cannotPutIn}>{t('accountTokens.cannotPutIn', { count: read.cannotPutIn })}</p>}
          </>
        )}
      </div>
    </Section>
  );
}


/**
 * THE ACCOUNT'S TOKENS, ASKED OF THE PERSON'S WALLET ON A PRESS. The account menu's Balances panel and the Deposit
 * panel both show this one component. Nothing is asked until the button is pressed; the answer lives in this view and
 * is dropped with it; a refresh asks again, and is named the same way before the wallet opens.
 *
 * `choose`, when given, makes each row selectable and hands back the row picked (its side and the token).
 * `onAnswered` is told each time a new answer replaces the last one, which drops the row picked from it.
 */
export function AccountTokens({ choose, onAnswered }: { choose?: (picked: TokenChosen) => void; onAnswered?: () => void }) {
  const t = useText();
  const [answer, setAnswer] = useState<AccountBalances | null>(null);
  const [asking, setAsking] = useState(false);
  const [picked, setPicked] = useState('');
  const going = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const ask = async (): Promise<void> => {
    if (going.current) return;
    going.current = true;
    setAsking(true);
    try {
      const got = await askForAccountBalances();
      if (!alive.current) return;
      setPicked('');
      setAnswer(got);
      onAnswered?.();
    } finally {
      going.current = false;
      if (alive.current) setAsking(false);
    }
  };

  const pick = (id: string): void => {
    setPicked(id);
    if (answer === null || answer.of !== ACCOUNT_BALANCES.read) return;
    for (const side of [answer.private, answer.public]) {
      const token = side.of === SIDE.read ? side.tokens.find((x) => rowId(x) === id) : undefined;
      if (token !== undefined) choose?.({ side: token.visibility, token });
    }
  };

  const asker = (
    <div className="flex flex-col items-start gap-2" data-account-tokens-ask>
      <WalletWindowNamed what={t('accountTokens.opens')} press={t('accountTokens.press')} />
      <Button
        variant={answer === null ? 'default' : 'outline'} size="sm" disabled={asking}
        onClick={() => { void ask(); }} data-action={answer === null ? 'show-account-tokens' : 'refresh-account-tokens'}
      >
        {asking ? <Spinner aria-label={t('accountTokens.waiting')} /> : null}
        {answer === null ? t('accountTokens.ask') : t('accountTokens.refresh')}
      </Button>
    </div>
  );

  if (answer === null) return <div className="flex flex-col gap-4" data-account-tokens="not-asked">{asker}</div>;
  if (answer.of === ACCOUNT_BALANCES.refused) {
    return <div className="flex flex-col gap-4" data-account-tokens="refused"><Refused why={answer.why} />{asker}</div>;
  }

  const choosing = choose !== undefined;
  const sides = (
    <div className="flex flex-col gap-4">
      <SideShown title={t('accountTokens.private')} side={answer.private} choosing={choosing} />
      <SideShown title={t('accountTokens.public')} side={answer.public} choosing={choosing} />
    </div>
  );
  return (
    <div className="flex flex-col gap-4" data-account-tokens="read">
      <div className="flex flex-col gap-1" data-account-address>
        <span className="text-sm text-muted-foreground" data-private-address-label>{t('accountTokens.privateAddress')}</span>
        <span className="break-all font-mono text-xs" data-private-address>{answer.privateAddress}</span>
      </div>
      {choosing ? <RadioGroup value={picked} onValueChange={pick} aria-label={t('accountTokens.choose')}>{sides}</RadioGroup> : sides}
      {asker}
    </div>
  );
}
