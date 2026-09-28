# Mehfooz deployment

Current detailed procedure: [docs/SAFE-UPDATE.md](../docs/SAFE-UPDATE.md).

Production folder delete na karein. Database, WAL/SHM, uploads, payments, users, numbers, credentials aur active backups ko source code se alag rakhein. Pehle fresh backup verify karein; phir staging par startup migration/data updates check karein. Explicit approval ke baghair production restart ya migration na chalayein.

Is directory ke service/backup templates ki paths aur process names production se verify karna zaroori hai. Purane naam ka matlab obsolete nahin hai.
