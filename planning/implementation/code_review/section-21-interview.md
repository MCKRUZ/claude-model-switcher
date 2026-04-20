# Section 21 Code Review Interview

## Auto-fixed (no user input needed)

1. **TypeScript files run with `node` in CI YAML** → Changed to `npm run check:spa` and `npx tsx` for all `.ts` script invocations in ci.yml and release.yml.

2. **Dockerfile missing package-lock.json** → Added `COPY --from=build /app/package-lock.json ./` and changed `npm install --omit=dev` to `npm ci --omit=dev` for reproducible installs.

3. **bun-fallback needs dependency on binary job** → Changed `needs: build` to `needs: [build, binary]` so `if: failure()` triggers correctly when binary job fails.

4. **Binary naming collision on GitHub Release** → Changed `outputPath` to produce `ccmux-<target>` filenames (e.g., `ccmux-linux-x64`, `ccmux-win-x64.exe`) instead of bare `ccmux`. Updated all workflow references and tests.

5. **Docker ENTRYPOINT mismatched with bin shim** → Changed from `node dist/cli/index.js` to `node bin/ccmux.js` which is the canonical entry point used by `package.json#bin`.

## Let go

6. **Windows backslash paths in build-binaries** → pkg and bun handle OS-native paths correctly on Windows runners. No change needed.

## User decision

User said "fix it however you see fit" — all items auto-resolved.
