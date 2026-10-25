import { useEffect, useId, useRef, useState } from 'react';
import {
  Alert, AlertDescription, AlertTitle, Amount, AMOUNT_KIND, Button, formatDate, InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput,
  InputGroupText, Item, ItemContent, ItemDescription, ItemTitle, Label, Progress, Spinner, useLanguage, useText,
} from 'vaults-ui';
import { ActRefused } from '../act-refused.js';
import { useVaultActions } from '../records/vault-pending.js';
import {
  AMOUNT_REFUSAL, CHECKED, checkMyLastDeposit, companyKeyHeldHere, DEPOSIT_KIND, DEPOSIT_METHODS, DEPOSIT_STEP, DEPOSITED, depositNow, MAX, putAwayEndedDeposit,
  putMoneyIn, PUT_IN, usualSecondsOf, watchDeposit,
  type AmountRefusal, type DepositMethod, type DepositNow, type DepositStep, type LastDepositChecked,
} from '../adapters/deposit.js';
import { proofsRunning } from '../adapters/proofs-running.js';
import { ACT_REFUSAL, type ActRefusal } from '../adapters/refusals.js';
import { useSession } from '../session.js';
import { STEP, type StepProps } from '../setup/step-ids.js';
import { secondsSince, StageProgress, useTicker } from '../stage-progress.js';
import { AccountTokens, WalletWindowNamed, type TokenChosen } from './account-tokens.js';
import { PanelFooter } from '../shell/right-panel.js';


/**
 * THE DEPOSIT THE ADAPTER KEEPS FOR A VAULT IN THIS TAB, followed as it changes. A deposit lives in the adapter, not in
 * a panel: closing a panel or opening another never stops it, and every view of it reads the same one.
 */
function useDepositNow(vault: string): DepositNow | null {
  const [now, setNow] = useState<DepositNow | null>(() => depositNow(vault));
  useEffect(() => {
    setNow(depositNow(vault));
    return watchDeposit(vault, () => setNow(depositNow(vault)));
  }, [vault]);
  return now;
}


/** The finished deposits the page has been told of, so a page that is drawn again, or a second view of the same deposit, never tells it twice. */
const TOLD = new WeakSet<object>();


/** Tells `told` once for each deposit that finishes, however many views of it are drawn or drawn again, so the vault's balances are read again once. */
function useToldWhenDone(now: DepositNow | null, told: () => void): void {
  useEffect(() => {
    if (now?.of !== DEPOSITED.done || TOLD.has(now)) return;
    TOLD.add(now);
    told();
  }, [now]);
}


function useStepWords(): Record<DepositStep, string> {
  const t = useText();
  return {
    [DEPOSIT_STEP.checkingTheVault]: t('deposit.step.checkingTheVault'),
    [DEPOSIT_STEP.provingTheDeposit]: t('deposit.step.provingTheDeposit'),
    [DEPOSIT_STEP.payingInYourWallet]: t('deposit.step.payingInYourWallet'),
    [DEPOSIT_STEP.sending]: t('deposit.step.sending'),
    [DEPOSIT_STEP.waitingForTheChain]: t('deposit.step.waitingForTheChain'),
  };
}


/** The press the wallet's payment window offers, by how the money goes in. */
function usePayPress(kind: DepositNow['kind']): string {
  const t = useText();
  return kind === DEPOSIT_KIND.private ? t('deposit.payWindow.press.private') : t('deposit.payWindow.press.public');
}


/**
 * What opens the right-hand panel on this vault's deposit, on what checking its last deposit found, or on the naming of
 * the wallet window that check opens in a tab that holds no company key.
 */
function useOpenDeposit(company: string, vault: string): (from?: { checked?: LastDepositChecked | null; naming?: boolean }) => void {
  const t = useText();
  const { inPanel } = useVaultActions();
  return ({ checked = null, naming = false } = {}) => {
    inPanel(
      checked === null && !naming ? t('vault.deposit') : t('vault.checkLastDeposit'),
      (props) => <Deposit company={company} vault={vault} checked={checked} naming={naming} {...props} />,
    );
  };
}


