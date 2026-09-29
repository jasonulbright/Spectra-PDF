"""Live process fixture; all descendants should belong to the launching job."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

child = subprocess.Popen(
    [sys.executable, "-B", "-c", "import subprocess,sys,time,os,json; p=subprocess.Popen([sys.executable,'-B','-c','import time; time.sleep(120)']); print(json.dumps([os.getpid(),p.pid]),flush=True); time.sleep(120)"],
    stdout=subprocess.PIPE,
    text=True,
)
descendants = json.loads(child.stdout.readline())
# A reader polls for the receipt; it appears whole or not at all.
receipt = Path(sys.argv[1])
pending = receipt.with_name(receipt.name + ".pending")
pending.write_text(json.dumps([os.getpid(), *descendants]))
os.replace(pending, receipt)
print(json.dumps(sys.argv[3:]), flush=True)
if sys.argv[2] == "exit":
    sys.exit(3)
time.sleep(120)
