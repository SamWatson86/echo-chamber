# Echo deploy-agent config safety

`push-build.ps1` deploys the desktop binary without posting `config.json` by
default. This prevents an older deploy agent from deleting a machine's
provisioned `jam_source` ID and token.

Before the first config upload to a machine, rerun `setup-agent.ps1` on that
machine. Setup installs `agent.ps1` and `deploy-config-lib.ps1` together. The
updated agent advertises `config_update_mode: preserve-jam-source-v1` from
`GET /health`; `push-build.ps1 -PushConfig` refuses to post unless that exact
capability is present.

The merge-aware endpoint applies ordinary settings such as `server` from the
incoming file while preserving the installed `jam_source` block when it is
omitted. Including a `jam_source` property is an explicit replacement;
`"jam_source": null` explicitly removes the source configuration. Invalid JSON
fails closed and leaves the installed file unchanged. Config contents and
credentials are never written to deploy-agent logs.