/**
 * THE PRESS ON CHECK MY LAST DEPOSIT, written once for the vault page and the panel. It is taken once however often it
 * is pressed, and tells what it found only while the view that pressed it is still drawn. In a tab that holds no
 * company key the check opens the person's wallet, so a press there only names that window (`naming`) and the check
 * itself waits for the next press.
 */
function useCheckMyLastDeposit(company: string, vault: string) {
  const { person } = useSession();
  const [checking, setChecking] = useState(false);
  const going = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const run = (found: (answer: LastDepositChecked) => void): void => {
    if (going.current) return;
    going.current = true;
    setChecking(true);
    void checkMyLastDeposit(person.id, company, vault).then((answer) => {
      going.current = false;
      if (!alive.current) return;
      setChecking(false);
      found(answer);
    });
  };
  return { checking, run, keyHeld: () => companyKeyHeldHere(company) };
}


/**
 * THE VAULT PAGE'S LINE ABOUT A DEPOSIT THAT RUNS, OR HAS ENDED AND NOT BEEN PUT AWAY: the step it is on, and a way back
 * to the panel that shows it. `onDone` is told once for each deposit seen to finish.
 */
export function DepositStrip({ company, vault, onDone }: { company: string; vault: string; onDone: () => void }) {
  const t = useText();
  const now = useDepositNow(vault);
  const open = useOpenDeposit(company, vault);
  useToldWhenDone(now, onDone);
  if (now === null) return null;
  const says = now.of === DEPOSITED.running ? t('vault.deposit.running', { n: now.n, count: now.steps.length })
    : now.of === DEPOSITED.done ? t('vault.deposit.done') : t('vault.deposit.failed');
  return (
    <div className="flex flex-wrap items-center gap-3" role="status" data-deposit-strip={now.of}>
      <p className="text-sm">{says}</p>
      <Button variant="outline" size="sm" onClick={() => open()} data-action="open-deposit">{t('vault.deposit.open')}</Button>
      {now.of === DEPOSITED.running ? <p className="w-full text-xs text-muted-foreground" data-check-waits>{t('vault.deposit.checkWaits')}</p> : null}
    </div>
  );
}


/**
 * DEPOSIT AND CHECK MY LAST DEPOSIT, THE VAULT PAGE'S TWO ACTIONS. Deposit is always there and opens the panel on the ways
 * to put money in. Checking the last deposit shows at once that it was taken, and opens the panel on what it found, or,
 * in a tab that holds no company key, on the naming of the wallet window it opens; it waits while a deposit into this
 * vault runs, since the two would read and settle the same deposit.
 */
export function DepositActions({ company, vault }: { company: string; vault: string }) {
  const t = useText();
  const now = useDepositNow(vault);
  const open = useOpenDeposit(company, vault);
  const { checking, run, keyHeld } = useCheckMyLastDeposit(company, vault);
  const check = (): void => {
    if (!keyHeld()) { open({ naming: true }); return; }
    run((checked) => open({ checked }));
  };
  return (
    <>
      <Button onClick={() => open()} data-action="deposit">{t('vault.deposit')}</Button>
      <Button disabled={checking || now?.of === DEPOSITED.running} onClick={check} data-action="check-last-deposit">
        {checking ? <Spinner aria-label={t('deposit.check.waiting')} /> : null}
        {t('vault.checkLastDeposit')}
      </Button>
    </>
  );
}


function CheckNamed({ check, back }: { check: () => void; back: () => void }) {
  const t = useText();
  return (
    <div className="flex flex-col gap-4" data-deposit="check-named">
      <WalletWindowNamed what={t('deposit.keyWindow.opens')} press={t('deposit.keyWindow.press')} />
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={check} data-action="check-last-deposit">{t('vault.checkLastDeposit')}</Button>
        <Button variant="outline" onClick={back} data-action="back-to-deposit">{t('deposit.check.back')}</Button>
      </div>
    </div>
  );
}


