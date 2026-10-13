#!/usr/bin/env bash
# Starts throwaway local mail servers for crates/core/tests/imap_smtp.rs:
#   Dovecot IMAP on 127.0.0.1:1143 (no TLS; localhost only) with \Archive and \Sent
#   An authenticating SMTP sink on 127.0.0.1:2525 that writes messages to $BASE/smtp-out
# User: tester / secret. Linux only; needs root (Dovecot drops privileges).
#
#   sudo apt-get install -y dovecot-imapd && pip install aiosmtpd
#   sudo tools/test-mail-servers/start.sh
#   MAILBIRD_IT_SMTP_OUT=/tmp/mbtest/smtp-out cargo test -p pim-core --test imap_smtp -- --ignored
set -euo pipefail

# Keep BASE short: Dovecot's unix sockets fail on paths over ~100 characters.
BASE=${BASE:-/tmp/mbtest}
HERE=$(cd "$(dirname "$0")" && pwd)
PYTHON=${PYTHON:-python3}

mkdir -p "$BASE/run" "$BASE/mail" "$BASE/smtp-out"
chmod 755 "$BASE"
U=$(id -u dovecot); G=$(id -g dovecot)
echo "tester:{PLAIN}secret:$U:$G::$BASE/mail/tester" > "$BASE/passwd"
chown -R dovecot:dovecot "$BASE/mail"

cat > "$BASE/dovecot.conf" <<CONF
base_dir = $BASE/run
log_path = $BASE/dovecot.log
protocols = imap
listen = 127.0.0.1
ssl = no
first_valid_uid = $U
disable_plaintext_auth = no
auth_mechanisms = plain login
mail_location = maildir:~/Maildir
default_internal_user = dovecot
default_login_user = dovenull
passdb {
  driver = passwd-file
  args = $BASE/passwd
}
userdb {
  driver = passwd-file
  args = $BASE/passwd
}
service imap-login {
  inet_listener imap {
    address = 127.0.0.1
    port = 1143
  }
  inet_listener imaps {
    port = 0
  }
}
namespace inbox {
  inbox = yes
  separator = /
  mailbox Archive {
    special_use = \Archive
    auto = create
  }
  mailbox Sent {
    special_use = \Sent
    auto = create
  }
}
CONF

dovecot -c "$BASE/dovecot.conf" stop 2>/dev/null || true
dovecot -c "$BASE/dovecot.conf"
nohup "$PYTHON" "$HERE/smtpd.py" "$BASE/smtp-out" > "$BASE/smtpd.log" 2>&1 &

for _ in $(seq 1 50); do
  (exec 3<>/dev/tcp/127.0.0.1/1143) 2>/dev/null && (exec 3<>/dev/tcp/127.0.0.1/2525) 2>/dev/null && { echo "test mail servers up"; exit 0; }
  sleep 0.2
done
echo "servers did not start; see $BASE/dovecot.log and $BASE/smtpd.log" >&2
exit 1
