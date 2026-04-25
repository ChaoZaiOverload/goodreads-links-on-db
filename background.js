// tabId -> Promise<{url, rating, ratingCount} | null>
const preloadCache = new Map();

// Start fetching the moment Chrome commits navigation to a Douban book page,
// well before the content script runs at document_end.
chrome.webNavigation.onCommitted.addListener(
  (details) => {
    if (details.frameId !== 0) return; // main frame only
    preloadCache.set(details.tabId, preloadForDoubanUrl(details.url));
  },
  { url: [{ hostEquals: "book.douban.com", pathContains: "/subject/" }] }
);

chrome.tabs.onRemoved.addListener((tabId) => preloadCache.delete(tabId));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "FIND_GOODREADS") return false;

  const tabId = sender.tab?.id;
  // Use in-flight or completed preload if available, otherwise start fresh.
  const work =
    (tabId != null && preloadCache.get(tabId)) ??
    findGoodreadsData(msg.isbn, msg.title, msg.author);

  work
    .then((data) => sendResponse(data ?? { url: null }))
    .catch(() => sendResponse({ url: null }));

  return true;
});

// Fetch the Douban page from the background to extract book info, then
// immediately kick off the Goodreads search without waiting for the content
// script to parse the DOM.
async function preloadForDoubanUrl(doubanUrl) {
  try {
    const res = await fetch(doubanUrl, {
      headers: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    });
    if (!res.ok) return null;
    const html = await res.text();

    const isbn13 = html.match(/ISBN[:：]\s*(\d{13})/);
    const isbn10 = html.match(/ISBN[:：]\s*(\d{10})/);
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
  const query = isbn || buildTitleQuery(title, author);
  const searchUrl = `https://www.goodreads.com/search?q=${encodeURIComponent(query)}&search_type=books`;

  const res = await fetch(searchUrl, {
    headers: { "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!res.ok) throw new Error(`Goodreads search failed: ${res.status}`);

  const html = await res.text();
  const url = parseFirstBookUrl(html);
  if (!url) return null;

  try {
    const bookRes = await fetch(url, {
      headers: { "Accept-Language": "en-US,en;q=0.9" },
    });
    if (bookRes.ok) {
      const bookHtml = await bookRes.text();
      const { rating, ratingCount } = parseRatingInfo(bookHtml);
      return { url, rating, ratingCount };
    }
  } catch {}

  return { url, rating: null, ratingCount: null };
}

function buildTitleQuery(title, author) {
  return author ? `${title} ${author}` : title;
}

function parseFirstBookUrl(html) {
  const match = html.match(/href="(\/book\/show\/[^"]+)"/);
  if (!match) return null;
  const path = match[1].split("?")[0];
  return `https://www.goodreads.com${path}`;
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
