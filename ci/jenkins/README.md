# jka-web test pipeline (Jenkins → build server → test app server)

Mirrors the ja2-web setup. Builds the WASM engine **and** the game module on the build server and
deploys to the **test** app server — never production. Production (`jka.virtastic.app`) is a separate
path (`docker-compose.prod.yml` + the OVH/edge Caddy).

## Servers (Virtastic proxmox lab)

| Role         | ssh alias / host          | what it is                                    |
|--------------|---------------------------|-----------------------------------------------|
| Build server | `builder` (<build-host>) | Jenkins (Docker container) + Docker. Builds here. |
| Test app srv | `user@<test-host>`   | Runs `jka-test` (nginx) on `:8083`.           |
| Ingress      | nginx-proxy-manager       | routes `jka.dev.virtastic.app` → `<test-host>:8083` (TLS/SNI). |

`ci/jenkins/config.env` (gitignored — copy `config.env.example`) holds these values for the manual
flow; a Jenkins job supplies them as env instead (see the repo-root `Jenkinsfile`).

Ports across the set: ja2 = 8081, jk2 = 8082, **jka = 8083**.

## Flow (manual, from a laptop)

```bash
ci/jenkins/sync-to-builder.sh                                  # rsync the working tree → builder:jka-src
ssh builder 'cd jka-src && SRC=$PWD ci/jenkins/build-engine.sh'   # docker build jka:test (Dockerfile.test)
ssh builder 'cd jka-src && ci/jenkins/deploy-test.sh'            # docker save | ssh test docker load; run :8083
ci/jenkins/smoke-test.sh http://<test-host>:8083              # (or https://jka.dev.virtastic.app)
```

The build is **self-contained** (`Dockerfile.test`): a multi-stage image whose builder stage is
`emscripten/emsdk:6.0.1` and compiles both `build-jka.sh` (engine → `jka.js`/`jka.wasm`) and
`build-jka-modules.sh` (game module → `qagame.wasm`). First build pulls the toolchain image
(~2-3 GB, one-time); later builds reuse the cached layer + a warm object cache. **No game data** is
ever copied into the image (builder takes only `games/` + `shared/`; runtime takes the two HTML pages
+ built artifacts), and `build-engine.sh` fails the build if any `.pk3`/`.data` leaks in.

## Jenkins job

A pipeline job pointed at this repo, using the repo-root `Jenkinsfile`. It checks the repo out on the
builder (so the workspace is the tree — no `sync-to-builder` needed) and runs Build → Deploy → Smoke.

Requirements on the builder for the job to run:
- The Jenkins container must reach the Docker daemon (docker socket mounted — "docker-outside-of-docker").
- A **builder→test SSH key** at `/var/jenkins_home/.ssh/jka-deploy`, whose public half is in
  `user@<test-host>:~/.ssh/authorized_keys`. This key lives on the builder, never in git.
- The Jenkins container/host must be able to reach `<test-host>` (same `vmbr0` bridge).

## Notes

- **Static-only**, matching production: the container serves the game with no `/api` backend. The
  Cloud Locker (`cloud/`) is not wired into the jka nginx vhost; enabling it on the test site would
  need an `/api` proxy block + a `jka-cloud` container (ja2 does this; jka/jka are static by design).
- The public URL (`jka.dev.virtastic.app`) additionally needs DNS + the ingress route. Until both
  exist the smoke stage checks the container directly on `<test-host>:8083`.
