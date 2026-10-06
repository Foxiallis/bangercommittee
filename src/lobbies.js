// Lobby state and the rules of the committee. Everything lives in memory and is
// mirrored to a JSON file so a restart does not wipe a session in progress.

const fs = require('fs');
const path = require('path');
const spotify = require('./spotify');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'lobbies.json');

const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';   // no vowels, so codes never spell anything
const VOTES = new Set(['for', 'against', 'abstain']);
const VERDICTS = new Set(['accepted', 'rejected']);
const MAX_MEMBERS = 50;
const MAX_QUEUE = 2000;
const HOST_GRACE_MS = 2 * 60 * 1000;        // an absent host keeps the chair this long
const MEMBER_AWAY_MS = 30 * 60 * 1000;      // absent members are dropped from the list after this
const LOBBY_TTL_MS = 24 * 60 * 60 * 1000;   // empty lobbies are deleted after this

const lobbies = new Map();

// ───────────── persistence ─────────────

let saveTimer = null;

function save() {
  if (!saveTimer) saveTimer = setTimeout(flush, 2000);
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const data = [...lobbies.values()].map((lobby) => ({
    ...lobby,
    members: lobby.members.map(({ id, clientId, name }) => ({ id, clientId, name })),
  }));
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(data));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  } catch (err) {
    console.error('Could not save lobbies:', err.message);
  }
}

function load() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return;
  }
  for (const lobby of data) {
    lobby.members = lobby.members.map((m) => ({ ...m, sockets: new Set(), awaySince: Date.now() }));
    lobbies.set(lobby.code, lobby);
  }
  console.log(`Restored ${lobbies.size} lobbies`);
}

// ───────────── talking to clients ─────────────

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(lobby, text, forMember = () => text) {
  for (const member of lobby.members) {
    for (const ws of member.sockets) {
      if (ws.readyState === 1) ws.send(forMember(member));
    }
  }
}

function emit(lobby, kind, data) {
  broadcast(lobby, JSON.stringify({ t: 'event', kind, ...data }));
}

// Sends everyone the whole lobby. Events that explain a change (a verdict, a vote)
// must be emitted before this, because clients react to the event and then redraw.
function pushState(lobby) {
  lobby.touched = Date.now();
  save();
  const state = JSON.stringify({
    code: lobby.code,
    hostId: lobby.hostId,
    members: lobby.members.map((m) => ({ id: m.id, name: m.name, online: m.sockets.size > 0 })),
    current: lobby.current,
    votes: lobby.votes,
    queue: lobby.queue,
    history: lobby.history,
  });
  broadcast(lobby, null, (member) => `{"t":"state","you":${JSON.stringify(member.id)},"state":${state}}`);
}

// ───────────── lobby helpers ─────────────

function createLobby() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join('');
  } while (lobbies.has(code));
  const lobby = {
    code,
    hostId: null,
    members: [],
    current: null,
    votes: {},
    queue: [],
    history: [],
    nextNo: 1,
    nextMember: 1,
    touched: Date.now(),
  };
  lobbies.set(code, lobby);
  return lobby;
}

const isOnline = (member) => member.sockets.size > 0;
const hostOf = (lobby) => lobby.members.find((m) => m.id === lobby.hostId);

function advance(lobby) {
  lobby.current = lobby.queue.shift() || null;
  lobby.votes = {};
}

function giveChair(lobby, member) {
  lobby.hostId = member ? member.id : null;
  if (member) emit(lobby, 'crowned', { id: member.id, name: member.name });
}

function removeMember(lobby, member) {
  lobby.members = lobby.members.filter((m) => m !== member);
  delete lobby.votes[member.id];
  if (lobby.hostId === member.id) giveChair(lobby, lobby.members.find(isOnline) || lobby.members[0]);
}

function detach(ws) {
  const { lobby, member } = ws;
  ws.lobby = ws.member = null;
  if (!lobby) return null;
  member.sockets.delete(ws);
  if (!isOnline(member)) member.awaySince = Date.now();
  return { lobby, member };
}

// ───────────── actions ─────────────

function enter(ws, lobby, msg) {
  const name = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  const clientId = String(msg.clientId || '').slice(0, 64);
  if (!name || !clientId) return send(ws, { t: 'error', fatal: true, msg: 'The record needs a name.' });

  let member = lobby.members.find((m) => m.clientId === clientId);
  const isNew = !member;
  if (isNew) {
    if (lobby.members.length >= MAX_MEMBERS) return send(ws, { t: 'error', fatal: true, msg: 'That lobby is full.' });
    member = { id: 'm' + lobby.nextMember++, clientId, name, sockets: new Set(), awaySince: 0 };
    lobby.members.push(member);
  }

  const previous = detach(ws);
  if (previous && previous.lobby !== lobby) pushState(previous.lobby);

  member.name = name;
  member.sockets.add(ws);
  member.awaySince = 0;
  ws.lobby = lobby;
  ws.member = member;
  if (!hostOf(lobby)) lobby.hostId = member.id;
  if (isNew) emit(lobby, 'joined', { id: member.id, name });
  pushState(lobby);
}

