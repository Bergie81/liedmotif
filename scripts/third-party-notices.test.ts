import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { thirdPartyNotices } from './third-party-notices.mjs';

describe('third-party notices for the published images', () => {
  let root: string;
  const lockPackages: Record<string, object> = { '': { name: 'liedmotif' } };

  function write(path: string, content: string) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  function install(name: string, lock: object, files: Record<string, string> = {}) {
    const dir = `node_modules/${name}`;
    lockPackages[dir] = lock;
    write(`${dir}/package.json`, JSON.stringify({ name, ...lock }));
    for (const [file, content] of Object.entries(files)) write(`${dir}/${file}`, content);
  }

  function notices() {
    write('package-lock.json', JSON.stringify({ packages: lockPackages }));
    return thirdPartyNotices(root);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'third-party-notices-'));
    for (const key of Object.keys(lockPackages)) if (key) delete lockPackages[key];
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('carries each production package with its version, license and full license text', () => {
    install(
      'left-pad',
      { version: '1.3.0', license: 'MIT' },
      { LICENSE: 'Copyright Left Pad Author' },
    );
    const text = notices();
    expect(text).toContain('left-pad@1.3.0');
    expect(text).toContain('License: MIT');
    expect(text).toContain('Copyright Left Pad Author');
  });

  it('keeps an Apache NOTICE file and every spelling of a license file', () => {
    install(
      'apache-pkg',
      { version: '1.0.0', license: 'Apache-2.0' },
      { 'LICENSE.md': 'apache terms', NOTICE: 'apache attribution' },
    );
    install(
      'british-pkg',
      { version: '1.0.0', license: 'ISC' },
      {
        'licence.txt': 'isc terms',
        'COPYING.LESSER': 'lgpl terms',
        'ThirdPartyNoticeText.txt': 'unicode terms',
      },
    );
    const text = notices();
    for (const content of [
      'apache terms',
      'apache attribution',
      'isc terms',
      'lgpl terms',
      'unicode terms',
    ]) {
      expect(text).toContain(content);
    }
  });

  it('leaves out dev tooling, platform builds not installed here, and the workspaces', () => {
    install('vitest', { version: '5.0.0', license: 'MIT', dev: true }, { LICENSE: 'dev terms' });
    lockPackages['node_modules/@img/sharp-win32-x64'] = { version: '0.35.5', license: 'MIT' };
    lockPackages['node_modules/@liedmotif/db'] = { resolved: 'packages/db', link: true };
    install('kept', { version: '1.0.0', license: 'MIT' }, { LICENSE: 'kept terms' });
    const text = notices();
    expect(text).toContain('kept@1.0.0');
    expect(text).not.toContain('vitest');
    expect(text).not.toContain('sharp-win32-x64');
    expect(text).not.toContain('@liedmotif/db');
  });

  it('points to the project when a package ships no license file', () => {
    install('bare', {
      version: '2.0.0',
      license: 'MIT',
      repository: { url: 'git+https://github.com/acme/bare.git' },
    });
    const text = notices();
    expect(text).toContain('bare@2.0.0');
    expect(text).toContain('No license file in the package. See https://github.com/acme/bare');
  });

  it('includes the code a package vendors under dist/compiled', () => {
    install(
      'next',
      { version: '16.0.0', license: 'MIT' },
      {
        license: 'next terms',
        'dist/compiled/acorn/LICENSE': 'vendored acorn terms',
        'dist/compiled/@scope/thing/LICENSE': 'vendored scoped terms',
      },
    );
    const text = notices();
    expect(text).toContain('next/dist/compiled/acorn');
    expect(text).toContain('vendored acorn terms');
    expect(text).toContain('vendored scoped terms');
  });

  it('adds the licenses of parts that do not come from npm', () => {
    install('kept', { version: '1.0.0', license: 'MIT' }, { LICENSE: 'kept terms' });
    write('docker/third-party-licenses/font-example-OFL.txt', 'Open Font License terms');
    const text = notices();
    expect(text).toContain('font-example-OFL.txt');
    expect(text).toContain('Open Font License terms');
  });

  it('writes the same file however the packages were installed', () => {
    install('zeta', { version: '1.0.0', license: 'MIT' }, { LICENSE: 'z' });
    install('alpha', { version: '1.0.0', license: 'MIT' }, { LICENSE: 'a' });
    const text = notices();
    expect(text.indexOf('alpha@1.0.0')).toBeLessThan(text.indexOf('zeta@1.0.0'));
  });

  it('refuses to write an empty list, so a broken install cannot ship without notices', () => {
    expect(() => notices()).toThrow(/no installed production packages/i);
  });
});
