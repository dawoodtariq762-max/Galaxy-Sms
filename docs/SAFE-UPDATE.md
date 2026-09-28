# Safe update: your local GitHub workflow and production VPS

No GitHub or VPS operations were performed for this finalization. You control every operation below. **Use a local computer for Steps 1–6, never the live VPS.**

## Step 1 — Prepare and protect your source

Download/extract `Galaxy-SMS-Final-Clean-Source.zip`. It contains complete current source—not a partial overlay—and no application database, uploads, credentials, dependencies or Git metadata. Keep a private backup of your current local repository and any uncommitted work.

Do not copy the entire raw workspace including its ignored database. The ZIP/`release/source-manifest.json` is the code-only distribution. Your production DB is not an input to a GitHub upload.

## Step 2 — Open a separate local clone of your existing GitHub repository

For a non-developer, **GitHub Desktop** is recommended:

1. Sign in yourself. Choose **File → Clone repository**, select your existing repository, and clone to a new local folder (for example `C:\GalaxyRepo`). Do not clone into the extracted source folder or a production directory.
2. Select the branch you intend to update. Prefer a new branch such as `galaxy-clean-update` and a pull request instead of updating `main` directly.
3. Before copying anything, the Changes tab must be empty. Resolve/back up pre-existing local work first. If the clone contains production DBs or secrets tracked by Git, STOP and deal with those separately; ignore rules alone do not untrack them.
4. Do not delete the clone's `.git` directory. It contains the history against which Git recognizes edits and deletions.

**Browser upload is not suitable for mirroring:** uploading new files in the GitHub website does not remove old files that are absent from your upload. Copying files over a clone also does not delete old files by itself.

## Step 3 — Apply updated code and explicit obsolete-code deletions locally

The safest replacement is **copy current source + delete only reviewed obsolete paths**. Do not use “delete everything except .git”, `git clean -fdx`, `rsync --delete`, `robocopy /MIR`, or a whole-directory mirror.

Included optional helper: `tools/sync-local-clone.py`. It uses Python 3, performs no Git or network operations, and refuses an unsafe target. It compares manifest files, preserves files outside its allowlist, refuses to act on a target containing obvious database/environment/upload data, and prints its plan before any write. It checks source hashes so incomplete/changed extraction is detected. It does not prove a target is non-production; **you must choose a separate local clone**.

Windows PowerShell, from the extracted `Galaxy-Sms` folder:

```powershell
py -3 tools\sync-local-clone.py --target "C:\GalaxyRepo"
```

macOS/Linux, from the extracted `Galaxy-Sms` folder:

```bash
python3 tools/sync-local-clone.py --target "$HOME/GalaxyRepo"
```

Read the printed `ADD`, `UPDATE`, `DELETE` and `PRESERVE` plan. Same-name current source will replace the local clone's old code. `DELETE` is restricted to exact files in `release/obsolete-code-paths.txt`; no recursive folder deletion and no wildcard data removal. Review modified obsolete files carefully: they may contain newer local work. Back up the clone before proceeding. If a deletion is unfamiliar, STOP rather than approving all.

**Only after you approve that local plan**, repeat with both flags:

```powershell
py -3 tools\sync-local-clone.py --target "C:\GalaxyRepo" --apply --confirm-local-clone
```

On macOS/Linux use the same command with `python3` and your local path.

Files outside the source manifest and deletion allowlist are preserved, not silently removed. If your GitHub repository contains additional old paths unknown to this workspace, they will remain. Review these individually before expanding any deletion list. This deliberately protects unrelated files; it does not pretend that every absent file is obsolete.

If Python is unavailable, install Python 3 from python.org, or have a trusted technician execute this local-only plan. Do not compensate by using a destructive mirror command.

## Step 4 — Verify all proposed changes before committing

In GitHub Desktop, inspect every changed file and diff. The expected statuses are:

- **Modified:** same path, changed content (`etherbot.js` would be updated, not duplicated).
- **Added:** new source paths.
- **Deleted:** obsolete previously tracked paths physically removed from this local clone.
- **Renamed:** Git may infer a rename based on content similarity; otherwise it may show deletion plus addition. Both can represent the same intended result.
- Untracked files become Added only when selected/staged for the commit.

