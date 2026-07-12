import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { renderLocalStatsRows } from '../src/cli/stats.mjs';

describe('renderLocalStatsRows', () => {
  it('renders a headroom-lite payload into stable rows and ignores unknown fields', () => {
    const result = renderLocalStatsRows({
      service: 'headroom-lite',
      proxy_requests: 42,
      compress_requests: 7,
      compress_pct: 83.25,
      compress_tokens_saved: 1234,
      uptime_seconds: 99,
      extra: 'ignore me',
    });

    assert.equal(result.available, true);
    assert.deepEqual(result.rows, [
      ['Status', 'running'],
      ['Requests', '42 total, 7 compressed'],
      ['Compression', '83.3%'],
      ['Tokens', '1,234 saved'],
    ]);
  });

  it('renders a copilot-headroom payload into stable rows and ignores unknown fields', () => {
    const result = renderLocalStatsRows({
      summary: {
        api_requests: 100,
        compression: {
          requests_compressed: 25,
          total_tokens_before_with_cli_filtering: 4000,
          total_tokens_saved_with_cli_filtering: 1500,
        },
        cost: {
          breakdown: {
            cache_savings_usd: 1.23,
            compression_savings_usd: 4.56,
          },
        },
        extra: 'ignore me',
      },
    });

    assert.equal(result.available, true);
    assert.deepEqual(result.rows, [
      ['Status', 'running'],
      ['Requests', '100 total, 25 compressed'],
      ['Compression', '37.5%'],
      ['Tokens', '1,500 saved'],
    ]);
  });

  it('returns an explicit unavailable result for invalid payloads', () => {
    assert.deepEqual(renderLocalStatsRows(null), {
      available: false,
      rows: [['Status', 'unavailable']],
    });

    assert.deepEqual(renderLocalStatsRows({ summary: {} }), {
      available: false,
      rows: [['Status', 'unavailable']],
    });
  });
});
