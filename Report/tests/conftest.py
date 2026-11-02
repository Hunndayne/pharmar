import sys
from pathlib import Path

REPORT_DIR = str(Path(__file__).resolve().parents[1])
if REPORT_DIR not in sys.path:
    sys.path.insert(0, REPORT_DIR)
