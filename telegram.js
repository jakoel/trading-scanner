/**
 * Telegram bot integration for watchlist alerts.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_PATH = join(__dirname, 'telegram.config.json');

function loadConfig() {
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    return { botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID };
  }
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    throw new Error(`Missing Telegram credentials: no TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID env vars and no telegram.config.json (${e.message})`);
  }
}

export async function sendMessage(text, parseMode = 'Markdown') {
  const { botToken, chatId } = loadConfig();
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode });
  // Retry network-level failures ("fetch failed") and 5xx/429 — a single
  // transient blip shouldn't fail the whole scan job.
  let data;
  for (let attempt = 1; ; attempt++) {
    try {
      const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      data = await resp.json();
      if (data.ok || (resp.status < 500 && resp.status !== 429) || attempt >= 4) break;
    } catch (e) {
      if (attempt >= 4) throw new Error(`Telegram request failed after ${attempt} attempts: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`);
    }
    await new Promise(r => setTimeout(r, attempt * 3000));
  }
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result;
}
