#!/usr/bin/env node
/**
 * Public-repo hygiene scan: secrets, private network addresses and locally denied words
 * in every file git would publish (tracked + untracked, not ignored).
 *
 *   node .claude/skills/redteam-qa/scripts/hygiene.mjs
 *
 * Denied words (company / internal product names) live in a gitignored
 * `.hygiene-denylist.txt` at the repo root, one per line, so the list itself is never published.
 * Exit code 1 when anything is found.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean);

const RULES = [
  { name: 'OpenAI/Anthropic-style key', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'private IPv4', re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/ },
];

const denyFile = `${root}/.hygiene-denylist.txt`;
const denied = existsSync(denyFile)
  ? readFileSync(denyFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
  : [];
for (const word of denied) RULES.push({ name: 'denied word', re: new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') });

const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf)$/i;
let hits = 0;
for (const file of files) {
  if (BINARY.test(file) || file === '.hygiene-denylist.txt') continue;
  let text;
  try { text = readFileSync(`${root}/${file}`, 'utf8'); } catch { continue; }
  text.split(/\r?\n/).forEach((line, i) => {
    for (const rule of RULES) {
      const m = line.match(rule.re);
      if (m) { hits++; console.log(`${file}:${i + 1}  [${rule.name}]  ${m[0]}`); }
    }
  });
}
console.log(`\nhygiene: ${files.length} files scanned, ${denied.length} denied words, ${hits} finding(s)`);
process.exit(hits ? 1 : 0);
