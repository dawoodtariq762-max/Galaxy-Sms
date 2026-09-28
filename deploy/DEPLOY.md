# Deployment templates — review before use

The current authoritative procedure is [Safe Update](../docs/SAFE-UPDATE.md).

Do not run an automatic install/restart on an existing VPS. Inventory the actual code, database, uploads, environment, services and backups first. Verify a fresh recoverable backup, inspect automatic startup schema/data updates on a staging copy, then obtain explicit deployment approval.

Files in this directory and the watchdog/diskguard/service scripts are retained because they may support existing installations. Their legacy `powerx`/Nova names are compatibility names, not proof of obsolescence. Their defaults do not establish your production configuration. In particular, review process names, absolute paths, backup retention/deletion, ports, TLS and API/sync worker roles. This cleanup does not execute them or modify the installed VPS versions.

Never use retired benchmark/crash tests on production. No current capacity claim is supplied by this release.
