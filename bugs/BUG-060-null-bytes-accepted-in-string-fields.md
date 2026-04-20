<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-060 — Null Bytes Accepted and Stored in String Fields

| Field | Value |
|---|---|
| Severity | Medium |
| Surface | API → `POST /api/proxy/groups`, potentially other string fields |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual API probe |

## Evidence

A group was created with a name containing a null byte (`\u0000`). The server accepted the payload and stored the null byte in the database:

```bash
curl -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data-raw '{"name":"LegitName\u0000DROP TABLE","description":"null byte test",...}' \
  https://chamaconnect.io/api/proxy/groups

HTTP/2 200
{
  "message": "Created group successfully with 1 members",
  "data": {
    "name": "LegitName\x00DROP TABLE",   ← null byte stored verbatim
    ...
  }
}
```

The stored group name, when retrieved and decoded, contains `\x00` (ASCII 0), splitting the string into `"LegitName"` and `"DROP TABLE"` at the null byte boundary.

## User impact

Although MongoDB handles null bytes in BSON strings without crashing, several downstream risks arise:

- **String truncation in C/system libraries**: If group names are passed to any native extension, PDF generator, email template renderer, or file-naming code that uses C-style null-terminated strings, the name is silently truncated to `"LegitName"` and the rest is discarded. This can cause display inconsistencies or bypass length validation.
- **Filter bypass**: Security filters that search for disallowed words (e.g., `DROP TABLE`) might fail to detect them if the string is null-byte-poisoned.
- **Log injection**: Null bytes in log entries can truncate log lines, hiding the full content from log analysis tools.
- **Unexpected behaviour in exports**: If group names are exported to CSV, Excel, or PDF, null bytes may corrupt the output or cause application crashes in the consuming system.

A chama admin could unknowingly create a group with a corrupted name, leading to broken UI display or data integrity issues.

## Root cause

Input validation does not strip or reject null bytes from string fields before accepting and persisting the data. Mongoose schemas do not apply null-byte sanitization by default.

## Proposed fix

```typescript
// middleware/sanitize.ts
export function stripNullBytes(obj: unknown): unknown {
  if (typeof obj === 'string') return obj.replace(/\0/g, '');
  if (Array.isArray(obj)) return obj.map(stripNullBytes);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, stripNullBytes(v)])
    );
  }
  return obj;
}

// Apply globally in Express app setup
app.use((req, _res, next) => {
  if (req.body) req.body = stripNullBytes(req.body);
  next();
});
```

Additionally, at the Mongoose schema level:

```typescript
const GroupSchema = new Schema({
  name: {
    type: String,
    required: true,
    validate: {
      validator: (v: string) => !v.includes('\0'),
      message: 'Group name must not contain null bytes',
    },
  },
  // ...
});
```

## Verification

1. Send `POST /api/proxy/groups` with `"name":"Test\u0000Poison"`.
2. Confirm the response either rejects the request (400) or stores `"TestPoison"` (null byte stripped).
3. Confirm `GET /api/proxy/groups/:id` returns the name without any null byte.
