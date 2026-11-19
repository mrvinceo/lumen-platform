# Deploying Lumen on DigitalOcean

This guide puts Lumen on one DigitalOcean server (a "Droplet") at **https://lumen.ryzomi.com**. Everything runs in
Docker on that server:

- **Caddy:** HTTPS certificates, which it gets and renews automatically
- **The Lumen API:** also serves the console, the chat page and `widget.js`
- **The worker:** document ingestion
- **Postgres** with pgvector
- **Redis**

Only Caddy is reachable from the internet.

Expect about an hour the first time. Every command is in its own box, so you can copy and paste one at a time.
Wherever you see `<droplet-ip>`, use your Droplet's IP address.

> **Cost:** the recommended Droplet is about **$24/month** (2 vCPU / 4 GB), plus about 20% if you turn on Droplet
> backups. Prices change, so check the figure DigitalOcean shows before you click Create.

---

## 1. Create an SSH key on your laptop (skip if you already have one)

An SSH key lets you log in to the server without a password. On macOS or Linux open Terminal; on Windows open
PowerShell.

```bash
ssh-keygen -t ed25519 -C "lumen-droplet"
```

Press Enter to accept the default file location. Set a passphrase if you like; you'll type it when you connect.

Print the **public** half, which is safe to share:

```bash
cat ~/.ssh/id_ed25519.pub
```

On Windows PowerShell, use `type $env:USERPROFILE\.ssh\id_ed25519.pub` instead.

Copy the whole line it prints (it starts with `ssh-ed25519`). You'll paste it into DigitalOcean next.

## 2. Create the Droplet

In the DigitalOcean control panel, click **Create → Droplets** and choose:

| Setting                | Choose                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Region**             | **London** (LON1), or the region nearest your users                                                                                               |
| **Image**              | **Marketplace** tab → search **Docker** → **Docker on Ubuntu** (Ubuntu 24.04 with Docker already installed)                                       |
| **Size**               | **Basic** → **Regular** (SSD) → **$24/mo: 2 vCPU, 4 GB RAM, 80 GB SSD**. The 2 GB plan (about $12/mo) works for light use, but builds are slower. |
| **Authentication**     | **SSH Key** → **New SSH Key** → paste the line from step 1 → name it e.g. "My laptop"                                                             |
| **Additional options** | Tick **Monitoring** (free CPU, memory and disk graphs). Optionally tick **Backups** (automatic whole-server snapshots, about 20% extra).          |
| **Hostname**           | `lumen`                                                                                                                                           |

Click **Create Droplet**. After about a minute it shows an **IPv4** address: that's your `<droplet-ip>`.

