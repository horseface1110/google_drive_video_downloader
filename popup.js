const status = document.querySelector('#status');
let tabId;
let refreshVersion = 0;
let playbackNotice = '';
const starting = new Set();
const rows = new Map();

function trackLabel(track) {
  const format = track.mime.split('/')[1].toUpperCase();
  const size = track.size ? `${new Intl.NumberFormat('zh-TW', {
    maximumFractionDigits: 1,
  }).format(track.size / 1048576)} MiB` : '';
  return [format, track.itag && `格式 ${track.itag}`, size].filter(Boolean).join(' · ');
}

async function downloadTrack(track, button) {
  starting.add(track.id);
  button.disabled = true;
  playbackNotice = '正在準備下載，開始後會切換到播放器…';
  status.textContent = playbackNotice;
  try {
    const result = await chrome.runtime.sendMessage({ action: 'downloadInPlayer', tabId, id: track.id });
    if (!result) throw new Error('Missing download reply');
    playbackNotice = result.error ?? result.notice ?? '已開始下載，可在 Chrome 下載記錄查看。';
  } catch {
    playbackNotice = '未收到下載回覆，請查看 Chrome 下載記錄。';
  } finally {
    starting.delete(track.id);
    button.disabled = false;
    status.textContent = playbackNotice;
  }
}

function renderTracks(tracks) {
  const currentIds = new Set(tracks.map(track => track.id));
  for (const [id, row] of rows) {
    if (currentIds.has(id)) continue;
    row.remove();
    rows.delete(id);
  }

  for (const track of tracks) {
    const label = trackLabel(track);
    let row = rows.get(track.id);
    if (!row) {
      row = document.createElement('li');
      const info = document.createElement('span');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '下載';
      button.addEventListener('click', () => downloadTrack(track, button));
      row.append(info, button);
      rows.set(track.id, row);
    }
    const list = document.getElementById(track.kind);
    if (row.parentElement !== list) list.append(row);
    row.firstChild.textContent = label;
    const kind = track.kind === 'audio' ? '音軌' : '影片';
    row.lastChild.setAttribute('aria-label', `下載${kind}，${label}`);
    row.lastChild.disabled = starting.has(track.id);
  }

  for (const kind of ['audio', 'video']) {
    const list = document.getElementById(kind);
    list.parentElement.hidden = list.children.length === 0;
  }
}

async function refresh() {
  const version = ++refreshVersion;
  try {
    const result = await chrome.runtime.sendMessage({ action: 'list', tabId });
    if (version !== refreshVersion) return;
    if (result.error) throw new Error(result.error);
    renderTracks(result.tracks);
    let emptyMessage = '尚未收到播放請求。請重新整理 Drive 頁面，按播放後再開啟擴充功能。';
    if (result.detected) emptyMessage = '已收到播放請求，但目前無法判斷它是影片還是音軌。';
    status.textContent = result.tracks.length ? playbackNotice : emptyMessage;
  } catch {
    if (version === refreshVersion) status.textContent = '讀取清單失敗，請重新開啟擴充功能。';
  }
}

async function initialize() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !tab.url.startsWith('https://drive.google.com/')) {
    status.textContent = '請在 Google Drive 開啟影片預覽。';
    return;
  }

  tabId = tab.id;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && Object.hasOwn(changes, `tracks:${tabId}`)) refresh();
  });
  await refresh();
}

initialize().catch(() => {
  status.textContent = '無法讀取目前分頁，請重新開啟擴充功能。';
});
