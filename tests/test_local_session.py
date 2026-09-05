"""Real ASGI session guard; synthetic handlers never touch projects or agents."""

import ast
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import local_session as security

PATHS = ["/ws/projects/synthetic", "/api/spec/ws/synthetic", "/api/assistant/ws/synthetic"]


@pytest.fixture
def app(monkeypatch):
    policy = security.LocalSessionPolicy(8889, 5173)
    monkeypatch.setattr(security, "policy", policy)
    application = FastAPI()
    application.include_router(security.router)
    application.add_middleware(security.LocalWebSocketMiddleware, session_policy=policy)
    entered = []
    for path in PATHS:

        async def endpoint(ws: WebSocket):
            entered.append(ws.url.path)
            await ws.accept()
            await ws.send_text("synthetic accepted")
            await ws.close()

        application.websocket(path)(endpoint)
    return application, policy, entered


def connect(app, path, headers=None, peer="127.0.0.1"):
    return TestClient(app, base_url="http://127.0.0.1:8889", client=(peer, 555)).websocket_connect(
        "ws://127.0.0.1:8889" + path, headers=httpx.Headers(headers or {})
    )


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize(
    "case", ["missing", "wrong", "foreign", "null", "remote", "unknown", "host", "duplicate-origin", "duplicate-host"]
)
def test_socket_rejected_before_handler(app, path, case):
    application, policy, entered = app
    headers = {"Origin": "http://127.0.0.1:8889", "Authorization": "Bearer " + policy.token}
    peer = "127.0.0.1"
    if case == "missing":
        headers.pop("Authorization")
    if case == "wrong":
        headers["Authorization"] = "Bearer wrong"
    if case == "foreign":
        headers["Origin"] = "http://untrusted.example"
    if case == "null":
        headers["Origin"] = "null"
    if case == "remote":
        peer = "192.0.2.1"
    if case == "unknown":
        peer = "unknown"
    if case == "host":
        headers["Host"] = "attacker.example:8889"
    if case == "duplicate-origin":
        headers = [*headers.items(), ("Origin", headers["Origin"])]
    if case == "duplicate-host":
        headers = [*headers.items(), ("Host", "127.0.0.1:8889"), ("Host", "127.0.0.1:8889")]
    with pytest.raises(WebSocketDisconnect):
        with connect(application, path, headers, peer):
            pytest.fail("unexpected accept")
    assert entered == []


@pytest.mark.parametrize("path", PATHS)
def test_local_cli_and_browser_cookie_work(app, path):
    application, policy, entered = app
    client = TestClient(application, base_url="http://127.0.0.1:8889", client=("127.0.0.1", 555))
    response = client.get("/api/session", headers={"Sec-Fetch-Site": "same-origin"})
    assert response.status_code == 200
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie and "Domain=" not in cookie
    assert response.headers["cache-control"] == "no-store"
    with client.websocket_connect("ws://127.0.0.1:8889" + path, headers={"Origin": "http://127.0.0.1:5173"}) as ws:
        assert ws.receive_text() == "synthetic accepted"
    with connect(application, path, {"Authorization": "Bearer " + response.json()["token"]}) as ws:
        assert ws.receive_text() == "synthetic accepted"
    assert entered == [path, path]


@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": "http://evil.example"},
        {"Origin": "null"},
        {"Host": "evil.example:8889"},
        {"Sec-Fetch-Site": "cross-site"},
        {"Sec-Fetch-Site": "same-site"},
        {"Sec-Fetch-Site": "none"},
    ],
)
def test_bootstrap_cannot_issue_cross_origin_cookie(app, headers):
    application, _, _ = app
    client = TestClient(application, base_url="http://127.0.0.1:8889", client=("127.0.0.1", 555))
    response = client.get("/api/session", headers=headers)
    assert response.status_code == 403
    assert "set-cookie" not in response.headers
    assert "token" not in response.json()


def test_unknown_peer_and_production_dev_origin_fail_closed():
    policy = security.LocalSessionPolicy(8888)
    scope = {"client": None, "headers": [(b"host", b"127.0.0.1:8888")]}
    assert not policy.local_request(scope)
    scope["client"] = ("127.0.0.1", 123)
    scope["headers"].append((b"origin", b"http://127.0.0.1:5173"))
    assert not policy.local_request(scope)


def test_all_routes_receive_shared_application_guard():
    source = ast.parse((Path(__file__).resolve().parents[1] / "server/main.py").read_text())
    assert any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "add_middleware"
        and node.args
        and isinstance(node.args[0], ast.Name)
        and node.args[0].id == "LocalWebSocketMiddleware"
        for node in ast.walk(source)
    )


def test_launcher_stops_failed_dev_pair_without_opening_browser(monkeypatch):
    from unittest.mock import Mock

    import start_ui

    for name in ("setup_python_venv", "install_python_deps", "check_node", "install_npm_deps"):
        monkeypatch.setattr(start_ui, name, lambda: True)
    monkeypatch.setattr(start_ui, "find_available_port", lambda: 8889)
    monkeypatch.setattr(start_ui.time, "sleep", lambda _: None)
    monkeypatch.setattr(start_ui.sys, "argv", ["start_ui.py", "--dev"])
    backend, frontend = Mock(), Mock()
    backend.poll.return_value = None
    frontend.poll.return_value = 1
    monkeypatch.setattr(start_ui, "start_dev_server", lambda _: (backend, frontend))
    opened = Mock()
    monkeypatch.setattr(start_ui.webbrowser, "open", opened)
    with pytest.raises(SystemExit) as failure:
        start_ui.main()
    assert failure.value.code == 1
    opened.assert_not_called()
    for child in (backend, frontend):
        child.terminate.assert_called_once()
        child.wait.assert_called_once()


def test_launcher_propagates_selected_port_and_does_not_trust_forwarded_headers(monkeypatch):
    from unittest.mock import Mock

    import start_ui

    spawn = Mock()
    monkeypatch.setattr(start_ui.subprocess, "Popen", spawn)
    monkeypatch.setenv("AUTOCODER_DEV_PORT", "9999")
    start_ui.start_dev_server(8892)
    backend, frontend = spawn.call_args_list
    assert "--no-proxy-headers" in backend.args[0]
    assert backend.kwargs["env"]["AUTOCODER_PORT"] == "8892"
    assert backend.kwargs["env"]["AUTOCODER_DEV_PORT"] == "5173"
    assert frontend.kwargs["env"]["VITE_API_PORT"] == "8892"
    assert frontend.kwargs["env"]["AUTOCODER_DEV_PORT"] == "5173"
    spawn.reset_mock()
    start_ui.start_production_server(8893)
    assert "--no-proxy-headers" in spawn.call_args.args[0]
    assert spawn.call_args.kwargs["env"]["AUTOCODER_PORT"] == "8893"
    assert "AUTOCODER_DEV_PORT" not in spawn.call_args.kwargs["env"]


def test_existing_frontend_is_rebuilt_for_matching_session_protocol(monkeypatch):
    from unittest.mock import Mock

    import start_ui

    command = Mock(return_value=True)
    monkeypatch.setattr(start_ui, "run_command", command)
    assert start_ui.build_frontend()
    assert command.call_args.args[0][-2:] == ["run", "build"]