function Methods({ choose }: { choose: (method: DepositMethod) => void }) {
  const t = useText();
  const named = useId();
  const words: Record<DepositMethod, { name: string; line: string }> = {
    [DEPOSIT_METHODS[0].id]: { name: t('deposit.method.fromYourWallet'), line: t('deposit.method.fromYourWallet.line') },
  };
  return (
    <div className="flex flex-col gap-2" data-deposit-methods>
      <p className="text-sm font-medium">{t('deposit.methods')}</p>
      {DEPOSIT_METHODS.map((m) => (
        <Item key={m.id} variant="outline" size="sm" data-method={m.id}>
          <ItemContent>
            <ItemTitle id={named + m.id}>{words[m.id].name}</ItemTitle>
            <ItemDescription className="line-clamp-none">{words[m.id].line}</ItemDescription>
          </ItemContent>
          <Button variant="outline" size="sm" onClick={() => choose(m.id)} aria-describedby={named + m.id} data-action="choose-method">{t('deposit.method.choose')}</Button>
        </Item>
      ))}
    </div>
  );
}


function AmountRefused({ why }: { why: AmountRefusal }) {
  const t = useText();
  const says: Record<AmountRefusal, string> = {
    [AMOUNT_REFUSAL.empty]: t('deposit.refused.nothingTyped'),
    [AMOUNT_REFUSAL.notANumber]: t('deposit.refused.notANumber'),
    [AMOUNT_REFUSAL.negative]: t('deposit.refused.negative'),
    [AMOUNT_REFUSAL.zero]: t('deposit.refused.zero'),
    [AMOUNT_REFUSAL.tooManyDecimals]: t('deposit.refused.tooManyDecimals'),
    [AMOUNT_REFUSAL.groupSeparator]: t('deposit.refused.groupSeparator'),
    [AMOUNT_REFUSAL.aboveHeld]: t('deposit.refused.aboveHeld'),
    [AMOUNT_REFUSAL.heldNotKnown]: t('deposit.refused.heldNotKnown'),
    [AMOUNT_REFUSAL.tokenNotKnown]: t('deposit.refused.tokenNotKnown'),
    [AMOUNT_REFUSAL.noPrivateForm]: t('deposit.refused.noPrivateForm'),
    [AMOUNT_REFUSAL.noPublicForm]: t('deposit.refused.noPublicForm'),
  };
  return (
    <Alert data-amount-refused={why}>
      <AlertTitle>{t('deposit.refused.title')}</AlertTitle>
      <AlertDescription>
        <span>{says[why]}</span>
        {' '}
        <span>{t('deposit.refused.notAsked')}</span>
      </AlertDescription>
    </Alert>
  );
}


/**
 * THE AMOUNT, AND THE PRESS. What is typed (or Max, which is exactly what the wallet said is held) is checked by the
 * adapter at the press, before the wallet is asked; the windows the press opens are named before it.
 */
