// netlify/functions/verifyEdge.js
// GET /api/verifyEdge?artistA=<mbid>&artistB=<mbid>&limit=5
//
// Returns a few recordings where BOTH artists appear as performers (instrument/vocal)
// using MusicBrainz WS2 recording relationships.
//
// IMPORTANT: This is "verification" only. We keep it small and throttled.

const MB_BASE = "https://musicbrainz.org/ws/2";
const UA = "JazzEgonetExplorer/1.0 (contact: you@example.com)"; // change to your email

// crude in-memory throttle per warm function instance
let lastCallMs = 0;
async function throttle(minIntervalMs = 1200) {
  const now = Date.now();
  const wait = Math.max(0, minIntervalMs - (now - lastCallMs));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallMs = Date.now();
}

// tiny /tmp cache (persists during warm instances)
const fs = require("fs");
const path = require("path");
const tmpDir = "/tmp/jazzcache";
function cachePath(key) {
  return path.join(tmpDir, key.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json");
}
function cacheGet(key, maxAgeMs = 7 * 24 * 3600 * 1000) {
  try {
    const p = cachePath(key);
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs > maxAgeMs) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}
function cacheSet(key, value) {
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(cachePath(key), JSON.stringify(value));
  } catch {}
}

async function fetchJson(url) {
  // MusicBrainz prefers no gzip surprises with some runtimes; but Node fetch is fine.
  await throttle(1200);
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`MusicBrainz ${res.status}: ${t.slice(0, 200)}`);
  }
  return await res.json();
}

// Pull performer relations from a recording json record
function performerArtistIdsFromRecording(rec) {
  // In MB JSON: recording.relations[] with type "instrument" / "vocal" and artist object
  const rels = rec.relations || [];
  const out = new Set();
  for (const r of rels) {
    const type = (r.type || "").toLowerCase();
    if (type !== "instrument" && type !== "vocal") continue;
    if (r.artist && r.artist.id) out.add(r.artist.id);
  }
  return out;
}

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const a = (qs.artistA || "").trim();
    const b = (qs.artistB || "").trim();
    const limit = Math.max(1, Math.min(20, Number(qs.limit || 6)));

    if (!a || !b) {
      return { statusCode: 400, body: JSON.stringify({ error: "artistA and artistB required" }) };
    }

    const key = `verifyEdge_${a}_${b}_${limit}`;
    const cached = cacheGet(key);
    if (cached) {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(cached) };
    }

    // Strategy:
    // - Browse recordings for artistA (small window)
    // - For each recording, fetch recording by id with artist-rels
    // - Check if both A and B appear in performer rels
    //
    // This is intentionally capped: verification is for a clicked edge, not whole-network building.

    // 1) get some recordings linked to artistA
    const browseUrl = `${MB_BASE}/recording?artist=${encodeURIComponent(a)}&limit=50&fmt=json`;
    const browse = await fetchJson(browseUrl);
    const recs = (browse.recordings || []).slice(0, 50);

    const hits = [];
    for (const r of recs) {
      if (hits.length >= limit) break;

      // fetch recording details w/ artist relationships
      const rid = r.id;
      const recUrl = `${MB_BASE}/recording/${rid}?inc=artist-rels+releases&fmt=json`;
      let full;
      try {
        full = await fetchJson(recUrl);
      } catch {
        continue;
      }
      const rec = full.recording || full; // depending on endpoint shape
      const perfIds = performerArtistIdsFromRecording(rec);

      if (perfIds.has(a) && perfIds.has(b)) {
        hits.push({
          recording_id: rid,
          title: rec.title || r.title || "",
          // provide a few release titles if present (not always)
          releases: (rec.releases || rec["release-list"] || [])
            .map((x) => x.title)
            .filter(Boolean)
            .slice(0, 8),
        });
      }
    }

    const out = { artistA: a, artistB: b, matches: hits };
    cacheSet(key, out);

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(out) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};
