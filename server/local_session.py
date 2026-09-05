"""Local browser/CLI session boundary shared by every WebSocket route."""

import ipaddress
import os
import secrets
from http.cookies import SimpleCookie

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

COOKIE_NAME = "autocoder_session"


class LocalSessionPolicy:
    def __init__(self, port=8888, dev_port=None):
        ports = {int(port)}
        if dev_port is not None:
            ports.add(int(dev_port))
        if any(port < 1 or port > 65535 for port in ports):
            raise ValueError("Invalid local server port")
        self.hosts = {f"{host}:{port}" for host in ("localhost", "127.0.0.1", "[::1]") for port in ports}
        self.origins = {"http://" + host for host in self.hosts}
        self.token = secrets.token_urlsafe(32)

    def local_request(self, scope):
        client = scope.get("client")
        try:
            if not client or not ipaddress.ip_address(client[0]).is_loopback:
                return False
        except ValueError:
            return False
        headers = {}
        for name, value in scope.get("headers", []):
            name = name.lower()
            if name in {b"host", b"origin", b"authorization", b"cookie", b"sec-fetch-site"}:
                if name in headers:
                    return False
                headers[name] = value.decode("latin1")
        if headers.get(b"host", "").lower() not in self.hosts:
            return False
        origin = headers.get(b"origin")
        if origin is not None:
            if origin not in self.origins:
                return False
        elif headers.get(b"sec-fetch-site") not in (None, "same-origin"):
            return False
        return True

    def authorized_socket(self, scope):
        if not self.local_request(scope):
            return False
        headers = {k.lower(): v.decode("latin1") for k, v in scope["headers"]}
        authorization = headers.get(b"authorization")
        if authorization is not None:
            token = authorization[7:] if authorization.startswith("Bearer ") else ""
        else:
            try:
                cookies = SimpleCookie()
                cookies.load(headers.get(b"cookie", ""))
                token = cookies[COOKIE_NAME].value if COOKIE_NAME in cookies else ""
            except Exception:
                return False
        return secrets.compare_digest(token.encode(), self.token.encode())


policy = LocalSessionPolicy(os.getenv("AUTOCODER_PORT", "8888"), os.getenv("AUTOCODER_DEV_PORT"))
router = APIRouter()


@router.get("/api/session")
def local_session(request: Request):
    if not policy.local_request(request.scope):
        return JSONResponse({"detail": "Local application origin required"}, status_code=403)
    response = JSONResponse({"token": policy.token}, headers={"Cache-Control": "no-store"})
    response.set_cookie(
        COOKIE_NAME, policy.token, httponly=True, samesite="strict", path="/", secure=request.url.scheme == "https"
    )
    return response


class LocalWebSocketMiddleware:
    def __init__(self, app, session_policy=None):
        self.app = app
        self.policy = session_policy or policy

    async def __call__(self, scope, receive, send):
        if scope["type"] == "websocket" and not self.policy.authorized_socket(scope):
            await send({"type": "websocket.close", "code": 1008})
            return
        await self.app(scope, receive, send)
