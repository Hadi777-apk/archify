import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChromeVisualBrowser, findChrome } from '../archify/bin/visual-check.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'archify');
const chromeConfigured = Object.prototype.hasOwnProperty.call(process.env, 'ARCHIFY_CHROME');
const chrome = chromeConfigured ? findChrome() : null;
if (chromeConfigured && !chrome) {
  throw new Error(`ARCHIFY_CHROME does not resolve to an executable browser: ${process.env.ARCHIFY_CHROME}`);
}

test('Classic tree branches collapse in place, follow the keyboard, reveal selections, and export complete', {
  skip: chrome ? false : 'Set ARCHIFY_CHROME to run real-browser tree checks.',
}, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-tree-browser-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  // Verified evidence on root, branch and leaf stays available without adding
  // source badges or mutating node accessibility labels.
  const git = (...args) => execFileSync('git', ['-C', scratch, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  fs.writeFileSync(path.join(scratch, 'source.js'), 'export const source = true;\n');
  git('init');
  git('config', 'user.name', 'Archify Tests');
  git('config', 'user.email', 'archify@example.test');
  git('add', 'source.js');
  git('commit', '-m', 'source fixture');
  git('remote', 'add', 'origin', 'https://github.com/example/evidence-repo');
  const render = (example, name) => {
    const output = path.join(scratch, name);
    const diagram = JSON.parse(fs.readFileSync(path.join(skillRoot, 'examples', example), 'utf8'));
    // These checks pin the fixed elbow tree; the mind map has its own test.
    diagram.layout = { ...diagram.layout, style: 'classic' };
    diagram.meta.repository = { url: 'https://github.com/example/evidence-repo', revision: git('rev-parse', 'HEAD') };
    diagram.nodes.forEach((node) => { node.sources = [{ path: 'source.js', line: 1 }]; });
    const input = path.join(scratch, name + '.json');
    fs.writeFileSync(input, JSON.stringify(diagram));
    execFileSync(process.execPath, [path.join(skillRoot, 'bin/archify.mjs'), 'render', 'tree', input, output, '--repo-root', scratch]);
    return output;
  };
  const small = render('payment-platform.tree.json', 'small.html');
  const large = render('archify-repository.tree.json', 'large.html');
  // Private export hook in this disposable copy only, as in export-cleanup-browser.
  const html = fs.readFileSync(small, 'utf8');
  const hooked = html.replace('      function download(blob, filename) {',
    '      window.treeExportTest = { serialize: serializeSvg, clean: cleanExportClone };\n      function download(blob, filename) {');
  assert.notEqual(hooked, html, 'export hook anchor');
  fs.writeFileSync(small, hooked);

  const browser = new ChromeVisualBrowser(chrome);
  t.after(() => browser.close());
  const session = await browser.sessionPromise;
  const send = (method, params = {}) => browser.cdp.send(method, params, session);
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  async function run(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    return result.result?.value;
  }
  let loadCount = 0;
  async function load(file, hash = '', theme = 'light') {
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
    await send('Page.navigate', { url: pathToFileURL(file).href + '?theme=' + theme + '&load=' + ++loadCount + hash });
    await loaded;
    await run('document.fonts.ready');
    await run('Archify.viewerChromeLayout.whenStable()');
  }
  async function key(name, code, windowsVirtualKeyCode) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode });
  }
  const box = (id) => `(() => { const r = document.querySelector('[data-node-id="${id}"] > rect.c-mask').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; })()`;

  await load(small);
  assert.equal(await run('Archify.treeBranches.active'), true);
  async function checkSources() {
    assert.equal(await run(`document.querySelectorAll('[data-source-evidence-beacon]').length`), 0);
    assert.deepEqual(await run(`['platform', 'payments', 'card_payment'].map(id => Archify.sourceEvidence.node(id).map(source => source.path))`), [['source.js'], ['source.js'], ['source.js']]);
    assert.deepEqual(await run(`['platform', 'payments', 'card_payment'].map(id => document.querySelector('[data-node-id="' + id + '"]').getAttribute('data-source-evidence-count'))`), ['1', '1', '1']);
  }
  await checkSources();
  const before = await run(box('operations'));
  const started = await run('performance.now()');
  await run(`document.querySelector('[data-tree-toggle="payments"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  const elapsed = (await run('performance.now()')) - started;
  const collapsed = await run(`(() => ({
    hidden: [...document.querySelectorAll('[data-node-id][data-tree-hidden]')].map((n) => n.getAttribute('data-node-id')),
    hiddenEdges: document.querySelectorAll('[data-edge-to][data-tree-hidden]').length,
    expanded: document.querySelector('[data-tree-toggle="payments"]').getAttribute('aria-expanded'),
    label: document.querySelector('[data-tree-toggle="payments"]').getAttribute('aria-label'),
    stacked: document.querySelector('[data-node-id="payments"]').hasAttribute('data-tree-collapsed'),
    expandAll: getComputedStyle(document.querySelector('[data-tree-expand-all]')).display,
  }))()`);
  assert.deepEqual(collapsed.hidden, ['card_payment', 'wallet_payment']);
  assert.equal(collapsed.hiddenEdges, 2);
  assert.equal(collapsed.expanded, 'false');
  assert.equal(collapsed.label, 'Expand Payments (2 hidden)');
  assert.equal(collapsed.stacked, true);
  assert.notEqual(collapsed.expandAll, 'none');
  // Collapsing never moves what stays visible.
  assert.deepEqual(await run(box('operations')), before);
  assert.ok(elapsed < 50, `collapse took ${elapsed}ms`);

  // Keyboard: Enter on the toggle restores the branch and keeps focus there;
  // ArrowLeft on a branch node collapses it, ArrowRight expands it.
  await run(`document.querySelector('[data-tree-toggle="payments"]').focus()`);
  await key('Enter', 'Enter', 13);
  assert.deepEqual(await run('Archify.treeBranches.collapsedIds()'), []);
  assert.equal(await run(`document.activeElement.getAttribute('data-tree-toggle')`), 'payments');
  await run(`document.querySelector('[data-node-id="orders"]').focus()`);
  await key('ArrowLeft', 'ArrowLeft', 37);
  assert.deepEqual(await run('Archify.treeBranches.collapsedIds()'), ['orders']);
  await key('ArrowRight', 'ArrowRight', 39);
  assert.deepEqual(await run('Archify.treeBranches.collapsedIds()'), []);

  // A selection through the shared focus path reveals a hidden node.
  await run(`Archify.treeBranches.collapse('platform')`);
  assert.equal(await run(`document.querySelector('[data-node-id="refunds"]').hasAttribute('data-tree-hidden')`), true);
  await run(`Archify.focus.set('refunds')`);
  assert.deepEqual(await run('Archify.treeBranches.collapsedIds()'), []);
  assert.equal(await run(`document.querySelector('[data-node-id="refunds"]').hasAttribute('data-tree-hidden')`), false);

  // Export is always the complete hierarchy, and the live view keeps its state.
  await run(`Archify.treeBranches.collapse('operations'); Archify.treeBranches.collapse('platform')`);
  const exported = await run(`(() => {
    const clone = document.querySelector('.diagram-container > svg').cloneNode(true);
    const clean = treeExportTest.clean(clone);
    return { clean, hidden: clone.querySelectorAll('[data-tree-hidden], [data-tree-collapsed]').length,
      any: clone.hasAttribute('data-tree-any-collapsed'),
      collapsedToggles: clone.querySelectorAll('[data-tree-toggle][aria-expanded="false"]').length,
      nodes: clone.querySelectorAll('[data-node-id]').length };
  })()`);
  assert.deepEqual(exported, { clean: true, hidden: 0, any: false, collapsedToggles: 0, nodes: 10 });
  assert.deepEqual((await run('Archify.treeBranches.collapsedIds()')).sort(), ['operations', 'platform']);

  // Expand all restores the authored hierarchy.
  await run(`document.querySelector('[data-tree-expand-all]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  assert.deepEqual(await run('Archify.treeBranches.collapsedIds()'), []);
  assert.equal(await run(`document.querySelectorAll('[data-tree-hidden]').length`), 0);

  // An authored collapsed branch starts collapsed in the Viewer.
  await load(large);
  assert.deepEqual(await run('Archify.treeBranches.collapsedIds()'), ['viewer']);
  assert.equal(await run(`document.querySelector('[data-node-id="v_tree"]').hasAttribute('data-tree-hidden')`), true);

  // Initial shared links reveal the authored collapsed ancestors before focus
  // measures the node. Hash updates use an internal setter, as do multi-selects.
  await load(large, '#focus=v_tree');
  assert.deepEqual(await run('Archify.treeBranches.collapsedIds()'), []);
  assert.equal(await run('Archify.focus.active()'), 'v_tree');
  assert.equal(await run(`document.querySelector('[data-node-id="v_tree"]').getBoundingClientRect().width > 0`), true);
  assert.equal(await run(`document.getElementById('focus-chip').hidden`), false);
  await run(`Archify.treeBranches.collapse('viewer'); location.hash = 'focus=v_focus'`);
  await run(`new Promise(resolve => setTimeout(resolve, 50))`);
  assert.equal(await run('Archify.focus.active()'), 'v_focus');
  assert.deepEqual(await run('Archify.treeBranches.collapsedIds()'), []);
  await run(`Archify.treeBranches.collapse('viewer'); Archify.focus.setMany(['v_tree', 'v_focus'])`);
  assert.deepEqual(await run('Archify.treeBranches.collapsedIds()'), []);

  await load(small, '', 'dark');
  await checkSources();
});

