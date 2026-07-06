import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseRtkVersion, rtkInstallStrategy } from '../src/tools/rtk.mjs';
import { parseHeadroomVersion, headroomHealthUrl } from '../src/tools/headroom.mjs';

describe('RTK version parsing', () => {
  it('parses version from rtk --version output', () => {
    const v = parseRtkVersion('rtk 0.5.1');
    assert.equal(v, '0.5.1');
  });
  it('returns null for empty string', () => {
    assert.equal(parseRtkVersion(''), null);
  });
  it('returns null for unrecognised output', () => {
    assert.equal(parseRtkVersion('not a version'), null);
  });
});

describe('RTK install strategy', () => {
  it('returns brew on darwin', () => {
    const s = rtkInstallStrategy('darwin');
    assert.equal(s[0].method, 'brew');
  });
  it('returns github_release first on linux', () => {
    const s = rtkInstallStrategy('linux');
    assert.equal(s[0].method, 'github_release');
  });
  it('returns github_release first on windows', () => {
    const s = rtkInstallStrategy('windows');
    assert.equal(s[0].method, 'github_release');
  });
  it('always includes cargo as last fallback', () => {
    const s = rtkInstallStrategy('darwin');
    assert.equal(s[s.length - 1].method, 'cargo');
  });
});

describe('Headroom version parsing', () => {
  it('parses version from headroom --version output', () => {
    const v = parseHeadroomVersion('headroom 1.2.3');
    assert.equal(v, '1.2.3');
  });
  it('parses version from headroom-ai style', () => {
    const v = parseHeadroomVersion('headroom-ai 1.0.0');
    assert.equal(v, '1.0.0');
  });
});

describe('headroomHealthUrl', () => {
  it('constructs URL from port', () => {
    assert.equal(headroomHealthUrl(8787), 'http://127.0.0.1:8787/health');
  });
  it('uses default 8787', () => {
    assert.equal(headroomHealthUrl(), 'http://127.0.0.1:8787/health');
  });
});
