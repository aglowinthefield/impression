import { afterAll, beforeAll, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import { isEmptyAfterScrub, scrub } from "./scrub.js";
import { createTestDb } from "./test-db.js";
import { fakeProviders } from "./test-providers.js";

// Fake but correctly shaped samples. Built by concatenation so scanners don't flag this file.
const fake = {
  aws: "AKIA" + "IOSFODNN7EXAMPLE",
  github: "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  anthropic: "sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz0123456789",
  openai: "sk-proj-" + "abcdefghijklmnopqrstuvwxyz0123456789ABCD",
  stripe: "sk_live_" + "abcdefghijklmnop1234",
  slack: "xoxb-" + "1234567890-abcdefghij",
  google: "AIza" + "SyA1234567890abcdefghijklmnopqrstuv",
  jwt:
    "eyJhbGciOiJIUzI1NiJ9." +
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0." +
    "abcdefghijk123456",
};

test.each(Object.entries(fake))(
  "redacts a %s token and keeps the sentence",
  (_n, secret) => {
    const r = scrub(`Deploy with ${secret} from CI`);
    expect(r.text).not.toContain(secret);
    expect(r.text).toMatch(/^Deploy with \[REDACTED:[a-z-]+\] from CI$/);
    expect(r.redactions).toHaveLength(1);
  },
);

test("redacts a private key block", () => {
  const r = scrub(
    "key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\ndef==\n-----END RSA PRIVATE KEY-----\nthen restart",
  );
  expect(r.text).toBe("key:\n[REDACTED:private-key]\nthen restart");
});

test("redacts .env values but keeps the variable name", () => {
  const r = scrub(
    'DATABASE_PASSWORD=hunter2hunter2\nSTRIPE_SECRET: "abc123def456"\nPORT=3000',
  );
  expect(r.text).toBe(
    'DATABASE_PASSWORD=[REDACTED:env-secret]\nSTRIPE_SECRET: "[REDACTED:env-secret]"\nPORT=3000',
  );
});

test("leaves env placeholders and booleans alone", () => {
  const text =
    "set API_KEY=changeme, TOKEN=<your-token>, SECRET_ENABLED=true, PASSWORD=$PW";
  expect(scrub(text).text).toBe(text);
});

test("redacts credentials in URLs and bearer headers but keeps the host", () => {
  const r = scrub(
    "postgres://app:s3cretpw@db.internal:5432/app and Authorization: Bearer abcdefghij0123456789xyz",
  );
  expect(r.text).toBe(
    "postgres://app:[REDACTED:url-credentials]@db.internal:5432/app and Authorization: Bearer [REDACTED:bearer-token]",
  );
});

test("redacts emails, SSNs and Luhn-valid card numbers only", () => {
  const r = scrub(
    "ping jane.doe@example.com, ssn 123-45-6789, card 4111 1111 1111 1111, order 1234 5678 9012 3456",
  );
  expect(r.text).toBe(
    "ping [REDACTED:email], ssn [REDACTED:ssn], card [REDACTED:credit-card], order 1234 5678 9012 3456",
  );
});

test("leaves ordinary developer notes untouched", () => {
  const notes = [
    "Migrations run via make db-migrate; see packages/api/drizzle",
    "The token endpoint returns 401 when the bearer token is missing",
    "Commit abc123def4567890abcdef1234567890abcdef12 fixed it",
    "Use sk- prefixed keys for OpenAI and export OPENAI_API_KEY first",
    "Call 2026-11-04T12:00:00Z or version 1.2.3",
  ];
  for (const n of notes) expect(scrub(n)).toEqual({ text: n, redactions: [] });
});

test("counts redactions per type", () => {
  const r = scrub(`a@b.io c@d.io ${fake.aws}`);
  expect(r.redactions).toEqual(
    expect.arrayContaining([
      { type: "email", count: 2 },
      { type: "aws-access-key", count: 1 },
    ]),
  );
});

test("isEmptyAfterScrub", () => {
  expect(isEmptyAfterScrub("[REDACTED:aws-access-key]")).toBe(true);
  expect(isEmptyAfterScrub("use [REDACTED:email] for alerts")).toBe(false);
});

let t: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
let token: string;
beforeAll(async () => {
  t = await createTestDb();
  app = createApp(t.db, fakeProviders());
  token = await createToken(t.db, "alice");
});
afterAll(() => t.drop());

const call = (method: string, path: string, body: unknown) =>
  app.request(`/api/memories${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

test("create stores the scrubbed text and reports what was removed", async () => {
  const res = await call("POST", "", {
    scope: "user",
    content: `Use key ${fake.aws} for the bucket`,
  });
  const body = (await res.json()) as { content: string; redactions: unknown };
  expect(res.status).toBe(201);
  expect(body.content).toBe("Use key [REDACTED:aws-access-key] for the bucket");
  expect(body.redactions).toEqual([{ type: "aws-access-key", count: 1 }]);
});

test("create rejects content that is only a secret", async () => {
  expect(
    (await call("POST", "", { scope: "user", content: fake.github })).status,
  ).toBe(422);
});

test("patch scrubs too", async () => {
  const m = (await (
    await call("POST", "", { scope: "user", content: "plain note" })
  ).json()) as { id: string };
  const res = await call("PATCH", `/${m.id}`, {
    content: `now ${fake.stripe} here`,
  });
  expect(((await res.json()) as { content: string }).content).toBe(
    "now [REDACTED:stripe-key] here",
  );
  expect(
    (await call("PATCH", `/${m.id}`, { content: fake.slack })).status,
  ).toBe(422);
});
