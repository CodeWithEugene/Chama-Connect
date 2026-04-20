<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-015 — Role records have empty `permissions` arrays

| Field | Value |
|---|---|
| Severity | High (authorization) |
| Surface | Auth / backend |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright recon (`/api/proxy/users/current-user` + `/api/proxy/roles`) |

## Evidence

`GET /api/proxy/roles` returns seven roles (Chairperson, ChamaAdmin, Member, Secretary, SuperAdmin, Treasurer, User), and the current-user endpoint embeds the role on the user:

```json
"role": {
  "id": "69c50c8a38f08070a83bd35b",
  "name": "User",
  "createdAt": "2026-03-26T10:38:02.540Z",
  "updatedAt": "2026-03-26T10:38:02.540Z",
  "permissions": []      ← always empty
},
"userType": "REGULAR"
```

Both endpoints confirm the `permissions` field exists on the schema but is never populated — for every role, for every user, on the live system.

## User impact

Two possibilities, both serious:

**A. Authorization is enforced at the front-end only.** Then an attacker can `curl` any backend endpoint and perform treasurer-only actions (loan approval, member removal, payout initiation) regardless of their role. Critical privilege-escalation hole.

**B. Authorization is enforced server-side via role *name* ("if user.role.name === 'Treasurer'").** Then the `permissions` array is dead code, but role-to-permission mapping is hard-coded in the server. Adding a new role (e.g. "Auditor") or a new action requires a code deploy. Operationally brittle — chamas in Kenya routinely invent roles (Welfare Lead, Investment Captain) and expect to assign scopes to them.

Either way the current design is wrong. We'd want to know which by asking the backend team, but the fix applies regardless.

## Root cause

The schema was designed for a permission-based RBAC (`role.permissions[]`) but the seed data / migration never wrote the entries. The feature was probably deferred with "we'll add permissions later" and the code then fell back to name-based checks (scenario B) or silently allows everything (scenario A).

## Proposed fix

1. Audit every server-side endpoint and confirm the authorization check. This is the only way to tell A from B.

2. Define permissions as strings and seed them:

```ts
// permissions/catalog.ts
export const PERMISSIONS = {
  CHAMA_CREATE: "chama:create",
  CHAMA_DELETE: "chama:delete",
  MEMBER_INVITE: "member:invite",
  MEMBER_REMOVE: "member:remove",
  CONTRIBUTION_READ: "contribution:read",
  CONTRIBUTION_MARK_PAID: "contribution:mark_paid",
  LOAN_REQUEST: "loan:request",
  LOAN_APPROVE: "loan:approve",
  LOAN_DISBURSE: "loan:disburse",
  PAYOUT_INITIATE: "payout:initiate",
  REPORT_EXPORT: "report:export",
  SETTINGS_WRITE: "settings:write",
} as const;
```

3. Migration — seed default permission sets:

```ts
const defaults: Record<string, string[]> = {
  Member:       [PERMISSIONS.CONTRIBUTION_READ, PERMISSIONS.LOAN_REQUEST],
  Secretary:    [..., PERMISSIONS.MEMBER_INVITE, PERMISSIONS.REPORT_EXPORT],
  Treasurer:    [..., PERMISSIONS.CONTRIBUTION_MARK_PAID, PERMISSIONS.LOAN_APPROVE, PERMISSIONS.LOAN_DISBURSE, PERMISSIONS.PAYOUT_INITIATE],
  Chairperson:  [..., PERMISSIONS.MEMBER_REMOVE, PERMISSIONS.SETTINGS_WRITE],
  ChamaAdmin:   Object.values(PERMISSIONS),
  SuperAdmin:   Object.values(PERMISSIONS),
  User:         [], // platform-level account, no chama-scoped perms
};
```

4. Enforce on every endpoint with a middleware helper:

```ts
router.post("/groups/:id/loans/:loanId/approve",
  requirePermission(PERMISSIONS.LOAN_APPROVE),
  approveLoan);
```

5. Expose a `GET /api/proxy/me/permissions` endpoint so the front-end can hide buttons the user can't use (UX, not security).

## Verification

- `curl /api/proxy/roles` → every role has a non-empty `permissions: [...]` array.
- Loan approval endpoint called by a Member-role user returns 403.
- Unit test matrix: every role × every permission → expected boolean.
