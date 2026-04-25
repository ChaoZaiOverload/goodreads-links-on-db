// tabId -> Promise<{url, rating, ratingCount} | null>
const preloadCache = new Map();

// Start fetching the moment Chrome commits navigation to a Douban book page,
// well before the content script runs at document_end.
chrome.webNavigation.onCommitted.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    preloadCache.set(details.tabId, fetchDataForDoubanUrl(details.url));
  },
  { url: [{ hostEquals: "book.douban.com", pathContains: "/subject/" }] }
);

chrome.tabs.onRemoved.addListener((tabId) => preloadCache.delete(tabId));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (msg.type === "FIND_GOODREADS") {
    const work =
      (tabId != null && preloadCache.get(tabId)) ??
      findGoodreadsData(msg.isbn, msg.title, msg.author);
    work
      .then((data) => sendResponse(data ?? { url: null }))
      .catch(() => sendResponse({ url: null }));
    return true;
  }

  // Ad-hoc lookup for a secondary Douban page (e.g. an English edition).
  if (msg.type === "FIND_GOODREADS_FOR_DOUBAN_URL") {
    fetchDataForDoubanUrl(msg.doubanUrl)
      .then((data) => sendResponse(data ?? { url: null }))
      .catch(() => sendResponse({ url: null }));
    return true;
  }

  return false;
});

// Fetch a Douban page, extract book info, then search Goodreads.
// Used for both the main preload and secondary edition lookups.
async function fetchDataForDoubanUrl(doubanUrl) {
  try {
    const res = await fetch(doubanUrl, {
      headers: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    });
    if (!res.ok) return null;
    const html = await res.text();

    const isbn13 = html.match(/ISBN[:：][^0-9]*(\d{13})/);
    const isbn10 = html.match(/ISBN[:：][^0-9]*(\d{10})/);
    const isbn = isbn13?.[1] ?? isbn10?.[1] ?? null;

    const titleMatch = html.match(/property="v:itemreviewed">([^<]+)</);
    const title = titleMatch?.[1]?.trim() ?? null;

    const authorMatch = html.match(/rel="v:author"[^>]*>([^<]+)</);
    const author = authorMatch?.[1]?.trim() ?? null;

    if (!isbn && !title) return null;
    return findGoodreadsData(isbn, title, author);
  } catch {
    return null;
  }
}

async function findGoodreadsData(isbn, title, author) {
  const query = isbn || (author ? `${title} ${author}` : title);
  const searchUrl = `https://www.goodreads.com/search?q=${encodeURIComponent(query)}&search_type=books`;

  const res = await fetch(searchUrl, {
    headers: { "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!res.ok) throw new Error(`Goodreads search failed: ${res.status}`);

  // ISBN searches redirect straight to the book page — the redirect URL
  // is the answer; no need to parse links from the HTML.
  if (res.url.includes("/book/show/")) {
    const url = res.url.split("?")[0];
    const { rating, ratingCount } = parseRatingInfo(await res.text());
    return { url, rating, ratingCount };
  }

  // Title/author search — find the first result via its class="bookTitle" link.
  const html = await res.text();
  const match =
    html.match(/class="bookTitle"[^>]*href="(\/book\/show\/[^"?]*)/) ||
    html.match(/href="(\/book\/show\/[^"?]*)"[^>]*class="bookTitle"/);
  if (!match) return null;
  const url = `https://www.goodreads.com${match[1]}`;

  try {
    const bookRes = await fetch(url, { headers: { "Accept-Language": "en-US,en;q=0.9" } });
    if (bookRes.ok) {
      const { rating, ratingCount } = parseRatingInfo(await bookRes.text());
      return { url, rating, ratingCount };
    }
  } catch {}

  return { url, rating: null, ratingCount: null };
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
