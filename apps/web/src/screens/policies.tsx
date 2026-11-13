import { useEffect, useId, useMemo, useState } from 'react';
import { Alert, AlertDescription, Amount, AMOUNT_KIND, Button, EmptyState, FieldDescription, FieldError, FieldLegend, FieldSet, Label, PageHeader, Section, useText } from 'vaults-ui';
import { PolicyIcon } from '@hugeicons/core-free-icons';
import {
  policyCurrencies, POLICIES_READ, POLICY_ACTED, POLICY_HELD, POLICY_PERIODS, POLICY_WHY, raisePolicy, raisePolicyBar, readHolders, readPolicies, whatAChangeCosts,
  type ChangeHolders, type PoliciesRead, type PolicyActed, type PolicyHeld, type PolicyTermsHeld, type PolicyWhy,
} from '../adapters/policy-acts.js';
import type { VaultRow } from '../adapters/company-records.js';
import { READ, type Read } from '../adapters/reads.js';
import { ACT_REFUSAL } from '../adapters/refusals.js';
import { watchPrivateMoneyReadable } from '../adapters/vault-private-money.js';
import { ActRefused } from '../act-refused.js';
import { AmountInput } from '../fields/form-fields.js';
import { useCompanyRecords } from '../records/company-records.js';
import { ActDone, ActOutcome, ActStopped, type ActPhase } from '../records/proposal-act.js';
import { ReadOf, WithRecords } from '../records/parts.js';
import { useSession } from '../session.js';
import { ChangeReview, REVIEW_OF, usePeriodSaid } from '../records/policy-review.js';
import { CHANGE_ASKED } from '../adapters/change-asked.js';

type Words = ReturnType<typeof useText>;

/** The marks the policy form's amount fields are found by, which tests read and a person never sees. */
const FIELD = { limit: 'limit', ceiling: 'ceiling' } as const;

const WHY_SAYS = (t: Words): Record<PolicyWhy, string> => ({
  [POLICY_WHY.seat]: t('policies.why.seat'), [POLICY_WHY.mayNotSet]: t('policies.why.may-not-set'),
  [POLICY_WHY.mayNotSetAfterFiling]: t('policies.why.may-not-set-after-filing'), [POLICY_WHY.mayNotSetAfterSending]: t('policies.why.may-not-set-after-sending'),
  [POLICY_WHY.seatNotInDirectory]: t('policies.why.seat-not-in-directory'), [POLICY_WHY.seatNotBelieved]: t('policies.why.seat-not-believed'),
  [POLICY_WHY.notAdopted]: t('policies.why.not-adopted'), [POLICY_WHY.notAPolicy]: t('policies.why.not-a-policy'), [POLICY_WHY.notACurrency]: t('policies.why.not-a-currency'),
  [POLICY_WHY.notABar]: t('policies.why.not-a-bar'), [POLICY_WHY.tooMany]: t('policies.why.too-many'), [POLICY_WHY.refused]: t('policies.why.refused'),
  [POLICY_WHY.notRaised]: t('policies.why.not-raised'), [POLICY_WHY.mayBeSent]: t('policies.why.may-be-sent'), [POLICY_WHY.raisedNotRead]: t('policies.why.raised-not-read'),
  [POLICY_WHY.notApproved]: t('policies.why.not-approved'), [POLICY_WHY.notCarried]: t('policies.why.not-carried'), [POLICY_WHY.withdrawn]: t('policies.why.withdrawn'),
  [POLICY_WHY.carriedOut]: t('policies.why.carried-out'), [POLICY_WHY.alreadyCounted]: t('policies.why.already-counted'), [POLICY_WHY.outrun]: t('policies.why.outrun'),
  [POLICY_WHY.notAsShown]: t('policies.why.not-as-shown'), [POLICY_WHY.stopped]: t('policies.why.stopped'), [POLICY_WHY.other]: t('policies.why.other'),
});

/** The whole page: each adopted vault's spending policies, and the bar every policy change needs. */
export function Policies() {
  const t = useText();
  return (
    <div className="flex flex-col gap-6" data-screen="policies">
      <PageHeader title={t('page.policies.name')} description={t('policies.intro')} />
      <WithRecords>{(records) => <PoliciesOf vaults={records.vaults} company={records.id} />}</WithRecords>
    </div>
  );
}


