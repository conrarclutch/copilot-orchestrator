"""Dependency-free, read-only MCP integration probe over stdio.

This demonstrates the transport only. For production connector tools use the
official MCP Python SDK and wrap your existing functions; see PYTHON_INTEGRATION.md.
"""
import json
import sys


def respond(request):
    method = request.get("method")
    if method == "initialize":
        return {
            "protocolVersion": request.get("params", {}).get("protocolVersion", "2024-11-05"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "local-integration-probe", "version": "1.0.0"},
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [{
            "name": "integration_probe",
            "description": "Read-only local integration check. Returns the provided marker from Python.",
            "inputSchema": {"type": "object", "properties": {"marker": {"type": "string"}}, "required": ["marker"], "additionalProperties": False},
            "annotations": {"readOnlyHint": True, "openWorldHint": False},
        }]}
    if method == "tools/call":
        params = request.get("params", {})
        if params.get("name") != "integration_probe":
            raise ValueError("Unknown probe tool")
        marker = params.get("arguments", {}).get("marker")
        if not isinstance(marker, str) or len(marker) > 200:
            raise ValueError("marker must be a string of at most 200 characters")
        return {"content": [{"type": "text", "text": json.dumps({"marker": marker, "source": "python-mcp-probe"})}]}
    raise ValueError("Unsupported probe method")


for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    try:
        response = {"jsonrpc": "2.0", "id": request["id"], "result": respond(request)}
    except ValueError as error:
        response = {"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32602, "message": str(error)}}
    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()
