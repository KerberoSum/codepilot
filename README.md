# CodePilot

CodePilot has two separately deployed parts:

- `frontend/` is the static browser application deployed by Netlify.
- `worker/` is the API deployed to Cloudflare Workers and connected to D1.

## Before deploying

1. In `frontend/index.html`, replace `PASTE_YOUR_WORKER_URL_HERE` with the HTTPS URL of the deployed Cloudflare Worker (without a trailing slash).
2. In `wrangler.jsonc`, replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with the database ID shown by Cloudflare.
3. Store `OPENROUTER_API_KEY` as a Cloudflare Worker secret. Never add it to this repository.

## Netlify settings

Import this private GitHub repository and use:

- Production branch: `main`
- Build command: leave blank
- Publish directory: `frontend`

The included `netlify.toml` also sets the publish directory automatically.

## Cloudflare setup

Install dependencies and authenticate Wrangler:

```sh
npm install
npx wrangler login
```

If a D1 database does not exist yet, create it and copy its ID into `wrangler.jsonc`:

```sh
npx wrangler d1 create codepilot-db
```

Apply the schema, add the secret, and deploy:

```sh
npm run db:migrate:remote
npx wrangler secret put OPENROUTER_API_KEY
npm run deploy:worker
```

After deployment, put the resulting `workers.dev` URL into `frontend/index.html`, commit, and push again so Netlify deploys the configured frontend.

