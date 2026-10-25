// The JWT is the one thing here that cannot be checked against GitHub
// without a registered App, so it is checked against GitHub's own
// documented requirements instead: RS256, a backdated `iat`, an `exp`
// no more than ten minutes out, and `iss` carrying the App's id. The
// signature is verified with the matching public key, so a test failure
// means the token really would be rejected rather than merely looking
// different.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerify } from "node:crypto";
import { JWT_BACKDATE_SECONDS, JWT_LIFETIME_SECONDS, appJwt, appJwtClaims } from "./jwt.ts";
import { testKeyPair } from "./helpers/test-key.ts";

const NOW = 1_800_000_000;

function decode(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

test("the JWT is three base64url segments, with GitHub's required header", () => {
  const { privateKeyPem } = testKeyPair();
  const token = appJwt("Iv1.fake", privateKeyPem, NOW);

  const segments = token.split(".");
  assert.equal(segments.length, 3);
  assert.deepEqual(decode(segments[0]), { alg: "RS256", typ: "JWT" });
  // base64url: no padding, and neither of base64's two URL-unsafe
  // characters anywhere in any segment.
  for (const segment of segments) assert.doesNotMatch(segment, /[+/=]/);
});

test("the claims are iat backdated, exp inside GitHub's ten-minute ceiling, and iss the App's id", () => {
  const claims = appJwtClaims("Iv1.fake", NOW);

  assert.deepEqual(claims, { iat: NOW - 60, exp: NOW + 540, iss: "Iv1.fake" });
  assert.equal(JWT_BACKDATE_SECONDS, 60, "GitHub's own recommendation is 60 seconds in the past");
  assert.ok(JWT_LIFETIME_SECONDS <= 600, "GitHub documents exp as no more than 10 minutes into the future");
  assert.ok(claims.exp - claims.iat <= 600 + JWT_BACKDATE_SECONDS);
});

test("the signature verifies with the matching public key, over header.payload", () => {
  const { privateKeyPem, publicKeyPem } = testKeyPair();
  const token = appJwt("Iv1.fake", privateKeyPem, NOW);
  const [header, payload, signature] = token.split(".");

  const verifier = createVerify("RSA-SHA256").update(`${header}.${payload}`);
  assert.equal(
    verifier.verify(publicKeyPem, Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64")),
    true
  );
});

test("a tampered payload no longer verifies", () => {
  const { privateKeyPem, publicKeyPem } = testKeyPair();
  const [header, , signature] = appJwt("Iv1.fake", privateKeyPem, NOW).split(".");
  const forged = Buffer.from(JSON.stringify(appJwtClaims("Iv1.someone-else", NOW)), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const verifier = createVerify("RSA-SHA256").update(`${header}.${forged}`);
  assert.equal(
    verifier.verify(publicKeyPem, Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64")),
    false
  );
});

test("a key this machine cannot sign with throws rather than producing an unsigned token", () => {
  assert.throws(() => appJwt("Iv1.fake", "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----\n", NOW));
});
