# Getting started (Debian 13)

From a freshly installed Debian 13 ("trixie") virtual machine to a working checkout of the repository. All development happens on the VM; your laptop only needs an SSH client and a browser. Expect about an hour the first time.

Conventions: `$` commands run as your normal user, `#` commands as root. Replace `dev` with your user name and `envelope-dev` with the VM's host name or IP address.

## 1. Create the virtual machine

Suggested resources, for example on Proxmox VE:

| Resource | Value | Why |
| --- | --- | --- |
| vCPU | 4 | TypeScript checks and tests run in parallel |
| RAM | 8 GB | Keycloak (Java) and PostgreSQL run next to Node.js |
| Disk | 40 GB | Container images, `node_modules`, database |
| Network | Bridged, static IP or DHCP reservation | Stable address for SSH |

Install Debian 13 from the netinst image with only **SSH server** and **standard system utilities**: no desktop environment.

Use a VM rather than an LXC container: Docker inside unprivileged containers needs extra configuration and has subtle limits.

**Tip:** take a snapshot after each numbered section. If a step goes wrong, roll back and repeat it.

## Fast path: Ansible

The playbook in [`infra/ansible`](../infra/ansible/README.md) performs sections 2 to 7 for you, and can be run again at any time without side effects. In short, as root on the new VM:

```bash
# apt update && apt install -y ansible-core git
# git clone https://github.com/YOUR-USER/envelope.git /root/envelope
# cd /root/envelope/infra/ansible
# cp inventory.example.ini inventory.ini && cp vars.example.yml vars.yml && nano vars.yml
# ansible-playbook site.yml
```

Then continue from section 8. The sections below describe each step by hand: read them to understand what the playbook does, or follow them if you prefer not to use Ansible.

## 2. Base system

Sign in as root (console or `ssh root@envelope-dev` if allowed), then:

```bash
# apt update && apt full-upgrade -y
# apt install -y sudo curl ca-certificates git unzip build-essential qemu-guest-agent
# systemctl enable --now qemu-guest-agent
# usermod -aG sudo dev
```

`qemu-guest-agent` lets Proxmox shut the VM down cleanly and show its IP address; skip it on other hypervisors. `build-essential` is needed by the few npm packages that compile native code.

Sign out and sign back in as `dev`, then check that sudo works:

```bash
$ sudo -v && echo "sudo ok"
```

### SSH key access

On your laptop, if you do not have a key yet, create one and copy it to the VM (both tools are built into macOS and most Linux systems):

```bash
ssh-keygen -t ed25519
ssh-copy-id dev@envelope-dev
ssh dev@envelope-dev
```

Once key login works, you may disable password login by setting `PasswordAuthentication no` in `/etc/ssh/sshd_config` and running `sudo systemctl restart ssh`.

## 3. Git

```bash
$ git config --global user.name "Your Name"
$ git config --global user.email "you@example.com"
$ git config --global init.defaultBranch main
```

## 4. Node.js with fnm

Debian's own `nodejs` package is older than the version the project needs (Node.js 24, pinned in `.nvmrc`). `fnm` installs and switches Node.js versions per user, without root, like `perlbrew` does for Perl.

```bash
$ curl -fsSL https://fnm.vercel.app/install | bash
$ echo 'eval "$(fnm env --use-on-cd --shell bash)"' >> ~/.bashrc
$ source ~/.bashrc
$ fnm install 24
$ node --version
```

If the installer already added its own `fnm env` line to `~/.bashrc`, keep only the one with `--use-on-cd`: it switches to the version in `.nvmrc` whenever you enter the project folder.

## 5. Docker Engine

Docker's official repository provides current versions and the Compose plugin.

```bash
$ sudo install -m 0755 -d /etc/apt/keyrings
$ sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
$ sudo chmod a+r /etc/apt/keyrings/docker.asc
$ echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
$ sudo apt update
$ sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
$ sudo usermod -aG docker dev
```

Sign out and back in so the new group applies, then:

```bash
$ docker run --rm hello-world
$ docker compose version
```

Members of the `docker` group are effectively root on the VM: keep the group limited to your own user.

## 6. Get the code

The repository is private, so the VM needs its own SSH key registered with the Git hosting service:

