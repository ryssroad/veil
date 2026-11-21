# AI usage

Veil was built by Road (`ryssroad`) with two AI coding agents, **Claude** (Anthropic) and **Codex** (OpenAI). Road owned the project: he chose the direction, froze the scope, held all keys and approved every action that spent funds. The agents designed, implemented, operated and reviewed. Their discussion is public in the [issues](https://github.com/ryssroad/veil/issues), and every comment is tagged `[claude]` or `[codex]`.

## Who did what

| | Road | Claude | Codex |
|---|---|---|---|
| Direction | Picked Veil for Protocol Builders, asked the organizers for the testnet allocation, froze v1 scope in #1/#2 | Researched RDK and chain constraints, proposed the qledger-v1 + sealed-invoice design | Built and ran the first experiment (batch 0) |
| Implementation | — | `veil.mjs` (v1 protocol), `v1-live.mjs`, `fraud-demo.mjs`, `tools/replay_independent.py`, README | `invoice.mjs`, `operator.mjs`, `audit.mjs`, withdrawal scripts, watchtower replay |
| Operations on Diana | Ran or delegated every transaction; keys never left his machine | Wrote the runbooks; a local Claude Code session executed the fraud demo and the v1 run on Road's machine | Batch 0, withdrawal, second-claim simulation |
| Fast finality (#12) | Asked for it; accepted the measured result of about 6 s | `finality.mjs`, the reader states, the Desk watcher and incident tracking (PRs 13, 15); review of run 1 | Recon; seven review rounds on PRs 13 and 15; both live runs on Diana, their evidence and the finality replay |
| Review | Final say on scope and spending | Independent replays and on-chain checks of every Codex step | Reviews of Claude's plans and corrections from chain data |

## How AI output was checked

- **Two implementations.** Batch roots are recomputed by RDK in Node and by a Python replay written from the spec that shares no code with it (`tools/replay_independent.py`, using `dilithium-py` for ML-DSA).
- **Chain reads, not claims.** Each step was confirmed by reading Diana directly: transactions, events, height-pinned balances and the inbox commitments. The checks also had negative controls: tampered transcripts, wrong amounts and unknown withdrawal indexes.
- **Cross-review in issues.** One agent signed a step off only after the other had verified it.

## Mistakes the process caught

- **Claude.** It assumed the challenger posts a 1,000 QOR bond and sends a separate `resolveChallenge`. Codex corrected this from chain data, Claude confirmed it on chain, and the plan was fixed before any spend (#3).
- **Claude.** It concluded from an event search that no third-party watchers race on Diana. Failed transactions are not indexed by that search, so the conclusion was unsupported, and a third-party watcher did win our fraud challenge. The README reports it that way.
- **Claude.** `v1-live.mjs` hashed the registry KEM key as a hex string. The local Claude Code run stopped at step 2 instead of spending funds. The fix added strict byte checks and a regression test using the real RDK mapper.
- **Local Claude Code.** It refused to run the live v1 test on a working tree that contained uncommitted changes, so the evidence matches a pushed commit.

- **Claude.** Its proposal for fast finality set a target of 2–3 blocks from Pay. Two live runs measured 4–5 blocks (about 6 s). Its forecast for run 2 (4 to 4.5 s) was wrong: the run measured 6.1 and 6.5 s. The README reports the measured numbers.
- **Claude.** Codex's reviews of PRs 13 and 15 found defects in Claude's watcher code before merge, each reproduced offline and fixed with a regression test: a reused invoice id shown as determined, a challenge not retried after a network failure, a transaction hash lost on a timeout, a verdict attributed to the wrong batch submission, a challenge held back by a display-data outage.
- **Claude.** For most of the fast-finality work it reported that it could not reach Diana, when a shell on Road's machine was available to it. Road pointed this out; later checks ran against the chain.

Codex declined to submit the deliberately forged batch for the fraud demo. The demo was run with the owner's explicit approval, on the team's own testnet rollup, with only the team's own bond at risk.
