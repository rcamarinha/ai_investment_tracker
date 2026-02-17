/**
 * Storage service — Supabase DB, localStorage, and Claude cloud storage.
 */

import state from './state.js';
import { buildAssetRecord } from './utils.js';
import { updateAuthBar, checkUserRole } from './auth.js';
import { renderPortfolio, updateHistoryDisplay } from './portfolio.js';
import { fetchAssetProfile } from './pricing.js';

// ── Supabase Initialization ─────────────────────────────────────────────────

export function initSupabase() {
    if (!state.supabaseUrl || !state.supabaseAnonKey) {
        updateAuthBar();
        return false;
    }
    try {
        state.supabaseClient = supabase.createClient(state.supabaseUrl, state.supabaseAnonKey);

        state.supabaseClient.auth.onAuthStateChange((event, session) => {
            state.currentUser = session?.user || null;
            updateAuthBar();
            if (event === 'SIGNED_IN') {
                loadFromDatabase();
            } else if (event === 'SIGNED_OUT') {
                // Clear user-specific state (handles session expiry, sign-out from other tabs)
                state.portfolio = [];
                state.portfolioHistory = [];
                state.marketPrices = {};
                state.priceMetadata = {};
                state.transactions = {};
                state.userRole = 'user';
                localStorage.removeItem('portfolioHistory');
                localStorage.removeItem('positionTransactions');
                renderPortfolio();
                updateHistoryDisplay();
            }
        });

        state.supabaseClient.auth.getSession().then(({ data: { session } }) => {
            state.currentUser = session?.user || null;
            updateAuthBar();
            if (state.currentUser) {
                loadFromDatabase();
            }
        });

        console.log('\u2713 Supabase initialized');
        return true;
    } catch (err) {
        console.error('Supabase init failed:', err);
        return false;
    }
}

// ── Portfolio DB Operations ─────────────────────────────────────────────────

export async function savePortfolioDB() {
    if (!state.supabaseClient || !state.currentUser) return;

    try {
        const { error: deleteError } = await state.supabaseClient
            .from('positions')
            .delete()
            .eq('user_id', state.currentUser.id);

        if (deleteError) throw deleteError;

        if (state.portfolio.length > 0) {
            const rows = state.portfolio.map(p => ({
                user_id: state.currentUser.id,
                name: p.name,
                symbol: p.symbol,
                platform: p.platform,
                shares: p.shares,
                avg_price: p.avgPrice,
                asset_type: p.type || 'Stock'
            }));

            const { error: insertError } = await state.supabaseClient
                .from('positions')
                .insert(rows);

            if (insertError) throw insertError;
        }

        console.log('\u2713 Portfolio saved to Supabase');

        const assetRecords = state.portfolio.map(p => buildAssetRecord(p));
        await saveAssetsToDB(assetRecords);
        await loadAssetsFromDB();
    } catch (err) {
        console.error('Failed to save portfolio to DB:', err);
    }
}

// ── Snapshot DB Operations ──────────────────────────────────────────────────

export async function saveSnapshotToDB(snapshot) {
    if (!state.supabaseClient || !state.currentUser) return;

    try {
        const { error } = await state.supabaseClient
            .from('snapshots')
            .insert({
                user_id: state.currentUser.id,
                timestamp: snapshot.timestamp,
                total_invested: snapshot.totalInvested,
                total_market_value: snapshot.totalMarketValue,
                position_count: snapshot.positionCount,
                prices_available: snapshot.pricesAvailable
            });

        if (error) throw error;
        console.log('\u2713 Snapshot saved to Supabase');
    } catch (err) {
        console.error('Failed to save snapshot to DB:', err);
    }
}

export async function clearHistoryFromDB() {
    if (!state.supabaseClient || !state.currentUser) return;

    try {
        const { error } = await state.supabaseClient
            .from('snapshots')
            .delete()
            .eq('user_id', state.currentUser.id);

        if (error) throw error;
        console.log('\u2713 History cleared from Supabase');
    } catch (err) {
        console.error('Failed to clear history from DB:', err);
    }
}

export async function deleteSnapshotFromDB(timestamp) {
    if (!state.supabaseClient || !state.currentUser) return;

    try {
        const { error } = await state.supabaseClient
            .from('snapshots')
            .delete()
            .eq('user_id', state.currentUser.id)
            .eq('timestamp', timestamp);

        if (error) throw error;
        console.log('\u2713 Snapshot deleted from Supabase:', timestamp);
    } catch (err) {
        console.error('Failed to delete snapshot from DB:', err);
    }
}

// ── App Config ──────────────────────────────────────────────────────────────

