"""Jot: human-owned notes with optional agent collaboration."""
import json
from pathlib import Path
from .backend import agent_call, handle_command


def register(ctx):
    schemas = json.loads((Path(__file__).parent / "runtime/tools.json").read_text(encoding="utf-8"))
    for schema in schemas:
        name = schema["name"]
        def handler(args, _name=name, **kwargs):
            return agent_call(_name, args)
        ctx.register_tool(name=name, toolset="jot", schema=schema, handler=handler)
    # User-typed only. There is no tool for this switch: Hermes dispatches slash
    # commands before the model sees them, and the store rejects an agent actor.
    ctx.register_command(
        "jot", handle_command,
        description="Open Jot or turn AI collaboration on or off",
        args_hint="[new|capture|ai on|off|status|help]",
    )
