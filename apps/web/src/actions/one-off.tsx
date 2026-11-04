import { useId, useState } from 'react';
import { Amount, AMOUNT_KIND, Button, Field, FieldError, FieldLabel, Input, Section, SectionRow, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, useText } from 'vaults-ui';
import {
  ONE_OFF_FIELD, ONE_OFF_NAME_MOST, ONE_OFF_PROBLEM, ONE_OFF_REASON_MOST, oneOffLeg, oneOffProblem, PROPOSAL_ACTED, raiseOneOff, runCurrencies, type OneOffDraft, type OneOffField, type OneOffProblem,
} from '../adapters/proposal-acts.js';
import { OPENED, READ } from '../adapters/reads.js';
import { payableVendors, type OneOffRow } from '../adapters/company-records.js';
import { ActedSays, useProposalAct } from '../records/proposal-act.js';
import { PanelFooter } from '../shell/right-panel.js';
import { useCompanyRecords } from '../records/company-records.js';
import { PublicFacts } from '../records/public-facts.js';
import { Approve } from './approve.js';

/** The payee select's choice for an address typed in, which no vendor entry can be called. */
const TYPED = '*';

/** The vault's name as the vaults list numbers it, or null when the vaults were not read or do not hold it. */
function useVaultName(vault: string): string | null {
  const t = useText();
  const { company } = useCompanyRecords();
  const vaults = company?.of === OPENED.open && company.vaults.of === READ.read ? company.vaults.value : null;
  const at = vaults === null ? -1 : vaults.findIndex((v) => v.vault.toLowerCase() === vault.toLowerCase());
  return at < 0 ? null : t('vaults.tile.name', { number: at + 1 });
}

/**
 * PAYING SOMEONE FROM A VAULT, in the shell's right-hand panel (which keeps the answer when the company's records are read again after
 * the wallet acts, as a result drawn on the page would not). With a `pay` it is the approval of a one-off payment the chain holds open,
 * or the paying of one it holds approved and shows not yet paid: what it pays and to whom, what making it public means, and the Approve
 * every proposal uses, which carries the payment out once the vault has the approvals it needs. Without one it raises a one-off payment from `vault`, or from the vault the person chooses
 * when none is given (the company's only vault is chosen for them): the payee is chosen from the vendor list (`vendor` presets it) or
 * typed as an address, and the amount, reason and currency are whatever the person types. The page refuses an amount or address
 * it cannot use in words before the wallet opens; the wallet checks everything again.
 */
export function OneOffPayment({ vault, symbol, vendor, pay }: { vault?: string; symbol?: string; vendor?: string; pay?: OneOffRow }) {
  if (pay !== undefined) return <Approving pay={pay} vault={vault ?? ''} />;
  return <Raise {...(vault === undefined ? {} : { vault })} {...(symbol === undefined ? {} : { symbol })} {...(vendor === undefined ? {} : { vendor })} />;
}

function Approving({ pay, vault }: { pay: OneOffRow; vault: string }) {
  const t = useText();
  const vaultName = useVaultName(vault) ?? t('oneOff.vault.unnamed');
  const approved = pay.proposal.status === 'approved';
  return (
    <div className="flex flex-col gap-4 text-sm" data-action="one-off-approve-panel" data-one-off={pay.id}>
      <Section title={approved ? t('oneOff.paying.title') : t('oneOff.pay.title')} empty={null} data-part="one-off-summary">
        <SectionRow data-fact="payee">{t('oneOff.pay.payee', { payee: pay.payee })}</SectionRow>
        <SectionRow data-fact="amount">{pay.amount === null ? t('records.unrecognisedOne') : <Amount value={pay.amount} kind={AMOUNT_KIND.toBePaid} />}</SectionRow>
        <SectionRow data-fact="reason">{t('oneOff.pay.reason', { reason: pay.reason })}</SectionRow>
        <SectionRow data-fact="approvals">{pay.needed === null ? t('oneOff.pay.approvalsUnknown', { approvals: pay.approvals }) : t('oneOff.pay.approvals', { approvals: pay.approvals, needed: pay.needed })}</SectionRow>
      </Section>
      {pay.leg === null ? null : <PublicFacts leg={pay.leg} vaultName={vaultName} payment />}
      <p className="text-muted-foreground" data-one-off-note>{approved ? t('oneOff.paying.walletNote') : t('oneOff.pay.walletNote')}</p>
      <Approve row={pay.proposal} />
    </div>
  );
}

