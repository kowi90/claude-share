import { isIP } from "node:net";

import forge from "node-forge";

export interface ServerCert {
  certPem: string;
  keyPem: string;
}

/** Generates a TLS server cert for the API port, signed by the MITM CA. */
export async function generateServerCert(
  caCertPem: string,
  caKeyPem: string,
  lanIp: string | null,
  publicHostname: string = "bore.pub",
): Promise<ServerCert> {
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);

  const keys = await new Promise<forge.pki.KeyPair>((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (err, keypair) => {
      if (err) reject(err);
      else resolve(keypair);
    });
  });

  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "02";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);

  cert.setSubject([{ name: "commonName", value: "claude-share-api" }]);
  cert.setIssuer(caCert.subject.attributes);

  const altNames: { type: number; value?: string; ip?: string }[] = [
    { type: 2, value: "localhost" },
    { type: 2, value: publicHostname },
    { type: 7, ip: "127.0.0.1" },
  ];
  // lanIp is normally an IP, but ADVERTISE_HOST may also be a DNS name
  if (lanIp) {
    altNames.push(
      isIP(lanIp) ? { type: 7, ip: lanIp } : { type: 2, value: lanIp },
    );
  }

  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames },
  ]);

  cert.sign(caKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}
