export interface Redaction {
  type: string;
  count: number;
}

export interface ScrubResult {
  text: string;
  redactions: Redaction[];
}

interface Rule {
  type: string;
  pattern: RegExp;
  /** Replace only this capture group, keeping the rest (e.g. the variable name in KEY=value). */
  group?: number;
  /** Extra check on the match, for rules the pattern alone can't decide. */
  verify?: (match: string) => boolean;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// Modeled on gitleaks' rules for the providers developers most often paste.
const RULES: Rule[] = [
  {
    type: "private-key",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  {
    type: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g,
  },
  {
    type: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g,
  },
  { type: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { type: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { type: "stripe-key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { type: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { type: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: "impression-token", pattern: /\bimp_[A-Za-z0-9_-]{40,}/g },
  {
    type: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    type: "url-credentials",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/gi,
    group: 1,
  },
  {
    type: "bearer-token",
    pattern: /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/g,
    group: 1,
  },
  {
    // .env style: NAME=value where the name suggests a secret.
    type: "env-secret",
    pattern:
      /\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?)[A-Za-z0-9_]*\s*[=:]\s*["']?([^\s"',;]{6,})["']?/gi,
    group: 1,
    verify: (m) =>
      !/^\[REDACTED/.test(m) &&
      !/^(?:true|false|null|none|undefined|changeme|example|your[_-].*|<.*>|\$\{?.*)$/i.test(
        m,
      ),
  },
  {
    type: "credit-card",
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    verify: (m) => {
      const d = m.replace(/\D/g, "");
      return d.length >= 13 && d.length <= 19 && luhn(d);
    },
  },
  {
    type: "ssn",
    pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  },
  {
    type: "email",
    pattern:
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
  },
];

/**
 * Replaces secrets and personal data with `[REDACTED:<type>]`. Run before
 * anything is stored or embedded. Rules run in order, so specific token
 * formats win over the generic env-style rule.
 */
export function scrub(input: string): ScrubResult {
  let text = input;
  const counts = new Map<string, number>();
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args) => {
      const match = args[0] as string;
      const captured = rule.group
        ? (args[rule.group] as string | undefined)
        : match;
      if (!captured || (rule.verify && !rule.verify(captured))) return match;
      counts.set(rule.type, (counts.get(rule.type) ?? 0) + 1);
      const tag = `[REDACTED:${rule.type}]`;
      return rule.group ? match.replace(captured, tag) : tag;
    });
  }
  return {
    text,
    redactions: [...counts].map(([type, count]) => ({ type, count })),
  };
}

/** True when nothing meaningful is left once placeholders are removed. */
export function isEmptyAfterScrub(text: string): boolean {
  return (
    text.replace(/\[REDACTED:[a-z-]+\]/g, "").replace(/[^\p{L}\p{N}]/gu, "")
      .length < 3
  );
}
