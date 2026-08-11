import asyncio
import multiprocessing
import queue
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

from run_trial import run_trial, task_cache_lock


def acquire_lock(
    cache_dir: str,
    identity: str,
    started: multiprocessing.Queue,
    acquired: multiprocessing.Queue,
) -> None:
    async def acquire() -> None:
        started.put(identity)
        async with task_cache_lock(Path(cache_dir), identity):
            acquired.put(identity)

    asyncio.run(acquire())


class TaskCacheLockTest(unittest.IsolatedAsyncioTestCase):
    async def test_same_task_waits_for_the_existing_process(self) -> None:
        context = multiprocessing.get_context("spawn")
        started = context.Queue()
        acquired = context.Queue()
        with tempfile.TemporaryDirectory() as cache_dir:
            async with task_cache_lock(Path(cache_dir), "same-task"):
                process = context.Process(
                    target=acquire_lock,
                    args=(cache_dir, "same-task", started, acquired),
                )
                process.start()
                self.assertEqual(started.get(timeout=2), "same-task")
                with self.assertRaises(queue.Empty):
                    acquired.get(timeout=0.2)
            self.assertEqual(acquired.get(timeout=2), "same-task")
            process.join(timeout=2)
            self.assertEqual(process.exitcode, 0)

    async def test_different_task_does_not_wait(self) -> None:
        context = multiprocessing.get_context("spawn")
        started = context.Queue()
        acquired = context.Queue()
        with tempfile.TemporaryDirectory() as cache_dir:
            async with task_cache_lock(Path(cache_dir), "first-task"):
                process = context.Process(
                    target=acquire_lock,
                    args=(cache_dir, "second-task", started, acquired),
                )
                process.start()
                self.assertEqual(started.get(timeout=2), "second-task")
                self.assertEqual(acquired.get(timeout=2), "second-task")
                process.join(timeout=2)
                self.assertEqual(process.exitcode, 0)

    async def test_waiting_for_the_same_task_is_cancellable(self) -> None:
        waiting_for_lock = asyncio.Event()

        async def wait_for_retry(_delay: float) -> None:
            waiting_for_lock.set()
            await asyncio.Future()

        with tempfile.TemporaryDirectory() as cache_dir:
            async with task_cache_lock(Path(cache_dir), "same-task"):
                with patch("run_trial.asyncio.sleep", new=wait_for_retry):
                    waiting = asyncio.create_task(
                        self._acquire(Path(cache_dir), "same-task")
                    )
                    await asyncio.wait_for(waiting_for_lock.wait(), timeout=1)
                waiting.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(waiting, timeout=1)

    @staticmethod
    async def _acquire(cache_dir: Path, identity: str) -> None:
        async with task_cache_lock(cache_dir, identity):
            raise AssertionError("cancelled waiter must not acquire the lock")


class TrialCreateLockTest(unittest.IsolatedAsyncioTestCase):
    async def test_trial_create_is_serialized_but_trial_run_is_not(self) -> None:
        first_create_entered = asyncio.Event()
        release_first_create = asyncio.Event()
        second_identity_read = asyncio.Event()
        second_create_entered = asyncio.Event()
        first_run_entered = asyncio.Event()
        second_run_entered = asyncio.Event()
        release_runs = asyncio.Event()

        class FakeConfig:
            def __init__(self, name: str) -> None:
                self.name = name
                self.task = SimpleNamespace(
                    model_dump_json=lambda: f"same-task-config-{name}",
                    get_task_id=self.get_task_id,
                )

            def get_task_id(self) -> SimpleNamespace:
                if self.name == "second":
                    second_identity_read.set()
                return SimpleNamespace(model_dump_json=lambda: "same-task")

        class FakeConfigType:
            @staticmethod
            def model_validate_json(value: str) -> FakeConfig:
                return FakeConfig(value)

        class FakeTrial:
            def __init__(self, name: str) -> None:
                self.name = name

            @classmethod
            async def create(cls, config: FakeConfig) -> "FakeTrial":
                if config.name == "first":
                    first_create_entered.set()
                    await release_first_create.wait()
                else:
                    second_create_entered.set()
                return cls(config.name)

            async def run(self) -> None:
                (first_run_entered if self.name == "first" else second_run_entered).set()
                await release_runs.wait()

        config_module = ModuleType("harbor.models.trial.config")
        config_module.TrialConfig = FakeConfigType
        trial_module = ModuleType("harbor.trial.trial")
        trial_module.Trial = FakeTrial
        constants_module = ModuleType("harbor.constants")

        with tempfile.TemporaryDirectory() as root:
            constants_module.TASK_CACHE_DIR = Path(root) / "cache"
            first_path = Path(root) / "first.json"
            second_path = Path(root) / "second.json"
            first_path.write_text("first")
            second_path.write_text("second")
            modules = {
                "harbor.constants": constants_module,
                "harbor.models.trial.config": config_module,
                "harbor.trial.trial": trial_module,
            }
            with (
                patch.dict("sys.modules", modules),
                patch("run_trial.importlib.metadata.version", return_value="0.20.0"),
            ):
                first = asyncio.create_task(run_trial("harbor", "0.20.0", first_path))
                await asyncio.wait_for(first_create_entered.wait(), timeout=1)
                second = asyncio.create_task(run_trial("harbor", "0.20.0", second_path))
                await asyncio.wait_for(second_identity_read.wait(), timeout=1)
                self.assertFalse(second_create_entered.is_set())

                release_first_create.set()
                await asyncio.wait_for(first_run_entered.wait(), timeout=1)
                await asyncio.wait_for(second_create_entered.wait(), timeout=1)
                await asyncio.wait_for(second_run_entered.wait(), timeout=1)

                release_runs.set()
                await asyncio.wait_for(asyncio.gather(first, second), timeout=1)


if __name__ == "__main__":
    unittest.main()
