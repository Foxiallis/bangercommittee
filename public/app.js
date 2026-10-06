(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(3, '0');

  const store = {
    get(key) { try { return localStorage.getItem('bc.' + key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem('bc.' + key, value); } catch {} },
    del(key) { try { localStorage.removeItem('bc.' + key); } catch {} },
  };

  const params = new URLSearchParams(location.search);
  const clientId = store.get('clientId') || (() => {
    const id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
    store.set('clientId', id);
    return id;
  })();

  const ICON = {
    crown: '<svg viewBox="0 0 24 24" aria-label="Host"><path d="M2.500 7.500 7 11l5-7 5 7 4.500-3.500L19.500 18h-15z"/><rect x="4.500" y="19.500" width="15" height="2" rx="1"/></svg>',
    for: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.500 9.500 18 20 6.500"/></svg>',
    against: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    abstain: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',
    soundOn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.500 8.500a5 5 0 0 1 0 7M19.500 6a8.500 8.500 0 0 1 0 12"/></svg>',
    soundOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="m17 9.500 5 5m0-5-5 5"/></svg>',
  };
  const VOTES = [['for', 'For'], ['against', 'Against'], ['abstain', 'Abstain']];
  const COLUMNS = [...VOTES, ['wait', "Didn't vote"]];
  const STAMP_HOLD_MS = 1600;

  const el = {
    landing: $('#landing'), lobby: $('#lobby'),
    stepDoor: $('#step-door'), stepName: $('#step-name'),
    joinForm: $('#join-form'), codeInput: $('#code-input'), createBtn: $('#create-btn'),
    nameInput: $('#name-input'), nameLabel: $('#name-label'), nameBack: $('#name-back'),
    landingError: $('#landing-error'),
    codeChip: $('#code-chip'), codeChipCode: $('#code-chip-code'), soundBtn: $('#sound-btn'), leaveBtn: $('#leave-btn'),
    members: $('#members'), membersCount: $('#members-count'),
    submitForm: $('#submit-form'), submitInput: $('#submit-input'), submitBtn: $('#submit-form button'),
    offline: $('#offline'),
    motion: $('#motion'), ballot: $('#ballot'), tally: $('#tally'), chair: $('#chair'),
    queue: $('#queue'), queueCount: $('#queue-count'),
    history: $('#history'), historyCount: $('#history-count'), copyAccepted: $('#copy-accepted'),
    toasts: $('#toasts'), datelineCount: $('#dateline-count'),
  };

  let transport = null;
  let state = null;
  let pending = null;       // what the name step will do: { mode: 'create' } or { mode: 'join', code }
  let heldState = null;     // newest state received while a verdict stamp is on screen
  let holding = false;
  let shownUid = null;      // track currently rendered in the motion card
  let seenVotes = new Set();

  // ───────────── landing ─────────────

  function showDoor(error = '') {
    el.lobby.hidden = true;
    el.landing.hidden = false;
    el.stepName.hidden = true;
    el.stepDoor.hidden = false;
    el.landingError.textContent = error;
  }

  function showNameStep() {
    el.landingError.textContent = '';
    el.stepDoor.hidden = true;
    el.stepName.hidden = false;
    el.nameLabel.textContent = pending.mode === 'create'
      ? 'You will chair this lobby — state your name'
      : `Joining lobby ${pending.code} — state your name`;
    el.nameInput.value = store.get('name') || '';
    el.nameInput.focus();
    el.nameInput.select();
  }

  el.codeInput.addEventListener('input', () => {
    el.codeInput.value = el.codeInput.value.replace(/[^a-z]/gi, '').toUpperCase().slice(0, 4);
    el.landingError.textContent = '';
  });

  el.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = el.codeInput.value;
    if (code.length !== 4) {
      el.landingError.textContent = 'A lobby code is four letters.';
      return;
    }
    pending = { mode: 'join', code };
    showNameStep();
  });

  el.createBtn.addEventListener('click', () => {
    pending = { mode: 'create' };
    showNameStep();
  });

  el.nameBack.addEventListener('click', () => showDoor());

  el.stepName.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = el.nameInput.value.trim().replace(/\s+/g, ' ');
    if (!name) {
      el.landingError.textContent = 'The record needs a name.';
      return;
    }
    store.set('name', name);
    enter(name);
  });

  function enter(name) {
    connect();
    transport.send({ t: pending.mode, code: pending.code, name, clientId });
  }

  // ───────────── connection ─────────────

  // A WebSocket that reconnects by itself and re-announces who we are each time.
  function createSocketTransport() {
    let ws = null;
    let retry = null;
    let attempts = 0;
    let closed = false;
    const api = {
      hello: null,
      onmessage() {},
      onstatus() {},
      send(msg) {
        if (msg.t === 'create' || msg.t === 'join') api.hello = msg;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      close() {
        closed = true;
        clearTimeout(retry);
        ws.close();
      },
    };
    (function open() {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => {
        attempts = 0;
        api.onstatus(true);
        if (api.hello) ws.send(JSON.stringify(api.hello));
      };
      ws.onmessage = (e) => api.onmessage(JSON.parse(e.data));
      ws.onclose = () => {
        if (closed) return;
        api.onstatus(false);
        retry = setTimeout(open, Math.min(5000, 500 * 2 ** attempts++));
      };
    })();
    return api;
  }

  function connect() {
    if (transport) transport.close();
    transport = params.has('mock') ? window.createMockTransport() : createSocketTransport();
    transport.onstatus = (online) => { el.offline.hidden = online || !state; };
    transport.onmessage = (msg) => {
      if (msg.t === 'state') onState({ ...msg.state, you: msg.you });
      else if (msg.t === 'event') onEvent(msg);
      else if (msg.t === 'ack') onAck(msg);
      else if (msg.t === 'error') onError(msg);
    };
  }

  function onState(next) {
    if (holding) {
      heldState = next;
      return;
    }
    const first = !state;
    state = next;
    if (first) {
      el.landing.hidden = true;
      el.lobby.hidden = false;
      store.set('session', state.code);
      // from here on a reconnect should rejoin this lobby, not create another
      transport.hello = { t: 'join', code: state.code, name: store.get('name'), clientId };
      params.set('c', state.code);
      history.replaceState(null, '', '?' + params);
    }
    render();
  }

  function onError(msg) {
    if (state && !msg.fatal) toast(msg.msg, true);
    else exit(msg.msg);
  }

  // the server's answer to a submission
  function onAck(msg) {
    setSubmitting(false);
    if (msg.ok) el.submitInput.value = '';
    if (msg.msg) toast(msg.msg, !msg.ok, msg.long ? 14000 : 4500);
  }

  function onEvent(e) {
    if (!state) return;
    switch (e.kind) {
      case 'vote':
        if (e.by !== state.you) sfx.play(e.vote ? 'type' : 'slide');
        break;
      case 'verdict':
        stamp(e.verdict);
        break;
      case 'submitted':
        sfx.play('bell');
        toast(e.count > 1 ? `${e.by} added ${e.count} songs to the docket` : `${e.by} submitted “${e.title}”`);
        break;
      case 'joined':
        sfx.play('chime');
        toast(`${e.name} has taken a seat`);
        break;
      case 'crowned':
        toast(e.id === state.you ? 'You now chair the committee' : `${e.name} now chairs the committee`);
        break;
      case 'prioritized':
        toast(`“${e.title}” will be heard next`);
        break;
    }
  }

  function leave() {
    if (transport) transport.send({ t: 'leave' });
    exit();
  }

  // back to the front door, forgetting the lobby
  function exit(error = '') {
    if (transport) transport.close();
    transport = null;
    setSubmitting(false);
    el.offline.hidden = true;
    state = heldState = shownUid = null;
    holding = false;
    seenVotes = new Set();
    el.motion.innerHTML = '';
    store.del('session');
    params.delete('c');
    history.replaceState(null, '', params.size ? '?' + params : location.pathname);
    showDoor(error);
  }

  // ───────────── verdict stamp ─────────────

  function stamp(verdict) {
    const accepted = verdict === 'accepted';
    const node = document.createElement('div');
    node.className = 'stamp ' + verdict;
    node.innerHTML = `<span class="stamp-main">${accepted ? 'Accepted' : 'Rejected'}</span>`
      + `<span class="stamp-sub">${accepted ? 'Certified banger' : 'Not a banger'}</span>`;
    el.motion.append(node);
    el.motion.classList.add('is-stamped');
    sfx.play('stamp');

    // freeze the room for a beat so everyone sees the ruling land
    holding = true;
    renderBallot();
    renderChair();
    setTimeout(() => {
      holding = false;
      if (heldState) {
        const next = heldState;
        heldState = null;
        onState(next);
      } else {
        render();
      }
    }, STAMP_HOLD_MS);
  }

  // ───────────── rendering ─────────────

  function render() {
    el.codeChipCode.textContent = state.code;
    el.datelineCount.textContent = `${state.history.length} ruled · ${state.queue.length} to hear`;
    renderMembers();
    renderMotion();
    renderBallot();
    renderTally();
    renderChair();
    renderQueue();
    renderHistory();
  }

  const isHost = () => state.hostId === state.you;

  function renderMembers() {
    const online = state.members.filter((m) => m.online).length;
    el.membersCount.textContent = `${online} present`;
    el.members.innerHTML = state.members.map((m) => `
      <li class="member${m.online ? '' : ' is-offline'}">
        <span class="member-crown">${m.id === state.hostId ? ICON.crown : ''}</span>
        <span class="member-name">${esc(m.name)}</span>
        ${m.id === state.you ? '<span class="tag">you</span>' : ''}
        ${m.online ? '' : '<span class="tag tag-dim">away</span>'}
        ${isHost() && m.online && m.id !== state.you ? `<button class="row-btn hand-btn" type="button" data-crown="${esc(m.id)}" data-name="${esc(m.name)}" title="Hand the chair to ${esc(m.name)}">${ICON.crown}</button>` : ''}
        <span class="vote-dot ${state.votes[m.id] || ''}"></span>
      </li>`).join('');
  }

  function renderMotion() {
    const t = state.current;
    const uid = t ? t.uid : 'empty';
    if (uid === shownUid) return;
    shownUid = uid;
    el.motion.classList.remove('is-stamped', 'is-entering');
    el.motion.innerHTML = t ? `
      <div class="motion-body">
        <div class="motion-head kicker"><span>Motion on the floor</span><span>Docket № ${pad(t.no)}</span></div>
        <h3 class="motion-title">${esc(t.title)}</h3>
        <p class="motion-artist">${esc(t.artist)}</p>
        <p class="motion-by">Submitted by <b>${esc(t.by)}</b></p>
        <iframe class="motion-player" title="Spotify player"
          src="https://open.spotify.com/embed/track/${encodeURIComponent(t.sid)}?utm_source=generator"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"></iframe>
      </div>` : `
      <div class="motion-body motion-empty">
        <h3>The floor is open</h3>
        <p>No song is under review. Submit a link to bring one before the committee.</p>
      </div>`;
    void el.motion.offsetWidth;
    el.motion.classList.add('is-entering');
  }

  function renderBallot() {
    if (!el.ballot.children.length) {
      el.ballot.innerHTML = VOTES.map(([vote, label]) =>
        `<button class="vote-btn" type="button" data-vote="${vote}">${ICON[vote]}<span>${label}</span></button>`).join('');
    }
    const mine = state.votes[state.you];
    for (const btn of el.ballot.children) {
      btn.setAttribute('aria-pressed', String(btn.dataset.vote === mine));
      btn.disabled = !state.current || holding;
    }
  }

  function renderTally() {
    const seen = new Set();
    el.tally.innerHTML = COLUMNS.map(([col, label]) => {
      const names = state.members.filter((m) => (state.votes[m.id] || 'wait') === col);
      const chips = names.map((m) => {
        const key = m.id + ':' + col;
        seen.add(key);
        const fresh = col !== 'wait' && !seenVotes.has(key);
        return `<li class="voter${fresh ? ' is-new' : ''}${m.online ? '' : ' is-offline'}">${esc(m.name)}</li>`;
      }).join('');
      return `
        <div class="tally-col" data-col="${col}">
          <div class="tally-head"><span class="tally-label kicker">${label}</span><span class="tally-num">${names.length}</span></div>
          <ul class="tally-names">${chips}</ul>
        </div>`;
    }).join('');
    seenVotes = seen;
  }

  function renderChair() {
    el.chair.hidden = !isHost();
    if (!isHost()) return;
    if (!el.chair.children.length) {
      el.chair.innerHTML = `
        <div class="chair-head kicker">${ICON.crown}Chair’s ruling<span>only you can rule</span></div>
        <div class="chair-btns">
          <button class="rule-btn accept" type="button" data-verdict="accepted">Accept</button>
          <button class="rule-btn reject" type="button" data-verdict="rejected">Reject</button>
        </div>`;
    }
    el.chair.querySelectorAll('.rule-btn').forEach((btn) => { btn.disabled = !state.current || holding; });
  }

  const cover = (t) => (t.cover ? `<img class="cover" src="${esc(t.cover)}" alt="" loading="lazy">` : '<span class="cover"></span>');

  function renderQueue() {
    const host = isHost();
    el.queueCount.textContent = state.queue.length ? `${state.queue.length} waiting` : '';
    el.queue.innerHTML = state.queue.map((t, i) => `
      <li class="row">
        <span class="row-no">${pad(t.no)}</span>
        ${cover(t)}
        <div class="row-meta">
          <div class="row-title">${esc(t.title)}</div>
          <div class="row-sub">${esc(t.artist)} · <i>${esc(t.by)}</i></div>
        </div>
        ${i === 0 ? '<span class="next-tag">Next</span>' : ''}
        ${host ? `<div class="row-actions">
          ${i > 0 ? `<button class="row-btn" type="button" data-act="prioritize" data-uid="${esc(t.uid)}" title="Hear this one next">↑ Next</button>` : ''}
          <button class="row-btn danger" type="button" data-act="remove" data-uid="${esc(t.uid)}" title="Strike from the docket" aria-label="Remove">✕</button>
        </div>` : ''}
      </li>`).join('') || '<li class="rows-empty">The docket is clear.</li>';
  }

  function renderHistory() {
    const accepted = state.history.filter((h) => h.verdict === 'accepted').length;
    el.historyCount.textContent = state.history.length ? `${accepted} in · ${state.history.length - accepted} out` : '';
    el.copyAccepted.disabled = !accepted;
    el.history.innerHTML = state.history.map(({ track: t, verdict, tally }) => `
      <li class="row">
        ${cover(t)}
        <div class="row-meta">
          <div class="row-title">${esc(t.title)}</div>
          <div class="row-sub">${esc(t.artist)} · ${tally.for}–${tally.against}${tally.abstain ? `–${tally.abstain}` : ''} · <i>${esc(t.by)}</i></div>
        </div>
        <span class="stamp-sm ${verdict}">${verdict}</span>
      </li>`).join('') || '<li class="rows-empty">Nothing has been ruled on yet.</li>';
  }

  function renderSound() {
    el.soundBtn.innerHTML = sfx.muted ? ICON.soundOff : ICON.soundOn;
    el.soundBtn.setAttribute('aria-pressed', String(!sfx.muted));
  }

  // ───────────── actions ─────────────

  el.ballot.addEventListener('click', (e) => {
    const btn = e.target.closest('.vote-btn');
    if (!btn || btn.disabled || !state.current) return;
    const vote = state.votes[state.you] === btn.dataset.vote ? null : btn.dataset.vote;
    sfx.play(vote ? 'type' : 'slide');
    transport.send({ t: 'vote', vote, uid: state.current.uid });
  });

  el.chair.addEventListener('click', (e) => {
    const btn = e.target.closest('.rule-btn');
    if (!btn || btn.disabled || !state.current) return;
    transport.send({ t: 'rule', verdict: btn.dataset.verdict, uid: state.current.uid });
  });

  el.queue.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) transport.send({ t: btn.dataset.act, uid: btn.dataset.uid });
  });

  el.members.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-crown]');
    if (btn && confirm(`Hand the chair to ${btn.dataset.name}? They will make the rulings from now on.`)) {
      transport.send({ t: 'crown', id: btn.dataset.crown });
    }
  });

  let submitTimer = null;
  function setSubmitting(on) {
    clearTimeout(submitTimer);
    el.submitBtn.disabled = on;
    el.submitBtn.textContent = on ? 'Looking it up…' : 'Add to the docket';
    if (on) submitTimer = setTimeout(() => setSubmitting(false), 45000);
  }

  el.submitForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = el.submitInput.value.trim();
    if (!url || el.submitBtn.disabled) return;
    setSubmitting(true);
    transport.send({ t: 'submit', url });
  });

  el.codeChip.addEventListener('click', () => {
    copy(`${location.origin}${location.pathname}?c=${state.code}`, 'Invite link copied');
  });

  el.copyAccepted.addEventListener('click', () => {
    const links = state.history.filter((h) => h.verdict === 'accepted').map((h) => `https://open.spotify.com/track/${h.track.sid}`).reverse();
    copy(links.join('\n'), `${links.length} accepted ${links.length === 1 ? 'link' : 'links'} copied — paste them into a Spotify playlist`);
  });

  el.soundBtn.addEventListener('click', () => {
    sfx.toggle();
    renderSound();
  });

  el.leaveBtn.addEventListener('click', leave);

  function copy(text, done) {
    navigator.clipboard.writeText(text).then(() => toast(done), () => toast('Could not reach the clipboard', true));
  }

  function toast(text, isError = false, ms = 3200) {
    const node = document.createElement('div');
    node.className = 'toast' + (isError ? ' is-error' : '');
    node.textContent = text;
    el.toasts.append(node);
    setTimeout(() => node.classList.add('is-leaving'), ms);
    setTimeout(() => node.remove(), ms + 400);
  }

  // ───────────── boot ─────────────

  renderSound();
  $('#dateline-date').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const urlCode = (params.get('c') || '').toUpperCase();
  if (/^[A-Z]{4}$/.test(urlCode)) {
    el.codeInput.value = urlCode;
    pending = { mode: 'join', code: urlCode };
    const name = store.get('name');
    if (name && store.get('session') === urlCode) enter(name);   // seamless rejoin after a refresh
    else showNameStep();
  }
})();
