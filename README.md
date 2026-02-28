# openclaw-dchat

OpenClaw channel plugin for **D-Chat / nMobile** — decentralized end-to-end encrypted messaging over the [NKN](https://nkn.org) relay network.

## Features

- Direct messages (DM) with NKN addresses
- Topic-based group chat (NKN pub/sub)
- Private group messaging
- IPFS media placeholders (image, audio, file)
- Delivery receipts
- AES-128-GCM encryption (nMobile wire format compatible)
- Multi-account support
- DM policy enforcement (pairing, allowlist, open, disabled)

## Installation

```bash
openclaw plugins install @zbruceli/openclaw-dchat
```

## Configuration

After installing, add the D-Chat channel:

```bash
openclaw channels add dchat
```

The onboarding wizard will prompt you for:

1. **NKN wallet seed** — a 64-character hex string. Generate one with `nkn-sdk` or use an existing seed from D-Chat Desktop / nMobile.
2. **DM policy** — controls who can send you direct messages:
   - `pairing` (default) — new senders must be approved via pairing code
   - `allowlist` — only explicitly allowed NKN addresses
   - `open` — accept DMs from anyone
   - `disabled` — no DMs

You can also configure via environment variables:

```bash
export DCHAT_SEED="your-64-char-hex-wallet-seed"
```

Or set directly in your OpenClaw config:

```yaml
channels:
  dchat:
    enabled: true
    seed: "your-64-char-hex-wallet-seed"
    dm:
      policy: pairing
```

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Watch mode
npm run test:watch
```

## How it works

The plugin connects to the NKN relay network as a MultiClient node, enabling peer-to-peer messaging without centralized servers. Messages use the same wire format as D-Chat Desktop and nMobile, so you can chat between OpenClaw and any D-Chat/nMobile client.

## License

MIT
