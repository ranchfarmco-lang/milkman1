# configuration/

- `catalog.json` — the master machine-readable index: installers and a
  capability → component map.
- `env.sh` — PATH additions written by the installers (sourced automatically
  when you run the scripts).
- `litellm.example.yaml` — a LiteLLM config routing several local models.

Add your own local model aliases and endpoints here. No secrets belong in this
directory; set keys via your environment.
