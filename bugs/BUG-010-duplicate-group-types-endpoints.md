<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-010 — Two different group-types endpoints with inconsistent schemas

| Field | Value |
|---|---|
| Severity | High |
| Surface | API / data integrity |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright recon |

## Evidence

Two endpoints exist — both customer-facing, both live — with subtly different shapes:

| Endpoint | URL style | `label` means | `value` means | Example |
|---|---|---|---|---|
| `/api/proxy/onboarding/group-types` | singular (`group-types`) | machine enum (`MERRRY_GO_AROUND`) | human label (`"MERRRY GO AROUND"`) | `{ label: "SACCO", value: "SACCO" }` |
| `/api/proxy/groups-types` | **plural** (`groups-types`) | human label (`"merrry go around"`) | machine enum (`MERRRY_GO_AROUND`) | `{ label: "sacco", value: "SACCO" }` |

Note: the two endpoints **swap the meaning of `label` vs `value`**. A client that expects "label = what I display, value = what I POST back" will silently work with one endpoint and silently corrupt with the other.

Also: the URL `/groups-types` violates the REST convention the rest of the API uses (`/users/...`, `/groups`, `/counties`, `/saccos` — all at most one dash in a segment and singular-ish). `groups-types` adds a rogue plural.

## User impact

1. The Create Chama wizard step 2 could use either endpoint and end up writing the wrong value to the database depending on which one the developer imported this week.
2. Mobile/partner integrators reading the docs are going to pick the wrong one; bugs will be blamed on them but are actually in the contract.
3. If two places in the UI read from different endpoints, the same chama will render with a different type label in two screens (case-mismatch: `"sacco"` vs `"SACCO"`).

## Root cause

Two controllers written by two engineers (or the same engineer at two times) without a shared DTO. The `/onboarding/group-types` name suggests it was scoped to the onboarding feature; `/groups-types` was then added when some other screen needed the same data, and nobody consolidated.

## Proposed fix

1. Pick one canonical endpoint: `GET /api/proxy/group-types` (singular segments, consistent with the rest of the API).
2. Pick one canonical shape — recommendation:
   ```json
   { "label": "Merry-Go-Round", "value": "MERRY_GO_ROUND" }
   ```
   where `label` = human-readable, `value` = machine enum. This matches how virtually every other frontend framework expects enum options.
3. Deprecate both existing endpoints with a 6-month sunset banner in the response headers:
   ```
   Deprecation: true
   Sunset: Wed, 22 Oct 2026 00:00:00 GMT
   Link: </api/proxy/group-types>; rel="successor-version"
   ```
4. Update `/admin/chamas/create` step 2 + the onboarding wizard to hit the new endpoint.
5. Fix BUG-009's typo at the same time — single migration.

## Verification

- `curl /api/proxy/group-types` → 200 with new unified shape.
- `curl /api/proxy/groups-types` → 200 + `Deprecation: true` header.
- `curl /api/proxy/onboarding/group-types` → 200 + `Deprecation: true` header.
- Grep the frontend for `groups-types` or `onboarding/group-types` — both should only appear in the deprecation alias of an api-client wrapper.
