/**
 * Extracts open-market insider PURCHASES (Form 4, transaction code P, acquired)
 * from the SEC quarterly data sets in research/sec_raw/ into
 * research/insider/purchases.csv (gitignored). Offline; no network.
 *
 *   node research/insider/build-insider.mjs
 */
import { spawnSync } from 'child_process';
import { readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = join(__dirname, '..', 'sec_raw');
const zips = readdirSync(RAW).filter(f => /^\d{4}q\d_form345\.zip$/.test(f)).sort();
if (!zips.length) { console.error('No data in research/sec_raw — run fetch-sec.mjs first.'); process.exit(1); }

const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const isoDate = s => {
  s = (s ?? '').trim();
  let m = s.match(/^(\d{2})-([A-Z]{3})-(\d{4})$/i); if (m) return `${m[3]}-${MON[m[2].toUpperCase()]}-${m[1]}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
};
function readTsv(zip, file) {
  const r = spawnSync('unzip', ['-p', join(RAW, zip), file], { maxBuffer: 2 ** 31 - 1, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`${zip}: cannot read ${file}`);
  const lines = r.stdout.split('\n'); const head = lines[0].replace(/\r$/, '').split('\t');
  const col = names => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } throw new Error(`${zip}/${file}: none of ${names} in header: ${head.join(',')}`); };
  return { lines, col };
}

const out = ['symbol,filing_date,trans_date,owner_cik,is_director,is_officer,is_ten_pct,title,shares,price,value,accession'];
let total = 0;
for (const zip of zips) {
  const sub = readTsv(zip, 'SUBMISSION.tsv');
  const [sA, sF, sD, sS] = [sub.col(['ACCESSION_NUMBER']), sub.col(['FILING_DATE']), sub.col(['DOCUMENT_TYPE']), sub.col(['ISSUERTRADINGSYMBOL'])];
  const subm = new Map();
  for (let k = 1; k < sub.lines.length; k++) {
    const f = sub.lines[k].split('\t'); if (f.length < 3) continue;
    if (f[sD].trim() !== '4') continue; // originals only; amendments would double-count
    const sym = (f[sS] ?? '').trim().toUpperCase().replace(/\./g, '-');
    if (!sym || sym === 'NONE' || sym === 'N/A') continue;
    subm.set(f[sA], { fd: isoDate(f[sF]), sym });
  }
  const own = readTsv(zip, 'REPORTINGOWNER.tsv');
  const [oA, oC, oR, oT] = [own.col(['ACCESSION_NUMBER']), own.col(['RPTOWNERCIK']), own.col(['RPTOWNER_RELATIONSHIP']), own.col(['RPTOWNER_TITLE'])];
  const owners = new Map();
  for (let k = 1; k < own.lines.length; k++) {
    const f = own.lines[k].split('\t'); if (f.length < 3 || !subm.has(f[oA])) continue;
    const rel = (f[oR] ?? '').toLowerCase();
    (owners.get(f[oA]) ?? owners.set(f[oA], []).get(f[oA])).push({ cik: f[oC].trim(), dir: /director/.test(rel), off: /officer/.test(rel), ten: /tenpercent|10%|ten percent/.test(rel.replace(/\s/g, '')) || /tenpercent/.test(rel), title: (f[oT] ?? '').replace(/[",\r]/g, ' ').trim() });
  }
  const tr = readTsv(zip, 'NONDERIV_TRANS.tsv');
  const [tA, tD, tC, tS, tP, tAD] = [tr.col(['ACCESSION_NUMBER']), tr.col(['TRANS_DATE']), tr.col(['TRANS_CODE']), tr.col(['TRANS_SHARES']), tr.col(['TRANS_PRICEPERSHARE']), tr.col(['TRANS_ACQUIRED_DISP_CD'])];
  let n = 0;
  for (let k = 1; k < tr.lines.length; k++) {
    const f = tr.lines[k].split('\t'); if (f.length < 5) continue;
    if ((f[tC] ?? '').trim() !== 'P' || (f[tAD] ?? '').trim() !== 'A') continue;
    const s = subm.get(f[tA]); if (!s || !s.fd) continue;
    const sh = Number(f[tS]), px = Number(f[tP]); if (!(sh > 0) || !(px > 0)) continue;
    const os = owners.get(f[tA]) ?? []; if (!os.length) continue;
    const o = os[0]; // joint filings: attribute to the first listed owner
    out.push([s.sym, s.fd, isoDate(f[tD]) ?? '', o.cik, +o.dir, +o.off, +o.ten, `"${o.title}"`, sh, px, (sh * px).toFixed(0), f[tA]].join(','));
    n++;
  }
  total += n;
  console.log(`  ${zip}: ${subm.size} Form 4 filings, ${n} open-market purchases`);
}
writeFileSync(join(__dirname, 'purchases.csv'), out.join('\n') + '\n');
console.log(`\n${total} purchase transactions -> research/insider/purchases.csv`);
