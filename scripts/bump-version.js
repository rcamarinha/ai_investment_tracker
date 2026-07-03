#!/usr/bin/env node
/**
 * Bump the app version everywhere it is hardcoded, in one command.
 *
 *   npm run bump 3.27.0        (or: node scripts/bump-version.js 3.27.0)
 *
 * Why this exists: the app has no build step, so the version is embedded as
 * `?v=X.Y.Z` cache-busting query strings across ~15 HTML/JS files plus header
 * labels. A single mismatched `?v=` silently forks a module instance (see
 * CLAUDE.md), so all of them MUST move together. This reads the current version
 * from package.json and rewrites every occurrence. package-lock.json is handled
 * via JSON (only the two app-version fields) so dependency versions are safe.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const SEMVER = /^\d+\.\d+\.\d+$/;

const next = process.argv[2];
if (!SEMVER.test(next || '')) {
    console.error('Usage: node scripts/bump-version.js <X.Y.Z>');
    process.exit(1);
}

const pkgPath = path.join(root, 'package.json');
const current = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
if (!SEMVER.test(current)) { console.error(`package.json version "${current}" is not X.Y.Z`); process.exit(1); }
if (current === next) { console.error(`Already at ${next}.`); process.exit(1); }

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'scripts']);
const SKIP_FILES = new Set(['package-lock.json']);   // handled via JSON below
const EXTS = new Set(['.html', '.js', '.json', '.md', '.css']);

const re = new RegExp(current.replace(/\./g, '\\.'), 'g');
const changed = [];

function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) walk(full);
            continue;
        }
        if (SKIP_FILES.has(entry.name) || !EXTS.has(path.extname(entry.name))) continue;
        const before = fs.readFileSync(full, 'utf8');
        const count = (before.match(re) || []).length;
        if (!count) continue;
        fs.writeFileSync(full, before.replace(re, next));
        changed.push(`${path.relative(root, full)} (${count})`);
    }
}
walk(root);

// package-lock.json: update only the app's own version fields, never deps.
const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    let n = 0;
    if (lock.version === current) { lock.version = next; n++; }
    if (lock.packages && lock.packages[''] && lock.packages[''].version === current) { lock.packages[''].version = next; n++; }
    if (n) { fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n'); changed.push(`package-lock.json (${n})`); }
}

if (changed.length === 0) {
    console.log(`No occurrences of ${current} found — nothing changed.`);
} else {
    console.log(`Bumped ${current} → ${next} in ${changed.length} file(s):`);
    changed.forEach(f => console.log('  ' + f));
    console.log('\nReminder: add a README changelog entry for ' + next + '.');
}
