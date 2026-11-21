# Diana finality measurement, run 2

Veil Desk at merge commit `a2a8562164a2a85a0a5e352bade844ef69265eeb` (PR #15) sent one 0.3 QOR payment to the same payee on `veil-pay-1` as run 1. Pay starts when Desk receives the request. Both runs used one server process, which evaluated the payee before the auditor.

| Reader | Pay → determined, run 1 | Pay → determined, run 2 | Run 2 minus run 1 | Estimated blocks, run 1 → run 2 |
|---|---:|---:|---:|---:|
| Payee | 5.938 s | 6.148 s | +0.210 s | 4 → 4 |
| Auditor | 6.111 s | 6.508 s | +0.397 s | 4 → 5 |

Both observations exceeded the 2–3 block target. We estimated last committed heights from the next Diana header's timestamp, following the run 1 method. Pay arrived at an estimated 10,496,673. The payee and auditor observations bracket different block boundaries, at estimated heights 10,496,677 and 10,496,678 respectively. [Run 1](../README.md) · [Run 2 observations](./determined.json) · [Nearby headers](./block-times.json) · [Comparison](./comparison.json)

The node acknowledged the run 2 payment 2.658 s after Pay. Desk received the inclusion result at +4.077 s, compared with +4.881 s in run 1. From that return to determination, the payee interval went from 1.057 s to 2.071 s and the auditor interval from 1.230 s to 2.431 s. The two runs do not isolate the cause of that difference. Run 2 used Desk's local recording mode for background polling and kept automatic challenge signing disabled. Run 1 used a configured watcher. Both replayed the chain and checked for divergent batches.

The payment was included at height 10,496,676. Batch 7 was submitted at height 10,496,699 and consumed the transfer and envelope at sequences 20 and 21. Both transactions returned code 0. [Payment on Diana](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/24A90F9FD2055125FD0126BC8B1F598103791F96660E641DCA5BF7294E5703A6) · [Batch on Diana](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/0107DDFA198ED46564F8E20668BE2F66B37799DD2E1BCB55F9BF20817AC0AEF6) · [Receipts](./transactions.json)

Batch 7 finalized at height 10,499,213. The payee recorded `settled` 1 h 0 min 46.626 s after Pay, and the auditor at 1 h 0 min 46.664 s. Both readers and an independent chain verification passed all six receipt checks. [Final Desk timestamps](./finality.json) · [Reader checks](./settlement.json) · [Independent verification](./verification.json)
