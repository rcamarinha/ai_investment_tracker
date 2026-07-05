import { describe, it, expect, beforeEach } from 'vitest';
import { setUntracked } from '../services/pricing.js';
import state from '../services/state.js';

// Reset the shared state slices touched by setUntracked before every test so
// tests are fully independent of each other.
beforeEach(() => {
    state.assetDatabase = {};
    state.portfolio = [];
});

describe('setUntracked', () => {
    it('no-ops when symbol is null', () => {
        setUntracked(null, true);
        expect(Object.keys(state.assetDatabase)).toHaveLength(0);
    });

    it('no-ops when symbol is empty string', () => {
        setUntracked('', true);
        expect(Object.keys(state.assetDatabase)).toHaveLength(0);
    });

    it('no-ops when symbol is undefined', () => {
        setUntracked(undefined, true);
        expect(Object.keys(state.assetDatabase)).toHaveLength(0);
    });

    it('sets untracked: true on state.assetDatabase for a new symbol', () => {
        setUntracked('AAPL', true);
        expect(state.assetDatabase['AAPL']).toMatchObject({ ticker: 'AAPL', untracked: true });
    });

    it('sets untracked: false when re-enabling pricing', () => {
        state.assetDatabase['AAPL'] = { ticker: 'AAPL', untracked: true };
        setUntracked('AAPL', false);
        expect(state.assetDatabase['AAPL'].untracked).toBe(false);
    });

    it('preserves other fields already in assetDatabase', () => {
        state.assetDatabase['AAPL'] = { ticker: 'AAPL', name: 'Apple Inc.', sector: 'Technology', currency: 'USD' };
        setUntracked('AAPL', true);
        expect(state.assetDatabase['AAPL']).toMatchObject({
            ticker: 'AAPL',
            name: 'Apple Inc.',
            sector: 'Technology',
            currency: 'USD',
            untracked: true,
        });
    });

    it('updates the matching portfolio position untracked flag to true', () => {
        state.portfolio.push({ symbol: 'MSFT', shares: 10, avgPrice: 300 });
        setUntracked('MSFT', true);
        const pos = state.portfolio.find(p => p.symbol === 'MSFT');
        expect(pos.untracked).toBe(true);
    });

    it('updates the matching portfolio position untracked flag to false', () => {
        state.portfolio.push({ symbol: 'MSFT', shares: 10, untracked: true });
        setUntracked('MSFT', false);
        const pos = state.portfolio.find(p => p.symbol === 'MSFT');
        expect(pos.untracked).toBe(false);
    });

    it('does not create a portfolio entry when symbol is not in portfolio', () => {
        setUntracked('NVDA', true);
        expect(state.portfolio).toHaveLength(0);
        // assetDatabase is still updated
        expect(state.assetDatabase['NVDA'].untracked).toBe(true);
    });

    it('only updates the matching portfolio position, not others', () => {
        state.portfolio.push({ symbol: 'AAPL', shares: 5 });
        state.portfolio.push({ symbol: 'MSFT', shares: 10 });
        setUntracked('AAPL', true);
        expect(state.portfolio.find(p => p.symbol === 'AAPL').untracked).toBe(true);
        expect(state.portfolio.find(p => p.symbol === 'MSFT').untracked).toBeUndefined();
    });

    it('coerces truthy non-boolean flag to true', () => {
        setUntracked('AAPL', 1);
        expect(state.assetDatabase['AAPL'].untracked).toBe(true);
    });

    it('coerces falsy non-boolean flag (0) to false', () => {
        state.assetDatabase['AAPL'] = { ticker: 'AAPL', untracked: true };
        setUntracked('AAPL', 0);
        expect(state.assetDatabase['AAPL'].untracked).toBe(false);
    });
});
