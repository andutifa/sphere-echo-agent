import { autoConnect } from '@unicitylabs/sphere-sdk/connect/browser';

const TESTNET2 = { id: 4, name: 'testnet2' };
const WALLET_URL = 'https://sphere.unicity.network';

const $ = (id) => document.getElementById(id);
const log = (msg) => {
  const el = $('log');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.prepend(line);
};

let client = null;

function setConnected(identity) {
  $('status').textContent = 'Connected';
  $('status').className = 'status connected';
  $('identity').textContent = identity?.nametag ? `@${identity.nametag}` : (identity?.directAddress || identity?.chainPubkey || 'unknown');
  $('connectBtn').style.display = 'none';
  $('actions').style.display = 'block';
}

function setDisconnected() {
  $('status').textContent = 'Not connected';
  $('status').className = 'status disconnected';
  $('identity').textContent = '—';
  $('connectBtn').style.display = 'inline-block';
  $('actions').style.display = 'none';
}

async function connect(silent) {
  try {
    log(silent ? 'Checking for an existing approved connection…' : 'Requesting connection to your Sphere wallet…');
    const result = await autoConnect({
      dapp: {
        name: 'Sphere Echo & Tip Agent',
        description: 'Echo & tip bot for testing Sphere DMs and payments',
        url: window.location.origin + window.location.pathname,
      },
      walletUrl: WALLET_URL,
      network: TESTNET2,
      silent,
    });
    client = result.client;
    setConnected(result.connection.identity);
    log(`Connected via ${result.transport} transport as ${result.connection.identity?.nametag ? '@' + result.connection.identity.nametag : 'wallet'}.`);

    client.on('identity:changed', (data) => {
      log('Wallet identity changed.');
      setConnected(data);
    });
    client.on('wallet:locked', () => {
      log('Wallet locked.');
      setDisconnected();
    });

    await refreshBalance();
  } catch (err) {
    if (!silent) log(`Connection failed: ${err.message || err}`);
    setDisconnected();
  }
}

async function refreshBalance() {
  if (!client) return;
  try {
    const assets = await client.query('sphere_getAssets');
    const uct = Array.isArray(assets) ? assets.find((a) => a.symbol === 'UCT') : null;
    $('balance').textContent = uct ? `${(Number(uct.totalAmount) / 1e18).toFixed(4)} UCT` : '0 UCT';
  } catch (err) {
    log(`Could not read balance: ${err.message || err}`);
  }
}

async function sendTipRequest() {
  if (!client) return;
  const recipientBot = $('botTag').value.trim() || '@andutbot99';
  try {
    log(`Sending DM "minta tip dong" to ${recipientBot}…`);
    await client.intent('dm', { to: recipientBot, content: 'minta tip dong' });
    log('DM sent. Watch your Sphere chat for the bot\'s reply.');
  } catch (err) {
    log(`Failed to send DM: ${err.message || err}`);
  }
}

async function sendDirectTip() {
  if (!client) return;
  const recipient = $('sendTo').value.trim();
  const amount = $('sendAmount').value.trim();
  if (!recipient || !amount) {
    log('Enter a recipient nametag and an amount first.');
    return;
  }
  try {
    log(`Requesting wallet approval to send ${amount} UCT to ${recipient}…`);
    const amountSmallestUnit = BigInt(Math.round(Number(amount) * 1e18)).toString();
    const result = await client.intent('send', { to: recipient, amount: amountSmallestUnit, coinId: 'UCT' });
    log(`Send result: ${result?.status || 'submitted'}.`);
    await refreshBalance();
  } catch (err) {
    log(`Send failed or was rejected: ${err.message || err}`);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  setDisconnected();
  $('connectBtn').addEventListener('click', () => connect(false));
  $('refreshBtn').addEventListener('click', refreshBalance);
  $('tipRequestBtn').addEventListener('click', sendTipRequest);
  $('sendBtn').addEventListener('click', sendDirectTip);

  // Try a silent auto-connect first (works instantly if already approved,
  // e.g. when embedded as an iframe agent inside Sphere).
  connect(true);
});
