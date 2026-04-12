# Troubleshooting & Progress Log

Date: 2026-03-29 (America/New_York)

This log captures each major step taken, problems encountered, and the fix applied. It will be appended going forward for new work.

## Timeline (Steps, Problems, Solutions)

1. **Set baseline project location**
   - Step: Confirmed CLI location and current files.
   - Problem: User moved files; CLI path changed.
   - Solution: Found new path and updated CLI to read league settings from the new location.

2. **League settings persistence**
   - Step: Created league settings file with roto categories, caps, season dates, and roster slots.
   - Problem: League settings file moved.
   - Solution: Updated CLI path to use /Users/atropea/coding/fantasy baseball/fantasy/league-settings.json.

3. **Config missing**
   - Step: Ran recommend.
   - Problem: Missing config.json.
   - Solution: CLI now auto-creates config.json from config.example.json.

4. **Keys not loading**
   - Step: Ran recommend again.
   - Problem: Missing Yahoo consumer key/secret in config.
   - Solution: Added support for env vars YAHOO_CONSUMER_KEY and YAHOO_CONSUMER_SECRET.

5. **OAuth 1.0a request token 404**
   - Step: Ran auth.
   - Problem: Yahoo OAuth1 endpoints returned 404.
   - Solution: Migrated to OAuth 2.0 Authorization Code flow and updated endpoints.

6. **Connectivity check**
   - Step: Added check command.
   - Problem: Needed a quick way to confirm OAuth endpoint behavior.
   - Solution: check prints status for OAuth 2.0 authorization URL.

7. **Yahoo app setup confusion**
   - Step: User went to Yahoo Developer page.
   - Problem: No app existed; unclear where to find secret.
   - Solution: Guided to create a Yahoo app, enable Fantasy Sports API, and locate Client ID/Secret.

8. **Redirect URI mismatch**
   - Step: Ran auth with redirect_uri=oob.
   - Problem: Yahoo app used https://localhost.
   - Solution: Added redirectUri to config and set to https://localhost.

9. **Auth success (OAuth 2.0)**
   - Step: Ran auth, completed browser flow.
   - Problem: Browser showed connection refused on localhost.
   - Solution: Confirmed expected; copy code from URL and paste into CLI. Tokens saved.

10. **Discover flow**
    - Step: Ran discover.
    - Problem: none.
    - Solution: League and team keys found and saved.

11. **Recommend issues (NaN IP, missing ranks, unknown players)**
    - Step: Ran recommend.
    - Problems:
      - Innings Pitched showed NaN.
      - Category ranks not inferred.
      - Free agents showed Unknown.
    - Solutions:
      - Added --debug-json to dump payloads.
      - Hardened stat extraction and team data parsing.
      - Fixed player name/position parsing.
      - Derived category ranks from roto points when rank missing.

12. **Debug cleanup**
    - Step: Added cleanup command.
    - Problem: Debug folder accumulated JSON dumps.
    - Solution: cleanup removes debug files.

13. **Recommendation sizing**
    - Step: Added --top flag.
    - Problem: Wanted shorter default list with option to expand.
    - Solution: Default --top = 3; user can set --top N for longer lists.

## Going Forward (Logging Rules)

- For every change, append a new entry with:
  - Step (what we did)
  - Problem (what failed or was unclear)
  - Solution (how it was fixed)
- If no problem occurred, note "Problem: none."
- Keep secrets out of the log (no Client Secret, access tokens, etc.).


14. **Point gain estimator**
    - Step: Added category point gain estimator against the next team above.
    - Problem: none.
    - Solution: Built team metrics from standings and computed target deltas per category.

15. **Points-per-unit efficiency**
    - Step: Added efficiency metric (points per unit) to point gain targets.
    - Problem: none.
    - Solution: Calculated points per unit (with ratio stat scaling) and appended to output lines.

16. **Best value targets summary**
    - Step: Added a summary list of best value targets sorted by points per unit.
    - Problem: none.
    - Solution: Computed efficiencies and displayed top entries after point gain targets.

17. **Compact output and action labels**
    - Step: Made recommend output more compact and added START/ADD/DROP actions.
    - Problem: Requested clearer action guidance and shorter output.
    - Solution: Added roster fetch for bench players and labeled actions; tightened summary formatting.

18. **START/DROP overlap fix**
    - Step: Prevented START and DROP from recommending the same players.
    - Problem: Bench-based logic listed identical players for both actions.
    - Solution: Excluded START candidates from DROP pool and only drop when rank data exists.

19. **DROP based on recent stats**
    - Step: Updated DROP recommendations to use recent player performance.
    - Problem: DROP list relied on missing Yahoo rank data.
    - Solution: Fetch roster stats (lastmonth/lastweek/season) and score bench players by weak categories.

20. **Roster stats fallback**
    - Step: Added fallback to basic roster if stat-type roster fails.
    - Problem: Roster stats endpoint returned errors.
    - Solution: Try lastmonth/lastweek/season, then fall back to standard roster.

21. **Bench player stats by key**
    - Step: Added per-player stats fetch by player_keys for recent performance.
    - Problem: Roster stats endpoint did not return stats.
    - Solution: Fetch player stats via players;player_keys with lastmonth/lastweek/season fallback.

22. **DROP pool and missing stat values**
    - Step: Fixed DROP pool and treated '-'/'""' stat values as zero.
    - Problem: DROP list stayed empty when START included all bench players and stats were '-'.
    - Solution: Use only displayed START list for exclusion and coerce '-' to 0 in player stats.

