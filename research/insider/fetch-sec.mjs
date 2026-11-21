/**
 * Downloads the SEC's quarterly "Insider Transactions Data Sets" (structured
 * Forms 3/4/5) into research/sec_raw/ (gitignored). Read-only research input.
 *
 * The SEC's fair-access policy requires a User-Agent that names the client and
 * gives a contact email. This script never stores one: set it yourself.
 *
 *   SEC_USER_AGENT="trading-scanner-research you@example.com" node research/insider/fetch-sec.mjs [--from=2016q1]
 *
 * Uses curl (which honours the HTTPS proxy), sequential, 0.5s apart — far
 * below the SEC's 10 requests/second limit. Re-running skips files on disk.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const UA = process.env.SEC_USER_AGENT;
if (!UA || !/@/.test(UA)) {
  console.error('Set SEC_USER_AGENT to "<client name> <contact email>" first (SEC fair-access policy).');
  process.exit(1);
}
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'sec_raw');
mkdirSync(OUT, { recursive: true });
const from = (process.argv.find(a => a.startsWith('--from=')) ?? '--from=2016q1').slice(7);
let [y, q] = [Number(from.slice(0, 4)), Number(from.slice(5))];
const now = new Date(), lastY = now.getUTCFullYear();
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

let got = 0, skipped = 0, missing = [];
for (; y <= lastY; q === 4 ? (y++, q = 1) : q++) {
  const name = `${y}q${q}_form345.zip`, path = join(OUT, name);
  if (existsSync(path) && statSync(path).size > 100000) { skipped++; continue; }
  const url = `https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/${name}`;
  try {
    const code = execFileSync('curl', ['-sS', '-A', UA, '-o', path, '-w', '%{http_code}', url], { encoding: 'utf-8' }).trim();
    if (code !== '200' || statSync(path).size < 100000) { missing.push(`${name} (HTTP ${code})`); unlinkSync(path); }
    else { got++; console.log(`  ${name}  ${(statSync(path).size / 1e6).toFixed(1)} MB`); }
  } catch (e) { missing.push(`${name} (${e.message.split('\n')[0]})`); if (existsSync(path)) unlinkSync(path); }
  sleep(500);
}
console.log(`\nDownloaded ${got}, already present ${skipped}.`);
if (missing.length) console.log(`Not available (normal for the current, unpublished quarter):\n  ${missing.join('\n  ')}`);
if (missing.some(m => /HTTP 403/.test(m))) console.log('\nHTTP 403 = the SEC rejected the User-Agent: check SEC_USER_AGENT contains a real contact email.');
