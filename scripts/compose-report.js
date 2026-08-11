#!/usr/bin/env node
// Merges every gate report into the single comment that gets written back to GitHub.
//
// A missing report counts as a failure. A job that crashes before writing one must
// never look like a pass - a monitor that silently breaks is worse than no monitor.
import fs from 'node:fs';
import path from 'node:path';
import { renderMarkdown } from './lib/report.js';

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith('--')) || 'reports';
const checkOnly = args.includes('--check');

const GATES = [
  { slug: 'fast', label: 'fast gate' },
  { slug: 'e2e', label: 'browser gate' }
];

function findReport(slug) {
  const hits = [];
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === `report-${slug}.json`) hits.push(p);
    }
  };
  walk(dir);
  return hits[0] || null;
}

let failed = false;
let passedCount = 0;
let totalCount = 0;
const sections = [];

for (const gate of GATES) {
  const file = findReport(gate.slug);
  if (!file) {
    failed = true;
    sections.push(`### ❌ ${gate.label} — no report produced\n\nThe job crashed before writing its report, or the artifact never uploaded. Counted as a failure on purpose.\n`);
    continue;
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data.ok) failed = true;
  passedCount += data.passed;
  totalCount += data.total;
  sections.push(renderMarkdown(data));
}

const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
const repo = process.env.GITHUB_REPOSITORY || '';
const runId = process.env.GITHUB_RUN_ID || '';
const sha = (process.env.GITHUB_SHA || 'local').slice(0, 7);
const runLink = runId ? ` · [run](${server}/${repo}/actions/runs/${runId})` : '';
const header = `${failed ? '❌ **verify failed**' : '✅ **verify passed**'} — ${passedCount}/${totalCount} checks passed · commit \`${sha}\`${runLink}`;
const body = [header, '', ...sections].join('\n');

if (checkOnly) {
  process.stdout.write(`${failed ? 'FAILED' : 'PASSED'}: ${passedCount}/${totalCount} checks\n`);
  process.exit(failed ? 1 : 0);
}

fs.writeFileSync('comment.md', body.slice(0, 60000));
process.stdout.write(body + '\n');
