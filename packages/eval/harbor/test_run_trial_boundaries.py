import asyncio
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

from run_trial import run_trial, task_cache_lock


class TaskCacheBoundaryTest(unittest.IsolatedAsyncioTestCase):
    async def test_waiting_for_the_same_task_is_cancellable(self) -> None:
        waiting_for_retry = asyncio.Event()

        async def wait_for_retry(_delay: float) -> None:
            waiting_for_retry.set()
            await asyncio.Future()

        with tempfile.TemporaryDirectory() as cache_dir:
            async with task_cache_lock(Path(cache_dir), "same-task"):
                with patch("run_trial.asyncio.sleep", new=wait_for_retry):
                    waiting = asyncio.create_task(
                        self._acquire(Path(cache_dir), "same-task")
                    )
                    await asyncio.wait_for(waiting_for_retry.wait(), timeout=1)
                waiting.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(waiting, timeout=1)

    async def test_failed_population_is_not_published_as_ready(self) -> None:
        creates = 0

        class FakeConfig:
            def __init__(self, name: str) -> None:
                self.name = name
                self.task = SimpleNamespace(
                    download_dir=None,
                    overwrite=False,
                    get_task_id=lambda: SimpleNamespace(
                        model_dump_json=lambda: "same-task"
                    ),
                )

        class FakeConfigType:
            @staticmethod
            def model_validate_json(value: str) -> FakeConfig:
                return FakeConfig(value)

        class FakeTrial:
            def __init__(self, task_dir: Path) -> None:
                self.task = SimpleNamespace(task_dir=task_dir)

            @classmethod
            async def create(cls, config: FakeConfig) -> "FakeTrial":
                nonlocal creates
                creates += 1
                self.assertTrue(config.task.overwrite)
                task_dir = config.task.download_dir / "task"
                task_dir.mkdir(parents=True, exist_ok=True)
                if config.name == "first":
                    (task_dir / "partial").write_text("partial")
                    raise RuntimeError("population failed")
                (task_dir / "complete").write_text("complete")
                return cls(task_dir)

            async def run(self) -> None:
                return None

        config_module = ModuleType("harbor.models.trial.config")
        config_module.TrialConfig = FakeConfigType
        trial_module = ModuleType("harbor.trial.trial")
        trial_module.Trial = FakeTrial
        constants_module = ModuleType("harbor.constants")

        with tempfile.TemporaryDirectory() as root:
            cache_dir = Path(root) / "cache"
            constants_module.TASK_CACHE_DIR = cache_dir
            first = Path(root) / "first.json"
            second = Path(root) / "second.json"
            first.write_text("first")
            second.write_text("second")
            modules = {
                "harbor.constants": constants_module,
                "harbor.models.trial.config": config_module,
                "harbor.trial.trial": trial_module,
            }
            with (
                patch.dict(sys.modules, modules),
                patch("run_trial.importlib.metadata.version", return_value="0.20.0"),
            ):
                with self.assertRaisesRegex(RuntimeError, "population failed"):
                    await run_trial("harbor", "0.20.0", first)

                namespace = cache_dir / ".maka-tasks" / hashlib.sha256(
                    b"same-task"
                ).hexdigest()
                self.assertFalse((namespace / "ready.json").exists())
                await run_trial("harbor", "0.20.0", second)
                self.assertTrue((namespace / "ready.json").exists())
                self.assertEqual(creates, 2)

    @staticmethod
    async def _acquire(cache_dir: Path, identity: str) -> None:
        async with task_cache_lock(cache_dir, identity):
            raise AssertionError("cancelled waiter must not acquire the lock")


if __name__ == "__main__":
    unittest.main()