function PoliciesOf({ vaults, company }: { vaults: Read<readonly VaultRow[]>; company: string }) {
  const t = useText();
  const { person } = useSession();
  const { openKeys } = useCompanyRecords();
  const [reads, setReads] = useState(0);
  const [policies, setPolicies] = useState<PoliciesRead | null>(null);
  const [holders, setHolders] = useState<Read<ChangeHolders> | null>(null);
  const [opening, setOpening] = useState(false);
  const adopted = useMemo(() => (vaults.of === READ.read ? vaults.value.filter((v) => v.adopted === true) : null), [vaults]);
  const all = vaults.of === READ.read ? vaults.value : [];

  useEffect(() => watchPrivateMoneyReadable(company, () => setReads((n) => n + 1)), [company]);

  useEffect(() => {
    if (adopted === null || adopted.length === 0) { setPolicies(null); return undefined; }
    let alive = true;
    setPolicies(null);
    void readPolicies(person.id, company, adopted.map((v) => v.vault)).then((read) => { if (alive) setPolicies(read); });
    return () => { alive = false; };
  }, [person.id, company, adopted, reads]);

  useEffect(() => {
    let alive = true;
    setHolders(null);
    void readHolders(person.id, company).then((read) => { if (alive) setHolders(read); });
    return () => { alive = false; };
  }, [person.id, company, reads]);

  const done = (): void => setReads((n) => n + 1);
  const open = async (): Promise<void> => { setOpening(true); await openKeys(); setOpening(false); setReads((n) => n + 1); };
  const numberOf = (vault: string): number | null => { const at = all.findIndex((v) => v.vault.toLowerCase() === vault.toLowerCase()); return at < 0 ? null : at + 1; };
  const known = holders?.of === READ.read ? holders.value : null;

  return (
    <>
      {policies?.of === POLICIES_READ.refused && policies.why === ACT_REFUSAL.noKeysHere ? (
        <Alert data-policies-no-keys>
          <AlertDescription>{t('policies.noKeys')}</AlertDescription>
          <div className="mt-2"><Button size="sm" variant="outline" disabled={opening} data-action="open-with-your-wallet" onClick={() => { void open(); }}>{t('policies.noKeys.open')}</Button></div>
        </Alert>
      ) : policies?.of === POLICIES_READ.refused ? <ActRefused why={policies.why} /> : null}
      <ReadOf read={vaults}>
        {(rows) => (adopted === null || adopted.length === 0
          ? <EmptyState icon={PolicyIcon}>{t('policies.noVaults')}</EmptyState>
          : adopted.map((v) => (
            <VaultPolicies key={v.vault} vault={v} number={numberOf(v.vault) ?? rows.length} read={policies} holders={known} onDone={done} />
          )))}
      </ReadOf>
      <PolicyBar holders={known} unread={holders?.of === READ.unreadable} vaultCalled={(v) => { const n = numberOf(v); return n === null ? null : t('vaults.tile.name', { number: n }); }} onDone={done} />
    </>
  );
}


type Editing = { readonly token: string; readonly current: PolicyTermsHeld | null };

function VaultPolicies({ vault, number, read, holders, onDone }: {
  vault: VaultRow; number: number; read: PoliciesRead | null; holders: ChangeHolders | null; onDone: () => void;
}) {
  const t = useText();
  const [editing, setEditing] = useState<Editing | null>(null);
  const rows = read?.of === POLICIES_READ.read ? read.held.filter((h) => h.vault === vault.vault.toLowerCase()) : null;
  const shown = rows === null ? null : rows.filter((h) => h.of === POLICY_HELD.set || h.of === POLICY_HELD.unread);
  const currencies = policyCurrencies();
  return (
    <Section title={t('vaults.tile.name', { number })} list={false} data-vault={vault.vault}>
      {read === null ? <p className="text-sm text-muted-foreground" role="status" data-policies-reading>{t('policies.reading')}</p>
        : shown === null ? null
          : shown.length === 0 ? <p className="text-sm" data-no-policy>{t('policies.vault.unset')}</p>
            : shown.map((h) => (
              <HeldPolicy key={h.token} held={h} symbol={currencies.find((c) => c.code === h.token)?.symbol ?? ''} onEdit={(current) => setEditing({ token: h.token, current })} />
            ))}
      {read?.of !== POLICIES_READ.read || editing !== null ? null
        : <div><Button size="sm" variant="outline" data-action="set-policy" onClick={() => setEditing({ token: currencies[0]?.code ?? '', current: null })}>{t('policies.set')}</Button></div>}
      {editing === null ? null : (
        <PolicyForm
          key={editing.token} vault={vault.vault} editing={editing} holders={holders} currencies={currencies}
          vaultCalled={(v) => (v.toLowerCase() === vault.vault.toLowerCase() ? t('vaults.tile.name', { number }) : null)}
          onClose={() => setEditing(null)} onChanged={onDone}
        />
      )}
    </Section>
  );
}