```bash
$ ssh-keygen -t ed25519 -C "dev@envelope-dev"
$ cat ~/.ssh/id_ed25519.pub
```

On GitHub, add the printed key under **Settings → SSH and GPG keys**, then:

```bash
$ ssh -T git@github.com          # should greet you by user name
$ git clone git@github.com:YOUR-USER/envelope.git ~/envelope
```

## 7. pnpm, dependencies and first tests

pnpm is the project's package manager, like `cpanm` for Perl. Node.js 24 ships `corepack`, which installs the pnpm version pinned in the `packageManager` field of `package.json`. TypeScript and the Node.js types are listed in `devDependencies`.

```bash
$ cd ~/envelope
$ corepack enable
$ pnpm install
$ pnpm test
$ pnpm typecheck
```

`pnpm install` creates `node_modules`, ignored by Git, following the exact versions in `pnpm-lock.yaml`. The expected result of `pnpm test` is `# fail 0`; `pnpm typecheck` prints nothing when there are no errors.

**Only once, if the repository has no `pnpm-lock.yaml` yet:** the `pnpm install` above creates it. Commit and push it, so every machine and the CI install exactly the same versions:

```bash
$ git add pnpm-lock.yaml && git commit -m "Add pnpm lockfile" && git push
```

## 8. PostgreSQL and Keycloak

```bash
$ cd ~/envelope/infra
$ cp .env.example .env
$ nano .env              # set the passwords; check the image versions
$ docker compose up -d
$ docker compose ps
$ KEYCLOAK_ADMIN_PASSWORD=<password set above> ../scripts/keycloak/bootstrap.sh
```

