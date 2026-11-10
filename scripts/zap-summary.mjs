// Summarizes a ZAP JSON report by risk and exits 1 when a High-risk alert is present.
// Alerts for rules marked IGNORE in rules.tsv are listed but never fail the run.
//
//   node scripts/zap-summary.mjs <zap-report.json> <rules.tsv>
import { appendFileSync, readFileSync } from 'node:fs';

const [reportPath, rulesPath] = process.argv.slice(2);
if (!reportPath || !rulesPath) {
  console.error('usage: node scripts/zap-summary.mjs <zap-report.json> <rules.tsv>');
  process.exit(2);
}

const ignored = new Set(
  readFileSync(rulesPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((line) => line.split('\t'))
    .filter(([, action]) => action?.trim() === 'IGNORE')
    .map(([id]) => id.trim()),
);

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const riskNames = { 3: 'High', 2: 'Medium', 1: 'Low', 0: 'Informational' };
const counts = { High: 0, Medium: 0, Low: 0, Informational: 0 };
let ignoredCount = 0;
const rows = [];

for (const site of report.site ?? []) {
  for (const alert of site.alerts ?? []) {
    const risk = riskNames[Number(alert.riskcode)] ?? 'Informational';
    const isIgnored = ignored.has(String(alert.pluginid));
    if (isIgnored) ignoredCount++;
    else counts[risk]++;
    const instances = alert.count ?? alert.instances?.length ?? 0;
    rows.push(
      `| ${risk}${isIgnored ? ' (ignored)' : ''} | ${alert.pluginid} | ${alert.name} | ${instances} |`,
    );
  }
}

const summary = [
  '### ZAP baseline summary',
  '',
  `High: ${counts.High} | Medium: ${counts.Medium} | Low: ${counts.Low} | ` +
    `Informational: ${counts.Informational} | Ignored by rules.tsv: ${ignoredCount}`,
  '',
  ...(rows.length > 0
    ? ['| Risk | Rule | Alert | Instances |', '| --- | --- | --- | --- |', ...rows]
    : ['No alerts.']),
  '',
].join('\n');

console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);

if (counts.High > 0) {
  console.error(`FAIL: ${counts.High} High-risk alert(s). See zap/reports/zap-report.html`);
  process.exit(1);
}
