#!/usr/bin/env python3
"""
Cancellation-safe offload for the Myelin mitmproxy addon (stdlib-only).

mitmproxy runs synchronous ``def`` addon hooks INLINE on its single asyncio
event loop, so any blocking I/O in a hook freezes the entire proxy. The fix is
to make the hooks ``async def`` and push the blocking work onto dedicated
thread pools via ``await loop.run_in_executor(...)``.

Two hazards make a naive ``run_in_executor`` + ``try/finally`` unsafe, both
addressed here:

  * A ``ThreadPoolExecutor`` has an UNBOUNDED work queue, so "max_workers" does
    not bound how much work can pile up. We add an explicit admission cap and
    fail-open (skip) when saturated.
  * When a hook is cancelled (the Copilot CLI disconnected), the asyncio
    wrapper future is cancelled but the worker THREAD keeps running. Releasing
    admission / circuit-breaker leases from a ``finally`` around the ``await``
    therefore releases them early, letting cancelled bursts bypass the caps and
    refill the queue. We instead settle admission and breaker state ONLY from
    the underlying future's completion callback (marshalled back to the loop),
    and ``asyncio.shield`` the await so cancellation cannot pre-empt settlement.

This module owns NO mitmproxy types — the callers snapshot plain data on the
loop, run pure functions in the pool, and apply results on the loop. That keeps
``mitmproxy`` flow objects and ``ctx.log`` single-threaded.
"""

from __future__ import annotations

import asyncio
import time
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Callable, Optional

# Circuit-breaker states.
CLOSED = 'closed'
OPEN = 'open'
HALF_OPEN = 'half_open'


