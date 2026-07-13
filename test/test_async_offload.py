#!/usr/bin/env python3
"""Tests for src/mitm/async_offload.py — GuardedPool + submit_guarded."""

import asyncio
import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'mitm'))

from async_offload import (  # noqa: E402
    CLOSED, OPEN, HALF_OPEN, GuardedPool, Rejected, submit_guarded,
)


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


# success predicate: exception => failure, else truthy result
def _ok(exc, res):
    return exc is None and bool(res)


class BreakerStateTest(unittest.TestCase):
    def setUp(self):
        self.clk = FakeClock()
        self.pool = GuardedPool('t', max_workers=2, failure_threshold=3,
                                cooldown=30.0, clock=self.clk)

    def test_starts_closed_and_admits_up_to_cap(self):
        self.assertEqual(self.pool.state(), CLOSED)
        t1 = self.pool.admit()
        t2 = self.pool.admit()
        self.assertIsNotNone(t1)
        self.assertIsNotNone(t2)
        self.assertEqual(self.pool.inflight, 2)
        # saturated: 3rd rejected
        self.assertIsNone(self.pool.admit())

    def test_settle_decrements_inflight(self):
        t1 = self.pool.admit()
        self.pool.settle(t1, success=True)
        self.assertEqual(self.pool.inflight, 0)

    def test_opens_after_threshold_consecutive_failures(self):
        for _ in range(3):
            tok = self.pool.admit()
            self.pool.settle(tok, success=False)
        self.assertEqual(self.pool.state(), OPEN)
        self.assertIsNone(self.pool.admit())  # OPEN rejects

    def test_success_resets_failure_counter(self):
        for _ in range(2):
            tok = self.pool.admit()
            self.pool.settle(tok, success=False)
        tok = self.pool.admit()
        self.pool.settle(tok, success=True)  # reset
        tok = self.pool.admit()
        self.pool.settle(tok, success=False)
        self.assertEqual(self.pool.state(), CLOSED)  # only 1 fail since reset

    def test_half_open_after_cooldown_admits_one_probe(self):
        for _ in range(3):
            tok = self.pool.admit()
            self.pool.settle(tok, success=False)
        self.assertEqual(self.pool.state(), OPEN)
        self.clk.advance(31)
        self.assertEqual(self.pool.state(), HALF_OPEN)
        probe = self.pool.admit()
        self.assertIsNotNone(probe)
        self.assertTrue(probe.probe)
        # second probe rejected while first in flight
        self.assertIsNone(self.pool.admit())

    def test_half_open_probe_success_closes(self):
        for _ in range(3):
            tok = self.pool.admit()
            self.pool.settle(tok, success=False)
        self.clk.advance(31)
        probe = self.pool.admit()
        self.pool.settle(probe, success=True)
        self.assertEqual(self.pool.state(), CLOSED)
        self.assertIsNotNone(self.pool.admit())

    def test_half_open_probe_failure_reopens(self):
        for _ in range(3):
            tok = self.pool.admit()
            self.pool.settle(tok, success=False)
        self.clk.advance(31)
        probe = self.pool.admit()
        self.pool.settle(probe, success=False)
        self.assertEqual(self.pool.state(), OPEN)
        # cooldown restarts
        self.clk.advance(31)
        self.assertEqual(self.pool.state(), HALF_OPEN)

    def test_stale_result_does_not_flip_state(self):
        # admit a task while CLOSED (gen 0), then force OPEN via other failures,
        # then settle the stale task success — must NOT close prematurely in a
        # way that corrupts state / probe flag accounting.
        stale = self.pool.admit()  # gen 0
        for _ in range(3):
            tok = self.pool.admit()
            self.pool.settle(tok, success=False)  # opens, gen -> 1
        self.assertEqual(self.pool.state(), OPEN)
        gen_before = self.pool._gen
        self.pool.settle(stale, success=True)  # stale gen 0
        # still OPEN (stale success ignored for transition), inflight decremented
        self.assertEqual(self.pool.state(), OPEN)
        self.assertEqual(self.pool._gen, gen_before)

    def test_stale_result_does_not_touch_failure_counter(self):
        # A stale success must NOT reset the current generation's failure count,
        # and a stale failure must NOT inflate it (CR finding: counter leaked
        # across generations before the stale guard was moved up).
        self.pool = GuardedPool('t', max_workers=4, failure_threshold=3,
                                cooldown=30.0, clock=self.clk)
        # Open then close the breaker so _gen advances past a lingering token.
        stale = self.pool.admit()  # gen 0
        for _ in range(3):
            tok = self.pool.admit()
            self.pool.settle(tok, success=False)   # OPEN, gen -> 1
        self.clk.advance(31)
        probe = self.pool.admit()                  # HALF_OPEN probe, gen 1
        self.pool.settle(probe, success=True)      # CLOSED, gen -> 2
        # Two genuine failures in gen 2 (threshold is 3 → still CLOSED).
        for _ in range(2):
            tok = self.pool.admit()
            self.pool.settle(tok, success=False)
        self.assertEqual(self.pool.state(), CLOSED)
        cf_before = self.pool._consecutive_failures
        # A stale (gen 0) success arrives — must NOT reset the gen-2 counter.
        self.pool.settle(stale, success=True)
        self.assertEqual(self.pool._consecutive_failures, cf_before)
        # One more genuine failure now trips the threshold.
        tok = self.pool.admit()
        self.pool.settle(tok, success=False)
        self.assertEqual(self.pool.state(), OPEN)


