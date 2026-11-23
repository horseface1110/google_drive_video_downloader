function reportPlayback(entries) {
  for (const entry of entries) {
    if (entry.name.includes('/videoplayback?')) {
      chrome.runtime.sendMessage({ action: 'observePlayback', url: entry.name }).catch(() => {});
    }
  }
}

// The resource timeline can also expose requests made by an embedded player.
new PerformanceObserver(list => reportPlayback(list.getEntries()))
  .observe({ type: 'resource', buffered: true });
