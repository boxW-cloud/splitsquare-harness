# Release process

Releases are intentionally tag-driven and Windows-only until other platforms have native packaging and security coverage.

## One-time repository setup

1. Review `BRANDING.md` and confirm that the repository, screenshots, social preview, and release listings all use the independent SplitSquare Harness identity before the first public push.
2. Create and configure the `boxW-cloud/splitsquare-harness` public GitHub repository.
3. Enable the dependency graph, Dependabot alerts, Dependabot security updates, private vulnerability reporting, and CodeQL default setup.
4. Protect `main` and `v*` tags with rulesets. Require CI and dependency review before merge.
5. Create a protected GitHub Environment named `release` with required reviewers.
6. Decide whether unsigned builds are allowed. To require signing, set the `release` environment variable `REQUIRE_WINDOWS_SIGNING=true`.

## Optional Windows Authenticode signing

Electron Forge supports a PFX certificate through the following protected `release` environment secrets:

- `WINDOWS_CERTIFICATE_BASE64`: base64-encoded PFX bytes;
- `WINDOWS_CERTIFICATE_PASSWORD`: the PFX password.

The workflow writes the certificate only to the runner's temporary directory, signs both the packaged application and Squirrel installer, validates every produced executable, and deletes the temporary certificate in an `always()` step. Never commit a certificate or password. Public unsigned builds will normally trigger Windows reputation warnings.

Azure Trusted Signing or hardware-backed certificates require a separate reviewed signing implementation; do not adapt the PFX path by placing long-lived cloud credentials in workflow files.

## Create a release

1. Update `CHANGELOG.md` and set `package.json.version`.
2. Run:

   ```powershell
   pnpm install --frozen-lockfile
   pnpm licenses
   pnpm run ci
   pnpm package
   ```

3. Merge the version change to `main`.
4. Create and push an annotated tag matching the package version exactly:

   ```powershell
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```

The workflow requires the tag to point to the current `main` head. It then builds Squirrel artifacts with locked dependencies, optionally signs them, exports a source dependency-graph SPDX document, generates `SHA256SUMS.txt`, creates a GitHub/Sigstore build-provenance attestation, and publishes a GitHub Release. Tags containing a hyphen are marked as prereleases.

The Release is created as a draft and made public only after every asset upload succeeds. If a failed rerun leaves a draft with the same tag, inspect its assets, delete that draft, and rerun the failed workflow; the automation intentionally refuses to overwrite an existing Release.

## Consumer verification

For releases from this repository:

```powershell
Get-FileHash .\SplitSquare-Harness-Setup.exe -Algorithm SHA256
gh attestation verify .\SplitSquare-Harness-Setup.exe --repo boxW-cloud/splitsquare-harness
Get-AuthenticodeSignature .\SplitSquare-Harness-Setup.exe
```

Compare the `Get-FileHash` value with the installer line in `SHA256SUMS.txt`. A signed release should report `Status: Valid`; an intentionally unsigned release will not.

The `.source.spdx.json` file describes the repository dependency graph. It is not a file-by-file binary SBOM of Electron, Chromium, or the unpacked application.
