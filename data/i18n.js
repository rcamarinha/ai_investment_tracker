/**
 * Internationalisation (i18n) — English and Portuguese translations.
 *
 * Usage:
 *   import { t, getLang, setLang, applyTranslations } from './data/i18n.js';
 *
 *   t('nav.portfolio')              → translated string
 *   applyTranslations()             → walks DOM, sets [data-i18n] elements
 */

// ── Translation dictionary ────────────────────────────────────────────────────

export const TRANSLATIONS = {
    en: {
        // ── Navigation ───────────────────────────────────────────────────────
        'nav.hub':          'Investment Hub',
        'nav.portfolio':    '📈 Portfolio',
        'nav.wine':         '🍷 Wine',
        'nav.login':        'Login',
        'nav.logout':       'Logout',
        'nav.lang_switch':  'PT',   // label of the OTHER language (switching target)

        // ── Auth dropdown ────────────────────────────────────────────────────
        'auth.google':          'Sign in with Google',
        'auth.or_email':        'or sign in with email',
        'auth.email_ph':        'Email',
        'auth.password_ph':     'Password',
        'auth.login_btn':       'Login',
        'auth.signup_btn':      'Sign Up',
        'auth.forgot':          'Forgot password?',
        'auth.connected':       'Connected',
        'auth.set_password':    'Set new password',
        'auth.new_password_ph': 'New password',
        'auth.confirm_ph':      'Confirm password',
        'auth.set_btn':         'Set Password',
        'auth.cancel':          'Cancel',

        // ── Hub page ─────────────────────────────────────────────────────────
        'hub.eyebrow':          'Investment Hub',
        'hub.total_wealth':     'Total Portfolio Wealth',
        'hub.stock_eyebrow':    'Equities · ETFs · Crypto',
        'hub.wine_eyebrow':     'Fine Wine · Spirits · Cellar',
        'hub.subtitle':         'Track all your investments — stocks and wine — in one place',
        'hub.stock_title':      'Stock Portfolio',
        'hub.stock_desc':       'Live market prices, AI-powered analysis, and multi-platform portfolio tracking.',
        'hub.stock_f1':         'Live prices via Finnhub / FMP / Alpha Vantage',
        'hub.stock_f2':         '6 investment perspective analyses',
        'hub.stock_f3':         'Performance history & snapshots',
        'hub.stock_f4':         'Supabase cloud sync',
        'hub.stock_cta':        'Open Portfolio →',
        'hub.wine_title':       'Wine Cellar',
        'hub.wine_desc':        'AI label recognition, cellar valuation, and investment tracking for your wine collection.',
        'hub.wine_f1':          'Scan labels with camera → AI identifies wine',
        'hub.wine_f2':          'Claude-powered bottle valuations',
        'hub.wine_f3':          'Drink window & cellar insights',
        'hub.wine_f4':          'Supabase cloud sync',
        'hub.wine_cta':         'Open Wine Cellar →',
        'hub.wine_badge':       'New',

        // ── Portfolio page ───────────────────────────────────────────────────
        'portfolio.back':           '← All Trackers',
        'portfolio.title':          '📈 AI Financial Advisor',
        'portfolio.subtitle':       'Market analysis and personalized portfolio insights',
        'portfolio.your_portfolio': '💼 Your Portfolio',
        'portfolio.total_value':    'Total Value',
        'portfolio.btn.api_keys':   '🔑 API Keys',
        'portfolio.btn.add':        '➕ Add Position',
        'portfolio.btn.import':     '📋 Import from Spreadsheet',
        'portfolio.btn.prices':     '🔄 Update Prices',
        'portfolio.btn.snapshot':   '💾 Save Snapshot',
        'portfolio.allocation':     '📊 Portfolio Allocation',
        'portfolio.by_type':        'By Asset Type',
        'portfolio.by_sector':      'By Sector',
        'portfolio.perspective':    'Investment Perspective:',
        'portfolio.btn.analyze':    'Get AI Analysis',
        'portfolio.btn.trade':      '💹 Get Trade Ideas',
        'portfolio.history':        '📈 Portfolio History',

        // ── Wine page ────────────────────────────────────────────────────────
        'wine.back':            '← All Trackers',
        'wine.title':           '🍷 Wine Cellar',
        'wine.subtitle':        'AI-powered wine collection management with label recognition',
        'wine.scan_title':      '📸 Scan Wine Label',
        'wine.scan_desc':       'Photograph the front label — Claude AI will identify the wine and pre-fill the details.',
        'wine.take_photo':      '📷 Take Photo / Upload Image',
        'wine.live_camera':     '🎥 Live Camera',
        'wine.cellar_title':    '🍾 Your Cellar',
        'wine.bottles':         'Bottles',
        'wine.invested':        'Invested',
        'wine.est_value':       'Est. Value',
        'wine.gain_loss':       'Gain / Loss',
        'wine.btn.api_keys':    '🔑 API Keys',
        'wine.btn.add':         '➕ Add Bottle',
        'wine.btn.valuate':     '💎 Update Valuations',
        'wine.btn.snapshot':    '💾 Save Snapshot',
        'wine.btn.analyze':     '🤖 AI Analysis',
        'wine.btn.export':      '⬇ Export CSV',
        'wine.search_ph':       'Search by name, region, varietal, vintage…',
        'wine.sort.added':      'Recently Added',
        'wine.sort.name':       'Name A–Z',
        'wine.sort.vintage':    'Vintage (newest)',
        'wine.sort.value':      'Value (highest)',
        'wine.sort.gain':       'Gain % (highest)',
        'wine.allocation':      '📊 Cellar Allocation',
        'wine.by_region':       'By Region',
        'wine.by_varietal':     'By Varietal',
        'wine.by_country':      'By Country',
        'wine.history':         '📈 Cellar History',
        'wine.clear_history':   '🗑 Clear History',
        'wine.filters':         'Filters',

        // ── Bottle form ──────────────────────────────────────────────────────
        'bottle.add_title':         '🍾 Add Bottle',
        'bottle.name':              'Wine Name *',
        'bottle.name_ph':           'e.g. Château Margaux',
        'bottle.winery':            'Winery / Producer',
        'bottle.winery_ph':         'e.g. Château Margaux',
        'bottle.vintage':           'Vintage',
        'bottle.vintage_ph':        'e.g. 2018',
        'bottle.varietal':          'Varietal / Grape',
        'bottle.varietal_ph':       'e.g. Cabernet Sauvignon',
        'bottle.region':            'Region',
        'bottle.region_ph':         'e.g. Bordeaux',
        'bottle.appellation':       'Appellation',
        'bottle.appellation_ph':    'e.g. Margaux AOC',
        'bottle.country':           'Country',
        'bottle.country_ph':        'e.g. France',
        'bottle.alcohol':           'Alcohol %',
        'bottle.alcohol_ph':        'e.g. 13.5%',
        'bottle.qty':               'Quantity (bottles) *',
        'bottle.qty_ph':            'e.g. 6',
        'bottle.price':             'Purchase Price / bottle (€)',
        'bottle.price_ph':          'e.g. 150.00',
        'bottle.date':              'Purchase Date',
        'bottle.storage':           'Storage Location',
        'bottle.storage_ph':        'e.g. Home cellar, Cavissima',
        'bottle.notes':             'Notes',
        'bottle.notes_ph':          'Awards, tasting notes, special designations...',
        'bottle.btn.add':           'Add Bottle',
        'bottle.btn.cancel':        'Cancel',
        'bottle.btn.delete':        '🗑 Delete Bottle',

        // ── AI Analysis (dynamic JS) ─────────────────────────────────────────
        'analysis.analyzing':       'Analyzing...',
        'analysis.generating':      'Generating...',
        'analysis.market_news':     '📰 Market News Overview',
        'analysis.market_assess':   'Market Assessment',
        'analysis.portfolio_eval':  'Portfolio Evaluation — ',
        'analysis.view':            'View',
        'analysis.market_summary':  'Market Summary',
        'analysis.portfolio_impact':'Portfolio Impact',
        'analysis.trade_ideas':     '📈 Concrete Trade Ideas',
        'analysis.exec_plan':       '📋 Today\'s Execution Plan',
        'analysis.current_context': 'Current Context',
        'analysis.specific_action': '🎯 Specific Action',
        'analysis.disclaimer':
            'This analysis is generated from a {perspective} perspective for educational purposes only. ' +
            'It should not be considered financial advice. ' +
            'Always consult with a qualified financial advisor before making investment decisions.',
        'analysis.trade_disclaimer':
            'These trade ideas are generated from a {perspective} perspective for educational purposes only. ' +
            'They are not personalized financial advice. ' +
            'Always do your own research and consult with a qualified financial advisor before making investment decisions.',
        'analysis.btn.analyze':     'Get AI Analysis',
        'analysis.btn.trade':       '💹 Get Trade Ideas',

        // ── Wine analysis (dynamic JS) ───────────────────────────────────────
        'wine.analysis.title':      '🤖 AI Cellar Analysis',
        'wine.analysis.overview':   '📊 Cellar Overview',
        'wine.analysis.divers':     '🌍 Diversification',
        'wine.analysis.highlights': '⭐ Cellar Highlights',
        'wine.analysis.drink_now':  '🍷 Drink Now or Soon',
        'wine.analysis.hold':       '⏳ Hold for Maximum Value',
        'wine.analysis.recs':       '💡 Recommendations',
        'wine.analysis.disclaimer':
            'This analysis is generated by AI for educational and informational purposes only. ' +
            'Wine valuations and market predictions are approximate. ' +
            'Consult a specialist before making investment decisions.',
        'wine.btn.analyze_done':    '🤖 AI Analysis',

        // ── Bottle card (dynamic JS) ─────────────────────────────────────────
        'bottle.card.edit':         '✎ Edit',
        'bottle.card.bottle':       'bottle',
        'bottle.card.bottles':      'bottles',
        'bottle.card.invested':     'invested',
        'bottle.card.no_price':     'No purchase price',
        'bottle.card.est_value':    'Est. value',
        'bottle.card.range':        'Range:',
        'bottle.card.gain_loss':    'Gain / Loss',
        'bottle.card.no_valuation': 'Valuation not yet fetched',
        'bottle.card.get_estimate': 'Get estimate →',
        'bottle.card.drink':        'Drink:',
        'bottle.card.valued':       'Valued',
        'bottle.card.bought':       'Bought',
        'bottle.card.stale':        '⚠ Valuation is {n} days old — consider refreshing',

        // ── Drink window badges ───────────────────────────────────────────────
        'drink.not_ready':  '🔵 Not Ready',
        'drink.ready':      '🟢 Ready Now',
        'drink.at_peak':    '🟡 At Peak',
        'drink.past_peak':  '🔴 Past Peak',

        // ── Time ago ─────────────────────────────────────────────────────────
        'time.today':      'today',
        'time.yesterday':  'yesterday',
        'time.days_ago':   '{n}d ago',
        'time.months_ago': '{n}mo ago',
        'time.years_ago':  '{n}y ago',

        // ── Cellar summary counts ─────────────────────────────────────────────
        'cellar.ready':     'ready',
        'cellar.at_peak':   'at peak',
        'cellar.not_ready': 'not ready',
        'cellar.past_peak': 'past peak',

        // ── Filter panel ──────────────────────────────────────────────────────
        'filter.country':    'Country',
        'filter.region':     'Region',
        'filter.producer':   'Producer',
        'filter.vintage':    'Vintage',
        'filter.varietal':   'Varietal',
        'filter.more':       'More filters',
        'filter.clear':      'Clear all',
        'filter.no_filters': 'No filters available yet.',

        // ── Cellar empty / no-results ─────────────────────────────────────────
        'cellar.empty_title':        'Your cellar is empty',
        'cellar.empty_desc':         'Scan a wine label with your camera, or add a bottle manually to get started.',
        'cellar.scan_label':         '📷 Scan a Label',
        'cellar.add_manual':         '➕ Add Manually',
        'cellar.no_results':         'No wines match your current search/filter.',
        'cellar.no_results_filters': 'Try clearing some filters above.',
        'cellar.no_results_search':  'Try a different search term.',

        // ── Confidence badges ─────────────────────────────────────────────────
        'conf.high':   '● High confidence',
        'conf.medium': '● Medium confidence',
        'conf.low':    '● Low confidence',

        // ── Bottle dialogs ────────────────────────────────────────────────────
        'dialog.edit_bottle': '✏️ Edit Bottle',
        'dialog.save':        'Save Changes',
        'dialog.saving':      'Saving...',
        'dialog.added':       'Bottle added to cellar!',
        'dialog.updated':     'Bottle updated.',

        // ── Claude language instruction ───────────────────────────────────────
        'ai.lang_instruction': '',   // empty in English — appended to every Claude prompt
    },

    pt: {
        // ── Navigation ───────────────────────────────────────────────────────
        'nav.hub':          'Hub de Investimentos',
        'nav.portfolio':    '📈 Carteira',
        'nav.wine':         '🍷 Adega',
        'nav.login':        'Entrar',
        'nav.logout':       'Sair',
        'nav.lang_switch':  'EN',

        // ── Auth dropdown ────────────────────────────────────────────────────
        'auth.google':          'Entrar com Google',
        'auth.or_email':        'ou entrar com email',
        'auth.email_ph':        'Email',
        'auth.password_ph':     'Senha',
        'auth.login_btn':       'Entrar',
        'auth.signup_btn':      'Registar',
        'auth.forgot':          'Esqueceu a senha?',
        'auth.connected':       'Conectado',
        'auth.set_password':    'Definir nova senha',
        'auth.new_password_ph': 'Nova senha',
        'auth.confirm_ph':      'Confirmar senha',
        'auth.set_btn':         'Definir Senha',
        'auth.cancel':          'Cancelar',

        // ── Hub page ─────────────────────────────────────────────────────────
        'hub.eyebrow':          'Hub de Investimentos',
        'hub.total_wealth':     'Riqueza Total da Carteira',
        'hub.stock_eyebrow':    'Ações · ETFs · Cripto',
        'hub.wine_eyebrow':     'Vinho Fino · Espirituosas · Adega',
        'hub.subtitle':         'Acompanhe todos os seus investimentos — ações e vinho — num só lugar',
        'hub.stock_title':      'Carteira de Ações',
        'hub.stock_desc':       'Preços de mercado ao vivo, análise com IA e gestão de carteira multi-plataforma.',
        'hub.stock_f1':         'Preços via Finnhub / FMP / Alpha Vantage',
        'hub.stock_f2':         '6 perspetivas de análise de investimento',
        'hub.stock_f3':         'Histórico de desempenho e instantâneos',
        'hub.stock_f4':         'Sincronização Supabase na nuvem',
        'hub.stock_cta':        'Abrir Carteira →',
        'hub.wine_title':       'Adega',
        'hub.wine_desc':        'Reconhecimento de rótulo por IA, avaliação de adega e acompanhamento de investimento na sua coleção de vinhos.',
        'hub.wine_f1':          'Digitalize rótulos com a câmara → IA identifica o vinho',
        'hub.wine_f2':          'Avaliações de garrafas com Claude',
        'hub.wine_f3':          'Janela de consumo e insights de adega',
        'hub.wine_f4':          'Sincronização Supabase na nuvem',
        'hub.wine_cta':         'Abrir Adega →',
        'hub.wine_badge':       'Novo',

        // ── Portfolio page ───────────────────────────────────────────────────
        'portfolio.back':           '← Todos os Rastreadores',
        'portfolio.title':          '📈 Consultor Financeiro IA',
        'portfolio.subtitle':       'Análise de mercado e insights personalizados de carteira',
        'portfolio.your_portfolio': '💼 A Sua Carteira',
        'portfolio.total_value':    'Valor Total',
        'portfolio.btn.api_keys':   '🔑 Chaves API',
        'portfolio.btn.add':        '➕ Adicionar Posição',
        'portfolio.btn.import':     '📋 Importar de Folha de Cálculo',
        'portfolio.btn.prices':     '🔄 Atualizar Preços',
        'portfolio.btn.snapshot':   '💾 Guardar Instantâneo',
        'portfolio.allocation':     '📊 Alocação da Carteira',
        'portfolio.by_type':        'Por Tipo de Ativo',
        'portfolio.by_sector':      'Por Setor',
        'portfolio.perspective':    'Perspetiva de Investimento:',
        'portfolio.btn.analyze':    'Obter Análise IA',
        'portfolio.btn.trade':      '💹 Obter Ideias de Negociação',
        'portfolio.history':        '📈 Histórico da Carteira',

        // ── Wine page ────────────────────────────────────────────────────────
        'wine.back':            '← Todos os Rastreadores',
        'wine.title':           '🍷 Adega',
        'wine.subtitle':        'Gestão de coleção de vinhos com IA e reconhecimento de rótulo',
        'wine.scan_title':      '📸 Digitalizar Rótulo',
        'wine.scan_desc':       'Fotografe o rótulo frontal — o Claude AI identificará o vinho e preencherá os detalhes.',
        'wine.take_photo':      '📷 Tirar Foto / Carregar Imagem',
        'wine.live_camera':     '🎥 Câmara Ao Vivo',
        'wine.cellar_title':    '🍾 A Sua Adega',
        'wine.bottles':         'Garrafas',
        'wine.invested':        'Investido',
        'wine.est_value':       'Valor Est.',
        'wine.gain_loss':       'Ganho / Perda',
        'wine.btn.api_keys':    '🔑 Chaves API',
        'wine.btn.add':         '➕ Adicionar Garrafa',
        'wine.btn.valuate':     '💎 Atualizar Avaliações',
        'wine.btn.snapshot':    '💾 Guardar Instantâneo',
        'wine.btn.analyze':     '🤖 Análise IA',
        'wine.btn.export':      '⬇ Exportar CSV',
        'wine.search_ph':       'Pesquisar por nome, região, casta, colheita…',
        'wine.sort.added':      'Adicionado Recentemente',
        'wine.sort.name':       'Nome A–Z',
        'wine.sort.vintage':    'Colheita (mais recente)',
        'wine.sort.value':      'Valor (mais alto)',
        'wine.sort.gain':       'Ganho % (mais alto)',
        'wine.allocation':      '📊 Alocação da Adega',
        'wine.by_region':       'Por Região',
        'wine.by_varietal':     'Por Casta',
        'wine.by_country':      'Por País',
        'wine.history':         '📈 Histórico da Adega',
        'wine.clear_history':   '🗑 Limpar Histórico',
        'wine.filters':         'Filtros',

        // ── Bottle form ──────────────────────────────────────────────────────
        'bottle.add_title':         '🍾 Adicionar Garrafa',
        'bottle.name':              'Nome do Vinho *',
        'bottle.name_ph':           'ex. Château Margaux',
        'bottle.winery':            'Quinta / Produtor',
        'bottle.winery_ph':         'ex. Château Margaux',
        'bottle.vintage':           'Colheita',
        'bottle.vintage_ph':        'ex. 2018',
        'bottle.varietal':          'Casta / Uva',
        'bottle.varietal_ph':       'ex. Cabernet Sauvignon',
        'bottle.region':            'Região',
        'bottle.region_ph':         'ex. Bordéus',
        'bottle.appellation':       'Denominação',
        'bottle.appellation_ph':    'ex. Margaux AOC',
        'bottle.country':           'País',
        'bottle.country_ph':        'ex. França',
        'bottle.alcohol':           'Álcool %',
        'bottle.alcohol_ph':        'ex. 13,5%',
        'bottle.qty':               'Quantidade (garrafas) *',
        'bottle.qty_ph':            'ex. 6',
        'bottle.price':             'Preço de Compra / garrafa (€)',
        'bottle.price_ph':          'ex. 150,00',
        'bottle.date':              'Data de Compra',
        'bottle.storage':           'Local de Armazenamento',
        'bottle.storage_ph':        'ex. Adega em casa, Cavissima',
        'bottle.notes':             'Notas',
        'bottle.notes_ph':          'Prémios, notas de prova, designações especiais...',
        'bottle.btn.add':           'Adicionar Garrafa',
        'bottle.btn.cancel':        'Cancelar',
        'bottle.btn.delete':        '🗑 Eliminar Garrafa',

        // ── AI Analysis (dynamic JS) ─────────────────────────────────────────
        'analysis.analyzing':       'A analisar...',
        'analysis.generating':      'A gerar...',
        'analysis.market_news':     '📰 Visão Geral das Notícias de Mercado',
        'analysis.market_assess':   'Avaliação do Mercado',
        'analysis.portfolio_eval':  'Avaliação da Carteira — ',
        'analysis.view':            'Perspetiva',
        'analysis.market_summary':  'Resumo do Mercado',
        'analysis.portfolio_impact':'Impacto na Carteira',
        'analysis.trade_ideas':     '📈 Ideias Concretas de Negociação',
        'analysis.exec_plan':       '📋 Plano de Execução de Hoje',
        'analysis.current_context': 'Contexto Atual',
        'analysis.specific_action': '🎯 Ação Específica',
        'analysis.disclaimer':
            'Esta análise é gerada numa perspetiva de {perspective} apenas para fins educativos. ' +
            'Não deve ser considerada aconselhamento financeiro. ' +
            'Consulte sempre um consultor financeiro qualificado antes de tomar decisões de investimento.',
        'analysis.trade_disclaimer':
            'Estas ideias de negociação são geradas numa perspetiva de {perspective} apenas para fins educativos. ' +
            'Não constituem aconselhamento financeiro personalizado. ' +
            'Faça sempre a sua própria pesquisa e consulte um consultor financeiro qualificado antes de tomar decisões de investimento.',
        'analysis.btn.analyze':     'Obter Análise IA',
        'analysis.btn.trade':       '💹 Obter Ideias de Negociação',

        // ── Wine analysis (dynamic JS) ───────────────────────────────────────
        'wine.analysis.title':      '🤖 Análise IA da Adega',
        'wine.analysis.overview':   '📊 Visão Geral da Adega',
        'wine.analysis.divers':     '🌍 Diversificação',
        'wine.analysis.highlights': '⭐ Destaques da Adega',
        'wine.analysis.drink_now':  '🍷 Beber Agora ou Em Breve',
        'wine.analysis.hold':       '⏳ Guardar para Máximo Valor',
        'wine.analysis.recs':       '💡 Recomendações',
        'wine.analysis.disclaimer':
            'Esta análise é gerada por IA apenas para fins educativos e informativos. ' +
            'As avaliações de vinho e previsões de mercado são aproximadas. ' +
            'Consulte um especialista antes de tomar decisões de investimento.',
        'wine.btn.analyze_done':    '🤖 Análise IA',

        // ── Bottle card (dynamic JS) ─────────────────────────────────────────
        'bottle.card.edit':         '✎ Editar',
        'bottle.card.bottle':       'garrafa',
        'bottle.card.bottles':      'garrafas',
        'bottle.card.invested':     'investido',
        'bottle.card.no_price':     'Sem preço de compra',
        'bottle.card.est_value':    'Valor Est.',
        'bottle.card.range':        'Intervalo:',
        'bottle.card.gain_loss':    'Ganho / Perda',
        'bottle.card.no_valuation': 'Avaliação não obtida',
        'bottle.card.get_estimate': 'Obter estimativa →',
        'bottle.card.drink':        'Beber:',
        'bottle.card.valued':       'Avaliado',
        'bottle.card.bought':       'Comprado',
        'bottle.card.stale':        '⚠ Avaliação tem {n} dias — considere atualizar',

        // ── Drink window badges ───────────────────────────────────────────────
        'drink.not_ready':  '🔵 Não Pronto',
        'drink.ready':      '🟢 Pronto',
        'drink.at_peak':    '🟡 No Pico',
        'drink.past_peak':  '🔴 Pico Ultrapassado',

        // ── Time ago ─────────────────────────────────────────────────────────
        'time.today':      'hoje',
        'time.yesterday':  'ontem',
        'time.days_ago':   'há {n}d',
        'time.months_ago': 'há {n}m',
        'time.years_ago':  'há {n}a',

        // ── Cellar summary counts ─────────────────────────────────────────────
        'cellar.ready':     'prontos',
        'cellar.at_peak':   'no pico',
        'cellar.not_ready': 'não prontos',
        'cellar.past_peak': 'pico ultrapassado',

        // ── Filter panel ──────────────────────────────────────────────────────
        'filter.country':    'País',
        'filter.region':     'Região',
        'filter.producer':   'Produtor',
        'filter.vintage':    'Colheita',
        'filter.varietal':   'Casta',
        'filter.more':       'Mais filtros',
        'filter.clear':      'Limpar tudo',
        'filter.no_filters': 'Sem filtros disponíveis.',

        // ── Cellar empty / no-results ─────────────────────────────────────────
        'cellar.empty_title':        'A sua adega está vazia',
        'cellar.empty_desc':         'Digitalize um rótulo com a câmara, ou adicione uma garrafa manualmente para começar.',
        'cellar.scan_label':         '📷 Digitalizar Rótulo',
        'cellar.add_manual':         '➕ Adicionar Manualmente',
        'cellar.no_results':         'Nenhum vinho corresponde à sua pesquisa/filtro.',
        'cellar.no_results_filters': 'Tente limpar alguns filtros acima.',
        'cellar.no_results_search':  'Tente um termo de pesquisa diferente.',

        // ── Confidence badges ─────────────────────────────────────────────────
        'conf.high':   '● Alta confiança',
        'conf.medium': '● Confiança média',
        'conf.low':    '● Baixa confiança',

        // ── Bottle dialogs ────────────────────────────────────────────────────
        'dialog.edit_bottle': '✏️ Editar Garrafa',
        'dialog.save':        'Guardar Alterações',
        'dialog.saving':      'A guardar...',
        'dialog.added':       'Garrafa adicionada à adega!',
        'dialog.updated':     'Garrafa atualizada.',

        // ── Claude language instruction ───────────────────────────────────────
        'ai.lang_instruction':
            '\n\nIMPORTANT: Respond entirely in European Portuguese (português europeu). ' +
            'Use formal register (tratamento de "você"). ' +
            'All section titles, labels, and content must be in Portuguese.',
    },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Get current language code ('en' or 'pt'). */
export function getLang() {
    return localStorage.getItem('app_lang') || 'en';
}

/** Persist language choice. */
export function setLang(lang) {
    localStorage.setItem('app_lang', lang);
}

/**
 * Translate a key for the current language.
 * Falls back to English, then to the key itself.
 */
export function t(key) {
    const lang = getLang();
    return TRANSLATIONS[lang]?.[key] ?? TRANSLATIONS['en']?.[key] ?? key;
}

/**
 * Walk the DOM and update every [data-i18n] element.
 * Elements with [data-i18n-placeholder] get their placeholder updated.
 */
export function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        el.textContent = t(key);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        el.setAttribute('placeholder', t(key));
    });
}
