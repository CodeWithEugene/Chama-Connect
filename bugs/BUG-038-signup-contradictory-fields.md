<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-038 — Signup response has contradictory account-status fields (`isActive:false` + `accountStatus:"ACTIVE"` + `activatedAt` populated)

| Field | Value |
|---|---|
| Severity | Medium (authz / business-logic ambiguity) |
| Surface | API / data model |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

Fresh signup, response body on `201 Created`:

```json
{
  "message": "User Created",
  "status": "success",
  "data": {
    "id":                    "69e5fa243e9a7937fd3ca4bf",
    "email":                 "pwnownr_4022@example.com",
    "isActive":              false,
    "emailVerified":         false,
    "activatedAt":           "2026-04-20T10:04:20.421Z",
    "accountStatus":         "ACTIVE",
    "deletionRequestedAt":   null,
    "deletionCompletedAt":   null,
    "roleId":                "69c50c8a38f08070a83bd35b",
    ...
  }
}
```

Three fields that should all agree disagree:

| Field | Value | Implication |
|---|---|---|
| `isActive` | `false` | "This account is NOT active yet." |
| `accountStatus` | `"ACTIVE"` | "This account IS active." |
| `activatedAt` | `2026-04-20T10:04:20.421Z` | "Activation happened at signup time." |

A signed-up user **can** in fact sign in immediately (I did it) and receives a JWT with `userType: "REGULAR"`, so the *effective* truth is "the account is active". Which makes the `isActive: false` field either a lie or a semantic leftover.

## User impact

1. **Authorisation ambiguity.** Any middleware that does `if (!user.isActive) return 401` will refuse the user even though the platform actually considers them active. Any middleware that does `if (user.accountStatus !== 'ACTIVE') return 401` will let them through. Two middleware writers reading the same DB document will reach opposite conclusions.
2. **Email-verification regression risk.** If the product ever wants to gate actions on "email verified first", the dev will reach for `isActive` (currently wrong) and ship a change that is silently wrong on every existing account.
3. **Audit confusion.** Operations staff reading the DB can't tell which users are truly gated vs active — "isActive: false" should mean "blocked / not yet activated", but here it means nothing.

This also intersects with BUG-037 and BUG-005 — because the semantics of "active" are muddled, any future "you must verify email before making a contribution" flow will be hard to wire without bugs.

## Root cause

The schema carries **two** independently-maintained activation markers:

- The legacy `isActive: boolean` field.
- The newer `accountStatus: 'ACTIVE' | 'PENDING' | 'DEACTIVATED' | 'DELETED'` enum.

Signup sets `accountStatus` to `"ACTIVE"` (modern code path) and defaults `isActive` to `false` (legacy field never updated on the success path). Downstream code reads one or the other, depending on when it was written.

## Proposed fix

1. Pick one field as the source of truth — recommend `accountStatus` (it already expresses the four real states of an account lifecycle: `PENDING`, `ACTIVE`, `DEACTIVATED`, `DELETED`).
2. Derive `isActive` from `accountStatus` in a virtual, or remove it entirely:

```ts
// models/user.ts
UserSchema.virtual('isActive').get(function () {
  return this.accountStatus === 'ACTIVE';
});
```

3. Add a migration that sets `accountStatus = (isActive ? 'ACTIVE' : 'PENDING')` on every historical row, then drops the `isActive` column.

4. Document the lifecycle in the README:

```text
PENDING      → email/phone not verified
ACTIVE       → can sign in, can join chamas
DEACTIVATED  → admin-disabled; signin returns 403
DELETED      → GDPR delete window; read-only
```

5. Introduce `emailVerified` / `phoneVerified` as separate, boolean, additive gates so "active + email not yet verified" is a representable state.

## Verification

1. Signup → response body has exactly one status field (`accountStatus`) plus derived `isActive`.
2. DB migration dry-run shows 0 rows with mismatched states after running.
3. Audit `rg 'isActive'` in the backend — no remaining reads, only the virtual definition.
4. Regression test in `/recon/tests/user-lifecycle.spec.ts`.
