import { useId } from 'react';
import {
  Button, Field, FieldError, FieldLabel, FieldLegend, FieldSet, Input, RadioGroup, RadioGroupItem, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, useText,
} from 'vaults-ui';
import { DECIMAL_KEYPAD, payAssets, TERMS, VENDOR_TERMS } from '../adapters/invite.js';

/*
 * THE FIELDS THE INVITE FORM AND THE PEOPLE AND VENDORS PANELS SHARE, each written once: an amount typed, an amount with its token, how a
 * vendor is paid, and a date set or taken off. They only draw and report what is typed; nothing here asks the wallet or reads a record, and
 * the names they take from the invite adapter are the ones it holds for the form (the keypad, the token list, the two kinds of terms).
 * A form that needs one imports it from here, never from another form's file, so a mistake is told beside the field it is about in every form.
 */

/** An amount typed, on the keypad a phone offers for decimals: the one field every form types an amount in. */
export function AmountInput({ id, field, value, disabled, invalid, onChange }: { id: string; field: string; value: string; disabled: boolean; invalid?: boolean; onChange: (entry: string) => void }) {
  return <Input id={id} data-field={field} inputMode={DECIMAL_KEYPAD} value={value} disabled={disabled} aria-invalid={invalid === true} onChange={(e) => onChange(e.target.value)} />;
}

/** An amount and the token it is in, with what is wrong with it told beside it. */
export function PayField({ idAsset, idAmount, asset, amount, locked, field, assetField, problem, fieldName, onAsset, onAmount }: {
  idAsset: string; idAmount: string; asset: string; amount: string; locked: boolean; field: string; assetField: string;
  problem: string | null; fieldName: string; onAsset: (code: string) => void; onAmount: (entry: string) => void;
}) {
  const t = useText();
  const assets = payAssets();
  return (
    <Field data-invalid={problem !== null || undefined}>
      <FieldLabel htmlFor={idAmount}>{fieldName}</FieldLabel>
      <div className="flex gap-2">
        <AmountInput id={idAmount} field={field} value={amount} disabled={locked} invalid={problem !== null} onChange={onAmount} />
        <Select value={asset} onValueChange={onAsset} disabled={locked}>
          <SelectTrigger id={idAsset} aria-label={t('invite.currency')} data-field={assetField}><SelectValue /></SelectTrigger>
          <SelectContent>{assets.map((a) => <SelectItem key={a.code} value={a.code}>{a.symbol}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {problem === null ? null : <FieldError data-problem={field}>{problem}</FieldError>}
    </Field>
  );
}

/** How a vendor is paid, one-off or the same amount monthly, and the monthly amount with its token when monthly is chosen. */
export function TermsChoice({ terms, onTerms, idAmount, idAsset, asset, amount, locked, amountField, assetField, problem, onAsset, onAmount }: {
  terms: string; onTerms: (terms: string) => void; idAmount: string; idAsset: string; asset: string; amount: string; locked: boolean; amountField: string; assetField: string;
  problem: string | null; onAsset: (code: string) => void; onAmount: (entry: string) => void;
}) {
  const t = useText();
  const says: Record<string, string> = { [TERMS.oneOff]: t('invite.terms.oneOff'), [TERMS.monthly]: t('invite.terms.monthly') };
  return (
    <>
      <FieldSet disabled={locked}>
        <FieldLegend variant="label">{t('invite.terms')}</FieldLegend>
        <RadioGroup value={terms} onValueChange={onTerms} data-field="terms">
          {VENDOR_TERMS.map((k) => (
            <Field key={k} orientation="horizontal">
              <RadioGroupItem value={k} id={idAmount + k} disabled={locked} data-terms={k} />
              <FieldLabel htmlFor={idAmount + k}>{says[k]}</FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      </FieldSet>
      {terms === TERMS.monthly ? (
        <PayField idAsset={idAsset} idAmount={idAmount} asset={asset} amount={amount} locked={locked} field={amountField} assetField={assetField} problem={problem}
          fieldName={t('invite.monthlyAmount')} onAsset={onAsset} onAmount={onAmount} />
      ) : null}
    </>
  );
}

/** One date typed as a calendar day, the field every date form of a person's or vendor's panel uses. */
export function DateField({ field, label, value, busy, onChange }: { field: string; label: string; value: string; busy: boolean; onChange: (day: string) => void }) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} type="date" data-field={field} value={value} disabled={busy} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/** The two dates a form sets or takes off, and the marks tests and styles find each form and its set and clear buttons by. */
export const DATE = { endDate: 'endDate', leavingDate: 'leavingDate' } as const;
const DAY_FORM = {
  [DATE.endDate]: { field: 'endDate', acts: ['set-endDate', 'clear-endDate'] },
  [DATE.leavingDate]: { field: 'leavingDate', acts: ['set-leavingDate', 'clear-leavingDate'] },
} as const;

/** A date set from a typed day or, when one is held, taken off: the end date of a person or a vendor, and a person's leaving date. */
export function DayForm({ which, label, value, busy, onChange, onSet, onClear, setWords, clearWords, canClear }: {
  which: keyof typeof DAY_FORM; label: string; value: string; busy: boolean; onChange: (day: string) => void; onSet: (e: { preventDefault: () => void }) => void; onClear: () => void;
  setWords: string; clearWords: string; canClear: boolean;
}) {
  const { field, acts } = DAY_FORM[which];
  return (
    <form className="flex flex-col gap-2" data-form={field} onSubmit={onSet}>
      <DateField field={field} label={label} value={value} busy={busy} onChange={onChange} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="outline" disabled={busy} data-action={acts[0]}>{setWords}</Button>
        {canClear ? <Button type="button" variant="outline" disabled={busy} onClick={onClear} data-action={acts[1]}>{clearWords}</Button> : null}
      </div>
    </form>
  );
}
