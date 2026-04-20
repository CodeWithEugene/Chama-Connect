<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-033 — Internal backend is publicly reachable at `/backend/api/v1/*` (double attack surface)

| Field | Value |
|---|---|
| Severity | High (architecture leak / authz bypass amplifier) |
| Surface | Infrastructure / API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

The `mpesaC2bCallbackUrl` value embedded in `/api/proxy/settings` pointed at `https://chamaconnect.io/backend/api/v1/transactions/group-contribution/mobile-money-callback`, which revealed the internal route prefix. Probing that prefix from the public internet with my own user's Bearer token:

```bash
$ curl -sS -H "authorization: Bearer $USER_TOKEN" https://chamaconnect.io/backend/api/v1/users/current-user \
  | jq '.message'
"Successfully  retrieved logged in user"

$ curl -sS -H "authorization: Bearer $USER_TOKEN" https://chamaconnect.io/backend/api/v1/transactions \
  | jq '.data | length'
10

$ curl -sS -H "authorization: Bearer $USER_TOKEN" https://chamaconnect.io/backend/api/v1/groups \
  | jq '.message'
"No groups found. Create your first chama to get started!"
```

The responses are byte-identical to the `/api/proxy/*` equivalents — confirming the `/api/proxy/*` layer (Next.js route handlers) is a thin passthrough, and the real backend is sitting behind `/backend/api/v1/*` on the **same hostname**.

`/backend/` without a suffix returns `301 Moved Permanently` (via nginx), which also confirms a reverse-proxy mount.

## User impact

1. **Defence-in-depth collapse** — any mitigation that is added to the Next.js proxy layer (IP allow-lists, WAF rules, CSP header injection, signature-verifying middleware) is bypassed by hitting `/backend/api/v1/*` directly. That undermines every future security fix.
2. **Doubled audit surface** — rate-limit headers, monitoring dashboards, and security tests all have to cover two base paths instead of one.
3. **Amplifies BUG-027, BUG-028, BUG-029, BUG-030** — the BOLA and settings-write bugs work at both paths, and any per-route fix needs to be applied twice or it's a no-op.
4. **Future production catastrophe** — once M-Pesa switches from sandbox to production, Safaricom Daraja will be the only valid caller of `/backend/api/v1/transactions/group-contribution/mobile-money-callback`. Today, any attacker can POST to that path from the internet and forge callback payloads (pending evidence — see BUG-027 proposed fix, which must include signing verification).

## Root cause

The Nginx/Cloudflare config is publishing the backend upstream under the same vhost as the public site, at `/backend/`. The intended isolation (Next.js BFF calls the backend over a private network) was only enforced in *naming*, not by firewall / Kubernetes network policy / Cloudflare WAF rule.

## Proposed fix

Three layered defences; do all of them:

1. **Block the path at the edge.** Cloudflare Rules → "If URL path starts with `/backend/` then block." Takes effect immediately, no redeploy.

```text
(http.request.uri.path matches "^/backend/")
→ Action: Block, Response: 404, Headers: none
```

2. **Bind the backend to an internal-only listener.** Either move the upstream out of this vhost entirely (preferred: put it on `https://api-internal.chamaconnect.io` behind Cloudflare Zero Trust), or if it must share the hostname, have Nginx reject `X-Forwarded-For` that is not the BFF's IP:

```nginx
location /backend/ {
  allow 10.0.0.0/16;   # k8s service CIDR of the BFF pod
  deny  all;
  proxy_pass http://backend-service;
}
```

3. **Require an HMAC header between the BFF and the backend.** The BFF signs every forwarded request with a shared secret (`X-Internal-Signature: hmac-sha256(timestamp || method || path || body)`). The backend rejects any request without a valid signature. That way even a cloud-misconfig that reopens the path can't be exploited.

4. **For the M-Pesa callback routes specifically** (`/mobile-money-callback`, `/c2b/confirmation`, `/b2b/*`, `/b2c/*`): verify Safaricom's signature AND restrict source IPs to Daraja's published egress ranges. Without this, any unblocked attacker can post fake "successful payment" callbacks.

## Verification

1. `curl https://chamaconnect.io/backend/api/v1/users/current-user` (with or without a token) → `404 Not Found` from Cloudflare's block rule.
2. `nslookup api-internal.chamaconnect.io` → resolves only from inside the cluster / through Zero Trust.
3. `curl -H 'X-Internal-Signature: tampered' <internal>` → `401`. Remove the header → `401`.
4. Post a fabricated Daraja callback without a valid signature → `401`.
5. Automated probe in `/recon/tests/backend-direct.spec.ts`.
