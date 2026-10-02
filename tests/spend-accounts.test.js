import { describe, it, expect } from 'vitest';
import { accountFromForm } from '../spend/accounts.js';

/**
 * Saving an account is an UPSERT of the whole row, so anything the form does
 * not carry is written as a default. The form had no currency field and sent
 * `currency: 'EUR'` always, so editing a GBP account — or a card account the
 * import created in another currency — silently re-denominated it. Currency
 * drives every conversion downstream, and nothing else would have caught it.
 */

const form = (over = {}) => ({ bankName: 'Bankinter', label: 'Conta à ordem', type: 'checking', currency: 'EUR', linkedAccountId: null, ...over });
const existing = (over = {}) => ({ id: 'a1', bankName: 'Bankinter', label: 'Conta', type: 'checking', currency: 'GBP', colour: '#abc123', archived: false, ...over });

describe('accountFromForm', () => {
    it('keeps an account in its own currency when the form is left as it was', () => {
        expect(accountFromForm(form({ currency: 'GBP' }), existing()).currency).toBe('GBP');
    });

    it('lets the currency be changed deliberately, normalised to ISO', () => {
        expect(accountFromForm(form({ currency: 'usd' }), existing()).currency).toBe('USD');
        expect(accountFromForm(form({ currency: ' chf ' }), existing()).currency).toBe('CHF');
    });

    it('falls back to the account\'s own currency, never to EUR, when the field is empty', () => {
        expect(accountFromForm(form({ currency: '' }), existing({ currency: 'USD' })).currency).toBe('USD');
        expect(accountFromForm(form({ currency: '' }), null).currency).toBe('EUR');   // a new account
    });

    it('refuses something that is not a currency rather than storing it', () => {
        expect(accountFromForm(form({ currency: 'euros' }), existing())).toMatch(/not a currency code/);
        expect(accountFromForm(form({ currency: 'E' }), existing())).toMatch(/not a currency code/);
    });

    it('carries over what the form does not show: colour, archived, learned references', () => {
        const a = accountFromForm(form(), existing({ colour: '#ff0000', archived: true, statementRefs: ['PT50…'] }));
        expect(a).toMatchObject({ colour: '#ff0000', archived: true, statementRefs: ['PT50…'] });
    });

    it('gives a new account a colour and no archived flag', () => {
        const a = accountFromForm(form(), null, 3);
        expect(a.colour).toMatch(/^#/);
        expect(a.archived).toBe(false);
        expect(a).not.toHaveProperty('id');
        expect(a).not.toHaveProperty('statementRefs');
    });

    it('links a funding account only for a wallet', () => {
        expect(accountFromForm(form({ type: 'wallet', linkedAccountId: 'chk' }), null).linkedAccountId).toBe('chk');
        expect(accountFromForm(form({ type: 'card', linkedAccountId: 'chk' }), null).linkedAccountId).toBeNull();
    });

    it('still requires a bank and a label', () => {
        expect(accountFromForm(form({ bankName: '  ' }), null)).toMatch(/required/);
        expect(accountFromForm(form({ label: '' }), null)).toMatch(/required/);
    });
});