function HeldPolicy({ held, symbol, onEdit }: { held: PolicyHeld; symbol: string; onEdit: (current: PolicyTermsHeld | null) => void }) {
  const t = useText();
  const said = usePeriodSaid();
  if (held.of !== POLICY_HELD.set) return <p className="text-sm" data-policy={held.token} data-unread>{t('policies.held.unread', { symbol })}</p>;
  const { terms } = held;
  return (
    <div className="flex flex-col gap-2 text-sm" data-policy={held.token}>
      <p className="font-medium">{t('policies.held.heading', { symbol })}</p>
      <div className="flex flex-col gap-1">
        {terms.bands.map((b, i) => (
          <p key={i} className="flex flex-wrap items-center gap-1.5" data-band={i + 1}>
            <span>{t('policies.band.label', { n: i + 1 })}</span><Amount value={b.ceiling} kind={AMOUNT_KIND.toBePaid} />
            <span>{t('policies.band.approvals', { count: b.approvals })}</span>
          </p>
        ))}
      </div>
      <p className="flex flex-wrap items-center gap-1.5"><span>{t('policies.held.limit')}</span><Amount value={terms.limit} kind={AMOUNT_KIND.toBePaid} /></p>
      <p data-period-says>{t('policies.held.period', { period: said(terms.periodLength) })}</p>
      <div><Button size="sm" variant="outline" data-action="edit-policy" onClick={() => onEdit(terms)}>{t('policies.edit')}</Button></div>
    </div>
  );
}


/** What came of an ask of the wallet, in the words of this page. */
function Says({ phase, result }: { phase: ActPhase; result: PolicyActed | null }) {
  const t = useText();
  const ended = result?.of === POLICY_ACTED.done ? result : null;
  const stopped = result?.of === POLICY_ACTED.stopped ? result : null;
  const problem = result?.of === POLICY_ACTED.problem ? result : null;
  const problemSays = (said: string): string => {
    switch (said) {
      case 'not-a-policy': return t('policies.problem.not-a-policy');
      case 'not-whole': return t('policies.problem.not-whole');
      case 'same': return t('policies.problem.same');
      case 'unread': return t('policies.problem.unread');
      default: return t('policies.problem.too-high', { count: problem?.most ?? 0 });
    }
  };
  return (
    <ActOutcome phase={phase} refused={result?.of === POLICY_ACTED.refused ? result.why : null}>
      {problem === null ? null : <FieldError data-problem={problem.problem}>{problemSays(problem.problem)}</FieldError>}
      {ended === null ? null : (
        <ActDone data-acted>
          {ended.state === 'carried-out' ? t('policies.done.carried') : t('policies.done.waiting', { page: t('page.proposals.name') })}
          {ended.approvals !== null && ended.needed !== null ? <> {t('proposal.act.counted', { approvals: ended.approvals, needed: ended.needed })}</> : null}
        </ActDone>
      )}
      {stopped === null ? null : (
        <ActStopped calm={stopped.partial || stopped.handedOver} data-policy-stopped={stopped.why}>
          <AlertDescription>{WHY_SAYS(t)[stopped.why]}</AlertDescription>
          {stopped.partial ? <AlertDescription data-partial>{t('signers.partial')}</AlertDescription> : null}
        </ActStopped>
      )}
    </ActOutcome>
  );
}

const worked = (ended: PolicyActed): boolean => ended.of === POLICY_ACTED.done || (ended.of === POLICY_ACTED.stopped && (ended.partial || ended.handedOver));

