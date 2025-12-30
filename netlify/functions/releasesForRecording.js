const MB_BASE = "https://musicbrainz.org/ws/2";
const UA = "JazzEgonetExplorer/1.0 (contact: you@example.com)"; // change

let lastCallMs = 0;
async function throttle(minIntervalMs = 1200) {
  const now = Date.now();
  const wait = Math.max(0, minIntervalMs - (now - lastCallMs));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallMs = Date.now();
}

async function fetchJson(url) {
  await throttle(1200);
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`MB ${res.status}`);
  return await res.json();
}

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const rid = (qs.rid || "").trim();
    const max = Math.max(1, Math.min(30, Number(qs.max || 12)));
    if (!rid) return { statusCode: 400, body: JSON.stringify({ error: "rid required" }) };

    const url = `${MB_BASE}/recording/${rid}?inc=releases&fmt=json`;
    const full = await fetchJson(url);
    const rec = full.recording || full;
    const releases = (rec.releases || rec["release-list"] || [])
      .map((x) => x.title)
      .filter(Boolean);

    // de-dupe, preserve order
    const seen = new Set();
    const out = [];
    for (const t of releases) {
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
      if (out.length >= max) break;
    }

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rid, releases: out }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};
