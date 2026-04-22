# Changes Log

## 2026-04-03
- Excluded IL players from START recommendations.
- Excluded IL-status players from START even if not slotted on IL.
- Prefilled doNotDrop with core rostered players.
- Added configurable do-not-drop list to block drop recommendations.
- Added fallback START list (best available bench) when no bench fits needs.
- Added confidence tags to DROP recommendations.
- Added league/team display names in output (configurable).
- Added automatic action inference from roster changes (no manual logging required).
- Snapshot now includes roster state for action inference.
- Added interactive prompt after recommend to log actions taken (can disable with --no-log-prompt).

## 2026-04-05
- Added effectiveness summary comparing target category movement since the last run.
- Enabled target-based learning updates even when no actions are logged or inferred.
- Weighted target prioritization using points-per-unit efficiency.
- Added lineup adherence tracking and tied learning adjustments to actual starters used.
- Penalized repeated recommendations when prior targets showed no improvement.

## 2026-04-14
- Added `--position` (`--pos`) filter to `recommend` for position-specific adds (e.g., catchers).
- Increased free agent pool and API filtering when a position is requested.
- Added catcher ranking output using live season stats when `--position C` is set.

## 2026-04-16
- Restored compact, colorized `recommend` output layout (Summary → Targets → Actions → Effectiveness).
- Added `--verbose` to show detailed point-gain and efficiency sections.

## 2026-04-22
- Removed `DTD` from status-based DROP suggestions (avoids nonsense drops of elite players).
- Excluded `DTD/NA/IL` players from START suggestions.
- Added `focusTargets` to snapshots and use it for effectiveness/learning (worst categories + best-value targets).
- Increased free-agent pool + stats behavior when chasing saves.
- Switched target selection to prioritize categories with the closest next point gains (derived from standings thresholds).
- Tightened drop logic by skipping players with strong Yahoo ranks.
- Prioritized RP adds when SV is a target for better saves streaming.
- Expanded add focus to include best-value targets (e.g., SV) in addition to weakest categories.
- Avoided dropping SPs with missing Yahoo ranks.
- Paired ADD recommendations with DROP candidates when available and warned when no safe drops exist.
- Suppressed ADD recommendations when no matching DROP is available, ensuring net-neutral roster moves.
- Ensured adds only pair with same-type drops (hitters for hitters, pitchers for pitchers).
- Loosened drop rank floor to surface more viable drop candidates.
- Added points-to-next-team indicator in the summary.
- Added a secondary drop tier when primary drops are unavailable.
- Restored effectiveness indicator even when no prior comparison exists.
- Prioritized targets by distance to the next point in the standings.
- Required add/drop pairs to meet a minimum Yahoo rank improvement.
- Delayed effectiveness evaluation by two days to allow changes to take effect.
- Relaxed add/drop upgrade threshold from 50 to 30 ranks.
- Expanded free-agent pool to improve add options.
- Added status-based drops (NA/DTD/IL) as low-risk options.
- Enabled stat-based add/drop upgrades when ranks are missing.
- Allowed status-based drops regardless of rank or stat comparisons.
- Surfaced status-eligible players anywhere on the roster as drop candidates.
- Prevented dropping the last active catcher.
- Added position filter (--position) for targeted add/drop suggestions.
- Added live-stat catcher ranking output when using --position C.

## 2026-04-01
- Added daily logging system (snapshots, actions, effectiveness evaluation).
- Added `log` command to record actions actually taken.
- Added lightweight learning boosts to prioritize responsive categories.

## 2026-03-30
- Suppressed DROP fallback message when a drop list is printed.
- Improved DROP logic to avoid empty drop pool when START includes all bench players.
- Treated missing player stat values ('-' or '') as zero for drop scoring.
- Added DROP recommendations based on recent performance using bench player stats by key (lastmonth/lastweek/season fallback).
- Added fallback to basic roster if stats roster is unavailable.
- Avoided overlapping START and DROP recommendations and clarified drop logic.
- Made recommend output more compact.
- Added START/ADD/DROP action labels with roster-based bench suggestions.
- Added best value targets summary (points per unit) after point gain targets.
- Added points-per-unit efficiency to point gain targets for each category.

## 2026-03-29
- Added league settings file with roto categories, caps, season dates, and roster slots.
- Updated CLI to read league settings from /Users/atropea/coding/fantasy baseball/fantasy/league-settings.json.
- Added auto-create for config.json from config.example.json when missing.
- Added support for YAHOO_CONSUMER_KEY and YAHOO_CONSUMER_SECRET environment variables.
- Added --debug / YAHOO_DEBUG=1 logging for OAuth token requests.
- Added OAuth 2.0 authorization code flow and token refresh support.
- Updated Yahoo API requests to use Bearer access tokens.
- Updated connectivity check to use OAuth 2.0 authorization endpoint.
- Added redirectUri and oauthScope settings for OAuth 2.0 auth URL.
- Added --debug-json / YAHOO_DEBUG_JSON=1 to dump Yahoo API payloads.
- Added cleanup command to remove debug JSON files.
- Added --top to control number of suggestions shown (including fallback section).
- Set default --top to 3 with option to increase via --top.
- Added point gain estimator for next team above in each category.
- Rounded rank target calculations to whole numbers.
- Added category-specific hitter/pitcher suggestions.
- Hardened stat/name/position parsing for Yahoo response shapes.
- Improved recommendation output to use league categories, show pace vs caps, and suggest roster tweaks by need.
