// Type-checks every Supabase edge function with Deno — the check the esbuild
// parse and the vitest suite cannot do, since neither sees Deno types.
//
//   npm run check:functions
//
// Supabase's deploy does NOT fail on type errors (two functions shipped with
// one for months), so a wrong argument only shows up as a broken feature in
// production. Run this before handing any function over for deploy.
//
// Uses Deno's official npm build through npx, so nothing needs installing.
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = join(process.cwd(), 'supabase', 'functions');
const fns = readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(dir, d.name, 'index.ts')))
    .map(d => d.name)
    .sort();

let failed = 0;
for (const fn of fns) {
    const res = spawnSync('npx', ['-y', 'deno@2', 'check', '--quiet', '--no-lock', join(fn, 'index.ts')], { cwd: dir, encoding: 'utf8' });
    const ok = res.status === 0;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${fn}`);
    if (!ok) console.log((res.stderr || res.stdout).replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(0, 12).join('\n'));
}
console.log(`\n${fns.length - failed}/${fns.length} functions type-check.`);
process.exit(failed ? 1 : 0);
