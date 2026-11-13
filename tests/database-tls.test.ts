import { afterEach, describe, expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseTls } from '../src/server/database-tls.ts';

const bundle = readFileSync(
  new URL('../src/server/certs/azure-mysql-ca.pem', import.meta.url),
  'utf8',
);
const host = 'tempo.mysql.database.azure.com';
const dirs: string[] = [];
function file(bytes: string | Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'tempo-ca-'));
  dirs.push(dir);
  const path = join(dir, 'ca.crt');
  writeFileSync(path, bytes);
  return path;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

describe('MySQL certificate configuration', () => {
  it('uses the current Azure roots and verifies certificates and hostnames with TLS 1.2+', () => {
    const options = databaseTls(host, {});
    expect(options).toMatchObject({
      rejectUnauthorized: true,
      verifyIdentity: true,
      minVersion: 'TLSv1.2',
    });
    const certs = (options!.ca as string[]).map((pem) => new X509Certificate(pem));
    expect(certs.map((c) => c.fingerprint256)).toEqual([
      'CB:3C:CB:B7:60:31:E5:E0:13:8F:8D:D3:9A:23:F9:DE:47:FF:C3:5E:43:C1:14:4C:EA:27:D4:6A:5A:B1:CB:5F',
      'C7:41:F7:0F:4B:2A:8D:88:BF:2E:71:C1:41:22:EF:53:EF:10:EB:A0:CF:A5:E6:4C:FA:20:F4:18:85:30:73:E0',
    ]);
    for (const c of certs) {
      expect(c.ca).toBe(true);
      expect(c.verify(c.publicKey)).toBe(true);
      expect(new Date(c.validTo).getTime()).toBeGreaterThan(Date.now());
    }
  });
  it('uses the default trust store for other hosts, including Azure lookalikes', () => {
    expect(databaseTls('mysql.example.com', {})!.ca).toBeUndefined();
    expect(databaseTls(`${host}.example.com`, {})!.ca).toBeUndefined();
  });
  it('loads a PEM file and accepts a single DER CA file', () => {
    const cert = new X509Certificate(bundle);
    expect(databaseTls(host, { DATABASE_SSL_CA: file(bundle) })!.ca).toHaveLength(2);
    expect(databaseTls(host, { DATABASE_SSL_CA: file(cert.raw) })!.ca).toEqual([cert.toString()]);
  });
  it('allows custom trust for Azure and inline PEM from App Service settings', () => {
    const cert = new X509Certificate(bundle).toString();
    expect(databaseTls(host, { DATABASE_SSL_CA_PEM: cert })!.ca).toEqual([cert]);
    expect(databaseTls(host, { DATABASE_SSL_CA_PEM: cert.replaceAll('\n', '\\n') })!.ca).toEqual([
      cert,
    ]);
  });
  it('reports missing, empty, malformed and ambiguous certificate configuration', () => {
    expect(() => databaseTls(host, { DATABASE_SSL_CA: '/missing/azure-ca.pem' })).toThrow(
      'Cannot read DATABASE_SSL_CA',
    );
    for (const bytes of [
      '',
      'invalid certificate',
      bundle + '\n-----BEGIN CERTIFICATE-----\nbroken',
    ]) {
      expect(() => databaseTls(host, { DATABASE_SSL_CA: file(bytes) })).toThrow(
        'valid CA certificates',
      );
    }
    expect(() => databaseTls(host, { DATABASE_SSL_CA_PEM: 'broken' })).toThrow(
      'DATABASE_SSL_CA_PEM',
    );
    expect(() =>
      databaseTls(host, { DATABASE_SSL_CA: 'file', DATABASE_SSL_CA_PEM: bundle }),
    ).toThrow('only one');
  });
  it('rejects disabling TLS for Azure or when a CA is configured, while allowing local development', () => {
    expect(() => databaseTls(host, { DATABASE_SSL: 'false' })).toThrow('Azure MySQL requires TLS');
    expect(() =>
      databaseTls('localhost', { DATABASE_SSL: 'false', DATABASE_SSL_CA: 'file' }),
    ).toThrow('requires TLS');
    expect(databaseTls('localhost', { DATABASE_SSL: 'false' })).toBeUndefined();
  });
});
