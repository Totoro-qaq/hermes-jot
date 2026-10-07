"""Jot: human-owned notes with optional agent collaboration."""
import json
from pathlib import Path
from .backend import agent_call, observe_agent_access


def _availability():
    """Hides the jot_* schemas from the model while the human collaboration switch is off.

    Hermes probes this when it builds an agent; a live chat keeps the tools it started with, so a
    flip reaches the next chat. Observing a flip also drops Hermes' memoized tool lists.
    """
    def jot_agent_access_enabled():
        return observe_agent_access()
    # A local file read: skip the registry's TTL verdict cache.
    try:
        from tools.registry import no_cache_check_fn
        return no_cache_check_fn(jot_agent_access_enabled)
    except Exception:
        return jot_agent_access_enabled


def _observe_switch(**_kwargs):
    # Every turn: catches a flip the Desktop API made from another process (gateway, CLI, compute host).
    observe_agent_access()


def register(ctx):
    schemas = json.loads((Path(__file__).parent / "runtime/tools.json").read_text(encoding="utf-8"))
    available = _availability()
    for schema in schemas:
        name = schema["name"]
        def handler(args, _name=name, **kwargs):
            return agent_call(_name, args)
        ctx.register_tool(name=name, toolset="jot", schema=schema, handler=handler, check_fn=available)
    try:
        ctx.register_hook("pre_llm_call", _observe_switch)
    except Exception:
        pass
    # Desktop's supported composer middleware opens the local pane. Registering
    # the command here lets Hermes consume it normally without a model turn.
    def command(raw_args):
        if raw_args.strip() in ("", "new", "capture"):
            return None
        return "Jot: /jot, /jot new, /jot capture in Hermes Desktop. Agent access uses the six jot_* tools and requires the human collaboration switch."
    ctx.register_command("jot", command, description="Open Jot notes", args_hint="[new|capture|help]")
