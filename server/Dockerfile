# The Oasis server, for a hosting service that builds from the repository.
#
# No dependencies to install — the whole thing is Node's own standard library —
# so this is just a Node image with the source copied in.

FROM node:22-alpine

WORKDIR /app/server
COPY . .

# The database and its backups live here. On a hosting service, attach a volume
# at this path: without one, the filesystem is wiped on every redeploy and every
# invoice with it. This is the single most important line in the file.
ENV OASIS_DB=/data/oasis.db
ENV OASIS_BACKUP_DIR=/data/backups
ENV OASIS_BACKUP_EVERY_HOURS=6
ENV OASIS_BACKUP_KEEP=28
RUN mkdir -p /data

# Behind the host's own HTTPS proxy.
ENV HOST=0.0.0.0
ENV PORT=8080
ENV OASIS_TRUST_PROXY=1
EXPOSE 8080

# Says whether the server is up and whether there is a workspace to sign in to.
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
