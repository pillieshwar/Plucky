# Todo City sync relay

A small Cloudflare Worker that stores and forwards **encrypted** boxes between a person's Macs. Each mailbox is its own Durable Object with a tiny SQLite database; boxes older than 30 days are deleted. The relay never sees task content and never holds a key.

## Deploy

Pushing changes under `relay/` to `main` deploys automatically (`.github/workflows/relay.yml`). It needs two repository secrets:

- `CLOUDFLARE_API_TOKEN` — from the "Edit Cloudflare Workers" token template
- `CLOUDFLARE_ACCOUNT_ID` — shown on the Workers & Pages overview

You can also run it from **Actions → Deploy relay → Run workflow**, or by hand:

```bash
cd relay
npx wrangler@4.148.0 dev      # local, http://localhost:8787
npx wrangler@4.148.0 deploy   # to Cloudflare
```

## Try it

```bash
R=https://todocity-relay.<your-subdomain>.workers.dev
M=test_mailbox_1234567890abcdef
curl -X PUT --data-binary "locked-box-1" $R/v1/m/$M/boxes   # {"box":1}
curl "$R/v1/m/$M/boxes?after=0"                            # [{"box":1,"data":"…"}]
```

## Status

Starter: put, list and 30-day expiry, with size and per-mailbox limits. Before Todo City uses it for real: device tokens, acknowledgements (delete once every Mac has a box), pairing rooms for the 6-digit code, and per-device rate limits.
