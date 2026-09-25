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
```

The services listen on `127.0.0.1` only, so they are not exposed on your network. To open the Keycloak console from your laptop, use an SSH tunnel:

```bash
ssh -L 8080:127.0.0.1:8080 dev@envelope-dev
```

Leave that session open and browse to [http://localhost:8080](http://localhost:8080) on the laptop. Sign in as `admin` with the password set in `.env`. Keycloak takes about a minute to start the first time.

## 9. Editing the code

Any editor works. Two common options:

- **On the VM:** `vim` or `nano` over SSH.
- **From the laptop:** an editor with remote SSH support, such as Visual Studio Code with the Remote - SSH extension. Files stay on the VM; the laptop only shows them.

## 10. Daily workflow

Changes reach the VM through the repository:

```bash
$ cd ~/envelope
$ git pull                 # get the latest changes
$ pnpm install             # only when package.json or pnpm-lock.yaml changed
$ pnpm test && pnpm typecheck
```

When you change something yourself:

```bash
$ git status
$ git add -A
$ git commit -m "Short description of the change"
$ git push
```

The repository's **Actions** tab on GitHub shows the CI run for every push: install, type check, tests. It must be green.

## Common problems

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `sudo: command not found` | Root password was set during installation, so sudo was not installed | Section 2, as root |
| `node: command not found` in a new session | fnm is not in `~/.bashrc` | Check the line added in section 4 |
| `pnpm: command not found` | corepack not enabled | `corepack enable` |
| `permission denied` on `/var/run/docker.sock` | Group change not applied yet | Sign out and back in, or `newgrp docker` |
| Keycloak keeps restarting | Not enough memory, or the database is not ready | `docker compose logs keycloak`; give the VM more RAM |
| Browser cannot reach `localhost:8080` | SSH tunnel not open | Run the `ssh -L` command from section 8 and keep it open |
| CI fails on `--frozen-lockfile` | `pnpm-lock.yaml` out of date or not pushed | `pnpm install`, then commit the lockfile |
| `git clone` asks for a password or says "Permission denied (publickey)" | The VM key is not registered on GitHub | Section 6 |