> If you can't find the Docker Marketplace image, choose **OS → Ubuntu 24.04 (LTS) x64** instead and follow
> [Installing Docker yourself](#installing-docker-yourself) after step 5.

## 3. Add a firewall in DigitalOcean

This blocks everything except SSH and web traffic before it reaches the server.

1. Go to **Networking → Firewalls → Create Firewall**.
2. **Name:** `lumen-web`.
3. **Inbound rules:**
   - keep **SSH** (TCP 22)
   - add **HTTP** (TCP 80)
   - add **HTTPS** (TCP 443)
   - optionally add a custom **UDP 443** rule, for HTTP/3
4. **Outbound rules:** leave the defaults (all allowed).
5. **Apply to Droplets:** choose `lumen`.
6. Click **Create Firewall**.

> **Optional: Reserved IP.** Under **Networking → Reserved IPs** you can assign a fixed IP to the Droplet. Use that IP
> in DNS (step 4) if you ever expect to rebuild or replace the Droplet: you just move the IP instead of changing DNS.

## 4. Point lumen.ryzomi.com at the Droplet

Add a DNS record wherever ryzomi.com's DNS is managed today (usually your domain registrar):

| Type | Name / Host | Value                               | TTL                         |
| ---- | ----------- | ----------------------------------- | --------------------------- |
| `A`  | `lumen`     | `<droplet-ip>` (or the Reserved IP) | 300 (or the lowest offered) |

If you'd rather manage DNS in DigitalOcean, add the domain under **Networking → Domains** and change the domain's
nameservers at your registrar to `ns1/ns2/ns3.digitalocean.com`. Then create the same `A` record there. Nameserver
changes can take a few hours.

Check it from your laptop; a few minutes after saving, it should print the Droplet's IP:

```bash
nslookup lumen.ryzomi.com
```

## 5. First login and server setup

### 5a. Log in as root

```bash
ssh root@<droplet-ip>
```

The first time, type `yes` to trust the server's fingerprint. If your key isn't the default one, add
`-i path/to/key`.

### 5b. Install updates

```bash
apt update && apt -y upgrade
```

If a pink or purple dialog asks which services to restart, press Enter to accept the defaults. If the server says a
reboot is required, run `reboot`, wait 30 seconds and log in again with the command from 5a.

### 5c. Create your own user (instead of using root)

Working as `root` makes mistakes costly, so create a normal user called `lumen` that can use `sudo` and Docker.

```bash
adduser lumen
```

It asks for a password twice: choose a strong one, because you'll type it whenever you use `sudo`. Press Enter to skip
the name and phone questions, then `Y` to confirm.

Give the user admin (`sudo`) and Docker rights:

```bash
usermod -aG sudo,docker lumen
```

Copy your SSH key to the new user, so you can log in as `lumen` with the same key:

```bash
rsync --archive --chown=lumen:lumen ~/.ssh /home/lumen
```

**Test it before going further.** Keep the root window open and open a **new** terminal window on your laptop:

```bash
ssh lumen@<droplet-ip>
```

```bash
sudo whoami
```

This should print `root` after you enter the `lumen` user's password. Then check Docker works without sudo:

```bash
docker ps
```

It should print a header line (`CONTAINER ID   IMAGE …`) and no error. If you see "permission denied", log out
(`exit`) and log in again as `lumen`.

### 5d. Turn off root and password logins

Only do this once 5c works: it stops anyone logging in as root, or with a password instead of your key. In the
`lumen` window:

```bash
sudo nano /etc/ssh/sshd_config.d/99-lumen.conf
```

Paste these two lines:

```
PermitRootLogin no
PasswordAuthentication no
```

Save with **Ctrl+O**, then **Enter**, and exit with **Ctrl+X**. Apply the change:

```bash
sudo systemctl restart ssh
```

From another **new** window, check `ssh lumen@<droplet-ip>` still works. From now on, always log in as `lumen`; you
can close the root window.

### 5e. Server firewall (second layer)

```bash
sudo ufw allow OpenSSH
```

```bash
sudo ufw allow 80,443/tcp
```

```bash
sudo ufw allow 443/udp
```

```bash
sudo ufw enable
```

Type `y` when it warns about SSH; you've allowed it. Then check:

```bash
sudo ufw status
```

It should list `OpenSSH`, `80,443/tcp` and `443/udp` as `ALLOW`.

> Docker can open ports that bypass `ufw`. Lumen's production setup only opens Caddy's ports 80 and 443; the database
> and Redis are never exposed. The DigitalOcean firewall from step 3 also protects you.

### 5f. Add swap space

Swap is spare memory on disk. It stops the server running out of memory while building Lumen.

```bash
sudo fallocate -l 2G /swapfile
```

```bash
sudo chmod 600 /swapfile
```

```bash
sudo mkswap /swapfile
```

```bash
sudo swapon /swapfile
```

Keep it after reboots:

```bash
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Check: the `Swap:` row should show `2.0Gi`.

```bash
free -h
```

### 5g. Automatic security updates

```bash
sudo apt install -y unattended-upgrades
```

```bash
sudo dpkg-reconfigure -plow unattended-upgrades
```

Choose **Yes**.

### 5h. Time zone (optional)

This makes log and backup times show UK time:

```bash
sudo timedatectl set-timezone Europe/London
```

### 5i. Check Docker

```bash
docker --version
```

```bash
docker compose version
```

Both should print a version, with Compose at v2 or later.

## 6. Get the code and configure Lumen

As `lumen`, in your home folder (`cd ~`).

### 6a. Clone the repository

If the GitHub repository is **public**:

```bash
git clone https://github.com/mrvinceo/lumen-platform.git
```

If it's **private**, give the server a read-only deploy key.

1. Create a key on the server:

   ```bash
   ssh-keygen -t ed25519 -C "lumen-droplet-deploy" -f ~/.ssh/github_deploy -N ""
   ```

2. Print its public half:

   ```bash
   cat ~/.ssh/github_deploy.pub
   ```

3. On GitHub, open the repository's **Settings → Deploy keys → Add deploy key**. Paste the key, leave "Allow write
   access" **unticked**, and save.

4. Tell SSH to use that key for GitHub:

   ```bash
   printf 'Host github.com\n  IdentityFile ~/.ssh/github_deploy\n' >> ~/.ssh/config
   ```

5. Clone over SSH:

   ```bash
   git clone git@github.com:mrvinceo/lumen-platform.git
   ```

Then move into the folder:

```bash
cd ~/lumen-platform
```

### 6b. Create the settings file

```bash
cp deploy/.env.production.example deploy/.env.production
```

Generate the two secrets. Each command prints a random value; copy each one somewhere for the next step.

```bash
openssl rand -hex 24
```

That's your `POSTGRES_PASSWORD`.

```bash
openssl rand -base64 32
```

That's your `MASTER_KEY`.

> **Save the MASTER_KEY in your password manager now.** Lumen uses it to encrypt the API keys you enter. If it's lost,
> those keys can't be recovered, even from a backup; you'd have to re-enter them all.
>
> If you want to bring your **existing local data** across ([step 10](#10-optional-move-your-local-data-across)), use
> the **same** `MASTER_KEY` as in your laptop's `.env`, not a new one.

Edit the file:

```bash
nano deploy/.env.production
```

Fill in:

- `LUMEN_DOMAIN=lumen.ryzomi.com` (already set)
- `POSTGRES_PASSWORD=` followed by the first value
- `MASTER_KEY=` followed by the second value

Save and exit with **Ctrl+O**, **Enter**, **Ctrl+X**. The file is ignored by git, so it never gets committed.

## 7. Start Lumen

From `~/lumen-platform`:

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production up -d --build
```

The first build takes about 5–10 minutes on the 4 GB Droplet. When it finishes, check everything is running:

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production ps
```

A healthy result lists `api`, `worker`, `caddy`, `postgres` (healthy) and `redis` (healthy), all `Up`. `migrate` isn't
listed, because it runs once and exits. Use `ps -a` to see it with `Exited (0)`.

Watch the logs (press **Ctrl+C** to stop watching; Lumen keeps running):

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production logs -f api caddy
```

Caddy logs `certificate obtained successfully` once it has the HTTPS certificate. That needs the DNS from step 4 and
ports 80 and 443 open.

> **Tip: a shorter command.** Add an alias so you can type `lumen ps`, `lumen logs -f api` and so on:
>
> ```bash
> echo "alias lumen='docker compose -f ~/lumen-platform/deploy/docker-compose.prod.yml --env-file ~/lumen-platform/deploy/.env.production'" >> ~/.bashrc && source ~/.bashrc
> ```
>
> The rest of this guide uses `lumen …` as shorthand for the full `docker compose -f … --env-file …` command.

## 8. Create your account, then close sign-ups

1. Open **https://lumen.ryzomi.com**, click **Sign up**, then create your account and workspace.
2. Stop anyone else signing up. Edit `deploy/.env.production`, set `ALLOW_SIGNUPS=false` and save:

   ```bash
   nano deploy/.env.production
   ```

3. Restart the API so it picks up the change:

   ```bash
   lumen up -d api
   ```

To add teammates later, temporarily set it back to `true` or invite them from the console once invitations ship.

## 9. Set up Lumen again

The server starts with an empty database. In the console:

1. add your models
2. create the knowledge base and upload documents
3. create the bot

On the bot's **Embed & branding** tab:

- the embed code now uses `https://lumen.ryzomi.com/widget.js`
- add the websites the bubble may appear on
- use **Open test page** to try it

## 10. (Optional) Move your local data across

Only if you want to keep what you built locally, **and** you used the same `MASTER_KEY` in step 6b.

1. On your **laptop**, in the project folder (with the local Postgres running), dump the database:

   ```bash
   docker compose --env-file .env -f deploy/docker-compose.yml exec -T postgres pg_dump -U lumen --no-owner lumen | gzip > lumen-local.sql.gz
   ```

2. Copy the dump to the server:

   ```bash
   scp lumen-local.sql.gz lumen@<droplet-ip>:~/
   ```

3. On the **server**, stop the app containers, then load the dump into a fresh database:

   ```bash
   lumen stop api worker
   ```

   ```bash
   lumen exec -T postgres psql -U lumen -d postgres -c "DROP DATABASE lumen WITH (FORCE)" -c "CREATE DATABASE lumen OWNER lumen"
   ```

   ```bash
   gunzip -c ~/lumen-local.sql.gz | lumen exec -T postgres psql -U lumen -d lumen -v ON_ERROR_STOP=1
   ```

   ```bash
   lumen up -d
   ```

Uploaded files aren't in the dump. Either re-upload them, or copy your local `STORAGE_DIR` contents into the
`uploads` volume.

## 11. Updating Lumen

When a new version is merged on GitHub:

```bash
cd ~/lumen-platform && git pull
```

```bash
lumen up -d --build
```

Database migrations run automatically before the API starts. To free disk space taken by old image layers now and
then:

```bash
docker image prune -f
```

## 12. Backups

`deploy/backup.sh` saves a database dump and the uploaded files to `/var/backups/lumen`, keeping 14 days.

Create the folder and run it once by hand:

```bash
sudo mkdir -p /var/backups/lumen && sudo chown lumen:lumen /var/backups/lumen
```

```bash
~/lumen-platform/deploy/backup.sh
```

Schedule it every night at 03:15 by opening your crontab:

```bash
crontab -e
```

If asked, choose `nano` (option 1). Add this line at the bottom, then save and exit:

```
15 3 * * * /home/lumen/lumen-platform/deploy/backup.sh >> /home/lumen/backup.log 2>&1
```

These backups live on the same server. If you ticked **Backups** when creating the Droplet, DigitalOcean also keeps
whole-server snapshots, which cover a lost server. For extra safety, copy `/var/backups/lumen` off the server now and
then (e.g. `scp` to your laptop, or `rclone` to DigitalOcean Spaces).

### Restoring the database from a backup

```bash
lumen stop api worker
```

```bash
lumen exec -T postgres psql -U lumen -d postgres -c "DROP DATABASE lumen WITH (FORCE)" -c "CREATE DATABASE lumen OWNER lumen"
```

Replace `db-2026-11-19-0315.sql.gz` with the backup you want:

```bash
gunzip -c /var/backups/lumen/db-2026-11-19-0315.sql.gz | lumen exec -T postgres psql -U lumen -d lumen -v ON_ERROR_STOP=1
```

```bash
lumen up -d
```

To restore uploaded files (again, use the matching file name):

```bash
lumen run --rm --no-deps -T -v /var/backups/lumen:/backup --entrypoint tar api -xzf /backup/uploads-2026-11-19-0315.tar.gz -C /data/uploads
```

## 13. Troubleshooting

- **The site doesn't load, or there's a certificate error.**
  - Check `nslookup lumen.ryzomi.com` shows the Droplet's IP.
  - Check the DigitalOcean firewall allows 80 and 443.
  - Read `lumen logs caddy`. Let's Encrypt limits retries, so fix DNS first, then run `lumen restart caddy`.
- **Something isn't working.** `lumen ps` shows what's running, and `lumen logs --tail 100 api` (or `worker`) shows
  recent errors.
- **Documents stay "Queued".** The worker isn't running or can't reach Redis: `lumen logs --tail 100 worker`.
- **The build is killed, or the server is very slow.** It's out of memory: check swap is on (`free -h`, step 5f), or
  resize the Droplet (**Droplet → Resize**, CPU and RAM only, so you can scale back down).
- **The disk is full.** `df -h /`, then `docker image prune -f` and `docker builder prune -f`.
- **After rebooting the server.** Everything restarts on its own (`restart: unless-stopped`).

## Later: DigitalOcean services you can switch to

None of these are needed now. They move pieces off the Droplet when you outgrow it:

- **Managed PostgreSQL** (Databases → Create → PostgreSQL 16). Enable the extension once with
  `CREATE EXTENSION vector;`, set `DATABASE_URL` for `migrate`, `api` and `worker` in the compose file, and remove the
  `postgres` service.
- **Spaces Object Storage** (S3-compatible) for uploads. Set `STORAGE_DRIVER=s3`, `S3_ENDPOINT` to the Spaces region
  endpoint (e.g. `https://lon1.digitaloceanspaces.com`), `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`.
- **Managed Caching** (Valkey, Redis-compatible). Set `REDIS_URL` and remove the `redis` service.
- **Bigger Droplet.** Use **Resize** for more CPU and RAM when traffic grows.

## Installing Docker yourself

Only needed if you chose plain Ubuntu instead of the Docker Marketplace image. Run these after step 5c, as `lumen`,
using Docker's official apt repository:

```bash
sudo apt install -y ca-certificates curl
```

```bash
sudo install -m 0755 -d /etc/apt/keyrings
```

```bash
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
```

```bash
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list
```

```bash
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

```bash
sudo usermod -aG docker lumen
```

Then log out (`exit`) and back in, so the `docker` group applies, and continue with step 5d.
