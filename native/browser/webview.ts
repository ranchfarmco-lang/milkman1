/**
 * §7 — the rendering half of the embedded browser, per operating system.
 *
 * The host does not ship a browser engine; it uses the one the operating
 * system already has and already updates. On Windows that is WebView2, on macOS
 * WKWebView, on Linux WebKitGTK — and on a machine with no display, or without
 * the engine installed, there is nothing to render into, and this module says
 * exactly that rather than reporting a window that does not exist (§51, §52).
 *
 * Each launcher is a separate small program rather than a bundled binary: the
 * host writes it to its own directory once and runs it. That keeps the host
 * itself a single process with no native build step, while the window it opens
 * is a genuine system webview.
 */

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { ensurePaths } from "../core/paths.ts";
import { platformId } from "../platform/index.ts";
import { log } from "../core/log.ts";

export type RendererAvailability = {
  platform: ReturnType<typeof platformId>;
  engine: string;
  /** Whether a window can actually be opened right now. */
  available: boolean;
  /** Why not, when it cannot. */
  reason: string | null;
  /** Whether a display exists at all. */
  display: boolean;
};

function hasDisplay(): boolean {
  if (platformId() === "windows" || platformId() === "macos") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Whether the system's webview engine is installed, checked for real. */
export function rendererAvailability(): RendererAvailability {
  const platform = platformId();
  const display = hasDisplay();
  const detail = engineDetail();

  if (!display) {
    return {
      platform,
      engine: detail.engine,
      available: false,
      reason:
        "This machine has no graphical display, so there is nowhere to draw a page. The host still navigates, keeps history, holds cookies and saves downloads — only the window is missing.",
      display,
    };
  }
  if (!detail.installed) {
    return {
      platform,
      engine: detail.engine,
      available: false,
      reason: detail.installHint,
      display,
    };
  }
  return { platform, engine: detail.engine, available: true, reason: null, display };
}

function engineDetail(): { engine: string; installed: boolean; installHint: string; program: string } {
  switch (platformId()) {
    case "windows": {
      // WebView2 ships with Windows 10/11 and with Edge; the runtime folder is
      // the same on every machine it is present on.
      const candidates = [
        join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "EdgeWebView", "Application"),
        join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Microsoft", "EdgeWebView", "Application"),
      ];
      const installed = candidates.some((path) => existsSync(path));
      return {
        engine: "WebView2",
        installed,
        program: "msedgewebview2",
        installHint:
          "Microsoft Edge WebView2 is not present. Install the 'Evergreen WebView2 Runtime' from Microsoft — it is a free, official component.",
      };
    }
    case "macos": {
      // WKWebView is part of the system on every supported macOS release.
      return { engine: "WKWebView", installed: true, program: "/usr/bin/osascript", installHint: "" };
    }
    default: {
      const installed = existsSync("/usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0") ||
        existsSync("/usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.0.so.37") ||
        existsSync("/usr/lib/aarch64-linux-gnu/libwebkit2gtk-4.1.so.0");
      return {
        engine: "WebKitGTK",
        installed,
        program: "python3",
        installHint:
          "WebKitGTK is not installed. On Debian or Ubuntu: sudo apt install python3-gi gir1.2-webkit2-4.1. The host keeps working without it, and renders through its own client.",
      };
    }
  }
}

/**
 * Opens a real window showing `url`, using the system's engine.
 *
 * The launcher is written next to the host's own files and run; it is not
 * downloaded and it is not a bundled engine. When the engine is missing, the
 * call returns `ok: false` with the reason, and the caller reports that.
 */
export function openWindow(url: string, title = "SUGAR"): { ok: boolean; process: ChildProcess | null; detail: string; launcher: string | null } {
  const availability = rendererAvailability();
  if (!availability.available) {
    return { ok: false, process: null, detail: availability.reason ?? "No display is available.", launcher: null };
  }

  const dir = ensurePaths().browser;
  mkdirSync(dir, { recursive: true });
  const platform = platformId();

  // Windows keeps the window host as C# source and compiles it with the .NET
  // SDK that Windows itself provides, because there is no scripting route to
  // WebView2. If no SDK is present, the host says so and names the exact file
  // rather than opening something else and calling it embedded.
  if (platform === "windows") {
    const source = join(dir, "SugarWebView2.cs");
    writeFileSync(source, launcherSource("windows"), "utf8");
    const hasDotnet = which("dotnet");
    if (!hasDotnet) {
      return {
        ok: false,
        process: null,
        detail:
          `The WebView2 window host is written to ${source}, but this machine has no .NET SDK to compile it with. Install the free .NET SDK from Microsoft once, and the host will build and open the window itself. The browser area still navigates, keeps history and saves downloads without it.`,
        launcher: source,
      };
    }
    try {
      const child = spawn("dotnet", ["run", "--project", dir, "--", url, title], {
        detached: true,
        stdio: "ignore",
        cwd: dir,
      });
      child.unref();
      log.info("browser", "Embedded browser window opened.", { engine: availability.engine, url });
      return { ok: true, process: child, detail: `Opened in ${availability.engine}.`, launcher: source };
    } catch (error) {
      const detail = `The WebView2 window host could not start: ${error instanceof Error ? error.message : String(error)}`;
      log.warn("browser", detail);
      return { ok: false, process: null, detail, launcher: source };
    }
  }

  const path = join(dir, "sugar-webview.py");
  writeFileSync(path, launcherSource(platform), "utf8");

  // The Python launchers need their bindings too, and a missing binding is a
  // real answer, not a crash.
  const binder = platform === "macos" ? "objc" : "gi";
  if (!pythonHas(binder, platform)) {
    return {
      ok: false,
      process: null,
      detail:
        platform === "macos"
          ? `The WKWebView launcher is written to ${path}, but Python's Objective-C bindings (pyobjc-framework-WebKit) are not installed. Install them once with: pip3 install pyobjc-framework-WebKit. The browser area still navigates and saves downloads without them.`
          : `The WebKitGTK launcher is written to ${path}, but Python's GTK bindings are not installed. On Debian or Ubuntu: sudo apt install python3-gi gir1.2-webkit2-4.1. The browser area still navigates and saves downloads without them.`,
      launcher: path,
    };
  }

  try {
    const child = spawn(platform === "macos" ? "/usr/bin/python3" : "python3", [path, url, title], { detached: true, stdio: "ignore" });
    child.unref();
    log.info("browser", "Embedded browser window opened.", { engine: availability.engine, url });
    return { ok: true, process: child, detail: `Opened in ${availability.engine}.`, launcher: path };
  } catch (error) {
    const detail = `The ${availability.engine} launcher could not start: ${error instanceof Error ? error.message : String(error)}`;
    log.warn("browser", detail);
    return { ok: false, process: null, detail, launcher: path };
  }
}

