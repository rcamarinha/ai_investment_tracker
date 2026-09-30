import { describe, it, expect } from 'vitest';
import { accountRefs, matchAccount, rememberRefs, normaliseRef } from '../services/import-identity.js';

/**
 * A statement says which account it is for; the app made the person say it
 * instead, before they had even chosen the file. These pin what counts as an
 * account reference and — more importantly — what does NOT match, since a
 * current account and its card share most of their digits.
 */

// The header of a real Bankinter statement, as the PDF reader reconstructs it.
const BANKINTER = [
    'EXTRACTO Nº 301/200073864/06/26',
    'NIB: 0269 0301 00200073864 60 IBAN: PT50 0269 0301 0020 0073 8646 0 SWIFT/BIC: BKBKPTPL',
    'Período a que se referem as informações prestadas no presente extrato: de 2026/06/01 a 2026/06/30',
    'CONTA BANKINTER Nº 301200073864 Moeda: Euro',
    'Saldo em 2026/06/01                 761,67',
    '12/06 Juros deposito top 12/06                 445,90               1.207,57',
];

describe('accountRefs', () => {
    it('reads the IBAN, the NIB and the account number from a statement header', () => {
        const refs = accountRefs(BANKINTER);
        expect(refs).toContain('PT50026903010020007386460');
        expect(refs).toContain('301200073864');
        expect(refs[0].startsWith('PT')).toBe(true);   // strongest first
    });

    it('reads a card account number that mixes digits and letters', () => {
        expect(accountRefs(['Conta-Cartão: BANKINTER CLASSIC BK Nº 3014A0073864 Moeda: EUR']))
            .toContain('3014A0073864');
    });

    it('does not mistake a balance, an amount or a date for an account', () => {
        const refs = accountRefs([
            'Saldo em 2026/06/01                 761,67',
            '18/06 Liq.d.top 18/06              70.000,00              87.877,60',
            'Data de emissão do extrato atual: 2026/06/30',
        ]);
        expect(refs).toEqual([]);
    });

    it('works on a CSV preamble as well as PDF lines', () => {
        expect(accountRefs('Conta;PT50 0033 0000 4551 1122 3334 4\nData;Descritivo;Valor'))
            .toContain('PT50003300004551112233344');
    });

    it('caps how many it keeps', () => {
        const many = Array.from({ length: 30 }, (_, i) => `Conta Nº 30120007${String(i).padStart(4, '0')}`);
        expect(accountRefs(many).length).toBeLessThanOrEqual(12);
    });
});

describe('matchAccount', () => {
    const current = { id: 'chk', statementRefs: ['301200073864', 'PT50026903010020007386460'] };
    const card = { id: 'card', statementRefs: ['3014A0073864'] };

    it('files a statement against the account that printed the same reference', () => {
        expect(matchAccount(accountRefs(BANKINTER), [current, card])).toEqual({ accountId: 'chk', ref: '301200073864' });
    });

    it('never matches on a near miss — a card shares most of its digits', () => {
        expect(matchAccount(['3014A0073864'], [current]).accountId).toBeNull();
        expect(matchAccount(['30120007386'], [current]).accountId).toBeNull();   // one digit short
        expect(matchAccount(['0073864'], [current]).accountId).toBeNull();       // a suffix
    });

    it('ignores an archived account, and refuses when two accounts claim the reference', () => {
        expect(matchAccount(['301200073864'], [{ ...current, archived: true }]).accountId).toBeNull();
        const twin = { id: 'other', statementRefs: ['301200073864'] };
        const r = matchAccount(['301200073864'], [current, twin]);
        expect(r.accountId).toBeNull();
        expect(r.candidates).toEqual(['chk', 'other']);
    });

    it('says nothing when the file printed no reference, or no account knows one', () => {
        expect(matchAccount([], [current]).accountId).toBeNull();
        expect(matchAccount(['999888777'], [current]).accountId).toBeNull();
    });

    it('compares as stored, whatever the spacing', () => {
        expect(matchAccount(['PT50 0269 0301 0020 0073 8646 0'], [current]).accountId).toBe('chk');
        expect(normaliseRef('pt50 0269-0301')).toBe('PT5002690301');
    });
});

describe('rememberRefs', () => {
    it('adds what this file printed, keeps what was there, and never duplicates', () => {
        expect(rememberRefs(['301200073864'], ['PT50026903010020007386460', '301200073864']))
            .toEqual(['PT50026903010020007386460', '301200073864']);
    });

    it('caps the list, so a bank printing a new reference monthly cannot grow it forever', () => {
        const found = Array.from({ length: 20 }, (_, i) => `30120007386${i}`);
        expect(rememberRefs([], found)).toHaveLength(12);
    });
});
