<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-076 — **Live production evidence: a `BackendHack` role exists in the production roles table, created during authenticated probing** (concrete demonstration of BUG-040)

| Field | Value |
|---|---|
| Severity | **Critical** (proof-of-exploitation, identical root cause to BUG-040) |
| Surface | API / authorisation / data integrity |
| Status | Open · **please purge before anything else** |
| Discovered | 2026-04-20 |
| Discovered by | Playwright audit pass 3 (Create-Chama wizard walk-through, probe 33) |
| Parent | **BUG-040** (any user can `POST /api/proxy/roles`) |

## Evidence

During probe 33 (Create-Chama wizard walk-through), the front-end loaded `/api/proxy/roles` to populate a role-selector. The live response captured at `recon/artifacts/audit3-2026-04-20T12-20-24-471Z/33_create_chama_network.json`:

```json
{
  "message": "Role lists",
  "status":  "success",
  "data": [
    {
      "id":         "69e603cb3e9a7937fd3ca50d",
      "name":       "BackendHack",                    ← ← ← not a canonical role
      "createdAt":  "2026-04-20T10:45:31.249Z",
      "updatedAt":  "2026-04-20T10:45:31.249Z"
    },
    { "id": "69c50c8a38f08070a83bd35f", "name": "Chairperson",  … },
    { "id": "69c50c8a38f08070a83bd360", "name": "ChamaAdmin",   … },
    …
  ]
}
```

Timestamp `2026-04-20T10:45:31` aligns with Eugene's earlier BUG-040 test run — confirming that the **test-created role is still live in MUIAA's production database** five hours later, visible to every signed-in user, and drop-down-selectable on at least one admin screen.

Cross-reference — the same role is visible in the earlier recon at `recon/artifacts/deep-2026-04-20T10-38-10-932Z/network/deep-interact-requests.json` under `/api/proxy/roles` responses, establishing the persistence was already present at that moment.

## User impact

Three overlapping harms, in order of severity:

1. **Proof that BUG-040 is not theoretical.** Any authenticated user can create arbitrary roles via `POST /api/proxy/roles`. Combined with BUG-015 (roles have `permissions: []` → authz likely enforced by role name only), an attacker who creates a role literally named `"SuperAdmin "` (trailing space) or `"Superadmin"` (wrong case) could escape authorization checks that rely on exact string-matching the role name. Even without that path, creating roles at will lets an attacker *rename* the canonical `SuperAdmin` role to neutralise checks that match by name.
2. **Role-listing surface is now poisoned.** Any UI dropdown populated from `/api/proxy/roles` — including the very Create-Chama wizard that exposed this — will render `BackendHack` as a choice to anyone creating a chama right now. A real end-user who assigns `BackendHack` to themselves or a member sees whatever privilege the backend infers from that string.
3. **Data integrity of the roles table is now unverifiable** without a clean re-seed. The original roles migration had 7 rows (Chairperson, ChamaAdmin, Member, Secretary, SuperAdmin, Treasurer, User). Any future audit of "who belongs to which role" has to filter this out, and the ChamaConnect team does not know how many *other* attacker-written roles might be sitting in the table from adversaries who didn't announce their test runs.

## Root cause

Same as BUG-040: the `POST /api/proxy/roles` handler does not verify `req.user.role.name === "SuperAdmin"` before allowing the write. Probably `POST /api/proxy/roles` and `PATCH /api/proxy/roles/:id` both fall through to a generic `requireAuth` rather than `requireRole("SuperAdmin")`.

## Proposed fix

Immediate (today):

1. Purge the probe role: `DELETE` the document with `id = "69e603cb3e9a7937fd3ca50d"` from the `roles` collection. Audit for any other non-canonical role name (anything not in the canonical 7).
2. Add a DB-level invariant check in CI: `role.name ∈ {Chairperson, ChamaAdmin, Member, Secretary, SuperAdmin, Treasurer, User}` unless an explicit migration creates a new canonical role.

Medium-term (this sprint):

3. Fix BUG-040 by wrapping role mutations with `requireRole("SuperAdmin")` (see BUG-040's proposed fix for the exact middleware).
4. Replace string-name authz (BUG-015) with permission-array checks. A role named `BackendHack` with `permissions: []` then conveys no authority at all, closing the "name-collision" escape vector.

Forensic (once):

5. Check the `audit_log` table (or application logs) for any `POST /roles`, `PATCH /roles/:id`, `DELETE /roles/:id` by a non-SuperAdmin actor. Revert any non-canonical role changes.

## Verification

- `GET /api/proxy/roles` returns only the seven canonical roles.
- Logged in as a `User` role: `POST /api/proxy/roles` → **403 FORBIDDEN**.
- `PATCH /api/proxy/roles/<SuperAdmin-id>` with body `{ name: "x" }` by a `User` → **403**.
- Database `roles` collection `count() === 7` and `distinct("name") === the canonical list`.

## Housekeeping

Please include this row in the already-listed probe-cleanup set (alongside the `@probe.local` accounts in BUG-064 + BUG-073):

- Role `id=69e603cb3e9a7937fd3ca50d name="BackendHack"` — **delete**.
