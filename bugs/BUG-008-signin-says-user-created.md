<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-008 — Login success response literally says "User Created"

| Field | Value |
|---|---|
| Severity | High |
| Surface | Auth / API / backend |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright recon |

## Evidence

Intercepted on the live site after logging in with a valid, pre-existing account (`eugenegabriel.ke@gmail.com`):

```
POST https://chamaconnect.io/api/proxy/users/signin
→ 200
{
  "message": "User Created",     ← this is a login, not a signup
  "status": "success",
  "data": {
    "user": { "id": "69ca...", "email": "...", "emailVerified": true, "activatedAt": "2026-03-30T15:24:37.901Z", ... },
    "token": "eyJhbG..."
  }
}
```

Full capture: `recon/artifacts/2026-04-20T08-22-01-022Z/signin_response.json`.

## User impact

Medium-to-high — the wrong message hints that signin and signup share the same backend handler without branching. Downstream effects:

1. Client code that branches on `message` text (e.g. to decide whether to send a verification email) will misbehave.
2. If audit logs / analytics pipe this message, every login becomes a "User Created" event — skews metrics, muddles SIEM / fraud-detection.
3. Any future attempt to add a distinct "account created" notification (welcome SMS, welcome email, onboarding funnel) will fire on every login. This is exactly the kind of bug that leaks "welcome to ChamaConnect" texts to users who have been members for months.
4. Customer-facing trust signal — if a developer ever ships this message to a toast, the user sees "User Created" on login and loses confidence in the product.

## Root cause (inferred)

The `/users/signin` handler likely calls a shared `createOrAuthenticate()` helper and returns that helper's message verbatim. A `if (isNewUser) msg = 'User Created'; else msg = 'Login successful'` branch is missing.

## Proposed fix

Backend (the repo judges control):

```ts
// users.controller.ts — signin handler
return res.json({
  message: "Login successful",
  status: "success",
  data: { user, token },
});
```

If the codebase genuinely reuses one function for both, introduce a discriminated return:

```ts
type AuthResult =
  | { kind: "signin"; user: User; token: string }
  | { kind: "signup"; user: User; token: string };

const messages: Record<AuthResult["kind"], string> = {
  signin: "Login successful",
  signup: "Account created successfully",
};
```

Front-end: stop relying on message text for branching; use `kind` (or the HTTP status).

## Verification

- Log in as an existing user → `message` = `"Login successful"`.
- Register a new user → `message` = `"Account created successfully"`.
- Add a contract test: `POST /users/signin with existing user must return message !== 'User Created'`.
