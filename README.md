# The Banger Committee

Vote on songs for a playlist with your friends. One person creates a lobby and chairs it;
everyone else joins with the 4-letter code, votes For / Against / Abstain on the song on the
floor, and the chair rules it Accepted or Rejected.

## Run locally

```bash
npm install
npm start
```

Then open http://localhost:3000. Add `?mock` to the address to run the page against fake
data with bot members (useful for design work; no server state is touched).

## Deploy on Railway

1. Push this repository to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo** and pick it. Railway detects Node,
   runs `npm start`, and health-checks `/healthz` (see `railway.json`).
3. Under **Settings → Networking**, generate a public domain.
4. Optional but recommended: add a **Volume** mounted at `/data` and set the variable
   `DATA_DIR=/data`. Lobbies are saved there, so a redeploy or restart does not wipe a
   session in progress. Without a volume, lobbies live only as long as the process does.

## How it works

- `server.js` serves `public/` and accepts WebSocket connections on `/ws`.
- `src/lobbies.js` holds the lobbies and the rules (who may vote, rule, reorder).
- `src/spotify.js` looks up tracks, albums and playlists from Spotify's public embed pages,
  so no Spotify API keys are needed.
- `public/` is the page itself: plain HTML, CSS and JavaScript, no build step.

## Things to know

- **Playlists are capped at 100 songs per link.** That is all Spotify exposes without a
  logged-in owner. For longer playlists, paste the link for the first 100, then select the
  remaining songs in the Spotify desktop app, copy them (Ctrl+C) and paste them into the
  submit field — any number of track links can be pasted at once.
- **Playback is per person.** Everyone presses play in their own Spotify player. Spotify
  plays a 30-second preview unless you are logged into Spotify in that browser.
- **The chair** stays with whoever created the lobby. They can hand it to another member
  (crown button next to the name); if they are disconnected for two minutes it passes to
  someone present.
- **Rejoining** is automatic: your name and seat are remembered in the browser, so a
  refresh or a dropped connection puts you back where you were.
