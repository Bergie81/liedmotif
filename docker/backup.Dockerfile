# The backup sidecar: the Postgres image the stack already runs (so `pg_dump`
# always matches the server it dumps — compose passes the pinned digest in as
# POSTGRES_IMAGE, keeping one copy of it) plus the `openssl` CLI, which the
# upstream image does not ship and the dump encryption needs, and `rsync`, which
# snapshots `/data` with unchanged files hardlinked to the previous backup.
ARG POSTGRES_IMAGE
FROM ${POSTGRES_IMAGE}

RUN apk add --no-cache openssl rsync

# The script reads the due query from its own directory.
COPY docker/backup.sh /usr/local/bin/liedmotif-backup
COPY docker/backup-due.sql /usr/local/bin/backup-due.sql
RUN chmod +x /usr/local/bin/liedmotif-backup
COPY LICENSE.md NOTICE.md /usr/share/doc/liedmotif/

ENTRYPOINT ["/bin/sh", "/usr/local/bin/liedmotif-backup"]
