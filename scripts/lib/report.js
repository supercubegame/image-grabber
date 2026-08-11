// Shared report builder for every gate.
//
// Iron rule: a failing check must carry enough evidence to find the root cause
// from the posted comment alone - expected vs actual, or the tail of the child
// process output. "1 check failed" with no detail is the same as no report.
import fs from 'node:fs';
import path from 'node:path';

export class Report {
  constructor(name) {
    this.name = name;
    this.checks = [];
  }

  record(title, ok, detail, evidence, skipped = false) {
    const entry = {
      title,
      ok: Boolean(ok),
      skipped,
      detail: String(detail == null ? '' : detail),
      evidence: evidence == null ? null : String(evidence)
    };
    this.checks.push(entry);
    const icon = skipped ? 'SKIP' : (entry.ok ? 'PASS' : 'FAIL');
    process.stdout.write(`${icon}  ${title}\n      ${entry.detail.split('\n')[0]}\n`);
    if (!entry.ok && entry.evidence) {
      process.stdout.write(entry.evidence.split('\n').map(l => '      | ' + l).join('\n') + '\n');
    }
    return entry;
  }

  check(title, fn) {
    try {
      return this.record(title, true, fn());
    } catch (err) {
      return this.record(title, false, err && err.message ? err.message : String(err), err && err.evidence);
    }
  }

  async checkAsync(title, fn) {
    try {
      return this.record(title, true, await fn());
    } catch (err) {
      return this.record(title, false, err && err.message ? err.message : String(err), err && err.evidence);
    }
  }

  skip(title, reason) {
    return this.record(title, false, reason, null, true);
  }

  get total() { return this.checks.length; }
  get passed() { return this.checks.filter(c => c.ok).length; }
  get failed() { return this.checks.filter(c => !c.ok).length; }
  get ok() { return this.total > 0 && this.failed === 0; }

  toJSON() {
    return {
      name: this.name,
      total: this.total,
      passed: this.passed,
      failed: this.failed,
      ok: this.ok,
      generatedAt: new Date().toISOString(),
      checks: this.checks
    };
  }

  toMarkdown() { return renderMarkdown(this.toJSON()); }

  save(dir, slug) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `report-${slug}.json`), JSON.stringify(this.toJSON(), null, 2));
    fs.writeFileSync(path.join(dir, `report-${slug}.md`), this.toMarkdown());
  }
}

export function renderMarkdown(data) {
  const head = `### ${data.ok ? '✅' : '❌'} ${data.name} — ${data.passed}/${data.total} checks passed`;
  const rows = data.checks.map(c => `| ${c.skipped ? '⏭️' : (c.ok ? '✅' : '❌')} | ${cell(c.title)} | ${cell(oneLine(c.detail))} |`);
  const table = ['| | check | detail |', '| --- | --- | --- |', ...rows].join('\n');
  const details = data.checks
    .filter(c => !c.ok && c.evidence)
    .map(c => `<details><summary>❌ ${cell(c.title)} — evidence</summary>\n\n\`\`\`\n${String(c.evidence).slice(-4000)}\n\`\`\`\n\n</details>`)
    .join('\n\n');
  return [head, '', table, '', details].join('\n').trim() + '\n';
}

function oneLine(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, 300); }
function cell(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|'); }
