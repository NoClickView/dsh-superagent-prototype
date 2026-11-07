# Multi-year memory replay — measured report

Scenario: **acme/widgets, 2023-01-09 to 2026-11-06** — 20 episodes over 2023-01-09 to 2026-11-06, then 10 graded questions. Answers: **controlled** (one fixed reader, so the run is reproducible and no provider is called).

Every number below was produced by one run of the replay described in `docs/007-architecture.md`; none of them is a constant of the harness. **This is a replayed span, not production experience**: the clock, the model and the users are the replay's own, and no real deployment ran for years to produce it.

## Verdict

**TIES** — the layered scheme answered 8 questions correctly against 8 for the better baseline (originals), measured against the scenario's hand-written keys; 0 of its answers presented a replaced fact as the present, against 2 for plain retrieval and 0 for the rolling summary.

## The three strategies

| Strategy | Recall quality | Stale-fact misuse | Fabricated detail | Abstentions | Block chars per question | Recall time |
| --- | --- | --- | --- | --- | --- | --- |
| layered | 8/10 | 0 | 0 | 1 | 583 (max 958) | 2 ms |
| originals | 8/10 | 2 | 0 | 1 | 640 (max 993) | 2 ms |
| rolling | 5/10 | 0 | 0 | 5 | 900 (max 900) | 0 ms |

All three were held to the same automatic-input allowance of 1000 characters per question, the runtime's own answer for the main Session's next request, and every background call any of them caused went through the same `llm/stream` waterfall and the same fixed model.

## The configuration this run is valid for

A number means nothing without the versions it was produced under, so every one the run read is named here: a change to any of them is a different measurement, not a better one.

- Numeric policy `mem-policy-4` on the scale `0-100`, whose rungs are 70 for the detail, 40 for the gist and 15 for routine recall's last candidacy; retention policy `mem-retention-1`.
- Scoring principles `mem-principles-1` and compression principles `mem-compression-1`.
- Request budget: 400000 characters, of which 32000 are kept for the answer and 8000 for measurement, leaving 1000 for recalled material on one question.

## Every question

| Question | Situations | Band | Layered | Originals | Rolling |
| --- | --- | --- | --- | --- | --- |
| cluster-now | old-fact-update | within a year | correct | wrong, stale: eu-west-1 | abstained |
| ci-now | old-fact-update | over a year | correct | wrong, stale: runs on jenkins | correct |
| ci-past | old-fact-update | over a year | wrong | correct | wrong |
| sam-who | same-name-entities | over a year | correct | correct | correct |
| nightly | contradictory-evidence | over a year | correct | correct | correct |
| threshold | repeated-self-reference | over a year | correct | correct | correct |
| postmortem | rare-important-event, forget-then-reactivate | over a year | correct | correct | abstained |
| report | long-idle-recovery | over a year | correct | correct | abstained |
| purge | evicted-originals | within a year | wrong | correct | abstained |
| vendor | rare-important-event | within a year | correct | correct | correct |

## The eight required situations

| Situation | Graded questions | Evidence |
| --- | --- | --- |
| old-fact-update | 3 | a 2023 pipeline fact and the 2025 fact that replaced it, and a 2026 region and its replacement |
| same-name-entities | 1 | two different people called Sam, captured as two facts about two teams |
| rare-important-event | 2 | a 2023 outage post-mortem said once and never restated, and a question about an event never recorded |
| repeated-self-reference | 1 | one alert-threshold fact and six restatements of it over a year |
| contradictory-evidence | 1 | a claim and a denial of it, both kept, neither settled by being newer |
| forget-then-reactivate | 1 | two 2023 facts that lost their gist and are read as their cues alone, and the reactivation door that hands records back above the rung their own weight reached |
| evicted-originals | 1 | a budget small enough that reclamation had to release originals, and the expansion that answers for one |
| long-idle-recovery | 1 | eight months without an event, a runtime restart inside them, and a read afterwards |

## Hard constraints

| Constraint | Violations | Owning ticket, which proves it at its own boundary | Measured here |
| --- | --- | --- | --- |
| over-budget-requests | 0 | ticket 01 (tests/budget.spec.ts) and ticket 05 (tests/memory-scoring.spec.ts) | 51 model requests were measured at llm/stream, foreground and background together: 51 of them reached the model and 0 of those were over the configured budget. 0 housekeeping call(s) were let through oversized as the policy's recovery exemption, overflowing the budget by 0 character(s) between them |
| write-bypasses | 0 | ticket 03 (tests/memory-isolation.spec.ts) | a real second process reached for this run's own published journal 4 ways — write, create, replace and delete — on a filesystem that denies it, and 0 of them got through (write EPERM, create EPERM, replace EPERM, delete EPERM); a read-only handle on the same files refused all 3 writes it attempted |
| duplicate-applications | 0 | ticket 02 (tests/memory-store.spec.ts) and ticket 04 (tests/memory-crash.spec.ts) | 24 captures were offered a second time; 24 were answered as duplicates and 0 were applied again |
| interrupted-publication | 0 | ticket 04 (tests/memory-crash.spec.ts) | a publication interrupted at manifest.write left the previous complete version, readable and whole |