const FIRST_BANDS = [{ ceiling: '', approvals: 1 }, { ceiling: '', approvals: 1 }, { ceiling: '', approvals: 1 }, { ceiling: '', approvals: 1 }];


function PolicyForm({ vault, editing, holders, currencies, vaultCalled, onClose, onChanged }: {
  vault: string; editing: Editing; holders: ChangeHolders | null; currencies: ReturnType<typeof policyCurrencies>;
  vaultCalled: (vault: string) => string | null; onClose: () => void; onChanged: () => void;
}) {
  const t = useText();
  const said = usePeriodSaid();
  const { person, company } = useSession();
  const limitId = useId();
  const [token, setToken] = useState(editing.token);
  const [bands, setBands] = useState(() => (editing.current === null ? FIRST_BANDS : editing.current.bands.map((b) => ({ ceiling: b.ceilingText, approvals: b.approvals }))));
  const [limit, setLimit] = useState(editing.current?.limitText ?? '');
  const [period, setPeriod] = useState(editing.current?.periodLength ?? POLICY_PERIODS[0].seconds);
  const [reviewing, setReviewing] = useState(false);
  const [phase, setPhase] = useState<ActPhase>(null);
  const [result, setResult] = useState<PolicyActed | null>(null);
  const busy = phase !== null;
  const options = Array.from({ length: holders?.seated ?? 0 }, (_, i) => i + 1);
  const lengths = [...POLICY_PERIODS.map((p) => p.seconds), ...(editing.current === null || POLICY_PERIODS.some((p) => p.seconds === editing.current?.periodLength) ? [] : [editing.current.periodLength])];
  const changed = (): void => { setReviewing(false); setResult(null); };
  const cost = holders === null ? null : whatAChangeCosts(holders, { kind: CHANGE_ASKED.spendingPolicy, vault, bands: bands.map((b) => ({ approvals: b.approvals })) });

  const save = async (): Promise<void> => {
    if (company === null || busy) return;
    setResult(null);
    setPhase({ step: 0, steps: 0 });
    const ended = await raisePolicy(person.id, company, { vault, token, limit, periodLength: period, bands, current: editing.current }, (step, steps) => setPhase({ step, steps }));
    setPhase(null);
    setResult(ended);
    if (worked(ended)) onChanged();
  };

  return (
    <form className="flex flex-col gap-4 text-sm" data-policy-form={token} onSubmit={(e) => { e.preventDefault(); setReviewing(true); }}>
      <FieldSet disabled={busy}>
        {editing.current !== null ? null : (
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('policies.form.currency')}>
            {currencies.map((c) => (
              <Button key={c.code} type="button" size="sm" variant={c.code === token ? 'default' : 'outline'} aria-pressed={c.code === token} data-currency={c.code}
                onClick={() => { setToken(c.code); changed(); }}>{c.symbol}</Button>
            ))}
          </div>
        )}
        {bands.map((b, i) => (
          <BandField key={i} n={i + 1} ceiling={b.ceiling} approvals={b.approvals} options={options} busy={busy}
            onCeiling={(entry) => { setBands(bands.map((x, at) => (at === i ? { ...x, ceiling: entry } : x))); changed(); }}
            onApprovals={(n) => { setBands(bands.map((x, at) => (at === i ? { ...x, approvals: n } : x))); changed(); }} />
        ))}
        <Label htmlFor={limitId}>{t('policies.form.limit')}</Label>
        <AmountInput id={limitId} field={FIELD.limit} value={limit} disabled={busy} onChange={(entry) => { setLimit(entry); changed(); }} />
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('policies.form.period')}>
          <span>{t('policies.form.period')}</span>
          {lengths.map((seconds, i) => (
            <Button key={i} type="button" size="sm" variant={seconds === period ? 'default' : 'outline'} aria-pressed={seconds === period} data-period-at={i}
              onClick={() => { setPeriod(seconds); changed(); }}>{said(seconds)}</Button>
          ))}
        </div>
      </FieldSet>
      {holders === null ? <FieldDescription data-form-unread>{t('policies.form.unread')}</FieldDescription> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || holders === null} data-action="review-policy">{t('policies.form.review')}</Button>
        <Button type="button" variant="ghost" disabled={busy} data-action="close-policy-form" onClick={onClose}>{t('policies.form.cancel')}</Button>
      </div>
      {!reviewing || holders === null || cost === null ? null : (
        <ChangeReview cost={cost} held={holders} kind={REVIEW_OF.policy} vaultCalled={vaultCalled} period={said(period)} busy={busy} onConfirm={() => { void save(); }} />
      )}
      <Says phase={phase} result={result} />
    </form>
  );
}


