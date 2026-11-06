# ZCode full CLI on this host

Local installation from official zai-org/ZCode source commit a9fe401eede6e6e5e01be9048679c206fe6f02d9. Distribution3.17.2, Agent0.17.1, Node24.14.0. This is host tooling, not a ShowStake runtime dependency.

Installed directory: `D:\Toolchains\zcode-runtime-3.17.2\zcode`.
Launcher: `%APPDATA%\npm\zcode.cmd` uses pinned Node under `%USERPROFILE%\.zcode\toolchains\node-v24.14.0-win-x64`.

```powershell
zcode --version
# See: 3.17.2

zcode
# See: native TUI (select model with /model if needed)

zcode --web --workspace "D:\Belajar\Hackacton\Hackacton yang masih jalan\ShowStake\.local\zcode-figcraft" --no-open
# See: loopback Web URL. Open printed URL; Ctrl+C stops the local service.

zcode -p "Reply exactly OK. Do not use tools or change files." --mode plan --json
# Sends a real inference request using selected provider; not an offline test.
```

Provider/model: Cloud Near, `https://cloud-api.near.ai/v1`, `deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated`, reasoning `high`. The shared desktop/CLI provider file is `%USERPROFILE%\.zcode\v2\provider_config.json`. Credentials stay in protected local configuration; never paste into repository or chat. CLI runtime/MCP config stays `%USERPROFILE%\.zcode\cli\config.json`.

Confirmed: native TUI loaded, Web returned HTTP200 on127.0.0.1, actual model returned ZCODE_CLOUD_NEAR_OK with exit0 and stored Cloud Near selection. This is no claim of attaching to an existing desktop session or accepted product design.

Build adjustment: official distribution collector requires shared dist, but packages/shared has no build script. Generated328 unbundled JS outputs from its source with installed esbuild, without tracked source edits. Build/dependency logs and source retained under `.zcode/toolchains`; build node_modules removed after packaging to reclaim space. Archive and checksum under `D:\Toolchains\zcode-local-3.17.2\releases\3.17.2`; installer base URL in generated metadata is inert localhost and not a publication endpoint.

Rollback: copy `%USERPROFILE%\.zcode\toolchains\zcode.cmd.before-full-distribution` back to `%APPDATA%\npm\zcode.cmd`. Previous shared default selector stored privately in `.zcode/toolchains/previous-desktop-default-model.json`; restoring it changes only defaultModelSelection, not provider credentials. Do not replace the full provider config with that selector snapshot.