function AmountEntry({ company, vault, chosen }: { company: string; vault: string; chosen: TokenChosen }) {
  const t = useText();
  const { person } = useSession();
  const field = useId();
  const [entry, setEntry] = useState<string | typeof MAX>('');
  const [refused, setRefused] = useState<AmountRefusal | null>(null);
  const [taken, setTaken] = useState(false);
  const took = useRef(false);
  const { side, token } = chosen;
  const isPrivate = side === DEPOSIT_KIND.private;
  const press = usePayPress(side);

  const put = (): void => {
    if (took.current) return;
    const started = putMoneyIn(person.id, company, vault, { code: token.code, kind: side }, entry, token.held);
    if (started.of === PUT_IN.refused) { setRefused(started.why); return; }
    took.current = true;
    setRefused(null);
    setTaken(true);
  };

  return (
    <div className="flex flex-col gap-4" data-deposit-amount data-side={side}>
      <p className="text-sm" data-chosen>{isPrivate ? t('deposit.chosen.private', { name: token.name }) : t('deposit.chosen.public', { name: token.name })}</p>
      <div className="flex flex-col gap-2">
        <Label htmlFor={field}>{t('deposit.amount.label')}</Label>
        <InputGroup>
          <InputGroupInput
            id={field} disabled={taken} aria-invalid={refused !== null}
            value={entry === MAX ? '' : entry} onChange={(e) => { setEntry(e.target.value); setRefused(null); }} data-field="deposit-amount"
          />
          <InputGroupAddon align="inline-end">
            <InputGroupText>{token.amount.symbol}</InputGroupText>
            <InputGroupButton variant="outline" disabled={taken} aria-label={t('deposit.amount.maxLabel')} onClick={() => { setEntry(MAX); setRefused(null); }} data-action="deposit-max">
              {t('deposit.amount.max')}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {entry === MAX ? (
          <p className="flex flex-wrap items-center gap-1.5 text-sm" data-max-all>{t('deposit.amount.all')} <Amount value={token.amount} kind={AMOUNT_KIND.paid} /></p>
        ) : null}
      </div>
      <p className="text-sm" data-privacy={side}>{isPrivate ? t('deposit.privacy.private') : t('deposit.privacy.public')}</p>
      <WalletWindowNamed what={isPrivate ? t('deposit.payWindow.opensPrivate') : t('deposit.payWindow.opens')} press={press} />
      {isPrivate ? null : <p className="text-sm text-muted-foreground" data-paid-from-public>{t('deposit.payWindow.publicFrom')}</p>}
      {/* The refusal and the press are in the foot of the panel, which stays in view while the form above them scrolls: a refusal is seen where the press is made, and the press is never below the fold. */}
      <PanelFooter>
        <div className="flex flex-col gap-3" data-deposit-footer>
          {refused === null ? null : <AmountRefused why={refused} />}
          <div>
            <Button disabled={taken} onClick={put} data-action="put-money-in">
              {taken ? <Spinner aria-label={t('deposit.putting')} /> : null}
              {taken ? t('deposit.putting') : t('deposit.put')}
            </Button>
          </div>
        </div>
      </PanelFooter>
    </div>
  );
}


function Running({ now }: { now: Extract<DepositNow, { of: 'running' }> }) {
  const t = useText();
  const stepWords = useStepWords();
  const press = usePayPress(now.kind);
  const { now: tick, proofStartedAt } = useTicker(proofsRunning);
  return (
    <div className="flex flex-col gap-4" data-deposit="running" data-step={now.step}>
      <p className="flex flex-wrap items-center gap-1.5 text-sm">{t('deposit.putting.amount')} <Amount value={now.amount} kind={AMOUNT_KIND.paid} /></p>
      <Progress aria-label={t('deposit.progress')} steps={now.steps.map((id, i) => ({ id, done: i < now.n - 1 }))} />
      <p className="text-sm font-medium" data-step-of>{t('deposit.stepOf', { n: now.n, count: now.steps.length })}</p>
      <p className="text-sm" role="status" data-step-name>{stepWords[now.step]}</p>
      <StageProgress
        stage={now.step} elapsedSeconds={secondsSince(tick, proofStartedAt ?? now.since)}
        usualSeconds={usualSecondsOf(now.kind, now.step)} usualLine={false}
      />
      {now.step === DEPOSIT_STEP.provingTheDeposit && now.kind === DEPOSIT_KIND.private ? (
        <p className="text-sm" data-wallet-makes>{t('deposit.walletMakes')}</p>
      ) : null}
      {now.step === DEPOSIT_STEP.provingTheDeposit && now.kind !== DEPOSIT_KIND.private ? (
        <p className="text-sm" data-next-window>
          {t('deposit.next.lead')} <Amount value={now.amount} kind={AMOUNT_KIND.paid} />{t('deposit.next.tail', { press })}
        </p>
      ) : null}
      {now.step === DEPOSIT_STEP.payingInYourWallet ? <p className="text-sm" data-wallet-open>{t('deposit.payWindow.open', { press })}</p> : null}
      <div>
        <Button disabled data-action="put-money-in"><Spinner aria-label={t('deposit.putting')} />{t('deposit.putting')}</Button>
      </div>
    </div>
  );
}