export async function loadAppConfig() {
    if (!state.supabaseClient || !state.currentUser) return;

    try {
        const { data, error } = await state.supabaseClient
            .from('app_config')
            .select('key, value');

        if (error) throw error;

        if (data && data.length > 0) {
            data.forEach(row => {
                if (row.key === 'finnhubKey' && row.value) state.finnhubKey = row.value;
                if (row.key === 'fmpKey' && row.value) state.fmpKey = row.value;
                if (row.key === 'alphaVantageKey' && row.value) state.alphaVantageKey = row.value;
            });
            console.log('\u2713 API keys loaded from DB:', {
                finnhub: !!state.finnhubKey,
                fmp: !!state.fmpKey,
                alphaVantage: !!state.alphaVantageKey
            });
        }
    } catch (err) {
        console.warn('Failed to load app config from DB:', err);
    }
}

// ── Asset DB Operations ─────────────────────────────────────────────────────

export async function saveAssetsToDB(assets) {
    if (!state.supabaseClient) return;

    try {
        for (const asset of assets) {
            const upsertData = {
                ticker: asset.ticker,
                name: asset.name,
                stock_exchange: asset.stock_exchange,
                sector: asset.sector,
                currency: asset.currency,
                asset_type: asset.asset_type,
                updated_at: new Date().toISOString()
            };
            // Include ISIN if available (for ISIN→ticker lookup on future imports)
            if (asset.isin) upsertData.isin = asset.isin;

            const { error } = await state.supabaseClient
                .from('assets')
                .upsert(upsertData, { onConflict: 'ticker' });

            if (error) {
                console.warn(`Failed to upsert asset ${asset.ticker}:`, error.message);
            }
        }
        console.log('\u2713 Saved', assets.length, 'assets to DB');
    } catch (err) {
        console.error('Failed to save assets to DB:', err);
    }
}

export async function loadAssetsFromDB() {
    if (!state.supabaseClient) return;

    try {
        const { data, error } = await state.supabaseClient
            .from('assets')
            .select('*')
            .order('ticker');

        if (error) {
            console.warn('Failed to load assets from DB:', error.message);
            return;
        }

        if (data && data.length > 0) {
            data.forEach(a => {
                state.assetDatabase[a.ticker.toUpperCase()] = {
                    name: a.name,
                    ticker: a.ticker,
                    stockExchange: a.stock_exchange,
                    sector: a.sector,
                    currency: a.currency,
                    assetType: a.asset_type,
                    isin: a.isin || null
                };
            });
            console.log('\u2713 Loaded', data.length, 'assets from DB into assetDatabase');
        }
    } catch (err) {
        console.error('Failed to load assets from DB:', err);
    }
}

export async function updateAssetInDB(ticker, updates) {
    if (!state.supabaseClient) return;
    try {
        const { error } = await state.supabaseClient
            .from('assets')
            .update({ ...updates, updated_at: new Date().toISOString() })
            .eq('ticker', ticker);
        if (error) {
            console.warn(`Failed to update asset ${ticker}:`, error.message);
        }
    } catch (err) {
        console.error(`Failed to update asset ${ticker}:`, err);
    }
}

