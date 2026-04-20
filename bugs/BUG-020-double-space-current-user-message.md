<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-020 — `/api/proxy/users/current-user` returns `"Successfully  retrieved logged in user"` (double space)

| Field | Value |
|---|---|
| Severity | Low |
| Surface | API / copy |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright recon |

## Evidence

Intercepted on the authenticated recon:

```
GET https://chamaconnect.io/api/proxy/users/current-user → 200
{
  "message": "Successfully  retrieved logged in user",   ← two spaces between "Successfully" and "retrieved"
  "status": "success",
  "data": { ... }
}
```

Captured at `recon/artifacts/2026-04-20T09-40-50-508Z/network/requests.json`. Every call to the endpoint returns the same string.

## User impact

On its own, a cosmetic copy issue — the message is rarely surfaced to users. But it matters for three reasons that justify filing it:

1. **This endpoint's `message` pairs with BUG-008** (`POST /users/signin` returning `"User Created"` on login). Both are symptoms of the same API-copy negligence, and both are defensively filed so a reviewer sees the pattern, not a single incident. Any future client that toasts `message` verbatim will show the double space to a user.
2. **Log grep / SIEM parsers** that pattern-match messages for alerting break silently when copy drift happens. "Successfully retrieved..." would match normal regex; `"Successfully  retrieved..."` adds a subtle parser-buster.
3. **Audit / support tooling** that joins event-log lines (Datadog, Grafana Loki, Elastic) ships "Successfully&nbsp;&nbsp;retrieved..." into every backend-team search result, which looks unpolished to an auditor.

## Root cause

Hand-typed message string with an extra space. No code review caught it because no lint rule or API-contract test exists for response message copy.

## Proposed fix

Fix the string and introduce a shared copy constant so the same phrasing pattern is used across endpoints:

```ts
// src/api/messages.ts
export const API_MSG = {
  CURRENT_USER_FETCHED: "Logged-in user retrieved successfully",
  ROLES_LISTED:        "Roles retrieved successfully",
  GROUPS_LISTED:       "Groups retrieved successfully",
  DASHBOARD_SUMMARY:   "Dashboard summary retrieved successfully",
  SIGNIN_SUCCESS:      "Login successful",            // fixes BUG-008
  SIGNUP_SUCCESS:      "Account created successfully",
} as const;
```

Use those constants everywhere. Add a lint rule or simple contract test:

```ts
test("no API response message contains double whitespace", async () => {
  for (const path of ["/api/proxy/users/current-user", "/api/proxy/roles", "/api/proxy/counties", ...]) {
    const r = await request.get(path);
    const body = await r.json();
    if (body.message) expect(body.message).not.toMatch(/\s{2,}/);
  }
});
```

## Verification

- `curl /api/proxy/users/current-user | jq -r .message` returns a single-space string.
- The contract test above is in CI and green.
