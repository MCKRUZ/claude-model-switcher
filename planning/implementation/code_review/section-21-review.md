# Section 21 Code Review: Release CI

## Critical

1. **ci.yml + release.yml run `.ts` files directly with `node`** — TypeScript files need a loader. `node scripts/check-spa-bundle.ts` will fail. Use `npx tsx scripts/check-spa-bundle.ts` or the npm script `npm run check:spa` instead.

2. **Dockerfile missing package-lock.json** — The `npm install --omit=dev` step in the final stage needs `package-lock.json` for reproducible installs. Add `COPY --from=build --chown=ccmux:ccmux /app/package-lock.json ./`.

3. **release.yml bun-fallback `needs: build` should also reference `binary`** — The `if: failure()` condition needs the binary job to have run and failed. Currently `needs: build` means it runs after build, not after binary fails.

## Important

4. **release.yml `assert-artifacts` greps for `ccmux-linux-x64` etc.** — But `softprops/action-gh-release` uploads files by their filesystem name, which is just `ccmux` or `ccmux.exe` (not prefixed with target). The release may have duplicate `ccmux` names. Consider renaming binaries during build or adjusting the assert script.

5. **smoke scripts in release.yml also use `node scripts/smoke/healthz.ts`** — Same TypeScript issue as #1. Need `npx tsx` or compile first.

## Minor

6. **`scripts/build-binaries.ts` uses `join` for output paths** — On Windows CI runners this produces backslash paths. The `--output` flag for pkg/bun might handle it, but worth noting.

7. **Docker ENTRYPOINT uses `dist/cli/index.js`** — Verify this path matches the actual build output (the `bin` field points to `bin/ccmux.js`).