Optional terminal checks, run by you in the **local clone**:

```bash
git status --short
git diff --stat
git diff --name-status --find-renames
git diff --check
git diff -- path/to/file
```

`git diff` alone does not show untracked file contents; inspect those too. Look for unintended source changes, unexpected deleted files, real API keys/passwords, `.env`, databases/WAL/SHM, uploads, certificates, logs, editor files and old tools. None belongs in this source commit. A private repository is not a substitute for secret protection.

Use Desktop to select only the reviewed files. Terminal users may stage **explicit reviewed paths**, including missing obsolete paths:

```bash
git add -A -- path/to/approved-file path/to/approved-obsolete-file
# Then review the actual staged snapshot:
git diff --cached --name-status --find-renames
git diff --cached --stat
git diff --cached
```

Do not paste placeholder paths literally. Do not use an unreviewed repository-wide `git add -A`. You do not have to delete each file through the GitHub website: the normal commit records the approved local deletions together.

**Secret history warning:** the former mobile signing keystore was historically tracked. Deleting it now does not remove prior committed copies. Treat exposed signing credentials as compromised when applicable. Rotation/revocation and any history rewrite require a separate coordinated plan; never force-push a rewritten shared history casually.

## Step 5 — Commit locally

Only when the selected diff is correct, use Desktop's **Commit to [your branch]** with a clear summary, for example `Finalize Galaxy SMS light UI and retire obsolete tooling`. Terminal equivalent after explicit staging/review:

```bash
git commit -m "Finalize Galaxy SMS light UI and retire obsolete tooling"
git status --short
```

If unexpected changes remain, investigate. Do not include them merely to make the status clean.

## Step 6 — Push your branch and review

Use Desktop **Push origin** / **Publish branch**, then open a pull request and review the GitHub diff yourself. Terminal users push the intended branch explicitly, for example `git push -u origin galaxy-clean-update`. Do not force-push or guess the remote/branch. Same-path updates, additions and deletions all travel in the commit. No separate manual GitHub file deletion is needed.

## Step 7 — Prepare a safe VPS code deployment (STOP gate)

Do not run the local sync helper on the VPS. Do not execute historical install/update scripts against an existing deployment without reviewing them. The root `deploy.sh` is now an informational stop, not an automatic pull/restart tool.

Have a trusted operator inventory the actual VPS, **read-only first**:

- Current source directory, checked-out commit, application version and local modifications.
- All running processes/services (PM2/systemd/containers, API/sync workers, SMPP listeners), current process names and ports. Changing a PM2 name can accidentally leave two services running.
- Actual absolute DB path from process environment/config; all external storage paths, mounts and symlinks. `DB_FILE` / `DATA_DIR` takes precedence over fallback paths.
- Environment files/secrets, TLS certificates/private keys, proxy configuration, backup configuration, logs, uploads/payment screenshots, legacy attachments, exports and import supply files.
- Current DB schema and startup migration/reconciliation behavior. This project still calls `createTables()` and `seed()` at startup, contains rate/pattern backfills and hard-coded range relinking, and may reconcile aggregates. **A code update can change data merely by starting.** Do not deploy until a staging copy proves the intended startup behavior and any needed migrations are separately approved. No migration bypass was invented in this cleanup.

A source Git commit does not establish which schema the VPS already has. Record that difference explicitly. If startup would change schema/data without approval, STOP; don't quietly run it and hope the operations are no-ops.

Prepare the new commit in a **new sibling release directory**, not by deleting the current production directory. Install locked dependencies there with `npm ci --omit=dev` on the compatible Node/runtime. Confirm that all persistent paths will point to existing protected storage. Do not initialize an empty DB. Review permissions and the existing process-manager settings; do not adopt examples blindly.

## Step 8 — Back up and protect production data before switching code

**A verified fresh production backup is mandatory, not the development DB or an old workspace snapshot.**

