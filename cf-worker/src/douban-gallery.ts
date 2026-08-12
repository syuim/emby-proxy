const GALLERY_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>豆瓣图片浏览</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #0f0f0f;
  color: #e0e0e0;
  min-height: 100vh;
}
.header {
  display: flex; align-items: center; gap: 12px;
  padding: 20px 24px; background: #1a1a2e;
  border-bottom: 1px solid #2a2a4a;
  position: sticky; top: 0; z-index: 100;
}
.header h1 { font-size: 20px; font-weight: 600; color: #fff; }
.header .subtitle { font-size: 13px; color: #888; }
#app { padding: 16px 24px; max-width: 1400px; margin: 0 auto; }
.loading { text-align: center; padding: 60px; color: #666; font-size: 16px; }
.error { text-align: center; padding: 40px; color: #e74c3c; }
.cat-section { margin-bottom: 32px; }
.cat-header {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 12px; padding: 0 4px;
}
.cat-name { font-size: 17px; font-weight: 600; color: #fff; }
.cat-count { font-size: 12px; color: #666; margin-left: 4px; }

/* Arrow button */
.expand-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: 50%;
  background: linear-gradient(135deg, #2a2a4a, #3a3a5a);
  color: #aaa; cursor: pointer; border: 1px solid #4a4a6a;
  font-size: 14px; transition: all .25s; flex-shrink: 0;
  margin-left: auto; position: relative; overflow: hidden;
}
.expand-btn::before {
  content: ''; position: absolute; inset: 0; border-radius: 50%;
  background: linear-gradient(135deg, #6c5ce7, #a855f7); opacity: 0;
  transition: opacity .25s;
}
.expand-btn:hover { border-color: #6c5ce7; color: #fff; }
.expand-btn:hover::before { opacity: .3; }
.expand-btn svg { position: relative; z-index: 1; transition: transform .3s; }
.expand-btn.expanded { border-color: #6c5ce7; background: linear-gradient(135deg, #3a2a5a, #4a3a6a); }
.expand-btn.expanded svg { transform: rotate(90deg); }

/* Scroll container - hide scrollbar entirely */
.scroll-wrap {
  overflow-x: auto; overflow-y: hidden;
  scroll-behavior: smooth; padding-bottom: 8px;
  -ms-overflow-style: none; scrollbar-width: none;
}
.scroll-wrap::-webkit-scrollbar { display: none; }

.poster-row {
  display: flex; gap: 12px; min-width: min-content; padding: 4px 0;
}
.poster-card {
  flex-shrink: 0; width: 140px; cursor: pointer;
  transition: transform .15s; border-radius: 8px; overflow: hidden;
  background: #1a1a2e;
}
.poster-card:hover { transform: translateY(-3px); }
.poster-img-wrap {
  width: 140px; height: 200px; position: relative; overflow: hidden;
  background: #1a1a2e;
}
/* Skeleton placeholder shimmer */
.skeleton {
  position: absolute; inset: 0;
  background: linear-gradient(90deg, #1a1a2e 25%, #2a2a3e 50%, #1a1a2e 75%);
  background-size: 200% 100%; animation: shimmer 1.5s ease-in-out infinite;
}
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.poster-img-wrap img {
  width: 100%; height: 100%; object-fit: cover; display: block;
  opacity: 0; transition: opacity .3s;
}
.poster-img-wrap img.loaded { opacity: 1; }
.poster-card .title {
  padding: 6px 8px; font-size: 12px; color: #bbb;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.poster-card .rating {
  padding: 0 8px 6px; font-size: 11px; color: #f5c518;
}
.expanded-grid {
  display: none; grid-template-columns: repeat(auto-fill, 140px);
  gap: 12px; justify-content: center; padding: 8px 0 4px;
}
.expanded-grid.open { display: grid; }
.expanded-grid .poster-card { width: 140px; }
.expanded-grid .poster-img-wrap { width: 140px; height: 200px; }
.load-more {
  display: none; text-align: center; padding: 12px;
}
.load-more button {
  background: #2a2a4a; color: #aaa; border: 1px solid #3a3a5a;
  padding: 8px 24px; border-radius: 6px; cursor: pointer; font-size: 13px;
}
.load-more button:hover { background: #3a3a5a; color: #fff; }
@media (max-width: 600px) {
  .header { padding: 14px 16px; }
  #app { padding: 12px 12px; }
  .poster-card, .poster-card .poster-img-wrap,
  .poster-card .poster-img-wrap img { width: 110px; }
  .poster-img-wrap { height: 160px; }
  .expanded-grid { grid-template-columns: repeat(auto-fill, 110px); }
  .expanded-grid .poster-card { width: 110px; }
  .expanded-grid .poster-img-wrap { width: 110px; height: 160px; }
}
</style>
</head>
<body>
<div class="header">
  <h1>🎬 豆瓣图片浏览</h1>
  <span class="subtitle">分类浏览热门影视海报</span>
</div>
<div id="app"><div class="loading">加载中...</div></div>
<script>
// Arrow SVG icon
const ARROW_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';

(async () => {
  const app = document.getElementById('app');
  const P = '/douban';
  const CONFIG_ID = 'suyu';

  function fetchJSON(url) {
    return fetch(url).then(r => { if (!r.ok) throw new Error(\`HTTP \${r.status}\`); return r.json(); });
  }

  function ratingStr(links) {
    if (!links || !links.length) return '';
    const d = links.find(l => l.name && l.name.includes('评分'));
    return d ? '⭐ ' + d.name.replace(/^.+：/, '') : '';
  }

  function posterUrl(item) {
    return item.poster || item.background || '';
  }

  // IntersectionObserver - load image lazily
  const imgObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const wrap = entry.target;
      const img = wrap.querySelector('img');
      const skeleton = wrap.querySelector('.skeleton');
      if (img && img.dataset.src) {
        img.src = img.dataset.src;
        delete img.dataset.src;
      }
      if (skeleton) skeleton.style.animationPlayState = 'paused';
      imgObserver.unobserve(wrap);
    }
  }, { rootMargin: '200px' });

  function createCard(item) {
    const imgUrl = posterUrl(item);
    const card = document.createElement('div');
    card.className = 'poster-card';

    const imgWrap = document.createElement('div');
    imgWrap.className = 'poster-img-wrap';

    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton';
    imgWrap.appendChild(skeleton);

    const img = document.createElement('img');
    img.alt = item.name;
    if (imgUrl) {
      img.dataset.src = imgUrl;
      imgObserver.observe(imgWrap);
    } else {
      img.src = '';
    }
    img.onload = () => {
      img.classList.add('loaded');
      skeleton.remove();
    };
    img.onerror = function () {
      skeleton.remove();
      img.style.display = 'none';
    };
    imgWrap.appendChild(img);

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = item.name;

    const rating = document.createElement('div');
    rating.className = 'rating';
    rating.textContent = ratingStr(item.links);

    card.appendChild(imgWrap);
    card.appendChild(title);
    card.appendChild(rating);

    const link = (item.id || '').startsWith('tmdb:')
      ? \`https://www.themoviedb.org/\${(item.type === 'series' ? 'tv' : 'movie')}/\${item.id.split(':').pop()}\`
      : (item.links && item.links[0] && item.links[0].url !== '#' ? item.links[0].url : null);
    if (link) { card.style.cursor = 'pointer'; card.onclick = () => window.open(link, '_blank'); }
    return card;
  }

  function renderCats(catalogs, allItems) {
    app.innerHTML = '';
    for (const cat of catalogs) {
      const items = (allItems[cat.id] || []).slice(0, 10);
      if (items.length === 0) continue;

      const section = document.createElement('div');
      section.className = 'cat-section';

      const total = (allItems[cat.id] || []).length;
      let expanded = false;
      let pageItems = (allItems[cat.id] || []).slice();
      let moreSkip = 20;

      const header = document.createElement('div');
      header.className = 'cat-header';
      header.innerHTML = \`<span class="cat-name">\${cat.name}</span><span class="cat-count">(\${total})</span>\`;

      const expandBtn = document.createElement('button');
      expandBtn.className = 'expand-btn';
      expandBtn.innerHTML = ARROW_SVG;
      expandBtn.title = '展开全部';
      header.appendChild(expandBtn);

      const scrollWrap = document.createElement('div');
      scrollWrap.className = 'scroll-wrap';
      const row = document.createElement('div');
      row.className = 'poster-row';
      items.forEach(item => row.appendChild(createCard(item)));
      scrollWrap.appendChild(row);

      const expandedGrid = document.createElement('div');
      expandedGrid.className = 'expanded-grid';
      pageItems.forEach(item => expandedGrid.appendChild(createCard(item)));

      const loadMore = document.createElement('div');
      loadMore.className = 'load-more';
      const loadBtn = document.createElement('button');
      loadBtn.textContent = '加载更多';
      loadMore.appendChild(loadBtn);

      loadBtn.onclick = async () => {
        loadBtn.textContent = '加载中...';
        loadBtn.disabled = true;
        try {
          const data = await fetchJSON(\`\${P}/\${cat.configId || CONFIG_ID}/catalog/\${cat.type}/\${cat.id}.json?skip=\${moreSkip}\`);
          const newItems = data.metas || [];
          if (newItems.length === 0) { loadMore.style.display = 'none'; return; }
          newItems.forEach(item => {
            pageItems.push(item);
            expandedGrid.appendChild(createCard(item));
          });
          moreSkip += newItems.length;
          if (newItems.length < 20) loadMore.style.display = 'none';
          else { loadBtn.textContent = '加载更多'; loadBtn.disabled = false; }
        } catch (e) {
          loadBtn.textContent = '加载失败';
        }
      };

      expandBtn.onclick = () => {
        expanded = !expanded;
        expandBtn.classList.toggle('expanded');
        if (expanded) {
          expandedGrid.classList.add('open');
          scrollWrap.style.display = 'none';
          expandBtn.title = '收起';
          loadMore.style.display = total > 10 ? 'block' : 'none';
        } else {
          expandedGrid.classList.remove('open');
          scrollWrap.style.display = '';
          expandBtn.title = '展开全部';
          loadMore.style.display = 'none';
        }
      };

      section.appendChild(header);
      section.appendChild(scrollWrap);
      section.appendChild(expandedGrid);
      section.appendChild(loadMore);
      app.appendChild(section);
    }
  }

  try {
    const manifest = await fetchJSON(\`\${P}/\${CONFIG_ID}/manifest.json\`);
    const catalogs = manifest.catalogs || [];
    if (catalogs.length === 0) { app.innerHTML = '<div class="error">暂无分类数据</div>'; return; }

    const allItems = {};
    const errors = [];

    const fetchPromises = catalogs.map(async (cat) => {
      try {
        const url = \`\${P}/\${CONFIG_ID}/catalog/\${cat.type}/\${cat.id}.json?skip=0\`;
        const data = await fetchJSON(url);
        allItems[cat.id] = data.metas || [];
      } catch (e) {
        errors.push(\`\${cat.name}: \${e.message}\`);
        allItems[cat.id] = [];
      }
    });

    await Promise.all(fetchPromises);

    if (Object.values(allItems).every(arr => arr.length === 0)) {
      app.innerHTML = '<div class="error">加载数据失败</div>';
      return;
    }

    renderCats(catalogs, allItems);
  } catch (e) {
    app.innerHTML = \`<div class="error">加载失败: \${e.message}</div>\`;
  }
})();
</script>
</body>
</html>`;

export function handleDoubanGallery(): Response {
  return new Response(GALLERY_HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}