23. **DROP duplicate message**
    - Step: Prevented "DROP: recent stats unavailable" after a successful drop list.
    - Problem: Drop fallback message printed even when drops were shown.
    - Solution: Track dropPrinted and only show fallback if no drop list was emitted.

24. **Daily effectiveness logging**
    - Step: Added snapshot/action logging and evaluation on subsequent recommend runs.
    - Problem: Needed to track effectiveness of actions actually made.
    - Solution: Added snapshots.jsonl, actions.jsonl, and daily-log.md with learning boosts.

25. **Interactive action logging prompt**
    - Step: Added a prompt after recommend to log actions taken.
    - Problem: Needed an easy way to capture actual moves without running a separate command.
    - Solution: Prompt for add/drop/start/bench/notes and save to actions.jsonl.

26. **Auto-infer actions**
    - Step: Inferred adds/drops/starts/benches from roster changes between snapshots.
    - Problem: Manual action logging was too burdensome.
    - Solution: Store roster state in snapshots and compute diffs on subsequent runs.

27. **Disable log prompt**
    - Step: Disabled the interactive logging prompt by default.
    - Problem: Manual prompts were still popping up.
    - Solution: Prompt only if FANTASY_LOG_PROMPT=1 is set.

28. **START fallback + DROP confidence + custom names**
    - Step: Added fallback start list, confidence tags, and custom league/team names.
    - Problem: No start guidance when bench doesn't fit needs and unclear drop confidence.
    - Solution: Fallback to best available bench, tag drops with confidence, and display configured names.

29. **Do-not-drop list**
    - Step: Added a configurable do-not-drop list in config.json.
    - Problem: Tool suggested dropping core players.
    - Solution: Filter drop pool using doNotDrop names.

30. **Prefilled do-not-drop list**
    - Step: Seeded doNotDrop with core rostered players.
    - Problem: Needed initial safety list without manual entry.
    - Solution: Added Zac Gallen, Spencer Steer, Steven Kwan, Anthony Santander, Giancarlo Stanton.

31. **Exclude IL from START**
    - Step: Filtered IL players out of START recommendations.
    - Problem: Injured players could be suggested to start.
    - Solution: Exclude bench players flagged as IL from start candidates.

32. **Exclude IL status even if not slotted on IL**
    - Step: Added status-based IL detection from Yahoo player data.
    - Problem: Some IL players are benched without being placed in an IL slot.
    - Solution: Treat players with IL/IR status as IL and exclude them from START.

33. **Effectiveness tracking without manual actions**
    - Step: Added target-based evaluation when no actions are logged or inferred.
    - Problem: Learning never updated because roster changes were not being recorded.
    - Solution: Compare previous target categories to current results and adjust boosts.

34. **Improve effectiveness via efficiency, adherence, and stale penalties**
    - Step: Weighted targets by points-per-unit, tracked lineup adherence, and penalized stale recs.
    - Problem: Recommendations repeated without measurable impact.
    - Solution: Blend efficiency into target priority, scale learning by starters actually used, and deprioritize repeated names when targets stall.

35. **Tighten drop logic + boost SV streaming**
    - Step: Added a rank floor for drop candidates and prioritized RP adds when SV is targeted.
    - Problem: High-value starters were showing up as drop candidates and SV streaming was too weak.
    - Solution: Skip drops for higher-ranked players and order RP adds first when SV is a target.

36. **Broaden add focus + protect unranked SPs**
    - Step: Added best-value targets to add focus and blocked drops of SPs without Yahoo ranks.
    - Problem: SV streams could be overlooked and unranked SPs could be dropped by mistake.
    - Solution: Union weakest categories with best-value targets for add focus, and protect SPs with null ranks.

37. **Tie adds to drops**
    - Step: Reworked ADD output to pair with DROP candidates and warn when no safe drops exist.
    - Problem: Adds weren’t actionable without knowing who to drop.
    - Solution: Match adds to drop candidates by hitter/pitcher and print an explicit drop hint.

38. **Require drop for every add**
    - Step: Suppressed adds when no drop is available and only printed add+drop pairs.
    - Problem: Adds without drops implied impossible moves.
    - Solution: Emit adds only when a matching drop candidate exists.

39. **Match add/drop by type**
    - Step: Restricted add/drop pairing to same-type (hitter for hitter, pitcher for pitcher).
    - Problem: Pitcher drops were suggested for hitter adds and vice versa.
    - Solution: Only pair adds with a drop of the same type, otherwise suppress the add.

40. **Loosen drops + next-team gap**
    - Step: Lowered the drop rank floor and added next-team point gap in output.
    - Problem: Adds were suppressed too often and no sense of overall points gap.
    - Solution: Allow more drop candidates and show how many roto points separate the next team.

41. **Secondary drop tier + always-on effectiveness**
    - Step: Added a secondary rank-based drop tier and ensured effectiveness output always prints.
    - Problem: Add recommendations were still blocked and effectiveness could disappear when no comparison was available.
    - Solution: Introduced a lower-rank fallback drop list and show a fallback message when no prior snapshot exists.

42. **Distance-to-point targeting + upgrade gating + eval delay**
    - Step: Weighted targets by gap to next point, required add/drop rank upgrades, and delayed evaluation.
    - Problem: Stat gains weren’t translating to points and adds were low-impact.
    - Solution: Prioritize categories closest to a point gain, only suggest clear upgrades, and wait 2 days before judging results.
