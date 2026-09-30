# browser-tools/

Browsing, browser automation, page inspection, screenshots and local-site
testing. Installed by `../scripts/install-browser-tools.sh`.

- **Engines**: Chromium, Firefox, WebKit (via Playwright).
- **Automation**: Playwright, Puppeteer, Selenium, Chrome DevTools Protocol
  (`chrome-remote-interface`) — drive pages, click, screenshot, read the console.
- **Browser agents**: `browser-use`, Stagehand, LaVague, Skyvern, browser-use
  web UI. Point them at a local model via `OPENAI_BASE_URL`.
- **Static inspection**: `lynx`, `w3m`, `htmlq`, `xmllint`, `pandoc`, `tidy`.
- **Extraction / readability**: `trafilatura`, `readability-lxml`,
  `newspaper3k`, `beautifulsoup4`.

For a vision model that can look at screenshots, download
`qwen2.5-vl-7b-instruct` (`MODEL_SET=vision`). Freebuff's browser agent is
`../source/freebuff/agents/browser-use/` and URL reading is
`../source/freebuff/sdk/src/tools/read-url.ts`.
