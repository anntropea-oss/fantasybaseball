## [2026-05-09 10:20] Protected IL Hitter Drop Gate
- Problem: Protected IL hitters in `doNotDrop` were treated as absolute no-drop players, so the recommender could not consider cutting a protected hitter even after injury news showed the player was unlikely to return within 30 days.
- Root Cause: Drop filters checked `doNotDrop` directly by name and had no review-aware exception for long-term IL hitter injuries.
- Solution: Added a protected injury review gate that only allows a `doNotDrop` hitter on IL/IR to enter the drop pool when `config.json` has a recent `injuryDropReviews` entry confirming all injury news was reviewed, evidence/notes exist, and the player is more likely than not out beyond 30 days.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/cli.js`, `/Users/atropea/coding/fantasy baseball/fantasy/config.example.json`, `/Users/atropea/coding/fantasy baseball/fantasy/README.md`, `/Users/atropea/coding/fantasy baseball/fantasy/config.json`, `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`
- Status: Resolved
- Verification: `node --check cli.js` passed; `node --test tests/e2e/run-e2e.mjs` passed 5/5; `node cli.js recommend --no-dashboard` completed and preserved the champion heuristic default while keeping Acuña/Stanton protected because neither has a qualifying >30-day injury review.

## [2026-05-09 10:26] Add Drop Diagnostics And Injury Review Snapshot Fields
- Problem: When no add/drop move was available, the CLI did not explain whether the blocker was missing add candidates, missing safe drops, protected IL players, stale injury reviews, or upgrade thresholds; snapshots also did not preserve protected IL injury-review state for later model analysis.
- Root Cause: Recommendation output only emitted final action lists, and `featureInputs.recommendationContext` stored candidate counts without the protection/review diagnostics that caused those counts.
- Solution: Added drop diagnostics to the recommendation flow, printed protected IL checks when protections block add/drop moves, added stale injury-review warnings, and wrote `protectedInjuryReviews` plus `dropDiagnostics` into snapshot feature inputs.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/cli.js`, `/Users/atropea/coding/fantasy baseball/fantasy/README.md`, `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`
- Status: Resolved
- Verification: `node --check cli.js` passed; `node --test tests/e2e/run-e2e.mjs` passed 5/5; `node cli.js recommend --no-dashboard` printed 6 add candidates, 0 safe drops, and protected IL checks for Stanton and Acuña; latest snapshot contains `featureInputs.recommendationContext.protectedInjuryReviews` and `dropDiagnostics`.

## [2026-05-09 10:36] Make GitHub Pages Dashboard Data-Driven
- Problem: The GitHub Pages dashboard was a fully static `docs/index.html`, so open browser tabs could not update when new recommendations were published, and the page had to be regenerated and reloaded to show current data.
- Root Cause: `scripts/dashboard.mjs` baked chart SVG directly into HTML and did not publish a separate data feed for client-side polling.
- Solution: Changed the dashboard publisher to write `docs/dashboard-data.json` and `docs/dashboard.js`; `docs/index.html` now embeds initial data, preloads the JSON feed, and the browser redraws charts/latest recommendations every 60 seconds when the JSON changes. Added optional `FANTASY_PUBLISH_PAGES=1 scripts/run-daily.sh` support to regenerate, commit, and push only dashboard artifacts from cron/launchd.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/scripts/dashboard.mjs`, `/Users/atropea/coding/fantasy baseball/fantasy/scripts/run-daily.sh`, `/Users/atropea/coding/fantasy baseball/fantasy/tests/e2e/run-e2e.mjs`, `/Users/atropea/coding/fantasy baseball/fantasy/README.md`, `/Users/atropea/coding/fantasy baseball/fantasy/docs/index.html`, `/Users/atropea/coding/fantasy baseball/fantasy/docs/dashboard-data.json`, `/Users/atropea/coding/fantasy baseball/fantasy/docs/dashboard.js`, `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`
- Status: Resolved
- Verification: `node --check scripts/dashboard.mjs`, `node --check docs/dashboard.js`, and `bash -n scripts/run-daily.sh` passed; `node --test tests/e2e/run-e2e.mjs` passed 5/5 after adding asserts for the dynamic dashboard assets.

## [2026-05-09 10:40] GitHub Pages Served Main Instead Of Feature Branch
- Problem: The public GitHub Pages dashboard still showed the April 24 static page after the updated dashboard was committed and pushed.
- Root Cause: GitHub Pages was serving the default `main` branch, but the updated `docs/` dashboard artifacts had only been pushed to `feature/e2e-test-suite`.
- Solution: Added a branch guard to `scripts/run-daily.sh` so automated Pages publishes fail loudly unless run from the configured Pages branch, documented that Pages data must be pushed to `main`, and fast-forwarded `main` to the tested feature branch.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/scripts/run-daily.sh`, `/Users/atropea/coding/fantasy baseball/fantasy/README.md`, `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`
- Status: Resolved
- Verification: Pushed `main` and polled `https://anntropea-oss.github.io/fantasybaseball/`; live HTML now includes `dashboard-data.json`, window `2026-04-11` to `2026-05-09`, and update timestamp `2026-05-09T14:35:45.926Z`.

