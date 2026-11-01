# Verifier seccomp policy

Derived from [Moby profiles seccomp/default.json](https://github.com/moby/profiles/blob/4b8214fc4971e06172938a1f1554ccff6647ee80/seccomp/default.json), Git blob `6e5e47e242892aaa290f916ba1045f9213ef0b84`, Apache-2.0 (LICENSE alongside).

The sole policy addition permits clone, setns, unshare and chroot for Chromium's nested user-namespace sandbox. The outer container still drops all capabilities, has no-new-privileges, user-namespace isolation, read-only root, no host mounts and no external network. clone3 retains Moby's ENOSYS fallback; privileged mount, bpf and other capability-dependent rules remain conditional. This exposes namespace syscalls to candidate code too; use a dedicated supported runtime and review the kernel boundary. It is not a sandbox-escape proof.

The host verifier pins these exact bytes and verifies Docker's installed JSON. There is no caller-selected profile or unconfined fallback. See [Playwright's Chromium namespace guidance](https://playwright.dev/docs/docker).
