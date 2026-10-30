(function () {
  'use strict';

  const cfg = window.STOCK_CONFIG || {};
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const QTY_CHIPS = ['None', '1', '2', '3', '4', '5+', '¼', '½'];
  const OPEN = ['requested', 'ordered'];
  const STATUS_LABEL = { requested: 'Requested', ordered: 'Ordered', arrived: 'Arrived', cancelled: 'Cancelled' };

  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) {
    $('#setupBanner').hidden = false;
    return;
  }
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  // ---------- State ----------
  const state = {
    me: null,          // signed-in email
    manager: false,
    items: [],         // all items, active and removed
    open: [],          // open requests
    recent: [],        // arrived in the last 7 days
    photos: {},        // photo_path -> signed URL
    search: '',
    justSent: null,    // request id just raised, for the "how many left?" screen
    history: null,
    historyRange: '90',
    selected: new Set(), // item ids ticked for label printing
    showRemoved: false
  };

  // ---------- Helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function shortName(email) {
    if (!email) return 'Someone';
    if (email === state.me) return 'You';
    const n = email.split('@')[0].split(/[._-]/)[0];
    return n.charAt(0).toUpperCase() + n.slice(1);
  }
  function when(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const dayDiff = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
    if (dayDiff === 0) return 'today ' + time;
    if (dayDiff === 1) return 'yesterday ' + time;
    if (dayDiff < 7) return d.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' + time;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: dayDiff > 300 ? 'numeric' : undefined });
  }
  function dateOnly(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : '2-digit' });
  }
  const itemById = (id) => state.items.find((i) => i.id === id);
  const openFor = (itemId) => state.open.find((r) => r.item_id === itemId);
  const itemLabel = (i) => [i.name, i.size_grade].filter(Boolean).join(' ');
  function reqTitle(r) {
    const i = r.item_id && itemById(r.item_id);
    return i ? itemLabel(i) : (r.note || 'Photo request');
  }
  function appUrl() {
    const u = cfg.appUrl || (location.origin + location.pathname);
    return u.replace(/#.*$/, '');
  }
  function chk({ data, error }) {
    if (error) {
      if (error.code === '23505') { const e = new Error('Someone has already asked for this. It\'s on the Open list.'); e.duplicate = true; throw e; }
      if (error.code === '42501') throw new Error(error.message || 'You\'re not allowed to do that.');
      throw new Error(error.message);
    }
    return data;
  }
  function showError(msg) {
    const b = $('#errorBanner');
    b.textContent = msg;
    b.hidden = !msg;
    if (msg) window.scrollTo(0, 0);
  }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
  }
  async function busy(btn, fn) {
    if (btn) btn.disabled = true;
    try { showError(''); await fn(); } catch (e) { showError(e.message); } finally { if (btn) btn.disabled = false; }
  }
  function closeOn(dialog) {
    $$('[data-close]', dialog).forEach((b) => b.addEventListener('click', () => dialog.close()));
  }

  // ---------- Data ----------
  async function load() {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const [items, open, recent, mgr] = await Promise.all([
      sb.from('stock_items').select('*').order('name').order('size_grade'),
      sb.from('stock_requests').select('*').in('status', OPEN).order('requested_at'),
      sb.from('stock_requests').select('*').eq('status', 'arrived').gte('arrived_at', weekAgo).order('arrived_at', { ascending: false }),
      sb.from('stock_managers').select('email').eq('email', state.me).maybeSingle()
    ]);
    state.items = chk(items);
    state.open = chk(open);
    state.recent = chk(recent);
    state.manager = Boolean(chk(mgr));
    await loadPhotos(state.open.concat(state.recent));
  }
  async function loadPhotos(rows) {
    const paths = rows.map((r) => r.photo_path).filter((p) => p && !state.photos[p]);
    if (!paths.length) return;
    const { data } = await sb.storage.from('stock-photos').createSignedUrls(paths, 60 * 60 * 4);
    (data || []).forEach((d) => { if (d.signedUrl) state.photos[d.path] = d.signedUrl; });
  }
  async function refresh() {
    try { await load(); showError(''); render(); } catch (e) { showError('Could not load: ' + e.message); }
  }

  async function raise(itemId, urgency) {
    const row = chk(await sb.from('stock_requests').insert({ item_id: itemId, urgency }).select().single());
    state.open.push(row);
    return row;
  }
  async function updateRequest(id, fields) {
    const row = chk(await sb.from('stock_requests').update(fields).eq('id', id).select().single());
    const swap = (list) => list.map((r) => (r.id === id ? row : r));
    state.open = swap(state.open).filter((r) => OPEN.includes(r.status));
    if (row.status === 'arrived') state.recent.unshift(row);
    return row;
  }

  // ---------- Photo resize (keeps uploads quick on workshop wifi) ----------
  function shrink(file, max) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read that photo'))), 'image/jpeg', 0.8);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that photo')); };
      img.src = url;
    });
  }

  // ---------- Routing ----------
  function route() {
    const h = location.hash.replace(/^#/, '');
    if (h.startsWith('item=')) return { tab: 'request', item: h.slice(5) };
    if (h === 'sent') return { tab: 'request', sent: true };
    if (['open', 'history', 'items'].includes(h)) return { tab: h };
    return { tab: 'request' };
  }

  function render() {
    const r = route();
    if (r.tab === 'items' && !state.manager) { location.hash = '#request'; return; }
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === r.tab));
    $('#itemsTab').hidden = !state.manager;
    $('#alertsBtn').hidden = !state.manager;
    const n = state.open.length;
    $('#openCount').textContent = n ? n : '';
    const el = $('#content');
    if (r.item) el.innerHTML = renderItem(r.item);
    else if (r.sent) el.innerHTML = renderSent();
    else if (r.tab === 'open') el.innerHTML = renderOpen();
    else if (r.tab === 'history') { el.innerHTML = renderHistory(); if (!state.history) loadHistory(); }
    else if (r.tab === 'items') el.innerHTML = renderItems();
    else el.innerHTML = renderRequest();
  }

  // ---------- Request tab: pick an item ----------
  function itemRows() {
    const active = state.items.filter((i) => i.active);
    const q = state.search.trim().toLowerCase();
    const list = q ? active.filter((i) => (i.name + ' ' + i.size_grade + ' ' + i.supplier).toLowerCase().includes(q)) : active;
    const rows = list.map((i) => {
      const o = openFor(i.id);
      const badge = o ? `<span class="badge ${o.status}">${STATUS_LABEL[o.status]}</span>` : '<span class="chev" aria-hidden="true">›</span>';
      return `<a class="item-row${o ? ' has-open' : ''}" href="#item=${i.id}">
        <span class="item-text"><b>${esc(i.name)}</b>${i.size_grade ? `<span class="muted"> ${esc(i.size_grade)}</span>` : ''}</span>${badge}</a>`;
    }).join('');
    return rows || `<p class="empty">${active.length ? 'Nothing matches.' : 'No items yet.' + (state.manager ? ' Add some on the Items tab.' : '')}</p>`;
  }
  function renderRequest() {
    return `
      <button class="btn btn-photo btn-block btn-big" type="button" data-action="photo">
        ${cameraIcon()} No label? Take a photo
      </button>
      <input id="search" class="search" type="search" placeholder="Find an item" autocomplete="off" enterkeyhint="search" value="${esc(state.search)}">
      <div class="item-list" id="itemList">${itemRows()}</div>
      <p class="muted small center">Tip: scan the QR label on the shelf with your phone camera to go straight to an item.</p>`;
  }
  function cameraIcon() {
    return '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4 7.2 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3.2L15 4H9Zm3 4.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z" fill="currentColor"/></svg>';
  }

  // ---------- One item (where a QR label lands) ----------
  function renderItem(id) {
    const i = itemById(id);
    if (!i) return `<div class="panel"><h2>Item not found</h2><p>This label may be for an item that's been removed.</p>
      <a class="btn btn-block btn-big" href="#request">See all items</a></div>`;
    const o = openFor(id);
    const facts = [
      i.supplier && `<div><span class="muted">Supplier</span> ${esc(i.supplier)}</div>`,
      i.order_qty && `<div><span class="muted">Usual order</span> ${esc(i.order_qty)}</div>`,
      i.notes && `<div class="muted small">${esc(i.notes)}</div>`
    ].filter(Boolean).join('');
    let body;
    if (!i.active) {
      body = '<p class="warn">This item has been removed from the list. Ask the parts manager.</p>';
    } else if (o) {
      body = `<div class="already ${o.status}">
          <div class="already-head">Already asked for</div>
          ${progress(o)}
          ${o.qty_left ? `<div>Left: <b>${esc(o.qty_left)}</b></div>` : ''}
          ${o.urgency === 'urgent' ? '<div><span class="badge urgent">Urgent</span></div>' : ''}
        </div>
        <div class="big-actions">
          ${o.urgency === 'normal' ? `<button class="btn btn-urgent btn-huge" type="button" data-action="bump" data-id="${o.id}">Make it urgent</button>` : ''}
          ${o.requested_by === state.me && o.status === 'requested' ? `<button class="btn btn-big" type="button" data-action="cancel" data-id="${o.id}">Cancel my request</button>` : ''}
        </div>`;
    } else {
      const last = state.recent.find((r) => r.item_id === id);
      body = `<div class="big-actions">
          <button class="btn btn-primary btn-huge" type="button" data-action="low" data-id="${id}">Running low</button>
          <button class="btn btn-urgent btn-huge" type="button" data-action="urgent" data-id="${id}">Urgent: run out</button>
        </div>
        ${last ? `<p class="muted small center">Last arrived ${esc(when(last.arrived_at))}</p>` : ''}`;
    }
    return `<a class="back" href="#request">‹ All items</a>
      <div class="panel item-panel">
        <h2 class="item-name">${esc(i.name)}</h2>
        ${i.size_grade ? `<div class="item-size">${esc(i.size_grade)}</div>` : ''}
        <div class="facts">${facts}</div>
        ${body}
      </div>`;
  }

  function progress(r) {
    const steps = [
      ['requested', 'Requested', r.requested_by, r.requested_at],
      ['ordered', 'Ordered', r.ordered_by, r.ordered_at],
      ['arrived', 'Arrived', r.arrived_by, r.arrived_at]
    ];
    return '<ol class="steps">' + steps.map(([k, label, by, at]) =>
      `<li class="${at ? 'done' : ''}${r.status === k ? ' now' : ''}"><b>${label}</b>${at ? `<span>${esc(shortName(by))}, ${esc(when(at))}</span>` : ''}</li>`
    ).join('') + '</ol>';
  }

  // ---------- Sent: optional quantity left ----------
  function renderSent() {
    const r = state.open.find((x) => x.id === state.justSent);
    if (!r) return `<div class="panel center"><p>Done.</p><a class="btn btn-primary btn-block btn-big" href="#request">Back to items</a></div>`;
    const chips = QTY_CHIPS.map((q) =>
      `<button class="chip-btn${r.qty_left === q ? ' on' : ''}" type="button" data-action="qty" data-id="${r.id}" data-qty="${esc(q)}">${esc(q)}</button>`).join('');
    return `<div class="panel sent">
        <div class="tick" aria-hidden="true">✓</div>
        <h2>Sent to parts</h2>
        <p class="sent-what">${esc(reqTitle(r))}${r.urgency === 'urgent' ? ' <span class="badge urgent">Urgent</span>' : ''}</p>
        <h3>How many left? <span class="muted">(optional)</span></h3>
        <div class="chips">${chips}</div>
        <a class="btn btn-primary btn-block btn-huge" href="#request">Done</a>
      </div>`;
  }

  // ---------- Open requests ----------
  function requestCard(r, { showActions }) {
    const i = r.item_id && itemById(r.item_id);
    const photo = r.photo_path && state.photos[r.photo_path];
    const mine = r.requested_by === state.me;
    let actions = '';
    if (showActions) {
      const b = [];
      if (state.manager) {
        if (r.status === 'requested') b.push(`<button class="btn btn-primary" type="button" data-action="ordered" data-id="${r.id}">Ordered</button>`);
        if (r.status === 'ordered') b.push(`<button class="btn btn-primary" type="button" data-action="arrived" data-id="${r.id}">Arrived</button>`);
        if (!r.item_id) b.push(`<button class="btn" type="button" data-action="makeitem" data-id="${r.id}">Add to stock list</button>`);
        if (r.status === 'ordered') b.push(`<button class="btn-link" type="button" data-action="unorder" data-id="${r.id}">Not ordered yet</button>`);
        b.push(`<button class="btn-link" type="button" data-action="cancel" data-id="${r.id}">Cancel</button>`);
      } else {
        if (r.urgency === 'normal') b.push(`<button class="btn btn-urgent-outline" type="button" data-action="bump" data-id="${r.id}">Make urgent</button>`);
        if (mine && r.status === 'requested') b.push(`<button class="btn" type="button" data-action="cancel" data-id="${r.id}">Cancel mine</button>`);
      }
      actions = b.length ? `<div class="card-actions">${b.join('')}</div>` : '';
    }
    const info = [
      i && i.supplier ? esc(i.supplier) : '',
      i && i.order_qty ? 'usual ' + esc(i.order_qty) : '',
      r.qty_ordered ? 'ordered ' + esc(r.qty_ordered) : ''
    ].filter(Boolean).join(' · ');
    return `<div class="card ${r.urgency === 'urgent' && OPEN.includes(r.status) ? 'urgent' : r.status}">
      <div class="card-head">
        ${photo ? `<button class="thumb" type="button" data-action="bigphoto" data-src="${esc(photo)}"><img src="${esc(photo)}" alt="Photo"></button>` : ''}
        <div class="card-main">
          <div class="card-title">${esc(i ? i.name : (r.note || 'Photo request'))}${i && i.size_grade ? ` <span class="muted">${esc(i.size_grade)}</span>` : ''}</div>
          ${i && r.note ? `<div class="small">${esc(r.note)}</div>` : ''}
          ${info ? `<div class="small muted">${info}</div>` : ''}
          ${r.qty_left ? `<div class="small">Left: <b>${esc(r.qty_left)}</b></div>` : ''}
        </div>
        <div class="badges">
          ${r.urgency === 'urgent' && OPEN.includes(r.status) ? '<span class="badge urgent">Urgent</span>' : ''}
          <span class="badge ${r.status}">${STATUS_LABEL[r.status]}</span>
        </div>
      </div>
      <div class="who small muted">
        ${esc(shortName(r.requested_by))} asked ${esc(when(r.requested_at))}
        ${r.ordered_at ? ` · ordered ${esc(when(r.ordered_at))}` : ''}
        ${r.arrived_at ? ` · arrived ${esc(when(r.arrived_at))}` : ''}
      </div>
      ${actions}
    </div>`;
  }

  function renderOpen() {
    const sorted = state.open.slice().sort((a, b) =>
      (a.urgency === 'urgent' ? 0 : 1) - (b.urgency === 'urgent' ? 0 : 1) ||
      (a.status === 'requested' ? 0 : 1) - (b.status === 'requested' ? 0 : 1) ||
      a.requested_at.localeCompare(b.requested_at));
    const waiting = sorted.filter((r) => r.status === 'requested');
    const ordered = sorted.filter((r) => r.status === 'ordered');
    const section = (title, list, empty) => `<h3 class="section">${title} <span class="muted">${list.length}</span></h3>
      <div class="list">${list.length ? list.map((r) => requestCard(r, { showActions: true })).join('') : `<p class="empty">${empty}</p>`}</div>`;
    return section('To order', waiting, 'Nothing waiting to be ordered.') +
      section('On order', ordered, 'Nothing on order.') +
      (state.recent.length ? `<h3 class="section">Arrived this week</h3><div class="list">${state.recent.map((r) => requestCard(r, { showActions: false })).join('')}</div>` : '');
  }

  // ---------- History ----------
  async function loadHistory() {
    try {
      let q = sb.from('stock_requests').select('*').order('requested_at', { ascending: false }).limit(5000);
      if (state.historyRange !== 'all') q = q.gte('requested_at', new Date(Date.now() - Number(state.historyRange) * 86400000).toISOString());
      state.history = chk(await q);
      if (route().tab === 'history') render();
    } catch (e) { showError('Could not load history: ' + e.message); }
  }

  function historyStats(rows) {
    const by = new Map();
    rows.filter((r) => r.status !== 'cancelled').forEach((r) => {
      const key = r.item_id || 'photo';
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(r);
    });
    return Array.from(by.entries()).map(([key, list]) => {
      const dates = list.map((r) => new Date(r.requested_at).getTime()).sort((a, b) => a - b);
      const gap = dates.length > 1 ? Math.round((dates[dates.length - 1] - dates[0]) / 86400000 / (dates.length - 1)) : null;
      const i = key !== 'photo' && itemById(key);
      return {
        key, name: key === 'photo' ? 'Photo requests (no label)' : i ? itemLabel(i) : 'Unknown item',
        supplier: i ? i.supplier : '', times: list.length,
        urgent: list.filter((r) => r.urgency === 'urgent').length,
        last: dates[dates.length - 1], gap
      };
    }).sort((a, b) => b.times - a.times || a.name.localeCompare(b.name));
  }

  function renderHistory() {
    const seg = [['90', '3 months'], ['365', '12 months'], ['all', 'All']].map(([v, l]) =>
      `<button class="seg-btn${state.historyRange === v ? ' active' : ''}" type="button" data-action="range" data-range="${v}">${l}</button>`).join('');
    if (!state.history) return `<div class="seg">${seg}</div><p class="empty">Loading…</p>`;
    const rows = state.history;
    const stats = historyStats(rows);
    const table = stats.length ? `<div class="table-wrap"><table class="stats">
        <thead><tr><th>Item</th><th>Times</th><th>Every</th><th>Urgent</th><th>Last</th></tr></thead>
        <tbody>${stats.map((s) => `<tr><td>${esc(s.name)}${s.supplier ? `<div class="small muted">${esc(s.supplier)}</div>` : ''}</td>
          <td class="num">${s.times}</td><td class="num">${s.gap == null ? '–' : s.gap + ' days'}</td>
          <td class="num">${s.urgent || ''}</td><td>${esc(dateOnly(s.last))}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="empty">No requests in this period.</p>';
    const recent = rows.slice(0, 100).map((r) => `<tr><td>${esc(dateOnly(r.requested_at))}</td><td>${esc(reqTitle(r))}</td>
        <td>${esc(shortName(r.requested_by))}</td><td><span class="badge ${r.status}">${STATUS_LABEL[r.status]}</span>${r.urgency === 'urgent' ? ' <span class="badge urgent">Urgent</span>' : ''}</td></tr>`).join('');
    return `<div class="seg">${seg}</div>
      <p class="muted small">${rows.length} requests. "Every" is the average gap between requests. Cancelled ones aren't counted.</p>
      ${table}
      <button class="btn btn-block" type="button" data-action="csv">Download as spreadsheet (CSV)</button>
      <h3 class="section">Latest requests</h3>
      <div class="table-wrap"><table class="stats log"><thead><tr><th>Date</th><th>Item</th><th>Who</th><th>Status</th></tr></thead><tbody>${recent}</tbody></table></div>
      ${rows.length > 100 ? '<p class="muted small">Showing the latest 100. The download has them all.</p>' : ''}`;
  }

  function downloadCsv() {
    const cell = (v) => {
      let s = String(v == null ? '' : v);
      if (/^[=+\-@]/.test(s)) s = "'" + s; // stop spreadsheet formulas sneaking in
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const fmt = (ts) => (ts ? new Date(ts).toLocaleString('en-GB') : '');
    const head = ['Requested', 'Item', 'Size/grade', 'Supplier', 'Note', 'Qty left', 'Urgency', 'Status', 'Qty ordered', 'Asked by', 'Ordered', 'Ordered by', 'Arrived', 'Cancelled'];
    const lines = [head.map(cell).join(',')].concat(state.history.map((r) => {
      const i = r.item_id && itemById(r.item_id);
      return [fmt(r.requested_at), i ? i.name : '(photo)', i ? i.size_grade : '', i ? i.supplier : '', r.note, r.qty_left, r.urgency,
        r.status, r.qty_ordered, r.requested_by, fmt(r.ordered_at), r.ordered_by, fmt(r.arrived_at), fmt(r.cancelled_at)].map(cell).join(',');
    }));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'stock-requests-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------- Items (managers) ----------
  function renderItems() {
    const active = state.items.filter((i) => i.active);
    const removed = state.items.filter((i) => !i.active);
    const n = state.selected.size;
    const row = (i) => `<div class="item-admin">
        ${i.active ? `<label class="tickbox"><input type="checkbox" data-select="${i.id}" ${state.selected.has(i.id) ? 'checked' : ''}><span class="sr">Select for labels</span></label>` : ''}
        <div class="item-admin-text"><b>${esc(i.name)}</b>${i.size_grade ? ` <span class="muted">${esc(i.size_grade)}</span>` : ''}
          <div class="small muted">${[i.supplier, i.order_qty && 'usual ' + i.order_qty].filter(Boolean).map(esc).join(' · ')}</div></div>
        ${i.active
          ? `<button class="btn btn-small" type="button" data-action="edit" data-id="${i.id}">Edit</button>`
          : `<button class="btn btn-small" type="button" data-action="restore" data-id="${i.id}">Put back</button>`}
      </div>`;
    return `<button class="btn btn-primary btn-block btn-big" type="button" data-action="add">+ Add item</button>
      <div class="label-bar">
        <label class="check"><input type="checkbox" data-action="selectall" ${n && n === active.length ? 'checked' : ''}> Select all</label>
        <button class="btn btn-grow" type="button" data-action="print" ${n ? '' : 'disabled'}>Print ${n || ''} label${n === 1 ? '' : 's'}</button>
      </div>
      <p class="muted small">Labels print 21 to an A4 sheet (63.5 × 38.1 mm, the common "L7160" layout). In the print box, set margins to None and scale to 100%.</p>
      <div class="admin-list">${active.map(row).join('') || '<p class="empty">No items yet.</p>'}</div>
      ${removed.length ? `<button class="btn-link" type="button" data-action="toggleremoved">${state.showRemoved ? 'Hide' : 'Show'} removed items (${removed.length})</button>
        ${state.showRemoved ? `<div class="admin-list">${removed.map(row).join('')}</div>` : ''}` : ''}`;
  }

  let editingId = null;
  let linkRequestId = null;
  function openItemForm(item, prefill) {
    const f = $('#itemForm');
    f.reset();
    editingId = item ? item.id : null;
    $('[data-title]', f).textContent = item ? 'Edit item' : 'Add item';
    $('[data-archive]', f).hidden = !item;
    $('[data-error]', f).textContent = '';
    const v = item || prefill || {};
    ['name', 'size_grade', 'supplier', 'order_qty', 'notes'].forEach((k) => { f.elements[k].value = v[k] || ''; });
    const suppliers = Array.from(new Set(state.items.map((i) => i.supplier).filter(Boolean))).sort();
    $('#supplierList').innerHTML = suppliers.map((s) => `<option value="${esc(s)}">`).join('');
    $('#itemDialog').showModal();
  }

  async function saveItem(e) {
    e.preventDefault();
    const f = e.target;
    const fields = {};
    ['name', 'size_grade', 'supplier', 'order_qty', 'notes'].forEach((k) => { fields[k] = f.elements[k].value.trim(); });
    if (!fields.name) return;
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      if (editingId) {
        chk(await sb.from('stock_items').update(fields).eq('id', editingId));
      } else {
        const row = chk(await sb.from('stock_items').insert(fields).select().single());
        if (linkRequestId) await updateRequest(linkRequestId, { item_id: row.id });
      }
      $('#itemDialog').close();
      linkRequestId = null;
      await refresh();
      toast('Saved');
    } catch (err) {
      $('[data-error]', f).textContent = err.message;
    } finally { btn.disabled = false; }
  }

  // ---------- Labels ----------
  function qrSvg(text) {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }
  function printLabels(ids) {
    const base = appUrl();
    const items = ids.map(itemById).filter(Boolean);
    const label = (i) => `<div class="label">
        <div class="label-qr">${qrSvg(base + '#item=' + i.id)}</div>
        <div class="label-text">
          <div class="label-name">${esc(i.name)}</div>
          ${i.size_grade ? `<div class="label-size">${esc(i.size_grade)}</div>` : ''}
          <div class="label-hint">Scan when running low</div>
          <div class="label-brand">Japex Automotive</div>
        </div></div>`;
    let html = '';
    for (let n = 0; n < items.length; n += 21) html += '<div class="sheet-a4">' + items.slice(n, n + 21).map(label).join('') + '</div>';
    $('#printArea').innerHTML = html;
    document.body.classList.add('printing');
    setTimeout(() => window.print(), 50);
  }
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('printing');
    $('#printArea').innerHTML = '';
  });

  // ---------- Phone alerts (managers) ----------
  const isIos = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  function b64uToBytes(s) {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  async function currentSub() {
    if (!('serviceWorker' in navigator)) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg && reg.pushManager ? reg.pushManager.getSubscription() : null;
  }
  async function renderAlerts() {
    const box = $('#alertsBody');
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!cfg.vapidPublicKey) {
      box.innerHTML = '<p>Phone alerts aren\'t set up yet. See "Phone alerts" in the README.</p>';
      return;
    }
    if (isIos && !isStandalone) {
      box.innerHTML = `<p><b>On iPhone, alerts only work from the Home Screen app.</b></p>
        <ol class="howto"><li>Open this page in <b>Safari</b>.</li><li>Tap the <b>Share</b> button (square with an arrow).</li>
        <li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li><li>Open <b>Stock</b> from your Home Screen, sign in, and tap Alerts again.</li></ol>
        <p class="muted small">Needs iOS 16.4 or newer.</p>`;
      return;
    }
    if (!supported) {
      box.innerHTML = '<p>This browser can\'t do phone alerts. On iPhone use the Home Screen app; on Android use Chrome.</p>';
      return;
    }
    const sub = await currentSub();
    const perm = Notification.permission;
    if (perm === 'denied') {
      box.innerHTML = `<p><b>Alerts are blocked on this phone.</b></p>
        <p>${isIos ? 'Go to <b>Settings › Notifications › Stock</b> and turn on Allow Notifications, then come back here.' : 'Allow notifications for this site in your browser settings, then come back here.'}</p>`;
      return;
    }
    box.innerHTML = sub && perm === 'granted'
      ? `<p class="ok"><b>Alerts are on for this phone.</b></p>
         <div class="big-actions"><button class="btn btn-primary btn-big" type="button" data-alert="test">Send a test</button>
         <button class="btn btn-big" type="button" data-alert="off">Turn off on this phone</button></div>`
      : `<p>Get a notification on this phone every time someone asks for stock.</p>
         <div class="big-actions"><button class="btn btn-primary btn-huge" type="button" data-alert="on">Turn on alerts</button></div>`;
  }
  async function alertAction(kind, btn) {
    const err = $('#alertsDialog [data-error]');
    err.textContent = '';
    btn.disabled = true;
    try {
      if (kind === 'on') {
        // Must be the first thing in the tap, or iPhone ignores the request.
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') throw new Error('Notifications weren\'t allowed.');
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(cfg.vapidPublicKey) });
        const j = sub.toJSON();
        chk(await sb.from('stock_push_subs').upsert({
          endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, device: navigator.userAgent.slice(0, 200)
        }, { onConflict: 'endpoint' }));
        toast('Alerts on');
      } else if (kind === 'off') {
        const sub = await currentSub();
        if (sub) {
          await sb.from('stock_push_subs').delete().eq('endpoint', sub.endpoint);
          await sub.unsubscribe();
        }
        toast('Alerts off');
      } else if (kind === 'test') {
        const { data, error } = await sb.functions.invoke('notify-request', { body: { test: true } });
        if (error) throw new Error('Test failed: ' + error.message);
        toast('Test sent');
        err.textContent = 'Phone: ' + (data.push || '?') + '. Email: ' + (data.email || '?') + '.';
      }
    } catch (e) {
      err.textContent = e.message;
    } finally {
      btn.disabled = false;
      await renderAlerts();
    }
  }

  // ---------- Actions ----------
  let photoBlob = null;
  async function act(btn) {
    const a = btn.dataset.action;
    const id = btn.dataset.id;
    if (a === 'photo') { $('#photoInput').value = ''; $('#photoInput').click(); return; }
    if (a === 'bigphoto') { $('#bigPhoto').src = btn.dataset.src; $('#bigPhotoDialog').showModal(); return; }
    if (a === 'range') { state.historyRange = btn.dataset.range; state.history = null; render(); return; }
    if (a === 'csv') { downloadCsv(); return; }
    if (a === 'add') { linkRequestId = null; openItemForm(null); return; }
    if (a === 'edit') { linkRequestId = null; openItemForm(itemById(id)); return; }
    if (a === 'toggleremoved') { state.showRemoved = !state.showRemoved; render(); return; }
    if (a === 'print') { printLabels(Array.from(state.selected)); return; }
    if (a === 'makeitem') {
      const r = state.open.find((x) => x.id === id);
      linkRequestId = id;
      openItemForm(null, { name: r ? r.note : '' });
      return;
    }
    if (a === 'ordered') {
      const r = state.open.find((x) => x.id === id);
      const i = r && r.item_id && itemById(r.item_id);
      const f = $('#orderForm');
      f.dataset.id = id;
      $('[data-title]', f).textContent = 'Ordered: ' + reqTitle(r);
      $('[data-sub]', f).textContent = i && i.supplier ? 'From ' + i.supplier : '';
      f.elements.qty_ordered.value = (i && i.order_qty) || '';
      $('[data-error]', f).textContent = '';
      $('#orderDialog').showModal();
      return;
    }
    await busy(btn, async () => {
      if (a === 'low' || a === 'urgent') {
        try {
          const row = await raise(id, a === 'urgent' ? 'urgent' : 'normal');
          state.justSent = row.id;
          location.hash = '#sent';
        } catch (e) {
          if (e.duplicate) { await load(); render(); toast('Already asked for'); return; }
          throw e;
        }
      } else if (a === 'qty') {
        await updateRequest(id, { qty_left: btn.dataset.qty });
        render();
        toast('Saved');
      } else if (a === 'bump') {
        await updateRequest(id, { urgency: 'urgent' });
        render();
        toast('Marked urgent');
      } else if (a === 'cancel') {
        if (!confirm('Cancel this request?')) return;
        await updateRequest(id, { status: 'cancelled' });
        render();
        toast('Cancelled');
      } else if (a === 'arrived') {
        await updateRequest(id, { status: 'arrived' });
        render();
        toast('Marked arrived');
      } else if (a === 'unorder') {
        await updateRequest(id, { status: 'requested' });
        render();
      } else if (a === 'restore') {
        chk(await sb.from('stock_items').update({ active: true }).eq('id', id));
        await refresh();
      }
    });
  }

  // ---------- Wiring ----------
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b && b.tagName !== 'INPUT') { e.preventDefault(); act(b); }
    const al = e.target.closest('[data-alert]');
    if (al) alertAction(al.dataset.alert, al);
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.select) {
      if (t.checked) state.selected.add(t.dataset.select); else state.selected.delete(t.dataset.select);
      render();
    } else if (t.dataset.action === 'selectall') {
      state.selected = new Set(t.checked ? state.items.filter((i) => i.active).map((i) => i.id) : []);
      render();
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'search') {
      state.search = e.target.value;
      $('#itemList').innerHTML = itemRows();
    }
  });

  $('#photoInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      photoBlob = await shrink(file, 1600);
      const f = $('#photoForm');
      f.reset();
      $('[data-error]', f).textContent = '';
      $('#photoPreview').src = URL.createObjectURL(photoBlob);
      if (!$('#photoDialog').open) $('#photoDialog').showModal();
    } catch (err) { showError(err.message); }
  });
  $('#retakeBtn').addEventListener('click', () => { $('#photoInput').value = ''; $('#photoInput').click(); });
  $('#photoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const urgency = e.submitter && e.submitter.value === 'urgent' ? 'urgent' : 'normal';
    const buttons = $$('button', f);
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const d = new Date();
      const path = d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2)) + '.jpg';
      const up = await sb.storage.from('stock-photos').upload(path, photoBlob, { contentType: 'image/jpeg' });
      if (up.error) throw new Error('Photo upload failed: ' + up.error.message);
      const row = chk(await sb.from('stock_requests').insert({ photo_path: path, note: f.elements.note.value.trim(), urgency }).select().single());
      state.open.push(row);
      state.photos[path] = $('#photoPreview').src;
      state.justSent = row.id;
      $('#photoDialog').close();
      location.hash = '#sent';
    } catch (err) {
      $('[data-error]', f).textContent = err.message;
    } finally { buttons.forEach((b) => { b.disabled = false; }); }
  });

  $('#orderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await updateRequest(f.dataset.id, { status: 'ordered', qty_ordered: f.elements.qty_ordered.value.trim() });
      $('#orderDialog').close();
      render();
      toast('Marked ordered');
    } catch (err) { $('[data-error]', f).textContent = err.message; } finally { btn.disabled = false; }
  });

  $('#itemForm').addEventListener('submit', saveItem);
  $('#itemForm [data-archive]').addEventListener('click', async () => {
    if (!editingId || !confirm('Remove this item from the list? Its history is kept, and you can put it back later.')) return;
    try {
      chk(await sb.from('stock_items').update({ active: false }).eq('id', editingId));
      state.selected.delete(editingId);
      $('#itemDialog').close();
      await refresh();
    } catch (err) { $('#itemForm [data-error]').textContent = err.message; }
  });

  ['#photoDialog', '#orderDialog', '#itemDialog', '#alertsDialog'].forEach((d) => closeOn($(d)));
  $('#alertsBtn').addEventListener('click', async () => {
    $('#alertsDialog [data-error]').textContent = '';
    $('#alertsBody').innerHTML = '<p class="muted">Checking…</p>';
    $('#alertsDialog').showModal();
    await renderAlerts();
  });
  $('#refreshBtn').addEventListener('click', () => busy($('#refreshBtn'), async () => { await load(); render(); }));
  $('#signOutBtn').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });

  window.addEventListener('hashchange', () => {
    if (!state.me) return;
    if (route().tab === 'history') state.history = null; // always fresh when you open it
    render();
    window.scrollTo(0, 0);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.me) refresh(); });
  setInterval(() => { if (!document.hidden && state.me && !document.querySelector('dialog[open]') && document.activeElement.tagName !== 'INPUT') refresh(); }, 60000);

  // ---------- Sign in ----------
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button');
    btn.disabled = true;
    $('#loginMsg').textContent = '';
    const { error } = await sb.auth.signInWithPassword({ email: f.elements.email.value.trim(), password: f.elements.password.value });
    btn.disabled = false;
    if (error) { $('#loginMsg').textContent = error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message; return; }
    start();
  });

  async function start() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      $('#loginView').hidden = false;
      $('#mainView').hidden = true;
      return;
    }
    state.me = (session.user.email || '').toLowerCase();
    $('#loginView').hidden = true;
    $('#mainView').hidden = false;
    $('#whoAmI').textContent = 'Signed in as ' + state.me;
    $('#refreshBtn').hidden = false;
    $('#content').innerHTML = '<p class="empty">Loading…</p>';
    await refresh();
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* alerts just won't be offered */ });
  start();
})();