## [2026-05-10 10:01] Clarify Lineup Adherence Baseline
- Problem: Today's output reported `0/3` lineup adherence even though an earlier May 9 recommendation run had been followed, making it look like no recommended starts were used.
- Root Cause: Multiple `recommend` runs happened on May 9. The adherence summary used the latest prior-day recommendation run as the baseline, even if an earlier same-day run better matched the actual lineup changes.
- Solution: Changed the effectiveness summary to evaluate all recommendation runs from the prior date and choose the best-matching adherence baseline, and print the selected baseline snapshot when there were multiple runs. Renamed the section from `Effectiveness since last run` to `Effectiveness since prior day`.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/cli.js`, `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`
- Status: Resolved
- Verification: `node --check cli.js` passed; `node --test tests/e2e/run-e2e.mjs` passed 5/5; `node cli.js recommend --no-dashboard` now prints the adherence baseline snapshot instead of silently scoring the latest prior-day run.

## [2026-05-16 12:14] Block Waiver-Unavailable Add Recommendations
- Problem: The recommender suggested adding Matt Brash, but Yahoo UI would not allow the add until his waiver period ends.
- Root Cause: The Yahoo free-agent player list used by the CLI can expose a player as addable without including the UI-level waiver/claim restriction in the normal player payload.
- Solution: Added configurable add exclusions via `doNotAdd` and `unavailableAdds`, filtered blocked players out before add recommendations are ranked, documented the config, and locally marked Matt Brash as unavailable until the waiver clears.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/cli.js`, `/Users/atropea/coding/fantasy baseball/fantasy/config.example.json`, `/Users/atropea/coding/fantasy baseball/fantasy/README.md`, `/Users/atropea/coding/fantasy baseball/fantasy/config.json`, `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`
- Status: Resolved
- Verification: `node --check cli.js` passed; `node --test tests/e2e/run-e2e.mjs` passed 5/5; rerunning `node cli.js recommend --no-dashboard` with Matt Brash blocked no longer recommends him and reports no add cleared upgrade thresholds.

