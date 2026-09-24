# CodePilot

CodePilot has two separately deployed parts:

- `frontend/` is the static browser application deployed by Netlify.
- `worker/` is the API deployed to Cloudflare Workers and connected to D1.

## Before deploying

1. In `frontend/index.html`, replace `PASTE_YOUR_WORKER_URL_HERE` with the HTTPS URL of the deployed Cloudflare Worker (without a trailing slash).
2. In `wrangler.jsonc`, replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with the database ID shown by Cloudflare.
3. Store `OPENROUTER_API_KEY` as a Cloudflare Worker secret. Never add it to this repository.
4. To enable the VM Agent bridge, add these Cloudflare Worker settings:
   - `VM_AGENT_URL` — optional fallback HTTPS base URL of the VM agent tunnel. VM Agent v2 can auto-register a new Quick Tunnel URL.
   - `VM_AGENT_SECRET` — bearer secret configured on the VM agent service.
   - `VM_AGENT_REGISTRATION_SECRET` — separate secret used by the VM to register its current Quick Tunnel URL.
   - `VM_MODEL_GATEWAY_SECRET` — separate secret for the VM-to-CodePilot OpenAI-compatible model gateway.
   The frontend never receives these VM secrets; authenticated browser requests are proxied through the Worker.

Remote Worker v3 files live in `vm-agent/`. They add conversational VM chat, background Missions, lightweight VM resource status, optional headless web/browser control through Trailblaze, automatic Quick Tunnel registration, a hardened service template, and the CodePilot model gateway. See `vm-agent/README.md` for the VM upgrade and browser-tool installation steps.

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

