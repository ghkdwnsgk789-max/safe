// /api/news-fetch.js
// 중대재해 관련 뉴스를 카테고리별로 실시간 수집하는 Vercel 서버리스 함수.
//
// 방식: 구글 뉴스 RSS 피드(news.google.com/rss/search)를 카테고리별 검색어로
// 각각 조회한다. 이 RSS는 별도 API 키가 필요 없는 공개 피드이며, 브라우저에서
// 직접 호출하면 CORS로 막히므로 서버(이 함수)가 대신 호출해서 중계한다.
//
// ⚠️ 참고: 이건 "매번 접속 시점에 그 자리에서 최신 뉴스를 가져오는" 방식입니다.
//   과거 뉴스를 누적 보관하는 "500건 아카이브" 기능은 별도 데이터베이스(Vercel KV 등)와
//   정기 자동수집(Vercel Cron)이 추가로 필요해서, 이번 1차 버전에는 포함되어 있지 않습니다.

const CATEGORY_QUERIES = {
  '중대재해':          '중대재해 사망사고',
  '지자체/공공기관':    '중대재해 예방 지자체 산업안전',
  '건설안전':          '건설현장 사고 안전',
  '안전보건관리체계':   '안전보건관리체계 안전경영',
  '법령/제도':         '중대재해처벌법 산업안전보건법 개정',
};

const PER_CATEGORY_LIMIT = 8;

function parseRss(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml))) {
    const block = m[1];
    const pick = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
      const mm = block.match(r);
      return mm ? mm[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
    };
    const title = pick('title');
    const link = pick('link');
    const pubDate = pick('pubDate');
    const source = pick('source');
    if (title && link) items.push({ title, link, pubDate, source });
  }
  return items;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const results = [];
    for (const [category, query] of Object.entries(CATEGORY_QUERIES)) {
      try {
        const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (seahcm-safety-platform)' } });
        if (!r.ok) continue;
        const xml = await r.text();
        const items = parseRss(xml).slice(0, PER_CATEGORY_LIMIT);
        items.forEach(it => results.push({ ...it, category }));
      } catch (innerErr) {
        // 특정 카테고리 하나가 실패해도 나머지는 계속 진행
        continue;
      }
    }

    // 중복 링크 제거 (여러 카테고리 검색어에 동시에 걸리는 기사 방지)
    const seen = new Set();
    const deduped = results.filter(a => {
      if (seen.has(a.link)) return false;
      seen.add(a.link);
      return true;
    });

    deduped.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    res.status(200).json({
      fetchedAt: new Date().toISOString(),
      count: deduped.length,
      articles: deduped,
    });
  } catch (err) {
    res.status(502).json({ error: '뉴스 수집 중 오류가 발생했습니다.', detail: String(err.message || err) });
  }
};