## [2026-05-16 12:24] Refresh Stale Learning And Apply Champion Target Model
- Problem: Model learning was stuck on snapshot `2026-05-03T15:36:26.911Z` despite daily recommendation runs through May 16, and benchmark output could identify `weakest` as a promotion candidate without `recommend` actually using it for target selection.
- Root Cause: `evaluateActions` only inspected the immediately previous snapshot and returned unchanged when that snapshot was less than the two-day effectiveness delay, so it never searched older eligible snapshots. Separately, benchmark promotion status was only printed and recorded, not wired into the live target-selection path.
- Solution: Added readiness helpers so action evaluation selects the newest unevaluated snapshot/action old enough to judge, promoted qualified benchmark challengers into target selection, and recorded the active `targetModel` in snapshot feature inputs. Documented that qualified challengers are used by `recommend`.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/cli.js`, `/Users/atropea/coding/fantasy baseball/fantasy/README.md`, `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`
- Status: Resolved
- Verification: `node --check cli.js` passed; `node --test tests/e2e/run-e2e.mjs` passed 5/5; `node cli.js recommend --no-dashboard` advanced `logs/learning.json` to `lastEvaluatedSnapshotId` `2026-05-14T14:36:32.414Z`; refreshed `node cli.js benchmark` showed `weakest` beating baseline on daily and all-runs checks; a final `node cli.js recommend --no-dashboard` printed `Champion: weakest is active for target selection` and wrote `featureInputs.recommendationContext.targetModel: "weakest"`.

## [2026-05-22 08:00] Start Recommendations Use Roster Order
- Problem: Start/bench recommendations repeatedly rotate through the same small pitcher group and can look essentially the same day to day even when daily baseball context should matter.
- Root Cause: The start selection flow filters bench players by whether they match the active batting/pitching target type, but then takes the first three remaining candidates from roster order. It does not rank bench candidates by probable start status, opponent, game day, target-stat score, projected innings, or ratio risk before selecting starts.
- Solution: Resolved by the later schedule-aware start ranking entry, which replaced roster-order selection with MLB schedule/probable-starter scoring and an upgrade threshold.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`, `/Users/atropea/coding/fantasy baseball/fantasy/cli.js`, `/Users/atropea/coding/fantasy baseball/fantasy/README.md`
- Status: Resolved
- Verification: Reviewed `cli.js` start selection logic and recent snapshots from May 15 through May 22; later verification confirmed `node cli.js recommend --no-dashboard` now ranks starts using MLB schedule diagnostics instead of unranked roster-order selection.

## [2026-05-22 09:13] Schedule-Aware Start Ranking
- Problem: Start/bench recommendations were selected by roster order after broad target filtering, and the first schedule-aware implementation could not match MLB schedule context because the main `recommend` roster mapping did not carry Yahoo `editorial_team_abbr` into mapped players. Projected K also showed as `0.0` because support stat `IP` is not a scoring category and was missing from the category stat-id map.
- Root Cause: The start flow lacked a ranked start score and did not preserve team metadata in the non-snapshot roster mapping path. Without team abbreviations, MLB probable-starter and opponent matching returned no scheduled game for real roster players; without standard Yahoo stat-id fallbacks, non-scoring support stats could not feed projections.
- Solution: Added Yahoo team extraction, MLB Stats API schedule/probable-starter lookup, start scores using probable starter/game status, projected IP/K, win-proxy, opponent record, ERA/WHIP risk, standard Yahoo stat-id fallbacks for support stats, and a minimum upgrade threshold over the active player to be benched. Added start diagnostics to snapshots and documented the behavior.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/cli.js`, `/Users/atropea/coding/fantasy baseball/fantasy/README.md`, `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`
- Status: Resolved
- Verification: `node --check cli.js` passed; `node --test tests/e2e/run-e2e.mjs` passed 5/5; `node cli.js recommend --no-dashboard` now writes `featureInputs.recommendationContext.startDiagnostics` with MLB schedule scores and recommends schedule-aware starts led by Michael Soroka instead of taking the first three bench pitchers from roster order; projected K is populated from IP/K stat-id fallbacks.

## [2026-05-30 09:52] Guard Against Stale Champion Benchmarks
- Problem: `recommend` could continue using a challenger model from stale benchmark reports even after newer snapshots changed the benchmark result. On May 30, refreshed benchmarks no longer promoted `weakest`, but prior daily recommendations had still reported `weakest` as active from May 16 benchmark files.
- Root Cause: `benchmarkPromotionCandidate` and model status output trusted the saved benchmark JSON files without checking whether their window covered the current snapshot log.
- Solution: Added benchmark freshness checks against `logs/snapshots.jsonl` snapshot count and latest snapshot date; stale reports can no longer promote a challenger and the status line now tells the user to rerun `node cli.js benchmark`.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/cli.js`, `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`
- Status: Resolved
- Verification: `node --check cli.js` passed; `node cli.js benchmark` refreshed reports through `2026-05-30` and showed no promotion candidate, so target selection will fall back to the current production default unless a fresh benchmark qualifies a challenger.

