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
.expand-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 50%;
  background: #2a2a4a; color: #888; cursor: pointer; border: none;
  font-size: 16px; transition: all .2s; flex-shrink: 0;
  margin-left: auto;
}
.expand-btn:hover { background: #3a3a5a; color: #fff; }
.expand-btn.expanded { transform: rotate(90deg); background: #4a4a6a; color: #fff; }
.scroll-wrap {
  overflow-x: auto; overflow-y: hidden;
  scroll-behavior: smooth; padding-bottom: 8px;
}
.scroll-wrap::-webkit-scrollbar { height: 6px; }
.scroll-wrap::-webkit-scrollbar-track { background: transparent; }
.scroll-wrap::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
.poster-row {
  display: flex; gap: 12px; min-width: min-content; padding: 4px 0;
}
.poster-card {
  flex-shrink: 0; width: 140px; cursor: pointer;
  transition: transform .15s; border-radius: 8px; overflow: hidden;
  background: #1a1a2e;
}
.poster-card:hover { transform: translateY(-3px); }
.poster-card img {
  width: 140px; height: 200px; object-fit: cover;
  display: block; background: #222;
}
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
.expanded-grid .poster-card img { width: 140px; height: 200px; }
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
  .poster-card, .poster-card img { width: 110px; }
  .poster-card img { height: 160px; }
  .expanded-grid { grid-template-columns: repeat(auto-fill, 110px); }
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

  function createCard(item) {
    const img = posterUrl(item);
    const card = document.createElement('div');
    card.className = 'poster-card';
    card.innerHTML = \`
      <img src="\${img}" alt="\${item.name}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22140%22 height=%22200%22><rect fill=%22%23222%22 width=%22140%22 height=%22200%22/><text x=%2250%%22 y=%2250%%22 text-anchor=%22middle%22 fill=%22%23555%22 font-size=%2212%22>无图</text></svg>'">
      <div class="title">\${item.name}</div>
      <div class="rating">\${ratingStr(item.links)}</div>
    \`;
    const link = (item.id || '').startsWith('tmdb:')
      ? \`https://www.themoviedb.org/\${(item.type==='series'?'tv':'movie')}/\${item.id.split(':').pop()}\`
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

      const header = document.createElement('div');
      header.className = 'cat-header';
      header.innerHTML = \`<span class="cat-name">\${cat.name}</span><span class="cat-count">(\${total})</span>\`;

      const expandBtn = document.createElement('button');
      expandBtn.className = 'expand-btn';
      expandBtn.textContent = '→';
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

      let skip = 20;
      loadBtn.onclick = async () => {
        loadBtn.textContent = '加载中...';
        loadBtn.disabled = true;
        try {
          const data = await fetchJSON(\`\${P}/\${cat.configId || CONFIG_ID}/catalog/\${cat.type}/\${cat.id}.json?skip=\${skip}\`);
          const newItems = data.metas || [];
          if (newItems.length === 0) { loadMore.style.display = 'none'; return; }
          newItems.forEach(item => {
            pageItems.push(item);
            expandedGrid.appendChild(createCard(item));
          });
          skip += newItems.length;
          if (newItems.length < 20) loadMore.style.display = 'none';
          else { loadBtn.textContent = '加载更多'; loadBtn.disabled = false; }
        } catch(e) {
          loadBtn.textContent = '加载失败';
        }
      };

      expandBtn.onclick = async () => {
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
      } catch(e) {
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
  } catch(e) {
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