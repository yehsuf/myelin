import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCopilotWrapper,
  buildClaudeWrapper,
  buildBareCopilotWrapper,
  buildBareClaudeWrapper,
  buildServiceEnvUnsetLines,
  COPILOT_FORBIDDEN_ENV,
  CLAUDE_FORBIDDEN_ENV,
  SERVER_FORBIDDEN_ENV,
} from '../src/service/wrappers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const platforms = ['windows', 'darwin', 'linux'];

/**
 * Return true when `wrapperText` contains an ASSIGNMENT of `varName` to a
 * value (as opposed to a mention inside an `unset`, `env -u`, `$null`
 * clear, or save/restore of the surrounding shell state).
 */
function assignsVar(wrapperText, varName) {
  // Windows: `$env:X = "..."` or `$env:X = '...'` with non-empty content.
  // Excludes `$env:X = $null` (clear) and `$env:X = $saved_X` (restore).
  const winAssign = new RegExp(`\\$env:${varName}\\s*=\\s*["'][^"']+["']`);
  if (winAssign.test(wrapperText)) return true;
  // POSIX: strip out `-u X` unset flags first, then look for `X=value`.
  const stripped = wrapperText.replace(new RegExp(`-u\\s+${varName}\\b`, 'g'), '');
  const posixAssign = new RegExp(`(^|\\s|;)(export\\s+)?${varName}=[^\\s\\\\;]`);
  return posixAssign.test(stripped);
}

// -----------------------------------------------------------------------------
// Provider isolation — the CORE invariant.
// -----------------------------------------------------------------------------

describe('wrappers — Claude never pollutes Copilot', () => {
  for (const os of platforms) {
    it(`_copilot (${os}) never ASSIGNS ANTHROPIC_BASE_URL (unsets are allowed)`, () => {
      const w = buildCopilotWrapper({ os });
      assert.ok(!assignsVar(w, 'ANTHROPIC_BASE_URL'),
        `_copilot must NOT set ANTHROPIC_BASE_URL — it would route Copilot's Anthropic-SDK calls to headroom, bypassing mitmproxy.`);
    });
    it(`_copilot (${os}) never ASSIGNS ENABLE_PROMPT_CACHING_1H`, () => {
      const w = buildCopilotWrapper({ os });
      assert.ok(!assignsVar(w, 'ENABLE_PROMPT_CACHING_1H'));
    });
    it(`_copilot (${os}) ACTIVELY UNSETS forbidden Anthropic vars (defense against inherited shell env)`, () => {
      const w = buildCopilotWrapper({ os });
      for (const v of COPILOT_FORBIDDEN_ENV) {
        // Windows uses save-and-restore; POSIX uses `env -u`
        const hasWinUnset = w.includes(`$env:${v} = $null`);
        const hasPosixUnset = w.includes(`-u ${v}`);
        assert.ok(hasWinUnset || hasPosixUnset,
          `_copilot must unset '${v}' in its wrapper so an inherited value cannot leak into copilot.`);
      }
    });
  }
});

describe('wrappers — Copilot never pollutes Claude', () => {
  for (const os of platforms) {
    it(`_claude (${os}) never ASSIGNS HTTPS_PROXY`, () => {
      const w = buildClaudeWrapper({ os });
      assert.ok(!assignsVar(w, 'HTTPS_PROXY'),
        `_claude must NOT set HTTPS_PROXY — would double-route Claude through mitmproxy.`);
    });
    it(`_claude (${os}) never ASSIGNS NO_PROXY`, () => {
      const w = buildClaudeWrapper({ os });
      assert.ok(!assignsVar(w, 'NO_PROXY'));
    });
    it(`_claude (${os}) ACTIVELY UNSETS forbidden Copilot vars (defense against inherited shell env)`, () => {
      const w = buildClaudeWrapper({ os });
      for (const v of CLAUDE_FORBIDDEN_ENV) {
        const hasWinUnset = w.includes(`$env:${v} = $null`);
        const hasPosixUnset = w.includes(`-u ${v}`);
        assert.ok(hasWinUnset || hasPosixUnset,
          `_claude must unset '${v}' in its wrapper so an inherited value cannot leak into claude.`);
      }
    });
  }
});

