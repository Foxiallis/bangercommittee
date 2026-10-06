// Looks songs up on Spotify without API keys, by reading the data that Spotify's
// public embed pages (open.spotify.com/embed/...) ship for their own player.
// The official Web API no longer returns playlist contents to third-party apps.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const LINK = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?|spotify:)(track|playlist|album)[/:]([A-Za-z0-9]{22})/g;
const SHORT_LINK = /https?:\/\/spotify(?:\.app)?\.link\/[A-Za-z0-9]+/g;

const EMBED_PLAYLIST_CAP = 100;   // the embed never lists more than this
const MAX_TRACKS = 600;           // per submission
const CONCURRENCY = 6;
const CACHE_SIZE = 5000;

const cache = new Map();          // spotify track id -> { sid, title, artist, cover }

async function fetchText(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { ...options, headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(10000) });
      if (res.status >= 500 || res.status === 429) throw new Error(`Spotify answered ${res.status}`);
      return res;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw lastError;
}

// The entity (track / album / playlist) described by an embed page, or null if there is none.
async function embedEntity(type, id) {
  const res = await fetchText(`https://open.spotify.com/embed/${type}/${id}`);
  const html = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]).props.pageProps.state.data.entity || null;
  } catch {
    return null;
  }
}

function coverOf(entity) {
  const images = entity.visualIdentity?.image || [];
  const best = images.find((i) => i.maxWidth === 300) || images[0];
  return best ? best.url : null;
}

async function lookupTrack(id, fallback) {
  if (cache.has(id)) return cache.get(id);
  let entity = null;
  try {
    entity = await embedEntity('track', id);
  } catch {}
  if (!entity || entity.type !== 'track') return fallback || null;
  const track = {
    sid: id,
    title: entity.title || entity.name || 'Untitled',
    artist: (entity.artists || []).map((a) => a.name).join(', '),
    cover: coverOf(entity),
  };
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
  cache.set(id, track);
  return track;
}

// Tracks of an album or playlist, with whatever the listing itself knows about them.
async function listCollection(type, id) {
  const entity = await embedEntity(type, id);
  if (!entity || !Array.isArray(entity.trackList)) return { tracks: [], capped: false };
  const cover = type === 'album' ? coverOf(entity) : null;
  const tracks = entity.trackList
    .filter((t) => typeof t.uri === 'string' && t.uri.startsWith('spotify:track:'))
    .map((t) => ({ sid: t.uri.split(':')[2], title: t.title || 'Untitled', artist: t.subtitle || '', cover }));
  return { tracks, capped: type === 'playlist' && entity.trackList.length >= EMBED_PLAYLIST_CAP };
}

async function expandShortLinks(text) {
  const shorts = [...new Set(text.match(SHORT_LINK) || [])].slice(0, 5);
  for (const url of shorts) {
    try {
      const res = await fetchText(url, { redirect: 'manual' });
      const target = res.headers.get('location') || await res.text();
      text = text.replace(url, target);
    } catch {}
  }
  return text;
}

async function mapPool(items, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i]);
    }
  }));
  return out;
}

// Turns pasted text (one link, or many) into a list of tracks.
//   found:  whether the text contained any Spotify link at all
//   tracks: [{ sid, title, artist, cover }] in the order given, without repeats
//   failed: how many songs could not be looked up
//   capped: a playlist hit Spotify's 100-song limit, so some songs may be missing
async function resolve(input) {
  const text = await expandShortLinks(String(input));
  const links = [...text.matchAll(LINK)].map((m) => ({ type: m[1], id: m[2] }));
  if (!links.length) return { found: false, tracks: [], failed: 0, capped: false };

  const wanted = new Map();   // sid -> what we know so far (maybe nothing)
  let capped = false;
  for (const link of links) {
    if (wanted.size >= MAX_TRACKS) break;
    if (link.type === 'track') {
      if (!wanted.has(link.id)) wanted.set(link.id, null);
      continue;
    }
    const list = await listCollection(link.type, link.id);
    capped = capped || list.capped;
    for (const t of list.tracks) {
      if (wanted.size >= MAX_TRACKS) break;
      if (!wanted.has(t.sid)) wanted.set(t.sid, t);
    }
  }

  const looked = await mapPool([...wanted], ([sid, known]) => lookupTrack(sid, known));
  const tracks = looked.filter(Boolean);
  return { found: true, tracks, failed: looked.length - tracks.length, capped };
}

module.exports = { resolve };