test('Mind map branches reflow, glide, focus the camera, and export complete', {
  skip: chrome ? false : 'Set ARCHIFY_CHROME to run real-browser tree checks.',
}, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-mindmap-browser-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const output = path.join(scratch, 'mindmap.html');
  execFileSync(process.execPath, [path.join(skillRoot, 'bin/archify.mjs'), 'render', 'tree', path.join(skillRoot, 'examples', 'payment-platform.tree.json'), output]);
  const html = fs.readFileSync(output, 'utf8');
  const hooked = html.replace('      function download(blob, filename) {',
    '      window.treeExportTest = { clean: cleanExportClone };\n      function download(blob, filename) {');
  assert.notEqual(hooked, html, 'export hook anchor');
  fs.writeFileSync(output, hooked);

  const browser = new ChromeVisualBrowser(chrome);
  t.after(() => browser.close());
  const session = await browser.sessionPromise;
  const send = (method, params = {}) => browser.cdp.send(method, params, session);
  async function run(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    return result.result?.value;
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
  await send('Page.navigate', { url: pathToFileURL(output).href + '?theme=light' });
  await loaded;
  await run('document.fonts.ready');
  await run('Archify.viewerChromeLayout.whenStable()');
  // Wait until nodes and camera stop moving: a fixed delay is too short
  // when other browser suites load the machine.
  const settle = () => run(`new Promise((resolve, reject) => {
    const started = performance.now();
    let previous = '';
    let still = 0;
    (function sample() {
      const svg = document.querySelector('.diagram-container > svg');
      const now = JSON.stringify([Archify.view.state(), svg.style.transform,
        document.querySelectorAll('[data-tree-leaving]').length,
        [...svg.querySelectorAll('[data-tree-shift]')].map((g) => g.getAttribute('transform')).join('|')]);
      still = now === previous ? still + 1 : 0;
      previous = now;
      if (still >= 6) return resolve();
      if (performance.now() - started > 8000) return reject(new Error('mind map did not settle'));
      requestAnimationFrame(sample);
    })();
  })`);
  const visible = `[...document.querySelectorAll('.diagram-container > svg [data-node-id]:not([data-tree-hidden])')].map((n) => n.getAttribute('data-node-id'))`;
  const boxes = `[...document.querySelectorAll('.diagram-container > svg [data-node-id]:not([data-tree-hidden]) .tree-pill')].map((r) => { const b = r.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; })`;
  const apart = (list) => list.every((a, i) => list.every((b, j) => j <= i || a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1]));

  assert.equal(await run('Archify.treeBranches.mindmap'), true);
  // The map is one fixed stage: the page fits the window and the wheel moves
  // the camera, never the page.
  assert.equal(await run(`document.querySelector('.diagram-container').hasAttribute('data-camera-stage')`), true);
  assert.ok(await run('document.documentElement.scrollHeight <= innerHeight + 1'), 'page fits one screen');
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY: 400 });
  await run('new Promise((resolve) => setTimeout(resolve, 150))');
  assert.equal(await run('scrollY'), 0);
  // The map opens at the first generation, laid out compactly.
  assert.deepEqual(await run(visible), ['platform', 'orders', 'payments', 'operations']);
  assert.ok(apart(await run(boxes)));
  assert.notEqual(await run(`document.querySelector('[data-node-id="operations"] [data-tree-shift]').getAttribute('transform')`), null);

  // Opening a branch reflows its neighbours, never overlapping, and the
  // camera follows the branch that was opened.
  const before = await run('Archify.view.state()');
  await run(`document.querySelector('[data-tree-toggle="payments"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  assert.deepEqual(await run(`document.querySelector('[data-node-id="operations"]').hasAttribute('data-tree-leaving')`), false);
  await settle();
  assert.deepEqual(await run(visible), ['platform', 'orders', 'payments', 'operations', 'card_payment', 'wallet_payment']);
  assert.ok(apart(await run(boxes)));
  const after = await run('Archify.view.state()');
  assert.ok(after.scale > before.scale, `camera zoomed toward the branch: ${before.scale} -> ${after.scale}`);
  assert.equal(await run(`document.querySelector('[data-tree-toggle="payments"]').getAttribute('aria-expanded')`), 'true');

  // The wider hit rail focus copies from each link follows it.
  assert.equal(await run(`(() => {
    const rail = document.querySelector('[data-relationship-hit-key][data-relationship-to="operations"] [data-tree-authored-d]');
    return Boolean(rail) && rail.getAttribute('d') === document.querySelector('[data-edge-to="operations"]').getAttribute('d');
  })()`), true);

  // Closing it again folds the children back and leaves no motion state.
  await run(`document.querySelector('[data-tree-toggle="payments"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  assert.equal(await run(`document.querySelectorAll('[data-tree-leaving]').length > 0`), true);
  await settle();
  assert.equal(await run(`document.querySelectorAll('[data-tree-leaving]').length`), 0);
  assert.deepEqual(await run(visible), ['platform', 'orders', 'payments', 'operations']);

  // Export is the complete, authored tree whatever the live layout is.
  const exported = await run(`(() => {
    const clone = document.querySelector('.diagram-container > svg').cloneNode(true);
    const clean = treeExportTest.clean(clone);
    return { clean, moved: clone.querySelectorAll('[data-tree-shift][transform], [data-tree-toggle][transform]').length,
      authored: clone.querySelectorAll('[data-tree-authored-d]').length,
      hidden: clone.querySelectorAll('[data-tree-hidden]').length };
  })()`);
  assert.deepEqual(exported, { clean: true, moved: 0, authored: 0, hidden: 0 });

  // With every branch open the live layout is exactly the authored one.
  await run(`document.querySelector('[data-tree-expand-all]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await settle();
  assert.equal(await run(`document.querySelectorAll('[data-tree-shift][transform], [data-tree-toggle][transform]').length`), 0);
  assert.equal(await run(`[...document.querySelectorAll('[data-tree-authored-d]')].every((path) => path.getAttribute('d') === path.getAttribute('data-tree-authored-d'))`), true);
  assert.equal(await run('Archify.view.state().scale'), 1);

  // A selection reveals a hidden node and settles at once, so focus measures it in place.
  // Programmatic changes settle at once; only the reader's own toggle glides.
  await run(`Archify.treeBranches.collapse('payments')`);
  assert.equal(await run(`document.querySelectorAll('[data-tree-leaving], .diagram-container > svg [style=""]').length`), 0);
  await run(`Archify.focus.set('card_payment')`);
  assert.equal(await run(`document.querySelector('[data-node-id="card_payment"]').hasAttribute('data-tree-hidden')`), false);
  assert.equal(await run(`document.querySelector('[data-node-id="card_payment"] [data-tree-shift]').style.opacity`), '');
});
