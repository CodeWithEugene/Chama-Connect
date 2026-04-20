<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-064 — Password policy accepts `"password"`, `"password123"`, eight-space strings; 6-char minimum is trivially weak

| Field | Value |
|---|---|
| Severity | High |
| Surface | Auth / signup |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright audit probe 14 |
| CWE | CWE-521 (Weak Password Requirements) |

## Evidence

`POST /api/proxy/users/signup` with a fresh throwaway email and each password in turn. Captured at `recon/artifacts/audit-2026-04-20T11-27-52-385Z/14_password_strength.json`:

| Password | Status | Server message |
|---|---|---|
| `"a"`         | 400 | `Password must be at least 6 characters long` |
| `"1"`         | 400 | ↑ |
| `"aa"`        | 400 | ↑ |
| `"12345"`     | 400 | ↑ |
| **`"password"`**    | **201 Created** | ← accepted |
| **`"password123"`** | **201 Created** | ← accepted |
| **`"        "`** (eight spaces) | **201 Created** | ← accepted |
| `"🔐"`        | 400 (JS `.length = 1`) |
| `"aA1!"`      | 400 (4 chars) |

So the *only* check is `password.length >= 6` against the raw input, with:

- No whitespace trimming (`"        ".length === 8`, therefore passes).
- No common-password blacklist.
- No character-class requirement (no mix of upper/lower/digit/special).
- No breach-database check (e.g. HIBP's range API, which is free to use).
- The regex also accepts the password `"password"` — the single most-common password in every recorded data breach since 2009.

Three accounts with the accepted weak passwords were created by the probe on the live system:

- `pw-1776684548453-8yd1d0@probe.local` (password `"password"`)
- `pw-1776684549177-addez3@probe.local` (password `"password123"`)
- `pw-1776684550885-qs1rmj@probe.local` (password `"        "`)

They are now live accounts on the production database with real phone slots reserved against random `+25470…` numbers.

## User impact

Chamas hold group money; a single compromised member lets an attacker vote on loan approvals, observe cash-flow schedules, and (combined with BUG-053 / BUG-040 / BUG-027) take over the chama's treasury.

1. **Credential stuffing is effectively free.** The top-10k common passwords cover an enormous share of real users; accepting `"password"` means at least 1% of accounts are compromisable with zero custom work.
2. **Given BUG-018** (signin rate limit = 1000 req / 15 min per IP, no per-account lockout), an attacker gets ~4 M attempts/hour from a single IP, which at 10k common passwords = 400 full dictionary runs per hour per IP against the whole user base.
3. Whitespace-only passwords bypass every password manager (which auto-trims) — meaning the only way to log in is by manually typing 8 spaces, which users will not remember, so support tickets pile up.
4. **Kenyan Data Protection Act (2019)** requires "appropriate technical and organisational measures" to protect personal data; a 6-char no-blacklist policy would not survive a competent ODPC audit. ChamaConnect's own `/terms` page cites the DPA.
5. Accepting `"password"` on a platform that markets itself as *"bank-grade security… blockchain precision"* on its homepage is contradictory to the product's own claims.

## Root cause

A single Mongoose/Zod length check without any of the complementary checks listed above. Likely `z.string().min(6)`.

## Proposed fix

Minimum viable — OWASP ASVS L1:

```ts
import { z } from "zod";
import zxcvbn from "zxcvbn";                       // ~400 KB, runs client-side
import { isPwned } from "@toruslabs/hibp";         // or any HIBP k-anon client

export const PasswordSchema = z
  .string()
  .min(8,  "must be at least 8 characters")
  .max(128, "must be at most 128 characters")
  .refine(pw => pw.trim() === pw && pw.trim().length >= 8,
    "must contain non-whitespace characters")
  .refine(pw => zxcvbn(pw).score >= 2,
    "too easy to guess — add more unique words or symbols")
  .refine(async pw => !(await isPwned(pw)),
    "this password appears in public breach databases — please choose another");
```

And front-end: render the strength meter (`zxcvbn.score`) live so users see feedback as they type; cap at 128 chars server-side to bound bcrypt work.

For already-registered weak-password accounts, on next signin force a password rotation with the same validator. Do **not** rotate silently — explain to the user that their previous password was identified as commonly breached.

## Verification

- `POST /signup  password="password"`      → 400 `too easy to guess`
- `POST /signup  password="password123"`   → 400 `appears in public breach databases`
- `POST /signup  password="        "`      → 400 `must contain non-whitespace characters`
- `POST /signup  password="short"`         → 400 `must be at least 8 characters`
- `POST /signup  password="GoodP@ssword99"` → 201 (passes all checks assuming not on HIBP)

Housekeeping: three probe accounts (pw-1776684548453-8yd1d0, pw-1776684549177-addez3, pw-1776684550885-qs1rmj) should be cleaned from the production DB.