## Cost, storage and time

- Background model calls: **55** in total — **35** (60409 characters) for the layered scheme, **0** for plain retrieval, and **20** (20053 characters) for the rolling summary, 15 ms of dispatch over all of them.
- Memory root on disk: **105795 bytes** over 30 experiences and 62 published versions — 0 originals, 15997 gists, 106496 journal, 4096 versions, 0 index.
- Archive: 3 reclamation passes under a budget too small for what was recorded released 1 originals; the one the archive question needed was released, and the answer paid for it (its expansion answered `evicted`).
- Bounded background, held: with the evaluator paused for four more captures the backlog reported **4 queued** and **0 deferred**, and the captures were still accepted and recallable — the foreground served from the published version while nothing was evaluated.
- Bounded background, released: the same queue settled to 0 queued, 14 committed, 0 failed, 0 rejected and 0 skipped over 11 pass(es), under the bounds maxCalls 8, batch 8, concurrency 1, pending 256, timeout 60000 ms and 2 attempt(s). The work runs under policy `mem-policy-4`, principles `mem-principles-1, mem-compression-1` and model `deepseek/deepseek-replay-controlled`.
- Upgrade sweep: one bounded sweep planned **0** re-evaluations, left **26** records still to look at and reported `done: false` — a bounded page rather than a finished one, which is the point of bounding it. Nothing was owed, because every record was already committed under the versions in force; the sweep is the door an upgrade goes through, and this replayed span had no version change to carry.
- Repetition: the fact was restated 7 times and the committed weights were [59.8, 59.8, 59.8, 59.8, 59.8, 59.8, 59.8] — a restatement neither raised the first one nor created anything the time term reads.
- Standing: 30 records still hold, 2 were closed by a later fact and 2 are in unresolved disagreement; every closed window was one the scenario wrote a replacement for.
- Ladder: of the 20 experiences the span itself recorded, 2 have fallen below the gist threshold and 0 have left routine recall; the lightest of them weighs 31.8 against a last threshold of 15, because ten years halve a weight and this span is not ten years long.
- Reactivation: the runtime itself delivered 26 recall notices over the whole replayed span, 0 of them for one of the 10 questions, and 3 item(s) in them were shown above the rung their own weight had reached — the door's work rather than the rung's. It opens on a message that repeats enough of what an older record carries — after the scope correction the shipped `recallThreshold` is a raw cue overlap of about 0.44 — which a message restating a fact reaches and a question about one does not. So the layered strategy's evidence here comes from the service's query door, and from a pushed notice only where one exists.
- Long idle: 2025-06-03 to 2026-02-10 with no event; the restart inside it served the same version and the same experiences (v32 → v32).
- Replay wall clock on the reporting machine: 2371 ms for the whole run, including the archive phase.

## What these numbers do not show

- The controlled model answers in-process, so the background and recall times above are dispatch and queueing, not provider latency. A real provider would be slower by orders of magnitude and the comparison between strategies would not change shape.
- The two baselines are ablations of the same corpus, not shipped systems: they are given the same episodes, the same clock, the same allowance and the same background-call counter, and nothing else. What they would cost to operate at scale is out of scope.
- The layered strategy is measured at the service's own query doors — routine recall and reactivation, both read from the live `MemoryService` within the allowance the runtime computes. It is **not** measured at the `orchestrator_read` listing and expansion door, which can page every experience in scope and would be plain retrieval by another name. A Session that browses memory would score differently, and that door is a separate measurement this replay does not make.
- The clock is replayed. Nothing here is evidence that a deployment ran for years, and no question was asked by a person who did not already know the answer the scenario was built around.
- The span is shorter than the policy horizon. Under a time term where ten years halve a weight, no fact this store can hold reaches the last threshold within the replayed years — the lightest weight in the store is stated above — so the ladder this run walks is the detail-to-gist-to-cues half of it, and the forgotten rung is exercised by the numeric tests that move a clock thirty years, not by this replay. A longer replay would be a different measurement, not a stricter one.
