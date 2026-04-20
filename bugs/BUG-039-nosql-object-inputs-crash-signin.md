<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-039 — Signin accepts object-valued `email`/`password` and crashes with `500` (NoSQL-injection surface)

| Field | Value |
|---|---|
| Severity | High (availability + latent NoSQL-injection surface) |
| Surface | Auth / API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

```bash
# Object values for email AND password
$ curl -sS -X POST https://chamaconnect.io/api/proxy/users/signin \
    -H 'content-type: application/json' \
    --data-raw '{"email":{"$ne":null},"password":{"$ne":null}}'
# HTTP 500
{"status":"error","message":"Internal Server Error"}

# $regex email, string password
$ curl -sS -X POST https://chamaconnect.io/api/proxy/users/signin \
    -H 'content-type: application/json' \
    --data-raw '{"email":{"$regex":".*"},"password":"wrong"}'
# HTTP 500
{"status":"error","message":"Internal Server Error"}

# Same 500 on request-password-reset
$ curl -sS -X POST https://chamaconnect.io/api/proxy/users/request-password-reset \
    -H 'content-type: application/json' \
    --data-raw '{"email":{"$ne":null}}'
# HTTP 500
{"status":"error","message":"Internal Server Error"}

# String email + object password — passes first DB lookup, crashes bcrypt.compare
$ curl -sS -X POST https://chamaconnect.io/api/proxy/users/signin \
    -H 'content-type: application/json' \
    --data-raw '{"email":"eugenegabriel.ke@gmail.com","password":{"$ne":"anything"}}'
# HTTP 400  (gets further but still misbehaves)
{"status":"error","message":"Incorrect password"}
```

Two distinct findings:

1. **Input-type validation is absent** — `email` and `password` are never asserted to be strings, so JavaScript object values (including MongoDB operators like `$ne`, `$gt`, `$regex`) reach the controller unchecked.
2. **Something downstream crashes** (Mongoose `CastError` or `bcrypt.compare(object, hash)` throwing) causing an opaque `500`. The generic error handler suppresses the stack trace — good for security, bad for the attacker — but the server crash and 500 response are real.

## User impact

1. **Latent NoSQL injection.** The MongoDB authentication bypass (`{"$gt":""}`) is a version-of-Mongoose / ODM-config dependent, but it's a one-upgrade-away risk today. Correct defence is to strip operators before the value reaches any query.

2. **DoS via crash loops.** An attacker can fire 1 000 object-valued signin requests (within the per-IP rate limit from BUG-018) and every one forces an exception path in Node, consuming event-loop time.

3. **Information channel.** `500` vs `400` vs `200` let the attacker probe which inputs cause DB-layer execution vs. validator rejection — a useful signal for deeper fuzzing.

## Root cause

The signin validator does not call `.isString()` on email/password fields:

```ts
// current (inferred)
body('email').exists().notEmpty(),
body('password').exists().notEmpty(),
```

`express-validator`'s `notEmpty()` passes any non-empty value, including objects.

## Proposed fix

```ts
// server/validators/auth.ts
export const signinValidator = [
  body('email').optional({ values: 'falsy' }).isString().trim().toLowerCase(),
  body('phone').optional({ values: 'falsy' }).isString().trim(),
  body('password').exists().isString().isLength({ min: 8, max: 128 }),
  body().custom((b) => {
    if (!b.email && !b.phone) throw new Error('email or phone required');
    return true;
  }),
];
```

Additionally add a global middleware using `express-mongo-sanitize` (or equivalent) to strip all `$`-prefixed keys from `req.body`, `req.query`, and `req.params` before any route handler runs:

```ts
import mongoSanitize from 'express-mongo-sanitize';
app.use(mongoSanitize({ replaceWith: '_', allowDots: false }));
```

Apply the same `.isString()` guards to `request-password-reset`, `password-reset`, `signup`, `activate`, `resend-otp`, and every other auth route.

## Verification

1. POST `{"email":{"$ne":null},"password":{"$ne":null}}` → `400 Invalid value`, never `500`.
2. POST `{"email":{"$regex":".*"},"password":"x"}` → `400`.
3. Classic bypass `{"email":{"$gt":""},"password":{"$gt":""}}` → `400`.
4. Confirm no 500 appears in server logs for any of these.
5. Regression test in `/recon/tests/auth-type-safety.spec.ts`.
