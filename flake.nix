# Dev container image for Tessera's rust/wasm/web toolchain.
#
# The image is composed on aarch64-darwin for a linux/arm64 guest: the linux
# closure substitutes from cache.nixos.org and cache.numtide.com as prebuilt
# binaries, so no Linux builder is needed; only the layer-packing runs on the
# Mac, which is why the image is built with the host's dockerTools and the
# contents come from the linux package set. Apple's `container image load`
# accepts OCI archives only, so `nix run .#loadDevImage` converts nix's
# docker-archive through skopeo first.
#
# The guest toolchain follows this repo's lockfiles: Cargo.lock pins
# wasm-bindgen 0.2.129 and nixpkgs' wasm-bindgen-cli matches. Known drift
# from devenv.nix: binaryen 132 vs 133, vale 3.17.1 vs 3.25.
#
# The image carries no secrets and no key material. Git push authenticates
# through the host ssh agent forwarded by `container run --ssh`, never with
# keys on container disk.
{
  # Pinned to revisions the caches have already built: cache.nixos.org for
  # nixpkgs, cache.numtide.com for the unfree agents that Hydra never
  # builds. A Mac with no Linux builder can only substitute image contents;
  # it cannot compile aarch64-linux closures, so both pins must stay on
  # revisions already present in those caches. Update via `nix flake
  # update` after checking the caches have the new revisions built.
  inputs.llm-agents.url = "github:numtide/llm-agents.nix/e78ca7f96a07c5d9ab88a34f5e76d544c6d2a299";
  inputs.nixpkgs.url = "github:nixos/nixpkgs/fe13242281a67641c0102cdb1087f0ebe586c7df";

  outputs =
    {
      self,
      nixpkgs,
      llm-agents,
    }:
    let
      system = "aarch64-darwin";
      pkgs = import nixpkgs {
        system = "aarch64-darwin";
        config.allowUnfree = true;
      };
      linux = import nixpkgs {
        system = "aarch64-linux";
        config.allowUnfree = true;
      };

      # github.com host keys, taken from https://api.github.com/meta on
      # 2026-11-02. Fingerprints to verify:
      # https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
      # writeTextDir so the file lands at etc/ssh/ssh_known_hosts; layer
      # dirs are read-only after copyToRoot, so extraCommands cannot mkdir.
      githubKnownHostsDir = pkgs.writeTextDir "etc/ssh/ssh_known_hosts" ''
        github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
        github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVW7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCZgK56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
      '';

      # Trust policy for the local docker-archive -> oci-archive hop: the
      # archive is this flake's own build output.
      skopeoPolicy = pkgs.writeText "skopeo-policy.json" ''
        {"default":[{"type":"insecureAcceptAnything"}]}
      '';

      # The guest toolchain, mirroring the packages in devenv.nix. nixpkgs rustc
      # bundles the wasm32-unknown-unknown std; its sysroot has no llvm-ar,
      # so LLVM ships alongside for ts-demo-wasm's
      # AR_wasm32_unknown_unknown.
      guestRoot = pkgs.buildEnv {
        name = "dev-tessera-root";
        paths =
          with linux;
          [
            # Shell and basics.
            bashInteractive
            cacert
            coreutils-full
            findutils
            gawk
            gnugrep
            gnused
            gzip
            gnutar
            less
            which
            # Rust.
            rustc
            cargo
            rustfmt
            clippy
            llvmPackages_20.llvm
            # Web demo toolchain.
            wasm-bindgen-cli
            binaryen
            bun
            nodejs
            # Prose linting.
            vale
            # VCS. openssh carries git's ssh transport; keys never live in
            # the container, only the forwarded agent socket.
            openssh
            git
            git-lfs
            jujutsu
            lazygit
          ];
        pathsToLink = [ "/bin" ];
      };

      # Agent CLIs are not baked into the image. Their nix derivations fetch
      # the vendor binary at build time without a fixed output hash, so they
      # need a Linux builder this Mac does not have. Agents install via their
      # own vendor installers on first use inside the container, into the
      # persistent cache volume, not the image.

      devImage = pkgs.dockerTools.buildImage {
        name = "dev-tessera";
        tag = "latest";
        architecture = "arm64";
        copyToRoot = [
          guestRoot
          pkgs.dockerTools.fakeNss
          pkgs.dockerTools.usrBinEnv
          # github.com host keys; see the pin note above. A writeTextDir
          # store path because layer dirs are read-only after copyToRoot.
          githubKnownHostsDir
        ];
        config = {
          Cmd = [ "/bin/bash" ];
          Env = [
            "PATH=/usr/bin:/bin"
            "SSL_CERT_FILE=${linux.cacert}/etc/ssl/certs/ca-bundle.crt"
            "GIT_SSL_CAINFO=${linux.cacert}/etc/ssl/certs/ca-bundle.crt"
            "AR_wasm32_unknown_unknown=${linux.llvmPackages_20.llvm}/bin/llvm-ar"
          ];
        };
      };
    in
    {
      packages.${system} = {
        # nix build .#devImage --print-out-paths
        devImage = devImage;

        # nix run .#loadDevImage -- builds the image if needed, converts the
        # docker-archive to an OCI archive, and loads it into Apple's
        # `container` runtime as dev-tessera:latest.
        loadDevImage = pkgs.writeShellScriptBin "loadDevImage" ''
          set -euo pipefail
          img=${devImage}
          work=$(mktemp -d)
          trap 'rm -rf "$work"' EXIT
          ${pkgs.skopeo}/bin/skopeo copy \
            --policy ${skopeoPolicy} \
            "docker-archive:$img" \
            "oci-archive:$work/dev-tessera.tar:dev-tessera:latest"
          container image load --input "$work/dev-tessera.tar"
        '';
      };
    };
}
