<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-036 — `/api/proxy/notifications/all` returns `500 Internal Server Error` on any call

| Field | Value |
|---|---|
| Severity | Medium (availability / stability) |
| Surface | API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

```bash
$ curl -sS -i -H "authorization: Bearer $USER_TOKEN" https://chamaconnect.io/api/proxy/notifications/all
HTTP/2 500
content-type: application/json; charset=utf-8
...
{"status":"error","message":"Internal Server Error","errors":[{"message":"Internal Server Error"}]}
```

Notes:

- The sibling route `GET /api/proxy/notifications` works correctly and returns `{"message":"Notifications fetched successfully","data":[],"count":0,"unreadCount":0}`.
- `/notifications/all` fails with no context — the server log almost certainly has a stack trace; the response body helpfully refuses to leak it (good), but the route should not be reachable with an uncaught exception at all.
- A zero-count account (my freshly-signed-up `User`) hits the same `500`, so the crash is not data-dependent on my notifications.

## User impact

Any UI surface that says "View all notifications" (common naming convention) will silently 500 when a user clicks it. The user sees an empty screen or a generic "Something went wrong" toast — there is no path for a real chama member to read historical notifications. For a product whose core value is "tell members when money moves", a silent 500 on the history view is a credibility wound.

Stability-wise, uncaught `500`s bypass the centralised error formatter, which means observability tools might classify them as exceptions rather than handled errors. If the backend auto-restarts on repeated 500s (common in containerised PM2/pm2-runtime setups), a single bored attacker can keep the worker churning with zero auth cost.

## Root cause

Likely one of:

- Missing handler registration for `/notifications/all` that falls through to a default that throws.
- A `populate()` call in Mongoose against a collection/field that doesn't exist on the default document shape.
- A shared controller that assumes `req.params.groupId` (or similar) and blows up on `undefined`.

Inspect server logs for the exact stack trace; the URL is a reliable repro trigger.

## Proposed fix

1. Register a dedicated handler for the route with an explicit query + error boundary:

```ts
// server/controllers/notifications.ts
export const listAllNotifications = asyncHandler(async (req, res) => {
  const me = req.user!.id;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Number(req.query.pageSize) || 25);
  const q = { userId: me };

  const [items, total, unreadCount] = await Promise.all([
    Notification.find(q).sort({ createdAt: -1 })
      .skip((page - 1) * pageSize).limit(pageSize).lean(),
    Notification.countDocuments(q),
    Notification.countDocuments({ ...q, readAt: null }),
  ]);

  return res.json({
    status: 'success',
    message: 'Notifications retrieved',
    data: items,
    count: total,
    unreadCount,
    page,
    pageSize,
  });
});

router.get('/notifications/all', authenticate(), listAllNotifications);
```

2. Wrap every route in a single `asyncHandler` + global error formatter so any future 500 at least returns a stable request-correlation ID (`{errorId: "req_…"}`) that maps to a log line in Datadog/CloudWatch.

3. Add a synthetic check (Uptime/Pingdom) that calls `/api/proxy/notifications/all` with a bot-user token and alerts on any non-200. Catches regressions.

## Verification

1. `curl -i .../api/proxy/notifications/all` → `200`, empty data for a fresh account, paginated list for an active one.
2. Wire a Playwright test that signs in, clicks "View all notifications" and asserts no 5xx was observed during the page load.
