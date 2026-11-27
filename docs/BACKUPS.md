# Database backups

The API backs up the whole MySQL database **once a day** and uploads it to S3.

- **When:** every day after **02:30 IST** (checked every 10 minutes; a failed run is retried up to 3 times that day).
- **Where:** the same bucket as uploads, private folder `db-backups/`
  (e.g. `db-backups/certezy-certezy-2026-11-27_023012-IST.sql.gz`). Never public —
  keep `db-backups/*` out of the bucket policy (the policy in `S3_SETUP.md` already does).
- **How many:** the newest **7** are kept; older ones are deleted from S3 automatically.
- **Admin → Backups** (Super Admins only): see the available backups, **Back up now**,
  and **Download** (a 5-minute private link). Every run and download is in the audit log.
- Nothing to install on the server: the dump is made by the API itself (all tables,
  in one consistent snapshot, as plain SQL, gzipped).

## Settings (optional, backend `.env`)

```
BACKUP_TIME_IST=02:30   # daily time, IST (HH:MM)
BACKUP_KEEP=7           # how many backups to keep in S3
```

S3 must be set up (`AWS_BUCKET_NAME`, see `S3_SETUP.md`). The IAM policy there already
allows Put / Get / Delete and ListBucket, which backups need.

## Restore

Restoring **replaces** the tables in the target database. Try it on a copy first.

1. Admin → Backups → **Download** the backup you want (or copy it from S3 → `db-backups/`).
2. On the server (or any machine with the MySQL client):

```bash
gunzip -c certezy-certezy-2026-11-27_023012-IST.sql.gz | mysql -h DB_HOST -u DB_USER -p DB_NAME
```

To check a backup without touching the live data, restore it into a new database:

```bash
mysql -h DB_HOST -u DB_USER -p -e "CREATE DATABASE certezy_restore_test CHARACTER SET utf8mb4"
gunzip -c FILE.sql.gz | mysql -h DB_HOST -u DB_USER -p certezy_restore_test
```

Amazon Linux: if `mysql` isn't installed, `sudo dnf install -y mariadb105` gives the client.
