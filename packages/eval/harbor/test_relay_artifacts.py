import asyncio
import importlib
import os
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from types import SimpleNamespace


class BaseAgent:
    def __init__(self, *args, **kwargs):
        pass


class LocalEnvironment:
    async def upload_file(self, source, target):
        shutil.copyfile(source, target)

    async def download_file(self, source, target):
        shutil.copyfile(source, target)

    async def exec(self, command, cwd=None, timeout_sec=None):
        completed = await asyncio.to_thread(
            subprocess.run,
            command,
            cwd=cwd,
            shell=True,
            executable="/bin/bash",
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
        )
        return SimpleNamespace(
            return_code=completed.returncode,
            stdout=completed.stdout,
            stderr=completed.stderr,
        )


def load_relay():
    os.environ["MAKA_EVAL_FRAMEWORK"] = "harbor"
    package = types.ModuleType("harbor")
    agents = types.ModuleType("harbor.agents")
    base = types.ModuleType("harbor.agents.base")
    base.BaseAgent = BaseAgent
    sys.modules["harbor"] = package
    sys.modules["harbor.agents"] = agents
    sys.modules["harbor.agents.base"] = base
    sys.modules.pop("relay_agent", None)
    return importlib.import_module("relay_agent")


class RelayArtifactTest(unittest.IsolatedAsyncioTestCase):
    async def test_output_files_do_not_wait_for_a_descendant_holding_descriptors(self):
        relay = load_relay()
        environment = LocalEnvironment()
        with tempfile.TemporaryDirectory() as directory:
            token = f"descriptor-{os.getpid()}"
            scope_path = str(Path(directory) / "scope.pid")
            output_path = str(Path(directory) / "subject.stdout")
            stderr_path = str(Path(directory) / "subject.stderr")
            child_path = str(Path(directory) / "child.pid")
            request = {
                "command": sys.executable,
                "args": [
                    "-c",
                    (
                        "import os,time;"
                        "child=os.fork();"
                        f"(open({child_path!r},'w').write(str(os.getpid())),time.sleep(5),os._exit(0))"
                        " if child==0 else (os.write(1,b'result-json\\n'),"
                        "os.write(2,b'runtime-error\\n'),os._exit(0))"
                    ),
                ],
                "credentials": {},
                "cwd": directory,
            }
            command = await relay._prepare_command(
                environment,
                request,
                token,
                scope_path,
                output_path,
                stderr_path,
            )
            started = time.monotonic()
            completed = await environment.exec(command, cwd=directory)
            self.assertLess(time.monotonic() - started, 1)
            self.assertEqual(completed.return_code, 0)
            self.assertEqual(
                await relay._read_subject_output(environment, output_path),
                "result-json\n",
            )
            self.assertEqual(
                await relay._read_subject_output(
                    environment, stderr_path, limit_bytes=64 * 1024
                ),
                "runtime-error\n",
            )
            deadline = time.monotonic() + 1
            while not Path(child_path).exists():
                if time.monotonic() >= deadline:
                    self.fail("descendant PID was not published")
                await asyncio.sleep(0.01)
            child_pid = int(Path(child_path).read_text())
            os.kill(child_pid, 15)


if __name__ == "__main__":
    unittest.main()
