# @maka/eval

`@maka/eval` owns experiment semantics. It does not execute Maka or construct Runtime objects.

```text
Experiment → Cells → Attempts → Results
                    ↓
       Runtime Host executes Maka subjects
```

An Experiment combines one benchmark, one executor, all subjects, all tasks, a repetition count, one shared budget, one verifier, and a frozen task-group concurrency limit. Cells are the Cartesian product `task × repetition × subject`. All subject arms in one task repetition start together; independent task groups run up to the declared limit. A repetition is a new experimental sample; an infrastructure retry appends a replacement attempt to the same cell; continuation remains internal to Runtime Host. Each subject declares only the credential environment names its cells receive.

Run a fully expanded spec through the public CLI:

```sh
maka eval run experiment.json --out .maka-eval/run-001
```

Use `--cell <cell-id>` to replace one failed or indeterminate cell. The attempt log is append-only and result selection always uses the earliest valid attempt.

The built-in Harbor and Pier executors use one relay Agent. The framework prepares the task environment, the relay invokes exactly one Eval subject from `Agent.run()`, and the framework runs its native verifier and finalizer. Harbor and Pier use separate, explicitly versioned Python environments because their Agent and task contracts differ.

Maka subjects ask the Runtime Host client to run one owned execution in a dedicated Host root. Session, Turn, Goal and continuation semantics remain inside Runtime Host. External subjects declare only a command and arguments; cohort-specific wrappers may configure the external product, but do not gain Runtime authority.

The result kernel contains only score, normalized usage, attributable cost, duration, status, and artifacts. Specs carry every semantic setting; environment variables are reserved for credentials and machine-local paths.

The checked-in primary Terminal-Bench 2.1 cohort is `experiments/terminal-bench-2.1-deepseek-v4-flash-seven-arm.json`. Its seven arms are Maka, Codex, Claude Code, Reasonix, OpenCode, Kimi Code and the official ZCode headless CLI extracted from the pinned ZCode 3.7.5 Linux package (`zcode` CLI 0.16.1). The spec freezes provider endpoints, DeepSeek V4 Flash at each product's highest native `max` reasoning setting, framework version, container paths, read-only mounts and a 70-cell peak (`10 task groups × 7 arms`). External wrappers verify the pinned toolchain manifest and file checksums before model admission, meter provider traffic through a cell-local proxy, and retain trajectory and stderr artifacts under `/logs/agent`; ZCode model-I/O and runtime JSONL are retained as separate trial artifacts.

The six-arm and four-arm files remain compatibility subsets. All cohorts preserve each task's native timeout and run the native verifier after subject timeout so already-written task output can still receive credit. Usage, attributable cost and trajectory capture use the same Eval result contract across arms. Product-native web search and fetch tools are disabled for Codex, Claude Code, Reasonix, OpenCode, Kimi Code and ZCode. Maka disables WebSearch by default, but its current Eval session contract does not provide a per-session ceiling for WebFetch, so that remaining capability difference is reported rather than hidden. Terminal-Bench tasks still run with their declared internet access, and every arm may use public network access through shell commands.

Set each declared machine-path environment variable to the matching prepared toolchain directory and set the declared API-key credentials. Missing or mismatched machine paths fail before model admission and remain replaceable infrastructure attempts. The deployment environment is intentionally not part of the repository: host package installation, executable availability, filesystem paths and machine capacity are operator configuration; model selection, reasoning effort, native-tool policy, timeout/verifier behavior, metering and expected toolchain identities are Eval semantics.

The experiment directory contains the frozen `experiment.json` and append-only attempt records. There is no second mutable results file. A leftover `.writer.lock` means the previous writer did not complete; remove it only after proving that no writer process remains.
