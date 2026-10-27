"""Visual-order fallback for RTL text when Pillow has no raqm (run: python3 test/compose_rtl_test.py)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "render", "v2"))
import compose  # noqa: E402

compose.RAQM = False
SHALOM, OLAM = "שלום", "עולם"
rev = lambda s: s[::-1]

cases = [
    ("Hello world", "Hello world"),
    (f"{SHALOM} {OLAM}", f"{rev(OLAM)} {rev(SHALOM)}"),
    (f"{SHALOM} {OLAM} 2026", f"2026 {rev(OLAM)} {rev(SHALOM)}"),
    (f"POV39 {SHALOM}", f"{rev(SHALOM)} POV39"),
    (f"{SHALOM} POV39 {OLAM}", f"{rev(OLAM)} POV39 {rev(SHALOM)}"),
]
failed = 0
for logical, expected in cases:
    got = compose.visual(logical)
    ok = got == expected
    failed += not ok
    print(("ok  " if ok else "FAIL"), ascii(logical), "->", ascii(got), "" if ok else f"expected {ascii(expected)}")
sys.exit(1 if failed else 0)