## [2026-05-30 09:52] Benchmark Does Not Directly Optimize League Rank
- Problem: The champion/challenger benchmark answers which target set gains the most category points, but the user goal is increasing league rank and closing the total-points gap to the next team.
- Root Cause: `scripts/model-benchmark-deep.mjs` scores methods with `scoreTargets` category-point gain/regret and uses historical logged `focusTargets` as `baseline`; it does not directly score `overallRank`, `pointsToNextTeam.delta`, or an apples-to-apples recomputation of the current live heuristic.
- Solution: Resolved by the later rank-aware benchmark objective entry, which changed model evaluation and promotion to optimize weighted rank-aware gain before raw category-point gain.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`, `/Users/atropea/coding/fantasy baseball/fantasy/scripts/model-benchmark-deep.mjs`, `/Users/atropea/coding/fantasy baseball/fantasy/cli.js`, `/Users/atropea/coding/fantasy baseball/fantasy/README.md`
- Status: Resolved
- Verification: Reviewed `scripts/model-benchmark-deep.mjs`; later verification confirmed benchmark reports now emit rank-aware gain/regret/capture metrics and `cli.js` promotion reads rank-aware deltas before activating a challenger.

## [2026-05-30 10:02] Add Rank-Aware Benchmark Objective
- Problem: Champion promotion was based on raw category-point gain, which did not directly align with increasing league rank or closing the next-team gap.
- Root Cause: `scripts/model-benchmark-deep.mjs` only scored `scoreTargets` raw category deltas and CLI promotion sorted/qualified challengers by `deltaMeanGainVsBaseline`.
- Solution: Added rank-aware target scoring that weights category gains by weak categories, immediate category gaps, and pressure on the team directly above us; emitted rank-aware gain/regret/capture metrics; changed CLI promotion/status to use rank-aware deltas with raw-gain safety checks.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/scripts/model-benchmark-deep.mjs`, `/Users/atropea/coding/fantasy baseball/fantasy/cli.js`, `/Users/atropea/coding/fantasy baseball/fantasy/README.md`, `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`
- Status: Resolved
- Verification: `node --check cli.js` passed; `node --check scripts/model-benchmark-deep.mjs` passed; `caffeinate -dimsu node --test tests/e2e/run-e2e.mjs` passed 5/5; `caffeinate -dimsu node cli.js benchmark` promoted `weakest` with rank-aware daily +0.257 and all-runs +0.101 vs baseline while keeping raw gain positive.

