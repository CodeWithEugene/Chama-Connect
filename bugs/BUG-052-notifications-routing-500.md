<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-052 — Notification sub-routes return `500`: `GET /notifications/mark-all-read`, `/clear`, `/all`

| Field | Value |
|---|---|
| Severity | Medium (availability + routing design) |
| Surface | API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

```bash
# Wrong method — 500 instead of 405
$ curl -sS -H "authorization: Bearer $TOKEN" https://chamaconnect.io/api/proxy/notifications/mark-all-read
{"status":"error","message":"Internal Server Error"}
# HTTP 500

$ curl -sS -H "authorization: Bearer $TOKEN" https://chamaconnect.io/api/proxy/notifications/clear
{"status":"error","message":"Internal Server Error"}
# HTTP 500 (all methods — never 200)

$ curl -sS -H "authorization: Bearer $TOKEN" https://chamaconnect.io/api/proxy/notifications/all
{"status":"error","message":"Internal Server Error"}
# HTTP 500 (already reported in BUG-036)

# Correct method for mark-all-read:
$ curl -sS -X POST -H "authorization: Bearer $TOKEN" https://chamaconnect.io/api/proxy/notifications/mark-all-read
{"message":"All notifications marked as read successfully","status":"success","data":[...]}
# HTTP 200 — only POST works
```

Three distinct notification sub-routes are broken:

| Path | GET | POST | Status |
|---|---|---|---|
| `/notifications/all` | 500 | — | BUG-036 (re-confirmed) |
| `/notifications/mark-all-read` | 500 | 200 | Wrong method used + routing collision |
| `/notifications/clear` | 500 | 500 | All methods broken |

The pattern is the same as BUG-049 and BUG-051: the `GET /notifications/:id` route is registered before the literal routes, causing string literals like `"mark-all-read"`, `"all"`, and `"clear"` to be treated as ObjectIds — Mongoose throws `CastError` → `500`.

The `notifications/clear` endpoint is entirely non-functional on all methods.

## Proposed fix

```ts
// server/routes/notifications.ts  — specific routes before :id
router.get ('/notifications/all',           authenticate(), listAllNotifications);  // fix for BUG-036
router.post('/notifications/mark-all-read', authenticate(), markAllRead);
router.post('/notifications/clear',         authenticate(), clearAllNotifications); // implement properly
router.get ('/notifications/:id',           authenticate(), getNotificationById);
router.delete('/notifications/:id',         authenticate(), deleteNotification);
```

Respond with `405 Method Not Allowed` + `Allow: POST` header when the wrong method is used on `mark-all-read`.

## Verification

1. `GET /api/proxy/notifications/all` → `200` list of all notifications.
2. `GET /api/proxy/notifications/mark-all-read` → `405 Method Not Allowed` (not `500`).
3. `POST /api/proxy/notifications/mark-all-read` → `200` (already works, keep working).
4. `POST /api/proxy/notifications/clear` → `200`, clears notifications.
5. `GET /api/proxy/notifications/non_hex_string` → `404`.
