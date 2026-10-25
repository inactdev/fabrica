// A throwaway RSA key pair in the shape GitHub actually hands over, for
// the tests in this module. Generated per call rather than committed:
// a private key checked into a repository is a private key, however
// fake, and every secret scanner on earth is right to flag one.
//
// PKCS#1 ("-----BEGIN RSA PRIVATE KEY-----") on purpose: that is the
// format GitHub's "Generate a private key" button downloads, so a test
// that parses or signs with this is exercising the same path a real key
// takes. 2048 bits is the smallest size GitHub issues, and keeps key
// generation cheap enough to do per test.

import { generateKeyPairSync } from "node:crypto";

export interface TestKeyPair {
  /** PKCS#1 PEM, exactly as `FABRICA_GITHUB_APP_KEY` points at. */
  privateKeyPem: string;
  /** SPKI PEM, for verifying a JWT this module signed. */
  publicKeyPem: string;
}

export function testKeyPair(): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKeyPem: privateKey as unknown as string, publicKeyPem: publicKey as unknown as string };
}
