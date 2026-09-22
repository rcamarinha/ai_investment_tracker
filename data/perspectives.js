/**
 * Investment perspective definitions.
 *
 * Each perspective provides a philosophical lens for portfolio analysis.
 * These are the display fields; the prompt each one sends lives in
 * supabase/functions/_shared/analysis-prompts.js, where the server builds it.
 */

export const INVESTMENT_PERSPECTIVES = {
    value: {
        name: 'Value Investing',
        icon: '\u{1F4DA}',
        color: '#4CAF84',
        figures: 'Benjamin Graham, Warren Buffett, Charlie Munger',
        description: 'Buy securities trading below intrinsic value with a margin of safety. Seek statistical cheapness or wonderful businesses at fair prices.'
    },
    garp: {
        name: 'Growth at Reasonable Price',
        icon: '\u{1F331}',
        color: '#C9A84C',
        figures: 'Peter Lynch',
        description: 'Find companies growing earnings fast but not at absurd valuations. Buy what you understand before Wall Street catches on.'
    },
    quant: {
        name: 'Quantitative & Systematic',
        icon: '\u{1F522}',
        color: '#C4607C',
        figures: 'Jim Simons, Cliff Asness',
        description: 'Use mathematical models, factor exposure, and statistical patterns to find edge. Data over narratives, risk-adjusted returns over raw gains.'
    },
    macro: {
        name: 'Macro Investing',
        icon: '\u{1F30D}',
        color: '#E05A5A',
        figures: 'George Soros, Ray Dalio',
        description: 'Position for macroeconomic trends \u2014 interest rates, currencies, debt cycles, and geopolitical shifts. Think top-down, not bottom-up.'
    },
    passive: {
        name: 'Index & Passive',
        icon: '\u{1F4C8}',
        color: '#E09A3A',
        figures: 'John Bogle',
        description: 'You cannot consistently beat the market \u2014 own it cheaply. Minimize costs, maximize diversification, and let compounding do the work.'
    },
    technical: {
        name: 'Technical & Momentum',
        icon: '\u{1F4C9}',
        color: '#9B3A5A',
        figures: 'Jesse Livermore, Paul Tudor Jones',
        description: 'Price action contains information. Identify trends, ride momentum, cut losers short, and let winners run.'
    }
};
