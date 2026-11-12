# Audit loop state — Countersign

- Skill: verified-audit-loop · target 9.0 · max 3 rounds · freeze code at 2026-11-12 16:00 UTC
- Baseline (before round 1): `npm test` 14/14 pass · `node loop/tripwire.js` 12/12 recorded decisions identical · live build d7a89f4 · published: 16/16 expected, 0/9 attacks moved money
- Rubric: PayPal AI Hackathon judging (see SUBMISSION.md) mapped onto Security, Reliability, Observability, Testing, Deploy, Code Quality, Honesty of claims

## Scores
| Round | OVERALL_SCORE | Fixed | Rejected | Escalated |
|---|---|---|---|---|
| 3 | (fixes for round-2 findings) | 7 (G1-G7) | 1 then corrected (G4) | 0 |
| 2 | 7.3 | – | – | stop: plateau (+0.2 < 0.3 over 2 rounds); owner chose to fix all G1-G7 |
| 1 | 7.1 (before fixes) | 10 (F1-F10, docs) | 3 then corrected (F8, F9, docs) | 2 (F1, F5: owner approved both) |

## Open findings
- none open; G1-G7 fixed and verified in round 3 (owner-approved)

## Escalations (owner decides)
- F1 resolved by owner: per-visitor budget + account cap (default $10,000, env ACCOUNT_DAILY_CAP).
- F5 resolved by owner: REQUESTER_IS_VENDOR added.
- Note: BENCHMARK-RESULTS.md:54 (protected) describes the pre-loop budget fix historically; README 'Changes since the published run' covers the update.
