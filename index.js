import 'dotenv/config';
import fs from 'fs';
import { Sphere, isSphereError, parseTokenAmount } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

const NAMETAG = process.env.NAMETAG || 'andutbot';
const TIP_AMOUNT_HUMAN = process.env.TIP_AMOUNT || '1'; // human-readable UCT amount, e.g. "1" = 1 UCT
const TIP_AMOUNT = parseTokenAmount(TIP_AMOUNT_HUMAN).toString(); // converted to smallest-unit string for send()
const TIP_COIN = process.env.TIP_COIN || 'UCT';
const TIP_KEYWORD = (process.env.TIP_KEYWORD || 'tip').toLowerCase();
const DAILY_TIP_CAP_HUMAN = Number(process.env.DAILY_TIP_CAP || '500'); // max total UCT tipped out per day

// --- Simple daily tip ledger (persisted to disk so the cap survives restarts) ---
const LEDGER_PATH = './wallet-data/tip-ledger.json';

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function loadLedger() {
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    if (raw.date === todayKey()) return raw;
  } catch (_) {
    // no ledger yet, or unreadable — start fresh
  }
  return { date: todayKey(), totalTipped: 0 };
}

function saveLedger(ledger) {
  fs.mkdirSync('./wallet-data', { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger));
}

async function main() {
  console.log('Starting Sphere Echo & Tip Agent...');

  // 1. Base providers (storage + Nostr transport + oracle/gateway)
  const base = createNodeProviders({
    network: 'testnet',
    dataDir: './wallet-data',
    tokensDir: './tokens',
    oracle: {
      apiKey: process.env.ORACLE_API_KEY || 'sk_ddc3cfcc001e4a28ac3fad7407f99590', // public testnet2 key
    },
  });

  // 2. Wallet-api rails (delivery/mailbox + server token storage) — REQUIRED for send/receive.
  //    Skipping this silently produces a wallet that can register a nametag and chat,
  //    but can never actually receive or send v2 token transfers.
  const providers = createWalletApiProviders(base, {
    baseUrl: 'https://wallet-api.unicity.network',
    network: 'testnet2',
    deviceId: process.env.NAMETAG ? `${process.env.NAMETAG}-device` : 'sphere-echo-agent-device',
  });

  // 2. Init wallet (auto-creates one on first run, saves to ./wallet-data)
  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    network: 'testnet', // some SDK versions require this forwarded explicitly, not just via createNodeProviders
    autoGenerate: true,
    communications: { cacheMessages: false }, // ephemeral bot, no local DM history needed
  });

  if (created && generatedMnemonic) {
    console.log('=================================================================');
    console.log('NEW WALLET CREATED — SAVE THIS RECOVERY PHRASE SOMEWHERE SAFE:');
    console.log(generatedMnemonic);
    console.log('=================================================================');
  }

  // 3. Claim a nametag for this agent (skip if already registered to this key)
  try {
    const available = await sphere.isNametagAvailable(NAMETAG);
    if (available) {
      await sphere.registerNametag(NAMETAG);
      console.log(`Registered nametag: @${NAMETAG}`);
    } else {
      console.log(`Nametag @${NAMETAG} already bound (probably to this wallet from a previous run).`);
    }
  } catch (err) {
    console.warn('Nametag registration skipped/failed:', err.message);
  }

  console.log('Agent identity:', sphere.identity?.nametag ?? sphere.identity?.address);

  // Drain any pending incoming transfers immediately, then log current balance
  await sphere.payments.receive(undefined, (t) => {
    console.log(`Received ${t.amount} ${t.coinId}`);
  });
  console.log('Current balance:', await sphere.payments.getAssets());

  // Keep polling for incoming transfers every 10s (in case background poll is delayed)
  setInterval(async () => {
    try {
      const { transfers } = await sphere.payments.receive(undefined, (t) => {
        console.log(`Received ${t.amount} ${t.coinId}`);
      });
      if (transfers?.length) {
        console.log('Updated balance:', await sphere.payments.getAssets());
      }
    } catch (err) {
      console.warn('Polling receive() failed:', err.message);
    }
  }, 10000);

  // 4. Listen for incoming DMs and react
  sphere.communications.onDirectMessage(async (msg) => {
    const from = msg.senderNametag ? `@${msg.senderNametag}` : msg.senderPubkey;
    console.log(`DM from ${from}: ${msg.content}`);

    const text = (msg.content || '').toLowerCase();

    try {
      if (text.includes(TIP_KEYWORD)) {
        // Check the daily cap before sending anything
        const ledger = loadLedger();
        const tipAmountHuman = Number(TIP_AMOUNT_HUMAN);

        if (ledger.totalTipped + tipAmountHuman > DAILY_TIP_CAP_HUMAN) {
          console.log(`Daily tip cap reached (${ledger.totalTipped}/${DAILY_TIP_CAP_HUMAN} ${TIP_COIN} today). Skipping tip for ${from}.`);
          await sphere.communications.sendDM(
            from,
            `Sorry, I've hit my daily tip limit (${DAILY_TIP_CAP_HUMAN} ${TIP_COIN}/day). Try again tomorrow!`
          );
          return;
        }

        // Send a small amount of testnet UCT back to whoever asked
        const result = await sphere.payments.send({
          recipient: from,
          amount: TIP_AMOUNT,
          coinId: TIP_COIN,
          memo: 'Thanks for testing the Sphere Echo & Tip Agent!',
        });

        if (result.status === 'completed') {
          // Only count it against the cap once the send actually succeeds
          ledger.totalTipped += tipAmountHuman;
          saveLedger(ledger);
          console.log(`Tipped ${tipAmountHuman} ${TIP_COIN} to ${from}. Daily total: ${ledger.totalTipped}/${DAILY_TIP_CAP_HUMAN}`);

          await sphere.communications.sendDM(
            from,
            `Sent you ${TIP_AMOUNT_HUMAN} ${TIP_COIN} (testnet). ${result.deliveryPending ? 'Delivery pending, it will land shortly.' : 'Enjoy!'}`
          );
        }
      } else {
        // Default: simple echo reply
        await sphere.communications.sendDM(from, `Echo: ${msg.content}`);
      }
    } catch (err) {
      if (isSphereError(err) && err.code === 'CERTIFICATION_UNCONFIRMED') {
        // Possibly already sent on-chain — do NOT retry send(). It will resolve on its own.
        console.warn('Send unconfirmed, will resolve automatically:', err.message);
      } else if (err.message?.toLowerCase().includes('insufficient balance')) {
        console.error('Error handling DM: insufficient balance, current assets:', await sphere.payments.getAssets());
        try {
          await sphere.communications.sendDM(from, "I'd love to tip you, but my wallet doesn't have enough testnet UCT credited yet. Try again in a bit!");
        } catch (_) {}
      } else {
        console.error('Error handling DM:', err.message);
        try {
          await sphere.communications.sendDM(from, 'Sorry, something went wrong on my end.');
        } catch (_) {}
      }
    }
  });

  console.log(`Agent is live. DM @${NAMETAG} with any message to get an echo, or "${TIP_KEYWORD}" to get a test tip.`);
  const startupLedger = loadLedger();
  console.log(`Today's tip quota: ${startupLedger.totalTipped}/${DAILY_TIP_CAP_HUMAN} ${TIP_COIN} used.`);

  // Recover any interrupted send() calls from a previous crashed run
  const resumed = await sphere.payments.resumeOpenIntents();
  if (resumed.resumed?.length || resumed.failed?.length) {
    console.log('Resumed open payment intents on startup:', resumed);
  }

  // Keep process alive for the DM listener
  process.on('SIGINT', () => {
    console.log('Shutting down agent...');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error starting agent:', err);
  process.exit(1);
});
