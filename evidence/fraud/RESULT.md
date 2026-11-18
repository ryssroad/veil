# Fraud demo on veil-pay-1 (QoreChain testnet Diana, 2026-11-18)

**Outcome:** the forged batch 2 was rejected and the operator bond slashed, but the
challenge that won was submitted by a third-party account, not by our watcher.
Our watcher's identical challenge landed in the same block and failed.

## Transactions

| Step | Height | Hash | Code |
|---|---|---|---|
| fund-watcher (5 QOR) | 10320124 | 3A47C4590536E1EF7EED81EA875E75702F051E43FA7CF6B812A4C13C9930388B | 0 |
| register-watcher | 10320132 | 9C93816EC94411E80472F546C26FE0853C1725C6235FA18508E9DC35E6F89969 | 0 |
| post (marker #5) | 10320153 | 12786AFC5BEE539ABFA7D6B88F62EB11196D0327DC6BF08DEE5EDA6D785B6789 | 0 |
| bad-batch (batch 2, forged) | 10320164 | 8F4BD8EBDA38C7E8E378C952FECA8793ACE9F7D7468B9990447DB6D9F70E081E | 0 |
| challenge (winner, third party) | 10320166 | ED09CB1B9E25020765B057BCF5D7214F5794272F8AB1A25E5A03090F2AD648B9 | 0 |
| challenge (ours, watcher) | 10320166 | 0E7400D2D0B42D6972B682C3BBF74232DEE9FD97995CA8EE75965959796A100A | 9 |
| rebond | 10320470 | B7EA3B39D40D0ADF7EDEAA44AF287A42231D438EB03AA4D064127A66AD056565 | 0 |
| replace (honest batch 2, range (4,5]) | 10320478 | 9E5529D1CCBFDCABBCBE99DAB3F1E3CA08274EA2523D91E511B2EF3C06B7EE8A | 0 |

bad-batch to challenge: 2 blocks (10320164 -> 10320166).

## Events of the winning tx

- `rdk_fraud_upheld`: rollup_id=veil-pay-1, batch_index=2,
  submitter=qor1a5j8wjpxpqc6f7htyv92042nrt7gaegpezdhx4,
  challenger=qor1ua2dl0nuf3qxr5yfhr3x9ah5cdh9vw7qczvdj5,
  slashed=1000000000uqor, challenger_reward=500000000uqor, burned=500000000uqor
- `rdk_inbox_rolled_back`: rollup_id=veil-pay-1, consumed_sequence=4

## Our watcher

- Address: qor1lkgyeaz5sukszwxrfrra9mqa7rxjl4g5gq49yu
- Detected batch 2 as fraud (`fraud=true`) at 14:19:58Z and submitted its challenge
  in the same block (10320166) as the winner, ordered after it.
- Result: code 9, `batch 2 is rejected: batch already finalized`
  (the batch was already rejected by the winning tx).
- Proofs in both challenge txs are byte-identical (208 bytes, sha256
  `ef5f485b9ed9f437d0488af1a317e8dc0c4f85df3da8859a2e0827b3af20b28c`). The proof
  is public in the tx, so any observer can submit it.
- Evidence: `challenge-upheld-tx.json`, `challenge-ours-tx.json`, `watch.jsonl`.

## Winner

Third-party account qor1ua2dl0nuf3qxr5yfhr3x9ah5cdh9vw7qczvdj5. Per the team it
previously challenged vigil-1 (not verified in this run). We did not retry or
compete with it.

## After the challenge

- Batch 2 `rejected`, inbox head=5 consumed=4, bondUqor=0.
- Rebond restored bondUqor=1000000000.
- Replacement batch 2 (fraud=false, stateRoot 40dd6411...e02b, same as batch 1)
  submitted at 10320478; consumed=5. Watcher logged it and was stopped manually.
- Replacement batch 2 finalized at block 10323001 (seen 2026-11-18 15:28 UTC):
  status=finalized, consumed=5, head=5, bondUqor=1000000000.

## Net cost to the team

1000 QOR of slashed test bond (500 to the challenger, 500 burned) plus tx fees.
