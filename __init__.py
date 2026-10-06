"""Jot: human-owned notes with optional agent collaboration."""
import json
from pathlib import Path
from .backend import agent_call


def register(ctx):
    schemas = json.loads((Path(__file__).parent / "runtime/tools.json").read_text(encoding="utf-8"))
    for schema in schemas:
        name = schema["name"]
        def handler(args, _name=name, **kwargs):
            return agent_call(_name, args)
        ctx.register_tool(name=name, toolset="jot", schema=schema, handler=handler)
    # Desktop's supported composer middleware opens the local pane. Registering
    # the command here lets Hermes consume it normally without a model turn.
    def command(raw_args):
        if raw_args.strip() in ("", "new", "capture"):
            return None
        return "Jot: /jot, /jot new, /jot capture in Hermes Desktop. Agent access uses the six jot_* tools and requires the human collaboration switch."
    ctx.register_command("jot", command, description="Open Jot notes / 打开随记", args_hint="[new|capture|help]")