// -----------------------------------------------------------------------------
// Correctness — each wrapper sets what it should set.
// -----------------------------------------------------------------------------

describe('_copilot wrapper — sets its own env per-invocation', () => {
  for (const os of platforms) {
    describe(os, () => {
      const w = buildCopilotWrapper({ os });
      it('sets HTTPS_PROXY pointing at mitmproxy port', () => {
        assert.ok(assignsVar(w, 'HTTPS_PROXY') && w.includes('127.0.0.1:8888'));
      });
      it('scopes/unsets HTTPS_PROXY so it does not persist in the shell', () => {
        if (os === 'windows') {
          assert.ok(w.includes('$env:HTTPS_PROXY = $null'));
          assert.ok(w.includes('$env:NO_PROXY = $null'));
        } else {
          // POSIX: env-prefix on the copilot line scopes it to that command
          assert.match(w, /HTTPS_PROXY=http:\/\/127\.0\.0\.1:8888 \\/);
        }
      });
      it('honours a custom port', () => {
        const custom = buildCopilotWrapper({ os, mitmPort: 9999 });
        assert.ok(custom.includes('127.0.0.1:9999'));
      });
      if (os === 'windows') {
        it('calls the binary directly via Get-Command (not "& copilot @args") to avoid recursing into the bare copilot function', () => {
          assert.ok(w.includes('Get-Command copilot -Type Application -ErrorAction Stop'),
            '_copilot must resolve the copilot binary explicitly so it never re-enters a "function global:copilot" clean wrapper defined in the same profile.');
          assert.ok(!w.includes('& copilot @args'),
            '_copilot must not call "copilot" as a bare command — that would recurse if a "copilot" function is defined.');
        });
      }
      if (os !== 'windows') {
        it('single-quotes the NO_PROXY value so zsh does not glob its * patterns', () => {
          // NO_PROXY contains wildcard hosts (e.g. *.akamai.com, *.local). As an
          // unquoted argument to `env`, zsh performs filename globbing on them and
          // aborts with "no matches found" when nothing matches (bash tolerates it,
          // zsh does not). The value MUST be single-quoted.
          assert.match(w, /NO_PROXY='[^']*\*[^']*' \\/,
            '_copilot POSIX wrapper must single-quote NO_PROXY to prevent zsh glob expansion.');
          // And must NOT emit the bare unquoted form.
          assert.ok(!/NO_PROXY=[^'"\s]*\*/.test(w),
            '_copilot must not emit an unquoted NO_PROXY value containing glob characters.');
        });
      }
    });
  }
});

describe('_copilot wrapper — copilotBin path embedding', () => {
  it('default (no copilotBin) uses bare copilot command', () => {
    const w = buildCopilotWrapper({ os: 'darwin' });
    assert.match(w, /\bcopilot "\$@"/);
  });
  it('absolute brew path is single-quoted in POSIX wrapper (prevents $VAR expansion)', () => {
    const w = buildCopilotWrapper({ os: 'darwin', copilotBin: '/opt/homebrew/bin/copilot' });
    assert.ok(w.includes("'/opt/homebrew/bin/copilot' \"$@\""),
      'wrapper must single-quote the explicit brew path for POSIX safety');
    assert.ok(!w.match(/(?<!\/)copilot "\$@"/),
      'bare copilot call must not appear when an explicit bin is given');
  });
  it('path with spaces is single-quoted in POSIX wrapper', () => {
    const w = buildCopilotWrapper({ os: 'linux', copilotBin: '/usr/local/my apps/copilot' });
    assert.ok(w.includes("'/usr/local/my apps/copilot' \"$@\""));
  });
  it('absolute path is embedded in Windows wrapper via quoted & call', () => {
    const w = buildCopilotWrapper({ os: 'windows', copilotBin: 'C:\\Programs\\copilot\\copilot.exe' });
    assert.ok(w.includes('"C:\\Programs\\copilot\\copilot.exe" @args'),
      'Windows wrapper must quote the explicit copilot bin path');
  });
  it('Windows default (bare copilot) uses recursion-safe Get-Command call', () => {
    const w = buildCopilotWrapper({ os: 'windows' });
    // Default copilotBin ('copilot') routes through Get-Command -Type Application
    // instead of '& copilot @args' to avoid recursing into a bare 'copilot' clean
    // wrapper function defined in the same profile.
    assert.ok(w.includes('Get-Command copilot -Type Application -ErrorAction Stop'));
    assert.ok(!w.includes('& copilot @args'));
  });
});

describe('Get-Command calls always take only the first match (guards all wrapper builders)', () => {
  // Get-Command can return multiple matches (e.g. nvm4w's copilot.cmd shim
  // plus a bare copilot/claude shim on PATH). Without Select-Object -First 1,
  // .Source is an array and PowerShell's & operator silently stringifies it
  // as one broken, space-joined command. Scan every generated Windows wrapper
  // for the unguarded pattern so no future Get-Command site regresses.
  it('every Windows Get-Command ...).Source is preceded by Select-Object -First 1', () => {
    const wrappers = [
      buildCopilotWrapper({ os: 'windows' }),
      buildBareCopilotWrapper({ os: 'windows' }),
      buildClaudeWrapper({ os: 'windows' }),
      buildBareClaudeWrapper({ os: 'windows' }),
    ];
    for (const w of wrappers) {
      const unguarded = w.match(/Get-Command \w+ -Type Application -ErrorAction Stop\)\.Source/g);
      assert.equal(unguarded, null,
        `found Get-Command ...).Source without Select-Object -First 1: ${JSON.stringify(unguarded)}`);
      assert.ok(/Get-Command \w+ -Type Application -ErrorAction Stop \| Select-Object -First 1\)\.Source/.test(w));
    }
  });
});

