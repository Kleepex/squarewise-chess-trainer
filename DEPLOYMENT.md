# Public deployment plan

Squarewise is now prepared for a split public deployment:

- **Frontend:** GitHub Pages publishes only the static app, chess rules, and Stockfish assets. The Pages workflow does not publish `server.py`, uploads, or repository documentation.
- **Import API:** Render runs `import_api.py` as an API-only Python service. It responds to Chess.com/Lichess import requests and does not serve the repository or the frontend.
- **Optional account sync:** The browser connects directly to the user’s own Supabase project. Supabase credentials are configured in the app; only the public anon/publishable key belongs in the browser.

This keeps the app usable on a stable HTTPS URL in Safari while placing the Python endpoints on a host that can run server code. GitHub Pages itself serves static files; the included workflow publishes them with GitHub Actions. Render’s Blueprint describes the separate web service and health check.

## What is already prepared

- `.github/workflows/deploy-pages.yml` stages just the static app files and deploys them to GitHub Pages.
- `squarewise-config.js` is the public, non-secret setting for the import API origin.
- `import_api.py` is an API-only entry point; it never serves `index.html` or other repository files.
- `render.yaml` describes the Render service, Python version, health check, allowed frontend origin, and best-effort import throttling.
- `server.py` supports an explicit CORS allow-list and handles cross-origin preflight requests for the two import routes.

## Deployment steps

### 1. Create the GitHub repository and push the starter files

Create a **public** GitHub repository, for example `squarewise-chess-trainer`. On a personal GitHub Free plan, Pages requires a public repository; the published site is public. If you need a private source repository or private site, use a plan/host that supports that setup. Download and extract `squarewise-deployment-starter.zip`, then run these commands from the extracted folder (replace `<owner>` with your GitHub username):

```bash
git init -b main
git add .
git commit -m "Prepare Squarewise for public deployment"
git remote add origin https://github.com/<owner>/squarewise-chess-trainer.git
git push -u origin main
```

Authenticate with GitHub’s normal browser/credential-manager flow. Do not paste passwords or personal access tokens into the app or commit them. The included `.gitignore` excludes local uploads, PGNs, environment files, and Python caches.

The Pages workflow watches `main`; change `.github/workflows/deploy-pages.yml` if your default branch has a different name. In **Settings → Pages**, set the publishing source to **GitHub Actions**.

The workflow deliberately stages only `index.html`, `app-advanced.js`, `cloud-sync.js`, `squarewise-config.js`, and `vendor/`. It retains the bundled third-party notices/source files inside `vendor/` but excludes the Python server and local `uploads/` directory.

Your project Pages URL will look like:

```text
https://<owner>.github.io/<repository>/
```

### 2. Deploy the import API to Render

Create a Render Blueprint from the same repository and use the root `render.yaml`. When Render asks for `SQUAREWISE_ALLOWED_ORIGINS`, enter the **origin only**, without a repository path or trailing slash:

```text
https://<owner>.github.io
```

For a custom frontend domain, use that domain’s origin instead, for example `https://chess.example.com`. Multiple origins may be comma-separated. Keep this value limited to the frontend origins you use.

After the first deploy, Render provides a service origin such as:

```text
https://squarewise-import-api.onrender.com
```

Check that `https://<your-api-host>/api/health` returns JSON with `"ok": true`.

The Render Free service is suitable for a personal demo, but it spins down after 15 minutes without inbound traffic and can take about a minute to wake on the next request. Upgrade the service if you need consistently warm imports.

### 3. Point the static app at the API

Edit `squarewise-config.js` and set `importApiBaseUrl` to the Render **origin**, with no route suffix:

```js
window.SQUAREWISE_CONFIG = {
  importApiBaseUrl: "https://squarewise-import-api.onrender.com"
};
```

Commit and push this change. GitHub Actions will publish the new static app. The API origin is public configuration, not a secret. Do not put a Lichess token, Supabase service-role key, or other private credential in this file.

### 4. Configure optional Supabase sign-in

Follow `SUPABASE_SETUP.md`. In Supabase **Authentication → URL Configuration**:

- Set the **Site URL** to the full public Pages URL, including the repository path, such as `https://<owner>.github.io/<repository>/`.
- Add that full URL to the allowed redirect URLs. Add the corresponding custom-domain URL too if you use one.

The password-reset redirect now preserves the Pages repository path. Keep using only the public anon/publishable key in Squarewise; never use the service-role secret in frontend code.

### 5. Verify cross-origin imports

From a terminal, replace the placeholders and run:

```bash
curl -i -X OPTIONS "https://<your-api-host>/api/import/chesscom" \
  -H "Origin: https://<owner>.github.io" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type"
```

A correct allow-list returns `204` and `Access-Control-Allow-Origin: https://<owner>.github.io`. Then open the Pages URL in Safari and test an import. The API also exposes only `/api/health` and the two import routes; it does not expose the repository files.

## Public endpoint notes

The import endpoints are intentionally read-only: they fetch public Chess.com/Lichess PGNs and return them to the browser. The API applies a small in-memory per-client request throttle (20 requests per 10 minutes by default), caps request sizes and import limits, and only calls the fixed Chess.com/Lichess hosts. The CORS allow-list controls browser access; it is **not authentication** and does not prevent direct non-browser requests. Do not treat a public import API as a private service.

Imported PGNs remain in the browser and are not uploaded to Supabase. A Lichess token, when supplied, is posted over HTTPS to the import API and forwarded only with that Lichess request; it is not saved or written to request logs.

## Still required before a real public URL exists

No GitHub repository, Render service, custom domain, or Supabase project credentials are connected in this workspace, so no public deployment has been created. The checked-in workflow and Render Blueprint are ready to use once the project is pushed to GitHub and the hosting accounts are configured.

## Official references

- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Render Blueprint specification](https://render.com/docs/blueprint-spec)
- [Render health checks](https://render.com/docs/health-checks)
- [Render Free service limits](https://render.com/docs/free)
