"""Remote stdio MCP endpoint; all packets go to a scoped local MCP sidecar over SSH."""
import json
import os
import socket
import sys
import threading

channel, socket_path = sys.argv[1:3]
connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
connection.connect(socket_path)
connection.sendall((json.dumps({"channel": channel}) + "\n").encode())

def responses():
    try:
        for line in connection.makefile("rb"):
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
    finally:
        try:
            connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        os._exit(0)

thread = threading.Thread(target=responses, daemon=True)
thread.start()
try:
    for line in sys.stdin.buffer:
        packet = json.loads(line)
        connection.sendall((json.dumps(packet) + "\n").encode())
finally:
    connection.close()
