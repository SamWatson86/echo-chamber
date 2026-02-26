#!/usr/bin/env node
/**
 * merge-session-logs.js
 *
 * Merges session log JSON files from multiple directories into the canonical
 * directory (core/logs/sessions/). Deduplicates by timestamp+identity+event_type,
 * sorts by timestamp, and writes merged results.
 */

const fs = require('fs');
const path = require('path');

// Source directories (order: canonical first, then others)
const CANONICAL_DIR = path.join(__dirname, '..', 'core', 'logs', 'sessions');
const SOURCE_DIRS = [
  CANONICAL_DIR,
  path.join(__dirname, '..', 'logs', 'sessions'),
  path.join(__dirname, '..', '..', 'logs', 'sessions'),
];

function loadSessionFiles(dir) {
  const files = {};
  if (!fs.existsSync(dir)) {
    return files;
  }
  const entries = fs.readdirSync(dir).filter(f => f.startsWith('sessions-') && f.endsWith('.json'));
  for (const entry of entries) {
    const dateMatch = entry.match(/sessions-(\d{4}-\d{2}-\d{2})\.json/);
    if (!dateMatch) continue;
    const date = dateMatch[1];
    const filePath = path.join(dir, entry);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const events = JSON.parse(raw);
      if (Array.isArray(events)) {
        files[date] = { events, path: filePath, size: fs.statSync(filePath).size };
      }
    } catch (err) {
      console.error(`  WARNING: Failed to parse ${filePath}: ${err.message}`);
    }
  }
  return files;
}

function dedupeKey(event) {
  return `${event.timestamp}|${event.identity || ''}|${event.event_type || ''}`;
}

function mergeEvents(arraysOfEvents) {
  const seen = new Map();
  for (const events of arraysOfEvents) {
    for (const event of events) {
      const key = dedupeKey(event);
      if (!seen.has(key)) {
        seen.set(key, event);
      } else {
        // Keep the version with more fields (e.g., one with duration_secs)
        const existing = seen.get(key);
        if (Object.keys(event).length > Object.keys(existing).length) {
          seen.set(key, event);
        }
      }
    }
  }
  const merged = Array.from(seen.values());
  merged.sort((a, b) => a.timestamp - b.timestamp);
  return merged;
}

function main() {
  console.log('=== Session Log Merger ===\n');

  // Load files from all directories
  const allDirFiles = [];
  for (const dir of SOURCE_DIRS) {
    console.log(`Scanning: ${dir}`);
    const files = loadSessionFiles(dir);
    const dates = Object.keys(files);
    if (dates.length === 0) {
      console.log('  (no files found)\n');
    } else {
      for (const d of dates.sort()) {
        console.log(`  ${d}: ${files[d].events.length} events (${files[d].size} bytes)`);
      }
      console.log('');
    }
    allDirFiles.push({ dir, files });
  }

  // Collect all dates
  const allDates = new Set();
  for (const { files } of allDirFiles) {
    for (const date of Object.keys(files)) {
      allDates.add(date);
    }
  }

  const sortedDates = Array.from(allDates).sort();
  console.log(`\nDates found: ${sortedDates.length}`);
  console.log('---');

  let totalMerged = 0;
  let totalWritten = 0;

  for (const date of sortedDates) {
    const sources = [];
    const sourceLabels = [];

    for (const { dir, files } of allDirFiles) {
      if (files[date]) {
        sources.push(files[date].events);
        const label = dir === CANONICAL_DIR ? 'canonical' :
                      dir.includes('Echo Chamber') ? 'repo/logs' : 'stray';
        sourceLabels.push(`${label}(${files[date].events.length})`);
      }
    }

    // Count total events before merge
    const totalBefore = sources.reduce((sum, arr) => sum + arr.length, 0);

    // Merge and deduplicate
    const merged = mergeEvents(sources);

    const deduped = totalBefore - merged.length;

    // Write to canonical directory
    const outPath = path.join(CANONICAL_DIR, `sessions-${date}.json`);
    const json = JSON.stringify(merged, null, 2) + '\n';
    fs.writeFileSync(outPath, json, 'utf-8');

    const outSize = fs.statSync(outPath).size;

    console.log(
      `${date}: ${sourceLabels.join(' + ')} => ${merged.length} events ` +
      `(${deduped} dupes removed) => ${outSize} bytes`
    );

    totalMerged += merged.length;
    totalWritten++;
  }

  console.log('\n=== Summary ===');
  console.log(`Files written: ${totalWritten}`);
  console.log(`Total events:  ${totalMerged}`);
  console.log(`Output dir:    ${CANONICAL_DIR}`);
}

main();
