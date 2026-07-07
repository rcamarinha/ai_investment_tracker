/**
 * Tests for setUntracked() — the "kept at cost" persistence function added in PR #211.
 *
 * Regression risk: setUntracked is the linchpin between the UI "keep at cost" / "re-enable
 * pricing" actions and the in-memory state + DB. Silent bugs here mean users are permanently
 * locked out of live pricing with no recovery path.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import state from '../services/state.js';
import { setUntracked } from '../services/pricing.js';

// saveAssetsToDB hits Supabase — not available in unit tests. setUntracked wraps
// it in try/catch, so the mock just prevents spurious console warnings.
vi.mock('../services/storage.js', () => ({
    saveAssetsToDB: vi.fn(),
    loadAssetsFromDB: vi.fn(),
    savePriceHistoryToDB: vi.fn(),
    enrichUnknownAssets: vi.fn(),
    saveSnapshotToDB: vi.fn(),
    clearHistoryFromDB: vi.fn(),
    savePortfolioDB: vi.fn(),
    saveTransactionsToDB: vi.fn(),
    deleteTransactionsForSymbol: vi.fn(),
    deleteSnapshotFromDB: vi.fn(),
    initSupabase: vi.fn(),
    loadFromDatabase: vi.fn(),
}));

vi.mock('../services/portfolio.js', () => ({
    renderPortfolio: vi.fn(),
    renderMoversSection: vi.fn(),
    savePortfolioSnapshot: vi.fn(),
}));

vi.mock('../services/analysis.js', () => ({
    analyzeMovers: vi.fn(),
}));

beforeEach(() => {
    state.assetDatabase = {};
    state.portfolio = [];
});

// ── null / empty symbol guards ────────────────────────────────────────────────

describe('setUntracked — null / empty symbol guards', () => {
    it('does nothing for null symbol', () => {
        setUntracked(null, true);
        expect(Object.keys(state.assetDatabase)).toHaveLength(0);
    });

    it('does nothing for undefined symbol', () => {
        setUntracked(undefined, false);
        expect(Object.keys(state.assetDatabase)).toHaveLength(0);
    });

    it('does nothing for empty-string symbol', () => {
        setUntracked('', true);
        expect(Object.keys(state.assetDatabase)).toHaveLength(0);
    });
});

// ── assetDatabase mutations ───────────────────────────────────────────────────

describe('setUntracked — assetDatabase mutations', () => {
    it('sets untracked: true for a new symbol', () => {
        setUntracked('AAPL', true);
        expect(state.assetDatabase['AAPL'].untracked).toBe(true);
    });

    it('sets untracked: false for a new symbol', () => {
        setUntracked('MSFT', false);
        expect(state.assetDatabase['MSFT'].untracked).toBe(false);
    });

    it('overwrites an existing untracked: true with false', () => {
        state.assetDatabase['NVDA'] = { ticker: 'NVDA', untracked: true, sector: 'Technology' };
        setUntracked('NVDA', false);
        expect(state.assetDatabase['NVDA'].untracked).toBe(false);
    });

    it('overwrites an existing untracked: false with true', () => {
        state.assetDatabase['SPY'] = { ticker: 'SPY', untracked: false };
        setUntracked('SPY', true);
        expect(state.assetDatabase['SPY'].untracked).toBe(true);
    });

    it('always sets ticker to the provided symbol', () => {
        setUntracked('GOOG', true);
        expect(state.assetDatabase['GOOG'].ticker).toBe('GOOG');
    });

    it('preserves existing fields when updating', () => {
        state.assetDatabase['AMZN'] = { ticker: 'AMZN', sector: 'Consumer', currency: 'USD', untracked: false };
        setUntracked('AMZN', true);
        expect(state.assetDatabase['AMZN'].sector).toBe('Consumer');
        expect(state.assetDatabase['AMZN'].currency).toBe('USD');
        expect(state.assetDatabase['AMZN'].ticker).toBe('AMZN');
        expect(state.assetDatabase['AMZN'].untracked).toBe(true);
    });

    it('only mutates the targeted symbol', () => {
        state.assetDatabase['TSLA'] = { ticker: 'TSLA', untracked: false };
        state.assetDatabase['META'] = { ticker: 'META', untracked: false };
        setUntracked('TSLA', true);
        expect(state.assetDatabase['TSLA'].untracked).toBe(true);
        expect(state.assetDatabase['META'].untracked).toBe(false);
    });

    it('coerces truthy non-boolean to true via !!', () => {
        setUntracked('INTC', 1);
        expect(state.assetDatabase['INTC'].untracked).toBe(true);
    });

    it('coerces falsy non-boolean to false via !!', () => {
        setUntracked('AMD', 0);
        expect(state.assetDatabase['AMD'].untracked).toBe(false);
    });
});

// ── portfolio position mutations ──────────────────────────────────────────────

describe('setUntracked — portfolio position mutations', () => {
    it('updates untracked on a matching portfolio position', () => {
        state.portfolio = [{ symbol: 'AAPL', shares: 10, untracked: false }];
        setUntracked('AAPL', true);
        expect(state.portfolio[0].untracked).toBe(true);
    });

    it('clears untracked on a matching portfolio position', () => {
        state.portfolio = [{ symbol: 'MSFT', shares: 5, untracked: true }];
        setUntracked('MSFT', false);
        expect(state.portfolio[0].untracked).toBe(false);
    });

    it('does not create a portfolio entry when symbol is not found', () => {
        state.portfolio = [{ symbol: 'OTHER', shares: 1 }];
        setUntracked('NOTHERE', true);
        expect(state.portfolio).toHaveLength(1);
        expect(state.portfolio[0].symbol).toBe('OTHER');
    });

    it('only updates the matching position, leaves others unchanged', () => {
        state.portfolio = [
            { symbol: 'AAPL', shares: 10, untracked: false },
            { symbol: 'GOOG', shares: 3, untracked: false },
        ];
        setUntracked('AAPL', true);
        expect(state.portfolio[0].untracked).toBe(true);
        expect(state.portfolio[1].untracked).toBe(false);
    });
});
