import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  generateLiteLLMConfig,
  generateLiteLLMStartCommand,
  liteLLMConfigPath,
} from '../src/service/litellm-service.mjs';

describe('generateLiteLLMConfig', () => {
  it('includes headroom guardrail at specified port', () => {
    const yaml = generateLiteLLMConfig({ headroomPort: 8787 });
    assert.ok(yaml.includes('http://127.0.0.1:8787'), 'headroom URL present');
    assert.ok(yaml.includes('guardrail: headroom'), 'guardrail name present');
    assert.ok(yaml.includes('mode: pre_call'), 'pre_call mode present');
  });

  it('includes both cheap and complex models', () => {
    const yaml = generateLiteLLMConfig({ cheapModel: 'claude-haiku-4-5', complexModel: 'claude-sonnet-4-6' });
    assert.ok(yaml.includes('claude-haiku-4-5'));
    assert.ok(yaml.includes('claude-sonnet-4-6'));
  });

  it('uses specified port', () => {
    const yaml = generateLiteLLMConfig({ litellmPort: 4001 });
    assert.ok(yaml.includes('port: 4001'));
  });

  it('uses specified api_base', () => {
    const yaml = generateLiteLLMConfig({ apiBase: 'https://custom.api.example.com' });
    assert.ok(yaml.includes('https://custom.api.example.com'));
  });

  it('returns a string', () => {
    assert.strictEqual(typeof generateLiteLLMConfig(), 'string');
  });
});

describe('generateLiteLLMStartCommand', () => {
  it('includes the config path and port', () => {
    const cmd = generateLiteLLMStartCommand({
      venvPath: '/home/user/.myelin/venv',
      configPath: '/home/user/.myelin/litellm-config.yaml',
      port: 4000,
    });
    assert.ok(cmd.includes('litellm-config.yaml'));
    assert.ok(cmd.includes('--port 4000'));
    assert.ok(cmd.includes('-m litellm'));
  });

  it('derives the venv python layout + separators from the venv style, not the host', () => {
    // POSIX venv -> bin/python, forward slashes only.
    const posix = generateLiteLLMStartCommand({
      venvPath: '/srv/managed/venv',
      configPath: '/srv/managed/litellm-config.yaml',
    });
    assert.ok(posix.includes('/srv/managed/venv/bin/python'), posix);
    assert.ok(!posix.includes('\\'), posix);
    // Windows venv (even resolved on a POSIX host) -> Scripts\python.exe,
    // backslashes only. A host-native join would splice a forward slash.
    const win = generateLiteLLMStartCommand({
      venvPath: 'D:\\managed\\venv',
      configPath: 'D:\\managed\\litellm-config.yaml',
    });
    assert.ok(win.includes('D:\\managed\\venv\\Scripts\\python.exe'), win);
    assert.ok(!win.includes('/venv'), win);
  });
});

describe('liteLLMConfigPath', () => {
  it('returns path inside .myelin', () => {
    const p = liteLLMConfigPath('/home/user');
    assert.ok(p.includes('.myelin'));
    assert.ok(p.includes('litellm-config.yaml'));
  });
});