class SubmitGuardedTest(unittest.TestCase):
    def test_runs_and_returns_result(self):
        pool = GuardedPool('run', max_workers=2)

        async def go():
            return await submit_guarded(pool, _ok, lambda x: x * 2, 21)

        self.assertEqual(asyncio.run(go()), 42)
        pool.shutdown(wait=True)

    def test_rejected_when_saturated(self):
        pool = GuardedPool('sat', max_workers=1, max_inflight=1)
        started = threading.Event()
        release = threading.Event()

        def block():
            started.set()
            release.wait(5)
            return True

        async def go():
            loop = asyncio.get_running_loop()
            # occupy the only slot
            task = asyncio.ensure_future(submit_guarded(pool, _ok, block))
            await loop.run_in_executor(None, started.wait, 5)
            # now saturated → Rejected synchronously
            with self.assertRaises(Rejected):
                await submit_guarded(pool, _ok, lambda: True)
            release.set()
            await task

        asyncio.run(go())
        pool.shutdown(wait=True)

    def test_cancellation_still_settles(self):
        # If the awaiter is cancelled, the worker completes and admission is
        # released (inflight back to 0), so later tasks are not starved.
        pool = GuardedPool('cancel', max_workers=1, max_inflight=1)
        release = threading.Event()
        ran_to_completion = threading.Event()

        def slow():
            release.wait(5)
            ran_to_completion.set()
            return True

        async def go():
            task = asyncio.ensure_future(submit_guarded(pool, _ok, slow))
            await asyncio.sleep(0.05)
            self.assertEqual(pool.inflight, 1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            # worker still running; inflight not yet released
            release.set()
            # let the done-callback marshal settle() onto the loop
            for _ in range(100):
                await asyncio.sleep(0.01)
                if pool.inflight == 0:
                    break
            self.assertTrue(ran_to_completion.is_set())
            self.assertEqual(pool.inflight, 0)

        asyncio.run(go())
        pool.shutdown(wait=True)

    def test_failure_predicate_trips_breaker(self):
        # A relay that "returns 418" counts as failure even without raising.
        pool = GuardedPool('pred', max_workers=1, failure_threshold=1, cooldown=30.0)

        def returns_418(exc, res):
            return exc is None and res == 200

        async def go():
            await submit_guarded(pool, returns_418, lambda: 418)
            # allow settle to marshal
            for _ in range(50):
                await asyncio.sleep(0.01)
                if pool.state() == OPEN:
                    break
            self.assertEqual(pool.state(), OPEN)

        asyncio.run(go())
        pool.shutdown(wait=True)

    def test_loop_not_blocked_while_worker_runs(self):
        # Heartbeat proof: a competing coroutine keeps ticking while the
        # offloaded worker blocks.
        pool = GuardedPool('heartbeat', max_workers=1)
        release = threading.Event()
        ticks = {'n': 0}

        def blocker():
            release.wait(5)
            return True

        async def heartbeat():
            while not release.is_set():
                ticks['n'] += 1
                await asyncio.sleep(0.01)

        async def go():
            hb = asyncio.ensure_future(heartbeat())
            worker = asyncio.ensure_future(submit_guarded(pool, _ok, blocker))
            await asyncio.sleep(0.1)
            self.assertGreater(ticks['n'], 3)  # loop kept running
            release.set()
            await worker
            await hb

        asyncio.run(go())
        pool.shutdown(wait=True)


if __name__ == '__main__':
    unittest.main()
