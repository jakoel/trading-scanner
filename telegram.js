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
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    throw new Error(`Missing telegram.config.json: ${e.message}`);
  }
}

export async function sendMessage(text, parseMode = 'Markdown') {
  const { botToken, chatId } = loadConfig();
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
    }),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
  return data.result;
}
