# Chrome Web Store listing

Everything the developer dashboard asks for, kept here so a resubmission copies
it instead of rewriting it. The extension's name and the one-line description
come from `_locales/*/messages.json` (`extName`, `extDescription`) — the store
reads them from the package, so they are not repeated here.

The store name is **Plain Translate** in English and **简单翻译** in Chinese:
"Simple Translate" is taken on the store by another developer's extension
(sienori, `ibplnjkanclpjokhdolnendpplpjiace`). The repository and the site page
keep the `simple-translate` slug.

The developer account is the Google account **starlink1874@gmail.com** (item
`agbnnlocgcdpnkkbfooojejhnpcemiko`); open the dashboard as
`https://chrome.google.com/webstore/devconsole?authuser=starlink1874@gmail.com`,
since the browser's first Google account is a different one. The dashboard asks
for a passkey re-check now and then, which only Max can do.

## Package

`sh tools/package.sh` → `dist/plain-translate-<version>.zip`. Bump `version` in
`manifest.json` before every upload; the store rejects a version it has seen.

## Store listing tab

- **Category**: Productivity → Tools
- **Language**: English (default), plus a Chinese (Simplified) listing
- **Icon**: `icons/128.png` has an 8 px margin; the store prefers 96×96 artwork
  on a 128×128 transparent canvas, rendered from `icons/icon.svg` with 16 px
  padding (`store/store-icon-128.png`, source `store/source/store-icon.html`)
- **Screenshots**: 1280×800, in `store/screenshots/`; `en-*` for the English
  listing (Chinese and Japanese pages translated into English), `zh-*` for the
  Chinese listing (English pages translated into Chinese). Taken 2026-10-16 with
  DeepSeek V4.1 Flash on OpenRouter; `*-3-settings.png` retaken 2026-10-21 from
  the 1.0.2 settings page (1024×640 at 1.25×). The key shown on the settings
  page is a placeholder. `zh-4-youtube-subtitles.png` (2026-11-02, Chinese
  listing only) is a 1.1.0 YouTube video with DeepSeek `deepseek-flash`
  subtitles, cropped from the player; `en-4-youtube-subtitles.png`
  (2026-11-02, English listing only) the same for a Chinese talk translated
  into English by 1.1.1.
- **Small promo tile**: 440×280, `store/promo-440x280.png` (English),
  `store/promo-440x280.zh.png` (Chinese); sources in `store/source/`
- **Homepage URL**: https://max1874.com/simple-translate/
- **Support URL**: https://github.com/max1874/simple-translate/issues

### Detailed description — English

Plain Translate translates the page you are reading with your own LLM and puts each translation under its paragraph. The original stays as it is.

• One key to toggle — click the toolbar icon or press Alt+A (⌥A on macOS). Press again and the page is back to how it was.

• YouTube bilingual subtitles — turn them on once in settings and a button appears in YouTube's player, next to CC. Translated subtitles show under the original line inside the player, full screen too, in the caption style you set on YouTube, and stay on from video to video until you turn the button off. Uploaded subtitles are joined into whole sentences before translating; automatic captions, and subtitles written without punctuation as Chinese ones usually are, are punctuated and split into sentences by your model in the same request. The video's title, channel and the previous lines go along, so names and terms stay consistent. When the uploader already provides subtitles in your language, those are shown and no model is called.

• What you are reading comes first — paragraphs on screen are translated first, in parallel, and each appears as soon as it is written. The rest follow as you scroll; content loaded later by infinite scroll or single-page apps is translated too.

• Formatting carries over — links, bold and italics stay in the translation; inline code and keys are copied as they are. Code, navigation, form controls and paragraphs already in your language are skipped.

• Your model, your key — presets for OpenRouter, OpenAI, DeepSeek and a local Ollama, or any OpenAI-compatible address. Type a model name or search the service's model list. Keys are saved per service.

• Nothing runs until you click — no script on every page and no access to all websites: the extension is injected into the current tab when you click, and asks only for access to the service address you picked, plus youtube.com if you turn YouTube subtitles on.

• No server, no analytics — page text goes only to the service you chose, under your own account and its standard rates. The developer receives nothing.

Translate into any of 13 languages. Open source (MIT), plain JavaScript with no dependencies: https://github.com/max1874/simple-translate

Privacy policy: https://max1874.com/simple-translate/privacy

### Detailed description — 简体中文

简单翻译用你自己的大模型翻译正在读的网页，把译文放在每段原文下面，原文不动。