The last command creates the real `envelope` realm and its `envelope-api` client (safe to run again, and safe to re-run later with `LAN_ORIGIN` set, see below: an existing realm is left alone, an existing client's own `redirectUris`/`webOrigins` are updated to match, nothing else about it changes). By default both services listen on `127.0.0.1` only, so they are not exposed on your network. To open the Keycloak console from your laptop, use an SSH tunnel:

```bash
ssh -L 8080:127.0.0.1:8080 dev@envelope-dev
```

Leave that session open and browse to [http://localhost:8080](http://localhost:8080) on the laptop. Sign in as `admin` with the password set in `.env`. Keycloak takes about a minute to start the first time.

**Letting another device on your own network sign in too** (a family member's own phone or laptop, for example — not the SSH-tunnel setup above, an alternative to it): the web app, the API and Keycloak's own sign-in pages all need to be reachable from that device directly, but only over real HTTPS — the sign-in flow needs the browser's Web Crypto API, which refuses to run outside a secure context, and a bare LAN IP over plain HTTP does not qualify (only `localhost`/`127.0.0.1` get that exception). [mkcert](https://github.com/FiloSottile/mkcert) (a locally-trusted CA) and [Caddy](https://caddyserver.com/) (TLS termination, `infra/Caddyfile`) provide that, set up once:

```bash
$ sudo apt install mkcert caddy
$ mkcert -install                                      # trusts a local CA, for this machine's own apps and browsers
$ mkdir -p ~/.local/share/mkcert/certs && cd ~/.local/share/mkcert/certs
$ mkcert -cert-file lan.pem -key-file lan-key.pem <this machine's own LAN address, e.g. 10.0.0.11> localhost 127.0.0.1 ::1
$ sudo install -d -o caddy -g caddy -m 750 /etc/caddy/certs
$ sudo install -o caddy -g caddy -m 640 lan.pem lan-key.pem /etc/caddy/certs/
$ sudo cp ~/envelope/infra/Caddyfile /etc/caddy/Caddyfile   # edit the LAN address in it first if it isn't 10.0.0.11
$ sudo systemctl reload caddy
```

Caddy is now the only process reachable from your network: the web app at `https://<that address>/` (plain `http://` on it redirects straight there), the API at `https://<that address>:3443`, Keycloak (sign-in pages and its own admin console alike) at `https://<that address>:8443`. `infra/docker-compose.yml`'s own Keycloak `ports:` entry and `apps/api`'s own `HOST` stay on `127.0.0.1` either way — nothing but Caddy is ever exposed directly; `docker compose up -d keycloak` once, after pulling this change, applies the `KC_PROXY_HEADERS` setting that makes Keycloak trust Caddy's own `X-Forwarded-Proto`/`-Host` and so build `https://` URLs instead of `http://` for the connection it actually sees. Re-run `bootstrap.sh` with this machine's own LAN address:

```bash
LAN_ORIGIN=<this machine's own LAN address, e.g. 10.0.0.11> \
  KEYCLOAK_ADMIN_PASSWORD=<password set above> ../scripts/keycloak/bootstrap.sh
```

Every other device that will sign in needs the mkcert CA trusted too, or its browser refuses the certificate outright: copy the root CA (`mkcert -CAROOT` prints its path, typically `rootCA.pem` there) to that device and install it as a trusted root — each OS/browser has its own way; mkcert's own README covers the common ones. There is no way around this for a CA that is not publicly trusted; it is the price of real TLS without a public domain name.

Node does not consult that same system trust store either: start `apps/api` (section 9) with `NODE_EXTRA_CA_CERTS=<CAROOT>/rootCA.pem` (`mkcert -CAROOT` prints `<CAROOT>`) in its own environment, or its JWKS fetch against Keycloak's now-`https://` issuer fails and every sign-in is rejected with "Unauthorized: fetch failed".

Sections 9 and 10 below cover pointing the API and the web app at that same address instead of `127.0.0.1` — every service, your own browser included, has to agree on the exact same hostname (Keycloak embeds whatever hostname a request used into the token's own `issuer`, and the API checks that string exactly), so this is an either/or with the SSH tunnel above, not an addition to it.

## 9. The API server (`apps/api`)

```bash
$ cd ~/envelope/apps/api
$ cp .env.example .env
$ nano .env                 # set DATABASE_URL's password to the one in infra/.env
$ pnpm --filter @envelope/api migrate
```

Migrations create the `envelope_app` and `envelope_queue` roles but never give them a password (ADR 0006: that would mean committing a real credential). Give them one, once per Postgres instance:

```bash
$ docker exec -it envelope-postgres-1 psql -U envelope -d envelope \
  -c "ALTER ROLE envelope_app WITH LOGIN PASSWORD '<a password you pick>';" \
  -c "ALTER ROLE envelope_queue WITH LOGIN PASSWORD '<a different password you pick>';"
$ nano .env                 # set APP_DATABASE_URL and QUEUE_DATABASE_URL to those passwords
```

The server also needs a VAPID key pair for the Web Push adapter (`#39`), even in development — the `budget-recompute` job (`#40`) can send through it:

```bash
$ npx web-push generate-vapid-keys
$ nano .env                 # set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to the pair just printed
$ pnpm --filter @envelope/api dev
```

Obtaining and configuring these (and, later, APNs/FCM) for a real self-hosted deployment is its own guide: [self-hosting push notifications](how-to/self-host-push-notifications.md).

The server listens on `http://127.0.0.1:3000` by default; `GET /health` reports whether it can reach PostgreSQL. `KEYCLOAK_ISSUER`/`KEYCLOAK_AUDIENCE` in `.env` must match the realm and client the previous section's `bootstrap.sh` created (its own defaults, `envelope`/`envelope-api`, already do) — the web app's own sign-in (`#49`, next section) is a real token from this Keycloak, verified against it on every request. Letting another device on your own network reach the API directly (section 8's own alternative to the SSH tunnel) needs `KEYCLOAK_ISSUER` and `WEB_ORIGIN` changed to `https://<that address>:8443/realms/envelope` and `https://<that address>` respectively — `HOST` stays `127.0.0.1`: Caddy (section 8) is what the network actually reaches.

Its integration tests use a separate database, so a failing test never touches the one above, and provision their own throwaway Keycloak realm and their own `envelope_app` login through the admin API (no manual setup needed for tests specifically):

```bash
$ createdb -h 127.0.0.1 -U envelope envelope_test     # once; asks for the password in infra/.env
$ DATABASE_URL=postgres://envelope:<password>@127.0.0.1:5432/envelope_test \
  KEYCLOAK_ADMIN_PASSWORD=<password from infra/.env> \
  pnpm --filter @envelope/api test
```

See [`apps/api/README.md`](../apps/api/README.md) for the environment variables and the migration runner.

## 10. The web app (`apps/web`)

With the API from the previous section still running:

```bash
$ cd ~/envelope/apps/web
$ cp .env.example .env
$ pnpm --filter @envelope/web dev
```

Browse to `http://localhost:5173`: it redirects straight to Keycloak to sign in (`#49`). Self-registration is disabled (`scripts/keycloak/bootstrap.sh`), so create a user once, from the Keycloak admin console (the SSH tunnel from section 8) under *Users → Add user* in the `envelope` realm, with a password set under its *Credentials* tab — turn off "Temporary" there for a development account you will keep reusing, or leave it on to be asked to change it on first sign-in. Signing in then lands back on the placeholder screen, which reports whether it can reach the API. If it cannot, check that `apps/api`'s own `WEB_ORIGIN` (its `.env`) matches this app's own origin — they already default to the same port, so this only matters if either one changed.

Browsing from your laptop rather than the VM itself needs all three services tunneled, not just Keycloak's own admin console from section 8 — the web app's own origin, the API it talks to, and Keycloak for the sign-in redirect:

```bash
ssh -L 5173:127.0.0.1:5173 -L 3000:127.0.0.1:3000 -L 8080:127.0.0.1:8080 dev@envelope-dev
```

Keep that session open and browse to `http://localhost:5173` on the laptop, same as from the VM itself.

Letting another device sign in directly over the network instead (section 8's own alternative) needs `VITE_API_URL` and `VITE_KEYCLOAK_ISSUER` in this app's own `.env` changed to `https://<that address>:3443` and `https://<that address>:8443/realms/envelope`, then that other device browses straight to `https://<that address>/` — no tunnel, no `localhost`, on any of the devices involved, your own included, and the mkcert CA (section 8) installed there first or the browser refuses the certificate.

See [`apps/web/README.md`](../apps/web/README.md) for the rest.

## 11. Editing the code

Any editor works. Two common options:

- **On the VM:** `vim` or `nano` over SSH.
- **From the laptop:** an editor with remote SSH support, such as Visual Studio Code with the Remote - SSH extension. Files stay on the VM; the laptop only shows them.

## 12. Daily workflow

Changes reach `main` only through pull requests: see [Work with issues, pull requests and releases](how-to/work-with-issues-and-pull-requests.md). Once per clone, activate the hook that refuses direct pushes to `main`:

```bash
$ git config core.hooksPath scripts/git-hooks
```

Then, for each change:

```bash
$ git switch main && git pull               # start from the latest main
$ git switch -c feat/12-short-description   # one branch per issue
$ pnpm install                              # only when package.json or pnpm-lock.yaml changed
$ pnpm test && pnpm typecheck
$ git add -A && git commit                  # message in English, with "Refs #12"
$ git push -u origin feat/12-short-description
$ gh pr create --fill                       # then review and merge on GitHub
```

The repository's **Actions** tab on GitHub shows the CI run for every push and pull request: install, type check, tests. It must be green before merging.

## 13. Demo data (optional)

With `apps/api` running (section 9), `scripts/README.md` has a seed script that fills a
"Demo" workspace with realistic data through the real API — useful to have something to look at
without building it up by hand through the web app.

## Common problems

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `sudo: command not found` | Root password was set during installation, so sudo was not installed | Section 2, as root |
| `node: command not found` in a new session | fnm is not in `~/.bashrc` | Check the line added in section 4 |
| `pnpm: command not found` | corepack not enabled | `corepack enable` |
| `permission denied` on `/var/run/docker.sock` | Group change not applied yet | Sign out and back in, or `newgrp docker` |
| Keycloak keeps restarting | Not enough memory, or the database is not ready | `docker compose logs keycloak`; give the VM more RAM |
| Browser cannot reach `localhost:8080`, `:3000` or `:5173` | SSH tunnel not open, or not forwarding that port | Run the `ssh -L` command from section 8 (Keycloak only) or section 10 (all three) and keep it open |
| CI fails on `--frozen-lockfile` | `pnpm-lock.yaml` out of date or not pushed | `pnpm install`, then commit the lockfile |
| `git clone` asks for a password or says "Permission denied (publickey)" | The VM key is not registered on GitHub | Section 6 |
