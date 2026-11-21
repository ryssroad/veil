# Diana finality measurement, run 1

Run 1 of two. [Run 2](./run-2/README.md) repeated it on 21 Nov, after PR #15.

One 0.3 QOR Desk payment on `veil-pay-1` reached `determined` **5.938 s after Pay for the payee and 6.111 s for the auditor**. Desk evaluated the payee first and the auditor second in the same process. Their 173 ms gap includes that processing order. Both readers subsequently verified all six receipt checks and recorded `settled`. The measured software was merge commit `582e212e9de2de4951faa51d38f4a5143ab4bf9c` from PR #13.

| Event | UTC on 2026-11-20 | Diana height | Elapsed from Desk receiving Pay |
|---|---|---:|---:|
| Desk received Pay | 22:33:43.910 | ≈10,458,201 last committed | 0 s |
| Header time of the block containing the payment | 22:33:45.160 | 10,458,203 | — |
| Broadcast returned to Desk | 22:33:48.791 | | 4.881 s |
| Payee determined | 22:33:49.848 | ≈10,458,205 last committed | 5.938 s |
| Auditor determined | 22:33:50.021 | ≈10,458,205 last committed | 6.111 s |
| Batch 6 submitted | 22:34:11 (chain metadata, whole seconds) | 10,458,221 | about 27 s |
| Header time of the block finalizing batch 6 | 23:34:11.094 | 10,460,731 | 1 h 0 min 27.184 s to header time |
| Payee settled | 23:34:18.361 | | 1 h 0 min 34.451 s |
| Auditor settled | 23:34:18.395 | | 1 h 0 min 34.485 s |

**Run 1 took an estimated four blocks from Pay to determination** (10,458,201 → 10,458,205), exceeding the issue #12 target of two to three. The payment was in block 10,458,203. For five Diana headers around Pay and determination, we reproduced each timestamp from the voting-power-weighted median of the previous block’s precommits. Using the next header as a proxy for commit time puts payment-block commitment around 22:33:46.663 UTC. The exact time Desk’s RPC endpoint first served the block was unmeasured. [Raw Desk observations](./finality.json) · [Header timestamps and height estimates](./block-times.json) · [CometBFT time rule](https://github.com/cometbft/cometbft/blob/v0.38.17/spec/consensus/bft-time.md)

## Where the time went

| Step | Seconds after Pay | Basis |
|---|---:|---|
| Node accepts the submitted transaction | ≈1.6–1.9 | Inferred if the first CosmJS lookup succeeded and lookup/return overhead was at most about 0.3 s. Desk read the inbox, replayed it, fetched the registry and account, and signed before submission. Run 1 did not timestamp the handoff. |
| Payment block commits | ≈2.753 | Proxy from the next block header. |
| Broadcast returns to Desk | 4.881 | Measured. CosmJS waited 3 s after `broadcastTxSync` returned before its first inclusion lookup. |
| Desk records determination | 5.938 / 6.111 | Measured. The payee observation followed broadcast return by 1.057 s and the auditor followed by 1.230 s. |

The watcher polled every 3 s before `notePayment()` enabled faster reads on broadcast return. Desk recorded its first payee determination about 3.185 s after the estimated commit. Run 1 recorded neither individual poll start times nor lookup durations, so those intervals cannot be split further from this trace.

The L2 payer went from 1.85 to 1.55 QOR, with nonce advancing from 4 to 5. Batch 6 consumed the transfer at sequence 18 and its envelope at 19. Diana returned code 0 for both transactions. Their declared transaction fees were 0.54 QOR for Pay and 0.27 QOR for the batch. [Diana payment](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/BBE9E446DDB2F70510FE3599AADD0DF932266267C4EA52DB25792440E14C2D97) · [Diana batch transaction](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/2750527E47118CEBE2B7451B3142772E6D8831A196252941CCCD1D02B2509D2A) · [Transaction receipts and balances](./transactions.json)

Desk ran the independent watcher throughout the challenge window. Its funded account held 4.46 QOR and had a registered PQC key with proof of possession. Replay of batch 6 matched the submitted roots, and the batch finalized after its 3,600-second window. A separate chain receipt verification passed after both readers reported settlement. [Preflight](./preflight.json) · [Submitted batch and watcher](./submitted.json) · [Settled readers](./settlement.json) · [Independent verification](./verification.json)
