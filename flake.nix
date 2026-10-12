{
  description = "Nod: observa tus sesiones con agentes de código y entrega eventos Nod v1 (plugin de Claude Code y módulo de home-manager)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      sistemas = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      cada = f: nixpkgs.lib.genAttrs sistemas (s: f nixpkgs.legacyPackages.${s});
      version = (builtins.fromJSON (builtins.readFile ./.claude-plugin/plugin.json)).version;
      # La revisión entra en la versión: `claude plugin update` solo reinstala si cambia.
      rev = self.shortRev or self.dirtyShortRev or "local";
    in {
      packages = cada (pkgs: rec {
        # El plugin listo para Claude Code (y su marketplace de un solo plugin). Sin Node: el bundle va versionado.
        plugin = pkgs.runCommand "nod-claude-plugin-${version}" { nativeBuildInputs = [ pkgs.jq ]; } ''
          mkdir -p $out/.claude-plugin $out/hooks $out/bundle
          cp ${./.claude-plugin/marketplace.json} $out/.claude-plugin/marketplace.json
          jq --arg v "${version}+${rev}" '.version = $v' ${./.claude-plugin/plugin.json} > $out/.claude-plugin/plugin.json
          cp ${./hooks/hooks.json} $out/hooks/hooks.json
          cp ${./bundle/claude.js} $out/bundle/claude.js
          cp ${./README.md} $out/README.md
          cp ${./LICENSE} $out/LICENSE
        '';
        default = plugin;

        # nod-collector: guarda los eventos, calcula métricas y da los límites para tmux (collector/).
        collector = pkgs.rustPlatform.buildRustPackage {
          pname = "nod-collector";
          version = (builtins.fromTOML (builtins.readFile ./collector/Cargo.toml)).package.version;
          # Solo lo que compila y prueba el crate; los tests leen el fixture real del mod (test/fixtures).
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./collector/Cargo.toml
              ./collector/Cargo.lock
              ./collector/src
              ./collector/tests
              ./test/fixtures/nod-v1-sesion-real.jsonl
            ];
          };
          cargoRoot = "collector";
          buildAndTestSubdir = "collector";
          cargoLock.lockFile = ./collector/Cargo.lock;
          # Los tests levantan el servidor en 127.0.0.1.
          __darwinAllowLocalNetworking = true;
          meta = {
            description = "Collector de eventos Nod v1: métricas por tarea y límites de uso para tmux";
            license = pkgs.lib.licenses.mit;
            mainProgram = "nod-collector";
          };
        };
      });

      homeManagerModules.default = import ./nix/home-manager.nix self;

      formatter = cada (pkgs: pkgs.nixfmt);
    };
}
