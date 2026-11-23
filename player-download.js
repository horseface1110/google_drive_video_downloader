function prepareMediaDownload() {
  const media = document.querySelector('video, audio');
  const source = media?.currentSrc || media?.src || media?.querySelector('source')?.src;
  if (source !== location.href || !document.body) return null;
  if (media.error) return { error: '播放器無法讀取這個媒體連結。' };

  media.pause();
  const startedAfter = new Date().toISOString();
  const link = document.createElement('a');
  link.href = source;
  link.download = media.title;
  document.body.append(link);
  link.click();
  link.remove();
  return { source, startedAfter };
}

function seekAndPlay(source, fraction) {
  if (location.href !== source) return 'unavailable';
  const media = document.querySelector('video, audio');
  if (!media || media.error) return 'unavailable';
  if (!Number.isFinite(media.duration) || media.duration <= 0) return 'pending';

  media.currentTime = media.duration * fraction;
  if (media.paused) {
    media.play().catch(error => {
      if (error.name !== 'NotAllowedError' || media.muted) return;
      media.muted = true;
      media.play().catch(() => { media.muted = false; });
    });
  }
  return 'seeked';
}

const wait = delay => new Promise(resolve => setTimeout(resolve, delay));

async function seekDuringDownload(tabId, downloadId, source) {
  const metadataDeadline = Date.now() + 8000;
  let percent = 1 + Math.floor(Math.random() * 99);
  try {
    while (true) {
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (item?.state !== 'in_progress') return;

      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        func: seekAndPlay,
        args: [source, percent / 100],
        injectImmediately: true,
      });
      if (injection?.result === 'seeked') {
        const previousPercent = percent;
        percent = 1 + Math.floor(Math.random() * 98);
        if (percent >= previousPercent) percent += 1;
        await wait(5000);
        continue;
      }
      if (injection?.result !== 'pending' || Date.now() >= metadataDeadline) return;
      await wait(250);
    }
  } catch (error) {
    console.warn('Drive 影片下載器，自動跳轉已停止', error.name);
  }
}

export async function downloadInPlayer(sourceTabId, url) {
  const tab = await chrome.tabs.create({ url, openerTabId: sourceTabId, active: false });
  let downloadStarted = false;
  try {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const current = await chrome.tabs.get(tab.id);
      if (current.url?.startsWith('https:')) {
        let injection;
        try {
          [injection] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: prepareMediaDownload,
            injectImmediately: true,
          });
        } catch (error) {
          if (current.status === 'complete') {
            return { error: 'Chrome 無法在播放器頁面執行下載程式。' };
          }
          await wait(250);
          continue;
        }
        const result = injection?.result;
        if (result?.error) return { error: result.error };
        if (result?.source) {
          const downloadDeadline = Date.now() + 5000;
          while (Date.now() < downloadDeadline) {
            const items = await chrome.downloads.search({
              startedAfter: result.startedAfter,
              url: result.source,
            });
            const item = items.find(item => item.state !== 'interrupted');
            if (item) {
              downloadStarted = true;
              try {
                await chrome.tabs.update(tab.id, { active: true });
              } catch {
                return { notice: '已開始下載，但無法切換到播放器分頁。' };
              }
              void seekDuringDownload(tab.id, item.id, result.source);
              return {};
            }
            if (items.length) return { error: 'Chrome 已中斷下載，請查看下載記錄。' };
            await wait(250);
          }
          return { error: '已發出下載請求，但 Chrome 尚未確認下載開始。' };
        }
      }
      await wait(250);
    }
    return { error: '播放器分頁未載入可播放的媒體。' };
  } finally {
    if (!downloadStarted) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}
