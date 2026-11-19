# Veil Desk screenshots and export

These artifacts use the existing Diana history for `veil-pay-1`. No new payment, deposit, batch or reader statement was posted for this UI check.

| Artifact | Source |
| --- | --- |
| [Finalized view](./finalized.png) | Live read at inbox head 12, consumed 12. Both readers verified invoice 10 in batch 3. Batch 4 was the latest finalized batch. |
| [Challenge-window replay](./challenge-replay.png) | Browser reconstruction at the recorded submission time of batch 3. The view ends at entry 11, marks batch 3 as submitted and omits its post-finality receipt checks. |
| [Withdrawal and recording](./withdrawal-recording.png) | Live entry 4 shows the executed withdrawal of 0.25 QOR in batch 1. The read-only recording displays REC and Mark scene. The local JSONL contains the scene marker. |
| [Batch 3 CSV](./batch-3.csv) | Desk auditor export for batch 3, with one verified invoice for 300000 uqor. |

The original [payment](../v1/payment.json), [batch submission](../v1/batch-3.json) and [reader-key rejection transaction](../v1/negatives.json) include the hashes and block heights. The two-payment Desk acceptance run was not repeated.
