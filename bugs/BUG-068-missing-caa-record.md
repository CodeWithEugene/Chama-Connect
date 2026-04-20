<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-068 — DNS missing a CAA record: any CA in the world can issue a cert for `chamaconnect.io`

| Field | Value |
|---|---|
| Severity | Medium |
| Surface | DNS / TLS trust chain |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | `dig` probe (recon/artifacts/dns-tls-audit/dns.txt) |
| CWE | CWE-295 (Improper Certificate Validation at the authority layer) |
| CA/B Forum baseline | 3.2.2.8 (CAA records must be respected by every public CA) |

## Evidence

```
$ dig +short CAA chamaconnect.io
(empty)

$ dig +short CAA mailza.co.ke     # the MX host, for cross-reference
(empty)
```

No `CAA` RR exists for either the apex or the mail-hosting zone. By the [CA/B Forum baseline requirements](https://cabforum.org/baseline-requirements-documents/), in the absence of a CAA record every publicly-trusted CA is *permitted* to issue a TLS certificate for `chamaconnect.io` — including CAs the operator has no relationship with.

Context of the rest of the DNS (for completeness): `/Users/eugenius/Work/Chama-Connect/recon/artifacts/dns-tls-audit/dns.txt`

```
A        104.21.82.53, 172.67.196.17
NS       anastasia.ns.cloudflare.com., dimitris.ns.cloudflare.com.
MX       0 mail.mailza.co.ke.
SPF      "v=spf1 mx a:mail.mailza.co.ke include:mailza.co.ke ~all"
DMARC    "v=DMARC1; p=quarantine; rua=mailto:dmarc@mailza.co.ke; ruf=…"
DKIM     (none at default, google, selector1)
CAA      (missing) ←
```

## User impact

The failure mode is not "an attacker gets a cert" on its own — publicly-trusted CAs still require proof of domain control. The harm is in the **combined** story with incidents that have actually happened to several fintechs in Kenya and elsewhere in the last few years:

1. **CA mis-issuance.** Even top-tier CAs have historically issued incorrect certs (DigiNotar 2011, WoSign 2015, GoDaddy 2019, etc.). A CAA record tells every CA "ask only the ones I approved." Without it, one mis-issuance in any CA anywhere yields a valid cert that browsers will trust for `chamaconnect.io`.
2. **BGP or DNS hijack as DV-cert vector.** A short-lived DNS / BGP hijack that lets the attacker satisfy a CA's domain-validation challenge (HTTP-01 / DNS-01) is enough to obtain a cert. CAA limits this to just the CA(s) you use; absent CAA, *every* CA is attackable.
3. **Insider-threat or disgruntled-admin scenarios.** Anyone at an unrelated CA who triggers a fraudulent issuance can point it at the site without external signals (CAA would produce log entries at the other CAs as denied-issuance events that the operator can monitor).
4. **M-Pesa callbacks.** Daraja callbacks (BUG-054) terminate TLS at the platform. A fraudulent cert for `chamaconnect.io` would allow a MITM on those callbacks — combined with BUG-054's absence of callback authentication, an attacker controlling DNS for the victim's ISP could redirect Safaricom → attacker-controlled host with a trusted cert and forge arbitrary credit events.

All told: CAA is cheap (one DNS record) and the absence is a known fintech anti-pattern the ODPC is increasingly expected to audit against.

## Root cause

CAA simply wasn't added when the domain was set up. Cloudflare DNS, which currently serves the zone, makes it a single-click affair in the DNS console.

## Proposed fix

Add two CAA records — one for issuance, one for wildcard issuance — naming the CAs actually used (identified by the existing cert chain — inspecting `https://chamaconnect.io` is left to the implementer; Let's Encrypt and Cloudflare are the overwhelmingly most likely pair). Include a mailto contact for CAs to send violation notices.

```
chamaconnect.io. 3600 IN CAA 0 issue     "letsencrypt.org"
chamaconnect.io. 3600 IN CAA 0 issue     "pki.goog"
chamaconnect.io. 3600 IN CAA 0 issuewild "letsencrypt.org"
chamaconnect.io. 3600 IN CAA 0 iodef     "mailto:security@muiaa.com"
```

(Replace the CA names with whoever is actually signing the production cert — inspecting the live cert chain is prerequisite.)

Also add CAA to `mailza.co.ke` if that is controlled by the same operator, or at least ensure the mail domain isn't an independent vector.

## Verification

```
$ dig +short CAA chamaconnect.io
0 issue "letsencrypt.org"
0 issue "pki.goog"
0 issuewild "letsencrypt.org"
0 iodef "mailto:security@muiaa.com"
```

And confirm the production cert is still renewable (Let's Encrypt will just-keep-working). Monitor [crt.sh](https://crt.sh/?q=chamaconnect.io) for any cert issued by an unexpected CA going forward.