- Use SQLite online backup facilities or coordinate a maintenance window that quiesces **every writer** (HTTP ingress, SMPP, provider sync, workers and scheduled jobs) and closes the DB cleanly. Coordinate carrier retry/buffering to avoid lost inbound traffic while stopped.
- Never copy only a live `data.sqlite` while ignoring uncheckpointed WAL. Never delete WAL/SHM to “clean” a database. Use an appropriate SQLite backup method; don't improvise an online file copy.
- Back up required uploads, environment/configuration, certificates and recovery logs too, securely and outside the release tree. Verify files are present/readable, database `PRAGMA integrity_check` on the backup succeeds, and the backup can be opened/restored in an isolated location. Record timestamp, size, hashes and protected locations.
- Record baseline counts for users, numbers, ranges, SMS/CDR, payment ledger and payment requests, allocations/sharing, rates and provider data. Also preserve schema and key/value or row-level snapshots/hashes of critical ownership, rate, permission and payment fields. **Equal counts do not prove unchanged data.** Do not dump credentials into public logs.
- Only after backup verification and your explicit approval, perform the coordinated service switch/restart using existing settings. Preserve the actual production storage; never copy a development SQLite file over it.

| CODE: replace from approved release | DATA/CONFIG: preserve, do not overwrite |
|---|---|
| HTML, `api.js`, JS/CSS/images in `assets/` | SQLite DB and its WAL/SHM/journal state |
| Backend JS and static lookup data | SMS/CDR/users/numbers/ranges/allocations/payments/rates/provider records inside DB |
| `package.json`, lockfile; reinstall dependencies | `.env`, real credentials/API keys, TLS certificates/private keys |
| Current source tests and documentation | `uploads/payment-screenshots`, other production uploads/attachments/import data |
| Reviewed obsolete code files only | Nova/other active backups, Litestream replicas, recovery logs and storage mounts |
| Deployment templates only after operator review | Existing effective service/proxy/system configuration and permissions |

Directories can contain both code and data: `backend/` contains source **and may contain the live DB**. The project root may contain `.env`, uploads and logs. Deleting these whole directories is data deletion, not a code update.

A known obsolete JS/HTML/style/test file can be removed after confirming no active consumer and no stored data. A similarly named directory cannot be treated the same way. If safety is unverified, **do not delete it**. Do not delete active Nova backups just to eliminate an old name.

`.gitignore` only affects untracked staging. It does not stop Git from overwriting/deleting previously tracked runtime files. If production runtime data is tracked, STOP: securely back up it and plan untracking/storage separation independently before any pull/checkout. Do not blindly run `git rm` on the VPS.

## Step 9 — Verify after deployment, before declaring success

Verify startup and logs; all four roles/login; dashboard and light UI; required APIs; HTTP receive/dedup; SMPP bind/receive; reports/CDR; number/range and ownership/allocation views; payments, rates, PIN/Complaints and permissions. Use coordinated non-destructive checks; do not run old benchmark/mutation tests on production.

Compare actual before/after data counts and critical values, storage inventory, schema and permissions. For example:

| Data | Before | After | Expected |
|---|---:|---:|---|
| Users | record | record | equal absent authorized changes |
| Numbers / ranges | record | record | equal absent authorized changes |
| SMS / CDR | record | record | equal in a fully quiesced window; may grow with traffic |
| Allocations / sharing | record | record | unchanged absent authorized changes |
| Payment ledger / requests | record | record | unchanged absent authorized operations/new earnings |
| Rates / provider config | record | record | same critical values, not just counts |

**Any unexplained decrease, changed ownership/rates/permissions/payment values, unexpected schema change, missing upload or wrong DB path: STOP and investigate.** File hashes of a live DB naturally change with traffic; whole-file equality is not a reliable online logical-data test. A growing row count alone also does not prove zero loss.

Keep the previous code release for rollback. Roll back code/config only after reviewing schema compatibility; do not overwrite a newer production DB with a stale backup and discard newly received traffic. Restoring data is a separate recovery decision.

Do not claim “zero production data lost” until these checks have actually been performed. No production verification is claimed for this workspace cleanup.
