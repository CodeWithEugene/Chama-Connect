<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-062 — Weak SPF (~all softfail) and DMARC (p=quarantine) Allow Email Spoofing

| Field | Value |
|---|---|
| Severity | Medium |
| Surface | Infrastructure → DNS / Email configuration |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual DNS audit |

## Evidence

DNS TXT records for `chamaconnect.io`:

```bash
dig TXT chamaconnect.io +short
# "v=spf1 mx a:mail.mailza.co.ke include:mailza.co.ke ~all"
#                                                      ^^^^ softfail — not hardfail

dig TXT _dmarc.chamaconnect.io +short
# "v=DMARC1; p=quarantine; rua=mailto:dmarc@mailza.co.ke; ruf=mailto:dmarc@mailza.co.ke; fo=1"
#            ^^^^^^^^^^^^ quarantine — not reject
```

**SPF `~all` (softfail)**: Emails from unauthorized servers are tagged as suspicious but **still delivered** to the recipient's inbox or spam folder. Receiving mail servers may or may not act on the softfail.

**DMARC `p=quarantine`**: Emails that fail DMARC alignment are sent to the spam/junk folder instead of being rejected outright. A determined attacker's spoofed email would reach the recipient's junk folder rather than being blocked.

An attacker can send an email appearing to come from `noreply@chamaconnect.io` or `support@chamaconnect.io`, and that email will land in recipients' spam/junk folders — which many users check and trust if the sender appears legitimate.

## User impact

Chama members and admins receive transactional emails from ChamaConnect for password resets, OTP codes, and payment confirmations. An attacker who spoofs `noreply@chamaconnect.io` can send phishing emails that:

- Trick a treasurer into clicking a fake "Login to verify your M-Pesa withdrawal" link
- Deliver a fake OTP to make the user believe a legitimate reset is in progress while the attacker resets the actual password via API (chained with BUG-047, BUG-058)
- Impersonate support staff asking for account credentials

Kenyan chama members typically have lower email security awareness, making phishing emails from a trusted domain name highly effective.

## Root cause

The DNS records were configured with conservative (draft/testing) settings rather than production hardening:
- `~all` (softfail) instead of `-all` (hardfail) in SPF
- `p=quarantine` instead of `p=reject` in DMARC

These are common misconfigurations during initial deployment that were never tightened to production values.

## Proposed fix

**Step 1: Tighten SPF to hardfail:**
```
v=spf1 mx a:mail.mailza.co.ke include:mailza.co.ke -all
```
Replace `~all` with `-all`. This instructs receiving servers to **reject** (not just tag) emails from unauthorized senders.

**Step 2: Escalate DMARC to reject after monitoring:**
```
v=DMARC1; p=reject; rua=mailto:dmarc@mailza.co.ke; ruf=mailto:dmarc@mailza.co.ke; fo=1; adkim=s; aspf=s
```
The `p=reject` policy ensures that spoofed emails are outright rejected, not delivered to spam.

**Recommended migration path:**
1. First set `p=quarantine; pct=25` to test on 25% of traffic.
2. Monitor DMARC reports at `dmarc@mailza.co.ke` for two weeks.
3. Escalate to `p=quarantine; pct=100`, then `p=reject`.

**Step 3: Ensure DKIM is configured** (`_domainkey.chamaconnect.io` had no TXT record). All outbound emails should be DKIM-signed. Contact `mailza.co.ke` to confirm DKIM is enabled for the `chamaconnect.io` domain.

## Verification

1. `dig TXT chamaconnect.io +short` — confirm SPF ends in `-all`.
2. `dig TXT _dmarc.chamaconnect.io +short` — confirm `p=reject`.
3. Use [https://mxtoolbox.com/emailhealth/chamaconnect.io](https://mxtoolbox.com/emailhealth/chamaconnect.io) to confirm DMARC and SPF pass.
4. Send a test email from an unauthorized server and confirm it is rejected (not delivered to spam).