• 一键开关——点工具栏图标或按 ⌥A（Windows / Linux 上是 Alt+A）。再按一次，页面恢复原样。

• YouTube 双语字幕——在设置里打开一次，YouTube 播放器里 CC 旁边就多一个按钮。译文显示在播放器里的原文字幕下面，全屏也有，样式跟随你在 YouTube 设置的字幕样式；换视频保持打开，直到你关掉按钮。人工字幕先拼回整句再翻；自动生成的字幕，以及中文这类不带标点的字幕，由你的模型在同一次请求里加标点、断句、翻译。视频标题、频道名和前几句一起发过去，人名和术语前后一致。作者已经传了你要的语言的字幕，就直接显示，不调模型。

• 先翻你在看的——屏幕上的段落先翻、并行发出，每段写完立刻显示；往下滚再继续。无限滚动、单页应用后来加载的内容也会补翻。

• 保留格式——链接、加粗、斜体在译文里保留，行内代码和按键原样复制。代码、导航、表单控件和已经是目标语言的段落自动跳过。

• 用你自己的模型和 Key——内置 OpenRouter、OpenAI、DeepSeek、本地 Ollama，也可以填任何兼容 OpenAI 接口的地址。模型可以直接输入，也可以从服务商的模型列表里搜索。每个服务的 Key 分开保存。

• 你不点，它就不动——不在每个网页常驻脚本，不要「读取所有网站」的权限：只在你点击时注入当前标签页，只申请访问你选的那个服务地址；打开 YouTube 字幕时再申请 youtube.com。

• 没有服务器，没有统计——网页文字只发给你选的服务，用你自己的账号、按服务商的标准价格计费。开发者收不到任何数据。

可翻译成 13 种语言。开源（MIT），纯 JavaScript，没有依赖：https://github.com/max1874/simple-translate

隐私政策：https://max1874.com/simple-translate/privacy

## Privacy practices tab

### Single purpose

Translates the web page the user is reading, on request, with an LLM service the user configures, and shows each translation under its original paragraph; on YouTube, when the user turns bilingual subtitles on, it translates the video's subtitles and shows them under the original subtitle line.

### Permission justifications

- **activeTab**: gives access to the current tab only when the user clicks the toolbar icon or presses the shortcut, so the extension needs no access to all websites.
- **scripting**: injects the translation script and its styles into that tab at that moment; nothing is injected into pages the user has not turned translation on for. Once the user allows youtube.com from the settings switch, it registers the subtitles button's scripts on youtube.com pages, including a small script in the page's own context that reads the player's subtitle tracks, caption style settings and the current video's id, title and channel, and turns YouTube's own captions off while the translated ones are shown. Turning the switch off removes the access and the scripts.
- **storage**: saves the user's settings: the chosen service, its API key, model, reasoning level, address (custom service only), and the target language.
- **Optional host permissions `https://*/*`, `http://*/*`**: the translation service is any OpenAI-compatible address the user enters, including a local Ollama on `http://localhost`, so its host cannot be listed in advance. They are optional: at run time the extension requests access only to the one origin of the service the user picked, and uses it only to send translation and model-list requests there. The only other origin requested is `https://www.youtube.com/*`, and only when the user turns on "YouTube bilingual subtitles" in settings; it lets the subtitles button run in YouTube's player. Other page access comes from activeTab, not from these.

### Remote code

No. All JavaScript is in the package; the extension loads no external scripts and evaluates no strings as code. Its only network requests are to the translation service the user configured.

### Data usage

Declare:

- **Website content** — the text of the paragraphs being translated, sent to the translation service the user configured, only after the user turns translation on for that tab. On a YouTube video page, the video's subtitles with its title and channel name instead.
- **Authentication information** — the user's API key for that service, stored in `chrome.storage.local` and sent only to that service in the request header.

Certify all three:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL**: https://max1874.com/simple-translate/privacy

## Distribution tab

- **Visibility**: Public
- **Regions**: all
- **Pricing**: free

## Test instructions

The dashboard's "Test instructions" page, "其他说明" field, at most 500 characters:

Needs an API key for an OpenAI-compatible LLM service; no account with the developer. Open settings (click the toolbar icon once), pick OpenRouter, paste a key, allow openrouter.ai when Chrome asks, press Test. On an English article (en.wikipedia.org) click the icon or press Alt+A: translations appear under paragraphs. YouTube: turn on "YouTube bilingual subtitles" in settings, allow youtube.com, open youtube.com/watch?v=UF8uR6Z6KLc and click the three-bar button left of CC.
