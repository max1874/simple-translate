// Injected by background.js into a YouTube page's own world, where the
// player's object lives, and answers subtitles.js over DOM events. Answers are
// JSON strings: an object passed as event detail does not cross worlds.

(() => {
  if (globalThis.__simpleTranslatePlayer) return;
  globalThis.__simpleTranslatePlayer = true;

  // The player's own caption requests carry the proof-of-origin token YouTube
  // may require; the latest address per video is kept to fetch again.
  const requested = new Map();
  const note = (entries) => {
    for (const { name } of entries) {
      if (!name.includes('/api/timedtext')) continue;
      const id = new URL(name).searchParams.get('v');
      if (id) requested.set(id, name);
    }
  };
  note(performance.getEntriesByType('resource'));
  new PerformanceObserver((list) => note(list.getEntries())).observe({ type: 'resource' });

  const player = () => document.getElementById('movie_player');
  let turningOn = 0;
  const captionsShown = () => player()?.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') === 'true';

  const answers = {
    video() {
      const response = player()?.getPlayerResponse?.();
      if (!response?.videoDetails) return null;
      const list = response.captions?.playerCaptionsTracklistRenderer;
      // A dubbed video lists its audio tracks ("en-US.4"); the default one is
      // the original, even while the player plays a dub in the viewer's
      // language (MrBeast's, in Chinese, 2026-11-02).
      const original = list?.audioTracks?.[list.defaultAudioTrackIndex ?? 0]?.audioTrackId;
      return {
        id: response.videoDetails.videoId,
        title: response.videoDetails.title,
        channel: response.videoDetails.author,
        audio: original?.replace(/\.\d+$/, '') ?? null,
        tracks: (list?.captionTracks ?? []).map((t) => ({ url: t.baseUrl, lang: t.languageCode, asr: t.kind === 'asr' })),
      };
    },
    captionStyle: () => player()?.getSubtitlesUserSettings?.() ?? null,
    captionUrl: (id) => requested.get(id) ?? null,
    // Turning captions on makes the player request them. Ones already on are
    // turned off and on again: their request may predate the observer, and
    // the page fills the timeline's 250 entries long before. True if they
    // were off.
    requestCaptions() {
      if (!player()) return false;
      const shown = captionsShown();
      if (shown) player().toggleSubtitles();
      clearTimeout(turningOn);
      turningOn = setTimeout(() => player().toggleSubtitles(), 100);
      return !shown;
    },
    // Only after requestCaptions turned them on, which may still be pending.
    captionsOff() {
      clearTimeout(turningOn);
      if (captionsShown()) player().toggleSubtitles();
      return true;
    },
  };

  document.addEventListener('simple-translate:ask', (event) => {
    let question;
    try {
      question = JSON.parse(event.detail);
    } catch {
      return;
    }
    const value = answers[question.name]?.(question.arg) ?? null;
    document.dispatchEvent(new CustomEvent('simple-translate:answer', { detail: JSON.stringify({ id: question.id, value }) }));
  });
})();
