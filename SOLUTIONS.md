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