const actions = {
  create(ws, msg) {
    const lobby = createLobby();
    enter(ws, lobby, msg);
    if (!lobby.members.length) lobbies.delete(lobby.code);   // the creator was turned away
  },

  join(ws, msg) {
    const lobby = lobbies.get(String(msg.code || '').toUpperCase());
    if (!lobby) return send(ws, { t: 'error', fatal: true, msg: 'There is no lobby with that code.' });
    enter(ws, lobby, msg);
  },

  leave(ws) {
    const left = detach(ws);
    if (!left) return;
    for (const other of left.member.sockets) {
      other.lobby = other.member = null;
      send(other, { t: 'error', fatal: true, msg: 'You left the lobby in another tab.' });
    }
    left.member.sockets.clear();
    removeMember(left.lobby, left.member);
    pushState(left.lobby);
  },

  vote(ws, msg) {
    const { lobby, member } = ws;
    if (!lobby.current || msg.uid !== lobby.current.uid) return;
    if (msg.vote === null) delete lobby.votes[member.id];
    else if (VOTES.has(msg.vote)) lobby.votes[member.id] = msg.vote;
    else return;
    emit(lobby, 'vote', { by: member.id, vote: msg.vote });
    pushState(lobby);
  },

  rule(ws, msg) {
    const { lobby, member } = ws;
    if (member.id !== lobby.hostId || !VERDICTS.has(msg.verdict)) return;
    if (!lobby.current || msg.uid !== lobby.current.uid) return;
    const tally = { for: 0, against: 0, abstain: 0 };
    for (const vote of Object.values(lobby.votes)) tally[vote] += 1;
    lobby.history.unshift({ track: lobby.current, verdict: msg.verdict, tally });
    emit(lobby, 'verdict', { verdict: msg.verdict, track: lobby.current });
    advance(lobby);
    pushState(lobby);
  },

  prioritize(ws, msg) {
    const { lobby, member } = ws;
    if (member.id !== lobby.hostId) return;
    const i = lobby.queue.findIndex((t) => t.uid === msg.uid);
    if (i < 1) return;
    const [track] = lobby.queue.splice(i, 1);
    lobby.queue.unshift(track);
    emit(lobby, 'prioritized', { title: track.title });
    pushState(lobby);
  },

  remove(ws, msg) {
    const { lobby, member } = ws;
    if (member.id !== lobby.hostId) return;
    const before = lobby.queue.length;
    lobby.queue = lobby.queue.filter((t) => t.uid !== msg.uid);
    if (lobby.queue.length !== before) pushState(lobby);
  },

  crown(ws, msg) {
    const { lobby, member } = ws;
    if (member.id !== lobby.hostId) return;
    const heir = lobby.members.find((m) => m.id === msg.id);
    if (!heir || heir === member) return;
    giveChair(lobby, heir);
    pushState(lobby);
  },

  async submit(ws, msg) {
    const { lobby, member } = ws;
    const ack = (ok, text, long = false) => send(ws, { t: 'ack', ok, msg: text, long });
    if (ws.submitting) return ack(false, 'Still looking up your last submission.');

    let found;
    ws.submitting = true;
    try {
      found = await spotify.resolve(String(msg.url || '').slice(0, 200000));
    } catch {
      return ack(false, 'Spotify could not be reached. Try again in a moment.');
    } finally {
      ws.submitting = false;
    }
    if (ws.lobby !== lobby) return;
    if (!found.found) return ack(false, 'That is not a Spotify track, album or playlist link.');

    const known = new Set([lobby.current, ...lobby.queue, ...lobby.history.map((h) => h.track)].filter(Boolean).map((t) => t.sid));
    const fresh = found.tracks.filter((t) => !known.has(t.sid)).slice(0, MAX_QUEUE - lobby.queue.length);
    const repeats = found.tracks.length - fresh.length;
    if (!fresh.length) {
      if (!found.tracks.length) return ack(false, 'No songs could be found at that link. Is the playlist public?');
      return ack(false, found.tracks.length === 1 ? 'That song is already on the docket or in the record.' : 'All of those songs are already on the docket or in the record.');
    }

    for (const track of fresh) {
      const no = lobby.nextNo++;
      lobby.queue.push({ uid: 't' + no, no, ...track, by: member.name });
    }
    if (!lobby.current) advance(lobby);
    emit(lobby, 'submitted', { by: member.name, count: fresh.length, title: fresh[0].title });
    pushState(lobby);

    const notes = [];
    if (repeats) notes.push(`${repeats} skipped as already on the docket or in the record.`);
    if (found.failed) notes.push(`${found.failed} could not be looked up.`);
    if (found.capped) notes.push('Spotify only shares the first 100 songs of a playlist. For the rest, select them in the Spotify desktop app, copy (Ctrl+C) and paste here.');
    ack(true, notes.join(' ') || null, found.capped);
  },
};

async function handle(ws, msg) {
  const action = msg && Object.hasOwn(actions, msg.t) ? actions[msg.t] : null;
  if (!action) return;
  const needsLobby = msg.t !== 'create' && msg.t !== 'join';
  if (needsLobby && !ws.lobby) return;
  await action(ws, msg);
}

function disconnect(ws) {
  const left = detach(ws);
  if (left) pushState(left.lobby);
}

// ───────────── housekeeping ─────────────

function sweep() {
  const now = Date.now();
  for (const lobby of lobbies.values()) {
    const present = lobby.members.filter(isOnline);
    if (!present.length) {
      if (now - lobby.touched > LOBBY_TTL_MS) {
        lobbies.delete(lobby.code);
        save();
      }
      continue;
    }
    let changed = false;
    const host = hostOf(lobby);
    if (!host || (!isOnline(host) && now - host.awaySince > HOST_GRACE_MS)) {
      giveChair(lobby, present[0]);
      changed = true;
    }
    for (const member of lobby.members) {
      if (!isOnline(member) && member.id !== lobby.hostId && now - member.awaySince > MEMBER_AWAY_MS) {
        removeMember(lobby, member);
        changed = true;
      }
    }
    if (changed) pushState(lobby);
  }
}

load();
setInterval(sweep, 20000).unref();

module.exports = { handle, disconnect, flush };
