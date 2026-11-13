import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SslOptions } from 'mysql2';

/** Configure trust before opening a pool, so bad certificate configuration fails at startup. */
export function databaseTls(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): SslOptions | undefined {
  const azure = host.toLowerCase().endsWith('.mysql.database.azure.com');
  const path = env.DATABASE_SSL_CA?.trim();
  const inline = env.DATABASE_SSL_CA_PEM?.trim();
  if (path && inline) throw new Error('Set only one of DATABASE_SSL_CA and DATABASE_SSL_CA_PEM.');
  if (env.DATABASE_SSL === 'false') {
    if (azure) throw new Error('Azure MySQL requires TLS. Remove DATABASE_SSL=false.');
    if (path || inline)
      throw new Error('A database CA certificate requires TLS. Remove DATABASE_SSL=false.');
    return undefined;
  }

  let ca: string[] | undefined;
  if (path) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new Error(`Cannot read DATABASE_SSL_CA file: ${path}`);
    }
    ca = certificates(bytes, 'DATABASE_SSL_CA');
  } else if (inline) {
    // Azure App Service settings can supply a PEM secret with literal escaped newlines.
    ca = certificates(Buffer.from(inline.replace(/\\r\\n|\\n/g, '\n')), 'DATABASE_SSL_CA_PEM');
  } else if (azure) {
    ca = certificates(
      readFileSync(new URL('./certs/azure-mysql-ca.pem', import.meta.url)),
      'bundled Azure CA',
    );
  }
  return {
    rejectUnauthorized: true,
    verifyIdentity: true,
    minVersion: 'TLSv1.2',
    ...(ca ? { ca } : {}),
  };
}

function certificates(bytes: Buffer, source: string): string[] {
  try {
    const text = bytes.toString('utf8').trim();
    const pem = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    // Accept concatenated PEM bundles or one binary DER certificate (Azure also distributes .crt files).
    if (
      pem &&
      text.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()
    )
      throw new Error('Unexpected content outside certificates.');
    const certs = pem ? pem.map((p) => new X509Certificate(p)) : [new X509Certificate(bytes)];
    if (certs.some((c) => !c.ca)) throw new Error('A CA certificate is required.');
    return certs.map((c) => c.toString());
  } catch {
    throw new Error(
      `${source} must contain valid CA certificates (a PEM bundle or a single DER certificate).`,
    );
  }
}