## [2026-05-31 10:57] Model Review Shows Rank Outcome Attribution Gap
- Problem: A review of the model critique and current logs shows the system can rank target categories and compare benchmark methods, but it still does not attribute why overall league rank remains stuck at 12 or separate category-target quality from execution, roster-move availability, and opponent movement.
- Root Cause: Current benchmark outputs optimize rank-aware category gain from snapshot-to-next-snapshot category deltas, while rank movement is sparse and delayed; recommendation logs do not yet decompose the points-to-next-team gap into controllable team gains, opponent gains, missed lineup adherence, unavailable safe drops, and add/drop opportunity cost.
- Solution: Resolved by the later rank attribution and opportunity challenger entry, which adds a `rank-review` command/API, multi-horizon outcomes, action-feasibility attribution, and a benchmarked `opportunity` challenger.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`, `/Users/atropea/coding/fantasy baseball/fantasy/cli.js`, `/Users/atropea/coding/fantasy baseball/fantasy/scripts/model-benchmark-deep.mjs`, `/Users/atropea/coding/fantasy baseball/fantasy/tests/e2e/run-e2e.mjs`, `/Users/atropea/coding/fantasy baseball/fantasy/README.md`
- Status: Resolved
- Verification: `node cli.js rank-review --days 14` now decomposes the rank/gap outcome into roto-point movement, estimated next-team movement, adherence, add/drop safety blocks, multi-horizon outcomes, and opportunity categories.

## [2026-05-31 11:08] Add Rank Attribution And Opportunity Challenger
- Problem: The model could recommend target categories and benchmark category gains, but it did not explain why rank stayed flat, evaluate feasible-action blockers, compare outcomes across multiple time horizons, or test whether direct next-team gap targeting should beat the current champion.
- Root Cause: Rank review logic was limited to prior-day effectiveness lines, and benchmark challengers did not include a direct-gap opportunity method. The local app API also lacked a rank-attribution endpoint.
- Solution: Added a shared rank attribution engine, `node cli.js rank-review`, `logs/rank-review.json`, `/api/rank-review`, dashboard trend cards, e2e coverage, multi-horizon gap/rank/target metrics, add/drop safety and adherence attribution, an opportunity matrix, and an `opportunity` benchmark challenger that can only become champion if it clears the same promotion gates.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/cli.js`, `/Users/atropea/coding/fantasy baseball/fantasy/scripts/model-benchmark-deep.mjs`, `/Users/atropea/coding/fantasy baseball/fantasy/tests/e2e/run-e2e.mjs`, `/Users/atropea/coding/fantasy baseball/fantasy/README.md`, `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`
- Status: Resolved
- Verification: `node --check cli.js`, `node --check scripts/model-benchmark-deep.mjs`, and `node --check tests/e2e/run-e2e.mjs` passed; `node cli.js rank-review --days 14` generated attribution output and `logs/rank-review.json`; `caffeinate -dimsu node cli.js benchmark` kept `weakest` champion while showing `opportunity` underperformed baseline; `caffeinate -dimsu node --test tests/e2e/run-e2e.mjs` passed 6/6.

## [2026-06-04 09:15] Start Adherence Does Not Explain Standings Impact
- Problem: The June 4 recommendation report showed 3/3 lineup adherence from the June 3 recommendations, but the gap to the next team widened from +3.5 to +10.5 and overall rank stayed 12, making adherence look successful while standings impact was negative.
- Root Cause: Current adherence measures whether recommended players were active, not whether those starts produced enough category-point movement to offset opponent gains or losses in non-target categories. The June 3 -> June 4 transition gained K value and improved ERA value but netted 0 target-category points, while AVG, W, and WHIP lost points and the next team gained an estimated 5 roto points.
- Solution: Resolved by the later start-outcome attribution and benchmark startup refresh entry, which separates start adherence from target/non-target point outcome and adds ratio-risk gating for ERA/WHIP-sensitive pitcher starts.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`, `/Users/atropea/coding/fantasy baseball/fantasy/cli.js`, `/Users/atropea/coding/fantasy baseball/fantasy/tests/e2e/run-e2e.mjs`, `/Users/atropea/coding/fantasy baseball/fantasy/README.md`
- Status: Resolved
- Verification: Compared `logs/snapshots.jsonl` latest daily snapshots for 2026-06-03 and 2026-06-04; later verification confirmed `node cli.js rank-review --days 14` prints start outcome attribution and start-risk notes.

## [2026-06-04 09:19] Add Start Outcome Attribution And Benchmark Startup Refresh
- Problem: `recommend` could start from stale benchmark reports unless the benchmark was manually rerun first, and lineup adherence reported only execution rather than whether starts helped the standings gap.
- Root Cause: `recommend` read benchmark reports but did not refresh stale reports at startup. Effectiveness and rank-review summaries counted active recommended starts without decomposing target-point movement, non-target-point movement, gap movement, estimated next-team movement, or pitcher ratio downside.
- Solution: Added automatic stale benchmark refresh at `recommend` startup, with `FANTASY_AUTO_BENCHMARK=0` and `--no-benchmark-refresh` escape hatches. Added start-outcome attribution to effectiveness and rank-review outputs, including target/non-target point deltas, gap movement, estimated next-team movement, per-start use status, and ERA/WHIP downside-risk flags. Added a downside-risk penalty to start scoring when ERA/WHIP are active targets.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/cli.js`, `/Users/atropea/coding/fantasy baseball/fantasy/tests/e2e/run-e2e.mjs`, `/Users/atropea/coding/fantasy baseball/fantasy/README.md`, `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`
- Status: Resolved
- Verification: `node --check cli.js` and `node --check tests/e2e/run-e2e.mjs` passed; `node cli.js rank-review --days 14` printed start outcome target 0, non-target -2, estimated next-team +5, and Shota Imanaga high ERA risk; `caffeinate -dimsu node --test tests/e2e/run-e2e.mjs` passed 6/6; `caffeinate -dimsu node cli.js recommend` auto-refreshed stale benchmark reports before target selection and printed the new start outcome/risk lines.

