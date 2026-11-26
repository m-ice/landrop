'use strict';

// Bundle the same static assets that the page is running into a portable HTML file.
window.downloadLanChat = async function () {
  const pageUrl = new URL('index.html', location.href);
  async function readAsset(path) {
    const url = new URL(path, pageUrl);
    const response = await fetch(url, { mode: 'same-origin' });
    if (!response.ok) throw new Error('离线网页资源读取失败，请重试。');
    return response.text();
  }

  const source = await readAsset(pageUrl);
  const page = new DOMParser().parseFromString(source, 'text/html');
  const assets = page.querySelectorAll('link[rel="stylesheet"], script[src]');
  const replacements = await Promise.all([...assets].map(async asset => {
    const isScript = asset.localName === 'script';
    const path = asset.getAttribute(isScript ? 'src' : 'href');
    if (isScript && new URL(path, pageUrl).href === new URL('offline.js', pageUrl).href) return null;
    const replacement = page.createElement(isScript ? 'script' : 'style');
    replacement.textContent = await readAsset(path);
    if (replacement.textContent.toLowerCase().includes(`</${replacement.localName}`)) {
      throw new Error('离线网页打包失败，请重试。');
    }
    return replacement;
  }));
  assets.forEach((asset, index) => {
    const replacement = replacements[index];
    if (replacement?.localName === 'style') asset.replaceWith(replacement);
    else {
      // Inline classic scripts run immediately. Keep them after the markup, in source order.
      if (replacement) page.body.append(replacement);
      asset.remove();
    }
  });
  const url = URL.createObjectURL(new Blob([`<!doctype html>\n${page.documentElement.outerHTML}`], { type: 'text/html' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = '邻传聊天.html';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
};
