# Diana finality measurement

One 0.3 QOR Desk payment on `veil-pay-1` reached `determined` in 5.938 s for the payee and 6.111 s for the auditor. Both readers subsequently verified all six receipt checks and recorded `settled`. The measured software was merge commit `582e212e9de2de4951faa51d38f4a5143ab4bf9c` from PR #13.

| Event | UTC on 2026-11-20 | Diana height | Elapsed from Pay |
|---|---|---:|---:|
| Desk received Pay | 22:33:43.910 | 10,458,202 (estimated) | 0 s |
| Payment included | 22:33:45.160 | 10,458,203 | 1.250 s |
| Payee determined | 22:33:49.848 | 10,458,206 (estimated) | 5.938 s |
| Auditor determined | 22:33:50.021 | 10,458,206 (estimated) | 6.111 s |
| Batch 6 submitted | 22:34:11 (chain metadata, whole seconds) | 10,458,221 | about 27 s |
| Batch 6 finalized | 23:34:11.094 | 10,460,731 | 1 h 27.184 s |
| Payee settled | 23:34:18.361 | | 1 h 34.451 s |
| Auditor settled | 23:34:18.395 | | 1 h 34.485 s |

Desk supplied the request and reader timestamps. Estimated heights use the last block header timestamp at or before the observation. Both readers saw determination four heights after the request, or three heights after inclusion. This single run exceeded the issue #12 target of two to three blocks from Pay. [Raw Desk report](./finality.json) · [Neighboring block headers](./block-times.json)

The L2 payer went from 1.85 to 1.55 QOR, with nonce advancing from 4 to 5. Batch 6 consumed the transfer at sequence 18 and its envelope at 19. Diana returned code 0 for both transactions. Their declared transaction fees were 0.54 QOR for Pay and 0.27 QOR for the batch. [Diana payment](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/BBE9E446DDB2F70510FE3599AADD0DF932266267C4EA52DB25792440E14C2D97) · [Diana batch transaction](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/2750527E47118CEBE2B7451B3142772E6D8831A196252941CCCD1D02B2509D2A) · [Transaction receipts and balances](./transactions.json)

Desk ran the independent watcher throughout the challenge window. Its funded account held 4.46 QOR and had a registered PQC key with proof of possession. Replay of batch 6 matched the submitted roots, and the batch finalized after its 3,600-second window. A separate chain receipt verification passed after both readers reported settlement. [Preflight](./preflight.json) · [Submitted batch and watcher](./submitted.json) · [Settled readers](./settlement.json) · [Independent verification](./verification.json)
