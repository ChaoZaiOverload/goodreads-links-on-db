(async () => {
  const titleEl = document.querySelector("#wrapper h1 [property='v:itemreviewed']")
    || document.querySelector("#wrapper h1 span");
  if (!titleEl) return;

  const { isbn, title, author } = extractBookInfo();
  if (!title) return;

  const { wrapper, btn, tooltip } = createWidget();
  titleEl.parentElement.appendChild(wrapper);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "FIND_GOODREADS",
      isbn,
      title,
      author,
    });

    if (response?.url) {
      btn.href = response.url;
      setButtonState(btn, "found");
      if (response.rating != null || response.ratingCount != null) {
        enableTooltip(btn, tooltip, response.rating, response.ratingCount);
      }
      // Look for an English edition concurrently — non-blocking.
      lookupEnglishEdition(response.url, titleEl);
    } else {
      const query = isbn || `${title} ${author}`.trim();
      btn.href = `https://www.goodreads.com/search?q=${encodeURIComponent(query)}&search_type=books`;
      setButtonState(btn, "search");
      lookupEnglishEdition(null, titleEl);
    }
  } catch {
    wrapper.remove();
  }
})();

// ── English edition ───────────────────────────────────────────────────────────

async function lookupEnglishEdition(mainGoodreadsUrl, titleEl) {
  const enDoubanUrl = findEnglishEditionUrl();
  if (!enDoubanUrl) return;

  const { wrapper: enWrapper, btn: enBtn, tooltip: enTooltip } = createWidget("en");
  titleEl.parentElement.appendChild(enWrapper);

  try {
    const resp = await chrome.runtime.sendMessage({
      type: "FIND_GOODREADS_FOR_DOUBAN_URL",
      doubanUrl: enDoubanUrl,
    });

    if (resp?.url && resp.url !== mainGoodreadsUrl) {
      enBtn.href = resp.url;
      setButtonState(enBtn, "found");
      if (resp.rating != null || resp.ratingCount != null) {
        enableTooltip(enBtn, enTooltip, resp.rating, resp.ratingCount, "English edition");
      }
    } else {
      enWrapper.remove();
    }
  } catch {
    enWrapper.remove();
  }
}

function findEnglishEditionUrl() {
  // Try precise class selectors first.
  const section =
    document.querySelector(".subject_others_interest") ||
    document.querySelector(".subject-others-interests") ||
    document.querySelector("[class*='others-interest']");

  if (section) {
    return searchSectionForEnglish(section);
  }

  // Fall back to locating the "其他版本" h2 and walking only its
  // sibling elements (stopping at the next heading). Using closest("div")
  // would return a container that also holds recommendation sections whose
  // absolute book.douban.com links would be mistaken for English editions.
  for (const h of document.querySelectorAll("h2")) {
    if (!h.textContent.includes("其他版本")) continue;
    let el = h.nextElementSibling;
    while (el && !el.matches("h2, h3")) {
      const url = searchSectionForEnglish(el);
      if (url) return url;
      el = el.nextElementSibling;
    }
  }
  return null;
}

// Languages Douban uses to label non-English editions.
const NON_ENGLISH_LANG_LABELS = [
  "德语", "法语", "俄语", "日语", "韩语", "西班牙语",
  "葡萄牙语", "意大利语", "荷兰语", "波兰语", "阿拉伯语",
  "瑞典语", "挪威语", "丹麦语", "芬兰语", "土耳其语",
];

