# Azure MySQL public root certificates

`azure-mysql-ca.pem` contains the two current public Azure Database for MySQL root CAs. These are public trust anchors,
not client certificates or private keys. The PEM copies were extracted from Node's bundled Mozilla trust store and are
identified by the SHA-256 fingerprints below. Do not add server certificates or intermediate certificates to this bundle.

| Certificate                                   | SHA-256 fingerprint                                                 | Expires (UTC) | Publisher download                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| DigiCert Global Root G2                       | `CB3CCBB76031E5E0138F8DD39A23F9DE47FFC35E43C1144CEA27D46A5AB1CB5F`  | 2038-01-15    | [DigiCert PEM](https://cacerts.digicert.com/DigiCertGlobalRootG2.crt.pem)                                           |
| Microsoft RSA Root Certificate Authority 2017 | `C741F70F4B2A8D88BF2E71C14122EF53EF10EBA0ECFA5E64CFA20F418853073E0` | 2042-07-18    | [Microsoft DER](https://www.microsoft.com/pkiops/certs/Microsoft%20RSA%20Root%20Certificate%20Authority%202017.crt) |

Reviewed on 2026-11-13 against [Azure MySQL TLS guidance](https://learn.microsoft.com/en-us/azure/mysql/flexible-server/security-tls).
Microsoft rotates intermediate certificates independently; trusting the roots allows these changes without pinning an intermediate.
For announced root changes, obtain the replacement from the publisher links in Microsoft's guidance, verify its fingerprint,
CA status and validity, convert DER to PEM if needed, and update the bundle and fingerprint tests together. Deploy and
restart all app and CLI processes. The application also permits an administrator-provided CA bundle without a code change.

The bundled roots target current Azure public-cloud endpoints. If another cloud/region still needs the legacy DigiCert
Global Root CA, supply an appropriate custom bundle following Microsoft's region-specific guidance.
