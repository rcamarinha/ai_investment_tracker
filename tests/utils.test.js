import { describe, it, expect } from 'vitest';
import { formatCurrency, formatPercent, escapeHTML } from '../src/portfolio.js';

describe('formatCurrency', () => {
  it('formats a positive number', () => {
    const result = formatCurrency(1234.56);
    // toLocaleString is locale-dependent; just check structure
    expect(result).toMatch(/^\$[\d,]+\.56$/);
  });

  it('formats zero', () => {
    expect(formatCurrency(0)).toMatch(/^\$0\.00$/);
  });

  it('formats a negative number', () => {
    const result = formatCurrency(-500.1);
    expect(result).toContain('500.10');
  });

  it('rounds to two decimal places', () => {
    const result = formatCurrency(9.999);
    expect(result).toMatch(/10\.00/);
  });

  it('handles very large numbers', () => {
    const result = formatCurrency(1000000);
    expect(result).toContain('1');
    expect(result).toContain('.00');
  });

  it('handles very small numbers', () => {
    const result = formatCurrency(0.001);
    expect(result).toMatch(/^\$0\.00$/);
  });
});

describe('formatPercent', () => {
  it('formats a positive percentage with + sign', () => {
    expect(formatPercent(2.5)).toBe('+2.50%');
  });

  it('formats a negative percentage', () => {
    expect(formatPercent(-1.75)).toBe('-1.75%');
  });

  it('formats zero as +0.00%', () => {
    expect(formatPercent(0)).toBe('+0.00%');
  });

  it('rounds to 2 decimal places', () => {
    expect(formatPercent(3.456)).toBe('+3.46%');
  });

  it('handles large percentages', () => {
    expect(formatPercent(150)).toBe('+150.00%');
  });

  it('handles very small negative percentages', () => {
    expect(formatPercent(-0.01)).toBe('-0.01%');
  });
});

describe('escapeHTML', () => {
  it('escapes < and >', () => {
    expect(escapeHTML('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('escapes ampersand', () => {
    expect(escapeHTML('AT&T')).toBe('AT&amp;T');
  });

  it('escapes double quotes', () => {
    expect(escapeHTML('"hello"')).toBe('&quot;hello&quot;');
  });

  it('escapes single quotes', () => {
    expect(escapeHTML("it's")).toBe('it&#039;s');
  });

  it('returns empty string unchanged', () => {
    expect(escapeHTML('')).toBe('');
  });

  it('returns normal strings unchanged', () => {
    expect(escapeHTML('Hello World')).toBe('Hello World');
  });

  it('handles non-string input by coercing to string', () => {
    expect(escapeHTML(123)).toBe('123');
    expect(escapeHTML(null)).toBe('null');
  });
});