function Done({ vault, now }: { vault: string; now: Extract<DepositNow, { of: 'done' }> }) {
  const t = useText();
  return (
    <div className="flex flex-col gap-4" data-deposit="done">
      <Alert>
        <AlertTitle>{t('deposit.done')}</AlertTitle>
        <AlertDescription>
          <span className="flex flex-col gap-2">
            <Amount value={now.amount} kind={AMOUNT_KIND.paid} />
            {now.chainTransaction === null ? (
              <>
                <span data-chain-transaction-none>{t('deposit.done.notNamed')}</span>
                {now.notYetSpendable ? <span data-not-spendable>{t('deposit.done.notSpendable')}</span> : null}
              </>
            ) : (
              <>
                <span>{t('deposit.done.transaction')}</span>
                <span className="break-all font-mono text-xs" data-chain-transaction>{now.chainTransaction}</span>
              </>
            )}
            {now.earlier === 'recorded' ? <span data-earlier="recorded">{t('deposit.done.earlierRecorded')}</span> : null}
            {now.earlier === 'never-landed' ? <span data-earlier="never-landed">{t('deposit.done.earlierNeverLanded')}</span> : null}
          </span>
        </AlertDescription>
      </Alert>
      <div>
        <Button variant="outline" onClick={() => putAwayEndedDeposit(vault)} data-action="put-more-in">{t('deposit.done.again')}</Button>
      </div>
    </div>
  );
}


const SETUP_MAY_HELP: readonly ActRefusal[] = [ACT_REFUSAL.vaultNotTheCompanys, ACT_REFUSAL.didNotFinish];

/**
 * A DEPOSIT THAT DID NOT FINISH. A private one that may have been sent says its own agreed words and leads to Check my
 * last deposit. A public one that may have been sent leads with the time before which the same money must not be put
 * in again and with looking at the wallet's public balance, because Check my last deposit reads private deposits only;
 * Try again is held back until that time.
 */
