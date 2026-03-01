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

Remember to restart gateway
```bash
openclaw gateway restart
```

## Configuration

After installing, add the D-Chat channel:

```bash
# Interactive wizard
openclaw channels add

# Non-interactive
openclaw channels add --channel dchat --access-token <64-char-hex-seed>
```

The onboarding wizard will prompt you for:

1. **NKN wallet seed** — a 64-character hex string. The easiest way is 1-click generating a NKN bot in the Settings menu of D-Chat Desktop app. Or you can generate one with `nkn-sdk` or use an existing seed from D-Chat Desktop / nMobile.
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
    dmPolicy: pairing
    allowFrom:
      - "nkn-address-hex"
```

## Pairing

With the default `dmPolicy: pairing`, new senders receive a pairing code that must be approved before messages flow through to the agent.

```bash
# List pending pairing requests
openclaw pairing list dchat

# Approve a sender
openclaw pairing approve dchat <CODE>
```

## Channel Management

```bash
# Check channel status
openclaw channels status

# Remove channel
openclaw channels remove --channel dchat

# Uninstall plugin
openclaw plugins uninstall openclaw-dchat
```

## Debug if you run into issues
```bash
openclaw logs | grep -i dchat
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

### Local Development (link workflow)

During plugin development, use the `--link` flag to avoid the npm publish → reinstall cycle:

```bash
# Link plugin from your local source directory
openclaw plugins install -l /path/to/openclaw-dchat

# After code changes, just restart the gateway — no reinstall needed
openclaw gateway restart
```

This adds your local path to `plugins.load.paths` in `openclaw.json` and loads directly from source. No need to republish or reinstall between iterations.

### Clean Uninstall / Reinstall

When you need a full cleanup:

```bash
# Uninstall plugin (removes config entries + installed files)
openclaw plugins uninstall openclaw-dchat

# Remove channel config
openclaw channels remove --channel dchat

# Reinstall from npm (production)
openclaw plugins install @zbruceli/openclaw-dchat

# Restart gateway
openclaw gateway restart
```

## How it works

The plugin connects to the NKN relay network as a MultiClient node, enabling peer-to-peer messaging without centralized servers. Messages use the same wire format as D-Chat Desktop and nMobile, so you can chat between OpenClaw and any D-Chat/nMobile client.

## License

MIT