class Rejected(Exception):
    """Raised when a task is not admitted (breaker OPEN or pool saturated)."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class _Admission:
    """Opaque token describing one admitted task (loop-thread only)."""

    __slots__ = ('gen', 'probe')

    def __init__(self, gen: int, probe: bool):
        self.gen = gen
        self.probe = probe


class GuardedPool:
    """
    A dedicated thread pool with an admission cap and a circuit breaker.

    ALL state (in-flight count, breaker fields) is mutated ONLY on the event
    loop thread — from ``admit()`` (before submit) and from the loop-marshalled
    settlement of the worker future. No locks are required.

    Circuit breaker:
      * CLOSED     — admit up to ``max_inflight`` concurrent tasks.
      * OPEN       — reject all tasks until ``cooldown`` elapses.
      * HALF_OPEN  — admit exactly ONE probe; success closes, failure re-opens.

    A generation counter is bumped on every OPEN/CLOSE transition; a settling
    task tagged with a stale generation still adjusts bookkeeping (in-flight,
    probe flag) but does NOT drive a state transition, so a slow task that
    completes across a transition cannot flip the breaker spuriously.
    """

    def __init__(
        self,
        name: str,
        max_workers: int,
        *,
        max_inflight: Optional[int] = None,
        failure_threshold: int = 3,
        cooldown: float = 30.0,
        clock: Callable[[], float] = time.monotonic,
    ):
        if max_workers < 1:
            max_workers = 1
        self.name = name
        self._max_workers = max_workers
        # Admission cap defaults to the worker count so the executor's unbounded
        # queue never grows: at most ``max_workers`` tasks are ever in flight.
        self._max_inflight = max_inflight if max_inflight is not None else max_workers
        self._failure_threshold = max(1, failure_threshold)
        self._cooldown = cooldown
        self._clock = clock

        self._executor: Optional[ThreadPoolExecutor] = None
        self._inflight = 0
        self._consecutive_failures = 0
        self._open_until = 0.0
        self._half_open_probe_inflight = False
        self._gen = 0

    # -- introspection (tests / metrics) ------------------------------------
    @property
    def inflight(self) -> int:
        return self._inflight

    @property
    def max_inflight(self) -> int:
        return self._max_inflight

    def state(self, now: Optional[float] = None) -> str:
        now = self._clock() if now is None else now
        if self._open_until:
            return OPEN if now < self._open_until else HALF_OPEN
        return CLOSED

    def executor(self) -> ThreadPoolExecutor:
        """Lazily create the underlying executor (so imports don't spawn threads)."""
        if self._executor is None:
            self._executor = ThreadPoolExecutor(
                max_workers=self._max_workers,
                thread_name_prefix=f'myelin-{self.name}',
            )
        return self._executor

    def shutdown(self, wait: bool = False) -> None:
        if self._executor is not None:
            self._executor.shutdown(wait=wait)
            self._executor = None

    # -- admission / settlement (loop thread only) --------------------------
    def admit(self, now: Optional[float] = None) -> Optional[_Admission]:
        """
        Try to admit one task. Returns an admission token, or ``None`` if the
        breaker is OPEN, a HALF_OPEN probe is already in flight, or the pool is
        saturated. MUST be called on the event loop thread.
        """
        now = self._clock() if now is None else now
        st = self.state(now)
        if st == OPEN:
            return None
        if st == HALF_OPEN:
            if self._half_open_probe_inflight:
                return None
            self._half_open_probe_inflight = True
            self._inflight += 1
            return _Admission(self._gen, probe=True)
        # CLOSED
        if self._inflight >= self._max_inflight:
            return None
        self._inflight += 1
        return _Admission(self._gen, probe=False)

    def settle(self, token: _Admission, success: bool, now: Optional[float] = None) -> None:
        """
        Record the outcome of an admitted task. MUST run on the event loop
        thread (callers marshal via ``loop.call_soon_threadsafe``).
        """
        now = self._clock() if now is None else now
        self._inflight -= 1
        if self._inflight < 0:
            self._inflight = 0
        if token.probe:
            self._half_open_probe_inflight = False

        # A result from an older generation only adjusts the bookkeeping above
        # (in-flight / probe flag); it must NOT touch the failure counter or drive
        # a state transition — otherwise a slow task straddling an OPEN/CLOSE
        # transition could mask or fabricate failures for the current generation.
        if token.gen != self._gen:
            return

        if success:
            self._consecutive_failures = 0
            if token.probe or self._open_until:
                # A successful probe (or any success while the breaker was open)
                # closes the breaker.
                self._open_until = 0.0
                self._gen += 1
            return

        # failure
        self._consecutive_failures += 1
        if token.probe:
            # Probe failed → straight back to OPEN.
            self._open_until = now + self._cooldown
            self._gen += 1
        elif self._consecutive_failures >= self._failure_threshold:
            self._open_until = now + self._cooldown
            self._gen += 1


async def submit_guarded(
    pool: GuardedPool,
    success_of: Callable[[Optional[BaseException], Any], bool],
    fn: Callable[..., Any],
    *args: Any,
) -> Any:
    """
    Admit + run ``fn(*args)`` on ``pool``'s executor with cancellation-safe
    admission/breaker accounting.

    ``success_of(exc, result)`` decides whether the outcome counts as a success
    for the circuit breaker (e.g. a relay that returns HTTP 418 is a failure
    even though it did not raise).

    Raises ``Rejected`` synchronously (before any thread work) if not admitted.
    Otherwise returns ``fn``'s result, or re-raises its exception. If the caller
    is cancelled, the worker still runs to completion and settlement still fires
    exactly once — the result is simply discarded.
    """
    loop = asyncio.get_running_loop()
    token = pool.admit()
    if token is None:
        raise Rejected(f'{pool.name}: not admitted (state={pool.state()}, inflight={pool.inflight})')

    try:
        cf: Future = pool.executor().submit(fn, *args)
    except Exception:
        # Executor rejected the task (e.g. shut down) — release the admission
        # lease we just took so it doesn't leak (and un-wedge a HALF_OPEN probe).
        pool.settle(token, False)
        raise

    def _on_done(f: Future) -> None:
        # Runs in the worker thread — marshal state mutation onto the loop.
        try:
            exc = f.exception()
            res = None if exc is not None else f.result()
        except BaseException as e:  # pragma: no cover - defensive
            exc, res = e, None
        ok = False
        try:
            ok = success_of(exc, res)
        except BaseException:  # pragma: no cover - predicate must not throw
            ok = False
        try:
            loop.call_soon_threadsafe(pool.settle, token, ok)
        except RuntimeError:
            # The event loop is already closed (shutdown/reload, or asyncio.run
            # finished in a test) — nothing left to settle.
            pass

    cf.add_done_callback(_on_done)
    # shield: if the awaiting hook is cancelled, cf keeps running and _on_done
    # still settles; we just stop waiting for it.
    return await asyncio.shield(asyncio.wrap_future(cf))
