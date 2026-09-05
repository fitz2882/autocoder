# Local UI connections

The UI remains local-only. Every WebSocket route now requires a per-process
session plus a loopback peer and an exact local Host/Origin. Project updates,
spec creation, and assistant chat all use the same guard before their handlers.
The browser refreshes its session before each connection or reconnect using
`GET /api/session`; the token is held in a host-only HttpOnly, SameSite=Strict
cookie. It is not stored in localStorage or placed in URLs. Restarting the
backend invalidates prior sessions; the UI bootstraps again on reconnect.

Use `python start_ui.py` or `python start_ui.py --dev`. Production startup
rebuilds the frontend so an old bundle cannot miss the session protocol.
The launcher propagates the chosen backend port (8888–8897) to the guard and
disables forwarded-header trust. Development uses port 5173 exactly: an occupied
port fails startup and stops the companion backend, rather than silently opening
another application's page. Vite proxies both `/api` WebSockets and `/ws`.

For a manual single-worker Uvicorn launch, set `AUTOCODER_PORT` to the actual
listening port, bind `127.0.0.1`, and use `--no-proxy-headers`. Set
`AUTOCODER_DEV_PORT=5173` only when using the Vite development UI; its configured
port must match. Allowed browser origins are HTTP localhost, 127.0.0.1, or [::1]
with the configured port. Remote access, reverse proxies, and multi-worker
sessions are not supported by this local-only policy.

The existing agent command-line entry point is unchanged. A native local
WebSocket client can first GET `/api/session` from the configured local address
and send its response token as `Authorization: Bearer <token>` on the socket.
It may omit browser Origin/fetch metadata. A remote peer, foreign Origin,
malformed/duplicate security headers, or missing/invalid token is rejected even
when other credentials are supplied. This boundary protects browser-origin and
unauthenticated network access; it does not separate trusted local OS processes.

Run isolated backend tests with `python -m pytest tests/test_local_session.py`.
They use synthetic ASGI handlers, never project files, agents, or model calls.