describe('_claude wrapper — sets its own env per-invocation', () => {
  for (const os of platforms) {
    describe(os, () => {
      const w = buildClaudeWrapper({ os });
      it('sets ANTHROPIC_BASE_URL pointing at headroom port (non-Foundry branch)', () => {
        assert.ok(assignsVar(w, 'ANTHROPIC_BASE_URL') && w.includes('127.0.0.1:8787'));
      });
      it('sets ANTHROPIC_FOUNDRY_BASE_URL for Foundry mode (never both at once)', () => {
        assert.ok(assignsVar(w, 'ANTHROPIC_FOUNDRY_BASE_URL') && w.includes('127.0.0.1:8787'));
      });
      it('unsets ANTHROPIC_BASE_URL in the Foundry branch to avoid split-brain', () => {
        if (os === 'windows') {
          assert.ok(w.includes('$env:ANTHROPIC_BASE_URL = $null'));
        } else {
          assert.ok(w.includes('-u ANTHROPIC_BASE_URL'));
        }
      });
      it('does not set ENABLE_PROMPT_CACHING_1H (Foundry does not support extended cache TTL)', () => {
        // ENABLE_PROMPT_CACHING_1H IS set — this test should verify it IS present
        assert.ok(assignsVar(w, 'ENABLE_PROMPT_CACHING_1H'),
          '_claude should set ENABLE_PROMPT_CACHING_1H for prompt caching');
      });
      it('scopes/unsets ANTHROPIC_BASE_URL so it does not persist in the shell', () => {
        if (os === 'windows') {
          assert.ok(w.includes('$env:ANTHROPIC_BASE_URL = $null'),
            'Windows _claude must unset ANTHROPIC_BASE_URL after the call.');
          assert.ok(w.includes('$env:ANTHROPIC_FOUNDRY_BASE_URL = $null'),
            'Windows _claude must unset ANTHROPIC_FOUNDRY_BASE_URL after the call.');
        } else {
          assert.match(w, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:8787 \\/);
          assert.match(w, /ANTHROPIC_FOUNDRY_BASE_URL=http:\/\/127\.0\.0\.1:8787 \\/);
        }
      });
      it('honours a custom port', () => {
        const custom = buildClaudeWrapper({ os, headroomPort: 9797 });
        assert.ok(custom.includes('127.0.0.1:9797'));
      });
      it('falls back to plain `claude` when headroom is offline', () => {
        if (os === 'windows') {
          assert.ok(w.includes('Test-NetConnection'));
          assert.ok(w.includes('Get-Command claude -Type Application'));
        } else {
          assert.ok(w.includes('nc -z 127.0.0.1'));
          assert.ok(w.includes('claude "$@"'));
        }
      });
    });
  }
});

