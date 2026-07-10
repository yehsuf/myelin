import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SERVER = join(REPO_ROOT, 'src', 'mcp', 'git-extra.py');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

function callMcp(requests) {
  const input = requests.map(request => JSON.stringify(request)).join('\n') + '\n';
  const result = spawnSync(PYTHON, [SERVER], {
    cwd: REPO_ROOT,
    input,
    encoding: 'utf8',
    timeout: 10000,
  });
  if (result.error) throw result.error;
  return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

describe('git-extra MCP server', () => {
  it('responds to initialize', () => {
    const [resp] = callMcp([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }]);
    assert.equal(resp.result?.serverInfo?.name, 'git-extra');
    assert.ok(resp.result?.protocolVersion);
  });

  it('lists two tools', () => {
    const [resp] = callMcp([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }]);
    const names = resp.result.tools.map(tool => tool.name);
    assert.ok(names.includes('git_blame'));
    assert.ok(names.includes('git_log_rich'));
  });

  it('git_log_rich returns commit history', () => {
    const [resp] = callMcp([{
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'git_log_rich', arguments: { n: 3 } },
    }]);
    const text = resp.result?.content?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'Expected non-empty output');
  });

  it('git_blame rejects unsafe paths', () => {
    const [resp] = callMcp([{
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'git_blame', arguments: { path: 'file; rm -rf /' } },
    }]);
    const hasError = resp.error != null || (resp.result?.content?.[0]?.text ?? '').includes('Unsafe');
    assert.ok(hasError, 'Expected rejection of unsafe path');
  });

  it('unknown method returns error', () => {
    const [resp] = callMcp([{ jsonrpc: '2.0', id: 1, method: 'bad/method', params: {} }]);
    assert.ok(resp.error != null, 'Expected error for unknown method');
  });
});
