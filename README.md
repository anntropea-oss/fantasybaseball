# Yahoo Fantasy Baseball Assistant

Manage a fantasy baseball team from the command line. This CLI connects to the Yahoo Fantasy Sports API, discovers your league/team, and prints daily recommendations.

## Setup

1. Create a Yahoo Developer app and enable **Fantasy Sports** access (Read or Read/Write).
2. Copy `config.example.json` to `config.json` and fill in your consumer key/secret.
3. Run the auth flow to store your access tokens.

```bash
cp config.example.json config.json
node cli.js auth
```

4. Discover your league + team keys (writes to `config.json`).

```bash
node cli.js discover
```

5. Generate recommendations.

```bash
node cli.js recommend
```

Check your lineup slot assignments for today + tomorrow (direct from Yahoo API):

```bash
node cli.js lineup
node cli.js lineup --date 2026-05-03 --players "Bryce Elder,Steven Matz,Colin Rea"
```

Optional: log a snapshot without computing recommendations (useful for daily tracking even on “busy” days).

```bash
node cli.js snapshot
```

Backfill the local SQLite database from existing JSONL logs:

```bash
node cli.js db-backfill
```

6. Open the dashboard.

```bash
node cli.js dashboard --open-dashboard
```

Open the decision review page for the latest recommendation.

```bash
node cli.js review --open-dashboard
```

7. Run the local app.

```bash
node cli.js app
```

Then open `http://127.0.0.1:8787`. The app has Today, Review, Lineup, Trends, and History tabs backed by local SQLite API endpoints:

```text
/api/latest
/api/snapshots
/api/recommendations
/api/lineup
/api/effectiveness
```

Use a custom port if needed:

```bash
node cli.js app --port 8790
```

8. Publish the dashboard to GitHub Pages output.

```bash
node cli.js dashboard --publish
```

The GitHub Pages dashboard is a static client app backed by
`docs/dashboard-data.json`. It loads instantly from embedded data, then polls
`dashboard-data.json` every 60 seconds and redraws when the published data
changes. Because GitHub Pages cannot run the Yahoo API or local SQLite process,
the data still has to be regenerated and pushed. For near-real-time Pages
updates from cron/launchd, run:

```bash
FANTASY_PUBLISH_PAGES=1 scripts/run-daily.sh
```

That captures a recommendation, regenerates `docs/index.html`,
`docs/dashboard-data.json`, and `docs/dashboard.js`, then commits and pushes
only those dashboard artifacts if they changed.

9. Run the champion/challenger model benchmark.

```bash
node cli.js benchmark
```

This keeps the current heuristic as the production champion unless a challenger
beats it across daily and all-runs walk-forward checks. Benchmark summaries are
stored in `logs/model-benchmark-history.jsonl`.

10. Backfill historical player/team data for model training.

```bash
node cli.js history-backfill
```

By default this fetches the last five completed MLB fantasy seasons. It stores
full paged Yahoo player pools with season stats, plus any historical leagues and
team standings discoverable from the authenticated Yahoo account. Useful flags:
`--years 3`, `--seasons 2021,2022,2023,2024,2025`, `--players-only`,
`--max-pages N`, and `--limit N`.

## Notes

- The CLI stores OAuth tokens at `.tokens.json`.
- If you play multiple leagues, `discover` will list them and pick the first. You can edit `leagueKey` and `teamKey` in `config.json` after discovery.
- SQLite data is stored locally at `logs/fantasy.db`; JSONL logs are still written as a backup/export path.
- The dashboard reads from `logs/fantasy.db` first, then falls back to `logs/snapshots.jsonl`.
- Snapshots include a versioned `featureInputs` block for future model training:
  category gaps, roster composition, player availability/status, lineup-slot
  schedule proxies, recommendation counts, add/drop context, archetypes, and
  projection-score coverage. External schedule/projection/news fields are
  explicitly marked as unavailable until a data feed is added.
- Protected players in `doNotDrop` are never recommended as drops unless they
  are hitters on IL/IR and have a recent `injuryDropReviews` entry showing all
  injury news was reviewed and the player is more likely than not out beyond 30
  days. The CLI prints protected-IL checks when these players block add/drop
  moves and warns when an injury review is older than
  `protectedInjuryReviewMaxAgeDays`. Snapshots record the same state under
  `featureInputs.recommendationContext.protectedInjuryReviews` and
  `dropDiagnostics`. Example:

```json
{
  "protectedInjuryReviewMaxAgeDays": 7,
  "injuryDropReviews": [
    {
      "playerName": "Anthony Santander",
      "reviewedAt": "2026-05-09",
      "reviewedAllInjuryNews": true,
      "likelyBackWithin30Days": false,
      "expectedOutDays": 60,
      "sources": ["https://www.mlb.com/news/anthony-santander-talks-shoulder-injury-2026-timeline"],
      "notes": "Shoulder surgery rehab estimate is five to six months."
    }
  ]
}
```
- Historical backfill tables are stored in `logs/fantasy.db`:
  `historical_player_pools`, `historical_players`,
  `historical_player_stats`, `historical_leagues`, and
  `historical_team_category_stats`.
- For recurring runs, you can call `scripts/run-daily.sh` from cron/launchd.

## Branch Helpers

Create a feature branch:

```bash
scripts/git-start.sh <feature-name>
```

Finish and merge your current feature branch into `main`:

```bash
scripts/git-finish.sh
```
