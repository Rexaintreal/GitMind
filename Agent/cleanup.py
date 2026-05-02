import os
path = "Agent/demo.py"
if os.path.exists(path):
    os.remove(path)
    print(f"Deleted {path}")
else:
    print(f"{path} not found")
