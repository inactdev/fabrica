// The JSON Web Token a GitHub App authenticates as itself with - the
// only thing the App's private key is ever used for, and the only
// credential this process holds for longer than one call.
//
// Written against GitHub's current reference for "Generating a JSON Web
// Token (JWT) for a GitHub App", read before this was written rather
// than recalled:
//
//   - signed with RS256; "your JWT must be signed using the RS256
//     algorithm"
//   - `iat` is when the token was created, and "we recommend that you
//     set this 60 seconds in the past" to survive clock drift between
//     this machine and GitHub's
//   - `exp` is when it stops being usable, and "must be no more than 10
//     minutes into the future"
//   - `iss` is "the client ID or application ID of your GitHub App",
//     with "use of the client ID is recommended" - which is why
//     `FABRICA_GITHUB_APP_ID` is documented as the Client ID and is
//     never interpreted here, only copied into the claim
//   - passed as `Authorization: Bearer <jwt>`; for a JWT specifically,
//     "you must use Authorization: Bearer"
//
// This token can only ask for an installation token. It can read
// nothing and write nothing on its own, which is why a nine-minute life
// is harmless and why it is never cached: signing is local and cheap,
// and a cache would be one more place a credential sits.

import { createSign } from "node:crypto";

/** How far into the future `exp` is set. Inside GitHub's documented
 * ten-minute ceiling with a minute to spare, so a request that leaves
 * this machine right at the edge is still accepted when it lands. */
export const JWT_LIFETIME_SECONDS = 9 * 60;

/** How far into the past `iat` is set - GitHub's own recommendation,
 * and the amount its own sample scripts use. */
export const JWT_BACKDATE_SECONDS = 60;

/** base64url, as JWTs are encoded: base64 with the two URL-unsafe
 * characters swapped and the padding dropped. */
function base64url(value: Buffer | string): string {
  return (typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The claims this JWT carries, exported so a test can assert on them
 * after verifying the signature rather than re-deriving them. */
export interface AppJwtClaims {
  iat: number;
  exp: number;
  iss: string;
}

export function appJwtClaims(appId: string, nowSeconds: number): AppJwtClaims {
  return {
    iat: nowSeconds - JWT_BACKDATE_SECONDS,
    exp: nowSeconds + JWT_LIFETIME_SECONDS,
    iss: appId,
  };
}

/**
 * One signed JWT for `appId`. `nowSeconds` is a parameter rather than a
 * call to the clock so a test can pin the claims; the one caller
 * (`mint.ts`) passes the real time.
 *
 * Throws whatever node's signer throws for a key it cannot use - which
 * `requireAppCredentials` has already refused for, so reaching that
 * here means the file changed underneath a running task.
 */
export function appJwt(appId: string, privateKeyPem: string, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(appJwtClaims(appId, nowSeconds)));
  const signingInput = `${header}.${payload}`;
  const signature = base64url(createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem));
  return `${signingInput}.${signature}`;
}
