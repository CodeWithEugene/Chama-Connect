<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-072 — `/api/proxy/users/admin` uses two different role-names (`super admins` vs `admins`) across HTTP methods on the same resource

| Field | Value |
|---|---|
| Severity | Medium |
| Surface | API / authorisation |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright audit probe 27 |

## Evidence

Calling `/api/proxy/users/admin` with a regular `User` role Bearer token (Eugene's, `role.name === "User"`):

| Method | Status | Body |
|---|---|---|
| GET    | 400 | `"Only super admins can access user administration"` |
| POST   | 404 | `"Not Found"` |
| PATCH  | 404 | `"Not Found"` |
| PUT    | 404 | `"Not Found"` |
| DELETE | 400 | `"Only admins can delete users"` |

Full capture: `recon/artifacts/audit2-2026-04-20T12-04-52-213Z/27_users_admin.json`.

Two distinct issues visible in one capture:

### 72.A — inconsistent role name across methods of the same endpoint

- `GET /users/admin`    → requires `super admins` (plural, two words)
- `DELETE /users/admin` → requires `admins` (plural, one word)

From `/api/proxy/roles` (recon, 2026-04-20), the canonical roles are `Chairperson`, `ChamaAdmin`, `Member`, `Secretary`, `SuperAdmin`, `Treasurer`, `User`. **Neither `"super admin"` nor `"admin"` matches any of those exactly.** The messages are ad-hoc strings written by whoever authored each handler, not derived from the role taxonomy. Consequences:

1. A user whose `role.name === "ChamaAdmin"` **may or may not** be able to DELETE. Only inspection of the server code would tell — but the message claims "admins" is enough. A user whose role name is "SuperAdmin" matches GET conceptually but not the exact string `"super admins"`.
2. The API is effectively a mystery role-matcher: handlers either (a) do substring matches (`role.name.toLowerCase().includes("admin")`), (b) hard-code role IDs that drift from role names over time, or (c) depend on `isSuperadmin` — the boolean claim in the JWT we saw in BUG-016. Any of (a)/(b)/(c) makes role-auth fragile.
3. An auditor cannot answer "who has access to `/users/admin`?" from the public API contract alone — the answer is spread across handler files.

### 72.B — authorisation failure returns HTTP 400, not 403

Both GET and DELETE return `400 Bad Request` when the user lacks the role, instead of `403 Forbidden`. This is the same pattern already catalogued in **BUG-037**, but seen here on a previously un-probed endpoint — which suggests it is a platform-wide pattern rather than a single mis-coded handler.

## User impact

1. **Auditor confusion / compliance risk.** An ODPC auditor reading the API contract can't determine who's authorised for which endpoint without reading the server code. For a fintech processing chama money, this is a red flag on a Data Protection Impact Assessment.
2. **Grep-based security drift.** Any developer onboarding later will grep for `"super admins"` (plural) and find only GET — not DELETE. Permission changes may be applied inconsistently.
3. **Error shape mismatches monitoring.** Client error boundaries that rely on HTTP status codes (403 → "upgrade your plan" / 400 → "fix your request") will render the wrong UX.

## Root cause

Two separate handler files behind the `/users/admin` router, each written by a different author, each hand-rolling the role check instead of using a shared `requireRole(Role.SuperAdmin)` middleware.

## Proposed fix

1. **Introduce a canonical role-constant module** and use it everywhere:

   ```ts
   // server/auth/roles.ts
   export const Roles = {
     SuperAdmin:  "SuperAdmin",
     ChamaAdmin:  "ChamaAdmin",
     Chairperson: "Chairperson",
     Secretary:   "Secretary",
     Treasurer:   "Treasurer",
     Member:      "Member",
     User:        "User",
   } as const;
   ```

2. **`requireRole` middleware** that returns 403 with a standardised body:

   ```ts
   export const requireRole = (...allowed: Array<keyof typeof Roles>) =>
     (req, res, next) => {
       if (!allowed.includes(req.user.role.name)) {
         return res.status(403).json({
           status: "error",
           code: "FORBIDDEN",
           message: "You don't have permission for this action.",
           required: allowed,
         });
       }
       next();
     };
   ```

3. **Apply to every `/users/admin` method** — explicitly:

   ```ts
   usersAdminRouter.get   ("/", requireRole("SuperAdmin"),             listAllUsers);
   usersAdminRouter.delete("/", requireRole("SuperAdmin","ChamaAdmin"), deleteUser);
   ```

4. Fix **BUG-037** at the same time (status code), because the two are the same refactor.

## Verification

- `GET /users/admin` with `role.name === "User"` → **403** `{ code: "FORBIDDEN", required: ["SuperAdmin"] }`.
- `DELETE /users/admin` with `role.name === "User"` → **403** `{ code: "FORBIDDEN", required: ["SuperAdmin","ChamaAdmin"] }`.
- `GET /users/admin` with `role.name === "SuperAdmin"` → 200.
- No handler has the literal strings `"super admins"` or `"admins"` in source — only constants from `Roles`.
