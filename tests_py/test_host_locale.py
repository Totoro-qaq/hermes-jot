"""Conflict copy follows the public, profile-scoped host APIs even without private i18n."""
import importlib.util
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("jot_locale_backend", Path(__file__).resolve().parents[1] / "backend.py")
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class HostLocale(unittest.TestCase):
    def setUp(self):
        self.env = None
        self.config = {"display": {"language": "zh"}}
        self.calls = []
        agent = types.ModuleType("agent")
        agent.__path__ = []
        secrets = types.ModuleType("agent.secret_scope")
        secrets.get_secret = self.read_env
        cli = types.ModuleType("hermes_cli")
        cli.__path__ = []
        config = types.ModuleType("hermes_cli.config")
        config.load_config_readonly = self.read_config
        self.enterContext(patch.dict(sys.modules, {
            "agent": agent, "agent.secret_scope": secrets, "agent.i18n": None,
            "hermes_cli": cli, "hermes_cli.config": config,
        }))

    def read_env(self, name):
        self.calls.append(name)
        if isinstance(self.env, Exception):
            raise self.env
        return self.env

    def read_config(self):
        self.calls.append("config")
        if isinstance(self.config, Exception):
            raise self.config
        return self.config

    def test_explicit_locale_does_not_read_the_host(self):
        self.assertEqual(backend.tool_display_locale("zh-HK"), "zh-hant")
        self.assertEqual(self.calls, [])

    def test_profile_language_override_wins_without_reading_config(self):
        self.env = "fr-FR"
        self.assertEqual(backend.tool_display_locale(), "fr")
        self.assertEqual(self.calls, ["HERMES_LANGUAGE"])
        self.env = "pt-BR"
        self.assertEqual(backend.tool_display_locale(), "en", "an unsupported override must not fall through to Chinese config")

    def test_config_changes_are_read_again_and_empty_override_falls_through(self):
        self.env = ""
        self.assertEqual(backend.tool_display_locale(), "zh")
        self.config = {"display": {"language": "de-DE"}}
        self.assertEqual(backend.tool_display_locale(), "de")

    def test_unbound_scope_never_falls_back_to_another_profiles_environment(self):
        self.env = RuntimeError("No profile secret scope")
        self.config = {"display": {"language": "fr"}}
        with patch.dict(os.environ, {"HERMES_LANGUAGE": "zh"}):
            self.assertEqual(backend.tool_display_locale(), "fr")

    def test_existing_language_aliases_keep_their_translations(self):
        aliases = {"chinese": "zh", "mandarin": "zh", "traditional_chinese": "zh-hant",
                   "japanese": "ja", "jp": "ja", "deutsch": "de", "français": "fr", "france": "fr",
                   "español": "es", "русский": "ru", "العربية": "ar"}
        for value, expected in aliases.items():
            with self.subTest(value=value):
                self.config = {"display": {"language": value}}
                self.assertEqual(backend.tool_display_locale(), expected)

    def test_bad_host_config_keeps_the_original_conflict_details(self):
        result = {"status": 409, "applied": False, "error": {
            "code": "REVISION_CONFLICT", "message": "expected revision 1, current revision 2"},
            "recovery": {"action": "read_then_retry"}}
        for config in (None, [], {"display": []}, {"display": {"language": 123}}, RuntimeError("unavailable")):
            with self.subTest(config=config):
                self.config = config
                displayed = backend.present_agent_result(result)
                self.assertEqual(displayed["error"]["message"], backend._CONFLICT_TEXT["en"])
                self.assertEqual(displayed["error"]["detail"], result["error"]["message"])
                self.assertEqual(displayed["error"]["code"], "REVISION_CONFLICT")
                self.assertEqual(displayed["status"], 409)
                self.assertFalse(displayed["applied"])
                self.assertEqual(displayed["recovery"], result["recovery"])
                self.assertNotIn("user_summary", result, "presentation must not mutate the engine result")


if __name__ == "__main__":
    unittest.main()
