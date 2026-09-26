# Development machine playbook

Prepares a fresh **Debian 13** machine for envelope: everything in sections 2–7 of the [getting started guide](../../docs/getting-started.md), automated and idempotent.

| Role | What it does | Tag |
| --- | --- | --- |
| `base` | Full upgrade, base packages, QEMU guest agent on KVM, time zone, automatic security updates, optional SSH hardening | `base` |
| `dev_user` | Development user in the `sudo` group, SSH keys, optional passwordless sudo, Git configuration | `user` |
| `docker` | Docker's APT repository, Docker Engine and Compose plugin, log rotation, `docker` group | `docker` |
| `node` | fnm in `/usr/local/bin`, Node.js from `node_major`, corepack (pnpm) | `node` |
| `project` | SSH key for the Git hosting service, clone of the repository, `pnpm install` | `project` |
| `github_cli` | GitHub CLI (`gh`) from its official APT repository | `github` |
| `claude_code` | Claude Code from its signed APT repository, optional personal instructions in `~/.claude/CLAUDE.md` | `claude` |

## Run it on the VM itself

As root on the new machine:

```bash
apt update && apt install -y ansible-core git
git clone https://github.com/YOUR-USER/envelope.git /root/envelope   # private repo: use a read-only access token as password
cd /root/envelope/infra/ansible
cp inventory.example.ini inventory.ini
cp vars.example.yml vars.yml
nano vars.yml                      # user name, SSH public key, Git identity, time zone
ansible-playbook site.yml --check --diff    # dry run
ansible-playbook site.yml
```

The dry run reports errors on the Docker packages on a fresh machine: the repository is only added for real during the actual run. That is expected.

## Run it from another machine

Any Linux machine with `ansible-core` works as a controller. Use option 2 in `inventory.ini`, then run the same commands from `infra/ansible`.

After `ssh_harden: true`, root can no longer sign in over SSH. For later runs, connect as the development user and let Ansible use sudo:

```ini
envelope-dev ansible_host=192.0.2.10 ansible_user=dev
```

## Typical sequence

1. First run with `ssh_harden: false` and `project_repo: ""`.
2. Check that `ssh dev@envelope-dev` works with your key, then set `ssh_harden: true` and run `--tags base`.
3. Copy the public key printed at the end of the run to your Git hosting account.
4. Set `project_repo` (for example `git@github.com:YOUR-USER/envelope.git`) and run `--tags project`: the repository is cloned into `project_dir` and its dependencies installed.
5. Sign out and back in as the development user, so the new `docker` group and the fnm shell setup apply.

## Files

| File | In Git | Content |
| --- | --- | --- |
| `site.yml` | Yes | The playbook |
| `roles/` | Yes | One folder per role |
| `ansible.cfg` | Yes | Local settings for this folder |
| `inventory.example.ini`, `vars.example.yml` | Yes | Templates |
| `inventory.ini`, `vars.yml` | **No** | Your copies, with personal data |
