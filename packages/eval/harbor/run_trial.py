"""Run exactly one pinned Harbor or Pier Trial."""

import asyncio
import contextlib
import fcntl
import hashlib
import importlib
import importlib.metadata
import os
import signal
import sys
from pathlib import Path
from typing import AsyncIterator


@contextlib.asynccontextmanager
async def task_cache_lock(cache_dir: Path, identity: str) -> AsyncIterator[None]:
    lock_dir = cache_dir / ".maka-locks"
    lock_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = lock_dir / f"{hashlib.sha256(identity.encode()).hexdigest()}.lock"
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(lock_path, flags, 0o600)
    acquired = False
    try:
        os.fchmod(descriptor, 0o600)
        while not acquired:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except BlockingIOError:
                await asyncio.sleep(0.05)
        yield
    finally:
        if acquired:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


async def run_trial(framework: str, expected_version: str, config_file: Path) -> None:
    distribution = {"harbor": "harbor", "pier": "datacurve-pier"}.get(framework)
    if distribution is None:
        raise RuntimeError("framework must be harbor or pier")
    if importlib.metadata.version(distribution) != expected_version:
        raise RuntimeError(f"{framework} version does not match the experiment spec")
    try:
        config_type = importlib.import_module(f"{framework}.models.trial.config").TrialConfig
        trial_type = importlib.import_module(f"{framework}.trial.trial").Trial
        config = config_type.model_validate_json(config_file.read_text())
        config_file.unlink()
        if framework == "harbor":
            from harbor.constants import TASK_CACHE_DIR

            task_identity = config.task.model_dump_json()
            async with task_cache_lock(TASK_CACHE_DIR, task_identity):
                trial = await trial_type.create(config)
        else:
            trial = await trial_type.create(config)
        await trial.run()
    finally:
        config_file.unlink(missing_ok=True)


async def main() -> None:
    framework, expected_version, config_path = sys.argv[1:]
    task = asyncio.current_task()
    assert task is not None
    loop = asyncio.get_running_loop()
    for host_signal in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(host_signal, task.cancel)
    try:
        await run_trial(framework, expected_version, Path(config_path))
    finally:
        for host_signal in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(host_signal)


if __name__ == "__main__":
    asyncio.run(main())
