"""Prove the cell namespace forces subject egress through the audited proxy.

The Python policy test only checks that `run_trial.py` hands Harbor the right
allowlist. This test brings up the checked-in Compose overlay against a minimal
Harbor-shaped base, applies the checked-in `network-policy` from a sidecar that
shares the subject namespace, and asserts what the README promises: explicit
proxy traffic works, everything else does not, and the subject never sees the
CA private key or the audit log.

It needs a working Docker daemon and outbound network, so it is opt-in:

    MAKA_EVAL_EGRESS_NAMESPACE_TEST=1 python3 harbor/test_cell_egress_namespace.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HARBOR_DIR = Path(__file__).parent
OVERLAY = HARBOR_DIR / "docker-compose-egress-proxy.yaml"
NETWORK_POLICY = HARBOR_DIR / "egress-proxy" / "network-policy"
PROXY_IMAGE = "maka-eval-egress-proxy:12.2.3"
MAIN_IMAGE = "maka-eval-egress-namespace-main:test"
SIDECAR_IMAGE = "maka-eval-egress-namespace-sidecar:test"
PROJECT = "maka-eval-egress-namespace-test"
PROXY_HOST = "maka-eval-mitmproxy"
SIDECAR = "harbor-docker-egress-control-sidecar"
CA_PATH = "/opt/maka-egress/mitmproxy-ca-cert.pem"
BUILD_TIMEOUT_S = 900
COMMAND_TIMEOUT_S = 120

BASE_COMPOSE = f"""\
services:
  main:
    image: {MAIN_IMAGE}
    command: ["sleep", "infinity"]

  {SIDECAR}:
    image: {SIDECAR_IMAGE}
    command: ["sleep", "infinity"]
    network_mode: "service:main"
    cap_add:
      - NET_ADMIN
    depends_on:
      - main
