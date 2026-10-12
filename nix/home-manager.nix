# programs.nod: instala Nod en todos los perfiles de Claude Code y lo mantiene al día.
#
# Cada `switch` (y cada vez que aparece un perfil nuevo de ws) ejecuta nod-sync: registra el marketplace
# del plugin en el perfil, instala o actualiza nod@nod y quita las versiones anteriores del mod
# (orbit@orbit-local del instalador de Orbit y orbit@orbit): con dos activos, cada evento saldría dos
# veces. No toca nada si la versión instalada ya es la del flake.
self:
{ config, lib, pkgs, ... }:
let
  cfg = config.programs.nod;
  home = config.home.homeDirectory;
  marketplace = "${config.xdg.dataHome}/nod/claude-plugin";
  wsProfiles = "${config.xdg.stateHome}/ws/claude";
  sync = pkgs.writeShellApplication {
    name = "nod-sync";
    runtimeInputs = [ pkgs.coreutils pkgs.jq ];
    text = ''
      # nod-sync [--force]: instala o actualiza Nod en los perfiles de Claude Code.
      claude=${lib.escapeShellArg cfg.claude}
      mkt=${lib.escapeShellArg marketplace}
      want=$(jq -r .version "$mkt/.claude-plugin/plugin.json")
      force=''${1:-}
      if [ ! -x "$claude" ]; then
        echo "nod-sync: no encuentro claude en $claude; Nod se instalará en el siguiente switch" >&2
        exit 0
      fi
      dirs=(${lib.escapeShellArgs cfg.profiles})
      if [ ''${#dirs[@]} -eq 0 ]; then
        dirs=("${home}/.claude")
        for d in "${wsProfiles}"/*/; do [ -d "$d" ] && dirs+=("''${d%/}"); done
      fi
      version() { jq -r '[.[] | select(.id == "nod@nod" and .scope == "user")][0].version // ""'; }
      fallos=0
      for d in "''${dirs[@]}"; do
        c() { CLAUDE_CONFIG_DIR="$d" "$claude" plugin "$@"; }
        mkdir -p "$d"
        plugins=$(c list --json 2>/dev/null || echo '[]')
        have=$(version <<<"$plugins")
        if [ "$force" != "--force" ] && [ "$have" = "$want" ]; then continue; fi
        # Versiones anteriores del mod: con dos activos, cada evento saldría dos veces.
        for old in orbit@orbit-local orbit@orbit; do
          if jq -e --arg id "$old" 'any(.[]; .id == $id)' <<<"$plugins" >/dev/null; then
            c uninstall "$old" --scope user >/dev/null 2>&1 || c uninstall "$old" >/dev/null 2>&1 || true
          fi
        done
        mkts=$(c marketplace list --json 2>/dev/null || echo '[]')
        for old in orbit-local orbit; do
          if jq -e --arg n "$old" 'any(.[]; .name == $n)' <<<"$mkts" >/dev/null; then
            c marketplace remove "$old" >/dev/null 2>&1 || true
          fi
        done
        if jq -e 'any(.[]; .name == "nod")' <<<"$mkts" >/dev/null; then
          c marketplace update nod >/dev/null 2>&1 || true
        else
          c marketplace add "$mkt" >/dev/null 2>&1 || true
        fi
        if [ -n "$have" ]; then
          c update nod@nod >/dev/null 2>&1 || true
        else
          c install nod@nod --scope user >/dev/null 2>&1 || true
        fi
        c enable nod@nod --scope user >/dev/null 2>&1 || true
        now=$(c list --json 2>/dev/null | version)
        if [ "$now" = "$want" ]; then
          echo "nod-sync: nod $want en ''${d/#$HOME/\~}"
        else
          echo "nod-sync: $d quedó con '$now' en vez de $want (prueba: CLAUDE_CONFIG_DIR=$d $claude plugin install nod@nod)" >&2
          fallos=$((fallos + 1))
        fi
      done
      exit "$fallos"
    '';
  };
in {
  options.programs.nod = {
    enable = lib.mkEnableOption "Nod en Claude Code (observa las sesiones y entrega eventos Nod v1)";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.plugin;
      description = "El plugin de Claude Code (con su marketplace).";
    };
    claude = lib.mkOption {
      type = lib.types.str;
      default = "${home}/.local/bin/claude";
      description = "Binario de claude (2.1.296 o más reciente) con el que se instala el plugin.";
    };
    profiles = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Directorios de configuración de Claude Code. Vacío: ~/.claude y los perfiles de ws (~/.local/state/ws/claude/*).";
    };
    watchProfiles = lib.mkOption {
      type = lib.types.bool;
      default = pkgs.stdenv.isDarwin;
      description = "Instala Nod también en los perfiles de ws que se creen después (agente de launchd).";
    };
  };

  config = lib.mkIf cfg.enable {
    # Ruta estable para el marketplace: Claude la guarda; el enlace cambia de destino en cada versión.
    xdg.dataFile."nod/claude-plugin".source = cfg.package;
    home.packages = [ sync ];

    home.activation.nod = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
      run ${sync}/bin/nod-sync || echo "nod: no quedó instalado en todos los perfiles (nod-sync para reintentar)" >&2
    '';

    launchd.agents.nod-sync = lib.mkIf cfg.watchProfiles {
      enable = true;
      config = {
        ProgramArguments = [ "${sync}/bin/nod-sync" ];
        WatchPaths = [ wsProfiles ];
        StandardErrorPath = "${home}/Library/Logs/nod-sync.log";
        StandardOutPath = "${home}/Library/Logs/nod-sync.log";
      };
    };
  };
}
