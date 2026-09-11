import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { escapeHTML as servicesEscape } from '../services/utils.js';
import { escapeHTML as spendEscape } from '../spend/utils.js';
import { escapeHTML as wineEscape } from '../wine/utils.js';
import { escapeHTML as holdingsEscape } from '../holdings/utils.js';

/**
 * Two rules about getting a value into markup, and the checks that make them true.
 *
 *   1. Every escapeHTML in the app escapes ALL FIVE characters, not three.
 *   2. No value is ever interpolated into an inline event-handler attribute.
 *
 * Rule 1 exists because `services/utils.js` used to build a <div>, set its
 * textContent and read back innerHTML. That is the HTML fragment serialisation
 * of a TEXT NODE: it escapes &, < and > and leaves BOTH quote characters alone.
 * Safe in text position, unsafe in attribute position, and it was used in both.
 * The wine, spend and holdings copies always escaped all five. Services was the
 * only one that did not, and the value that reached it — a sector name — comes
 * from a catalogue table any authenticated account can write.
 *
 * Rule 2 exists because escaping does not save an inline handler. The parser
 * HTML-decodes an attribute BEFORE its contents are compiled as JavaScript, so
 * `&#x27;` is a real quote again by the time it matters. The durable fix is a
 * `data-` attribute read back as a string — see bindActions in services/utils.js
 * and bindDelegation in spend/ledger.js.
 *
 * Both checks read the source rather than restating it, so neither can drift.
 */

const ROOT = join(import.meta.dirname, '..');
const SOURCE_DIRS = ['services', 'src', 'data', 'wine', 'spend', 'holdings'];

function jsFilesUnder(dir) {
    const abs = join(ROOT, dir);
    const out = [];
    for (const entry of readdirSync(abs)) {
        const full = join(abs, entry);
        if (statSync(full).isDirectory()) continue;
        if (entry.endsWith('.js')) out.push(full);
    }
    return out;
}

describe('escapeHTML is the same function everywhere', () => {
    const copies = {
        services: servicesEscape,
        spend: spendEscape,
        wine: wineEscape,
        holdings: holdingsEscape,
    };

    // The payload that actually mattered: a double quote closes the attribute
    // and opens a new event handler in the owner's session.
    const attack = 'Tech" onmouseover="alert(1)';

    for (const [name, fn] of Object.entries(copies)) {
        it(`${name} escapes both quote characters`, () => {
            expect(fn('"')).toBe('&quot;');
            expect(fn("'")).toBe('&#x27;');
        });

        it(`${name} escapes the three markup characters`, () => {
            expect(fn('&')).toBe('&amp;');
            expect(fn('<')).toBe('&lt;');
            expect(fn('>')).toBe('&gt;');
        });

        it(`${name} leaves no quote in an attacker-shaped sector name`, () => {
            expect(fn(attack)).not.toContain('"');
            expect(fn(attack)).toBe('Tech&quot; onmouseover=&quot;alert(1)');
        });

        it(`${name} treats null and undefined as empty, not as text`, () => {
            expect(fn(null)).toBe('');
            expect(fn(undefined)).toBe('');
            // 0 and false are values, not absences.
            expect(fn(0)).toBe('0');
            expect(fn(false)).toBe('false');
        });
    }

    it('all four copies agree character for character', () => {
        const samples = ['', 'plain', attack, `it's`, '<b>&</b>', '"\'&<>', '0', 'Ação & Cia'];
        for (const sample of samples) {
            const results = Object.values(copies).map(fn => fn(sample));
            expect(new Set(results).size, `disagreement on ${JSON.stringify(sample)}`).toBe(1);
        }
    });
});

describe('no value is interpolated into an inline event handler', () => {
    // Any on*="..." attribute carrying a template placeholder.
    const INTERPOLATED_HANDLER = /\bon[a-z]+\s*=\s*"[^"]*\$\{/;

    for (const dir of SOURCE_DIRS) {
        it(`${dir}/ has no interpolated handler attribute`, () => {
            const offenders = [];
            for (const file of jsFilesUnder(dir)) {
                const lines = readFileSync(file, 'utf8').split('\n');
                lines.forEach((line, i) => {
                    if (INTERPOLATED_HANDLER.test(line)) {
                        offenders.push(`${dir}/${file.split('/').pop()}:${i + 1}`);
                    }
                });
            }
            expect(offenders, 'use a data- attribute and a delegated listener instead').toEqual([]);
        });
    }
});
