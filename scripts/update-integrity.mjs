/**
 * Record a deliberate change to published data in the integrity files.
 *
 *   node scripts/update-integrity.mjs --reason "Rebuilt CTrain layers from 2027-01 GTFS" public/data/ctrain-green.geojson
 *
 * For each listed file this updates its bytes and SHA-256 in
 * data/audit/data-integrity.json or data/audit/geography-integrity.json and
 * appends a transformation entry with the reason, the date and the previous
 * and new fingerprints. A reason is required: fingerprints exist to catch
 * accidental edits, so they should only move together with an explanation.
 * Run `npm run check` afterwards.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const reasonAt = args.indexOf('--reason');
const reason = reasonAt >= 0 ? args.splice(reasonAt, 2)[1] : '';
if (!reason?.trim() || !args.length) {
  console.error('Usage: node scripts/update-integrity.mjs --reason "why the data changed" <public/data/file> ...');
  process.exit(1);
}

const root = new URL('../', import.meta.url);
const INTEGRITY_FILES = ['data/audit/data-integrity.json', 'data/audit/geography-integrity.json'];
const integrity = Object.fromEntries(
  INTEGRITY_FILES.map(path => [path, JSON.parse(fs.readFileSync(new URL(path, root), 'utf8'))]),
);
const changes = Object.fromEntries(INTEGRITY_FILES.map(path => [path, {}]));
const sections = record => [record.files, record.orientationLandmarks].filter(Boolean);

for (const file of args) {
  const owner = INTEGRITY_FILES.find(path => sections(integrity[path]).some(section => section[file]));
  if (!owner) {
    console.error(`${file} is not listed in ${INTEGRITY_FILES.join(' or ')}; add it there first.`);
    process.exit(1);
  }
  const section = sections(integrity[owner]).find(candidate => candidate[file]);
  const bytes = fs.readFileSync(new URL(file, root));
  const next = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const previous = section[file];
  if (previous.sha256 === next.sha256) {
    console.log(`${file}: unchanged`);
    continue;
  }
  changes[owner][file] = {
    inputSha256: previous.sha256,
    inputBytes: previous.bytes,
    outputSha256: next.sha256,
    outputBytes: next.bytes,
  };
  section[file] = { ...previous, ...next };
}

for (const path of INTEGRITY_FILES) {
  if (!Object.keys(changes[path]).length) continue;
  const record = integrity[path];
  record.transformations = [
    ...(record.transformations || []),
    { date: new Date().toISOString().slice(0, 10), operation: reason.trim(), files: changes[path] },
  ];
  fs.writeFileSync(new URL(path, root), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`${path}: recorded ${Object.keys(changes[path]).join(', ')}`);
}
