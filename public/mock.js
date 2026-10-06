// Offline stand-in for the server, for design work: open the page with ?mock in the address.
// It speaks the same messages as the real thing and adds a few bots who vote.
window.createMockTransport = () => {
  const img = (id) => `https://image-cdn-fa.spotifycdn.com/image/${id}`;
  const POOL = [
    ['4PTG3Z6ehGkBFwjybzWkR8', 'Never Gonna Give You Up', 'Rick Astley', 'ab67616d00001e0215ebbedaacef61af244262a8'],
    ['003vvx7Niy0yvhvHt4a68B', 'Mr. Brightside', 'The Killers', 'ab67616d00001e02ccdddd46119a4ff53eaf1f5d'],
    ['2374M0fQpWi3dLnB54qaLX', 'Africa', 'TOTO', 'ab67616d00001e02ebd6d20c0082524244ef83df'],
    ['0VjIjW4GlUZAMYd2vXMi3b', 'Blinding Lights', 'The Weeknd', 'ab67616d00001e028863bc11d2aa12b54f5aeb36'],
    ['2Foc5Q5nqNiosCNqttzHof', 'Get Lucky (Radio Edit) [feat. Pharrell Williams and Nile Rodgers]', 'Daft Punk, Pharrell Williams, Nile Rodgers', 'ab67616d00001e0219a88dd5c7118e87d7b1619e'],
    ['2WfaOiMkCvy7F5fcp2zZ8L', 'Take on Me', 'a-ha', 'ab67616d00001e02e8dd4db47e7177c63b0b7d53'],
    ['7tFiyTwD0nx5a1eklYtX2J', 'Bohemian Rhapsody - Remastered 2011', 'Queen', 'ab67616d00001e02ce4f1737bc8a646c8c4bd25a'],
    ['5ChkMS8OtdzJeqyybCc9R5', 'Billie Jean', 'Michael Jackson', 'ab67616d00001e024121faee8df82c526cbab2be'],
    ['5ghIJDpPoe3CfHMGu71E6T', 'Smells Like Teen Spirit', 'Nirvana', 'ab67616d00001e02e175a19e530c898d167d39bf'],
    ['0GjEhVFGZW8afUYGChu3Rr', 'Dancing Queen', 'ABBA', 'ab67616d00001e0270f7a1b35d5165c85b95a0e0'],
  ];
  const BOTS = ['Masha', 'Dima', 'Olya', 'Kostya', 'Lena'];

  let S = null;
  let docketNo = 0;
  let timers = [];
  const api = { onmessage() {}, send(msg) { setTimeout(() => handle(msg), 50); }, close() { clearTimers(); } };

  const emit = (msg) => api.onmessage(JSON.parse(JSON.stringify(msg)));
  const pushState = () => emit({ t: 'state', you: 'you', state: S });
  const event = (kind, data) => emit({ t: 'event', kind, ...data });
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

  function track(i, by) {
    const [sid, title, artist, cover] = POOL[i % POOL.length];
    docketNo += 1;
    return { uid: 't' + docketNo, no: docketNo, sid, title, artist, cover: img(cover), by };
  }

  function tallyOf(votes) {
    const tally = { for: 0, against: 0, abstain: 0 };
    Object.values(votes).forEach((v) => { tally[v] += 1; });
    return tally;
  }

  function botsVote() {
    S.members.filter((m) => m.bot && m.online).forEach((m) => {
      later(1500 + Math.random() * 8000, () => {
        if (!S.current) return;
        const vote = ['for', 'for', 'for', 'against', 'against', 'abstain'][Math.floor(Math.random() * 6)];
        S.votes[m.id] = vote;
        event('vote', { by: m.id, vote });
        pushState();
      });
    });
    // when a bot is chairing, it rules on its own after a while
    if (S.hostId !== 'you') {
      later(13000, () => {
        const t = tallyOf(S.votes);
        rule(t.for >= t.against ? 'accepted' : 'rejected');
      });
    }
  }

  function rule(verdict) {
    if (!S.current) return;
    clearTimers();
    S.history.unshift({ track: S.current, verdict, tally: tallyOf(S.votes) });
    event('verdict', { verdict, track: S.current });
    S.current = S.queue.shift() || null;
    S.votes = {};
    pushState();
    if (S.current) botsVote();
  }

  function start(name, code, asHost) {
    docketNo = 0;
    const members = [{ id: 'you', name, online: true }];
    BOTS.forEach((n, i) => members.push({ id: 'bot' + i, name: n, online: n !== 'Kostya', bot: true }));
    if (!asHost) members.unshift(members.splice(1, 1)[0]);
    const who = (i) => [name, ...BOTS][i % 6];
    S = {
      code,
      hostId: asHost ? 'you' : 'bot0',
      members,
      history: [
        { track: track(0, who(1)), verdict: 'accepted', tally: { for: 4, against: 1, abstain: 0 } },
        { track: track(1, who(0)), verdict: 'accepted', tally: { for: 5, against: 0, abstain: 0 } },
        { track: track(2, who(2)), verdict: 'rejected', tally: { for: 1, against: 3, abstain: 1 } },
      ].reverse(),
      current: track(3, who(3)),
      votes: {},
      queue: [4, 5, 6, 7, 8, 9].map((i) => track(i, who(i))),
    };
    pushState();
    botsVote();
  }

  function handle(msg) {
    switch (msg.t) {
      case 'create':
        return start(msg.name, 'BNGR', true);
      case 'join':
        return start(msg.name, msg.code, false);
      case 'vote':
        if (!S.current) return;
        if (msg.vote) S.votes.you = msg.vote; else delete S.votes.you;
        event('vote', { by: 'you', vote: msg.vote });
        return pushState();
      case 'rule':
        return rule(msg.verdict);
      case 'submit': {
        if (!/spotify/.test(msg.url)) return emit({ t: 'ack', ok: false, msg: 'That is not a Spotify track, album or playlist link.' });
        const me = S.members.find((m) => m.id === 'you').name;
        const many = /playlist|album/.test(msg.url);
        const added = Array.from({ length: many ? 8 : 1 }, () => track(Math.floor(Math.random() * POOL.length), me));
        S.queue.push(...added);
        const wasIdle = !S.current;
        if (wasIdle) S.current = S.queue.shift();
        event('submitted', { by: me, count: added.length, title: added[0].title });
        pushState();
        emit({ t: 'ack', ok: true });
        if (wasIdle) botsVote();
        return;
      }
      case 'prioritize': {
        const i = S.queue.findIndex((t) => t.uid === msg.uid);
        if (i < 1) return;
        const [t] = S.queue.splice(i, 1);
        S.queue.unshift(t);
        event('prioritized', { title: t.title });
        return pushState();
      }
      case 'remove':
        S.queue = S.queue.filter((t) => t.uid !== msg.uid);
        return pushState();
      case 'leave':
        clearTimers();
        S = null;
    }
  }

  return api;
};
