// Output of the tools `enterprise-build.ts --check` runs, as macOS prints it
// (copied from real runs, names and hashes changed), for its tests.

/** `codesign -dv --verbose=4` on an app signed with a Developer ID, hardened runtime, notarized. */
export const CODESIGN_DEVELOPER_ID = `Executable=/Applications/Smoke Break.app/Contents/MacOS/smoke-break
Identifier=com.smokebreak.desktop
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20500 size=2275 flags=0x10000(runtime) hashes=60+7 location=embedded
Hash type=sha256 size=32
CDHash=3143f4402b417986ad4df24ce68127f0716b7898
Signature size=8971
Authority=Developer ID Application: Acme Inc (TEAMID1234)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=May 31, 2026 at 13:50:39
Notarization Ticket=stapled
Info.plist entries=20
TeamIdentifier=TEAMID1234
Runtime Version=26.5.0
Sealed Resources version=2 rules=13 files=5
Internal requirements count=1 size=212
`;

/** The same app signed without the hardened runtime and not notarized. */
export const CODESIGN_NO_RUNTIME = CODESIGN_DEVELOPER_ID.replace('flags=0x10000(runtime)', 'flags=0x0(none)').replace(
  'Notarization Ticket=stapled\n',
  '',
);

/** What the linker leaves on an unsigned build (Apple Silicon). */
export const CODESIGN_ADHOC = `Executable=/tmp/Smoke Break.app/Contents/MacOS/smoke-break
Identifier=smoke_break-55554944
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=250 flags=0x20002(adhoc,linker-signed) hashes=5+0 location=embedded
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
Sealed Resources=none
`;

export const CODESIGN_UNSIGNED = `/tmp/Smoke Break.app: code object is not signed at all
`;

export const VERIFY_OK = `--prepared:/Applications/Smoke Break.app/Contents/MacOS/smoke-break
/Applications/Smoke Break.app: valid on disk
/Applications/Smoke Break.app: satisfies its Designated Requirement
`;

export const VERIFY_MODIFIED = `/Applications/Smoke Break.app: a sealed resource is missing or invalid
file modified: /Applications/Smoke Break.app/Contents/Resources/icon.icns
`;

export const SPCTL_NOTARIZED = `/Applications/Smoke Break.app: accepted
source=Notarized Developer ID
origin=Developer ID Application: Acme Inc (TEAMID1234)
`;

export const SPCTL_GATEKEEPER_OFF = `/Applications/Smoke Break.app: accepted
source=Notarized Developer ID
override=security disabled
`;

export const SPCTL_REJECTED = `/Applications/Smoke Break.app: rejected
source=Unnotarized Developer ID
origin=Developer ID Application: Acme Inc (TEAMID1234)
`;

export const STAPLER_OK = `Processing: /Applications/Smoke Break.app
The validate action worked!
`;

export const STAPLER_NONE = `Processing: /Applications/Smoke Break.app
Smoke Break.app does not have a ticket stapled to it.
`;
