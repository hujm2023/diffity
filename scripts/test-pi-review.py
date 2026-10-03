#!/usr/bin/env python3
"""Real Pi + scoped MCP + SSH verification using a simulated local model and disposable worktrees."""
import json, re, os, pathlib, pwd, shutil, socket, subprocess, tempfile, threading, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import argparse
parser=argparse.ArgumentParser(description='Isolated Pi/SSH/MCP integration; uses a local simulated model and no real provider credentials')
parser.add_argument('--sudo', action='store_true', help='Run only the temporary loopback sshd with existing noninteractive sudo access')
args=parser.parse_args()
root=pathlib.Path(__file__).resolve().parents[1]
cargo=os.environ.get('DIFFITY_TEST_CARGO') or shutil.which('cargo')
if not cargo or not shutil.which('pi') or not shutil.which('node'):
    raise SystemExit('This test requires Cargo, Node.js and Pi 0.99.2+ on PATH')
sshd=shutil.which('sshd') or '/usr/sbin/sshd'
privileged=[] if os.geteuid()==0 else ['sudo','-n'] if args.sudo else None
if privileged is None:
    raise SystemExit('Use --sudo to authorize a temporary loopback sshd, or run the harness in a disposable root-owned test container')
fixture=pathlib.Path(tempfile.mkdtemp(prefix='diffity-pi-ssh-'))
server_process=None; requests=[]; failure=[]
class Model(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_POST(self):
        payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])));requests.append(payload)
        names=[item['function']['name'] for item in payload.get('tools',[])]
        step=len(requests)
        if any(name in names for name in ['write','edit','bash','codemode']):
            failure.append({'unsafe_tools':names})
        if step<=4 or step in (6,7):
            if step==1:
                name='read';args={'path':str(fixture/'outside.txt')}
            elif step==2:
                name='read';args={'path':'tracked.txt'}
            elif step==6:
                name=next((value for value in names if value.endswith('__list_threads')),None);args={}
            elif step==7:
                name=next((value for value in names if value.endswith('__reply')),None)
                content=next(message.get('content','') for message in reversed(payload['messages']) if message.get('role')=='tool')
                match=re.search(r'"id"\s*:\s*"([a-f0-9-]{36})"',str(content))
                if not match:raise RuntimeError('No scoped thread ID in list_threads result')
                args={'threadId':match.group(1),'body':'Fixture reply from read-only Pi'}
            else:
                suffix='__get_diff' if step==3 else '__add_comment'
                name=next((value for value in names if value.endswith(suffix)),None)
                args={} if step==3 else {'file':'tracked.txt','startLine':1,'body':'Fixture finding from remote Pi','severity':'suggestion'}
            if not name:
                failure.append({'missing_tool':step,'declared':names})
                self.send_response(500);self.end_headers();self.wfile.write(b'Fixture tool not declared');return
            delta={'role':'assistant','tool_calls':[{'index':0,'id':'fixture-'+str(step),'type':'function','function':{'name':name,'arguments':json.dumps(args)}}]}
            reason='tool_calls'
        else:
            delta={'role':'assistant','content':'Remote Pi review complete.'};reason='stop'
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Connection','close');self.end_headers()
        for body in [{'id':'fixture','object':'chat.completion.chunk','created':1,'model':'remote-review-model','choices':[{'index':0,'delta':delta,'finish_reason':None}]},{'id':'fixture','object':'chat.completion.chunk','created':1,'model':'remote-review-model','choices':[{'index':0,'delta':{},'finish_reason':reason}]}]:
            self.wfile.write(('data: '+json.dumps(body)+'\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
model=ThreadingHTTPServer(('127.0.0.1',0),Model);threading.Thread(target=model.serve_forever,daemon=True).start()
try:
    (fixture/'outside.txt').write_text('DO_NOT_SEND_OUTSIDE_PROJECT')
    repo=fixture/'repo';repo.mkdir()
    def git(*args):return subprocess.check_output(['git','-C',str(repo),*args],stderr=subprocess.DEVNULL)
    git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.test')
    (repo/'.gitignore').write_text('.worktrees/\n');(repo/'tracked.txt').write_text('original\n');git('add','.');git('commit','-m','Fixture')
    worktree=repo/'.worktrees'/'remote-task';git('worktree','add','-b','remote-task',str(worktree));(worktree/'tracked.txt').write_text('remote changed\n')
    config_dir=fixture/'remote-pi';config_dir.mkdir()
    (config_dir/'settings.json').write_text(json.dumps({'defaultProvider':'fixture','defaultModel':'remote-review-model','defaultThinkingLevel':'off'}))
    (config_dir/'models.json').write_text(json.dumps({'providers':{'fixture':{'baseUrl':f'http://127.0.0.1:{model.server_address[1]}/v1','api':'openai-completions','apiKey':'fixture-not-a-secret','models':[{'id':'remote-review-model','name':'Remote fixture model','reasoning':False,'input':['text'],'contextWindow':32768,'maxTokens':4096,'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0}}]}}}))
    claude_fixture=fixture/'claude-agent-acp'
    claude_fixture.write_text((root/'tests/fixtures/review-acp.mjs').read_text());claude_fixture.chmod(0o755)
    marker=fixture/'agent-marker.json'
    real_pi=shutil.which('pi')
    pi_wrapper=fixture/'pi-wrapper'
    wrapper_source = '#!/usr/bin/env python3\nimport os,json,sys\nfrom pathlib import Path\n'
    wrapper_source += 'if "--version" not in sys.argv:\n'
    wrapper_source += ' servers=json.loads(os.environ.get("DIFFITY_PI_MCP_SERVERS","[]"))\n'
    wrapper_source += ' data={"pid":os.getpid(),"cwd":os.getcwd(),"config":os.environ.get("PI_CODING_AGENT_DIR"),"mcpScript":(servers[0].get("args") or [""])[0] if servers else ""}\n'
    wrapper_source += ' Path(' + repr(str(marker)) + ').write_text(json.dumps(data))\n'
    wrapper_source += 'os.execv(' + repr(real_pi) + ', [' + repr(real_pi) + '] + sys.argv[1:])\n'
    pi_wrapper.write_text(wrapper_source.replace('\\n','\n'));pi_wrapper.chmod(0o755)
    local_config=fixture/'desktop-pi';local_config.mkdir();(local_config/'settings.json').write_text(json.dumps({'defaultProvider':'unconfigured-desktop','defaultModel':'wrong-local-model'}))
    for name in ['host_key','client_key']:subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(fixture/name)],check=True)
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    login=pwd.getpwuid(os.getuid()).pw_name
    node_dir=pathlib.Path(shutil.which('node')).parent
    pi_dir=pathlib.Path(shutil.which('pi')).parent
    sshd_config=fixture/'sshd_config'
    sshd_config.write_text(f'Port {port}\nListenAddress 127.0.0.1\nHostKey {fixture}/host_key\nPidFile {fixture}/sshd.pid\nAuthorizedKeysFile {fixture}/client_key.pub\nStrictModes no\nAllowUsers {login}\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM yes\nSetEnv PI_CODING_AGENT_DIR={config_dir} PI_CODING_AGENT_SESSION_DIR={config_dir}/sessions PATH={node_dir}:{pi_dir}:/usr/bin:/bin\nLogLevel ERROR\n')
    log=open(fixture/'sshd.log','w');server_process=subprocess.Popen(privileged+[sshd,'-D','-e','-f',str(sshd_config)],stdout=subprocess.DEVNULL,stderr=log)
    public=(fixture/'host_key.pub').read_text().split();(fixture/'known_hosts').write_text(f'[127.0.0.1]:{port} {public[0]} {public[1]}\n')
    ssh_config=fixture/'ssh_config';ssh_config.write_text(f'Host pi-fixture\n HostName 127.0.0.1\n Port {port}\n User {login}\n IdentityFile {fixture}/client_key\n UserKnownHostsFile {fixture}/known_hosts\n IdentitiesOnly yes\n')
    (fixture/'bin').mkdir();wrapper=fixture/'bin'/'ssh';wrapper.write_text(f'#!/bin/sh\nexec /usr/bin/ssh -F "{ssh_config}" "$@"\n');wrapper.chmod(0o755)
    for attempt in range(30):
        if server_process.poll() is not None:raise RuntimeError((fixture/'sshd.log').read_text())
        probe=subprocess.run(['/usr/bin/ssh','-F',str(ssh_config),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','pi-fixture','true'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        if probe.returncode==0:break
        time.sleep(0.1)
    else:raise RuntimeError('SSH fixture did not start')
    env=dict(os.environ,PI_CODING_AGENT_DIR=str(local_config),DIFFITY_AGENT_TEST_CLAUDE_BINARY=str(claude_fixture),DIFFITY_AGENT_TEST_PI_BINARY=str(pi_wrapper),DIFFITY_AGENT_TEST_REPO='ssh://pi-fixture/'+urllib.parse.quote(str(worktree).lstrip('/')),PATH=str(fixture/'bin')+':'+os.environ['PATH'])
    for name in list(env):
        if name.endswith('_API_KEY'):env.pop(name)
    metadata=repo/'.git'
    def snapshot():return {str(p.relative_to(metadata)):(p.read_bytes(),p.stat().st_mtime_ns) for p in metadata.rglob('*') if p.is_file()}
    before=snapshot()
    subprocess.run([cargo,'test','--manifest-path',str(root/'src-tauri/Cargo.toml'),'--features','mcp','--test','pi_review','-j','2','--','--nocapture'],env=env,check=True)
    assert snapshot()==before,'Agent review modified Git metadata'
    assert (worktree/'tracked.txt').read_text()=='remote changed\n','Agent review modified code'
    assert requests and all(request['model']=='remote-review-model' for request in requests),'Agent did not use remote Pi model configuration'
    assert not failure,failure
    assert all('DO_NOT_SEND_OUTSIDE_PROJECT' not in json.dumps(request) for request in requests),'Pi read escaped the project boundary'
    record=json.loads(marker.read_text())
    assert record['cwd']==str(worktree),'Agent used the wrong working directory'
    assert record['config']==str(config_dir),'Agent loaded desktop provider credentials/config'
    support_dir=pathlib.Path(record['mcpScript']).parent
    assert record['mcpScript'].endswith('/agent-mcp.py'),'Agent used a desktop MCP endpoint'
    for attempt in range(40):
        try:os.kill(record['pid'],0);alive=True
        except ProcessLookupError:alive=False
        if not alive and not support_dir.exists():break
        time.sleep(0.1)
    assert not alive,'Agent process leaked after deleting the chat'
    assert not support_dir.exists(),'Remote temporary support directory leaked'
    before_local=snapshot()
    env['DIFFITY_AGENT_TEST_REPO']=str(worktree)
    env['PI_CODING_AGENT_DIR']=str(config_dir)
    requests.clear()
    subprocess.run([cargo,'test','--manifest-path',str(root/'src-tauri/Cargo.toml'),'--features','mcp','--test','pi_review','-j','2','--','--nocapture'],env=env,check=True)
    assert snapshot()==before_local,'Local Pi review modified Git metadata'
    assert (worktree/'tracked.txt').read_text()=='remote changed\n'
    assert requests and all(request['model']=='remote-review-model' for request in requests)
    assert all('DO_NOT_SEND_OUTSIDE_PROJECT' not in json.dumps(request) for request in requests)
    print(json.dumps({'status':'passed','real_pi_version':'0.99.2','model_requests':len(requests),'model_from_remote_config':True,'comment_author':'Pi','git_and_source_unchanged':True,'external_model_requests':0}))
except Exception:
    print(json.dumps({'fixture_model_requests':len(requests),'fixture_failures':failure}));raise
finally:
    model.shutdown();model.server_close()
    if server_process is not None and server_process.poll() is None:
        subprocess.run(privileged+['kill','-TERM',str(server_process.pid)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:server_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            subprocess.run(privileged+['kill','-KILL',str(server_process.pid)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);server_process.wait(timeout=5)
    shutil.rmtree(fixture)