## [2026-06-04 09:52] GitHub Pages Dashboard Served Stale Data
- Problem: The GitHub Pages dashboard still displayed May 9 data even though the local recommendation/snapshot logs had fresh June 4 data.
- Root Cause: `recommend` regenerated the local `logs/` dashboard artifacts, but the public Pages app reads tracked files under `docs/`. The repository was on `feature/e2e-test-suite`, while GitHub Pages is configured to serve `main`, so refreshed local data was not published to the Pages source branch.
- Solution: Regenerated the published dashboard with `node cli.js dashboard --publish` and prepared the refreshed `docs/index.html` and `docs/dashboard-data.json` for publication to `main`.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/docs/index.html`, `/Users/atropea/coding/fantasy baseball/fantasy/docs/dashboard-data.json`, `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`
- Status: Resolved
- Verification: Confirmed `docs/dashboard-data.json` now has `generatedAt` `2026-06-04T13:50:17.302Z`, window `2026-05-06` to `2026-06-04`, latest date `2026-06-04`, and latest starts `Emerson Hancock` and `Bryan Hudson`; confirmed `origin/main:docs/dashboard-data.json` was still May 9 before publishing.

## [2026-06-04 10:08] Model Evaluation Still Has Target-Action Blind Spots
- Problem: The current `weakest` target model is the best-performing target selector in tested walk-forward metrics, but rank remains stuck at 12 and the model evaluation can still overstate effectiveness because it scores category target choices separately from whether concrete add/drop/start actions are feasible and beneficial.
- Root Cause: Benchmark scoring optimizes category-point and rank-aware category gain from snapshot transitions, not an end-to-end decision utility that includes safe-drop availability, waiver/actionability constraints, start-vs-add/drop separation, opponent movement, ratio downside, and multi-day rank movement. The latest review window also shows 11/21 days blocked by add/drop safety, so target-selection quality alone cannot translate into roster upgrades.
- Solution: No code fix applied yet. Identified next experiments: add an actionability-weighted benchmark, split start-streaming optimization from add/drop target selection, evaluate multi-horizon rank/gap objectives as promotion gates, and test whether resolving safe-drop bottlenecks produces more rank lift than changing target models.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`
- Status: Open
- Verification: Ran `node cli.js rank-review --days 21`, inspected benchmark reports through `2026-06-04`, queried Gemma Desktop through the bridge for adversarial critique, and ran an additional 1/3/7-day horizon comparison showing `weakest` still beats baseline/opportunity/direct-next on target-selection metrics while remaining far below oracle and disconnected from action feasibility.