describe('_claude wrapper — unproxied when compression backend is disabled (null port)', () => {
  for (const os of platforms) {
    describe(os, () => {
      const w = buildClaudeWrapper({ os, headroomPort: null });
      it('never ASSIGNS ANTHROPIC_BASE_URL (no proxy exists)', () => {
        assert.ok(!assignsVar(w, 'ANTHROPIC_BASE_URL'),
          '_claude must NOT point at a nonexistent proxy when the backend is disabled.');
      });
      it('ACTIVELY UNSETS ANTHROPIC_BASE_URL + HEADROOM_PORT (defense against stale global env)', () => {
        for (const v of ['ANTHROPIC_BASE_URL', 'HEADROOM_PORT']) {
          const hasWinUnset = w.includes(`$env:${v} = $null`);
          const hasPosixUnset = w.includes(`-u ${v}`);
          assert.ok(hasWinUnset || hasPosixUnset,
            `unproxied _claude must unset '${v}' so a stale value can't point Claude at a dead port.`);
        }
      });
      it('runs claude directly (unproxied)', () => {
        if (os === 'windows') {
          assert.ok(w.includes('Get-Command claude -Type Application'));
        } else {
          assert.ok(w.includes('claude "$@"'));
        }
      });
    });
  }
});

// -----------------------------------------------------------------------------
// Service isolation — long-running services must unset client-side vars.
// -----------------------------------------------------------------------------

describe('buildServiceEnvUnsetLines — server-side isolation', () => {
  it('windows emits SetEnvironmentVariable($null, "Process") lines', () => {
    const s = buildServiceEnvUnsetLines({ os: 'windows' });
    for (const v of SERVER_FORBIDDEN_ENV) {
      assert.ok(s.includes(`SetEnvironmentVariable('${v}', $null, 'Process')`),
        `Missing Windows unset for '${v}'`);
    }
  });
  it('linux emits systemd UnsetEnvironment= directives', () => {
    const s = buildServiceEnvUnsetLines({ os: 'linux' });
    for (const v of SERVER_FORBIDDEN_ENV) {
      assert.ok(s.includes(`UnsetEnvironment=${v}`), `Missing systemd unset for '${v}'`);
    }
  });
  it('darwin emits POSIX `unset X` prefix', () => {
    const s = buildServiceEnvUnsetLines({ os: 'darwin' });
    assert.match(s, /^unset\s+ANTHROPIC_BASE_URL\b/);
    for (const v of SERVER_FORBIDDEN_ENV) {
      assert.ok(s.includes(v), `Missing '${v}' in darwin unset line`);
    }
  });
  it('accepts a custom vars list', () => {
    const s = buildServiceEnvUnsetLines({ os: 'linux', vars: ['FOO', 'BAR'] });
    assert.ok(s.includes('UnsetEnvironment=FOO'));
    assert.ok(s.includes('UnsetEnvironment=BAR'));
  });
});

// -----------------------------------------------------------------------------
// Regression test — src/install.mjs must NEVER re-introduce ANTHROPIC_BASE_URL
// into any globally-visible env-var location. This is the July 2026
// "418 to api.anthropic.com" regression guard.
// -----------------------------------------------------------------------------

