"""One-off IMAP inspector for the TOS email-alert inbox (tosbullalert@gmail.com).

Prints subject / from / date / plain-text body of the most recent messages so we
can see the exact alert format before wiring the poller. Reads the app password
from env — NEVER prints it.

Run (PowerShell):
    $env:TOSALERT_IMAP_USER = "tosbullalert@gmail.com"
    $env:TOSALERT_IMAP_APP_PASSWORD = "<the app password>"   # your shell only
    python inspect_tosalert.py
Requires IMAP enabled on the account (Gmail > Settings > Forwarding and POP/IMAP).
"""
import imaplib
import email
import os
import sys
from email.header import decode_header


def _dec(s):
    if not s:
        return ""
    parts = decode_header(s)
    out = []
    for text, enc in parts:
        if isinstance(text, bytes):
            out.append(text.decode(enc or "utf-8", errors="replace"))
        else:
            out.append(text)
    return "".join(out)


def _plaintext(msg):
    """Best-effort plain-text body; falls back to stripped-ish HTML."""
    if msg.is_multipart():
        # prefer text/plain
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and "attachment" not in str(part.get("Content-Disposition")):
                return part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", errors="replace")
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                return part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", errors="replace")
        return ""
    payload = msg.get_payload(decode=True)
    return payload.decode(msg.get_content_charset() or "utf-8", errors="replace") if payload else ""


def main():
    user = os.environ.get("TOSALERT_IMAP_USER", "tosbullalert@gmail.com")
    pw = os.environ.get("TOSALERT_IMAP_APP_PASSWORD")
    if not pw:
        print("ERROR: set TOSALERT_IMAP_APP_PASSWORD in your shell first.")
        return 2
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 3

    M = imaplib.IMAP4_SSL("imap.gmail.com")
    M.login(user, pw)
    try:
        M.select("INBOX")
        # Target the TOS alerts specifically: subject contains "calls" or "puts".
        typ, data = M.search(None, '(OR SUBJECT "calls" SUBJECT "puts")')
        match_ids = data[0].split()
        print(f"Connected. TOS-alert matches (subject calls/puts): {len(match_ids)}\n")
        if match_ids:
            for num in match_ids[-n:][::-1]:
                typ, md = M.fetch(num, "(RFC822)")
                msg = email.message_from_bytes(md[0][1])
                print("=" * 70)
                print("SUBJECT:", _dec(msg.get("Subject")))
                print("FROM   :", _dec(msg.get("From")))
                print("DATE   :", msg.get("Date"))
                body = _plaintext(msg).strip()
                print("BODY   :")
                print(body[:2000])
                if len(body) > 2000:
                    print(f"... [truncated, {len(body)} chars total]")
                print()
        else:
            # None yet — list recent subjects so we can see what's actually arriving.
            typ, data = M.search(None, "ALL")
            ids = data[0].split()
            print(f"No calls/puts subjects found. Newest {min(15, len(ids))} INBOX subjects:")
            for num in ids[-15:][::-1]:
                typ, md = M.fetch(num, "(BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)])")
                hdr = email.message_from_bytes(md[0][1])
                print(f"  [{msg_date(hdr)}] {_dec(hdr.get('From'))[:30]:30} | {_dec(hdr.get('Subject'))}")
    finally:
        M.logout()
    return 0


def msg_date(hdr):
    d = hdr.get("Date") or ""
    return d[:25]


if __name__ == "__main__":
    raise SystemExit(main())
