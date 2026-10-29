import { test } from 'node:test';
import { createScratchDirectory } from './helpers/scratch-directory.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..', 'archify');
const renderer = path.join(skillRoot, 'renderers', 'tree', 'render-tree.mjs');
const checker = path.join(skillRoot, 'scripts', 'check-render-output.mjs');
const small = JSON.parse(fs.readFileSync(path.join(skillRoot, 'examples', 'payment-platform.tree.json'), 'utf8'));
const large = JSON.parse(fs.readFileSync(path.join(skillRoot, 'examples', 'archify-repository.tree.json'), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
// The fixed elbow tree, kept as layout.style "classic"; the default is the mind map.
const classic = (diagram) => ({ ...clone(diagram), layout: { ...diagram.layout, style: 'classic' } });

function run(diagram, extra = []) {
  const directory = createScratchDirectory(path.join(os.tmpdir(), 'archify-tree-'));
  const input = path.join(directory, 'candidate.tree.json');
  const output = path.join(directory, 'candidate.html');
  fs.writeFileSync(input, JSON.stringify(diagram));
  const result = spawnSync(process.execPath, [renderer, input, output, ...extra], { cwd: directory, encoding: 'utf8' });
  return { ...result, output };
}

const layoutOf = (diagram) => {
  const result = run(diagram, ['--layout-json']);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const [name, diagram] of [['small', small], ['large', large], ['classic small', classic(small)], ['classic large', classic(large)]]) {
  test(`tree: ${name} example renders and passes the showcase artifact checks`, () => {
    const result = run(diagram);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(spawnSync(process.execPath, [checker, result.output], { encoding: 'utf8' }).stdout);
    assert.equal(receipt.ok, true, JSON.stringify(receipt.checks.filter((entry) => !entry.ok)));
    assert.equal(receipt.composition.summary.errors, 0);
    assert.equal(receipt.composition.summary.warnings, 0);
  });

  test(`tree: ${name} layout keeps generations aligned and nodes apart`, () => {
    const report = layoutOf(diagram);
    const byId = new Map(report.nodes.map((node) => [node.id, node]));
    const down = report.direction === 'down';
    for (const node of report.nodes) {
      for (const other of report.nodes) if (node.id < other.id) assert.ok(!overlap(node, other), `${node.id} overlaps ${other.id}`);
      if (!node.parent) continue;
      const parent = byId.get(node.parent);
      assert.equal(node.depth, parent.depth + 1);
      // Children lie strictly past their parent along the depth axis.
      assert.ok(down ? node.y >= parent.y + parent.height : node.x >= parent.x + parent.width, `${node.id} is not beyond ${parent.id}`);
    }
    // One generation shares one band edge: a row centre going down, a column
    // start going right. A stacked leaf list hangs below its parent instead.
    const bands = new Map();
    for (const node of report.nodes) {
      if (node.stacked) continue;
      const key = down ? Math.round(node.y + node.height / 2) : node.x;
      (bands.get(node.depth) || bands.set(node.depth, new Set()).get(node.depth)).add(key);
    }
    for (const [depth, keys] of bands) assert.equal(keys.size, 1, `generation ${depth} is not aligned`);
    // Every link starts at its parent and ends at its child.
    for (const edge of report.edges) {
      const [start, end] = [edge.points[0], edge.points.at(-1)];
      const parent = byId.get(edge.from);
      const child = byId.get(edge.to);
      if (down) {
        assert.equal(start[1], parent.y + parent.height);
        assert.ok(start[0] > parent.x && start[0] < parent.x + parent.width, `${edge.from} link leaves its own bottom edge`);
      } else assert.deepEqual(start, [parent.x + parent.width, parent.y + parent.height / 2]);
      assert.deepEqual(end, down && !child.stacked ? [child.x + child.width / 2, child.y] : [child.x, child.y + child.height / 2]);
    }
  });
}

test('tree: an unbalanced classic tree places a parent over its own children only', () => {
  const report = layoutOf(classic(small));
  const byId = new Map(report.nodes.map((node) => [node.id, node]));
  const center = (node) => node.x + node.width / 2;
  for (const parent of ['orders', 'payments', 'operations']) {
    const children = report.nodes.filter((node) => node.parent === parent);
    const expected = (center(children[0]) + center(children.at(-1))) / 2;
    assert.ok(Math.abs(center(byId.get(parent)) - expected) <= 1, parent);
  }
});

test('tree: three or more sibling leaves going down become one stacked list', () => {
  const report = layoutOf(classic(large));
  const children = (id) => report.nodes.filter((node) => node.parent === id);
  const scripts = children('scripts');
  assert.ok(scripts.length >= 3 && scripts.every((node) => node.stacked));
  // One column, one width, in authored order.
  assert.equal(new Set(scripts.map((node) => node.x)).size, 1);
  assert.equal(new Set(scripts.map((node) => node.width)).size, 1);
  for (let index = 1; index < scripts.length; index += 1) assert.ok(scripts[index].y >= scripts[index - 1].y + scripts[index - 1].height);
  // Two leaves and every branch stay in the row layout.
  assert.ok(layoutOf(classic(small)).nodes.every((node) => !node.stacked));
  assert.ok(!report.nodes.find((node) => node.id === 'r_shared').stacked);
});

test('tree: every descendant and link carries its ancestors, and toggles count what they hide', () => {
  const result = run(small);
  const html = fs.readFileSync(result.output, 'utf8');
  assert.match(html, /data-node-id="card_payment"[^>]*data-tree-ancestors="payments platform"/);
  assert.match(html, /data-edge-from="payments" data-edge-to="card_payment"[^>]*data-tree-ancestors="payments platform"/);
  assert.match(html, /data-tree-toggle="platform" data-tree-count="9"/);
  assert.match(html, /data-tree-toggle="payments" data-tree-count="2"[^>]*aria-expanded="true" aria-label="Collapse Payments \(2 below\)"/);
  assert.doesNotMatch(html, /data-tree-toggle="card_payment"/);
});

test('tree: authored collapsed state is a Viewer default, not a removal from the SVG', () => {
  const result = run(classic(large));
  const html = fs.readFileSync(result.output, 'utf8');
  assert.match(html, /data-tree-toggle="viewer"[^>]*data-tree-initially-collapsed=""/);
  assert.match(html, /data-node-id="v_tree"/);
  assert.doesNotMatch(html.match(/<svg\b[\s\S]*?<\/svg>/)[0], /data-tree-hidden=""/);
});

test('tree: long labels wrap between words instead of overflowing', () => {
  const diagram = classic(small);
  diagram.nodes.find((node) => node.id === 'refunds').label = 'Refund handling for partially captured multi-currency orders';
  const report = layoutOf(diagram);
  const node = report.nodes.find((entry) => entry.id === 'refunds');
  assert.ok(node.lines > 1);
  assert.ok(node.width <= 220);
});

test('tree: the default mind map grows right in generation columns', () => {
  const report = layoutOf(large);
  assert.equal(report.style, 'mindmap');
  assert.equal(report.direction, 'right');
  const byId = new Map(report.nodes.map((node) => [node.id, node]));
  const columns = new Map();
  for (const node of report.nodes) (columns.get(node.depth) || columns.set(node.depth, []).get(node.depth)).push(node);
  // A column is as wide as its widest pill, then the toggle and the link.
  for (let depth = 1; columns.has(depth); depth += 1) {
    const previous = columns.get(depth - 1);
    const reach = previous[0].x + Math.max(...previous.map((node) => node.width)) + 10 + 22 + 104;
    assert.deepEqual([...new Set(columns.get(depth).map((node) => node.x))], [reach], `column ${depth}`);
  }
  assert.ok(report.nodes.every((node) => !node.stacked));
  // A parent sits midway between its first and last child.
  for (const parent of report.nodes) {
    const children = report.nodes.filter((node) => node.parent === parent.id);
    if (!children.length) continue;
    const middle = (node) => node.y + node.height / 2;
    assert.ok(Math.abs(middle(parent) - (middle(children[0]) + middle(children.at(-1))) / 2) <= 1, parent.id);
  }
  // Rows in one group are 26px apart; the next branch group starts 44px further.
  const viewer = report.nodes.filter((node) => node.parent === 'viewer');
  assert.equal(viewer[1].y - (viewer[0].y + viewer[0].height), 26);
  const siblings = report.nodes.filter((node) => node.parent === byId.get('viewer').parent);
  const next = siblings[siblings.findIndex((node) => node.id === 'viewer') + 1];
  const subtree = (id) => [byId.get(id), ...report.nodes.filter((node) => node.parent === id).flatMap((node) => subtree(node.id))];
  const nextTop = Math.min(...subtree(next.id).map((node) => node.y));
  assert.ok(nextTop - (viewer.at(-1).y + viewer.at(-1).height) >= 26 + 44, `${next.id} sits apart from the viewer group`);
});

test('tree: a mind map draws label-only pills and opens one generation at a time', () => {
  const diagram = clone(small);
  diagram.nodes.find((node) => node.id === 'orders').collapsed = false;
  const html = fs.readFileSync(run(diagram).output, 'utf8');
  const svg = html.match(/<svg\b[\s\S]*?<\/svg>/)[0];
  assert.match(svg, /data-tree-style="mindmap" data-tree-mindmap="64 32 26 44 104 10 11"/);
  assert.doesNotMatch(svg, /class="t-muted tree-sublabel"/);
  // A mind map is a fixed stage, not a page as tall as the whole tree.
  assert.match(svg, /data-camera-stage=""/);
  assert.doesNotMatch(svg, /data-reader-fit="intrinsic-height"/);
  assert.match(svg, /data-node-id="payments"[^>]*>[\s\S]*?<g data-tree-shift="">[\s\S]*?class="[^"]*tree-pill"/);
  // Below the root every branch starts closed unless it says otherwise.
  assert.doesNotMatch(svg, /data-tree-toggle="platform"[^>]*data-tree-initially-collapsed/);
  assert.doesNotMatch(svg, /data-tree-toggle="orders"[^>]*data-tree-initially-collapsed/);
  assert.match(svg, /data-tree-toggle="payments"[^>]*data-tree-initially-collapsed=""/);
  assert.match(svg, /data-edge-from="payments" data-edge-to="card_payment"[^>]*d="M [\d.]+ [\d.]+ H [\d.]+ C /);
  assert.doesNotMatch(svg, /data-tree-hidden=""/);
});

function failure(mutate) {
  const diagram = clone(small);
  mutate(diagram);
  const result = run(diagram);
  assert.notEqual(result.status, 0, 'renderer accepted an invalid tree');
  return result.stderr;
}

test('tree: structural errors are refused instead of inventing a hierarchy', () => {
  assert.match(failure((d) => { d.nodes[4].parent = 'missing'; }), /tree\/missing-parent/);
  assert.match(failure((d) => { delete d.nodes[1].parent; }), /tree\/root-count/);
  assert.match(failure((d) => { d.nodes[0].parent = 'orders'; }), /tree\/root-count/);
  const cycle = failure((d) => {
    d.nodes.find((node) => node.id === 'orders').parent = 'create_order';
  });
  assert.match(cycle, /tree\/cycle/);
  assert.match(cycle, /"orders" -> "create_order" -> "orders"|"create_order" -> "orders" -> "create_order"/);
  assert.match(failure((d) => { d.nodes[5].id = d.nodes[4].id; }), /tree\/duplicate-id/);
});
