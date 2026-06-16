// Live web/news context for "commentary on current events". Fetches an article
// URL and extracts readable text, and (with BRAVE_API_KEY) searches recent news
// to assemble context. Everything here is public, public-bound content.

const MAX_TEXT_CHARS = 20000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// Rough but dependency-free HTML -> readable text. Prefers <article>/<main>.
function htmlToText(html) {
  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ");
  const main = h.match(/<article[\s\S]*?<\/article>/i) || h.match(/<main[\s\S]*?<\/main>/i);
  if (main) h = main[0];
  const text = decodeEntities(
    h
      .replace(/<\/(p|div|h[1-6]|li|br|section)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  return text.slice(0, MAX_TEXT_CHARS);
}

function titleOf(html, fallback) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return decodeEntities(og[1]).trim();
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return t ? decodeEntities(t[1]).trim() : fallback;
}

// Fetch one article URL and return its readable text.
export async function fetchArticle(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Enter a valid http(s) URL.");
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) URLs are supported.");

  const res = await fetch(u.href, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Could not fetch the page (${res.status}). Paste the article text instead.`);
  const ct = res.headers.get("content-type") || "";
  if (!/html|text/.test(ct)) throw new Error("That URL isn't an article page. Paste the text instead.");
  const html = await res.text();
  const text = htmlToText(html);
  if (text.length < 200) throw new Error("Couldn't extract enough text (paywall or JS site?). Paste the text instead.");
  return { title: titleOf(html, u.hostname), text, url: u.href };
}

// ---- News search via GDELT (Tier B) — free, no API key ------------------
// GDELT DOC 2.0 indexes worldwide news and returns direct publisher URLs.
export function newsSearchEnabled() {
  return true; // keyless
}

function unescapeXml(s) {
  return decodeEntities(String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).replace(/<[^>]+>/g, " ").trim();
}

// Google News RSS — free, keyless. Direct-ish links + headline-level snippets.
async function searchGoogleNews(query, count) {
  const u = `https://news.google.com/rss/search?${new URLSearchParams({ q: query, hl: "en-US", gl: "US", ceid: "US:en" })}`;
  const res = await fetch(u, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`news rss ${res.status}`);
  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, count);
  return items.map((m) => {
    const b = m[1];
    const pick = (re) => (b.match(re)?.[1] || "").trim();
    return {
      title: unescapeXml(pick(/<title>([\s\S]*?)<\/title>/)),
      url: pick(/<link>([\s\S]*?)<\/link>/),
      seendate: pick(/<pubDate>([\s\S]*?)<\/pubDate>/),
      description: unescapeXml(pick(/<description>([\s\S]*?)<\/description>/)).slice(0, 600),
    };
  }).filter((r) => r.url);
}

// GDELT (direct publisher URLs, but throttles) with a Google News RSS fallback.
async function searchGdelt(query, count) {
  const params = new URLSearchParams({
    query, mode: "ArtList", format: "json",
    maxrecords: String(Math.min(Math.max(count, 1), 25)), sort: "DateDesc", timespan: "1w",
  });
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  if (!res.ok) throw new Error(`gdelt ${res.status}`);
  const data = await res.json().catch(() => ({}));
  return (data.articles || []).slice(0, count).map((a) => ({
    title: a.title, url: a.url, domain: a.domain || "", seendate: a.seendate || "", description: "",
  }));
}

// Search recent news for a query. Tries GDELT, falls back to Google News RSS.
export async function searchNews(query, { count = 5 } = {}) {
  try {
    const g = await searchGdelt(query, count);
    if (g.length) return g;
  } catch {
    /* fall through */
  }
  try {
    return await searchGoogleNews(query, count);
  } catch {
    throw new Error("News search is unavailable right now. Add a source by URL or paste the article instead.");
  }
}

// Search + fetch the top few articles + assemble a grounded context blob.
export async function buildNewsContext(query, { articles = 3 } = {}) {
  const results = await searchNews(query, { count: Math.max(articles + 3, 6) });
  if (!results.length) throw new Error(`No recent results for "${query}".`);
  const fetched = [];
  for (const r of results) {
    if (fetched.length >= articles) break;
    try {
      const a = await fetchArticle(r.url);
      fetched.push({ ...a, source: r.url });
    } catch {
      // Page couldn't be fetched (paywall/JS/bot-block) — keep the headline and
      // any snippet so the take stays grounded in real, recent items.
      fetched.push({ title: r.title, text: [r.title, r.description].filter(Boolean).join(". "), url: r.url, source: r.url });
    }
  }
  if (!fetched.length) throw new Error("Couldn't retrieve any article content for that topic.");
  const text = fetched
    .map((a, i) => `SOURCE ${i + 1}: ${a.title} (${a.url})\n${a.text.slice(0, 6000)}`)
    .join("\n\n---\n\n")
    .slice(0, MAX_TEXT_CHARS);
  return {
    name: `News: ${query}`,
    text,
    sources: fetched.map((a) => ({ title: a.title || a.url, url: a.url })),
  };
}
