#!/usr/bin/env bash
# Browsing, browser automation, page inspection, screenshots and local site testing.
. "$(dirname "$0")/lib.sh"

B="$BRAIN_DATA/browser-tools"

# ---- browser engines --------------------------------------------------------
log "fetching browser engines via Playwright"
pip_install "$B/playwright" playwright
"$B/playwright/bin/python" -m playwright install --with-deps chromium firefox webkit 2>/dev/null \
  || "$B/playwright/bin/python" -m playwright install chromium || warn "playwright browser download failed"

# ---- automation frameworks --------------------------------------------------
pip_install "$B/selenium" selenium
have chromedriver || warn "chromedriver: managed automatically by selenium-manager"

# node automation
if have npm || have bun; then
  pm="npm"; have bun && pm="bun"
  ( cd "$B" && $pm init -y >/dev/null 2>&1 || true; $pm install puppeteer puppeteer-core chrome-remote-interface ) \
    || warn "puppeteer install failed"
fi

# ---- open-source browser agents ---------------------------------------------
pip_install "$B/browser-use" browser-use
pip_install "$B/stagehand" "stagehand-py" 2>/dev/null || warn "stagehand-py optional"
fetch_repo() {
  local owner_repo="$1" dest="$B/$2"
  [ -d "$dest" ] && { ok "$2 present"; return; }
  mkdir -p "$dest"
  curl -sSL "https://codeload.github.com/$owner_repo/tar.gz/refs/heads/main" | tar xz -C "$dest" --strip-components=1 \
    || warn "failed to fetch $owner_repo"
}
fetch_repo browserbase/stagehand stagehand
fetch_repo lavague-ai/LaVague LaVague
fetch_repo Skyvern-AI/skyvern skyvern
fetch_repo browser-use/web-ui browser-use-web-ui

# ---- static / text browsers and HTML tooling --------------------------------
have lynx  || pkg_install lynx lynx
have w3m   || pkg_install w3m w3m
have htmlq || { have brew && brew install htmlq || warn "htmlq optional"; }
have pup   || warn "pup optional (HTML slicing)"
have xmllint || pkg_install libxml2-utils libxml2 || true
have pandoc  || pkg_install pandoc pandoc || true
have tidy    || pkg_install tidy tidy || true

# ---- page extraction / readability ------------------------------------------
pip_install "$B/readability" readability-lxml trafilatura newspaper3k beautifulsoup4 lxml html5lib

ok "browser tools installed under $B"
