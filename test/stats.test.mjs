import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  collectWideLocalStatsSections,
  getWideStatsHint,
  isAliveRoot,
  renderLocalStatsRows,
  runStats,
} from '../src/cli/stats.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function captureConsole() {
  const logs = [];
  return {
    logs,
    log: (message = '') => logs.push(message),
  };
}

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

  it('returns unavailable for copilot-headroom payloads with a zero token baseline', () => {
    assert.deepEqual(renderLocalStatsRows({
      summary: {
        api_requests: 100,
        compression: {
          requests_compressed: 25,
          total_tokens_before_with_cli_filtering: 0,
          total_tokens_saved_with_cli_filtering: 1500,
        },
      },
    }), {
      available: false,
      rows: [['Status', 'unavailable']],
    });
  });

  it('advertises --wide in myelin stats --help', () => {
    const result = spawnSync(process.execPath, ['bin/myelin', 'stats', '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /--wide\s+Show wide stats output/);
  });

  describe('wide local stats discovery', () => {
    it('skips extra local stats queries outside wide mode and prints one discovery hint when configured', async () => {
      const fetchCalls = [];
      const healthCalls = [];
      const config = {
        proxy: {
          engine: 'headroom_lite',
          headroom_lite: { enabled: true, port: 9001 },
          mitm: { enabled: false },
          copilot_headroom: { enabled: false },
        },
      };

      assert.equal(getWideStatsHint(config), 'More detail: myelin stats --wide');
      assert.equal(getWideStatsHint({
        proxy: {
          engine: 'headroom_lite',
          headroom_lite: { enabled: false },
          copilot_headroom: { enabled: false },
        },
      }), 'More detail: myelin stats --wide');

      assert.deepEqual(
        await collectWideLocalStatsSections({
          config,
          wide: false,
          fetchStats: async (url) => {
            fetchCalls.push(url);
            return null;
          },
        }),
        [],
      );
      assert.deepEqual(fetchCalls, []);

      const consoleCapture = captureConsole();
      await runStats(
        { wide: false },
        {
          loadConfig: async () => config,
          log: consoleCapture.log,
          probeHealth: (url) => {
            healthCalls.push(url);
            return true;
          },
          readStats: async (url) => {
            fetchCalls.push(url);
            return {
              service: 'headroom-lite',
              proxy_requests: 1,
              compress_requests: 1,
              compress_pct: 50,
              compress_tokens_saved: 2,
            };
          },
          pathExists: () => false,
        },
      );

      assert.deepEqual(fetchCalls, []);
      assert.deepEqual(healthCalls, ['http://127.0.0.1:9001/health']);
      assert.equal(
        consoleCapture.logs.filter(line => line === '  More detail: myelin stats --wide').length,
        1,
      );
      assert.equal(
        consoleCapture.logs.some(line => line.includes('1 total, 1 compressed')),
        false,
      );
    });

    it('queries configured localhost stats endpoints in wide mode and renders allowlisted rows', async () => {
      const fetchCalls = [];
      const config = {
        proxy: {
          engine: 'headroom_lite',
          headroom_lite: { enabled: true, port: 9001 },
          copilot_headroom: { enabled: true, port: 9002 },
        },
      };

      const sections = await collectWideLocalStatsSections({
        config,
        wide: true,
        fetchStats: async (url) => {
          fetchCalls.push(url);
          if (url === 'http://127.0.0.1:9001/stats') {
            return {
              service: 'headroom-lite',
              proxy_requests: 42,
              compress_requests: 7,
              compress_pct: 83.25,
              compress_tokens_saved: 1234,
              raw_payload: 'must not leak',
            };
          }

          return {
            summary: {
              api_requests: 100,
              compression: {
                requests_compressed: 25,
                total_tokens_before_with_cli_filtering: 4000,
                total_tokens_saved_with_cli_filtering: 1500,
              },
              debug: 'must not leak',
            },
          };
        },
      });

      assert.deepEqual(fetchCalls, [
        'http://127.0.0.1:9001/stats',
        'http://127.0.0.1:9002/stats',
      ]);
      assert.deepEqual(sections, [
        {
          label: 'headroom-lite',
          title: 'headroom-lite  (:9001)',
          available: true,
          rows: [
            ['Status', 'running'],
            ['Requests', '42 total, 7 compressed'],
            ['Compression', '83.3%'],
            ['Tokens', '1,234 saved'],
          ],
        },
        {
          label: 'copilot-headroom',
          title: 'copilot-headroom  (:9002)',
          available: true,
          rows: [
            ['Status', 'running'],
            ['Requests', '100 total, 25 compressed'],
            ['Compression', '37.5%'],
            ['Tokens', '1,500 saved'],
          ],
        },
      ]);
    });

    it('returns explicit unavailable sections when a wide stats endpoint is malformed or fails', async () => {
      const config = {
        proxy: {
          engine: 'headroom_lite',
          headroom_lite: { enabled: true, port: 9001 },
          copilot_headroom: { enabled: true, port: 9002 },
        },
      };

      const sections = await collectWideLocalStatsSections({
        config,
        wide: true,
        fetchStats: async (url) => {
          if (url === 'http://127.0.0.1:9001/stats') {
            throw new Error('connection refused');
          }

          return { summary: {} };
        },
      });

      assert.deepEqual(sections, [
        {
          label: 'headroom-lite',
          title: 'headroom-lite  (:9001)',
          available: false,
          rows: [['Status', 'unavailable']],
        },
        {
          label: 'copilot-headroom',
          title: 'copilot-headroom  (:9002)',
          available: false,
          rows: [['Status', 'unavailable']],
        },
      ]);
    });

    it('keeps mitmproxy before copilot-headroom when headroom-lite is disabled', async () => {
      const consoleCapture = captureConsole();
      await runStats(
        { wide: false },
        {
          loadConfig: async () => ({
            proxy: {
              engine: 'headroom',
              headroom_lite: { enabled: false, port: 9001 },
              mitm: { enabled: true, port: 9003 },
              copilot_headroom: { enabled: true, port: 9002 },
            },
          }),
          log: consoleCapture.log,
          probeHealth: () => true,
          probeRoot: () => true,
          pathExists: () => false,
        },
      );

      const sectionTitles = consoleCapture.logs.filter(line => /^  (mitmproxy|copilot-headroom)/.test(line));
      assert.deepEqual(sectionTitles, [
        '  mitmproxy  (:9003)  — Copilot CLI',
        '  copilot-headroom  (:9002)',
      ]);
    });

    it('queries only the selected Python headroom engine in wide mode', async () => {
      const fetchCalls = [];
      const sections = await collectWideLocalStatsSections({
        config: {
          proxy: {
            engine: 'headroom',
            headroom: { enabled: true, port: 9000 },
            headroom_lite: { enabled: true, port: 9001 },
            copilot_headroom: { enabled: false },
          },
        },
        wide: true,
        fetchStats: async (url) => {
          fetchCalls.push(url);
          return {
            summary: {
              api_requests: 1,
              compression: {
                requests_compressed: 1,
                total_tokens_before_with_cli_filtering: 100,
                total_tokens_saved_with_cli_filtering: 50,
              },
            },
          };
        },
      });

      assert.deepEqual(fetchCalls, ['http://127.0.0.1:9000/stats']);
      assert.deepEqual(sections.map(({ label }) => label), ['headroom']);
    });
  });

  describe('isAliveRoot', () => {
    it('treats non-2xx localhost root responses as alive for mitm compatibility', () => {
      const execStub = () => {
        const error = new Error('http 404');
        error.status = 22;
        throw error;
      };

      assert.equal(isAliveRoot('127.0.0.1', 8888, 2000, execStub), true);
    });
  });

  it('returns unavailable for copilot-headroom payloads with non-finite compression inputs', () => {
    assert.deepEqual(renderLocalStatsRows({
      summary: {
        api_requests: 100,
        compression: {
          requests_compressed: 25,
          total_tokens_before_with_cli_filtering: Number.POSITIVE_INFINITY,
          total_tokens_saved_with_cli_filtering: 1500,
        },
      },
    }), {
      available: false,
      rows: [['Status', 'unavailable']],
    });
  });

  it('does not fall through malformed headroom-lite payloads to copilot-headroom rendering', () => {
    assert.deepEqual(renderLocalStatsRows({
      service: 'headroom-lite',
      summary: {
        api_requests: 100,
        compression: {
          requests_compressed: 25,
          total_tokens_before_with_cli_filtering: 4000,
          total_tokens_saved_with_cli_filtering: 1500,
        },
      },
    }), {
      available: false,
      rows: [['Status', 'unavailable']],
    });
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