function Failed({ vault, now, check, leadTo }: {
  vault: string; now: Extract<DepositNow, { of: 'failed' }>; check: () => void; leadTo: StepProps['leadTo'];
}) {
  const t = useText();
  const language = useLanguage();
  const reasonsSaid = useReasonsSaid();
  const reasons = reasonsSaid(now.reasons);
  const isPublic = now.mayHaveBeenSent && now.kind === DEPOSIT_KIND.public;
  const holding = useBefore(isPublic && now.until !== undefined ? now.until : null);
  const lead = !isPublic ? t('deposit.failed.maybeSent', { reasons })
    : now.until === undefined ? t('deposit.failed.publicMaybeSentNoTime')
    : t('deposit.failed.publicMaybeSent', { when: formatDate(new Date(now.until), language, UNTIL) });
  const causes = isPublic ? now.reasons.slice(1) : [];
  return (
    <div className="flex flex-col gap-4" data-deposit="failed" data-may-have-been-sent={now.mayHaveBeenSent}>
      {now.mayHaveBeenSent ? (
        <>
          <Alert data-refusal="may-have-been-sent">
            <AlertTitle>{t('act.refused.title')}</AlertTitle>
            <AlertDescription data-failed-words>{lead}</AlertDescription>
          </Alert>
          {causes.length === 0 ? null : <p className="text-xs text-muted-foreground" data-details>{t('deposit.failed.details', { reasons: reasonsSaid(causes) })}</p>}
        </>
      ) : (
        <>
          <ActRefused why={now.refusal} />
          <p className="text-sm" data-nothing-sent>{t('deposit.failed.nothingSent')}</p>
          {now.reasons.length === 0 ? null : <p className="text-xs text-muted-foreground" data-details>{t('deposit.failed.details', { reasons })}</p>}
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {now.mayHaveBeenSent && !isPublic ? <Button onClick={check} data-action="check-last-deposit">{t('vault.checkLastDeposit')}</Button> : null}
        {holding ? null : <Button variant="outline" onClick={() => putAwayEndedDeposit(vault)} data-action="try-again">{t('deposit.failed.again')}</Button>}
        {!now.mayHaveBeenSent && SETUP_MAY_HELP.includes(now.refusal) ? (
          <Button variant="outline" onClick={() => leadTo(STEP.vault)} data-lead-to={STEP.vault}>{t('deposit.failed.setup')}</Button>
        ) : null}
      </div>
    </div>
  );
}


/** How the time a deposit on its way is waited for until is written: the browser's date format turns it into the person's language. */
const UNTIL = { dateStyle: 'medium', timeStyle: 'short' } as const;


/** Whether `until` (a time in milliseconds, or null for none) is still ahead, drawn again at that time. */
function useBefore(until: number | null): boolean {
  const [, draw] = useState(0);
  const ahead = until !== null && Date.now() < until;
  useEffect(() => {
    if (!ahead || until === null) return;
    const timer = setTimeout(() => draw((n) => n + 1), Math.min(until - Date.now(), MAX_TIMEOUT_MS));
    return () => clearTimeout(timer);
  }, [ahead, until]);
  return ahead;
}


/** The longest wait a timer takes in one go; a longer one is waited for again when it ends. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;


/** The reasons something failed, one after another, as the failure words give them, with the language file's own separator. */
function useReasonsSaid(): (reasons: readonly string[]) => string {
  const t = useText();
  return (reasons) => (reasons.length === 0 ? t('deposit.failed.noReason') : reasons.reduce((said, reason) => t('deposit.failed.reasonThen', { said, reason })));
}


/** WHAT CHECKING THE LAST DEPOSIT FOUND, in words: where the deposit it judged stands and how much it was, and that only private deposits are checked here. */
function LastDepositAnswer({ answer, back }: { answer: LastDepositChecked; back?: () => void }) {
  const t = useText();
  const language = useLanguage();
  const reasonsSaid = useReasonsSaid();
  const found = answer.of === CHECKED.checked ? answer : null;
  const d = found?.deposit;
  const says = found === null ? null
    : d === 'none' ? t('deposit.check.nothingWaiting')
    : d === 'already-recorded' ? t('deposit.check.alreadyRecorded')
    : d === 'never-landed' ? t('deposit.check.neverLanded')
    : d === 'recorded' ? t('deposit.check.recorded')
    : d === 'still-on-its-way' ? t('deposit.check.stillOnItsWay', { when: formatDate(new Date(found.until ?? 0), language, UNTIL) })
    : d === 'landed-owed-its-record' ? t('deposit.check.owedItsRecord')
    : d === 'journalled-not-seen' ? t('deposit.check.journalledNotSeen')
    : d === 'landed-and-since-spent' ? t('deposit.check.landedAndSinceSpent')
    : t('deposit.check.landedNotRecorded');
  const details = answer.of === CHECKED.checked ? t('deposit.check.details', { text: answer.forSupport }) : answer.reasons.length === 0 ? '' : t('deposit.failed.details', { reasons: reasonsSaid(answer.reasons) });
  return (
    <div className="flex flex-col gap-4" data-deposit="checked" data-checked={answer.of === CHECKED.checked ? answer.deposit : CHECKED.refused}>
      <p className="text-sm text-muted-foreground" data-private-only>{t('deposit.check.privateOnly')}</p>
      {answer.of === CHECKED.refused ? <ActRefused why={answer.why} /> : (
        <div className="flex flex-col gap-2" role="status">
          <p className="text-sm" data-check-says>{says}</p>
          {answer.deposited !== null ? <p className="text-sm" data-checked-amount><Amount value={answer.deposited} kind={AMOUNT_KIND.held} /></p>
            : answer.unshown !== null ? <p className="text-sm" data-checked-unshown={answer.unshown}>{t('records.unrecognised', { count: 1 })}</p> : null}
          {answer.notYetSpendable ? <p className="text-sm" data-not-spendable>{t('deposit.check.notSpendable')}</p> : null}
          {answer.unnamed === 0 ? null : <p className="text-sm" data-unnamed={answer.unnamed}>{t('deposit.check.unnamed', { count: answer.unnamed })}</p>}
          {answer.toName === 0 ? null : <p className="text-sm" data-to-name={answer.toName}>{t('deposit.check.toName', { count: answer.toName })}</p>}
        </div>
      )}
      {details === '' || (found !== null && found.forSupport === '') ? null : <p className="break-words text-xs text-muted-foreground" data-details>{details}</p>}
      {back === undefined ? null : <div><Button variant="outline" onClick={back} data-action="back-to-deposit">{t('deposit.check.back')}</Button></div>}
    </div>
  );
}


/**
 * THE DEPOSIT PANEL. It opens on the list of ways to put money in; the way from the person's wallet shows the account's
 * tokens (asked on a press), then the amount. A deposit that runs, or has ended and not been put away, is the adapter's:
 * this panel shows it whenever it is open, so closing it and opening it again shows the same deposit. When a deposit
 * ends nothing picked or held for it is kept: the next one asks the wallet again. `checked` opens the panel on what
 * checking the last deposit found, and `naming` on the naming of the wallet window that check opens.
 */
export function Deposit({ company, vault, leadTo, checked = null, naming: namingFirst = false }: {
  company: string; vault: string; checked?: LastDepositChecked | null; naming?: boolean;
} & Pick<StepProps, 'leadTo' | 'onChanged'>) {
  const t = useText();
  const now = useDepositNow(vault);
  const [method, setMethod] = useState<DepositMethod | null>(null);
  const [chosen, setChosen] = useState<TokenChosen | null>(null);
  const [answer, setAnswer] = useState<LastDepositChecked | null>(checked);
  const [naming, setNaming] = useState(namingFirst);
  const { checking, run, keyHeld } = useCheckMyLastDeposit(company, vault);
  const ended = now?.of === DEPOSITED.done || now?.of === DEPOSITED.failed;
  useEffect(() => {
    if (!ended) return;
    setMethod(null);
    setChosen(null);
  }, [ended]);

  const checkNow = (): void => run((found) => { setNaming(false); setAnswer(found); });
  const check = (): void => { if (keyHeld()) checkNow(); else setNaming(true); };

  if (answer !== null) return <LastDepositAnswer answer={answer} back={() => setAnswer(null)} />;
  if (checking) return <div className="flex items-center gap-2 text-sm" role="status" data-checking><Spinner aria-label={t('deposit.check.waiting')} />{t('deposit.check.waiting')}</div>;
  if (naming) return <CheckNamed check={checkNow} back={() => setNaming(false)} />;
  if (now?.of === DEPOSITED.running) return <Running now={now} />;
  if (now?.of === DEPOSITED.done) return <Done vault={vault} now={now} />;
  if (now?.of === DEPOSITED.failed) return <Failed vault={vault} now={now} check={check} leadTo={leadTo} />;
  if (method === null) return <Methods choose={setMethod} />;
  return (
    <div className="flex flex-col gap-4" data-deposit="form" data-method={method}>
      <div>
        <Button variant="ghost" size="sm" onClick={() => { setMethod(null); setChosen(null); }} data-action="deposit-methods">{t('deposit.methods.back')}</Button>
      </div>
      <AccountTokens choose={setChosen} onAnswered={() => setChosen(null)} />
      {chosen === null ? null : <AmountEntry key={chosen.side + chosen.token.code} company={company} vault={vault} chosen={chosen} />}
    </div>
  );
}
