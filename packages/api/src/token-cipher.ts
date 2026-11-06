import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * Seals GitHub user tokens at rest with AES-256-GCM. The key comes from the GitHub
 * client secret, so there is no second secret to manage. Rotating the secret makes
 * stored tokens unreadable, and people sign in again.
 */
export function tokenCipher(secret: string) {
  const key = Buffer.from(
    hkdfSync("sha256", secret, "impression", "github-user-tokens", 32),
  );
  return {
    seal(plain: string): string {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return [iv, c.getAuthTag(), body]
        .map((b) => b.toString("base64url"))
        .join(".");
    },
    /** Returns null if the value is malformed or was sealed with another key. */
    open(sealed: string | null): string | null {
      if (!sealed) return null;
      try {
        const [iv, tag, body] = sealed
          .split(".")
          .map((p) => Buffer.from(p, "base64url"));
        const d = createDecipheriv("aes-256-gcm", key, iv as Buffer);
        d.setAuthTag(tag as Buffer);
        return Buffer.concat([d.update(body as Buffer), d.final()]).toString(
          "utf8",
        );
      } catch {
        return null;
      }
    },
  };
}
