# Sphere Echo & Tip Agent

A minimal autonomous agent built on the **Unicity Sphere SDK**, running on **testnet2**.

## What it does

- Registers a nametag (`@andutbot` by default) on connect.
- Listens for incoming direct messages via `sphere.communications`.
- Echoes any regular message back to the sender.
- If a message contains the keyword `tip`, the agent sends the sender a small amount of testnet UCT via `sphere.payments.send()` and confirms once the transfer completes.
- Automatically resumes any interrupted payment intents on startup (safe handling of `CERTIFICATION_UNCONFIRMED`, per SDK guidance — never re-sends blindly).

## Why this app

It's a small, self-contained demonstration of the two core primitives of the Sphere SDK working together:

1. **Messaging** (`sphere.communications`) — NIP-17 encrypted DMs, no shared ledger needed for the conversation itself.
2. **Payments** (`sphere.payments`) — engine-certified token transfers delivered through the wallet-api mailbox.

It's designed as a template other builders can extend into real agent-to-agent commerce (e.g. pay-per-query bots, automated tipping, escrow negotiation).

## Running it

```bash
npm install
cp .env.example .env   # edit NAMETAG to something unique
npm start
```

On first run, a wallet is auto-generated and its recovery phrase is printed once — save it. The wallet needs testnet UCT to send tips; top it up from the Sphere Quests faucet.

## Tech stack

- `@unicitylabs/sphere-sdk` (Node.js providers)
- Network: `testnet` (testnet2 v2 gateway)
- No external database — wallet state is stored locally under `./wallet-data`
