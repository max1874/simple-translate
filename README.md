# Simple Translate 简单翻译

A minimal Chrome extension that does one thing: translates the page you are reading with your own LLM and shows each translation right below its original paragraph.

一个极简的 Chrome 扩展，只做一件事：用你自己的大模型翻译当前网页，把译文放在每段原文下面。

- **One click.** Click the toolbar icon or press <kbd>Alt</kbd>+<kbd>A</kbd> to translate; press again to restore the page.
- **Only what you read.** Paragraphs are translated as they scroll near the screen, in batches.
- **Your model, your key.** Any OpenAI-compatible API: OpenAI, DeepSeek, OpenRouter, Ollama, LM Studio, and others.
- **Nothing runs until you ask.** No content script on every page, no `<all_urls>` permission, no analytics, no server of ours. The page text goes only to the API you configured.
- **Small.** Plain JavaScript, no dependencies, no build step.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the repository folder.
3. The settings page opens on first click. Fill in:
   - **API base URL**, e.g. `https://api.openai.com/v1`, `https://api.deepseek.com`, `https://openrouter.ai/api/v1`, `http://localhost:11434/v1`
   - **API key** (leave empty for local servers)
   - **Model**, e.g. `gpt-4.1-mini`, `deepseek-chat`
   - **Translate into**
4. Click **Save and test**. Chrome asks once for permission to reach the API host.

For reasoning models, put `{"reasoning_effort": "none"}` (or what your provider accepts) in **Extra request fields** to keep translations fast.

## How it works

- `background.js` injects the content script into the current tab when you click, and sends translation requests to `{base URL}/chat/completions`.
- `content.js` splits the page into paragraphs (runs of inline content between block elements and `<br>`), skips code, navigation, form controls and text already in the target language, and inserts a `<span class="simple-translate">` after each paragraph near the viewport.
- Paragraphs go to the model in batches of up to 8 as a JSON object (`{"1": "...", "2": "..."}`) and come back with the same keys. A reply that misses a key, or looks shifted (two keys with the same translation, a key holding another paragraph's source, or a translation/source length ratio far from the rest of the batch), is discarded and the batch is retried one paragraph at a time. Only accepted translations are cached.
- Content added later (infinite scroll, single-page apps) is picked up while translation is on.

## Privacy

Settings, including the API key, are stored in `chrome.storage.local` in your browser. Page text is sent only to the API base URL you set, and only after you turn translation on for that tab. The extension makes no other network requests.

## License

[MIT](LICENSE)