export async function enrichUnknownAssets() {
    // Only enrich assets that belong to the current user's portfolio
    const portfolioTickers = new Set(state.portfolio.map(p => p.symbol.toUpperCase()));
    const unknowns = Object.entries(state.assetDatabase)
        .filter(([ticker, a]) => portfolioTickers.has(ticker) && (!a.sector || a.sector === 'Other'))
        .map(([ticker]) => ticker);

    if (unknowns.length === 0) {
        console.log('\u2713 All assets already have sector data');
        return;
    }

    console.log(`=== ENRICHING ${unknowns.length} ASSETS WITH UNKNOWN SECTOR ===`);

    let enriched = 0;
    for (const ticker of unknowns) {
        const profile = await fetchAssetProfile(ticker);
        if (profile && profile.sector) {
            state.assetDatabase[ticker].sector = profile.sector;
            if (profile.currency) state.assetDatabase[ticker].currency = profile.currency;
            if (profile.exchange) state.assetDatabase[ticker].stockExchange = profile.exchange;

            const dbUpdates = { sector: profile.sector };
            if (profile.currency) dbUpdates.currency = profile.currency;
            if (profile.exchange) dbUpdates.stock_exchange = profile.exchange;
            await updateAssetInDB(ticker, dbUpdates);

            enriched++;
            console.log(`\u2713 ${ticker}: sector=${profile.sector} (${profile.source})`);
        } else {
            console.log(`\u2717 ${ticker}: no profile data found`);
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log(`=== ENRICHMENT DONE: ${enriched}/${unknowns.length} resolved ===`);

    if (enriched > 0) {
        renderPortfolio();
    }
}

// ── Price History DB ────────────────────────────────────────────────────────

export async function savePriceHistoryToDB(priceRecords) {
    if (!state.supabaseClient) return;

    try {
        const rows = [];
        for (const r of priceRecords) {
            const ticker = r.ticker.toUpperCase();
            if (!state.assetDatabase[ticker]) {
                console.warn(`Skipping price for ${r.ticker}: not in asset DB`);
                continue;
            }
            rows.push({
                ticker: ticker,
                price: r.price,
                currency: r.currency || 'USD',
                source: r.source,
                fetched_at: r.fetchedAt || new Date().toISOString()
            });
        }

        if (rows.length === 0) return;

        const { error } = await state.supabaseClient
            .from('price_history')
            .insert(rows);

        if (error) {
            console.warn('Failed to save price history:', error.message);
        } else {
            console.log('\u2713 Saved', rows.length, 'price records to history');
        }
    } catch (err) {
        console.error('Failed to save price history to DB:', err);
    }
}

export async function loadLatestPricesFromDB() {
    if (!state.supabaseClient) return;

    try {
        const tickers = [...new Set(state.portfolio.map(p => p.symbol.toUpperCase()))];
        if (tickers.length === 0) return;

        // Only query tickers that exist in the asset database
        const knownTickers = tickers.filter(t => state.assetDatabase[t]);
        if (knownTickers.length === 0) return;

        const { data, error } = await state.supabaseClient
            .from('price_history')
            .select('ticker, price, currency, source, fetched_at')
            .in('ticker', knownTickers)
            .order('fetched_at', { ascending: false });

        if (error) {
            console.warn('Failed to load latest prices from DB:', error.message);
            return;
        }

        if (data && data.length > 0) {
            const seen = new Set();
            let loadedCount = 0;
            data.forEach(row => {
                if (!seen.has(row.ticker)) {
                    seen.add(row.ticker);
                    state.marketPrices[row.ticker] = Number(row.price);
                    state.priceMetadata[row.ticker] = {
                        timestamp: row.fetched_at,
                        source: row.source + ' (cached)',
                        success: true
                    };
                    loadedCount++;
                }
            });
            console.log('\u2713 Loaded', loadedCount, 'cached prices from DB');
        }
    } catch (err) {
        console.error('Failed to load latest prices from DB:', err);
    }
}

export async function loadPriceHistoryForAsset(ticker, limit = 30) {
    if (!state.supabaseClient) return [];

    try {
        const upperTicker = ticker.toUpperCase();
        if (!state.assetDatabase[upperTicker]) return [];

        const { data, error } = await state.supabaseClient
            .from('price_history')
            .select('price, currency, source, fetched_at')
            .eq('ticker', upperTicker)
            .order('fetched_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.warn(`Failed to load price history for ${ticker}:`, error.message);
            return [];
        }

        return (data || []).reverse();
    } catch (err) {
        console.error(`Failed to load price history for ${ticker}:`, err);
        return [];
    }
}

// ── Transaction DB Operations ──────────────────────────────────────────────

export async function saveTransactionsToDB() {
    if (!state.supabaseClient || !state.currentUser) return;

    try {
        // Delete existing transactions for this user
        const { error: deleteError } = await state.supabaseClient
            .from('transactions')
            .delete()
            .eq('user_id', state.currentUser.id);

        if (deleteError) throw deleteError;

        // Flatten state.transactions into rows
        const rows = [];
        for (const [symbol, txs] of Object.entries(state.transactions)) {
            for (const tx of txs) {
                rows.push({
                    user_id: state.currentUser.id,
                    symbol,
                    type: tx.type,
                    shares: tx.shares,
                    price: tx.price,
                    total_amount: tx.totalAmount,
                    date: tx.date,
                    cost_basis: tx.costBasis || null,
                    realized_gain_loss: tx.realizedGainLoss || null,
                    currency: tx.currency || null,
                    exchange_rate: tx.exchangeRate || null
                });
            }
        }

        if (rows.length > 0) {
            const { error: insertError } = await state.supabaseClient
                .from('transactions')
                .insert(rows);

            if (insertError) throw insertError;
        }

        console.log('\u2713 Transactions saved to Supabase:', rows.length, 'records');
    } catch (err) {
        console.error('Failed to save transactions to DB:', err);
    }
}

export async function loadTransactionsFromDB() {
    if (!state.supabaseClient || !state.currentUser) return;

    try {
        const { data, error } = await state.supabaseClient
            .from('transactions')
            .select('*')
            .eq('user_id', state.currentUser.id)
            .order('date', { ascending: true });

        if (error) throw error;

        if (data && data.length > 0) {
            // Group by symbol into state.transactions format
            const grouped = {};
            data.forEach(row => {
                if (!grouped[row.symbol]) grouped[row.symbol] = [];
                const tx = {
                    type: row.type,
                    shares: Number(row.shares),
                    price: Number(row.price),
                    date: row.date,
                    totalAmount: Number(row.total_amount),
                    currency: row.currency || null,
                    exchangeRate: row.exchange_rate ? Number(row.exchange_rate) : null,
                    timestamp: row.created_at
                };
                if (row.type === 'sell') {
                    if (row.cost_basis !== null) tx.costBasis = Number(row.cost_basis);
                    if (row.realized_gain_loss !== null) tx.realizedGainLoss = Number(row.realized_gain_loss);
                }
                grouped[row.symbol].push(tx);
            });
            state.transactions = grouped;
            console.log('\u2713 Loaded', data.length, 'transactions from DB for', Object.keys(grouped).length, 'symbols');
        }
    } catch (err) {
        console.error('Failed to load transactions from DB:', err);
    }
}

export async function deleteTransactionsForSymbol(symbol) {
    if (!state.supabaseClient || !state.currentUser) return;

    try {
        const { error } = await state.supabaseClient
            .from('transactions')
            .delete()
            .eq('user_id', state.currentUser.id)
            .eq('symbol', symbol);

        if (error) throw error;
        console.log(`\u2713 Deleted transactions for ${symbol} from DB`);
    } catch (err) {
        console.error(`Failed to delete transactions for ${symbol}:`, err);
    }
}

// ── Full Database Load ──────────────────────────────────────────────────────

export async function loadFromDatabase() {
    if (!state.supabaseClient || !state.currentUser) return;

    try {
        console.log('\u2601\uFE0F Loading data from Supabase...');

        // Clear user-specific state before loading (prevents cross-user data leaks)
        state.portfolio = [];
        state.portfolioHistory = [];
        state.marketPrices = {};
        state.priceMetadata = {};
        state.transactions = {};

        // Load positions
        const { data: dbPositions, error: posError } = await state.supabaseClient
            .from('positions')
            .select('*')
            .eq('user_id', state.currentUser.id)
            .order('symbol');

        if (posError) throw posError;

        if (dbPositions && dbPositions.length > 0) {
            state.portfolio = dbPositions.map(p => ({
                name: p.name,
                symbol: p.symbol,
                platform: p.platform,
                type: p.asset_type || 'Stock',
                shares: Number(p.shares),
                avgPrice: Number(p.avg_price)
            }));
            console.log('\u2713 Loaded', state.portfolio.length, 'positions from DB');
            renderPortfolio();
        }

        // Load snapshots
        const { data: dbSnapshots, error: snapError } = await state.supabaseClient
            .from('snapshots')
            .select('*')
            .eq('user_id', state.currentUser.id)
            .order('timestamp', { ascending: true });

        if (snapError) throw snapError;

        if (dbSnapshots && dbSnapshots.length > 0) {
            state.portfolioHistory = dbSnapshots.map(s => ({
                timestamp: s.timestamp,
                totalInvested: Number(s.total_invested),
                totalMarketValue: Number(s.total_market_value),
                positionCount: s.position_count,
                pricesAvailable: s.prices_available
            }));
            state.portfolioHistory.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
            localStorage.setItem('portfolioHistory', JSON.stringify(state.portfolioHistory));
            console.log('\u2713 Loaded', state.portfolioHistory.length, 'snapshots from DB');
            updateHistoryDisplay();
        }

        // Load assets
        await loadAssetsFromDB();

        // Enrich positions with asset_type from DB
        let enrichedCount = 0;
        state.portfolio.forEach(p => {
            if (!p.type || p.type === 'Stock') {
                const dbAsset = state.assetDatabase[p.symbol.toUpperCase()];
                if (dbAsset && dbAsset.assetType && dbAsset.assetType !== 'Stock') {
                    p.type = dbAsset.assetType;
                    enrichedCount++;
                }
            }
        });
        if (enrichedCount > 0) {
            console.log(`\u2713 Enriched ${enrichedCount} positions with asset type from DB`);
            renderPortfolio();
        }

        // Load transactions
        await loadTransactionsFromDB();
        // Also persist to localStorage so offline works
        if (Object.keys(state.transactions).length > 0) {
            localStorage.setItem('positionTransactions', JSON.stringify(state.transactions));
        }

        // Load cached prices
        await loadLatestPricesFromDB();
        if (Object.keys(state.marketPrices).length > 0) {
            renderPortfolio();
        }

        // Load shared API keys
        await loadAppConfig();

        // Check user role (admin vs regular user)
        await checkUserRole();
    } catch (err) {
        console.error('Failed to load from database:', err);
    }
}
