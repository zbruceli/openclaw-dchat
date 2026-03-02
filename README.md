# openclaw-dchat

OpenClaw channel plugin for **D-Chat / nMobile** — decentralized end-to-end encrypted messaging over the [NKN](https://nkn.org) relay network.

## Features

- Direct messages (DM) with NKN addresses
- Topic-based group chat (NKN pub/sub)
- Private group messaging
- Media support — images, voice messages, and file transfers
  - Images and files sent/received over IPFS with AES-128-GCM encryption
  - Voice messages via inline AAC (D-Chat Desktop & nMobile compatible)
  - Graceful fallback to URL text when IPFS upload fails
- Delivery receipts
- Multi-account support
- DM policy enforcement (pairing, allowlist, open, disabled)
- Full nMobile wire format compatibility

## Installation

```bash
openclaw plugins install @zbruceli/openclaw-dchat
openclaw gateway restart
```

## Configuration

Add the D-Chat channel after installing:

```bash
# Interactive wizard
openclaw channels add

# Non-interactive
openclaw channels add --channel dchat --access-token <64-char-hex-seed>
```

You'll need:

1. **NKN wallet seed** — a 64-character hex string. Generate one in D-Chat Desktop (Settings > 1-click bot generation), or use `nkn-sdk`, or reuse an existing seed.
2. **DM policy** — controls who can send direct messages:
   - `pairing` (default) — new senders must be approved via pairing code
   - `allowlist` — only explicitly allowed NKN addresses
   - `open` — accept DMs from anyone
   - `disabled` — no DMs

### Config file

```yaml
channels:
  dchat:
    enabled: true
    seed: "your-64-char-hex-wallet-seed"
    dmPolicy: pairing
    allowFrom:
      - "nkn-address-hex"
```

## Pairing

With the default `dmPolicy: pairing`, new senders receive a pairing code that must be approved:

```bash
openclaw pairing list dchat
openclaw pairing approve dchat <CODE>
```

## Channel Management

```bash
openclaw channels status          # check status
openclaw channels remove --channel dchat  # remove channel
openclaw plugins uninstall openclaw-dchat # uninstall plugin
```

## Debugging

```bash
openclaw logs | grep -i dchat
```

## Development

```bash
npm install    # install dependencies
npm test       # run tests
npm run test:watch  # watch mode
```

### Local Development

Use the link workflow to avoid the publish/reinstall cycle:

```bash
openclaw plugins install -l /path/to/openclaw-dchat
openclaw gateway restart  # after code changes, just restart
```

### Clean Reinstall

```bash
openclaw plugins uninstall openclaw-dchat
openclaw channels remove --channel dchat
openclaw plugins install @zbruceli/openclaw-dchat
openclaw gateway restart
```

## How It Works

The plugin connects to the NKN relay network as a MultiClient node, enabling peer-to-peer messaging without centralized servers. Messages use the same wire format as D-Chat Desktop and nMobile for full interop. Media (images, files) is encrypted with AES-128-GCM and transferred via IPFS; voice messages use inline AAC encoding.

## License

MIT