function searchSectionForEnglish(container) {
  const linkSelector = 'a[href^="/subject/"], a[href*="book.douban.com/subject/"]';

  // Pass 1: look for an edition card explicitly labeled 英语 or 英文.
  // Douban always shows the language on each edition card — this is the most
  // reliable signal and avoids confusing German/Russian/etc. editions whose
  // titles also happen to use Latin script.
  for (const card of container.querySelectorAll("li, dl")) {
    const cardText = card.textContent;
    if (!cardText.includes("英语") && !cardText.includes("英文")) continue;
    const a = card.querySelector(linkSelector);
    if (a?.href.includes("book.douban.com/subject/")) {
      return a.href.split("?")[0];
    }
  }

  // Pass 2: title heuristic, but skip cards that carry a non-English language label.
  for (const a of container.querySelectorAll(linkSelector)) {
    if (!a.href.includes("book.douban.com/subject/")) continue;
    const card = a.closest("li") || a.closest("dl");
    const cardText = card?.textContent ?? "";
    if (NON_ENGLISH_LANG_LABELS.some((l) => cardText.includes(l))) continue;
    const title = getEditionTitle(a);
    if (title && isLikelyEnglish(title)) return a.href.split("?")[0];
  }
  return null;
}

function getEditionTitle(linkEl) {
  const img = linkEl.querySelector("img");
  const fromImg = img?.getAttribute("title") || img?.getAttribute("alt");
  if (fromImg?.trim()) return fromImg.trim();

  const titleEl = linkEl.querySelector(".title") || linkEl.querySelector("p");
  if (titleEl?.textContent?.trim()) return titleEl.textContent.trim();

  return linkEl.textContent.trim().split("\n")[0].trim();
}

