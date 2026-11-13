"""Client for the transformation runner (spec section 9, AC-2).

The runner is a separate service (planned: Node with JSONata, no network egress,
CPU/memory limits). Protocol, POST {base}/v1/transform with {"expression", "input"}:

  200 {"output": <json>}                                    -> ok
  422 {"error": {"kind": "expression_error" | "limit_exceeded", "message": ...}}
                                                            -> error: the runner CONFIRMS the expression failed
  anything else: timeout, connection refused or reset, 5xx, 200 without "output",
  a body that is not JSON, an unknown error kind            -> unavailable: the result is unknown

Only `error` may send a delivery to dead (transform_error). `unavailable` defers it
without using an attempt, because a slow or broken runner says nothing about the expression.
"""

import asyncio
from dataclasses import dataclass
from typing import Any, Literal

import aiohttp

CONFIRMED_FAILURES = frozenset({"expression_error", "limit_exceeded"})


@dataclass(frozen=True)
class TransformResult:
    kind: Literal["ok", "error", "unavailable"]
    output: Any = None
    detail: str | None = None  # error kind or why the runner was unavailable; never payload data


class TransformClient:
    """Use as an async context manager; one per worker process."""

    def __init__(self, base_url: str, timeout: float = 2.0):
        self._url = base_url.rstrip("/") + "/v1/transform"
        self._timeout = timeout
        self._session: aiohttp.ClientSession | None = None

    async def __aenter__(self) -> "TransformClient":
        self._session = aiohttp.ClientSession(trust_env=False)
        return self

    async def __aexit__(self, *exc) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None

    async def transform(self, expression: str, data: Any) -> TransformResult:
        if self._session is None:
            raise RuntimeError("TransformClient used outside 'async with'")
        try:
            async with self._session.post(
                self._url,
                json={"expression": expression, "input": data},
                timeout=aiohttp.ClientTimeout(total=self._timeout),
            ) as resp:
                try:
                    body = await resp.json(content_type=None)
                except ValueError:
                    return TransformResult("unavailable", detail=f"runner sent a non-JSON {resp.status}")
                if resp.status == 200 and isinstance(body, dict) and "output" in body:
                    return TransformResult("ok", output=body["output"])
                error = body.get("error") if isinstance(body, dict) else None
                kind = error.get("kind") if isinstance(error, dict) else None
                if resp.status == 422 and kind in CONFIRMED_FAILURES:
                    return TransformResult("error", detail=kind)
                return TransformResult("unavailable", detail=f"runner answered {resp.status}")
        except TimeoutError:
            return TransformResult("unavailable", detail="runner timed out")
        except (aiohttp.ClientError, OSError, asyncio.IncompleteReadError) as e:
            return TransformResult("unavailable", detail=f"runner unreachable: {type(e).__name__}")
