# Veil

**Private invoices for public payments on a QoreChain optimistic rollup.**

**Video:** [3.5-minute walkthrough](https://youtu.be/6Jd2YcRKnyg): the fraud proof, a live sealed payment, and finality in seconds.

**Demo:** [replay of a live Desk run on Diana](https://ryssroad.github.io/veil/demo/): a top-up, two sealed payments, a batch, its finalization and the auditor's register, replayed in the real Desk from a recorded session.

**Finality replay:** [one payment on Diana, from Pay to its settled receipt](https://ryssroad.github.io/veil/demo/finality/). Both readers determined it about 6 s after Pay; L1 settled it an hour later.

Every payment needs two things: someone must enforce that only the owner can move the money, and someone must know what the money was for. Veil puts the first on the chain and seals the second for exactly the people who need it.

- **The chain enforces authorization.** Payments are qledger-v1 transfers signed with ML-DSA-44. If a batch moves funds without the owner's signature, any watchtower can prove it, and Diana rejects the batch and slashes the operator's bond. We demonstrated this live: our operator submitted a batch that drained a payer without a signature, and it was rejected two blocks later with 1,000 QOR slashed.
- **Only the payee and an auditor can read the meaning.** The invoice (who, what for, reference numbers) is sealed with ML-KEM-1024 to exactly two readers. It is signed by the payer's transfer key and bound to the exact transfer bytes, and a reader accepts it only after those bytes executed in a finalized batch whose settlement receipt verifies. Because the ciphertext stays on a public chain forever, it has to resist harvest-now-decrypt-later, which is why the sealing is post-quantum.

A typical case is a Travel Rule-style transfer between two providers: the transfer stays publicly verifiable, while the originator and beneficiary details reach only the receiving provider and the compliance auditor.

Everything below ran on **QoreChain Diana** (testnet) on rollup [`veil-pay-1`](https://api-testnet.qore.host/qorechain/rdk/v1/rollup/veil-pay-1), a based qledger-v1 optimistic rollup with fraud proofs. Track: **Protocol Builders**.

## What ran on Diana

| # | What | Evidence |
|---|---|---|
| 1 | **Sealed invoice payment.** Deposit, a 0.25 QOR transfer and its two-reader envelope (posted in one L1 tx). Batch 0 finalized at 10,306,367; the payee and the auditor each decrypted the same invoice. | [payment tx](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/010AB8E43A327097C6C1E71A2626917B84E8AF87F369F4271F3264BDF8CDB268) · [batch 0](https://api-testnet.qore.host/qorechain/rdk/v1/batch/veil-pay-1/0) · [report](./DIANA-2026-11-18.md) |
| 2 | **Withdrawal to L1.** The payee withdrew 0.25 QOR. Batch 1 finalized at 10,315,867; `MsgExecuteWithdrawal` paid the L1 address (0 → 250,000 uqor). A second claim of the same withdrawal is refused (`rdk` code 28). | [claim tx](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/AB6F83B99E5CD0EAC1FEC0B1C927ED1C2EBB97C871C1A6FF40DE2536E13625E1) · [report](./evidence/withdrawal/RESULT.md) |
| 3 | **Settlement receipt.** ML-DSA-87 anchor receipt for batch 1, verified by RDK, by the official `qorollup receipt veil-pay-1 1 --network testnet --verify`, and independently with `dilithium-py`. | [receipt](./evidence/withdrawal/receipt.json) |
| 4 | **Fraud proof.** The operator deliberately submitted a forged batch 2 that drained the payer's 0.75 QOR into a withdrawal to itself, without the payer's signature. Diana upheld a challenge two blocks later: 1,000 QOR bond slashed (500 burned, 500 to the challenger), inbox rolled back. The honest replacement batch 2 finalized at 10,323,001. | [forged batch](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/8F4BD8EBDA38C7E8E378C952FECA8793ACE9F7D7468B9990447DB6D9F70E081E) · [upheld challenge](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/ED09CB1B9E25020765B057BCF5D7214F5794272F8AB1A25E5A03090F2AD648B9) · [report](./evidence/fraud/RESULT.md) |
| 5 | **Watchtower.** Our watcher, on a separate account, re-executed batch 2 from chain data alone, built the proof and submitted it in the same block. A third-party watcher's byte-identical challenge was ordered first, so ours failed with "already rejected". | [our challenge](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/0E7400D2D0B42D6972B682C3BBF74232DEE9FD97995CA8EE75965959796A100A) · [watch log](./evidence/fraud/watch.jsonl) |
| 6 | **Veil v1: reader-key discovery.** The payee published a signed reader-key statement to the inbox (entry 6). A substituted key claiming the payee's account (7) was rejected; a second statement (8) and a re-post of the first (9) were ignored. | [statement](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/83772A205B380782E33FBC4332D236C68F5482D8DBA7219A82CD7E2BD3F8ECFB) · [negatives](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/3A8AA293B3AD9E653F4DDAA46D329516D2F1766BF81F16FB9B19BE2E73D2ECEF) |
| 7 | **Veil v1: auditor-declared invoice.** The auditor registered its ML-KEM-1024 key in the chain's KEM registry. The payer took the payee's key from the inbox and the auditor's from the registry, and paid 0.3 QOR with the invoice (6,013 B envelope). Batch 3 finalized at 10,336,020. Two clients in separate directories, sharing nothing but the chain, each accepted the same invoice with all receipt checks passing; a repeated import was a no-op duplicate. | [payment tx](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/0B913BF8042BD47C83410F4AFDB2B6571A4D754B4E0B3476B1FF9FEF848B6F31) · [batch 3](https://api-testnet.qore.host/qorechain/rdk/v1/batch/veil-pay-1/3) · [evidence](./evidence/v1/) |
| 8 | **No censorship of third-party posts.** An outside account posted a probe to our inbox (entry 12). The operator's next batch (4) included it; it finalized at 10,345,225. | [batch 4](https://api-testnet.qore.host/qorechain/rdk/v1/batch/veil-pay-1/4) |
| 9 | **Fast finality, measured twice.** A 0.3 QOR Desk payment was `determined` by the payee and the auditor about 6 s after Pay (5.9–6.5 s over two runs) and `settled` after the 1-hour window with all six receipt checks. Run 2: payment at 10,496,676, batch 7 finalized at 10,499,213. | [run 2 payment](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/24A90F9FD2055125FD0126BC8B1F598103791F96660E641DCA5BF7294E5703A6) · [batch 7](https://api-testnet.qore.host/qorechain/rdk/v1/batch/veil-pay-1/7) · [run 1](./evidence/finality/README.md) · [run 2](./evidence/finality/run-2/README.md) |

The roots of batches 0–1 are reproduced from the raw inbox bytes by two independent implementations: RDK in Node, and [a Python replay](./tools/replay_independent.py) that shares no code with it. The forged and honest roots of batch 2 and the commitments of batches 3–4 were recomputed the same way during review. The step-by-step reviews are in [issue #3](https://github.com/ryssroad/veil/issues/3), [#1](https://github.com/ryssroad/veil/issues/1) and [#2](https://github.com/ryssroad/veil/issues/2).

## Why this trust model

Rollups that hide everything usually prove that a batch is arithmetically consistent, but in-circuit signature checks are expensive, so who authorized each transfer is often left to the operator and its watchtowers. Veil makes the opposite trade:

| | Veil |
|---|---|
| Who authorizes a transfer | The owner's ML-DSA-44 signature, re-checked by Diana in every fraud proof |
| What a dishonest operator can do | Nothing that survives a challenge: forged batches are rejected and the operator is slashed |
| Who can read payment details | The payee and an auditor named in the invoice. The operator and watchtowers cannot |
| What stays public | Accounts, amounts and timing, so anyone can audit the ledger itself |
| Cost of the trade | Amounts are public; L1 settlement takes the 1-hour challenge window. A watching reader can verify the payment after its first committed block ([Fast finality](#fast-finality)) |

Veil is for payments that must stay publicly verifiable while their purpose stays private.

## How it works

**Payment.** A normal qledger-v1 transfer: payer, payee, amount and nonce, signed with ML-DSA-44. Diana re-executes it in fraud proofs, so a batch that lies about it can be challenged and the operator's bond slashed.

**Invoice.** The payer signs `sha256(aad ‖ 0x00 ‖ body)` with the transfer's ML-DSA-44 key (context `veil-invoice-v1`), where `aad = [purpose, chainId, rollupId, sha256(transfer)]`. The signature and the body are sealed with QoreSeal (ML-KEM-1024, anonymous slots) to the payee and the auditor. The transfer and the envelope are posted in one L1 transaction, so the envelope is the next inbox entry.

The body is canonical JSON with exactly these keys: `version` (2), `id`, `description` (≤128 B printable text), `amountUqor`, `beneficiary` and `auditorKey`, which is the sha256 of the auditor's registered ML-KEM-1024 key. The worst case fits the 6,144 B post limit (6,135 B), and the size is checked before sealing.

**A reader settles an invoice when all of these hold:**
1. its key opens the envelope for this exact transfer, and the envelope has exactly two slots;
2. the payer's signature verifies and the body is canonical;
3. the amount and beneficiary equal the transfer's, and `auditorKey` equals the auditor's key in the chain registry;
4. replaying the inbox, *these exact transfer bytes* executed: the payer's nonce advanced and the funds moved;
5. the batch containing the transfer is `finalized` and its ML-DSA-87 settlement receipt verifies;
6. the pairs `(payer, executed nonce)` and `(payer, invoice id)` were not imported before. An exact re-import is a no-op; a conflicting one is flagged.

**Reader keys.** The payee publishes a binary `VRK1` statement (5,369 B) to the inbox. It binds its L2 account to an ML-KEM-1024 key and is signed by the account's ML-DSA-44 key under its own context. The first valid statement per account wins, so replays and later statements change nothing. The auditor is an organization with a `qor1` address and uses the chain's KEM registry.

**What stays public.** The fact of payment, both L2 accounts, the amount, the time, the L1 poster and the message sizes — qledger is a public ledger. What the payment was for is visible only to the payee and the auditor.

## Fast finality

The recipient can verify a payment after its first committed Diana block. L1 settlement follows batch finalization.

This holds because qledger-v1 execution is a deterministic function of the ordered inbox. The inbox is based-sequenced, so the operator can neither reorder nor skip posts. Diana commits each block once (1.427 s per block on average over 1,000 blocks on 20 Nov). So the outcome of a payment is fixed in the block that posts it. A batch attests to that outcome, and the challenge window decides when L1 pays withdrawals. When the forged batch 2 was rejected on Diana, its honest replacement produced the same balances.

The reader reports three states for each invoice:

| State | When |
|---|---|
| **determined** | Rules 1–4 and 6 hold. The transfer and its envelope are consecutive messages of **one** successful L1 transaction (same hash, code 0). The reader's watcher has checked every batch: it replays the inbox from genesis, matches each finalized batch as a checkpoint, and finds that every pending batch whose range starts before the entry follows the replay |
| **settled** | Also rule 5: the batch is finalized and its ML-DSA-87 receipt verifies. Only settled invoices are imported and exported to CSV |
| **disputed** | A pending batch the entry depends on diverges from the replay, including an earlier batch that ends before the entry, or a finalized batch diverges. The watcher holds the replay result and tracks the chain's decision |

**The condition.** The guarantee needs one honest watcher during each window, ours or anyone's. An unchallenged divergent batch would finalize on L1, and withdrawals would follow it. Desk shows when the watcher falls behind (`unwatched`). With `VEIL_WATCHER_MNEMONIC` set, the Desk server polls Diana for as long as it runs, with or without a browser, and challenges a divergent batch from that account. It retries delivery until the chain decides or the window closes. Either way, it records the chain's verdict, including a race won by a third-party watcher, as on 18 Nov.

The watcher reproduces Diana's verdict on the real batch 2: it flags the forgery with a fraud proof byte-identical to the one the chain upheld (sha256 `ef5f485b…b28c`), then accepts the honest replacement (`finality.test.mjs`).

**Measured on Diana.** Two Desk payments of 0.3 QOR, timed from the moment Desk received Pay:

| | Run 1, 20 Nov | Run 2, 21 Nov |
|---|---:|---:|
| Payee `determined` | 5.938 s | 6.148 s |
| Auditor `determined` | 6.111 s | 6.508 s |
| Payee `settled` | 1 h 0 min 34 s | 1 h 0 min 47 s |

In Desk, a payment is determined about 6 s after Pay and settled about an hour later. The 2–3 block target set in issue #12 was not met: both runs took 4 to 5 blocks.

Most of the 6 s is Desk, not the chain. In run 2 the node accepted the transaction 2.7 s after Pay, while Desk prepared and signed it. Its block was committed at about 3.6 s (estimated from block headers). Desk's readers showed `determined` 2.6 s (payee) and 2.9 s (auditor) after that. One Desk process evaluates the payee and then the auditor, so the two times are not independent. [Run 1](./evidence/finality/README.md) · [Run 2](./evidence/finality/run-2/README.md)

**Limits of v1.**
- `auditorKey` is the payer's signed *declaration*. A reader cannot prove that the second slot really opens for the auditor; confirmed auditor access would need an acknowledgement protocol.
- Reader keys don't rotate, and the registry key is looked up at its current value.
- Readers trust the Diana node they query for finality and anchors.

## Verify it yourself

Node.js 22 and the lockfile versions:

```sh
npm ci --ignore-scripts
npm test                                                      # protocol tests, offline
node replay-withdrawal.mjs                                    # batches 0-1 from the transcript, offline
node evidence/watchtower/replay.mjs | diff evidence/watchtower/replay.json -   # watcher decision, offline
node verify-withdrawal.mjs                                    # receipt, finality, L1 payment (needs Diana)
node v1-live.mjs status                                       # batches, inbox, reader-key events (needs Diana)
npm run audit -- public                                       # batch 0 payment and invoice binding (needs Diana)
```

The independent replay needs Python and `pip install dilithium-py`:

```sh
python3 -I tools/replay_independent.py evidence/withdrawal/transcript.jsonl
```

None of these needs a key. Decrypting an invoice needs a reader's own seed (`node v1-live.mjs read <dir> payee|auditor <auditor-qor1>`).

## Veil Desk

Run `npm ci` and `npm run desk` in a checkout with the existing v1 reader files. Open **http://127.0.0.1:8788**. The Desk reads Diana, replays the inbox and opens invoices locally. The payer seed is `.private/payer-l2.seed`. The payee and auditor directories default to `.private/clients/payee` and `.private/clients/auditor`. Override them with `VEIL_PAYEE_DIR` and `VEIL_AUDITOR_DIR`. Set `VEIL_AUDITOR` to select another registered auditor.

The default session is read-only. To enable Pay, Top up and Submit batch, start the server with `VEIL_OPERATOR_MNEMONIC` set to the **path** of the rollup creator’s mnemonic file. Inspect key rejection jumps to a previously rejected substitution and shows the current binding. Export CSV includes settled invoices in the selected batch or all batches. Each invoice shows when it was determined and when it settles. A Desk payment also shows Pay → determined and Pay → settled; `GET /api/finality.json` returns those timestamps for each reader, with the committed block, the batch submission and the finalization. Set `VEIL_WATCHER_MNEMONIC` to the path of a funded account, not the rollup creator, to challenge divergent batches automatically.

Start `npm run desk -- --record demo` to record the dashboard and use **Mark scene** to label moments. The local JSONL in `video/sessions/` contains decrypted demo invoices. Open `/?replay` and inject each recorded state via `window.renderState(event.state, event.t)`, advancing the clock with `window.renderTick(event.t)`. Recording timestamps use epoch milliseconds.

### Operator demo on Diana

To prepare a signing and recording session, stop the existing Desk server, then run this from the repository root with the operator file used by `v1-live.mjs`:

```sh
VEIL_OPERATOR_MNEMONIC=.private/rollup-operator.mnemonic npm run desk -- --record demo
```

Starting the server sends no transaction. The **REC** badge and **Mark scene** button appear when recording is active. Signing and recording are independent: omit the environment variable for a read-only recording, or omit `-- --record demo` for signing without recording.

1. In **Payer**, use **Top up** with 2 QOR. Wait for a successful transaction and the refreshed L2 balance.
2. Pay the bound payee 0.3 QOR using **Travel Rule transfer**. After the payer nonce advances, pay another 0.3 QOR using **Audit services invoice**.
3. Use **Submit batch** and note the batch number. It becomes available when there are pending entries. Mark the challenge-window scene while the invoices are submitted.
4. Wait for Diana to finalize the batch. Confirm both invoices show **verified** in both reader columns. Filter the auditor register to that batch and export its CSV.
5. **Inspect key rejection** jumps to the historical rejected statement at entry 7 and identifies the payee’s binding at entry 6.

## Repository

| Path | Purpose |
|---|---|
| `veil.mjs`, `veil.test.mjs` | Veil v1: invoice body, sealing and opening, reader-key statements, execution replay, importer |
| `finality.mjs`, `finality.test.mjs` | Fast finality: inbox entries bound to their L1 transactions, the reader's batch watcher, determined/disputed rules |
| `v1-live.mjs` | v1 live run: clients, auditor registry, statements, payment, batch, reads |
| `invoice.mjs`, `operator.mjs`, `audit.mjs` | first experiment (batch 0) and its public and reader audits |
| `withdrawal.mjs`, `replay-withdrawal.mjs`, `verify-withdrawal.mjs` | withdrawal, offline replay, live verification |
| `fraud-demo.mjs` | forged batch, watchtower, challenge, re-bond, replacement |
| `tools/replay_independent.py` | independent Python replay |
| `evidence/` | transaction records, transcripts, receipts, reports |

## Cost

Of the 15,000 test QOR allocated:
- 10,000 is the rollup stake (9,900 escrowed, 100 burned);
- 1,000 went to layer registration;
- 1,000 is the active submitter bond;
- 1,000 was slashed in the fraud demo;
- 10 funded the watcher and auditor accounts;
- 3 were deposited to the payer (2.75 still in the pool, 0.25 withdrawn);
- about 10 went to fees.

The operator holds 1,976.70 QOR (21 Nov).

## Built with

- [QoreChain RDK 0.9.0](https://github.com/qorechain/qorechain-rdk/tree/v0.9.0) for qledger, commitments, batches, fraud proofs and receipts;
- [QoreSeal 0.1.0](https://github.com/qorechain/qoreseal) for the envelopes;
- the QoreChain SDK for hybrid-signed transactions;
- noble-post-quantum for invoice and statement signatures.

The protocol was designed and reviewed in GitHub issues by two AI agents, Claude and Codex, under the owner's direction. Each comment is tagged with its author; see [AI_USAGE.md](AI_USAGE.md).

## License

Apache-2.0, see [LICENSE](LICENSE).
