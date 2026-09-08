import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { __testing } from '../services/telemetry.js';

/**
 * How this app is required to handle failure — and the checks that make it true.
 *
 * The rules:
 *
 *   1. A failure the user must know about  -> a toast AND reportHandled().
 *   2. A failure the user need not know about -> reportHandled() alone. Never
 *      nothing, and never console.error as the only handler.
 *   3. alert() is not a failure handler. It blocks the page, it reports nothing,
 *      and it is absent from every module written since.
 *   4. An operation whose CORRECTNESS CANNOT BE CHECKED AT THE TIME IT RUNS —
 *      importing a statement or a broker export, valuing a cellar — writes a
 *      reportDiagnostic() saying how it went, whether or not it threw.
 *   5. Every context key must be in ALLOWED_CONTEXT_KEYS.
 *   6. Every page installs the reporter.
 *
 * Rule 4 exists because rules 1-3 would not have caught a single import bug
 * found in this codebase. A mortgage section imported as income, a card bill
 * counted twice, a debit read as a credit: all silent wrong results, none of
 * them an exception. An error log stays empty through every one of them.
 *
 * Rule 5 is the one enforced hardest, because breaking it is invisible.
 * pickContext() copies only keys it recognises and drops the rest without a
 * word, so a diagnostic written with `rowsParsed` instead of `parsed` still
 * sends, still looks healthy, and carries nothing. The check below reads the
 * allow-list FROM telemetry.js rather than restating it — the lesson of
 * db-constraints.test.js, where a restated rule would have drifted from the one
 * actually enforced.
 *
 * Deliberately NOT asserted here: "every catch must report". That rule is real
 * but it is a shape, not an invariant — a legitimately silent catch exists
 * (telemetry's own reporter must swallow its own failures or recurse), and a
 * test of shape rots into a test of style. It belongs on the pre-push checklist,
 * where a human can weigh it, not in an assertion that fails on a judgement call.
 */

const root = join(import.meta.dirname, '..');
const MODULE_DIRS = ['services', 'spend', 'wine', 'holdings', 'src'];
const PAGES = ['index.html', 'portfolio.html', 'wine.html', 'spend.html', 'holdings.html'];

const sources = MODULE_DIRS.flatMap(dir => {
    const abs = join(root, dir);
    if (!existsSync(abs)) return [];
    return readdirSync(abs).filter(f => f.endsWith('.js'))
        .map(f => ({ path: `${dir}/${f}`, text: readFileSync(join(abs, f), 'utf8') }));
});

/** Top-level keys of the object literal passed as the last argument to a report call. */
function reportedKeys(text) {
    const found = [];
    const call = /report(?:Handled|Diagnostic)\s*\(/g;
    let m;
    while ((m = call.exec(text))) {
        // Walk to the object literal, then to its matching brace, so nested
        // objects and strings containing braces do not confuse the scan.
        const open = text.indexOf('{', m.index);
        if (open === -1) continue;
        const end = text.indexOf(')', m.index);
        if (open > end && end !== -1) continue;             // no object argument
        let depth = 0, i = open;
        for (; i < text.length; i++) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}' && --depth === 0) break;
        }
        const body = text.slice(open + 1, i);
        let nest = 0;
        for (const line of body.split('\n')) {
            const key = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
            if (nest === 0 && key) found.push(key[1]);
            nest += (line.match(/[{[]/g) || []).length - (line.match(/[}\]]/g) || []).length;
        }
    }
    return found;
}

describe('failure handling is consistent across the app', () => {
    it('reads its allow-list from telemetry rather than restating it', () => {
        expect(Array.isArray(__testing.ALLOWED_CONTEXT_KEYS)).toBe(true);
        expect(__testing.ALLOWED_CONTEXT_KEYS).toContain('action');
    });

    it('never reports a context key that would be silently dropped', () => {
        const allowed = new Set(__testing.ALLOWED_CONTEXT_KEYS);
        const offenders = [];
        for (const { path, text } of sources) {
            for (const key of reportedKeys(text)) {
                if (!allowed.has(key)) offenders.push(`${path}: ${key}`);
            }
        }
        // pickContext drops an unrecognised key without a word, so the report
        // still sends and still looks healthy while carrying nothing.
        expect(offenders, 'add the key to ALLOWED_CONTEXT_KEYS in services/telemetry.js, or rename it to one that exists').toEqual([]);
    });

    it('installs the reporter on every page', () => {
        const blind = PAGES.filter(p =>
            existsSync(join(root, p)) && !readFileSync(join(root, p), 'utf8').includes('installErrorReporting'));
        expect(blind, 'a page without installErrorReporting reports nothing at all').toEqual([]);
    });

    it('writes a diagnostic wherever correctness cannot be checked as it runs', () => {
        // Named one by one rather than inferred: this is the list of places
        // where being wrong is both possible and invisible.
        const mustDiagnose = [
            { path: 'spend/importer.js',    what: 'statement import' },
            { path: 'services/portfolio.js', what: 'broker trade import' }
        ];
        const missing = mustDiagnose.filter(({ path }) => {
            const src = sources.find(s => s.path === path);
            return !src || !src.text.includes('reportDiagnostic(');
        });
        expect(missing.map(m => m.what), 'this operation can be wrong without throwing, so it must record how it went').toEqual([]);
    });

    it('keeps alert() out of the modules written since it was abandoned', () => {
        const offenders = sources
            .filter(s => /^(spend|wine|holdings|src)\//.test(s.path) && /\balert\s*\(/.test(s.text))
            .map(s => s.path);
        expect(offenders, 'alert() blocks the page and reports nothing — use the module toast').toEqual([]);
    });
});
