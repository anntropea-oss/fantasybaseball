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
```

Optional: log a snapshot without computing recommendations (useful for daily tracking even on “busy” days).

```bash
node cli.js snapshot
```

6. Open the dashboard.

```bash
node cli.js dashboard --open-dashboard
```

7. Publish the dashboard to GitHub Pages output (writes `docs/index.html`).

```bash
node cli.js dashboard --publish
```

## Notes

- The CLI stores OAuth tokens at `.tokens.json`.
- If you play multiple leagues, `discover` will list them and pick the first. You can edit `leagueKey` and `teamKey` in `config.json` after discovery.
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
