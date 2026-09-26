# Changelog

All notable changes to envelope are listed here, newest first. Versions follow semantic versioning; before 1.0.0, a new minor version (0.x.0) closes a milestone.

Each entry groups changes under **Added**, **Changed**, **Fixed** and **Removed**.

## [Unreleased]

### Added

- Monorepo with strict TypeScript configuration and CI.
- `@envelope/core`: integer money amounts with locale-aware parsing and formatting, months and local dates, translatable validation errors.
- Budget month calculation: ready to assign, rollover, future assignments, cash and credit overspending, credit card payment categories.
- Transaction aggregation: income, splits, transfers, card payments, off-budget accounts.
- Development environment: docker-compose for PostgreSQL and Keycloak, Ansible playbook for a Debian 13 development machine.
- Documentation: design document, getting started, how-to guides, ADRs 0001–0005, glossary.
- GitHub workflow: labels and milestones, protected main branch, pull request template, commit convention checked by a Git hook and by CI on pull request titles.
