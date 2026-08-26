// Minimal CDP driver: boots headless Chrome, loads a page, collects console
// errors, and can evaluate expressions. No dependencies.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

export async function launch() {
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=/tmp/claude-501/chrome-profile',
    '--window-size=1440,1000', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); return proc; } catch { await sleep(250); }
  }
  throw new Error('chrome did not start');
}

/**
 * @param opts.fresh  wipe this origin's storage and reload, so the tab behaves
 *   like a device that has never visited. Tabs share one browser profile, so
 *   without this a "second phone" silently inherits the first one's
 *   localStorage — and a test of the returning-student path would pass for
 *   entirely the wrong reason.
 */
export async function openPage(url, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });

  let id = 0;
  const pending = new Map();
  const logs = [];
  const navigations = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.consoleAPICalled')
      logs.push({ type: msg.params.type, text: msg.params.args.map(a => a.value ?? a.description ?? JSON.stringify(a.preview ?? '')).join(' ') });
    if (msg.method === 'Runtime.exceptionThrown')
      logs.push({ type: 'exception', text: msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text });
    // Track top-level navigations. Asserting "the page reloaded" by evaluating
    // in the new document is unreliable — the old context is already gone —
    // so the event itself is the evidence.
    if (msg.method === 'Page.frameNavigated' && !msg.params.frame.parentId) {
      navigations.push(msg.params.frame.url);
    }
    if (msg.method === 'Log.entryAdded')
      logs.push({ type: msg.params.entry.level, text: msg.params.entry.text });
    // Headless blocks on confirm()/alert() until someone answers it. The
    // student flow raises one ("no photo — skip it?"), so accept every dialog.
    if (msg.method === 'Page.javascriptDialogOpening') {
      logs.push({ type: 'dialog', text: msg.params.message });
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    }
  };
  // Every call gets a deadline. A page that navigates mid-test destroys the
  // execution context an in-flight evaluate was addressed to, and the reply
  // simply never arrives — which stalls the whole run instead of failing it.
  const send = (method, params = {}, timeoutMs = 15000) =>
    new Promise((ok, bad) => {
      const n = ++id;
      const timer = setTimeout(() => {
        pending.delete(n);
        bad(new Error(`CDP timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      pending.set(n, (msg) => { clearTimeout(timer); ok(msg); });
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result?.result?.value;
  };
  const screenshot = async (path) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, Buffer.from(r.result.data, 'base64'));
    return path;
  };
  // The app no longer uses native prompt()/confirm(), so the dialog handler
  // above never fires for it. Auto-accepting its in-page dialogs keeps the
  // existing tests meaning what they meant before: "the user said yes".
  // Installed on every new document so it survives reloads and navigations.
  if (opts.autoDialog !== false) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (() => {
          const accept = () => {
            for (const d of document.querySelectorAll('dialog.app-dialog[open]')) {
              d.querySelector('[data-ok]')?.click();
            }
          };
          // Observe the Document node, not documentElement: this script runs
          // before the page's own, at which point <html> may not exist yet and
          // observe(null) throws, killing the whole installer silently.
          new MutationObserver(accept).observe(document, {
            childList: true, subtree: true, attributes: true, attributeFilter: ['open'],
          });
          setInterval(accept, 120);
        })();`,
    });
    await send('Page.reload', { ignoreCache: false });
    await new Promise((r) => setTimeout(r, 400));
    logs.length = 0;
  }

  if (opts.fresh) {
    await evaluate('try { localStorage.clear(); sessionStorage.clear(); } catch {} ');
    await send('Page.reload', { ignoreCache: true });
    logs.length = 0;
  }

  return { send, evaluate, logs, navigations, screenshot, close: () => ws.close(), targetId: target.id };
}

export function errors(logs) {
  return logs.filter(l => l.type === 'error' || l.type === 'exception');
}
