const fs = require('fs');
const path = require('path');

const dirs = [
  'F:/Codex AI/The Echo Chamber/core/logs/bugs',
  'F:/Codex AI/The Echo Chamber/logs/bugs',
  'F:/Codex AI/logs/bugs'
];
const target = dirs[0];

const byDate = {};
for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter(f => f.startsWith('bugs-') && f.endsWith('.json'))) {
    const date = f.replace('bugs-','').replace('.json','');
    if (!byDate[date]) byDate[date] = [];
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      byDate[date].push(...(Array.isArray(data) ? data : [data]));
    } catch(e) {}
  }
}

let total = 0;
for (const [date, events] of Object.entries(byDate).sort()) {
  const seen = new Set();
  const unique = events.filter(e => {
    const key = (e.timestamp||'') + '|' + (e.identity||e.name||'') + '|' + (e.description||'').slice(0,50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a,b) => (a.timestamp||0) - (b.timestamp||0));
  fs.writeFileSync(path.join(target, 'bugs-' + date + '.json'), JSON.stringify(unique, null, 2));
  total += unique.length;
  console.log(date + ': ' + unique.length + ' reports');
}
console.log('Total: ' + total + ' bug reports merged');
