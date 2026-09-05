# Open questions

What is genuinely unknown, who can answer it, and what is blocked behind it. Not a task list —
`BACKLOG.md` is that.

## Cannot be answered without a chain — `V-79`

Everything below was decided by reading, measured offline, or proved in a simulator. **A simulator
cannot close any of it, and no further offline work shortens the list.**

- Does a failure in the vault revert the account's record of the payment? Offline they share one
  context that is discarded together. `V-32(b)`
- Does a payee's own wallet, built from their keys alone, find a coin the vault paid them? **This is
  the proof that deleting the payslip layer was right rather than merely cheaper.** `V-77`
- Do two payments of one run settle in the same block? The whole window design exists to make this
  true. `V-60`
- Proving **time and memory** — zkir bytes are a proxy, and an employee waits on the real thing.
  `V-44`
- Does a pre-proven payout survive other transactions landing? Decides whether a service can submit
  payroll without ever seeing it. `V-69`

Blocker is the network, not us: Stagenet stopped accepting transactions on 16 August. **Confirm
before planning around it.**

## Waiting on identity, deliberately

- **A payee's encryption key comes from an operator's input, and a wrong one pays them a coin their
  wallet will never show them.** Nothing objects — the mapping is a transaction option, so no assert
  can reach it. `C7` in the register, `V-78`. The real fix is the key coming from the payee's own
  onboarded account, which is why it waits.
- **`failed` is a state nothing produces yet.** The view renders it correctly; the job runner has to
  record attempts. `V-73`
- **Who submits a hundred payments** — a browser tab is not a payroll system. Options are a runner
  the customer hosts or a service, and a service needs the run's secrets. `V-65`, `V-69`

## Known-weak, no decision needed yet

- **No mutation testing for TypeScript.** The contracts are the best-covered thing here and the
  client is the larger money surface. `T-11`
- **Governance proposals have no window**, only runs do. Probably fine, never examined. `V-67`
