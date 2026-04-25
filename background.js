// tabId -> { urlP: Promise<string|null>, ratingsP: Promise<{rating,ratingCount}|null> }
const preloadCache = new Map();

chrome.webNavigation.onCommitted.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    preloadCache.set(details.tabId, buildLookupFromDouban(details.url));
  },
  { url: [{ hostEquals: "book.douban.com", pathContains: "/subject/" }] }
);

chrome.tabs.onRemoved.addListener((tabId) => preloadCache.delete(tabId));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (msg.type === "FIND_GOODREADS_URL") {
    let lookup = tabId != null ? preloadCache.get(tabId) : null;
    if (!lookup) {
      lookup = buildLookupFromInfo(msg.isbn, msg.title, msg.author);
      if (tabId != null) preloadCache.set(tabId, lookup);
    }
    lookup.urlP
      .then((url) => sendResponse({ url }))
      .catch(() => sendResponse({ url: null }));
    return true;
  }

  if (msg.type === "FIND_GOODREADS_RATINGS") {
    const lookup = tabId != null ? preloadCache.get(tabId) : null;
    if (!lookup?.ratingsP) {
      sendResponse({ rating: null, ratingCount: null });
      return false;
    }
    lookup.ratingsP
      .then((data) => sendResponse(data ?? { rating: null, ratingCount: null }))
      .catch(() => sendResponse({ rating: null, ratingCount: null }));
    return true;
  }

  return false;
});

// Preload path: fetch the Douban page to extract book info before the content
// script runs, then immediately start both Goodreads fetches as chained promises.
function buildLookupFromDouban(doubanUrl) {
  const infoP = fetch(doubanUrl, {
    headers: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
  })
    .then((r) => (r.ok ? r.text() : Promise.reject()))
    .then(extractBookInfoFromHtml)
    .catch(() => null);

  const urlP = infoP.then((info) =>
    info ? fetchGoodreadsUrl(info.isbn, info.title, info.author) : null
  );
  const ratingsP = urlP.then((url) => (url ? fetchRatings(url) : null));

  return { urlP, ratingsP };
}

// Fresh-fetch path (no preload cache hit).
function buildLookupFromInfo(isbn, title, author) {
  const urlP = fetchGoodreadsUrl(isbn, title, author);
  const ratingsP = urlP.then((url) => (url ? fetchRatings(url) : null));
  return { urlP, ratingsP };
}

function extractBookInfoFromHtml(html) {
  const isbn13 = html.match(/ISBN[:：]\s*(\d{13})/);
  const isbn10 = html.match(/ISBN[:：]\s*(\d{10})/);
  const isbn = isbn13?.[1] ?? isbn10?.[1] ?? null;

  const titleMatch = html.match(/property="v:itemreviewed">([^<]+)</);
  const title = titleMatch?.[1]?.trim() ?? null;

  const authorMatch = html.match(/rel="v:author"[^>]*>([^<]+)</);
  const author = authorMatch?.[1]?.trim() ?? null;

  return isbn || title ? { isbn, title, author } : null;
}

async function fetchGoodreadsUrl(isbn, title, author) {
  const query = isbn || (author ? `${title} ${author}` : title);
  const searchUrl = `https://www.goodreads.com/search?q=${encodeURIComponent(query)}&search_type=books`;

  const res = await fetch(searchUrl, { headers: { "Accept-Language": "en-US,en;q=0.9" } });
  if (!res.ok) return null;

  const html = await res.text();
  const match = html.match(/href="(\/book\/show\/[^"]+)"/);
  if (!match) return null;
  return `https://www.goodreads.com${match[1].split("?")[0]}`;
}

async function fetchRatings(bookUrl) {
  try {
    const res = await fetch(bookUrl, { headers: { "Accept-Language": "en-US,en;q=0.9" } });
    if (!res.ok) return null;
    return parseRatingInfo(await res.text());
  } catch {
    return null;
  }
}

function parseRatingInfo(html) {
  const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (ldMatch) {
    try {
      const data = JSON.parse(ldMatch[1]);
      if (data.aggregateRating) {
        return {
          rating: parseFloat(data.aggregateRating.ratingValue),
          ratingCount: parseInt(data.aggregateRating.ratingCount, 10),
        };
      }
    } catch {}
  }

  const ratingMatch = html.match(/class="RatingStatistics__rating[^"]*"[^>]*>\s*([0-9.]+)/);
  const countMatch = html.match(/([\d,]+)\s+ratings/);
  return {
    rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
    ratingCount: countMatch ? parseInt(countMatch[1].replace(/,/g, ""), 10) : null,
  };
}
