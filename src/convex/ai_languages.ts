/**
 * Which language names the code runner can actually turn into a compiler, and
 * the aliases an agent is likely to type instead. It lives on its own so the
 * agent prompts and the runner can both read it without importing each other.
 */

/**
 * Which Wandbox compiler belongs to which language. Every matcher here was
 * checked against the runner's live list, so an agent is never promised a
 * language this box cannot actually run.
 */
export const LANGUAGE_MATCHERS: Record<string, RegExp> = {
  python: /^cpython-3/,
  pypy: /^pypy-\d/,
  javascript: /^nodejs-\d/,
  typescript: /^typescript-\d/,
  bash: /^bash$/,
  ruby: /^ruby-\d/,
  php: /^php-\d/,
  perl: /^perl-\d/,
  go: /^go-\d/,
  rust: /^rust-\d/,
  java: /^openjdk-jdk-\d/,
  csharp: /^dotnetcore-\d/,
  c: /^gcc-[\d.]+-c$/,
  cpp: /^gcc-[\d.]+$/,
  sql: /^sqlite-\d/,
  lua: /^lua-\d/,
  luajit: /^luajit-\d/,
  julia: /^julia-\d/,
  r: /^r-\d/,
  haskell: /^ghc-\d/,
  elixir: /^elixir-\d/,
  erlang: /^erlang-\d/,
  ocaml: /^ocaml-\d/,
  scala: /^scala-\d/,
  swift: /^swift-\d/,
  nim: /^nim-\d/,
  zig: /^zig-\d/,
  crystal: /^crystal-\d/,
  groovy: /^groovy-\d/,
  d: /^(dmd|ldc)-\d/,
  pascal: /^fpc-\d/,
  lisp: /^(sbcl|clisp)-\d/,
  pony: /^pony-\d/,
  vim: /^vim-\d/,
};

export const LANGUAGE_ALIASES: Record<string, string> = {
  py: "python",
  py3: "python",
  python3: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  nodejs: "javascript",
  ts: "typescript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  rb: "ruby",
  rs: "rust",
  "c++": "cpp",
  cxx: "cpp",
  "c#": "csharp",
  cs: "csharp",
  golang: "go",
  sqlite: "sql",
  hs: "haskell",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  ml: "ocaml",
  pl: "perl",
  pas: "pascal",
  cl: "lisp",
  sbcl: "lisp",
  commonlisp: "lisp",
  dlang: "d",
  viml: "vim",
  vimscript: "vim",
};
