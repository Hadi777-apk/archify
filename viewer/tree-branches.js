    /* ============================================================
       Tree Branches — expand/collapse for hierarchy diagrams. The renderer
       lays out the complete tree once and tags every node, link, and toggle
       with its ancestors. In a classic tree collapsing only hides descendants,
       so visible nodes never move and the reader keeps their place; a mind
       map reflows around the open branches and the camera follows the one
       the reader toggled (see Mind map below). Selecting a hidden node
       through Finder, Outline, or a shared link expands its ancestors. Export
       always writes the complete tree (see Export Cleanup).
       ============================================================ */
    Archify.treeBranches = (function () {
      var svg = document.querySelector('.diagram-container > svg[data-tree-ui]');
      if (!svg) return { active: false };
      var collapsed = Object.create(null);
      var toggles = Object.create(null);
      Array.prototype.forEach.call(svg.querySelectorAll('[data-tree-toggle]'), function (toggle) {
        toggles[toggle.getAttribute('data-tree-toggle')] = toggle;
      });
      var tagged = svg.querySelectorAll('[data-tree-ancestors]');
      var expandAll = svg.querySelector('[data-tree-expand-all]');

      function ancestors(el) {
        return (el.getAttribute('data-tree-ancestors') || '').split(' ').filter(Boolean);
      }

      function apply() {
        Array.prototype.forEach.call(tagged, function (el) {
          var hidden = ancestors(el).some(function (id) { return collapsed[id]; });
          if (hidden) el.setAttribute('data-tree-hidden', '');
          else el.removeAttribute('data-tree-hidden');
        });
        var any = false;
        Object.keys(toggles).forEach(function (id) {
          var toggle = toggles[id];
          var isCollapsed = Boolean(collapsed[id]);
          any = any || isCollapsed;
          toggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
          toggle.setAttribute('aria-label', toggle.getAttribute(isCollapsed ? 'data-tree-label-expand' : 'data-tree-label-collapse') || '');
          var node = svg.querySelector('[data-node-id="' + id + '"]');
          if (node) {
            if (isCollapsed) node.setAttribute('data-tree-collapsed', '');
            else node.removeAttribute('data-tree-collapsed');
          }
        });
        if (any) svg.setAttribute('data-tree-any-collapsed', '');
        else svg.removeAttribute('data-tree-any-collapsed');
      }

      /* Mind map. The renderer placed the complete tree; here only the open
         part is laid out, with the renderer's own pass, so closing a branch
         pulls its neighbours together and opening one makes room. Nodes glide
         between layouts and the camera follows the branch the reader opened.
         With every branch open the positions are exactly the authored ones. */
      var mindmap = svg.getAttribute('data-tree-style') === 'mindmap' ? buildMindmap() : null;
      var motionFrame = 0;
      // The open part of the map, from the canvas origin to its far margin.
      // A stage camera holds its view to these bounds.
      var openBounds = null;

      function boundsOf(pos) {
        var gap = mindmap.gap;
        var right = 0;
        var bottom = 0;
        Object.keys(pos).forEach(function (id) {
          var item = mindmap.items[id];
          right = Math.max(right, pos[id].x + item.w + (item.children.length ? gap.toggle + gap.r * 2 : 0));
          bottom = Math.max(bottom, pos[id].y + item.h);
        });
        return { x0: 0, y0: 0, x1: right + gap.margin, y1: bottom + gap.margin };
      }

      function setBounds(bounds) {
        openBounds = bounds;
        if (Archify.view && typeof Archify.view.refresh === 'function') Archify.view.refresh();
      }

      function buildMindmap() {
        var values = (svg.getAttribute('data-tree-mindmap') || '').split(' ').map(Number);
        if (values.length !== 7 || !values.every(isFinite)) return null;
        var gap = { top: values[0], margin: values[1], row: values[2], group: values[3], link: values[4], toggle: values[5], r: values[6] };
        var items = Object.create(null);
        var order = [];
        var root = null;
        Array.prototype.forEach.call(svg.querySelectorAll('[data-node-id][data-tree-depth]'), function (el) {
          var pill = el.querySelector('.tree-pill');
          var shift = el.querySelector('[data-tree-shift]');
          if (!pill || !shift) return;
          var id = el.getAttribute('data-node-id');
          var item = {
            id: id, el: el, shift: shift, toggle: toggles[id] || null, edge: null,
            depth: Number(el.getAttribute('data-tree-depth')), parent: ancestors(el)[0] || null, children: [],
            x: Number(pill.getAttribute('x')), y: Number(pill.getAttribute('y')),
            w: Number(pill.getAttribute('width')), h: Number(pill.getAttribute('height')),
            shown: true
          };
          item.cur = { x: item.x, y: item.y, o: 1 };
          items[id] = item;
          order.push(item);
        });
        order.forEach(function (item) {
          if (item.parent && items[item.parent]) items[item.parent].children.push(item);
          else if (!item.parent) root = item;
        });
        Array.prototype.forEach.call(svg.querySelectorAll('.tree-curve[data-edge-to]'), function (edge) {
          var item = items[edge.getAttribute('data-edge-to')];
          if (!item) return;
          item.edge = edge;
          // Export restores the authored link from here (see Export Cleanup).
          edge.setAttribute('data-tree-authored-d', edge.getAttribute('d'));
        });
        return root ? { gap: gap, items: items, order: order, root: root } : null;
      }

      function isOpen(item) { return item.children.length > 0 && !collapsed[item.id]; }

      // The renderer's placeMindmap(), over the nodes that are not hidden.
      function mindmapLayout() {
        var gap = mindmap.gap;
        var width = [];
        (function measure(item) {
          width[item.depth] = Math.max(width[item.depth] || 0, item.w);
          if (isOpen(item)) item.children.forEach(measure);
        })(mindmap.root);
        var columnX = [gap.margin];
        for (var depth = 1; depth < width.length; depth += 1) {
          columnX[depth] = columnX[depth - 1] + width[depth - 1] + gap.toggle + gap.r * 2 + gap.link;
        }
        var pos = Object.create(null);
        var cursor = gap.top;
        (function place(item) {
          var center;
          if (isOpen(item)) {
            var centers = item.children.map(function (child, index) {
              if (index && (isOpen(child) || isOpen(item.children[index - 1]))) cursor += gap.group;
              return place(child);
            });
            center = (centers[0] + centers[centers.length - 1]) / 2;
          } else {
            center = cursor + item.h / 2;
            cursor += item.h + gap.row;
          }
          pos[item.id] = { x: Math.round(columnX[item.depth]), y: Math.round(center - item.h / 2) };
          return center;
        })(mindmap.root);
        var top = pos[mindmap.root.id].y;
        Object.keys(pos).forEach(function (id) { top = Math.min(top, pos[id].y); });
        var lift = Math.max(0, gap.margin - top);
        if (lift) Object.keys(pos).forEach(function (id) { pos[id].y += lift; });
        return pos;
      }

      function linkPath(parent, child) {
        var gap = mindmap.gap;
        var round = function (value) { return Math.round(value * 10) / 10; };
        var sx = parent.cur.x + parent.w;
        var sy = parent.cur.y + parent.h / 2;
        var tx = sx + gap.toggle + gap.r;
        var ex = child.cur.x;
        var ey = child.cur.y + child.h / 2;
        var reach = (ex - tx) / 2;
        return 'M ' + round(sx) + ' ' + round(sy) + ' H ' + round(tx) + ' C ' + round(tx + reach) + ' ' + round(sy) + ' ' +
          round(ex - reach) + ' ' + round(ey) + ' ' + round(ex) + ' ' + round(ey);
      }

      function draw(item, settled) {
        var dx = Math.round((item.cur.x - item.x) * 100) / 100;
        var dy = Math.round((item.cur.y - item.y) * 100) / 100;
        var transform = dx || dy ? 'translate(' + dx + ' ' + dy + ')' : null;
        [item.shift, item.toggle].forEach(function (el) {
          if (!el) return;
          if (transform) el.setAttribute('transform', transform);
          else el.removeAttribute('transform');
          fade(el, settled ? null : item.cur.o);
        });
        if (item.edge) {
          var parent = mindmap.items[item.parent];
          var home = !transform && parent.cur.x === parent.x && parent.cur.y === parent.y;
          item.edge.setAttribute('d', home ? item.edge.getAttribute('data-tree-authored-d') : linkPath(parent, item));
          fade(item.edge, settled ? null : item.cur.o);
        }
      }

      // A settled element carries no motion residue, not even an empty style.
      function fade(el, opacity) {
        if (opacity !== null) { el.style.opacity = String(opacity); return; }
        el.style.removeProperty('opacity');
        if (!el.getAttribute('style')) el.removeAttribute('style');
      }

      function shownAncestor(item) {
        var current = mindmap.items[item.parent];
        while (current && !current.shown) current = mindmap.items[current.parent];
        return current || mindmap.root;
      }

      function reducedMotion() {
        return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      }

      // Glide every node from where it is to its new place. Entering nodes grow
      // out of their parent; leaving ones fold back into it and then hide.
      function reflow(options) {
        if (!mindmap) return null;
        options = options || {};
        var pos = mindmapLayout();
        var moves = [];
        var settledBounds = boundsOf(pos);
        mindmap.order.forEach(function (item) {
          var to = pos[item.id];
          if (to) {
            var from = item.shown ? { x: item.cur.x, y: item.cur.y, o: item.cur.o } : null;
            if (!from) {
              var origin = shownAncestor(item);
              from = { x: origin.cur.x, y: origin.cur.y, o: 0 };
            }
            moves.push({ item: item, from: from, to: { x: to.x, y: to.y, o: 1 } });
          } else if (item.shown) {
            var keeper = mindmap.items[item.parent];
            while (keeper && !pos[keeper.id]) keeper = mindmap.items[keeper.parent];
            var home = pos[(keeper || mindmap.root).id];
            moves.push({ item: item, from: { x: item.cur.x, y: item.cur.y, o: item.cur.o }, to: { x: home.x, y: home.y, o: 0 }, leaving: true });
          }
        });
        moves.forEach(function (move) { move.item.shown = !move.leaving; });
        cancelAnimationFrame(motionFrame);
        var instant = options.instant === true || reducedMotion() || document.hidden;
        var settle = function () {
          // Focus copies each link once for its wider hit rail; keep the copies on the links.
          var rails = Object.create(null);
          Array.prototype.forEach.call(svg.querySelectorAll('[data-relationship-hit-key] [data-tree-authored-d]'), function (shape) {
            var to = shape.closest('[data-relationship-hit-key]').getAttribute('data-relationship-to');
            (rails[to] = rails[to] || []).push(shape);
          });
          var traced = [];
          var folded = [];
          moves.forEach(function (move) {
            move.item.cur = move.to;
            draw(move.item, true);
            if (move.item.edge) {
              (rails[move.item.id] || []).forEach(function (shape) { shape.setAttribute('d', move.item.edge.getAttribute('d')); });
              (move.leaving ? folded : traced).push(move.item.edge);
            }
            [move.item.el, move.item.toggle, move.item.edge].forEach(function (el) { if (el) el.removeAttribute('data-tree-leaving'); });
          });
          // Live motion draws its flow layers along the links; they follow in
          // one batch. Hidden links only carry their path until they open.
          if ((traced.length || folded.length) && Archify.motionGovernor && typeof Archify.motionGovernor.retrace === 'function') Archify.motionGovernor.retrace(traced, folded);
          setBounds(settledBounds);
          if (Archify.focus && Archify.focus.reposition) Archify.focus.reposition();
        };
        if (instant) { settle(); return pos; }
        setBounds(openBounds ? {
          x0: 0,
          y0: 0,
          x1: Math.max(openBounds.x1, settledBounds.x1),
          y1: Math.max(openBounds.y1, settledBounds.y1)
        } : settledBounds);
        moves.forEach(function (move) {
          if (move.leaving) [move.item.el, move.item.toggle, move.item.edge].forEach(function (el) { if (el) el.setAttribute('data-tree-leaving', ''); });
        });
        var duration = 420;
        var startedAt = 0;
        var step = function (timestamp) {
          if (!startedAt) startedAt = timestamp;
          var t = Math.min(1, (timestamp - startedAt) / duration);
          var eased = 1 - Math.pow(1 - t, 4);
          moves.forEach(function (move) {
            move.item.cur = {
              x: move.from.x + (move.to.x - move.from.x) * eased,
              y: move.from.y + (move.to.y - move.from.y) * eased,
              o: move.from.o + (move.to.o - move.from.o) * eased
            };
          });
          moves.forEach(function (move) { draw(move.item, false); });
          if (t < 1) motionFrame = requestAnimationFrame(step);
          else settle();
        };
        motionFrame = requestAnimationFrame(step);
        return pos;
      }

      // Bring the branch the reader just toggled to the middle of the view: the
      // node itself, the links that reach it for context, and, once open, all
      // of its children. Opening zooms in a little, or out as far as the
      // branch needs; closing keeps the zoom and recentres on the node.
      function focusBranch(id, pos) {
        var view = Archify.view;
        var item = mindmap && mindmap.items[id];
        if (!item || !pos || !pos[id] || !view || typeof view.centerAt !== 'function' || typeof view.logicalViewport !== 'function') return;
        var gap = mindmap.gap;
        var at = pos[id];
        var middle = at.y + item.h / 2;
        var left = item.parent ? Math.max(0, at.x - gap.link) : at.x;
        var right = at.x + item.w + gap.toggle + gap.r * 2;
        var reach = item.h / 2;
        if (isOpen(item)) item.children.forEach(function (child) {
          var spot = pos[child.id];
          right = Math.max(right, spot.x + child.w + (child.children.length ? gap.toggle + gap.r * 2 : 0));
          reach = Math.max(reach, Math.abs(spot.y + child.h / 2 - middle) + child.h / 2);
        });
        var seen = view.logicalViewport();
        if (!seen) return;
        var current = view.state().scale;
        var fit = Math.min(seen.width * current / (right - left), seen.height * current / (reach * 2)) * 0.88;
        var scale = isOpen(item) ? Math.max(1, Math.min(Math.max(current, 1.25), fit)) : current;
        view.centerAt((left + right) / 2, middle, { scale: scale, glide: true });
      }

      function setCollapsed(id, value, options) {
        if (!toggles[id]) return false;
        if (value) collapsed[id] = true;
        else delete collapsed[id];
        apply();
        var reader = Boolean(options && options.focus);
        var pos = reflow({ instant: !reader });
        if (reader) focusBranch(id, pos);
        return true;
      }

      function toggle(id, options) { return setCollapsed(id, !collapsed[id], options); }

      // Reveal a node by expanding every collapsed ancestor. A classic tree
      // moves nothing else; a mind map settles at once so focus measures the
      // node where it ends up. Programmatic collapse and expand settle at once
      // too; only a toggle the reader uses glides and moves the camera.
      function reveal(id) {
        var node = svg.querySelector('[data-node-id="' + id + '"]');
        if (!node) return false;
        var changed = false;
        ancestors(node).forEach(function (ancestor) {
          if (collapsed[ancestor]) { delete collapsed[ancestor]; changed = true; }
        });
        if (changed) { apply(); reflow({ instant: true }); }
        return changed;
      }

      function restoreAll(options) {
        collapsed = Object.create(null);
        apply();
        reflow({ instant: !(options && options.animate) });
      }

      function activate(event) {
        var target = event.target.closest('[data-tree-toggle], [data-tree-expand-all]');
        if (!target || !svg.contains(target)) return false;
        event.preventDefault();
        event.stopPropagation();
        if (target.hasAttribute('data-tree-expand-all')) {
          restoreAll({ animate: true });
          // The open mind map is the authored canvas, so its overview frames it.
          if (mindmap && Archify.view && typeof Archify.view.reset === 'function') Archify.view.reset();
          var root = svg.querySelector('[data-tree-toggle]:not([data-tree-ancestors])');
          if (root) root.focus();
        } else {
          toggle(target.getAttribute('data-tree-toggle'), { focus: true });
          // The camera, not the browser, decides where a moving map scrolls.
          target.focus({ preventScroll: true });
        }
        return true;
      }

      // Capture phase so the canvas focus handler never treats a toggle press
      // as a background click that clears the current focus.
      svg.addEventListener('click', activate, true);
      svg.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { activate(event); return; }
        var node = event.target.closest('[data-node-id]');
        if (!node || !svg.contains(node)) return;
        var id = node.getAttribute('data-node-id');
        // Arrow keys follow the tree convention: left collapses, right expands.
        if (event.key === 'ArrowLeft' && toggles[id] && !collapsed[id]) { event.preventDefault(); setCollapsed(id, true, { focus: true }); }
        else if (event.key === 'ArrowRight' && collapsed[id]) { event.preventDefault(); setCollapsed(id, false, { focus: true }); }
      }, true);

      // Focus reveals ancestors synchronously before positioning its lens.
      // The observer also covers paths that change pressed state directly.
      new MutationObserver(function (records) {
        records.forEach(function (record) {
          var el = record.target;
          if (el.hasAttribute && el.hasAttribute('data-tree-hidden') && el.getAttribute('aria-pressed') === 'true') {
            reveal(el.getAttribute('data-node-id'));
          }
        });
      }).observe(svg, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });

      Object.keys(toggles).forEach(function (id) {
        if (toggles[id].hasAttribute('data-tree-initially-collapsed')) collapsed[id] = true;
      });
      apply();
      reflow({ instant: true });

      return {
        active: true,
        mindmap: Boolean(mindmap),
        bounds: function () { return openBounds ? { x0: openBounds.x0, y0: openBounds.y0, x1: openBounds.x1, y1: openBounds.y1 } : null; },
        toggle: toggle,
        collapse: function (id) { return setCollapsed(id, true); },
        expand: function (id) { return setCollapsed(id, false); },
        reveal: reveal,
        restoreAll: restoreAll,
        collapsedIds: function () { return Object.keys(collapsed); },
        expandAllControl: expandAll
      };
    })();
