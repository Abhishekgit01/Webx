"""Webx run-memory Lambda.

Routes (behind API Gateway HTTP API):
  POST /runs           store a run record
  GET  /runs/{runId}   fetch one record
  GET  /runs           list the most recent records

DynamoDB is the only AWS dependency; boto3 is provided by the Lambda runtime.
The optional WEBX_API_TOKEN shared secret is enforced when configured.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import boto3
from botocore.exceptions import ClientError

TABLE_NAME = os.environ.get("TABLE_NAME", "webx-runs")
API_TOKEN = os.environ.get("WEBX_API_TOKEN", "").strip()
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*").strip() or "*"
RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")
MAX_BODY_BYTES = 48_000

_table = None


def _get_table():
    global _table
    if _table is None:
        _table = boto3.resource("dynamodb").Table(TABLE_NAME)
    return _table


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _cors() -> dict[str, str]:
    return {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Content-Type": "application/json",
    }


def response(status: int, body: dict[str, Any] | list[Any]) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": _cors(),
        "body": json.dumps(body, default=str),
    }


def _authorized(event: dict[str, Any]) -> bool:
    if not API_TOKEN:
        return True
    headers = {str(key).lower(): value for key, value in (event.get("headers") or {}).items()}
    supplied = str(headers.get("authorization") or headers.get("x-webx-token") or "").strip()
    if supplied.lower().startswith("bearer "):
        supplied = supplied[7:].strip()
    return supplied == API_TOKEN


def _body(event: dict[str, Any]) -> dict[str, Any]:
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        import base64

        raw = base64.b64decode(raw).decode("utf-8", errors="replace")
    if len(raw.encode("utf-8")) > MAX_BODY_BYTES:
        raise ValueError("request body is too large")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("body must be a JSON object")
    return data


def _clean(value: Any) -> Any:
    """DynamoDB rejects floats; convert them to Decimal recursively."""
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {str(key): _clean(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_clean(item) for item in value]
    return value


def _plain(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_plain(item) for item in value]
    return value


def _method(event: dict[str, Any]) -> str:
    return str(
        event.get("requestContext", {}).get("http", {}).get("method")
        or event.get("httpMethod")
        or "GET"
    ).upper()


def _path(event: dict[str, Any]) -> str:
    raw = str(event.get("rawPath") or event.get("path") or "/")
    return raw.rstrip("/") or "/"


def _create(event: dict[str, Any]) -> dict[str, Any]:
    data = _body(event)
    task = str(data.get("task") or "").strip()
    if not task:
        return response(400, {"ok": False, "error": "task is required"})
    if len(task) > 1400:
        return response(400, {"ok": False, "error": "task is too long"})

    run_id = str(data.get("runId") or "").strip()
    if not run_id:
        run_id = datetime.now(timezone.utc).strftime("run-%Y%m%d-%H%M%S")
    if not RUN_ID_RE.match(run_id):
        return response(400, {"ok": False, "error": "runId contains unsupported characters"})

    created = str(data.get("createdAt") or _now())
    item = {
        "runId": run_id,
        "task": task,
        "status": str(data.get("status") or "complete")[:32],
        "price": str(data.get("price") or "")[:64],
        "product": str(data.get("product") or "")[:200],
        "trackersBlocked": int(data.get("trackersBlocked") or 0),
        "tabs": int(data.get("tabs") or 0),
        "createdAt": created,
        "updatedAt": _now(),
        "result": _clean(data.get("result") or {}),
    }
    _get_table().put_item(Item=item)
    return response(201, {"ok": True, "runId": run_id, "createdAt": created})


def _get(run_id: str) -> dict[str, Any]:
    if not RUN_ID_RE.match(run_id):
        return response(400, {"ok": False, "error": "invalid runId"})
    try:
        item = _get_table().get_item(Key={"runId": run_id}).get("Item")
    except ClientError as exc:
        return response(500, {"ok": False, "error": str(exc)[:200]})
    if not item:
        return response(404, {"ok": False, "error": "run not found"})
    return response(200, {"ok": True, "run": _plain(item)})


def _list() -> dict[str, Any]:
    scan = _get_table().scan(Limit=50)
    items = [_plain(item) for item in scan.get("Items", [])]
    items.sort(key=lambda item: item.get("createdAt", ""), reverse=True)
    return response(200, {"ok": True, "runs": items[:25], "count": min(len(items), 25)})


def lambda_handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    method = _method(event)
    path = _path(event)

    if method == "OPTIONS":
        return response(204, {})

    if not _authorized(event):
        return response(401, {"ok": False, "error": "unauthorized"})

    try:
        if path == "/runs" and method == "POST":
            return _create(event)
        if path == "/runs" and method == "GET":
            return _list()
        if path.startswith("/runs/") and method == "GET":
            return _get(path.split("/", 2)[2])
        if path in {"/", "/health"} and method == "GET":
            return response(200, {"ok": True, "service": "webx-memory", "table": TABLE_NAME})
        return response(404, {"ok": False, "error": "not found"})
    except json.JSONDecodeError:
        return response(400, {"ok": False, "error": "body must be valid JSON"})
    except ValueError as exc:
        return response(400, {"ok": False, "error": str(exc)})
    except Exception as exc:  # noqa: BLE001 - never leak a stack trace to the API
        print(f"webx-memory error: {exc!r}")
        return response(500, {"ok": False, "error": "internal error"})
