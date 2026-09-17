import json,subprocess,uuid
IMAGE='python@sha256:b64631e04e4920160c50fbe8d8df828f7f35f06f425cb44aa09bca53e708a35a'
def execute(code,timeout=8):
 name='routetok-eval-'+uuid.uuid4().hex
 cmd=['docker','run','--name',name,'--rm','-i','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','65534:65534','--memory','128m','--memory-swap','128m','--cpus','.5','--pids-limit','16','--ulimit','nofile=64:64','--ulimit','fsize=1048576:1048576','--log-driver','none','--tmpfs','/tmp:rw,noexec,nosuid,size=8m',IMAGE,'python','-I','-B','-']
 # Discard generated-program output: prevents memory/log flooding. Exit code is test verdict.
 try:
  r=subprocess.run(cmd,input=code.encode(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=timeout)
  return {'pass':r.returncode==0,'exitCode':r.returncode,'timeout':False}
 except subprocess.TimeoutExpired:return {'pass':False,'exitCode':None,'timeout':True}
 finally:subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
if __name__=='__main__':
 checks={'works':execute('assert 2+2==4'),'assertion':execute('assert False'),'network':execute("import socket\ns=socket.socket()\ns.settimeout(.2)\ntry: s.connect(('1.1.1.1',443))\nexcept OSError: pass\nelse: raise AssertionError('network available')"),'readonly':execute("try: open('/host-secret','w')\nexcept OSError: pass\nelse: raise AssertionError('writable root')"),'timeout':execute('while True: pass',2)}
 assert checks['works']['pass'] and not checks['assertion']['pass'] and checks['network']['pass'] and checks['readonly']['pass'] and checks['timeout']['timeout'];print(json.dumps(checks))
