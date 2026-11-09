// The DOM layer: corner UI, floating labels, the approval marker. All text goes in through textContent,
// because event text comes from a public feed. Anything that animates is driven from the engine clock.

import * as THREE from 'three';

const TYPE_MARK = {
  idle: 'rest',
  working: 'working',
  found: 'found',
  done: 'done',
  needs_approval: 'needs approval',
};

const MAX_TASK_LABELS = 3;
const MAX_TASK_LABELS_NARROW = 2; // The feed already holds the same text, and worlds are small on a phone.
const NARROW_WIDTH = 640;
// How long a line stays over a bot. A bot waiting on a person keeps its line until it is answered.
const BUBBLE_SECONDS = 3.4;
// One line on screen at a time, the newest. A bot waiting on a person goes first. ?bubbles=n allows more.
const MAX_BUBBLES = Math.max(1, Number(new URLSearchParams(location.search).get('bubbles')) || 1);
const FEED_COLLAPSED = 3;
const FEED_EXPANDED = 6;
const PX_PER_NAME_LABEL = 64;

function el(tag, className, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

function ageText(ms, nowMs) {
  const s = Math.max(0, (nowMs - ms) / 1000);
  if (s < 10) return 'now';
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function showFatal(root, title, details = []) {
  root.textContent = '';
  const wrap = el('div', 'gi-card-wrap', root);
  const card = el('div', 'gi-glass gi-card', wrap);
  card.setAttribute('role', 'alert');
  card.dataset.testid = 'fatal';
  el('h1', '', card).textContent = title;
  if (details.length) {
    const ul = el('ul', '', card);
    for (const line of details) el('li', '', ul).textContent = line;
  }
}

export function showLoading(root, text) {
  root.textContent = '';
  const wrap = el('div', 'gi-card-wrap', root);
  wrap.style.pointerEvents = 'none';
  el('div', 'gi-glass gi-loading', wrap).textContent = text;
  return () => wrap.remove();
}

export function createUi({ root, config, store, island, camera, source, rig, params, nowMs, onSelectWorld, debugHud }) {
  root.textContent = '';
  // The world does the talking. The corner panels, pile counts and camera buttons are opt in with ?ui=1.
  const showUi = params.get('ui') === '1';
  if (params.get('film') === '1') root.classList.add('gi-film');
  const bots = new Map([config.lead, ...config.bots].map((b) => [b.id, b]));

  // Top left: workspace and status.
  const tl = el('div', 'gi-corner gi-tl', root);
  const brand = el('div', 'gi-glass gi-brand', tl);
  brand.style.position = 'relative';
  const workspace = el('div', 'gi-workspace', brand);
  workspace.textContent = config.workspace;
  const status = el('div', 'gi-status', brand);
  status.dataset.testid = 'status';
  const statusDot = el('span', 'gi-status-dot', status);
  const statusLabel = el('span', '', status);
  const statusDetail = el('div', 'gi-glass gi-status-detail', brand);
  statusDetail.dataset.testid = 'status-detail';
  statusDetail.hidden = true;

  // Top right: today's counts and the waiting counter.
  const tr = el('div', 'gi-corner gi-tr', root);
  const approvals = el('div', 'gi-glass gi-approvals', tr);
  approvals.dataset.testid = 'approvals';
  approvals.hidden = true;
  const approvalsDot = el('span', 'gi-amber-dot', approvals);
  const approvalsNum = el('b', '', approvals);
  el('span', '', approvals).textContent = 'waiting';
  const counts = el('div', 'gi-glass gi-counts', tr);
  counts.dataset.testid = 'counts';
  el('span', 'gi-counts-title', counts).textContent = 'Today';
  const countRows = {};
  for (const [key, label] of [['working', 'started'], ['found', 'found'], ['done', 'done']]) {
    const box = el('span', '', counts);
    const b = el('b', '', box);
    b.textContent = '0';
    box.appendChild(document.createTextNode(label));
    countRows[key] = b;
  }

  // Bottom left: the feed. Three rows, six on tap.
  const bl = el('div', 'gi-corner gi-bl', root);
  const feed = el('button', 'gi-glass gi-feed', bl);
  feed.type = 'button';
  feed.dataset.testid = 'feed';
  feed.hidden = true;
  feed.setAttribute('aria-expanded', 'false');
  feed.setAttribute('aria-label', 'Recent bot activity. Tap to show more.');
  let feedExpanded = false;
  feed.addEventListener('click', () => {
    feedExpanded = !feedExpanded;
    feed.setAttribute('aria-expanded', String(feedExpanded));
    renderFeed();
  });

  // Bottom right: camera buttons.
  const br = el('div', 'gi-corner gi-br', root);
  const overview = el('button', 'gi-glass gi-button', br);
  overview.type = 'button';
  overview.textContent = 'overview';
  overview.dataset.testid = 'overview';
  overview.addEventListener('click', () => rig.goHome(1));
  const cinematic = el('button', 'gi-glass gi-button', br);
  cinematic.type = 'button';
  cinematic.textContent = 'cinematic';
  cinematic.dataset.testid = 'cinematic';
  cinematic.addEventListener('click', () => {
    if (rig.mode === 'tour') {
      rig.stopTour();
      rig.goHome(1.6);
    } else {
      rig.startTour();
    }
  });

  // Over the main building: the approval marker.
  const marker = el('div', 'gi-glass gi-marker', root);
  marker.dataset.testid = 'marker';
  marker.hidden = true;
  const markerDot = el('span', 'gi-marker-dot', marker);
  const markerHalo = el('i', '', markerDot);
  el('u', '', markerDot);
  const markerText = el('span', 'gi-marker-text', marker);

  // A plate island's bubbles speak for the bots, so nothing floats over the main building as well.
  const plateIsland = island.cameraLimits?.plate === true;
  if (plateIsland) marker.style.display = 'none';

  // Bubbles over each bot: who it is, what it is saying right now, how far along it is.
  const labels = [];
  const addLabel = (bot, world) => {
    const node = el('div', 'gi-label gi-bubble', root);
    node.dataset.testid = `label-${bot.id}`;
    node.setAttribute('aria-label', bot.name);
    const body = el('div', 'gi-bubble-body', node);
    el('i', 'gi-bubble-wait', body);
    const task = el('div', 'gi-label-task', body);
    task.hidden = true;
    const line = el('span', 'gi-bubble-line', task);
    const oldLine = el('span', 'gi-bubble-line gi-bubble-old', task);
    labels.push({
      bot, world, node, body, task, line, oldLine,
      opacity: 0, width: 100, height: 22, taskOn: false, activeSince: -Infinity,
      full: '', shown: '', changedAt: -10, tick: null, x: null, y: null, w: 0, h: 0, targetW: 0, targetH: 0,
    });
  };
  addLabel(config.lead, island.main);
  for (const bot of config.bots) addLabel(bot, island.worlds.get(bot.id));

  const debugBox = debugHud ? el('div', 'gi-glass gi-debug', root) : null;
  if (debugBox) debugBox.dataset.testid = 'debug';

  const toast = el('div', 'gi-glass gi-toast', root);
  toast.dataset.testid = 'toast';
  toast.hidden = true;
  let toastUntil = 0;

  if (!showUi) {
    for (const node of [tl, tr, bl, br]) node.style.display = 'none';
    workspace.style.display = 'none';
  }
  // For a clean plate: no names and no marker over the world.
  if (params.get('labels') === '0') root.classList.add('gi-no-labels');

  const feedRows = new Map();
  let clock = 0;
  let lastAgeRefresh = -1;
  let lastCounts = '';

  function renderFeed() {
    const limit = feedExpanded ? FEED_EXPANDED : FEED_COLLAPSED;
    const rows = store.lastEvents(limit);
    feed.hidden = rows.length === 0 || island.cameraLimits?.plate === true;
    feed.textContent = '';
    const nowValue = nowMs();
    for (const evt of rows) {
      const bot = bots.get(evt.bot_id);
      const row = el('div', 'gi-feed-row', feed);
      row.dataset.type = evt.type;
      const mark = el('span', 'gi-feed-mark', row);
      mark.style.background = bot?.color ?? '#ffffff';
      el('span', 'gi-feed-name', row).textContent = bot?.name ?? evt.bot_id;
      el('span', 'gi-feed-text', row).textContent = evt.text || TYPE_MARK[evt.type];
      const age = el('span', 'gi-feed-age', row);
      age.textContent = ageText(evt.ms, nowValue);
      const key = evt.id ?? `${evt.bot_id}${evt.ms}${evt.type}`;
      if (!feedRows.has(key)) feedRows.set(key, clock);
      const bornAt = feedRows.get(key);
      row.dataset.born = String(bornAt);
    }
    if (feedRows.size > 40) {
      const keep = [...feedRows.keys()].slice(-20);
      for (const k of [...feedRows.keys()]) if (!keep.includes(k)) feedRows.delete(k);
    }
  }

  function renderCounts() {
    const c = store.todayCounts(nowMs());
    const text = `${c.working}|${c.found}|${c.done}`;
    if (text !== lastCounts) {
      lastCounts = text;
      countRows.working.textContent = String(c.working);
      countRows.found.textContent = String(c.found);
      countRows.done.textContent = String(c.done);
    }
  }

  function renderPending() {
    const list = store.pendingApprovals();
    approvals.hidden = list.length === 0;
    approvalsNum.textContent = String(list.length);
    marker.hidden = list.length === 0;
    if (list.length) {
      const top = list[0];
      const name = top.bot?.name ?? top.bot_id;
      markerText.textContent = `${name}: ${top.text || 'needs approval'}`;
    }
  }

  let lastStatus = '';
  function renderStatus() {
    const s = source.status();
    let state = s.state;
    if (state === 'ok') state = source.mode === 'live' ? 'live' : 'plain';
    const key = `${s.label}|${state}|${s.detail}`;
    if (key === lastStatus) return;
    lastStatus = key;
    statusLabel.textContent = s.label;
    status.dataset.state = state;
    statusDetail.hidden = !s.detail;
    statusDetail.textContent = s.detail;
    // With the corners off, a problem with the feed is the one thing that still has to be said.
    if (!showUi) tl.style.display = state === 'retrying' || state === 'warn' ? '' : 'none';
  }

  // A number going up in the same sentence ticks. Anything else slides in over the old line.
  function setBubbleText(label, text, instant) {
    const prev = label.full;
    label.full = text;
    const num = /\d[\d,]*/g;
    const a = prev.match(num);
    const b = text.match(num);
    const sameWords = prev.replace(num, '#') === text.replace(num, '#');
    if (!instant && prev && a && b && sameWords) {
      label.tick = { from: a.map((x) => Number(x.replace(/,/g, ''))), to: b.map((x) => Number(x.replace(/,/g, ''))), at: clock, parts: text.split(num) };
      return;
    }
    label.tick = null;
    if (instant || !prev) {
      label.line.textContent = text;
      label.oldLine.textContent = '';
      label.changedAt = -10;
      return;
    }
    label.oldLine.textContent = prev;
    label.line.textContent = text;
    label.changedAt = clock;
  }

  const noteEvent = (evt) => {
    for (const label of labels) {
      if (label.bot.id === evt.bot_id) {
        // A late row must not replace what the bot is saying now.
        if (label.lastEvt && evt.ms < label.lastEvt.ms) continue;
        // A row with nothing to say does not bring a bubble back, and going idle is not news.
        if (evt.text || evt.type === 'idle') {
          label.activeSince = clock;
          label.lastEvt = evt;
        }
        if (evt.text && evt.type !== 'idle' && label.full !== evt.text) setBubbleText(label, evt.text, evt.catchup);
        label.measured = false;
      }
    }
    renderFeed();
    renderCounts();
    renderPending();
  };
  const offEvent = store.on(noteEvent);
  const offReset = store.onReset(() => {
    for (const label of labels) {
      label.activeSince = -Infinity;
      label.lastEvt = null;
    }
    renderFeed();
    renderCounts();
    renderPending();
  });

  const v = new THREE.Vector3();
  const rects = [];
  const uiPanels = [tl, tr, bl, br];

  function bubbleVisuals(label, t) {
    const state = store.botState(label.bot.id);
    const pending = !!state?.pending;
    const recent = t - label.activeSince < BUBBLE_SECONDS && label.lastEvt && label.lastEvt.type !== 'idle' && !label.lastEvt.catchup;
    const kind = pending ? 'wait' : recent ? 'show' : 'rest';
    if (label.kind !== kind) {
      label.kind = kind;
      label.node.dataset.kind = kind;
      label.measured = false;
    }
    // Old line out, new line in. A plain cross-fade: nothing slides, nothing glows.
    const k = Math.min(1, (t - label.changedAt) / 0.5);
    label.line.style.opacity = smoothstep(0.1, 1, k).toFixed(3);
    label.oldLine.style.opacity = (1 - smoothstep(0, 0.6, k)).toFixed(3);
    // Numbers count up.
    if (label.tick) {
      const q = Math.min(1, (t - label.tick.at) / 0.8);
      const eased = 1 - (1 - q) ** 3;
      const { from, to, parts } = label.tick;
      let text = parts[0];
      to.forEach((end, i) => {
        const start = from[i] ?? end;
        text += Math.round(start + (end - start) * eased).toLocaleString('en-US') + (parts[i + 1] ?? '');
      });
      if (label.line.textContent !== text) label.line.textContent = text;
      if (q >= 1) { label.line.textContent = label.full; label.tick = null; }
    }
    return kind;
  }

  function measureBubble(label) {
    label.body.style.width = 'max-content';
    label.body.style.height = 'auto';
    label.targetW = label.body.offsetWidth || 90;
    label.targetH = label.body.offsetHeight || 26;
    if (!label.w) { label.w = label.targetW; label.h = label.targetH; }
    label.body.style.width = `${label.w}px`;
    label.body.style.height = `${label.h}px`;
    label.measured = true;
  }

  function layoutLabels(dt, width, height) {
    const smoothing = 1 - Math.exp(-dt * 7);
    const fading = 1 - Math.exp(-dt * 4.5);
    // Faster than the move, so the text is never cut off while the bubble catches up with it.
    const sizing = 1 - Math.exp(-dt * 14);
    rects.length = 0;
    if (showUi) {
      for (const panel of uiPanels) {
        for (const child of panel.children) {
          if (child.hidden) continue;
          const r = child.getBoundingClientRect();
          if (r.width > 0) rects.push({ x0: r.left - 6, y0: r.top - 6, x1: r.right + 6, y1: r.bottom + 6 });
        }
      }
    }
    if (!marker.hidden && !plateIsland) {
      const r = marker.getBoundingClientRect();
      if (r.width > 0) rects.push({ x0: r.left - 4, y0: r.top - 4, x1: r.right + 4, y1: r.bottom + 4 });
    }
    const placed = [];
    // Who gets to speak: a wait first, then whoever spoke last. The rest stay quiet until it fades.
    let speakers = labels.filter((l) => l.lastEvt || store.botState(l.bot.id)?.pending);
    speakers.sort((a, b) => (!!store.botState(b.bot.id)?.pending - !!store.botState(a.bot.id)?.pending) || (b.activeSince - a.activeSince));
    speakers = new Set(speakers.slice(0, MAX_BUBBLES));
    for (const label of labels) {
      let kind = bubbleVisuals(label, clock);
      if (kind !== 'rest' && !speakers.has(label)) kind = 'rest';
      // The line stays in place while the bubble fades, so it never shrinks to an empty pill on the way out.
      const showTask = !!label.full && (kind !== 'rest' || label.opacity > 0.02);
      if (showTask !== label.taskOn) {
        label.taskOn = showTask;
        label.task.hidden = !showTask;
        label.measured = false;
      }
      if (!label.measured) measureBubble(label);
      label.w += (label.targetW - label.w) * sizing;
      label.h += (label.targetH - label.h) * sizing;
      label.body.style.width = `${label.w.toFixed(1)}px`;
      label.body.style.height = `${label.h.toFixed(1)}px`;

      const anchor = label.world.anchor;
      if (anchor.isVector3) v.copy(anchor);
      else anchor.getWorldPosition(v);
      v.project(camera);
      const sx = (v.x * 0.5 + 0.5) * width;
      const sy = (-v.y * 0.5 + 0.5) * height;
      const off = v.z > 1 || sx < -40 || sx > width + 40 || sy < -40 || sy > height + 40;
      let x0 = Math.max(8, Math.min(width - label.targetW - 8, sx - label.targetW / 2));
      let y0 = Math.max(8, sy - label.targetH - 8);
      // Stack clear of the corner panels and the bubbles already placed. Up first, then down when there is no room.
      for (let pass = 0; pass < 6; pass += 1) {
        let moved = false;
        for (const r of [...rects, ...placed]) {
          if (x0 < r.x1 && x0 + label.targetW > r.x0 && y0 < r.y1 && y0 + label.targetH > r.y0) {
            const up = r.y0 - label.targetH - 4;
            y0 = up >= 8 ? up : r.y1 + 4;
            moved = true;
          }
        }
        if (!moved) break;
      }
      placed.push({ x0, y0, x1: x0 + label.targetW, y1: y0 + label.targetH });
      if (label.x === null) { label.x = x0; label.y = y0; }
      label.x += (x0 - label.x) * smoothing;
      label.y += (y0 - label.y) * smoothing;
      // A bubble that is still growing into place must not hang off the edge on the way.
      label.x = Math.max(4, Math.min(width - label.w - 4, label.x));
      label.y = Math.max(4, Math.min(height - label.h - 4, label.y));
      const wanted = off || kind === 'rest' ? 0 : 1;
      // Out quickly, so a line on its way out never sits on screen as a half faded ghost.
      label.opacity += (wanted - label.opacity) * (wanted < label.opacity ? 1 - Math.exp(-dt * 11) : fading);
      label.node.style.opacity = label.opacity.toFixed(3);
      // Settles into place as it arrives, and sinks back as it goes.
      label.body.style.transform = `translateY(${((1 - label.opacity) * 3).toFixed(2)}px) scale(${(0.97 + label.opacity * 0.03).toFixed(4)})`;
      label.node.style.visibility = label.opacity < 0.01 ? 'hidden' : 'visible';
      label.node.style.transform = `translate3d(${label.x.toFixed(1)}px, ${label.y.toFixed(1)}px, 0)`;
    }
    layoutTags(width, height, placed);
  }

  // Small things that belong to the world: a count by a pile, a "+1" when something lands.
  const tagNodes = new Map();
  const chipNodes = [];
  function layoutTags(width, height, bubbles) {
    if (!showUi) {
      island.drainChips?.();
      return;
    }
    if (!island.tags && !island.drainChips) return;
    if (island.tags) {
      for (const [id, t] of island.tags) {
        let node = tagNodes.get(id);
        if (!node) {
          node = el('div', 'gi-tag', root);
          tagNodes.set(id, node);
        }
        if (node.textContent !== t.text) node.textContent = t.text;
        v.copy(t.pos).project(camera);
        const sx = (v.x * 0.5 + 0.5) * width;
        const sy = (-v.y * 0.5 + 0.5) * height;
        node.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -50%)`;
        const covered = bubbles.some((r) => sx + 30 > r.x0 && sx - 30 < r.x1 && sy + 10 > r.y0 && sy - 10 < r.y1);
        const want = v.z > 1 || covered ? 0 : 1;
        t.alpha = (t.alpha ?? 1) + (want - (t.alpha ?? 1)) * 0.12;
        node.style.opacity = t.alpha.toFixed(3);
      }
    }
    const fresh = island.drainChips ? island.drainChips() : [];
    for (const c of fresh) {
      const node = el('div', 'gi-chip', root);
      node.textContent = c.text;
      chipNodes.push({ node, pos: c.pos, at: clock });
    }
    for (let i = chipNodes.length - 1; i >= 0; i -= 1) {
      const c = chipNodes[i];
      const age = (clock - c.at) / 1.7;
      if (age >= 1) {
        c.node.remove();
        chipNodes.splice(i, 1);
        continue;
      }
      v.copy(c.pos).project(camera);
      const sx = (v.x * 0.5 + 0.5) * width;
      const sy = (-v.y * 0.5 + 0.5) * height - age * 26;
      c.node.style.display = sx < 14 || sx > width - 14 || sy < 14 || sy > height - 14 ? 'none' : '';
      c.node.style.opacity = (age < 0.15 ? age / 0.15 : 1 - smoothstep(0.55, 1, age)).toFixed(3);
      c.node.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
  }

  function layoutMarker(width, height, t) {
    if (marker.hidden) return;
    const anchor = island.main.anchor;
    if (anchor.isVector3) v.copy(anchor);
    else anchor.getWorldPosition(v);
    v.project(camera);
    let sx = (v.x * 0.5 + 0.5) * width;
    let sy = (-v.y * 0.5 + 0.5) * height;
    if (v.z > 1) {
      sx = width / 2;
      sy = 64;
    }
    const w = marker.offsetWidth;
    const h = marker.offsetHeight;
    const gutter = 16;
    // It stays clear of the corner UI, wherever the main building is on screen.
    let top = gutter;
    let bottom = height - gutter;
    if (showUi) {
      for (const panel of [tl, tr]) {
        for (const child of panel.children) {
          if (!child.hidden) top = Math.max(top, child.getBoundingClientRect().bottom + 8);
        }
      }
      for (const child of bl.children) {
        if (!child.hidden) bottom = Math.min(bottom, child.getBoundingClientRect().top - 8);
      }
    }
    const x = Math.min(width - w - gutter, Math.max(gutter, sx - w / 2));
    const y = Math.max(top, Math.min(bottom - h, sy - h - 12));
    marker.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    const p = (Math.sin(t * 3.6) + 1) / 2;
    markerHalo.style.transform = `scale(${(1 + p * 1.5).toFixed(3)})`;
    markerHalo.style.opacity = (0.55 * (1 - p)).toFixed(3);
    approvalsDot.style.opacity = (0.55 + 0.45 * p).toFixed(3);
  }

  renderFeed();
  renderCounts();
  renderPending();
  renderStatus();

  return {
    root,
    showToast(text, seconds = 8) {
      toast.textContent = text;
      toast.hidden = false;
      toastUntil = clock + seconds;
    },
    update(dt, t) {
      clock = t;
      const width = root.clientWidth;
      const height = root.clientHeight;
      layoutMarker(width, height, t);
      layoutLabels(dt, width, height);
      if (status.dataset.state === 'live') {
        statusDot.style.opacity = (0.65 + 0.35 * Math.sin(t * 2.6)).toFixed(3);
      } else {
        statusDot.style.opacity = '1';
      }
      if (!toast.hidden && clock > toastUntil) toast.hidden = true;
      // Fade new feed rows in.
      for (const row of feed.children) {
        const age = t - Number(row.dataset.born);
        if (age < 0.5) {
          row.style.opacity = (age / 0.5).toFixed(3);
          row.style.transform = `translateY(${((1 - age / 0.5) * 6).toFixed(2)}px)`;
        } else if (row.style.opacity !== '1') {
          row.style.opacity = '1';
          row.style.transform = '';
        }
      }
      renderStatus();
      if (Math.floor(t) !== lastAgeRefresh) {
        lastAgeRefresh = Math.floor(t);
        renderCounts();
        const nowValue = nowMs();
        const rows = store.lastEvents(feedExpanded ? FEED_EXPANDED : FEED_COLLAPSED);
        [...feed.children].forEach((row, i) => {
          const age = row.querySelector('.gi-feed-age');
          if (age && rows[i]) age.textContent = ageText(rows[i].ms, nowValue);
        });
      }
      // Only after the person has moved the camera. The automatic pull must not make a button blink.
      overview.hidden = !(rig.mode === 'free' || rig.mode === 'flight');
      const cineText = rig.mode === 'tour' ? 'stop' : 'cinematic';
      if (cinematic.textContent !== cineText) cinematic.textContent = cineText;
      if (debugBox) debugBox.textContent = debugHud(t);
    },
    onLayoutChange() {
      for (const label of labels) label.measured = false;
    },
    dispose() {
      offEvent();
      offReset();
      root.textContent = '';
    },
  };
}