function BandField({ n, ceiling, approvals, options, busy, onCeiling, onApprovals }: {
  n: number; ceiling: string; approvals: number; options: readonly number[]; busy: boolean; onCeiling: (entry: string) => void; onApprovals: (n: number) => void;
}) {
  const t = useText();
  const id = useId();
  return (
    <div className="flex flex-col gap-2" data-band-field={n}>
      <FieldLegend variant="label">{t('policies.form.band', { n })}</FieldLegend>
      <Label htmlFor={id}>{t('policies.form.ceiling')}</Label>
      <AmountInput id={id} field={FIELD.ceiling} value={ceiling} disabled={busy} onChange={onCeiling} />
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('policies.form.approvals')}>
        <span>{t('policies.form.approvals')}</span>
        {options.map((o) => (
          <Button key={o} type="button" size="sm" variant={o === approvals ? 'default' : 'outline'} aria-pressed={o === approvals} data-approvals-band={n} data-approvals={o}
            onClick={() => onApprovals(o)}>{o}</Button>
        ))}
      </div>
    </div>
  );
}


function PolicyBar({ holders, unread, vaultCalled, onDone }: {
  holders: ChangeHolders | null; unread: boolean; vaultCalled: (vault: string) => string | null; onDone: () => void;
}) {
  const t = useText();
  const { person, company } = useSession();
  const [chosen, setChosen] = useState<number | null>(null);
  const [phase, setPhase] = useState<ActPhase>(null);
  const [result, setResult] = useState<PolicyActed | null>(null);
  const busy = phase !== null;
  const now = holders?.policyBar ?? null;
  const from = chosen ?? now ?? holders?.approvals ?? 1;
  const seated = holders?.seated ?? 0;
  const change = (to: number | null): void => { setChosen(to); setResult(null); };

  const save = async (): Promise<void> => {
    if (company === null || busy || chosen === null || holders === null) return;
    setResult(null);
    setPhase({ step: 0, steps: 0 });
    const ended = await raisePolicyBar(person.id, company, chosen, { policyBar: holders.policyBar, seated: holders.seated }, (step, steps) => setPhase({ step, steps }));
    setPhase(null);
    setResult(ended);
    if (worked(ended)) onDone();
  };

  return (
    <Section title={t('policies.bar.heading')} list={false} data-policy-bar>
      <p className="text-sm text-muted-foreground">{t('policies.bar.intro')}</p>
      {holders === null ? (unread ? <FieldError data-bar-unread>{t('policies.bar.unread')}</FieldError> : null) : (
        <>
          <p className="text-sm" data-bar-now>{now === null ? t('policies.bar.unset', { count: holders.approvals }) : t('policies.bar.current', { count: now })}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" disabled={busy || from <= 1} aria-label={t('policies.bar.fewer')} data-action="bar-fewer" onClick={() => change(Math.max(from - 1, 1))}>-</Button>
            <span className="min-w-32 text-center" data-bar-value>{t('policies.bar.value', { count: from })}</span>
            <Button type="button" size="sm" variant="outline" disabled={busy || from >= seated} aria-label={t('policies.bar.more')} data-action="bar-more" onClick={() => change(Math.min(from + 1, seated))}>+</Button>
            {chosen === null ? null : <Button type="button" size="sm" variant="ghost" disabled={busy} data-action="bar-keep" onClick={() => change(null)}>{t('policies.bar.keep')}</Button>}
          </div>
          <FieldDescription>{t('policies.bar.hint', { count: seated })}</FieldDescription>
          {chosen === null || chosen === now ? null : (
            <ChangeReview cost={whatAChangeCosts(holders, { kind: CHANGE_ASKED.policyBar, bar: chosen })} held={holders} kind={REVIEW_OF.bar} vaultCalled={vaultCalled} busy={busy} onConfirm={() => { void save(); }} />
          )}
        </>
      )}
      <Says phase={phase} result={result} />
    </Section>
  );
}
