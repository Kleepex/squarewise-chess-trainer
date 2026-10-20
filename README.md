# Squarewise — personal chess training room

An original, local-first chess-training app inspired by the *types* of workflows on ChessStrive (game review, focused drills, opening work, studies, and progress), without reusing its name, logo, artwork, copy, or source. It is a separate personal app; it does not unlock or alter ChessStrive itself.

## Run it

Use the included small Python server (needed for the read-only platform import proxy and correct WebAssembly MIME types):

```bash
python3 server.py
```

Open `http://localhost:4173`. The server binds to `0.0.0.0` for the live preview.

## Implemented

- **Full legal chess rules and PGN replay** with the vendored `chess.js` 1.4.0 library.
- **Local Stockfish analysis** in a Web Worker using Stockfish.js 19 Lite single-threaded WebAssembly. Analyze a position or scan up to 100 plies of a game; quick/standard/deep budgets are available.
- **Game-derived practice:** evaluation drops are surfaced as review moments; save the engine’s candidate move as a personal puzzle and solve it on a legal board.
- **Guided sessions:** build 10-, 15-, or 20-minute multi-round sets with a warm-up, a selected-focus decision rep, legal board puzzles, optional positions from your own saved drills, hints, and an attempt-aware results summary. Puzzle order adapts to recent first-try results; sessions log to local progress and sync through Supabase when signed in.
- **Play a complete game vs Stockfish**, choose color and engine skill, ask for a hint, undo, save to the review library, or download PGN.
- **Read-only account imports:** Chess.com public monthly archives, and Lichess game export with an optional transient token for own/private-game access. The server fetches public/authorized PGNs; platform accounts are not changed.
- **Paste/file PGN import**, editable opening repertoire and study notes, plus a dynamic progress dashboard. Training history drives weekly session counts, daily minutes, streaks, and a weighted practice-accuracy estimate; illustrative demo figures are clearly labeled and replaced when real activity is logged. JSON export and profile reset are included.
- **Optional cloud login and progress sync via your own Supabase project.** Email/password sign-up, sign-in, password reset, automatic syncing, conflict choice, and RLS-protected per-user storage are included. See `SUPABASE_SETUP.md`; cloud sync is inactive until you configure a project. Imported PGN files remain local.
- **Public deployment scaffolding:** a GitHub Pages workflow for the static app and an API-only Render service for Chess.com/Lichess imports. See `DEPLOYMENT.md`; actual hosting still requires a GitHub repository and hosting accounts.
- 19 training modes, all open in this personal edition. No subscription gates, CDN scripts, or analytics are required; local autosave works without an account.

## Privacy and limits

Local autosave keeps app data in this browser’s `localStorage`. When cloud sync is enabled, the user’s own Supabase project receives profile settings, progress, daily tasks, repertoire, study notes, and game-derived drills; imported PGN files and complete game records are not uploaded. Passwords go directly to Supabase Auth over HTTPS and are not stored by Squarewise. Only the public anon/publishable key belongs in the browser—never use a service-role key. Stockfish runs locally; positions are not sent to an engine service. An optional Lichess token is sent to the configured import API for that request (use HTTPS on public deployments) and is not saved. Chess.com’s published API is read-only and exposes public data; private Chess.com data cannot be imported through that API.

Engine labels and game review are analysis aids, not a guarantee of perfect play. The bundled Lite Stockfish model favors fast local use over maximum engine strength. Full-game scans are capped at 100 plies and trade depth for speed. The app provides deterministic engine-based notes rather than a cloud generative-AI coach; adding a cloud AI provider would require a provider choice and a private API credential.

Supabase Auth and cloud sync require the user to create a project, create the table/policies from `SUPABASE_SETUP.md`, and enter the Project URL plus public anon/publishable key in Squarewise. Until then, no Squarewise cloud account is active; local autosave continues. Arena preview URLs may change, so stable multi-device use needs a stable HTTPS deployment with its origin allow-listed in Supabase. Cloud reset/deletion is managed in the user’s Supabase project; the in-app reset clears this device’s local copy and signs out without deleting the cloud copy. Cloud generative-AI coaching remains intentionally absent; engine notes are local and deterministic.

## Third-party notices

- `vendor/chess/chess.mjs` is chess.js 1.4.0, BSD-2-Clause; see `vendor/chess/LICENSE.txt`.
- `vendor/stockfish/` contains unmodified Stockfish.js 19.0.1 Lite single-threaded files, GPL-3.0; see `vendor/stockfish/Copying.txt`, `README.md`, and the included corresponding source archive.
