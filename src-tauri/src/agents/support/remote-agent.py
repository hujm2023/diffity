"""SSH-only agent/stdio-MCP multiplexer. Creates private temporary support files, then removes them."""
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading

config = json.loads(sys.stdin.readline())
directory = Path(tempfile.mkdtemp(prefix="diffity-agent-", dir="/tmp"))
os.chmod(directory, 0o700)
output_lock = threading.Lock()
connections, connection_lock = {}, threading.Lock()
child = None
listener = None

def emit(packet):
    with output_lock:
        sys.stdout.write(json.dumps(packet) + "\n")
        sys.stdout.flush()

def pipe_agent():
    for line in child.stdout:
        try:
            emit({"kind": "agent", "packet": json.loads(line)})
        except ValueError:
            emit({"kind": "error", "message": "Agent emitted invalid JSON protocol output"})
            break
    emit({"kind": "exit", "code": child.wait()})

def pipe_stderr():
    for line in child.stderr:
        emit({"kind": "stderr", "text": line.decode("utf-8", "replace")})

def mcp_connection(connection):
    channel = None
    try:
        stream = connection.makefile("rb")
        channel = json.loads(stream.readline())["channel"]
        with connection_lock:
            connections[channel] = connection
        for line in stream:
            emit({"kind": "mcp", "channel": channel, "packet": json.loads(line)})
    finally:
        with connection_lock:
            if connections.get(channel) is connection:
                connections.pop(channel, None)
        connection.close()
        if channel:
            emit({"kind": "mcp_closed", "channel": channel})

def accept_mcp():
    while True:
        try:
            connection, _ = listener.accept()
        except OSError:
            return
        threading.Thread(target=mcp_connection, args=(connection,), daemon=True).start()

try:
    for name, source in config["files"].items():
        if name not in {"agent-mcp.py", "pi-acp.mjs", "pi-extension.mjs"}:
            raise ValueError("Unsupported agent support file")
        (directory / name).write_text(source)
    socket_path = str(directory / "mcp.sock")
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(socket_path)
    os.chmod(socket_path, 0o600)
    listener.listen(16)
    threading.Thread(target=accept_mcp, daemon=True).start()
    launch = config["launch"]
    env = dict(os.environ)
    env.update(dict(launch.get("env") or []))
    # Binary discovery supplies remote paths only. Never inherit the desktop's provider credentials.
    bins = [str(Path(launch["command"]).parent)]
    if config.get("piBinary"):
        env["DIFFITY_PI_BINARY"] = config["piBinary"]
        bins.append(str(Path(config["piBinary"]).parent))
    env["PATH"] = os.pathsep.join(bins + [env.get("PATH", "")])
    command = [launch["command"]] + launch.get("args", [])
    if config.get("piBinary"):
        command = [launch["command"], str(directory / "pi-acp.mjs")]
    child = subprocess.Popen(command, cwd=config["cwd"], env=env, stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    emit({"kind": "ready", "directory": str(directory), "socket": socket_path, "python": sys.executable})
    threading.Thread(target=pipe_agent, daemon=True).start()
    threading.Thread(target=pipe_stderr, daemon=True).start()
    for line in sys.stdin:
        message = json.loads(line)
        if message["kind"] == "close":
            break
        if message["kind"] == "agent":
            child.stdin.write((json.dumps(message["packet"]) + "\n").encode())
            child.stdin.flush()
        elif message["kind"] == "mcp":
            with connection_lock:
                connection = connections.get(message["channel"])
            if connection:
                connection.sendall((json.dumps(message["packet"]) + "\n").encode())
        elif message["kind"] == "mcp_closed":
            with connection_lock:
                connection = connections.pop(message["channel"], None)
            if connection:
                connection.shutdown(socket.SHUT_RDWR)
                connection.close()
except (OSError, ValueError, KeyError) as error:
    emit({"kind": "error", "message": str(error)})
finally:
    if child:
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        except ProcessLookupError:
            pass
    if listener:
        listener.close()
    with connection_lock:
        for connection in connections.values():
            try:
                connection.close()
            except OSError:
                pass
    shutil.rmtree(directory)