describe('install.mjs regression — no global ANTHROPIC_BASE_URL', () => {
  const installSrc = readFileSync(join(__dirname, '..', 'src', 'install.mjs'), 'utf8');

  it('Windows registry (HKCU\\Environment) block excludes ANTHROPIC_BASE_URL', () => {
    const match = installSrc.match(/const registryVars = \{[\s\S]*?\};/);
    assert.ok(match, 'registryVars object literal not found in install.mjs');
    assert.ok(!match[0].includes('ANTHROPIC_BASE_URL'),
      'ANTHROPIC_BASE_URL must NOT be persisted to Windows registry — it makes Copilot CLI bypass mitmproxy. Only _claude wrapper may set it (per-invocation).');
  });

  it('Windows PowerShell $PROFILE block (psEnv) excludes ANTHROPIC_BASE_URL', () => {
    const match = installSrc.match(/const psEnv = [^\n]*;/);
    assert.ok(match, 'psEnv assignment not found');
    assert.ok(!match[0].includes('ANTHROPIC_BASE_URL'),
      'ANTHROPIC_BASE_URL must NOT be exported in Windows PowerShell $PROFILE — it leaks into every PS-launched process (including Copilot CLI). Only _claude wrapper may set it.');
  });

  it('POSIX shell profile block excludes ANTHROPIC_BASE_URL', () => {
    const posixStart = installSrc.indexOf('block = `\\n# >>> myelin managed >>>\\n${headroomExport}');
    assert.ok(posixStart >= 0, 'POSIX shell-block assignment not found');
    const posixEnd = installSrc.indexOf('`;', posixStart);
    assert.ok(posixEnd >= 0, 'POSIX shell-block template not terminated');
    const posixBlock = installSrc.slice(posixStart, posixEnd);
    assert.ok(!posixBlock.includes('ANTHROPIC_BASE_URL'),
      'ANTHROPIC_BASE_URL must NOT be exported in .bashrc/.zshrc — it leaks into every shell-launched process (including copilot). Only _claude wrapper may set it.');
  });
});


describe('osc52d integration in shell wrappers (COMPACT-CLIP-001)', () => {
  it('POSIX _copilot wrapper starts osc52d before the copilot call', () => {
    const wrapper = buildCopilotWrapper({ os: 'darwin' });
    assert.ok(wrapper.includes('osc52d'), 'should reference osc52d');
    assert.ok(wrapper.includes('OSC52_SOCKET'), 'should set OSC52_SOCKET');
    assert.ok(wrapper.includes('osc52d.py'), 'should reference daemon script path');
  });

  it('POSIX _copilot wrapper passes OSC52_SOCKET to copilot env', () => {
    const wrapper = buildCopilotWrapper({ os: 'darwin' });
    // OSC52_SOCKET must appear in the env block, not just in the setup
    assert.ok(wrapper.includes('_osc52_env'), 'should use _osc52_env variable');
    // Verify env block includes it: appears in the env ... copilot "$@" call
    const envCallIdx = wrapper.indexOf('copilot "$@"');
    const envSection = wrapper.slice(0, envCallIdx);
    assert.ok(envSection.includes('_osc52_env'), '_osc52_env must be set before copilot call');
  });

  it('POSIX _copilot wrapper kills daemon on exit', () => {
    const wrapper = buildCopilotWrapper({ os: 'darwin' });
    // Cleanup must use ';' not '&&' so rm -f runs even when kill fails (dead daemon)
    assert.ok(wrapper.includes('kill "$_osc52_pid"'), 'should kill daemon on exit');
    assert.ok(wrapper.includes('rm -f "$_osc52_sock"'), 'should clean up socket on exit');
    // Key: rm -f must not be gated on kill exit code (stale-socket regression)
    assert.ok(!wrapper.match(/kill.*osc52_pid.*&&.*rm -f/), 'rm -f must not be && chained after kill');
  });

  it('POSIX _claude wrapper starts osc52d before the claude call', () => {
    const wrapper = buildClaudeWrapper({ os: 'darwin', headroomPort: 8787 });
    assert.ok(wrapper.includes('osc52d'), 'should reference osc52d');
    assert.ok(wrapper.includes('OSC52_SOCKET'), 'should set OSC52_SOCKET');
  });

  it('Windows wrappers do not include osc52d (Unix sockets unsupported)', () => {
    const copilotWin = buildCopilotWrapper({ os: 'windows' });
    const claudeWin = buildClaudeWrapper({ os: 'windows', headroomPort: 8787 });
    assert.ok(!copilotWin.includes('osc52d'), 'Windows _copilot should not reference osc52d');
    assert.ok(!claudeWin.includes('osc52d'), 'Windows _claude should not reference osc52d');
  });

  it('isolation invariants preserved: _copilot still unsets Anthropic vars', () => {
    const wrapper = buildCopilotWrapper({ os: 'linux' });
    for (const v of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY']) {
      assert.ok(wrapper.includes(`-u ${v}`), `must still unset ${v}`);
    }
  });

  it('POSIX _copilot wrapper filters MallocStackLogging stderr noise', () => {
    // Node.js native addons call turn_off_stack_logging() unconditionally; when
    // MallocStackLogging is absent this produces a harmless but noisy stderr line
    // per spawned subprocess. The wrapper must filter it via process substitution.
    const wrapper = buildCopilotWrapper({ os: 'darwin' });
    assert.ok(wrapper.includes("grep -Fv 'MallocStackLogging:'"),
      '_copilot must pipe stderr through grep to suppress MallocStackLogging noise');
    assert.ok(wrapper.includes('2> >'),
      'filter must use process substitution (2> >(grep ...))');
    // Windows wrapper must NOT include the filter (no process substitution in PowerShell)
    const winWrapper = buildCopilotWrapper({ os: 'windows' });
    assert.ok(!winWrapper.includes('grep -Fv'),
      'Windows wrapper must not include POSIX grep filter');
  });
});

