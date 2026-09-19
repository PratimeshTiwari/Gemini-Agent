"""
Drive the real CLI under a pty, waiting on *observed output* rather than a clock.

drive2.py pumped for a fixed number of seconds between steps, so pressing enter
to approve a diff could land before the prompt existed — a different code path
entirely. That is why identical code measured 1 clear on one run and 89 on the
next, and why three comparisons built on those numbers were noise.

Steps are now objects:
  {"wait": "<substring>"}   read until it appears (or fail loudly)
  {"send": "<keys>"}        write them
  {"quiet": ms}             read until nothing new arrives for ms
"""
import os, pty, sys, time, select, signal, json, subprocess, fcntl, termios, struct, re

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROWS, COLS, PORT = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
STEPS, WS, REPLIES = json.loads(sys.argv[4]), sys.argv[5], sys.argv[6]
DELAY = sys.argv[7] if len(sys.argv) > 7 else '300'

pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.environ['AGENT_CLI_HOME'] = os.path.join(WS, 'home')
    os.chdir(os.path.join(REPO, 'server'))
    os.execvp('npx', ['npx', 'tsx', 'src/main.js', '--workspace', WS,
                      '--port', str(PORT), '--no-github'])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
buf = b''
plain = lambda: re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', buf.decode('utf-8', 'replace'))

def read_once(t=0.2):
    global buf
    r, _, _ = select.select([fd], [], [], t)
    if not r: return False
    try: c = os.read(fd, 65536)
    except OSError: return False
    if not c: return False
    buf += c
    return True

def wait_for(text, timeout=45):
    end = time.time() + timeout
    while time.time() < end:
        if text in plain(): return True
        read_once()
    return False

def quiet(idle_ms=900, timeout=45):
    """Read until nothing new arrives for idle_ms."""
    end = time.time() + timeout
    last = time.time()
    while time.time() < end:
        if read_once(0.1): last = time.time()
        elif (time.time() - last) * 1000 >= idle_ms: return True
    return False

fails = []
# The prompt box is the CLI's "ready".
if not wait_for('Ask anything', 60): fails.append('CLI never drew its prompt')
fake = subprocess.Popen(['node', os.path.join(os.path.dirname(__file__), 'fake-extension.js'),
                         str(PORT), REPLIES, DELAY], stderr=subprocess.DEVNULL)
quiet(700)

marks = []
for step in STEPS:
    before = len(buf)
    if 'key' in step:
        # Named keys, so the caller never has to embed a raw escape byte.
        seq = {'up': '\x1b[A', 'down': '\x1b[B', 'esc': '\x1b',
               'enter': '\r', 'tab': '\t'}[step['key']]
        os.write(fd, seq.encode())
        # Drain while waiting, never `sleep`.
        #
        # A bare sleep leaves the pty's output buffer unread, and macOS gives
        # it only a few KB. The diff prompt redraws ~1.5KB per keypress, so
        # two keys in a row filled it, the child blocked inside `write()`
        # mid-render, and the next key was never handled — one `↓` moved the
        # cursor and the second did nothing. It reads as the app dropping a
        # keypress and it is the harness holding the pipe shut.
        quiet(250, timeout=5)
        label = 'key ' + step['key']
    elif 'send' in step:
        os.write(fd, step['send'].encode())
        # `quiet: 0` means "do not wait at all" — the spinner animates while a
        # turn runs, so waiting for silence there waits out the timeout and
        # turns a concurrency test into a sequential one.
        q = int(step.get('quiet', 900))
        if q > 0: quiet(q)
        else: time.sleep(0.9)  # a human's gap between prompts, not a paste
        label = repr(step['send'])
    elif 'seed' in step:
        # Write a file with an mtime in the past, before the CLI's own clock
        # started — which is how a leftover artifact from a previous session
        # looks on disk, and the only way to test that it is not shown.
        for name, body in step['seed'].items():
            at = os.path.join(WS, name)
            os.makedirs(os.path.dirname(at), exist_ok=True)
            with open(at, 'w') as fh:
                fh.write(body)
            old = time.time() - 86400
            os.utime(at, (old, old))
        label = 'seed ' + ','.join(step['seed'])
    elif 'touch' in step:
        # Drive the file watcher the only way it can be driven: move a file.
        # `chokidar` is watching the workspace, and the CLI turns each change
        # into a `[System Event]` turn — the thing that used to be counted as
        # work the agent did.
        for name in step['touch']:
            with open(os.path.join(WS, name), 'a') as fh:
                fh.write('x\n')
        time.sleep(float(step.get('settle', 1.5)))
        label = 'touch ' + ','.join(step['touch'])
    elif 'wait' in step:
        ok = wait_for(step['wait'], int(step.get('timeout', 45)))
        if not ok: fails.append(f"never saw {step['wait']!r}")
        label = f"wait {step['wait']!r} -> {ok}"
    seg = buf[before:]
    marks.append((label, seg.count(b'\x1b[2J'), seg.count(b'\x1b[3J')))

quiet(1200)
open(os.path.join(WS, 'out.txt'), 'w').write(buf.decode('utf-8', 'replace'))
os.kill(pid, signal.SIGKILL)
try: os.waitpid(pid, 0)
except Exception: pass
fake.kill()

for n, a, b in marks: print(f'  {n:34} 2J={a} 3J={b}')
print(f'TOTAL bytes={len(buf)} 2J={buf.count(b"\x1b[2J")} 3J={buf.count(b"\x1b[3J")}')
if fails: print('FAILED: ' + '; '.join(fails))
