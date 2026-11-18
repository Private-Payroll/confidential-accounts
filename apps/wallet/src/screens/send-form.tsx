import type { ReactNode } from 'react';
import { Button, Card, CardContent, Input, Label, Section } from 'vaults-ui';
import { Textarea } from 'vaults-ui/components/textarea';
import { NETWORK } from '../config.js';
import { exactStars } from '../chain/amount.js';
import type { Recipient } from '../chain/send.js';
import type { Parsed } from './send-hooks.js';
import { Refusal, kindWords } from './send-parts.js';

/** Who to pay and how much, with each field answered as it is typed. */
export function SendForm({
  recipientText, setRecipientText, recipientInfo, amountText, setAmountText, amountInfo, ready, begin,
}: {
  readonly recipientText: string;
  readonly setRecipientText: (text: string) => void;
  readonly recipientInfo: Parsed<Recipient> | null;
  readonly amountText: string;
  readonly setAmountText: (text: string) => void;
  readonly amountInfo: Parsed<bigint> | null;
  readonly ready: boolean;
  readonly begin: () => void;
}): ReactNode {
  return (
    <Section list={false} box={false} aria-label="Who, and how much" title="Who, and how much">
      <Card>
        <CardContent className="flex flex-col">
          <Label htmlFor="send-recipient" className="mb-2">The recipient&rsquo;s address</Label>
          <Textarea
            className="font-mono text-sm tracking-tight"
            id="send-recipient"

            aria-label="The recipient's address"
            value={recipientText}
            rows={3}
            spellCheck={false}
            aria-invalid={recipientInfo?.ok === false}
            placeholder={`mn_addr_${NETWORK}1… or mn_shield-addr_${NETWORK}1…`}
            onChange={(e) => setRecipientText(e.target.value)}
          />
          {recipientInfo?.ok === true && (
            <p className="m-0 mt-2 text-sm text-muted-foreground" role="status">
              This is {kindWords(recipientInfo.value)}.
            </p>
          )}
          {recipientInfo?.ok === false && <Refusal>{recipientInfo.error}</Refusal>}

          <Label htmlFor="send-amount" className="mb-2 mt-5">The amount, in tNIGHT</Label>
          <Input
            id="send-amount"
            aria-label="The amount, in tNIGHT"
            value={amountText}
            inputMode="decimal"
            aria-invalid={amountInfo?.ok === false}
            placeholder="0.000000"
            onChange={(e) => setAmountText(e.target.value)}
          />
          {amountInfo?.ok === true && (
            <p className="m-0 mt-2 text-sm text-muted-foreground" role="status">
              {/* §7.17: the number that will actually move, beside the typed
                * one, BEFORE anything is agreed to. */}
              Exactly {exactStars(amountInfo.value)} — the chain counts STARs, and
              this is the figure the transaction will carry.
            </p>
          )}
          {amountInfo?.ok === false && <Refusal>{amountInfo.error}</Refusal>}

          <div className="mt-5">
            <Button type="button" variant="default" disabled={!ready} onClick={begin}>
              Check this payment
            </Button>
          </div>
          <p className="m-0 mt-3 text-xs text-muted-foreground">
            Checking builds and balances the transaction so you can see what would
            actually happen — the fee, and the balance after. Nothing is sent until
            you agree on the next screen.
          </p>
        </CardContent>
      </Card>
    </Section>
  );
}