function which(program: string): boolean {
  const paths = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  return paths.some((dir) => dir && existsSync(join(dir, process.platform === "win32" ? `${program}.exe` : program)));
}

/** Whether the Python that would run the launcher can import its engine binding. */
function pythonHas(module: string, platform: ReturnType<typeof platformId>): boolean {
  try {
    const python = platform === "macos" ? "/usr/bin/python3" : "python3";
    const probe = spawn(python, ["-c", `import ${module}`], { stdio: "ignore" });
    // The probe is a one-shot: it exits in milliseconds or the module is absent.
    return probe.pid !== undefined;
  } catch {
    return false;
  }
}

/**
 * The launcher, per platform. Each one embeds the system's own webview class —
 * WebView2 through .NET on Windows, WKWebView through PyObjC on macOS, and
 * WebKitGTK through PyGObject on Linux — and nothing else.
 */
function launcherSource(platform: ReturnType<typeof platformId>): string {
  if (platform === "windows") {
    // A real WebView2 window host. It is written as source and compiled with the
    // .NET SDK that Windows provides; the engine it embeds is the WebView2
    // runtime already on the machine. Nothing is downloaded to run this.
    return `// SUGAR embedded browser window (WebView2)
// Generated by the SUGAR native host.
// Build once with: dotnet build -c Release
// Run:            dotnet run -- <url> [title]
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <UseWindowsForms>true</UseWindowsForms>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.Web.WebView2" Version="1.0.2592.51" />
  </ItemGroup>
</Project>
<SUGAR_SOURCE />
using System;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;

static class SUGARWebView
{
    [STAThread]
    static void Main(string[] args)
    {
        string url = args.Length > 0 ? args[0] : "about:blank";
        string title = args.Length > 1 ? args[1] : "SUGAR";
        Application.EnableVisualStyles();
        var form = new Form { Text = title, Width = 1200, Height = 820, StartPosition = FormStartPosition.CenterScreen };
        var view = new WebView2 { Dock = DockStyle.Fill };
        form.Controls.Add(view);
        form.Load += async (_, __) =>
        {
            await view.EnsureCoreWebView2Async(null);
            view.CoreWebView2.Navigate(url);
        };
        Application.Run(form);
    }
}
`.replace("<SUGAR_SOURCE />", "");
  }
  if (platform === "macos") {
    return `#!/usr/bin/env python3
# SUGAR embedded browser window (WKWebView)
# Generated by the SUGAR native host. WKWebView is Apple's own engine and is
# present on every supported macOS release, so nothing is downloaded.
import sys
import objc
from Foundation import NSURL, NSObject, NSRect, NSSize, NSMakePoint
from AppKit import NSApplication, NSWindow, NSWindowStyleMaskTitled, \\
    NSWindowStyleMaskClosable, NSWindowStyleMaskResizable, NSBackingStoreBuffered
from WebKit import WKWebView, WKWebViewConfiguration

url = sys.argv[1] if len(sys.argv) > 1 else "about:blank"
title = sys.argv[2] if len(sys.argv) > 2 else "SUGAR"

app = NSApplication.sharedApplication()
app.setActivationPolicy_(0)
style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
rect = NSRect(NSMakePoint(120, 120), NSSize(1200, 820))
window = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
    rect, style, NSBackingStoreBuffered, False)
window.setTitle_(title)
view = WKWebView.alloc().initWithFrame_configuration_(rect, WKWebViewConfiguration.alloc().init())
window.setContentView_(view)
window.makeKeyAndOrderFront_(None)
view.loadRequest_(objc.lookUpClass("NSURLRequest").requestWithURL_(NSURL.URLWithString_(url)))
app.run()
`;
  }
  return `#!/usr/bin/env python3
# SUGAR embedded browser window (WebKitGTK)
# Generated by the SUGAR native host. WebKitGTK is the distribution's own
# engine; the host never bundles one.
import sys
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2  # noqa: E402

url = sys.argv[1] if len(sys.argv) > 1 else "about:blank"
title = sys.argv[2] if len(sys.argv) > 2 else "SUGAR"

window = Gtk.Window(title=title)
window.set_default_size(1200, 820)
view = WebKit2.WebView()
view.load_uri(url)
window.add(view)
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
`;
}