function isLikelyEnglish(text) {
  const cleaned = text.replace(/\s/g, "");
  if (!cleaned) return false;
  const latin = (cleaned.match(/[a-zA-Z]/g) || []).length;
  const cjk = (cleaned.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
  return latin > cjk && latin / cleaned.length > 0.3;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function extractBookInfo() {
  const info = {};

  const titleEl = document.querySelector("#wrapper h1 [property='v:itemreviewed']")
    || document.querySelector("#wrapper h1 span");
  info.title = titleEl?.textContent?.trim() ?? null;

  const infoDiv = document.getElementById("info");
  if (!infoDiv) return info;

  const text = infoDiv.innerText;
  const isbn13 = text.match(/ISBN[:：]\s*(\d{13})/);
  const isbn10 = text.match(/ISBN[:：]\s*(\d{10})/);
  info.isbn = (isbn13?.[1] ?? isbn10?.[1]) ?? null;

  const authorEl = infoDiv.querySelector("[rel='v:author']")
    || infoDiv.querySelector("a[href*='/author/']");
  info.author = authorEl?.textContent?.trim() ?? null;

  return info;
}

function createWidget(variant) {
  const isEn = variant === "en";

  const wrapper = document.createElement("span");
  wrapper.style.cssText = `
    display: inline-block;
    position: relative;
    vertical-align: middle;
    margin-left: 10px;
    flex-shrink: 0;
  `;

  if (isEn) {
    const badge = document.createElement("span");
    badge.textContent = "EN";
    badge.style.cssText = `
      position: absolute;
      top: -4px;
      right: -6px;
      background: #2E6DA4;
      color: white;
      font-size: 7px;
      font-weight: bold;
      font-family: Arial, sans-serif;
      border-radius: 3px;
      padding: 1px 3px;
      line-height: 1.4;
      pointer-events: none;
      z-index: 1;
    `;
    wrapper.appendChild(badge);
  }

  const idleBg     = isEn ? "#EBF3FB" : "#F4F1EA";
  const idleBorder = isEn ? "#91BAD8" : "#C9B99A";
  const hoverBg    = isEn ? "#D7E9F5" : "#E8DED0";
  const hoverBorder= isEn ? "#5B9EC9" : "#9D7F5E";

  const btn = document.createElement("a");
  btn.target = "_blank";
  btn.rel = "noopener noreferrer";
  btn.title = isEn ? "Open English edition on Goodreads" : "Open on Goodreads";
  btn.style.cssText = `
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: ${idleBg};
    border: 1.5px solid ${idleBorder};
    cursor: pointer;
    text-decoration: none;
    transition: background 0.15s, border-color 0.15s;
  `;

  const tooltip = document.createElement("div");
  tooltip.style.cssText = `
    display: none;
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    background: #FBF8F3;
    border: 1px solid #C9B99A;
    border-radius: 8px;
    padding: 9px 13px;
    white-space: nowrap;
    font-family: Georgia, serif;
    font-size: 13px;
    color: #181818;
    box-shadow: 0 3px 10px rgba(0,0,0,0.13);
    pointer-events: none;
    z-index: 99999;
  `;
  tooltip.innerHTML = `<div style="
    position:absolute; bottom:-6px; left:50%; transform:translateX(-50%);
    width:10px; height:6px; overflow:hidden;
  "><div style="
    width:10px; height:10px; background:#FBF8F3;
    border:1px solid #C9B99A; transform:rotate(45deg);
    margin-top:-6px; margin-left:0;
  "></div></div>`;

  setButtonState(btn, "loading");

  btn.addEventListener("mouseenter", () => {
    btn.style.background = hoverBg;
    btn.style.borderColor = hoverBorder;
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.background = idleBg;
    btn.style.borderColor = idleBorder;
  });

  wrapper.appendChild(tooltip);
  wrapper.appendChild(btn);
  return { wrapper, btn, tooltip };
}

function enableTooltip(btn, tooltip, rating, ratingCount, editionLabel) {
  tooltip.innerHTML = buildTooltipHTML(rating, ratingCount, editionLabel);
  btn.addEventListener("mouseenter", () => { tooltip.style.display = "block"; });
  btn.addEventListener("mouseleave", () => { tooltip.style.display = "none"; });
}

function buildTooltipHTML(rating, ratingCount, editionLabel) {
  let html = "";

  if (editionLabel) {
    html += `<div style="color:#2E6DA4;font-size:10px;font-family:Arial,sans-serif;font-weight:bold;
      text-transform:uppercase;letter-spacing:0.6px;margin-bottom:5px;">${editionLabel}</div>`;
  }

  html += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">`;
  if (rating != null) {
    html += `<span style="letter-spacing:1px;font-size:15px;">${renderStars(rating)}</span>`;
    html += `<span style="font-weight:bold;color:#553B08;font-size:14px;">${rating.toFixed(2)}</span>`;
  }
  html += `</div>`;

  if (ratingCount != null) {
    html += `<div style="color:#767676;font-size:12px;font-family:sans-serif;">
      ${ratingCount.toLocaleString()} ratings on Goodreads
    </div>`;
  }

  return html;
}

function renderStars(rating) {
  let html = "";
  for (let i = 1; i <= 5; i++) {
    const fill = Math.min(1, Math.max(0, rating - (i - 1)));
    if (fill >= 0.75) {
      html += `<span style="color:#E07B54;">★</span>`;
    } else if (fill >= 0.25) {
      html += `<span style="position:relative;display:inline-block;">` +
        `<span style="color:#C9B99A;">★</span>` +
        `<span style="position:absolute;left:0;top:0;width:50%;overflow:hidden;color:#E07B54;">★</span>` +
        `</span>`;
    } else {
      html += `<span style="color:#C9B99A;">★</span>`;
    }
  }
  return html;
}

// ── Button states ─────────────────────────────────────────────────────────────

function setButtonState(btn, state) {
  if (state === "loading") {
    btn.innerHTML = spinnerSVG();
  } else {
    btn.innerHTML = goodreadsSVG();
  }
}

function goodreadsSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="18" height="18" aria-hidden="true">
    <text x="50%" y="50%" dominant-baseline="central" text-anchor="middle"
      font-family="Georgia, serif" font-size="20" font-weight="bold" fill="#553B08">g</text>
  </svg>`;
}

function spinnerSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <style>@keyframes gr-spin{to{transform:rotate(360deg)}}</style>
    <circle cx="12" cy="12" r="9" fill="none" stroke="#C9B99A" stroke-width="3"/>
    <path d="M12 3 A9 9 0 0 1 21 12" fill="none" stroke="#553B08" stroke-width="3" stroke-linecap="round"
      style="transform-origin:12px 12px;animation:gr-spin 0.8s linear infinite"/>
  </svg>`;
}