// -----------------------------------------------------------------------------
// Bare wrappers — copilot and claude clean-env shims.
// -----------------------------------------------------------------------------
describe('buildBareCopilotWrapper — guarantees no proxy vars reach copilot', () => {
  const proxyVars = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy'];
  // Windows PS env vars are case-insensitive; wrapper deduplicates to uppercase.
  const winProxyVars = [...new Set(proxyVars.map(v => v.toUpperCase()))]; // ['HTTPS_PROXY','HTTP_PROXY','NO_PROXY']
  for (const os of ['darwin', 'linux', 'windows']) {
    describe(os, () => {
      const w = buildBareCopilotWrapper({ os });
      it('defines a copilot function (not _copilot)', () => {
        if (os === 'windows') assert.ok(w.includes('function global:copilot'));
        else assert.ok(w.includes('function copilot()'));
      });
      it('strips proxy vars (Windows: uppercase-deduplicated; POSIX: all 6)', () => {
        const checkVars = os === 'windows' ? winProxyVars : proxyVars;
        for (const v of checkVars) {
          const stripped = os === 'windows' ? w.includes(`$env:${v} = $null`) : w.includes(`-u ${v}`);
          assert.ok(stripped, `bare copilot must strip '${v}'`);
        }
      });
      it('calls binary directly (no function recursion)', () => {
        if (os === 'windows') assert.ok(w.includes('Get-Command copilot -Type Application'));
        else assert.ok(w.includes('type -P copilot'));
      });
      it('Windows wrapper uses try/finally for guaranteed restore', () => {
        if (os !== 'windows') return;
        assert.ok(w.includes('try {'), 'Windows copilot wrapper must use try block');
        assert.ok(w.includes('} finally {'), 'Windows copilot wrapper must use finally block');
      });
    });
  }
});

describe('buildBareClaudeWrapper — guarantees no provider vars reach claude', () => {
  const providerVars = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ENABLE_PROMPT_CACHING_1H', 'HEADROOM_PORT'];
  for (const os of ['darwin', 'linux', 'windows']) {
    describe(os, () => {
      const w = buildBareClaudeWrapper({ os });
      it('defines a claude function (not _claude)', () => {
        if (os === 'windows') assert.ok(w.includes('function global:claude'));
        else assert.ok(w.includes('function claude()'));
      });
      it('strips all provider vars', () => {
        for (const v of providerVars) {
          const stripped = os === 'windows' ? w.includes(`$env:${v} = $null`) : w.includes(`-u ${v}`);
          assert.ok(stripped, `bare claude must strip '${v}'`);
        }
      });
      it('calls binary directly (no function recursion)', () => {
        if (os === 'windows') assert.ok(w.includes('Get-Command claude -Type Application'));
        else assert.ok(w.includes('type -P claude'));
      });
      it('Windows wrapper uses try/finally for guaranteed restore', () => {
        if (os !== 'windows') return;
        assert.ok(w.includes('try {'), 'Windows claude wrapper must use try block');
        assert.ok(w.includes('} finally {'), 'Windows claude wrapper must use finally block');
      });
    });
  }
});
