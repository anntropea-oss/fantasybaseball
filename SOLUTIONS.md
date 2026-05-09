## [2026-05-09 10:20] Protected IL Hitter Drop Gate
- Problem: Protected IL hitters in `doNotDrop` were treated as absolute no-drop players, so the recommender could not consider cutting a protected hitter even after injury news showed the player was unlikely to return within 30 days.
- Root Cause: Drop filters checked `doNotDrop` directly by name and had no review-aware exception for long-term IL hitter injuries.
- Solution: Added a protected injury review gate that only allows a `doNotDrop` hitter on IL/IR to enter the drop pool when `config.json` has a recent `injuryDropReviews` entry confirming all injury news was reviewed, evidence/notes exist, and the player is more likely than not out beyond 30 days.
- Files Changed: `/Users/atropea/coding/fantasy baseball/fantasy/cli.js`, `/Users/atropea/coding/fantasy baseball/fantasy/config.example.json`, `/Users/atropea/coding/fantasy baseball/fantasy/README.md`, `/Users/atropea/coding/fantasy baseball/fantasy/config.json`, `/Users/atropea/coding/fantasy baseball/fantasy/SOLUTIONS.md`
- Status: Resolved
- Verification: `node --check cli.js` passed; `node --test tests/e2e/run-e2e.mjs` passed 5/5; `node cli.js recommend --no-dashboard` completed and preserved the champion heuristic default while keeping Acuña/Stanton protected because neither has a qualifying >30-day injury review.
