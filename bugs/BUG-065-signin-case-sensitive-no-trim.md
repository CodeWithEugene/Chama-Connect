<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-065 — Signin is email-case-sensitive and does not trim whitespace (silent lockout + enumeration)

| Field | Value |
|---|---|
| Severity | High |
| Surface | Auth / signin |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright audit probe 07 |
| CWE | CWE-178 (Improper Handling of Case Sensitivity), CWE-203 (Observable Discrepancy) |

## Evidence

`POST /api/proxy/users/signin` with a known-valid account and varying the email casing / whitespace. Full capture: `recon/artifacts/audit-2026-04-20T11-27-52-385Z/07_email_case.json`.

| Email variant (password identical, correct) | Status | Server response | Latency |
|---|---|---|---|
| `eugenegabriel.ke@gmail.com`       | **200** | full signin success payload | 479 ms |
| `EUGENEGABRIEL.KE@GMAIL.COM`       | **400** | `Invalid email or phone number` | 320 ms |
| `eugenegabriel.ke@gmail.com` (second try, identical) | 200 | success | 444 ms |
| `eugenegabriel.ke@gmail.com ` (trailing space) | **400** | `Invalid email or phone number` | 350 ms |
| ` eugenegabriel.ke@gmail.com` (leading space) | **400** | `Invalid email or phone number` | 311 ms |
| `eugenegabriel.ke+test@gmail.com`  | 400 | `Invalid email or phone number` | 328 ms (correctly rejected — different address) |

So the signin handler performs a **raw, exact-match compare** of the submitted email string to the stored one — no `.toLowerCase()`, no `.trim()`.

## User impact

1. **Silent lockout for legitimate users.** Mobile keyboards (iOS, Samsung, Gboard) auto-capitalise the first letter of an email input by default. Autofill from Apple / Chrome password manager sometimes pastes with a trailing space. Users see "Invalid email or phone number" — an error that blames them for credentials they typed correctly — and cannot recover without typing manually in the exact case and whitespace they used at signup. For a product whose primary user is a Kenyan treasurer on a mobile device this is the single biggest conversion / retention killer on the auth path.
2. **Enumeration amplifier.** The ~160 ms latency gap between "known email, correct password" (~460 ms) and "wrong-case email" (~320 ms) confirms the server short-circuits at the user-lookup step for unknown emails (lookup fails → return immediately). This complements BUG-031 (differential error messages) and BUG-032 (signup enumeration): attackers can enumerate the user list with a ~300 ms-per-attempt loop regardless of the defensive messaging on the "wrong password" vs "unknown email" branch.
3. **Silent duplicate accounts.** Signup — if it has the same raw-equality check — allows both `user@foo.com` and `User@Foo.com` to be registered as separate accounts. Two humans thinking they registered the same email will be on different chamas. Data integrity problem.
4. **Support load.** Inbound "I can't log in" tickets from case/whitespace mismatches are the #1 predictable support cost of this bug.

## Root cause

The signin handler does something like `await User.findOne({ email })` with the raw user-supplied email, and `email` is stored in the DB as whatever string the user typed at signup (not normalised). The two values have to be byte-identical for the lookup to succeed.

## Proposed fix

1. **Normalise email at both write and read sites.** Pick one canonical form: lower-case, `trim()`, NFKC Unicode normalise. Store that, and always look up with that.

   ```ts
   // util/email.ts
   export function normaliseEmail(raw: string): string {
     return raw.trim().normalize("NFKC").toLowerCase();
   }
   ```

2. **Write migration** that normalises every existing `user.email` — most will already be lowercase, but any that aren't would silently become lookupable:

   ```ts
   const users = await User.find({});
   for (const u of users) {
     const normed = normaliseEmail(u.email);
     if (normed !== u.email) await User.updateOne({ _id: u._id }, { email: normed });
   }
   ```

   Before running, also de-duplicate: if two accounts normalise to the same string, merge using a business rule (keep the one with more data, archive the other, email the user).

3. **Validate at ingress** with a Zod schema that does the normalisation and then validates the RFC-5321 shape:

   ```ts
   import { z } from "zod";
   export const EmailSchema = z.string().trim().toLowerCase().email();
   ```

4. **Tests.** Add a matrix test on `/signin` and `/signup` that asserts the outcome is **identical** across `email`, `EMAIL`, ` email `, ` Email `, etc.

5. **Bonus:** treat email-verification and password-reset lookups the same way — else those become inconsistent (e.g. user signs up with `User@x`, reset email lookup fails because normaliser lowercased it).

## Verification

- `POST /signin email="EUGENEGABRIEL.KE@GMAIL.COM" password=<valid>` → 200 success.
- `POST /signin email=" eugenegabriel.ke@gmail.com "` → 200 success.
- `POST /signup email="User@x.com"` then `POST /signup email="user@x.com"` → second returns 400 `already registered`.
- Timing delta between "unknown email" and "known email" collapses to < 50 ms once normalisation runs on both branches.