"""

MAIN_DOCKERFILE = """\
FROM python:3.12-slim
RUN apt-get update \\
  && apt-get install -y --no-install-recommends ca-certificates curl iputils-ping \\
  && rm -rf /var/lib/apt/lists/*
"""

# Debian bookworm ships nftables 1.0.6, which rejects the `dstnat` priority name
# on a nat output chain; the policy needs 1.1 or newer, as Harbor's sidecar has.
SIDECAR_DOCKERFILE = """\
FROM debian:trixie-slim
RUN apt-get update \\
  && apt-get install -y --no-install-recommends nftables \\
  && rm -rf /var/lib/apt/lists/* \\
  && mkdir -p /opt/egress-sidecar
"""

TCP_PROBE = (
    "import socket\n"
    "try:\n"
    "    socket.create_connection(('1.1.1.1', 443), 5).close()\n"
    "    print('reachable')\n"
    "except OSError:\n"
    "    print('blocked')\n"
)

# A well-formed query for example.com. A malformed datagram is dropped without a
# reply even by a reachable resolver, which would report the open network as
# blocked and silently retire this probe's assertion.
UDP_PROBE = (
    "import socket\n"
    "query = (\n"
    "    b'\\xab\\xcd\\x01\\x00\\x00\\x01\\x00\\x00\\x00\\x00\\x00\\x00'\n"
    "    b'\\x07example\\x03com\\x00\\x00\\x01\\x00\\x01'\n"
    ")\n"
    "sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)\n"
    "sock.settimeout(5)\n"
    "try:\n"
    "    sock.sendto(query, ('8.8.8.8', 53))\n"
    "    sock.recvfrom(512)\n"
    "    print('reachable')\n"
    "except OSError:\n"
    "    print('blocked')\n"
)

# SO_MARK is 36 on Linux. gost marks its forwarded traffic, so a policy that
# exempted that mark would let any subject able to set it leave unproxied.
MARK_PROBE = (
    "import socket\n"
    "sock = socket.socket()\n"
    "try:\n"
    "    sock.setsockopt(socket.SOL_SOCKET, 36, 114514)\n"
    "except OSError:\n"
    "    print('blocked')\n"
    "else:\n"
    "    try:\n"
    "        sock.settimeout(5)\n"
    "        sock.connect(('1.1.1.1', 443))\n"
    "        print('reachable')\n"
    "    except OSError:\n"
    "        print('blocked')\n"
)

LOOPBACK_PROBE = (
    "import socket\n"
    "server = socket.socket()\n"
    "server.bind(('127.0.0.1', 0))\n"
    "server.listen(1)\n"
    "client = socket.create_connection(server.getsockname(), 5)\n"
    "client.close()\n"
    "print('reachable')\n"
)

PROXY_ENVIRONMENT = {
    "HTTPS_PROXY": f"http://{PROXY_HOST}:8080",
    "CURL_CA_BUNDLE": CA_PATH,
}

# The bypass attempt carries no CA override: pinning trust to the cell CA would
# fail a successful direct connection on certificate verification instead, and
# the assertion would hold even with the policy removed.
BYPASS_ENVIRONMENT = {"HTTPS_PROXY": f"http://{PROXY_HOST}:8080"}


def docker_available() -> bool:
    if shutil.which("docker") is None:
        return False
    probe = subprocess.run(
        ["docker", "version", "--format", "{{.Server.Version}}"],
        capture_output=True,
        timeout=COMMAND_TIMEOUT_S,
    )
    return probe.returncode == 0


@unittest.skipUnless(
    os.environ.get("MAKA_EVAL_EGRESS_NAMESPACE_TEST") == "1",
    "set MAKA_EVAL_EGRESS_NAMESPACE_TEST=1 to run the Docker cell namespace test",
)
class CellEgressNamespaceTest(unittest.TestCase):
    workdir: Path | None = None
    compose: list[str] = []

    @classmethod
    def setUpClass(cls) -> None:
        if not docker_available():
            raise unittest.SkipTest("Docker daemon is unavailable")
        cls.workdir = Path(tempfile.mkdtemp(prefix="maka-eval-egress-namespace-"))
        # Registered before anything can fail: `tearDownClass` does not run when
        # `setUpClass` raises, which would leak the stack and the named volume.
        cls.addClassCleanup(shutil.rmtree, cls.workdir, ignore_errors=True)
        (cls.workdir / "base.yaml").write_text(BASE_COMPOSE)
        cls.build_image(MAIN_IMAGE, dockerfile=MAIN_DOCKERFILE, name="main")
        cls.build_image(SIDECAR_IMAGE, dockerfile=SIDECAR_DOCKERFILE, name="sidecar")
        cls.build_image(
            PROXY_IMAGE, context=HARBOR_DIR, path=HARBOR_DIR / "egress-proxy" / "Dockerfile"
        )
        cls.compose = [
            "docker",
            "compose",
            "--project-name",
            PROJECT,
            "--file",
            str(cls.workdir / "base.yaml"),
            "--file",
            str(OVERLAY),
        ]
        cls.run_compose(["down", "--volumes", "--remove-orphans"], check=False)
        cls.addClassCleanup(
            cls.run_compose, ["down", "--volumes", "--remove-orphans"], check=False
        )
        cls.run_compose(["up", "--detach", "--wait"], timeout=BUILD_TIMEOUT_S)

    @classmethod
    def build_image(
        cls,
        tag: str,
        *,
        dockerfile: str | None = None,
        name: str | None = None,
        context: Path | None = None,
        path: Path | None = None,
    ) -> None:
        if dockerfile is not None:
            context = cls.workdir / name
            context.mkdir()
            (context / "Dockerfile").write_text(dockerfile)
        subprocess.run(
            [
                "docker",
                "build",
                "--tag",
                tag,
                *(["--file", str(path)] if path else []),
                str(context),
            ],
            check=True,
            timeout=BUILD_TIMEOUT_S,
        )

    @classmethod
    def run_compose(
        cls,
        arguments: list[str],
        *,
        check: bool = True,
        timeout: int = COMMAND_TIMEOUT_S,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [*cls.compose, *arguments],
            env={**os.environ, "MAKA_EVAL_NETWORK_POLICY_PATH": str(NETWORK_POLICY)},
            capture_output=True,
            text=True,
            check=check,
            timeout=timeout,
        )

    @classmethod
    def exec_service(
        cls,
        service: str,
        command: list[str],
        *,
        environment: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        overrides = [
            argument
            for name, value in (environment or {}).items()
            for argument in ("--env", f"{name}={value}")
        ]
        return cls.run_compose(
            ["exec", "--no-TTY", *overrides, service, *command], check=False
        )

    @classmethod
    def exec_main(
        cls, command: list[str], *, environment: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        return cls.exec_service("main", command, environment=environment)

    @classmethod
    def probe_main(cls, script: str) -> str:
        result = cls.exec_main(["python3", "-c", script])
        if result.returncode != 0:
            raise AssertionError(f"probe failed to run: {result.stderr}")
        return result.stdout.strip()

    @classmethod
    def curl(
        cls, arguments: list[str], *, environment: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        return cls.exec_main(
            [
                "curl",
                "--silent",
                "--show-error",
                "--max-time",
                "20",
                "--output",
                "/dev/null",
                *arguments,
                "https://example.com",
            ],
            environment=environment,
        )

    @classmethod
    def ping(cls) -> subprocess.CompletedProcess[str]:
        return cls.exec_main(["ping", "-c", "1", "-W", "5", "1.1.1.1"])

    def test_subject_sees_only_the_ca_certificate(self) -> None:
        listed = self.exec_main(["ls", "--almost-all", "/opt/maka-egress"])
        self.assertEqual(listed.returncode, 0, listed.stderr)
        self.assertEqual(listed.stdout.split(), ["mitmproxy-ca-cert.pem"])

    def test_cell_namespace_admits_only_the_audited_proxy(self) -> None:
        # Every negative assertion below is vacuous on a host that cannot reach
        # the target anyway, so the reachability of each one is asserted before
        # the policy exists. Failing there is the point: a skip would report a
        # contract this run never actually exercised.
        self.assertEqual(self.curl([]).returncode, 0, "no HTTPS before any policy")
        self.assertEqual(self.probe_main(TCP_PROBE), "reachable")
        self.assertEqual(self.probe_main(UDP_PROBE), "reachable")
        self.assertEqual(self.ping().returncode, 0, "no ICMP before any policy")

        applied = self.exec_service(
            SIDECAR, ["network-policy", "allow", PROXY_HOST]
        )
        self.assertEqual(applied.returncode, 0, applied.stderr)

        with self.subTest("explicit proxy HTTPS"):
            allowed = self.curl([], environment=PROXY_ENVIRONMENT)
            self.assertEqual(allowed.returncode, 0, allowed.stderr)

        with self.subTest("curl --noproxy"):
            bypassed = self.curl(["--noproxy", "*"], environment=BYPASS_ENVIRONMENT)
            self.assertNotEqual(bypassed.returncode, 0)

        with self.subTest("direct IP TCP"):
            self.assertEqual(self.probe_main(TCP_PROBE), "blocked")

        with self.subTest("forged sidecar packet mark"):
            self.assertEqual(self.probe_main(MARK_PROBE), "blocked")

        with self.subTest("external UDP"):
            self.assertEqual(self.probe_main(UDP_PROBE), "blocked")

        with self.subTest("external ICMP"):
            self.assertNotEqual(self.ping().returncode, 0)

        with self.subTest("loopback provider proxy"):
            self.assertEqual(self.probe_main(LOOPBACK_PROBE), "reachable")

        with self.subTest("Docker DNS"):
            resolved = self.exec_main(["getent", "hosts", PROXY_HOST])
            self.assertEqual(resolved.returncode, 0, resolved.stderr)

if __name__ == "__main__":
    unittest.main()
