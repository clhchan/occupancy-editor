## *Prebuilt Frontend: Start the Editor Offline

- **Direct startup**: Git now includes the complete `dist/`. With it, `./start.sh` needs only Bash and Python 3, not Node.js, npm, or a network connection.
- **Rebuild when needed**: If the entry page or its assets are missing, the script uses the installed build tools or installs them first with `npm ci --include=dev`. To install dependencies with `--offline`, the npm cache must be complete for the target platform.
- **Distribution**: Include all of `dist/` when packaging or copying the editor. After frontend changes, run `npm run build` and commit the output with the source.

[简体中文](release-notes-v0.2.2.md)
