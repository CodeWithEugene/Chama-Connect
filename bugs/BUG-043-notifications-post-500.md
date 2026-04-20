<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-043 — `POST /api/proxy/notifications` returns `500 Internal Server Error` on any payload

| Field | Value |
|---|---|
| Severity | Medium (availability + missing authz enforcement) |
| Surface | API / stability |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

```bash
# Empty body
$ curl -sS -i -X POST -H "authorization: Bearer $USER_TOKEN" -H 'content-type: application/json' \
    --data-raw '{}' https://chamaconnect.io/api/proxy/notifications
HTTP/2 500
{"status":"error","message":"Internal Server Error","errors":[{"message":"Internal Server Error"}]}

# Realistic notification payload
$ curl -sS -i -X POST -H "authorization: Bearer $USER_TOKEN" -H 'content-type: application/json' \
    --data-raw '{"title":"Alert","body":"Test","type":"ALERT","userId":"69c50ee3a8a7e71e0cdeab36"}' \
    https://chamaconnect.io/api/proxy/notifications
HTTP/2 500
{"status":"error","message":"Internal Server Error","errors":[{"message":"Internal Server Error"}]}
```

`GET /api/proxy/notifications` (same path, different verb) works fine, confirming the route is registered but the POST handler is broken.

## User impact

Two issues in one:

1. **Any user who can sign in can push to `POST /api/proxy/notifications` and trigger a server exception.** Since there is no per-account lock-out and the 500 fires on every attempt, this is a trivially-reproducible availability issue. Combined with the general rate limit from BUG-018 (1000/15min), an attacker can drive 1000 backend exceptions per 15 minutes per IP.

2. **If the handler were working correctly, a regular `User` would be reaching a "create notification" endpoint with no role guard.** Given every other pattern on this platform (BUG-027, BUG-040) the lack of a guard here would let attackers send arbitrary notifications to any user, enabling phishing-within-platform attacks ("Your withdrawal of KES 5,000 was approved — click here to confirm").

## Root cause

Most likely the POST handler references a missing required field (e.g. `req.body.groupId` or `req.body.senderId`) without a null check, or an ORM relation (`populate(...)`) references a collection that doesn't exist in the seeded DB. The server catches the exception via the global handler but doesn't expose the stack trace.

## Proposed fix

1. Fix the crash — inspect server logs for the exact stack trace. Add null guards and input validation before any DB access:

```ts
// server/controllers/notifications.ts
export const createNotification = asyncHandler(async (req, res) => {
  const { title, body, type, userId } = req.body;
  if (!title || !body || !userId) return badRequest(res, 'title, body, userId required');

  // Only admins can send to arbitrary users
  if (req.user!.id !== userId && req.user!.role?.name !== 'SuperAdmin') return forbidden(res);

  const notif = await Notification.create({ title, body, type: type ?? 'INFO', userId, createdBy: req.user!.id });
  return res.status(201).json({ status: 'success', message: 'Notification sent', data: notif });
});
```

2. Add the same `requireRole('SuperAdmin')` guard so non-admins cannot reach the create-notification path at all until there is an explicit in-product workflow that needs it.

3. The `DELETE /api/proxy/notifications/all` endpoint (BUG-036) has the same symptom — audit both together and confirm they share the same broken handler.

## Verification

1. `POST /api/proxy/notifications {}` as a regular `User` → `403 Forbidden`, never `500`.
2. `POST` as `SuperAdmin` with valid payload → `201 Created`, notification row in DB, recipient receives it via `GET /notifications`.
3. Zero 500s in server logs for any input to this path.
