"""Opt-in live test: Python bridge, MCP tools, attachments and durable events."""
import asyncio
import json
from pathlib import Path
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from examples.python_bridge.client import OrchestratorClient


async def main():
    base = ROOT / '.orchestrator' / ('public-integration-' + uuid.uuid4().hex)
    workspace = base / 'workspace'
    workspace.mkdir(parents=True)
    (workspace / 'README.md').write_text('Integration smoke workspace\n')
    for command in [
        ['git', 'init', '-q'],
        ['git', 'config', 'user.name', 'Integration Test'],
        ['git', 'config', 'user.email', 'test@example.invalid'],
        ['git', 'add', 'README.md'],
        ['git', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'test baseline'],
    ]:
        subprocess.run(command, cwd=workspace, check=True, capture_output=True)
    attachment_marker = 'ATTACHMENT_OK_' + uuid.uuid4().hex[:12]
    note = base / 'attachment.txt'
    note.write_text('The integration marker is ' + attachment_marker)
    config = base / 'mcp.local.json'
    config.write_text(json.dumps({'mcpServers': {'work-tools': {
        'type': 'stdio', 'command': sys.executable,
        'args': [str(ROOT / 'examples' / 'mcp_probe.py')],
        'tools': ['integration_probe'],
    }}}))
    data_dir = base / 'data'
    events = []
    async with OrchestratorClient(cwd=workspace, data_dir=data_dir, model='gpt-6-luna', mcp_config=config,
                                  events_after=0, event_queue_size=2048) as client:
        project = await client.request('project.create', {'title': 'Integration smoke', 'workspaceRoot': str(workspace)})
        project_id = project.get('project', project)['id']
        attachment = await client.request('attachment.import', {'path': str(note)})
        thread = await client.request('thread.create', {
            'projectId': project_id, 'title': 'Python and attachment bridge', 'runtimeMode': 'full-access',
            'prompt': 'Read the supplied attachment and report its exact integration marker. Also call the integration_probe MCP tool with marker MCP_PUBLIC_OK and report the source field returned by that tool. You must actually call the tool.',
            'attachments': [attachment],
        })
        waited = await client.request('thread.wait', {'threadId': thread['threadId'], 'runId': thread['runId'], 'timeoutMs': 120000}, timeout=150)
        assert not waited['timedOut'], waited
        read = await client.request('thread.read', {'threadId': thread['threadId'], 'view': 'activity', 'limit': 100})
        answers = '\n'.join(item.get('text') or '' for item in read['items'] if item['type'] == 'assistant_message')
        assert attachment_marker in answers, answers
        assert 'python-mcp-probe' in answers, answers
        tools = [item for item in read['items'] if item['type'] in ('tool_call', 'dynamic_tool') and 'integration_probe' in json.dumps(item)]
        assert any(item['status'] == 'completed' for item in tools), tools
        while True:
            try:
                event = await asyncio.wait_for(client.next_event(), .2)
                if isinstance(event.get('sequence'), int):
                    events.append(event)
            except asyncio.TimeoutError:
                break
        assert events and all(a['sequence'] < b['sequence'] for a, b in zip(events, events[1:]))
        cursor = events[0]['sequence']
    async with OrchestratorClient(cwd=workspace, data_dir=data_dir, model='gpt-6-luna', events_after=cursor,
                                  event_queue_size=2048) as resumed:
        await resumed.request('project.list')
        replayed = await asyncio.wait_for(resumed.next_event(), 20)
        assert replayed['sequence'] > cursor, replayed
        assert replayed['sequence'] == events[1]['sequence'], (replayed, events[:2])
        status = await resumed.request('thread.status', {'threadId': thread['threadId']})
        assert status['latestRun']['status'] == 'completed', status
    result = {'status': 'passed', 'pythonBridge': True, 'pythonMcpTool': True, 'attachmentReadByModel': True,
              'eventReplayAfterRestart': True, 'eventCount': len(events), 'workspace': str(workspace)}
    (base / 'summary.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    if '--run-live' not in sys.argv:
        print('Live inference is opt-in. Pass --run-live to exercise your Copilot account.')
    else:
        asyncio.run(main())