function Raise({ vault: fixed, symbol, vendor: preset }: { vault?: string; symbol?: string; vendor?: string }) {
  const t = useText();
  const ids = { form: useId(), vault: useId(), payee: useId(), address: useId(), name: useId(), token: useId(), amount: useId(), reason: useId() };
  const { company } = useCompanyRecords();
  const act = useProposalAct();
  const currencies = runCurrencies();
  const open = company?.of === OPENED.open ? company : null;
  const vendorsRead = open?.vendorsBelief;
  const vendors = payableVendors(vendorsRead?.of === READ.read ? vendorsRead.value.rows : []);
  const [token, setToken] = useState(currencies.find((c) => c.symbol === symbol)?.code ?? currencies[0]?.code ?? '');
  const [amount, setAmount] = useState('');
  const vaultRows = open?.vaults.of === READ.read ? open.vaults.value : [];
  const [vaultChosen, setVaultChosen] = useState('');
  const vault = fixed ?? (vaultRows.some((v) => v.vault === vaultChosen) ? vaultChosen : vaultRows.length === 1 ? vaultRows[0]!.vault : '');
  const vaultName = useVaultName(vault) ?? t('oneOff.vault.unnamed');
  const [chosen, setChosen] = useState(preset ?? TYPED);
  const [typed, setTyped] = useState('');
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const vendor = vendors.find((v) => v.id === chosen) ?? null;
  const draft: OneOffDraft = { vault, token, amount, payee: vendor === null ? typed : vendor.address, payeeName: vendor === null ? name : vendor.name, reason, vendor: vendor?.id ?? null };
  const leg = oneOffLeg(draft);
  const wrong = tried ? oneOffProblem(draft) : null;
  const busy = act.phase !== null;
  const locked = busy || act.done;
  const problems: Record<OneOffProblem, string> = {
    [ONE_OFF_PROBLEM.noAsset]: t('oneOff.problem.no-asset'), [ONE_OFF_PROBLEM.noAmount]: t('oneOff.problem.no-amount'), [ONE_OFF_PROBLEM.badAmount]: t('oneOff.problem.bad-amount'),
    [ONE_OFF_PROBLEM.zeroAmount]: t('oneOff.problem.zero-amount'), [ONE_OFF_PROBLEM.tooManyDecimals]: t('oneOff.problem.too-many-decimals'),
    [ONE_OFF_PROBLEM.noAddress]: t('oneOff.problem.no-address'), [ONE_OFF_PROBLEM.badAddress]: t('oneOff.problem.bad-address'),
    [ONE_OFF_PROBLEM.noReason]: t('oneOff.problem.no-reason'), [ONE_OFF_PROBLEM.reasonTooLong]: t('oneOff.problem.reason-too-long', { count: ONE_OFF_REASON_MOST }),
    [ONE_OFF_PROBLEM.nameTooLong]: t('oneOff.problem.name-too-long', { count: ONE_OFF_NAME_MOST }), [ONE_OFF_PROBLEM.noVault]: t('oneOff.problem.no-vault'),
  };
  const says = (field: OneOffField): string | null => (wrong !== null && wrong.field === field ? problems[wrong.problem] : null);

  const raise = (): void => {
    if (locked) return;
    setTried(true);
    if (oneOffProblem(draft) !== null) return;
    act.start((personId, companyId, onStep) => raiseOneOff(personId, companyId, draft, onStep));
  };
  const state = act.result?.of === PROPOSAL_ACTED.done ? act.result.state : null;
  const done = state === 'paid' || state === 'already-paid' ? t('oneOff.done.paid') : t('oneOff.done.raised');

  return (
    <form id={ids.form} className="flex max-w-xl flex-col gap-4 text-sm" data-action="one-off-panel" onSubmit={(e) => { e.preventDefault(); raise(); }}>
      {fixed !== undefined ? <p data-one-off-from>{t('oneOff.from', { vault: vaultName })}</p> : (
        <Field data-invalid={says(ONE_OFF_FIELD.vault) !== null || undefined}>
          <FieldLabel htmlFor={ids.vault}>{t('oneOff.vault')}</FieldLabel>
          <Select value={vault} onValueChange={setVaultChosen} disabled={locked}>
            <SelectTrigger id={ids.vault} data-field="vault"><SelectValue placeholder={t('oneOff.vault.choose')} /></SelectTrigger>
            <SelectContent>{vaultRows.map((v, i) => <SelectItem key={v.vault} value={v.vault}>{t('vaults.tile.name', { number: i + 1 })}</SelectItem>)}</SelectContent>
          </Select>
          {says(ONE_OFF_FIELD.vault) === null ? null : <FieldError data-problem="vault">{says(ONE_OFF_FIELD.vault)}</FieldError>}
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor={ids.payee}>{t('oneOff.payee')}</FieldLabel>
        <Select value={vendor === null ? TYPED : chosen} onValueChange={setChosen} disabled={locked}>
          <SelectTrigger id={ids.payee} data-field="payee-choice"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={TYPED}>{t('oneOff.payee.typed')}</SelectItem>
            {vendors.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      {vendor === null ? (
        <>
          <Field data-invalid={says(ONE_OFF_FIELD.payee) !== null || undefined}>
            <FieldLabel htmlFor={ids.address}>{t('oneOff.address')}</FieldLabel>
            <Input id={ids.address} data-field="payee" value={typed} disabled={locked} aria-invalid={says(ONE_OFF_FIELD.payee) !== null} onChange={(e) => setTyped(e.target.value)} />
            {says(ONE_OFF_FIELD.payee) === null ? null : <FieldError data-problem="payee">{says(ONE_OFF_FIELD.payee)}</FieldError>}
          </Field>
          <Field data-invalid={says(ONE_OFF_FIELD.name) !== null || undefined}>
            <FieldLabel htmlFor={ids.name}>{t('oneOff.name')}</FieldLabel>
            <Input id={ids.name} data-field="payee-name" value={name} disabled={locked} onChange={(e) => setName(e.target.value)} />
            {says(ONE_OFF_FIELD.name) === null ? null : <FieldError data-problem="name">{says(ONE_OFF_FIELD.name)}</FieldError>}
          </Field>
        </>
      ) : <p className="break-all text-muted-foreground" data-one-off-vendor-address>{t('oneOff.vendor.address', { address: vendor.address })}</p>}
      <Field data-invalid={says(ONE_OFF_FIELD.amount) !== null || undefined}>
        <FieldLabel htmlFor={ids.amount}>{t('oneOff.amount')}</FieldLabel>
        <div className="flex gap-2">
          <Input id={ids.amount} data-field="amount" value={amount} disabled={locked} aria-invalid={says(ONE_OFF_FIELD.amount) !== null} onChange={(e) => setAmount(e.target.value)} />
          <Select value={token} onValueChange={setToken} disabled={locked}>
            <SelectTrigger id={ids.token} aria-label={t('invite.currency')} data-field="currency"><SelectValue /></SelectTrigger>
            <SelectContent>{currencies.map((c) => <SelectItem key={c.code} value={c.code}>{c.symbol}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {says(ONE_OFF_FIELD.amount) === null ? null : <FieldError data-problem="amount">{says(ONE_OFF_FIELD.amount)}</FieldError>}
      </Field>
      <Field data-invalid={says(ONE_OFF_FIELD.reason) !== null || undefined}>
        <FieldLabel htmlFor={ids.reason}>{t('oneOff.reason')}</FieldLabel>
        <Input id={ids.reason} data-field="reason" value={reason} disabled={locked} aria-invalid={says(ONE_OFF_FIELD.reason) !== null} onChange={(e) => setReason(e.target.value)} />
        {says(ONE_OFF_FIELD.reason) === null ? null : <FieldError data-problem="reason">{says(ONE_OFF_FIELD.reason)}</FieldError>}
      </Field>
      {leg === null ? null : <PublicFacts leg={leg} vaultName={vaultName} payment />}
      <p className="text-muted-foreground" data-one-off-note>{t('oneOff.walletNote')}</p>
      <PanelFooter>
        <div className="flex flex-col gap-4">
          <div>
            <Button type="submit" form={ids.form} disabled={locked} data-action="raise-one-off">{t('oneOff.raise')}</Button>
          </div>
          <ActedSays phase={act.phase} result={act.result} done={done} />
        </div>
      </PanelFooter>
    </form>
  );
}
