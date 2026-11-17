"""Negative acceptance checks for the checked-in offline evidence."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("rtos_fixture_build", HERE / "build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class FixtureEvidenceTests(unittest.TestCase):
    def sample(self, name):
        return ((HERE / "samples" / (name + ".bin")).read_bytes(),
                json.loads((HERE / "samples" / (name + ".json")).read_text(encoding="utf-8")))

    def test_all_checked_in_samples_satisfy_independent_oracle(self):
        for name in ("continuous", "continuous-overflow", "single-shot", "single-shot-overflow", "post-mortem"):
            with self.subTest(name=name):
                build.verify_sample(*self.sample(name))

    def test_packet_corruption_fails_even_without_hash(self):
        data, meta = self.sample("continuous")
        meta.pop("sha256")
        damaged = bytearray(data)
        damaged[meta["checks"][0]["offset"] + 1] ^= 1
        with self.assertRaises(AssertionError):
            build.verify_sample(bytes(damaged), meta)

    def test_missing_manual_packet_coverage_is_rejected(self):
        data, meta = self.sample("continuous")
        meta["checks"] = []
        with self.assertRaises(AssertionError):
            build.verify_sample(data, meta)

    def test_unfrozen_or_still_recording_buffer_is_rejected(self):
        data, meta = self.sample("single-shot")
        for field, value in (("frozen", False), ("stateAfterStop", 1)):
            invalid = copy.deepcopy(meta)
            invalid[field] = value
            with self.subTest(field=field), self.assertRaises(AssertionError):
                build.verify_sample(data, invalid)

    def test_truncated_post_mortem_is_rejected_without_hash(self):
        data, meta = self.sample("post-mortem")
        meta.pop("sha256")
        with self.assertRaises(AssertionError):
            build.verify_sample(data[:-1], meta)

    def test_overflow_cannot_be_relabelled_complete(self):
        data, meta = self.sample("single-shot-overflow")
        meta["integrity"] = "complete"
        with self.assertRaises(AssertionError):
            build.verify_sample(data, meta)

    def test_vendor_mutation_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "vendor").mkdir()
            (root / "vendor/file.c").write_bytes(b"original")
            manifest = {"files": [{"path": "file.c", "bytes": 8, "sha256": build.digest(b"original")}]}
            (root / "vendor-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            with patch.object(build, "HERE", root):
                self.assertEqual(build.verify_vendor(), 1)
                (root / "vendor/file.c").write_bytes(b"tampered")
                with self.assertRaises(AssertionError):
                    build.verify_vendor()


if __name__ == "__main__":
    unittest.main()
