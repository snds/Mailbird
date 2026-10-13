#!/usr/bin/env python3
# Test SMTP sink: AUTH PLAIN/LOGIN as tester/secret, writes each message to a file.
import asyncio, sys, pathlib, itertools
from aiosmtpd.controller import Controller
from aiosmtpd.smtp import AuthResult, LoginPassword

out = pathlib.Path(sys.argv[1]); counter = itertools.count(1)

def auth(server, session, envelope, mechanism, data):
    ok = isinstance(data, LoginPassword) and data.login == b"tester" and data.password == b"secret"
    return AuthResult(success=ok)

class Sink:
    async def handle_DATA(self, server, session, envelope):
        (out / f"{next(counter)}.eml").write_bytes(envelope.original_content)
        (out / "rcpts.txt").open("a").write(",".join(envelope.rcpt_tos) + "\n")
        return "250 OK"

c = Controller(Sink(), hostname="127.0.0.1", port=2525, authenticator=auth,
               auth_required=True, auth_require_tls=False)
c.start(); print("smtp sink on 2525", flush=True)
asyncio.get_event_loop().run_forever()
