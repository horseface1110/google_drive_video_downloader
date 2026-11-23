import { downloadInPlayer } from './player-download.js';

const requestFilter = {
  urls: [
    'https://drive.google.com/*videoplayback*',
    'https://*.c.drive.google.com/*videoplayback*',
    'https://*.googleusercontent.com/*videoplayback*',
    'https://*.googlevideo.com/*videoplayback*',
    'https://drive.usercontent.google.com/*videoplayback*',
    'https://docs.google.com/*videoplayback*',
  ],
};
const pending = new Map();
const storage = chrome.storage.session;
const keyFor = tabId => `tracks:${tabId}`;

function inTabOrder(tabId, task) {
  const next = (pending.get(tabId) ?? Promise.resolve()).catch(() => {}).then(task);
  pending.set(tabId, next);
  const release = () => {
    if (pending.get(tabId) === next) pending.delete(tabId);
  };
  next.then(release, error => {
    release();
    console.error('Drive 影片下載器', error.name);
  });
  return next;
}

function downloadUrl(url) {
  const [base, query] = url.split('#', 1)[0].split(/\?(.*)/s);
  if (!query) return base;
  // Keep the original encoding and order of all retained signed parameters.
  const retained = query.split('&').filter(part => {
    const name = new URLSearchParams(part).keys().next().value;
    return name !== 'ump' && name !== 'range';
  });
  return retained.length ? `${base}?${retained.join('&')}` : base;
}

function mediaMime(value) {
  const mime = value?.split(';')[0].trim().toLowerCase();
  return /^(audio|video)\/[\w.+-]+$/.test(mime ?? '') ? mime : null;
}

const mimeByItag = new Map([
  ...[139, 140, 141, 256, 258].map(itag => [String(itag), 'audio/mp4']),
  ...[171, 172, 249, 250, 251].map(itag => [String(itag), 'audio/webm']),
  ...[18, 22, 133, 134, 135, 136, 137, 160, 264, 266, 298, 299]
    .map(itag => [String(itag), 'video/mp4']),
  ...[43, 44, 45, 46, 242, 243, 244, 247, 248, 271, 272, 278, 302, 303, 308, 313, 315]
    .map(itag => [String(itag), 'video/webm']),
]);

function capture(details) {
  const { tabId } = details;
  if (tabId < 0) return;
  let url;
  try {
    url = new URL(details.url);
  } catch {
    return;
  }
  if (url.protocol !== 'https:' || !(
    ['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'].includes(url.hostname) ||
    /(^|\.)c\.drive\.google\.com$/.test(url.hostname) ||
    /(^|\.)(googlevideo|googleusercontent)\.com$/.test(url.hostname)
  )) return;
  if (!url.pathname.split('/').includes('videoplayback')) return;
  const itag = url.searchParams.get('itag')?.match(/^\d+$/)?.[0];
  const typeHeader = details.responseHeaders?.find(header => header.name.toLowerCase() === 'content-type');
  const explicitMime = mediaMime(url.searchParams.get('mime')) ?? mediaMime(typeHeader?.value);
  const mime = explicitMime ?? mimeByItag.get(itag);
  const kind = mime?.split('/')[0];
  const normalized = downloadUrl(details.url);
  const mediaId = url.searchParams.get('id') ?? url.searchParams.get('docid');
  const identity = mediaId && itag ? JSON.stringify([mediaId, itag]) : normalized;
  const size = Number(url.searchParams.get('clen'));
  const track = {
    identity, url: normalized, kind, mime, itag, explicitMime: Boolean(explicitMime),
    size: Number.isSafeInteger(size) && size > 0 ? size : null,
  };

  inTabOrder(tabId, async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url?.startsWith('https://drive.google.com/')) return;
    const key = keyFor(tabId);
    const state = (await storage.get(key))[key];
    if (!mime) {
      if (!state) await storage.set({ [key]: { tracks: [] } });
      return;
    }
    const tracks = state?.tracks ?? [];
    const index = tracks.findIndex(item => item.identity === identity);
    if (index >= 0 && tracks[index].explicitMime && !track.explicitMime) return;
    track.id = index >= 0 ? tracks[index].id : crypto.randomUUID();
    if (index >= 0) tracks[index] = track;
    else tracks.push(track);
    await storage.set({ [key]: { tracks: tracks.slice(-80) } });
  });
}

chrome.webRequest.onBeforeRequest.addListener(capture, requestFilter);
chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.statusCode >= 200 && details.statusCode < 300) capture(details);
}, requestFilter, ['responseHeaders']);

function clearTab(tabId) {
  inTabOrder(tabId, () => storage.remove(keyFor(tabId)));
}

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId === 0) clearTab(tabId);
});
chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId }) => {
  if (frameId === 0) clearTab(tabId);
});
chrome.tabs.onRemoved.addListener(clearTab);

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.action === 'observePlayback' && Number.isInteger(sender.tab?.id) &&
      typeof message.url === 'string') {
    capture({ tabId: sender.tab.id, url: message.url });
    return;
  }

  if (sender.url !== chrome.runtime.getURL('popup.html') ||
      !['list', 'downloadInPlayer'].includes(message?.action) ||
      !Number.isInteger(message.tabId)) return;

  const { tabId } = message;
  inTabOrder(tabId, async () => {
    const key = keyFor(tabId);
    const state = (await storage.get(key))[key];
    const tracks = state?.tracks ?? [];
    if (message.action === 'list') {
      return {
        detected: Boolean(state),
        tracks: tracks.map(({ id, kind, mime, itag, size }) => ({ id, kind, mime, itag, size })),
      };
    }

    const track = tracks.find(item => item.id === message.id);
    if (!track) return { error: '這個項目已失效，請重新播放影片。' };
    return downloadInPlayer(tabId, track.url);
  }).then(reply, () => reply({
    error: message.action === 'list' ? '讀取清單失敗。' : '無法處理媒體，請重新播放影片後再試。',
  }));
  return true;
});
