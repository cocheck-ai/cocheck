import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { looksSecret } from "../src/tool-label.ts";

// LooksSecret drops env-style assignments whose name ends in a secret word, URL credentials and "password is X".
describe("looksSecret", () => {
  // Only the shapes the gitleaks default ruleset finds stay in this list.
  const dropped = [
    "sk_live_51HabcdefGhijklmnop",
    "use rk_test_abcdefgh12345678 here",
    "curl -u admin:hunter2 https://api.example.com/x",
    "curl --user admin:hunter2 https://api.example.com/x",
    "curl -s -uadmin:hunter2 https://api.example.com/x",
    "glpat-abcdefghij1234567890",
    "xapp-1-A0123456789-1234567890123-abcdef",
  ];
  for (const s of dropped) it(`drops ${s}`, () => assert.equal(looksSecret(s), true));

  // These pinned hand-written shapes that were removed. They have no vendor format, so they are
  // not detected now. Bound stated in docs/security.md. Flipped, not deleted, so a change in what the gitleaks rules cover is noticed.
  const notDetected = [
    "STRIPE_KEY=abcd1234",
    "SECRET_KEY=hunter2xyz",
    "ANTHROPIC_KEY=abcdefgh",
    "PASSWORD=abc",
    "DATABASE_URL=postgres://admin:hunter2@db.local:5432/app",
    "my password is hunter2",
    "sk-abcdefgh12345678",
    "Authorization: Bearer abcdefgh12345678",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI",
    "export TOKEN=abc123",
    "client_secret: s3cr3tvalue",
    "whsec_abcdefghijklmnop",
    "db_passwd=x",
    "MY_PWD: x",
    "GOOGLE_CREDENTIALS='x'",
    "service-credential=x",
    "api_token: \"x\"",
    "apiKey=abc",
    "clientSecret: 'abc'",
    "{\"STRIPE_KEY\": \"abc\"}",
    "password was abc",
    "password: abc",
    "curl https://bob:pw@example.com/x",
    "redis://:hunter2@cache.local:6379/0",
    "REDIS=redis://:p@h",
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "authorization: basic dXNlcjpwYXNzd29yZA==",
    "-H 'AUTHORIZATION: BASIC dXNlcjpwYXNzd29yZA=='",
    "Basic dXNlcjpwYXNzd29yZA==",
    "npm_abcdefghijklmnopqrstuvwxyzABCDEF0123",
    "SG.abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ_",
    "ssh --pass=hunter2 host",
    "pw=hunter2",
    "passphrase: correct horse",
    "passphrase=abc",
    "mysql -u root -phunter2 mydb",
    "sshpass -p hunter2 ssh host",
    "sshpass -phunter2 ssh host",
    "machine example.com login bob password hunter2",
    "login bob password hunter2",
  ];
  for (const s of notDetected) it(`not detected (free-prose or generic shape): ${s}`, () => assert.equal(looksSecret(s), false));

  // the opposite miss: ordinary text and code with no value must stay readable
  const kept = [
    "set the API key in settings",
    "KEY_COLUMN = 0",
    'os.environ["API_KEY"]',
    "API_KEY=",
    "if API_KEY == None: pass",
    "monkey=1",
    "https://example.com/path?x=1",
    "https://user@example.com/x",
    "check the password policy",
    "the token count is low",
    "turkey: roast",
    "risk_assessment_value and task_list_items",
    "ask_user_for_input",
    "http://localhost:3000/a@b",
    "redis://cache.local:6379/0",
    // Ordinary text near the new shapes
    "curl -u",
    "curl -u user https://example.com",
    "curl -H 'Accept: a:b' https://example.com",
    "the passphrase field",
    "pw",
    "use pw for short",
    "mysql -p",
    "mysql -p mydb",
    "sshpass -p",
    "import npm_modules from here",
    "cd npm_modules",
    "SG. is the prefix in prose",
    "Basic configuration is enough",
    "Basic Authentication is weak",
    "bypass=1 compass=2",
    "the password policy",
  ];
  for (const s of kept) it(`keeps ${s}`, () => assert.equal(looksSecret(s), false));

  it("the worst 6000-character inputs stay under 100 ms", () => {
    const inputs = [
      "curl ".repeat(1200),
      "curl -u ".repeat(750),
      "Basic ".repeat(1000),
      "mysql ".repeat(1000),
      "sshpass ".repeat(750),
      "machine x login ".repeat(375),
      "a".repeat(6000),
      "SG.".concat("a".repeat(5997)),
      "Basic ".concat("a".repeat(5994)),
    ];
    for (const s of inputs) {
      const t = performance.now();
      looksSecret(s.slice(0, 6000));
      assert.ok(performance.now() - t < 100, `slow on ${s.slice(0, 12)}`);
    }
  });

  // A regex engine without a linear-time guarantee must not stall the hook on a long field.
  it("the two pathological 50000-character inputs finish under 100 ms", () => {
    for (const s of ["a.".repeat(25000) + ":", "a_".repeat(25000) + "pass"]) {
      const t = performance.now();
      looksSecret(s);
      assert.ok(performance.now() - t < 100, `slow on ${s.slice(0, 6)}`);
    }
  });
});
