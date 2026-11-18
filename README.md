# Veil

Veil links a public qledger-v1 payment on QoreChain Diana to a signed invoice sealed for the recipient and auditor. The first experiment transferred **0.25 test QOR** in batch 0 of `veil-pay-1`.

[Payment transaction](https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/010AB8E43A327097C6C1E71A2626917B84E8AF87F369F4271F3264BDF8CDB268) · [Live batch](https://api-testnet.qore.host/qorechain/rdk/v1/batch/veil-pay-1/0) · [Protocol discussions](https://github.com/ryssroad/veil/issues)

## Verify the payment

The experiment used Node.js 22.22.3 and the public Diana endpoints. Run these commands from the project directory.

```sh
npm ci --ignore-scripts
npm run audit -- public
```

Public verification checks the successful L1 transaction, both messages, the inbox commitment, the executed transfer, the finalized state root and the ML-DSA-87 anchor. A reader can additionally authenticate and decrypt the invoice using a 32-byte binary QoreSeal seed. Each reader needs only its own encryption key.

```sh
npm run audit -- auditor /path/to/auditor.seed
npm run audit -- recipient /path/to/recipient.seed
```

To check a saved receipt supply `--receipt evidence/receipt.json`. The optional `--allow-pending` mode reports the actual batch status while the challenge window is open. The optional `--save` flag records finalized, redacted verification results in `evidence/` and a readable local copy of the invoice in `.private/` for a reader. Keep that directory outside source control.

## Protocol and scope

The payer signs the exact invoice bytes and a reference to the signed L2 transfer using ML-DSA-44. The reference binds the chain ID, rollup ID and transfer digest. QoreSeal encrypts the signed invoice to two ML-KEM-1024 keys. The operator posts the transfer and the envelope in one Cosmos transaction. The invoice author is authenticated independently of the L1 poster.

This verifier covers the first batch of this rollup. The reader keys were provisioned on one test machine and the three inbox entries are publicly recoverable from an indexed Diana endpoint. qledger payment IDs, amounts, posting metadata and balances are public. Receipt verification trusts the configured Diana node for chain state. Separate participant devices, authenticated reader-key discovery, later batches, rollbacks and withdrawals are tracked in Issues.

The operator scripts record the one-time experiment. Running the read-only verifier never requires an operator mnemonic. RDK 0.9.0 implements qledger, commitments, batch planning and receipt verification. QoreSeal 0.1.0 implements the envelope, the QoreChain SDK signs native transactions, and noble-post-quantum signs the invoice.

[QoreChain RDK](https://github.com/qorechain/qorechain-rdk/tree/v0.9.0) · [QoreSeal](https://github.com/qorechain/qoreseal) · [Diana protocol](https://docs.qorechain.io/rollups/rdk-v328/)
