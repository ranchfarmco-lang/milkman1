/**
 * Boxes 6, 7 and 8 — GitHub Integration, Deployment Targets, Research &
 * External Tools.
 *
 * Every button here does real network work against the real APIs with a
 * token from the encrypted vault: identity tests, repo creation, push, pull,
 * Vercel and Netlify deployments, and live probes of the research sources.
 * Failures come back as sentences on the light, never as a silent no-op.
 */
import { ForgeBox, MiniButton } from "@/components/forge/ForgeBox";
import { Switch } from "@/components/ui/switch";
import { useForgeConfig, useForgeLights } from "@/hooks/use-forge";
import { writeConfig } from "@/lib/forge/config";
import { getSecret, putSecret } from "@/lib/forge/crypto";
import {
  deployNetlify,
  deployVercel,
  saveDeployToken,
  testDeploy,
  type DeployTarget,
} from "@/lib/forge/deploy";
import { forgeDb, setLight, type Tone } from "@/lib/forge/db";
import {
  GITHUB_SECRET,
  createRepo,
  pullRepo,
  pushRepo,
  saveGithubToken,
  testGithub,
} from "@/lib/forge/github";
import { currentProject, projectFiles, applyFiles } from "@/lib/forge/files";
import { CloudUpload, FolderGit2, Github, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

function useLight(id: string) {
  const lights = useForgeLights();
  return useMemo(() => lights.find((light) => light.id === id), [lights, id]);
}

/* ------------------------------------------------------------------ box 6 */

export function GithubBox() {
  const light = useLight("github");
  const [token, setToken] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [busy, setBusy] = useState<string | null>(null);

  const tokenField = (
    <input
      type="password"
      autoComplete="off"
      value={token}
      onChange={(event) => setToken(event.target.value)}
      placeholder="personal access token (repo scope)"
      aria-label="GitHub personal access token"
      className="h-7 w-64 rounded-lg border border-border/60 bg-background/60 px-2 text-[10px] outline-none focus:border-white/40"
    />
  );

  const connect = async () => {
    setBusy("test");
    try {
      if (token.trim()) await saveGithubToken(token.trim());
      const result = await testGithub(token.trim() || null);
      await setLight("github", result.ok ? "good" : "bad", result.detail);
      if (result.ok) toast.success(result.detail);
      else toast.error(result.detail);
    } finally {
      setBusy(null);
    }
  };

  const withToken = async (work: (key: string) => Promise<void>) => {
    const key = (token.trim() || (await getSecret(GITHUB_SECRET)) || "").trim();
    if (!key) {
      toast("Save a token first — Connect is the test.");
      return;
    }
    await work(key);
  };

  const create = async () =>
    withToken(async (key) => {
      setBusy("create");
      try {
        const name =
          repo.trim() ||
          window.prompt(
            "Repository name (owner/repo or just a name):",
            "forge-app",
          );
        if (!name) return;
        const result = await createRepo(
          key,
          name.split("/").pop() ?? name,
          "Built with ControlForge.",
        );
        await setLight("github", result.ok ? "good" : "bad", result.detail);
        if (result.ok && result.repo) setRepo(result.repo);
        if (result.ok) toast.success(result.detail);
        else toast.error(result.detail);
      } finally {
        setBusy(null);
      }
    });

  const push = async () =>
    withToken(async (key) => {
      setBusy("push");
      try {
        const project = await currentProject();
        const files = await projectFiles(project.id);
        if (!files.length) {
          toast("The project has no files to push.");
          return;
        }
        const target = repo.trim();
        if (!target) {
          toast("Give the repository as owner/repo.");
          return;
        }
        const result = await pushRepo({
          token: key,
          repo: target,
          branch: branch.trim() || "main",
          files,
          message: `ControlForge push — ${new Date().toISOString()}`,
        });
        await setLight("github", result.ok ? "good" : "bad", result.detail);
        if (result.ok) toast.success(result.detail);
        else toast.error(result.detail);
      } finally {
        setBusy(null);
      }
    });

  const pull = async () =>
    withToken(async (key) => {
      setBusy("pull");
      try {
        const target = repo.trim();
        if (!target) {
          toast("Give the repository as owner/repo.");
          return;
        }
        const result = await pullRepo(key, target, branch.trim() || "main");
        if (!result.ok) {
          await setLight("github", "bad", result.detail);
          toast.error(result.detail);
          return;
        }
        const project = await currentProject();
        await applyFiles(project.id, result.files);
        await setLight("github", "good", result.detail);
        toast.success(result.detail);
      } finally {
        setBusy(null);
      }
    });

  const tone: Tone = light?.tone ?? "muted";

  return (
    <ForgeBox
      id="forge-github"
      icon={Github}
      title="GitHub Integration"
      light={{
        tone,
        value: light
          ? tone === "good"
            ? "CONNECTED"
            : "NOT CONNECTED"
          : "NO TOKEN",
        note:
          light?.detail ?? "Save a personal access token and press Connect.",
      }}
      onRefresh={connect}
      test={{
        label: busy === "test" ? "Testing…" : "Connect",
        onTest: connect,
      }}
      testing={busy === "test"}
      hint="The token is sealed in the encrypted vault; pushes go through the hub's own GitHub writer, blobs and commit tree included."
    >
      <div className="flex flex-wrap items-center gap-2">
        {tokenField}
        <MiniButton
          onClick={() =>
            void saveGithubToken(token.trim()).then(() =>
              toast.success("Token sealed."),
            )
          }
          disabled={!token.trim()}
        >
          Save
        </MiniButton>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={repo}
          onChange={(event) => setRepo(event.target.value)}
          placeholder="owner/repo"
          aria-label="Repository"
          data-spell="off"
          spellCheck={false}
          className="h-7 w-44 rounded-lg border border-border/60 bg-background/60 px-2 text-[10px] outline-none focus:border-white/40"
        />
        <input
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          placeholder="main"
          aria-label="Branch"
          data-spell="off"
          spellCheck={false}
          className="h-7 w-28 rounded-lg border border-border/60 bg-background/60 px-2 text-[10px] outline-none focus:border-white/40"
        />
        <MiniButton onClick={() => void create()} disabled={busy !== null}>
          <FolderGit2 className="size-3" />
          {busy === "create" ? "Creating…" : "Create Repo"}
        </MiniButton>
        <MiniButton onClick={() => void push()} disabled={busy !== null}>
          <Github className="size-3" />
          {busy === "push" ? "Pushing…" : "Push"}
        </MiniButton>
        <MiniButton onClick={() => void pull()} disabled={busy !== null}>
          <CloudUpload className="size-3 scale-x-[-1]" />
          {busy === "pull" ? "Pulling…" : "Pull"}
        </MiniButton>
      </div>
    </ForgeBox>
  );
}

/* ------------------------------------------------------------------ box 7 */

function DeployRow({
  target,
  label,
  onDeployed,
}: {
  target: DeployTarget;
  label: string;
  onDeployed: (tone: Tone, detail: string) => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const save = async () => {
    if (!token.trim()) {
      toast("Paste a token first.");
      return;
    }
    await saveDeployToken(target, token.trim());
    toast.success(`${label} token sealed.`);
    setToken("");
  };

  const test = async () => {
    setBusy("test");
    try {
      const result = await testDeploy(target);
      onDeployed(result.ok ? "good" : "bad", result.detail);
      if (result.ok) toast.success(`${label}: ${result.detail}`);
      else toast.error(`${label}: ${result.detail}`);
    } finally {
      setBusy(null);
    }
  };

  const deploy = async () => {
    setBusy("deploy");
    try {
      const key = (
        token.trim() ||
        (await getSecret(target === "vercel" ? "vercel" : "netlify")) ||
        ""
      ).trim();
      if (!key) {
        toast("Save a token first.");
        return;
      }
      const project = await currentProject();
      const files = await projectFiles(project.id);
      if (!files.length) {
        toast("The project has no files to deploy.");
        return;
      }
      const result =
        target === "vercel"
          ? await deployVercel(key, project.name, files)
          : await deployNetlify(key, project.name, files);
      onDeployed(result.ok ? "good" : "bad", result.detail);
      if (result.ok) toast.success(`${label}: ${result.detail}`);
      else toast.error(`${label}: ${result.detail}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 py-1.5">
      <span className="w-20 text-[10px] font-medium">{label}</span>
      <input
        type="password"
        autoComplete="off"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        placeholder="API token"
        aria-label={`${label} API token`}
        className="h-7 w-52 rounded-lg border border-border/60 bg-background/60 px-2 text-[10px] outline-none focus:border-white/40"
      />
      <MiniButton onClick={() => void save()} disabled={!token.trim()}>
        Save
      </MiniButton>
      <MiniButton onClick={() => void test()} disabled={busy !== null}>
        {busy === "test" ? "Testing…" : "Test Token"}
      </MiniButton>
      <MiniButton
        onClick={() => void deploy()}
        disabled={busy !== null}
        title="Deploy the current project's files"
      >
        {busy === "deploy" ? "Deploying…" : "Deploy"}
      </MiniButton>
    </div>
  );
}

export function DeployBox() {
  const config = useForgeConfig();
  const vercel = useLight("deploy:vercel");
  const netlify = useLight("deploy:netlify");

  const onDeployed = (target: DeployTarget, tone: Tone, detail: string) =>
    void setLight(`deploy:${target}`, tone, detail);

  const tone: Tone =
    vercel?.tone === "good" || netlify?.tone === "good"
      ? "good"
      : vercel?.tone === "bad" || netlify?.tone === "bad"
        ? "bad"
        : "muted";

  return (
    <ForgeBox
      id="forge-deploy"
      icon={CloudUpload}
      title="Deployment Targets (Vercel + Netlify)"
      light={{
        tone,
        value:
          tone === "good"
            ? "TARGET READY"
            : tone === "bad"
              ? "TARGET FAILED"
              : "NOT TESTED",
        note:
          vercel?.detail ??
          netlify?.detail ??
          "Save a token and press Test Token.",
      }}
      onRefresh={async () => {
        await testDeploy("vercel").then((result) =>
          setLight("deploy:vercel", result.ok ? "good" : "bad", result.detail),
        );
        await testDeploy("netlify").then((result) =>
          setLight("deploy:netlify", result.ok ? "good" : "bad", result.detail),
        );
      }}
      test={{
        label: "Deploy Current",
        onTest: async () => {
          const target: DeployTarget =
            vercel?.tone === "good" ? "vercel" : "netlify";
          const key = (await getSecret(target))?.trim();
          if (!key) {
            toast("No saved token for either target — save one below first.");
            return;
          }
          const project = await currentProject();
          const files = await projectFiles(project.id);
          if (!files.length) {
            toast("The project has no files to deploy.");
            return;
          }
          const result =
            target === "vercel"
              ? await deployVercel(key, project.name, files)
              : await deployNetlify(key, project.name, files);
          onDeployed(target, result.ok ? "good" : "bad", result.detail);
          if (result.ok) toast.success(result.detail);
          else toast.error(result.detail);
        },
      }}
      hint="Deploys send the live project's files straight to the target's API. Auto-deploy fires the ready target after every Apply to Live Project."
    >
      <DeployRow
        target="vercel"
        label="Vercel"
        onDeployed={(tone_, detail) => onDeployed("vercel", tone_, detail)}
      />
      <DeployRow
        target="netlify"
        label="Netlify"
        onDeployed={(tone_, detail) => onDeployed("netlify", tone_, detail)}
      />

      <div className="mt-2 flex items-center gap-2 border-t border-border/50 pt-2">
        <Switch
          checked={config.autoDeploy}
          onCheckedChange={(checked) =>
            void writeConfig({ autoDeploy: checked })
          }
        />
        <span className="text-[10px] text-foreground/90">
          Auto-deploy after Apply
        </span>
        <span className="text-[9px] text-muted-foreground">
          {config.autoDeploy
            ? "on — the last working target deploys after an apply."
            : "off — deploys are only pressed by hand."}
        </span>
      </div>
    </ForgeBox>
  );
}

/* ------------------------------------------------------------------ box 8 */

type Source = "wikipedia" | "brave" | "searxng";

async function probeSource(
  source: Source,
  config: ReturnType<typeof useForgeConfig>,
): Promise<{ tone: Tone; detail: string }> {
  try {
    if (source === "wikipedia") {
      const started = performance.now();
      const response = await fetch(
        "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1&srsearch=test",
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        },
      );
      const ms = Math.round(performance.now() - started);
      return response.ok
        ? { tone: "good", detail: `Wikipedia answered in ${ms} ms.` }
        : { tone: "bad", detail: `Wikipedia answered ${response.status}.` };
    }
    if (source === "brave") {
      const key = (await getSecret("search:brave"))?.trim();
      if (!key) return { tone: "warn", detail: "No Brave key saved yet." };
      const response = await fetch(
        "https://api.search.brave.com/res/v1/web/search?count=1&q=test",
        {
          headers: { Accept: "application/json", "X-Subscription-Token": key },
          signal: AbortSignal.timeout(8000),
        },
      );
      return response.ok
        ? { tone: "good", detail: "Brave answered with the key." }
        : { tone: "bad", detail: `Brave answered ${response.status}.` };
    }
    const base = config.searxngUrl.trim();
    if (!base) return { tone: "warn", detail: "No SearxNG address saved yet." };
    const response = await fetch(
      `${base.replace(/\/+$/, "")}/search?format=json&q=test`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      },
    );
    return response.ok
      ? { tone: "good", detail: "SearxNG answered." }
      : { tone: "bad", detail: `SearxNG answered ${response.status}.` };
  } catch (error) {
    return {
      tone: "bad",
      detail: `${source}: ${error instanceof Error ? error.message : String(error)} — unreachable or blocked (CORS).`,
    };
  }
}

export function ResearchBox() {
  const config = useForgeConfig();
  const [braveKey, setBraveKey] = useState("");
  const [searx, setSearx] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [clearArmed, setClearArmed] = useState(false);
  const [cacheSize, setCacheSize] = useState<number | null>(null);

  const selectedLight = useLight(`research:${config.researchProvider}`);

  const probeOne = async (source: Source) => {
    const result = await probeSource(source, config);
    await setLight(`research:${source}`, result.tone, result.detail);
    return result;
  };

  const probeAll = async () => {
    setBusy("probe");
    try {
      for (const source of ["wikipedia", "brave", "searxng"] as const) {
        await probeOne(source);
      }
      toast("Probed every research source.");
    } finally {
      setBusy(null);
    }
  };

  const clearCache = async () => {
    if (!clearArmed) {
      setClearArmed(true);
      toast("Press Clear Cache again to forget every cached search.");
      window.setTimeout(() => setClearArmed(false), 4000);
      return;
    }
    setClearArmed(false);
    const removed = await forgeDb.research.count();
    await forgeDb.research.clear();
    setCacheSize(0);
    toast.success(`Cleared ${removed} cached search(es).`);
  };

  const tone: Tone = selectedLight?.tone ?? "muted";

  return (
    <ForgeBox
      id="forge-research"
      icon={Search}
      title="Research & External Tools"
      light={{
        tone,
        value:
          tone === "good"
            ? "SOURCE OK"
            : tone === "bad"
              ? "SOURCE DOWN"
              : "NOT TESTED",
        note:
          selectedLight?.detail ??
          "Probe the sources the Research agent may use.",
      }}
      onRefresh={probeAll}
      test={{
        label: busy === "probe" ? "Probing…" : "Probe All",
        onTest: probeAll,
      }}
      testing={busy === "probe"}
      hint="The Research agent only ever reaches the source selected here, and every answer is cached with its query for an hour."
    >
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["wikipedia", "Wikipedia (no key)"],
            ["brave", "Brave (key)"],
            ["searxng", "SearxNG (your server)"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => void writeConfig({ researchProvider: id })}
            className={`cursor-pointer rounded-full border px-2.5 py-1 text-[9px] transition-colors ${
              config.researchProvider === id
                ? "border-white/50 bg-white/10 text-foreground"
                : "border-border/60 text-muted-foreground hover:border-white/30"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="password"
          autoComplete="off"
          value={braveKey}
          onChange={(event) => setBraveKey(event.target.value)}
          placeholder="Brave Search API key"
          aria-label="Brave Search API key"
          className="h-7 w-56 rounded-lg border border-border/60 bg-background/60 px-2 text-[10px] outline-none focus:border-white/40"
        />
        <MiniButton
          onClick={async () => {
            await putSecret("search:brave", braveKey.trim());
            toast.success("Brave key sealed.");
            setBraveKey("");
            await probeOne("brave");
          }}
          disabled={!braveKey.trim()}
        >
          Save
        </MiniButton>

        <input
          value={searx}
          onChange={(event) => setSearx(event.target.value)}
          onBlur={() => void writeConfig({ searxngUrl: searx.trim() })}
          placeholder="https://searx.example"
          aria-label="SearxNG address"
          data-spell="off"
          spellCheck={false}
          className="h-7 w-56 rounded-lg border border-border/60 bg-background/60 px-2 text-[10px] outline-none focus:border-white/40"
        />
        <MiniButton
          onClick={() =>
            void writeConfig({ searxngUrl: searx.trim() }).then(() =>
              probeOne("searxng"),
            )
          }
        >
          Save
        </MiniButton>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
        <MiniButton
          onClick={clearCache}
          title="Forget the Research agent's cached searches (two presses)"
        >
          <Trash2 className="size-3 text-amber-300" />
          {clearArmed ? "press again to clear" : "Clear Cache"}
        </MiniButton>
        <span className="text-[9px] text-muted-foreground">
          {cacheSize !== null
            ? `${cacheSize} cached searches left.`
            : "Cached searches live in IndexedDB; the Research agent checks them before any network call."}
        </span>
      </div>
    </ForgeBox>
  );
}
