# Todo City sync relay

A small Cloudflare Worker that stores and forwards **sealed** boxes between a person's Macs. Everything is encrypted on the Mac first (ChaCha20-Poly1305, with a key only the paired Macs have), so the relay never sees task content and never holds a key.

## How it works

- **Mailboxes.** One per group of Macs, each its own Durable Object with a tiny SQLite database. The app names the mailbox and makes its pass from the group key; the relay keeps only a SHA-256 of the pass, set on first use.
- **Acknowledgements.** Each Mac says which box it has read up to. A box is deleted as soon as every Mac in the group has it, and in any case after 30 days.
- **Gaps.** A Mac that comes back after its boxes were deleted is told `gap: true`. It asks the others, through the mailbox, for a full copy.
- **Pairing rooms.** For adding a Mac: an 8-letter code opens a room for 10 minutes that holds a few small messages (public keys and a sealed invite). The two Macs show the same six digits if, and only if, nobody swapped keys in between.
- **Limits.** Boxes up to 256 KB; 4,000 boxes or 64 MB waiting per mailbox; 10 Macs per group; 240 calls and 120 boxes per minute per mailbox; 600 requests and 30 pairing messages per minute per network address.

The full API is at the top of [`src/index.ts`](src/index.ts). The app's side is `crates/todocity-core/src/sync/`.

## Deploy

Pushing changes under `relay/` to `main` deploys automatically (`.github/workflows/relay.yml`), then runs a smoke test against the live relay. It needs two repository secrets:

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
P=$(openssl rand -hex 24)
curl -H "authorization: Bearer $P" -H "x-device: my_mac_01" --data-binary "sealed-box" $R/v1/m/$M/boxes   # {"box":1}
curl -H "authorization: Bearer $P" -H "x-device: my_mac_02" "$R/v1/m/$M/boxes?after=0"                   # {"boxes":[…],"gap":false,…}
```
