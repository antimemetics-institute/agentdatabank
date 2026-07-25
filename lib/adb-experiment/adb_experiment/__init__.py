"""adb-experiment: the Python experiment-side toolkit for ADB.

The runner-protocol scaffold re-exported here; provider routing in
:mod:`adb_experiment.providers`; the instrumented LLM client in
:mod:`adb_experiment.llm` (imported explicitly — it needs the ``[llm]`` extra's
OpenAI SDK, which the base package deliberately doesn't require).
"""

from .scaffold import deposit_artifact, experiment_main, protected_stream  # noqa: F401
