import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

async function withKey(key: string | undefined) {
  vi.resetModules();
  vi.doMock("./env", () => ({ env: () => ({ TOKEN_ENCRYPTION_KEY: key, GOOGLE_MODE: "real" }) }));
  return import("./crypto");
}

afterEach(() => vi.doUnmock("./env"));

describe("token encryption key", () => {
  it("accepts 32 random bytes in base64 and round-trips", async () => {
    const c = await withKey(randomBytes(32).toString("base64"));
    expect(c.decryptSecret(c.encryptSecret("refresh-token-synthetic"))).toBe("refresh-token-synthetic");
  });

  it("accepts a long random passphrase", async () => {
    const c = await withKey("correct horse battery staple synthetic passphrase 42");
    expect(c.decryptSecret(c.encryptSecret("abc"))).toBe("abc");
  });

  it("refuses a short key in real Google mode", async () => {
    const c = await withKey("too-short");
    expect(() => c.encryptSecret("abc")).toThrow(/at least 40 characters/);
  });

  it("refuses a missing key in real Google mode", async () => {
    const c = await withKey(undefined);
    expect(() => c.encryptSecret("abc")).toThrow(/not set/);
  });

  it("a different key cannot decrypt", async () => {
    const a = await withKey("passphrase-number-one-synthetic-0000000000");
    const sealed = a.encryptSecret("abc");
    const b = await withKey("passphrase-number-two-synthetic-0000000000");
    expect(() => b.decryptSecret(sealed)).toThrow();
  });
});
