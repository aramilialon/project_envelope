Fixed

- `apps/api`: a misspelt or unchangeable field sent to create or change a portfolio, an account (its withholding-agent flag, its tax regimes, its closing) or a workspace (its tax country) is refused with 400 `unknown_field` naming it, instead of being silently ignored, and nothing is written (`#713`).
