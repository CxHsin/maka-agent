import importlib
import os
import sys
import types
import unittest
from pathlib import Path


class BaseAgent:
    def __init__(self, *args, **kwargs):
        pass


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


class FakeEnvironment:
    def __init__(self):
        self.uploaded = b""
        self.source = None

    async def upload_file(self, source, _target):
        self.source = Path(source)
        self.uploaded = self.source.read_bytes()


class RelayAgentBoundaryTest(unittest.IsolatedAsyncioTestCase):
    async def test_command_stages_credentials_and_captures_stdout_out_of_band(self):
        relay = load_relay()
        environment = FakeEnvironment()
        secret = "test-only-canary"

        command = await relay._prepare_command(
            environment,
            {
                "command": "/opt/agent",
                "args": ["run"],
                "credentials": {"OPENAI_API_KEY": secret},
            },
            "token",
            "/tmp/scope.pid",
            "/tmp/result.stdout",
        )

        self.assertNotIn(secret, command)
        self.assertIn(secret.encode(), environment.uploaded)
        self.assertFalse(environment.source.exists())
        self.assertIn("> /tmp/result.stdout", command)
        self.assertTrue(command.startswith("setsid --wait sh -c "))


if __name__ == "__main__":
    unittest.main()
